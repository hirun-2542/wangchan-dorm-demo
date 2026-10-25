import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import {
  ApiError,
  checkoutTenant,
  createTenant,
  fetchBillPeriods,
  fetchBills,
  fetchPendingLinks,
  fetchRooms,
  fetchTenants,
  tenantsChangedEvent,
  updateTenant,
  type Bill,
  type PendingLink,
  type Room,
  type Tenant,
  type TenantStatus,
} from "../api";
import { useSearch } from "../search";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  PageHeader,
  Select,
  Skeleton,
  StatusBadge,
  Toast,
  type DataTableColumn,
} from "../ui";
import type { Tenant as PinnedTenant } from "../mock-data";
import { baht, todayIso } from "./bills-shared";
import { periodLabel, periodOptions } from "../period";
import { PairingSurface, type PairingResult } from "./tenants-pairing";

const thaiMonthsShort = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

function formatThaiDate(iso: string): string {
  const [yearPart, monthPart, dayPart] = iso.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);

  if (!Number.isFinite(year) || !Number.isFinite(month) || dayPart === undefined) {
    return iso;
  }

  const monthLabel = thaiMonthsShort[month - 1] ?? "";
  const shortYear = String((year + 543) % 100).padStart(2, "0");
  return `${dayPart} ${monthLabel} ${shortYear}`;
}

function saveFailureState(
  failure: unknown,
  fallback: string,
): { error: { message: string; field?: string }; toast: boolean } {
  const message = failure instanceof ApiError ? failure.message : fallback;
  const field = failure instanceof ApiError ? failure.field : undefined;

  return { error: { message, field }, toast: field === undefined };
}

function LineStatusBadge({ linked }: { linked: boolean }) {
  if (linked) {
    return (
      <Badge tone="paid" icon="check_circle">
        เชื่อมแล้ว
      </Badge>
    );
  }

  return (
    <Badge tone="review" icon="error">
      ยังไม่เชื่อม
    </Badge>
  );
}

function TenantStatusBadge({ status }: { status: TenantStatus }) {
  if (status === "current") {
    return (
      <Badge tone="paid" icon="check_circle">
        ปัจจุบัน
      </Badge>
    );
  }

  return (
    <Badge tone="vacant" icon="logout">
      ย้ายออกแล้ว
    </Badge>
  );
}

function DetailRow({ label, value, numeric }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-steel">{label}</dt>
      <dd className={numeric === true ? "num text-charcoal" : "text-charcoal"}>{value}</dd>
    </div>
  );
}

const tabOptions: { id: TenantStatus; label: string }[] = [
  { id: "current", label: "ปัจจุบัน" },
  { id: "moved-out", label: "ย้ายออกแล้ว" },
];

function TenantsTabs({ value, onChange }: { value: TenantStatus; onChange: (next: TenantStatus) => void }) {
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }

    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + step + tabOptions.length) % tabOptions.length;
    const next = tabOptions[nextIndex];

    if (next !== undefined) {
      onChange(next.id);
      document.getElementById(`tenants-tab-${next.id}`)?.focus();
    }
  };

  return (
    <div role="tablist" aria-label="สถานะผู้เช่า" className="flex gap-1 rounded-lg border border-ash p-1">
      {tabOptions.map((option, index) => {
        const active = option.id === value;

        return (
          <button
            key={option.id}
            id={`tenants-tab-${option.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls="tenants-panel"
            tabIndex={active ? 0 : -1}
            className={`btn ${active ? "bg-status-unpaid-bg font-medium text-deep-sapphire" : "text-steel"}`}
            onClick={() => {
              onChange(option.id);
            }}
            onKeyDown={(event) => {
              onTabKeyDown(event, index);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface TenantFormValues {
  name: string;
  phone: string;
  roomId: string;
  checkIn: string;
}

interface TenantFormDrawerProps {
  open: boolean;
  seedKey: string;
  title: string;
  submitLabel: string;
  initial: TenantFormValues;
  roomLabel: string;
  roomOptions: { value: string; label: string }[];
  roomHelper: string;
  saving: boolean;
  serverError: { message: string; field?: string } | null;
  onClose: () => void;
  onSave: (values: TenantFormValues) => void;
}

function TenantFormDrawer({
  open,
  seedKey,
  title,
  submitLabel,
  initial,
  roomLabel,
  roomOptions,
  roomHelper,
  saving,
  serverError,
  onClose,
  onSave,
}: TenantFormDrawerProps) {
  const [name, setName] = useState(initial.name);
  const [phone, setPhone] = useState(initial.phone);
  const [roomId, setRoomId] = useState(initial.roomId);
  const [checkIn, setCheckIn] = useState(initial.checkIn);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [seededKey, setSeededKey] = useState<string | null>(null);

  if (!open) {
    if (seededKey !== null) {
      setSeededKey(null);
    }
  } else if (seededKey !== seedKey) {
    setSeededKey(seedKey);
    setName(initial.name);
    setPhone(initial.phone);
    setRoomId(initial.roomId);
    setCheckIn(initial.checkIn);
    setTouched({});
  }

  const nameValid = name.trim() !== "";
  const phoneValid = phone.trim() !== "";
  const roomValid = roomId !== "";
  const dateValid = checkIn !== "";
  const canSave = nameValid && phoneValid && roomValid && dateValid && !saving;

  const fieldError = (field: string): string | undefined =>
    serverError !== null && serverError.field === field ? serverError.message : undefined;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button
            variant="primary"
            icon="save"
            disabled={!canSave}
            onClick={() => {
              onSave({ name: name.trim(), phone: phone.trim(), roomId, checkIn });
            }}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field
          label="ชื่อ-นามสกุล"
          value={name}
          onChange={(value) => {
            setName(value);
            setTouched((prev) => ({ ...prev, name: true }));
          }}
          error={fieldError("fullName") ?? (touched.name === true && !nameValid ? "กรุณากรอกชื่อ-นามสกุล" : undefined)}
        />

        <Field
          label="เบอร์โทร"
          value={phone}
          onChange={(value) => {
            setPhone(value);
            setTouched((prev) => ({ ...prev, phone: true }));
          }}
          inputMode="tel"
          error={fieldError("phone") ?? (touched.phone === true && !phoneValid ? "กรุณากรอกเบอร์โทร" : undefined)}
        />

        <Select
          label={roomLabel}
          value={roomId}
          onChange={setRoomId}
          options={roomOptions}
          helper={fieldError("roomId") ?? (touched.room === true && !roomValid ? "กรุณาเลือกห้อง" : roomHelper)}
        />

        <Field
          label="วันเข้า"
          type="date"
          value={checkIn}
          onChange={setCheckIn}
          error={fieldError("checkInDate") ?? (touched.checkIn === true && !dateValid ? "กรุณาเลือกวันเข้า" : undefined)}
        />

        {serverError !== null && serverError.field === undefined && <p className="text-xs text-danger">{serverError.message}</p>}
      </div>
    </Drawer>
  );
}

interface CheckoutDialogProps {
  tenant: Tenant | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (tenant: Tenant, dateIso: string) => void;
}

function CheckoutDialog({ tenant, saving, error, onClose, onConfirm }: CheckoutDialogProps) {
  const [date, setDate] = useState(todayIso());
  const [seededId, setSeededId] = useState<string | null>(null);

  if (tenant !== null && tenant.id !== seededId) {
    setSeededId(tenant.id);
    setDate(todayIso());
  }

  if (tenant === null) {
    return (
      <Dialog open={false} onClose={onClose} title="เช็คเอาท์ผู้เช่า">
        {null}
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`เช็คเอาท์ · ${tenant.fullName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button
            variant="danger-soft"
            icon="logout"
            disabled={date === "" || saving}
            onClick={() => {
              onConfirm(tenant, date);
            }}
          >
            ยืนยันเช็คเอาท์
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="วันที่ออก" type="date" value={date} onChange={setDate} error={error ?? undefined} />

        <div className="panel-muted">
          <p className="text-sm text-charcoal">หลังยืนยันเช็คเอาท์</p>
          <p className="mt-1 text-sm text-steel">
            ห้อง {tenant.roomNumber} จะเปลี่ยนเป็นห้องว่าง แต่ประวัติผู้เช่าของ {tenant.fullName} จะยังถูกเก็บไว้ในระบบ
          </p>
        </div>
      </div>
    </Dialog>
  );
}

export function TenantsPage() {
  const [tenantList, setTenantList] = useState<Tenant[]>([]);
  const [roomList, setRoomList] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingLinks, setPendingLinks] = useState<PendingLink[]>([]);
  const [tab, setTab] = useState<TenantStatus>("current");
  const [pairingOpen, setPairingOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [billPeriods, setBillPeriods] = useState<string[]>(() => periodOptions([]));
  const [tenantBills, setTenantBills] = useState<Bill[]>([]);
  const [billsLoading, setBillsLoading] = useState(false);
  const [billsError, setBillsError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Tenant | null>(null);
  const [checkoutTarget, setCheckoutTarget] = useState<Tenant | null>(null);
  const [formError, setFormError] = useState<{ message: string; field?: string } | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { query, setQuery } = useSearch();

  const showToast = useCallback((message: string) => {
    setToast(message);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [tenants, rooms, pending, billed] = await Promise.all([
        fetchTenants(),
        fetchRooms(),
        fetchPendingLinks(),
        fetchBillPeriods(),
      ]);
      setTenantList(tenants);
      setRoomList(rooms);
      setPendingLinks(pending);
      setBillPeriods(periodOptions(billed));
    } catch (loadError) {
      setError(loadError instanceof ApiError ? loadError.message : "โหลดข้อมูลผู้เช่าไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * ผู้เช่าใหม่มาจากอุปกรณ์ของเขาเอง (LIFF) ไม่ใช่แท็บนี้ — ถ้าไม่ฟังเหตุการณ์นี้
   * เจ้าของที่เปิดหน้ารายชื่อค้างไว้จะไม่เห็นคนใหม่จนกว่าจะรีเฟรชเอง
   */
  useEffect(() => {
    const refresh = () => {
      void load();
    };

    window.addEventListener(tenantsChangedEvent, refresh);

    return () => {
      window.removeEventListener(tenantsChangedEvent, refresh);
    };
  }, [load]);

  useEffect(() => {
    if (toast === null) {
      return;
    }

    const timer = window.setTimeout(() => {
      setToast(null);
    }, 3000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [toast]);

  useEffect(() => {
    if (selectedId === null) {
      setTenantBills([]);
      setBillsError(null);
      setBillsLoading(false);
      return;
    }

    // บิลงวดก่อนวันเข้าอยู่ของผู้เช่าคนนี้เป็นไปไม่ได้ — ตัดงวดที่เก่ากว่าออก
    // จำนวนคำขอจึงขึ้นกับอายุการอยู่จริง ไม่ใช่ประวัติทั้งหอ
    const tenant = tenantList.find((item) => item.id === selectedId) ?? null;
    const since = tenant === null ? "" : tenant.checkInDate.slice(0, 7);
    const periods = since === "" ? billPeriods : billPeriods.filter((period) => period >= since);

    let active = true;
    setBillsLoading(true);
    setBillsError(null);

    void Promise.all(periods.map((period) => fetchBills(period)))
      .then((lists) => {
        if (!active) {
          return;
        }

        const owned = lists.flat().filter((bill) => bill.tenantId === selectedId);
        owned.sort((left, right) => (left.period < right.period ? 1 : left.period > right.period ? -1 : 0));
        setTenantBills(owned);
      })
      .catch((loadError: unknown) => {
        if (!active) {
          return;
        }

        setTenantBills([]);
        setBillsError(loadError instanceof ApiError ? loadError.message : "โหลดบิลของผู้เช่าไม่สำเร็จ");
      })
      .finally(() => {
        if (active) {
          setBillsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedId, billPeriods, tenantList]);

  const markPaired = (result: PairingResult) => {
    showToast(`เชื่อม LINE กับ คุณ${result.tenantName} แล้ว`);
    void load();
  };

  const pairingTenants: PinnedTenant[] = tenantList.map((tenant) => ({
    id: tenant.id,
    name: tenant.fullName,
    roomId: tenant.roomNumber,
    phone: tenant.phone,
    checkIn: formatThaiDate(tenant.checkInDate),
    lineLinked: tenant.lineUserId !== null,
    status: tenant.status,
    movedOutAt: tenant.checkOutDate === null ? null : formatThaiDate(tenant.checkOutDate),
  }));

  if (pairingOpen) {
    return (
      <div>
        <PairingSurface
          tenants={pairingTenants}
          onPaired={markPaired}
          onBack={() => {
            setPairingOpen(false);
          }}
        />
        <Toast message={toast ?? ""} open={toast !== null} />
      </div>
    );
  }

  const currentTenants = tenantList.filter((tenant) => tenant.status === "current");
  const movedOutTenants = tenantList.filter((tenant) => tenant.status === "moved-out");
  const visibleTenants = tab === "current" ? currentTenants : movedOutTenants;
  const vacantRooms = roomList.filter((room) => room.status === "vacant");
  const selectedTenant = tenantList.find((tenant) => tenant.id === selectedId) ?? null;

  const needle = query.trim().toLowerCase();
  const filtered = visibleTenants.filter(
    (tenant) =>
      needle === "" ||
      tenant.fullName.toLowerCase().includes(needle) ||
      tenant.roomNumber.toLowerCase().includes(needle) ||
      tenant.phone.includes(needle),
  );

  const openDetail = (tenant: Tenant) => {
    setSelectedId(tenant.id);
  };

  const openAdd = () => {
    setFormError(null);
    setAddOpen(true);
  };

  const openEdit = (tenant: Tenant) => {
    setFormError(null);
    setEditTarget(tenant);
  };

  const openCheckout = (tenant: Tenant) => {
    setCheckoutError(null);
    setCheckoutTarget(tenant);
  };

  const addTenant = async (values: TenantFormValues) => {
    setSaving(true);
    setFormError(null);

    try {
      const created = await createTenant({
        fullName: values.name,
        phone: values.phone,
        roomId: values.roomId,
        checkInDate: values.checkIn,
      });
      setAddOpen(false);
      await load();
      showToast(`เพิ่มผู้เช่า ${created.fullName} ห้อง ${created.roomNumber} แล้ว`);
    } catch (saveError) {
      const failure = saveFailureState(saveError, "เพิ่มผู้เช่าไม่สำเร็จ");
      setFormError(failure.error);
      if (failure.toast) {
        showToast(failure.error.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async (tenant: Tenant, values: TenantFormValues) => {
    setSaving(true);
    setFormError(null);

    try {
      const updated = await updateTenant(tenant.id, {
        fullName: values.name,
        phone: values.phone,
        checkInDate: values.checkIn,
      });
      setEditTarget(null);
      await load();
      showToast(`บันทึกข้อมูล ${updated.fullName} แล้ว`);
    } catch (saveError) {
      const failure = saveFailureState(saveError, "บันทึกข้อมูลผู้เช่าไม่สำเร็จ");
      setFormError(failure.error);
      if (failure.toast) {
        showToast(failure.error.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const confirmCheckout = async (tenant: Tenant, dateIso: string) => {
    setSaving(true);
    setCheckoutError(null);

    try {
      const updated = await checkoutTenant(tenant.id, dateIso);
      setCheckoutTarget(null);
      await load();
      showToast(`เช็คเอาท์ ${updated.fullName} แล้ว ห้อง ${updated.roomNumber} กลายเป็นห้องว่าง`);
    } catch (checkoutFailure) {
      const failure = saveFailureState(checkoutFailure, "เช็คเอาท์ผู้เช่าไม่สำเร็จ");
      setCheckoutError(failure.error.message);
      if (failure.toast) {
        showToast(failure.error.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const columns: DataTableColumn<Tenant>[] = [
    {
      key: "name",
      header: "ผู้เช่า",
      render: (tenant) => (
        <button type="button" className="text-left" onClick={() => openDetail(tenant)}>
          <span className="block font-medium text-charcoal hover:underline">{tenant.fullName}</span>
        </button>
      ),
    },
    { key: "room", header: "ห้อง", render: (tenant) => <span className="num">{tenant.roomNumber}</span> },
    { key: "phone", header: "เบอร์โทร", render: (tenant) => <span className="num">{tenant.phone}</span> },
    { key: "checkIn", header: "วันที่เข้า", render: (tenant) => <span className="num">{formatThaiDate(tenant.checkInDate)}</span> },
    { key: "line", header: "LINE", render: (tenant) => <LineStatusBadge linked={tenant.lineUserId !== null} /> },
    { key: "status", header: "สถานะ", render: (tenant) => <TenantStatusBadge status={tenant.status} /> },
    {
      key: "action",
      header: "จัดการ",
      align: "right",
      render: (tenant) => (
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => openDetail(tenant)}>
            ดูข้อมูล
          </Button>
        </div>
      ),
    },
  ];

  const addInitial: TenantFormValues = { name: "", phone: "", roomId: "", checkIn: todayIso() };
  const editInitial: TenantFormValues =
    editTarget === null
      ? { name: "", phone: "", roomId: "", checkIn: todayIso() }
      : { name: editTarget.fullName, phone: editTarget.phone, roomId: editTarget.roomId, checkIn: editTarget.checkInDate };

  const addRoomOptions =
    vacantRooms.length === 0
      ? [{ value: "", label: "ไม่เหลือห้องว่าง" }]
      : [
          { value: "", label: "ยังไม่ได้เลือก" },
          ...vacantRooms.map((room) => ({ value: room.id, label: `ห้อง ${room.roomNumber}` })),
        ];

  const editRoomOptions =
    editTarget === null ? [] : [{ value: editTarget.roomId, label: `ห้อง ${editTarget.roomNumber}` }];

  return (
    <div>
      <PageHeader
        title="ผู้เช่า"
        supporting={
          loading
            ? "กำลังโหลดข้อมูล"
            : `ผู้เช่าปัจจุบัน ${currentTenants.length} คน · ย้ายออกแล้ว ${movedOutTenants.length} คน`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <TenantsTabs value={tab} onChange={setTab} />
            <Button variant="primary" icon="add" onClick={openAdd}>
              เพิ่มผู้เช่า
            </Button>
          </div>
        }
      />

      {pendingLinks.length > 0 && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <span
                className="ms grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-paper-mist text-[1.25rem] text-slate"
                aria-hidden="true"
              >
                link
              </span>
              <div className="min-w-0">
                <p className="text-sm text-charcoal">
                  มี {pendingLinks.length} คนที่แอด LINE แล้วแต่ยังจับคู่ไม่ได้
                </p>
                <p className="mt-0.5 text-xs text-fog">จับคู่เพื่อให้บิลและข้อความยืนยันส่งถึงผู้เช่าได้</p>
              </div>
            </div>
            <Button
              variant="secondary"
              icon="link"
              onClick={() => {
                setPairingOpen(true);
              }}
            >
              จัดการการเชื่อม LINE
            </Button>
          </div>
        </Card>
      )}

      <Card className="mb-4 md:border-0 md:bg-transparent md:p-0">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="w-full md:hidden sm:w-72">
            <Field label="ค้นหาผู้เช่า" value={query} onChange={setQuery} placeholder="เช่น สมชาย หรือ A101" />
          </div>
          <p className="text-xs text-fog sm:max-w-xs sm:pb-3">LINE · ให้ผู้เช่าแอดบอทและพิมพ์เลขห้อง</p>
        </div>
      </Card>

      <div role="tabpanel" id="tenants-panel" aria-labelledby={`tenants-tab-${tab}`}>
        {loading ? (
          <Card>
            <div className="grid gap-3" aria-busy="true">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          </Card>
        ) : error !== null ? (
          <Card>
            <EmptyState
              icon="cloud_off"
              title="โหลดข้อมูลผู้เช่าไม่สำเร็จ"
              description={error}
              action={
                <Button
                  variant="secondary"
                  icon="refresh"
                  onClick={() => {
                    void load();
                  }}
                >
                  ลองใหม่
                </Button>
              }
            />
          </Card>
        ) : visibleTenants.length === 0 ? (
          <Card>
            <EmptyState
              icon={tab === "current" ? "group" : "history"}
              title={tab === "current" ? "ยังไม่มีผู้เช่าปัจจุบัน" : "ยังไม่มีผู้เช่าที่ย้ายออก"}
              description={
                tab === "current"
                  ? "เพิ่มผู้เช่าคนแรกพร้อมห้อง เบอร์โทร และวันเข้า เพื่อเริ่มออกบิลและส่งข้อความ LINE"
                  : "ผู้เช่าที่เช็คเอาท์แล้วจะยังถูกเก็บประวัติไว้และแสดงในหน้านี้"
              }
              action={
                tab === "current" ? (
                  <Button variant="primary" icon="add" onClick={openAdd}>
                    เพิ่มผู้เช่า
                  </Button>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <>
            <Card className="hidden md:block">
              <DataTable
                columns={columns}
                rows={filtered}
                getRowKey={(tenant) => tenant.id}
                minWidth={960}
                emptyMessage="ไม่พบผู้เช่าที่ตรงกับเงื่อนไข"
              />
            </Card>

            <div className="grid gap-3 md:hidden">
              {filtered.length === 0 && (
                <Card>
                  <EmptyState
                    icon="group"
                    title="ไม่พบผู้เช่าที่ตรงกับเงื่อนไข"
                    description="ลองล้างคำค้นหาเพื่อดูรายชื่อผู้เช่าทั้งหมด"
                  />
                </Card>
              )}
              {filtered.map((tenant) => (
                <Card key={tenant.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-charcoal" title={tenant.fullName}>{tenant.fullName}</p>
                      <p className="num mt-0.5 text-xs text-fog">
                        ห้อง {tenant.roomNumber} · {tenant.phone}
                      </p>
                    </div>
                    <TenantStatusBadge status={tenant.status} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <LineStatusBadge linked={tenant.lineUserId !== null} />
                    <span className="num text-xs text-fog">เข้า {formatThaiDate(tenant.checkInDate)}</span>
                  </div>
                  <div className="mt-3">
                    <Button size="sm" variant="secondary" className="w-full" onClick={() => openDetail(tenant)}>
                      ดูข้อมูล
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>

      <Drawer
        open={selectedTenant !== null}
        onClose={() => {
          setSelectedId(null);
        }}
        title={selectedTenant === null ? "ข้อมูลผู้เช่า" : `ข้อมูลผู้เช่า · ${selectedTenant.fullName}`}
        footer={
          selectedTenant === null ? undefined : (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setSelectedId(null);
                }}
              >
                ปิด
              </Button>
              <Button
                variant="secondary"
                icon="edit"
                onClick={() => {
                  openEdit(selectedTenant);
                  setSelectedId(null);
                }}
              >
                แก้ไข
              </Button>
              {selectedTenant.status === "current" && (
                <Button
                  variant="danger-soft"
                  icon="logout"
                  onClick={() => {
                    openCheckout(selectedTenant);
                    setSelectedId(null);
                  }}
                >
                  เช็คเอาท์
                </Button>
              )}
            </>
          )
        }
      >
        {selectedTenant !== null && (
          <div className="grid gap-5">
            <dl className="grid gap-2.5">
              <DetailRow label="ชื่อ-นามสกุล" value={selectedTenant.fullName} />
              <DetailRow label="ห้อง" value={selectedTenant.roomNumber} numeric />
              <DetailRow label="เบอร์โทร" value={selectedTenant.phone} numeric />
              <DetailRow label="วันที่เข้า" value={formatThaiDate(selectedTenant.checkInDate)} numeric />
              {selectedTenant.checkOutDate !== null && (
                <DetailRow label="วันที่ออก" value={formatThaiDate(selectedTenant.checkOutDate)} numeric />
              )}
            </dl>

            <div>
              <p className="field-label">สถานะ LINE</p>
              <LineStatusBadge linked={selectedTenant.lineUserId !== null} />
              <p className="mt-1.5 text-xs text-fog">ให้ผู้เช่าแอดบอทและพิมพ์เลขห้อง</p>
            </div>

            <div>
              <CardHeader title="บิลของผู้เช่า" description={`บิลของห้องนี้จากรอบบิลล่าสุด ${billPeriods.length} รอบ`} />
              {billsLoading ? (
                <p className="text-sm text-fog">กำลังโหลดบิล</p>
              ) : billsError !== null ? (
                <p className="text-sm text-danger">{billsError}</p>
              ) : tenantBills.length === 0 ? (
                <p className="text-sm text-fog">
                  ยังไม่มีบิลของผู้เช่ารายนี้ในรอบบิลล่าสุด บิลจะแสดงที่นี่เมื่อออกบิลให้ห้องนี้จากหน้า บิล
                </p>
              ) : (
                <ul className="grid gap-2">
                  {tenantBills.map((bill) => (
                    <li
                      key={bill.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-ash px-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-charcoal">{periodLabel(bill.period)}</span>
                        <span className="num block text-xs text-fog">ห้อง {bill.roomNumber}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="num text-sm text-charcoal">{baht(bill.total)} บาท</span>
                        <StatusBadge status={bill.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Drawer>

      <TenantFormDrawer
        open={addOpen}
        seedKey="add"
        title="เพิ่มผู้เช่า"
        submitLabel="บันทึกผู้เช่า"
        initial={addInitial}
        roomLabel="ห้องว่าง"
        roomOptions={addRoomOptions}
        roomHelper={vacantRooms.length === 0 ? "ตอนนี้ไม่มีห้องว่าง กรุณาเช็คเอาท์ผู้เช่าเดิมก่อน" : "เลือกห้องว่างที่ผู้เช่าจะย้ายเข้า"}
        saving={saving}
        serverError={addOpen ? formError : null}
        onClose={() => {
          setAddOpen(false);
          setFormError(null);
        }}
        onSave={(values) => {
          void addTenant(values);
        }}
      />

      <TenantFormDrawer
        open={editTarget !== null}
        seedKey={editTarget === null ? "edit" : editTarget.id}
        title={editTarget === null ? "แก้ไขข้อมูลผู้เช่า" : `แก้ไข · ${editTarget.fullName}`}
        submitLabel="บันทึกการแก้ไข"
        initial={editInitial}
        roomLabel="ห้อง"
        roomOptions={editRoomOptions}
        roomHelper="ย้ายห้องไม่ได้ ต้องเช็คเอาท์ก่อนเพิ่มผู้เช่าใหม่"
        saving={saving}
        serverError={editTarget !== null ? formError : null}
        onClose={() => {
          setEditTarget(null);
          setFormError(null);
        }}
        onSave={(values) => {
          if (editTarget !== null) {
            void saveEdit(editTarget, values);
          }
        }}
      />

      <CheckoutDialog
        tenant={checkoutTarget}
        saving={saving}
        error={checkoutError}
        onClose={() => {
          setCheckoutTarget(null);
          setCheckoutError(null);
        }}
        onConfirm={(tenant, dateIso) => {
          void confirmCheckout(tenant, dateIso);
        }}
      />

      <Toast message={toast ?? ""} open={toast !== null} />
    </div>
  );
}
