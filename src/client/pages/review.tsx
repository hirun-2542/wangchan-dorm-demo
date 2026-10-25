import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  announceReviewQueueChanged,
  fetchSlips,
  resolveSlip,
  type Slip,
  type SlipReason,
  type SlipResolveAction,
} from "../api";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  HeroMoney,
  PageHeader,
  Skeleton,
  Toast,
  type BadgeTone,
} from "../ui";
import { baht, billNumber, stampLabel } from "./bills-shared";
import { periodLabel } from "../period";

type FilterId = "all" | "mismatch" | "not_verified" | "verify_failed" | "duplicate_slip";

const filterOptions: { id: FilterId; label: string }[] = [
  { id: "all", label: "ทั้งหมด" },
  { id: "mismatch", label: "ยอดไม่ตรง" },
  { id: "not_verified", label: "ตรวจไม่ผ่าน" },
  { id: "verify_failed", label: "ตรวจไม่ได้" },
  { id: "duplicate_slip", label: "สลิปซ้ำ" },
];

const reasonLabels: Record<SlipReason, string> = {
  mismatch: "ยอดไม่ตรง",
  not_verified: "ตรวจไม่ผ่าน",
  no_unpaid_bill: "ไม่พบบิลค้างตอนรับสลิป",
  duplicate_slip: "สลิปซ้ำ (ยังไม่ปิดบิล)",
  verify_failed: "ตรวจไม่ได้",
};

const reasonTones: Record<SlipReason, BadgeTone> = {
  mismatch: "unpaid",
  not_verified: "danger",
  no_unpaid_bill: "review",
  duplicate_slip: "review",
  verify_failed: "review",
};

const unknownRoom = "ไม่ทราบห้อง";
const unknownTenant = "ไม่ระบุผู้เช่า";

const settleBlockedReason =
  "สลิปนี้ไม่มีบิลที่ระบบเทียบไว้ ปิดบิลด้วยสลิปนี้ไม่ได้เพราะระบุบิลไม่ได้ กรุณาปฏิเสธสลิปหรือปิดบิลด้วยมือจากหน้าบิล";

const queueLoadFailed = "โหลดคิวสลิปไม่สำเร็จ";
const resolveFailed = "ตัดสินสลิปไม่สำเร็จ";

const rejectNote = "บิลไม่เปลี่ยนแปลง สลิปจะออกจากคิวรอตรวจ";

const rejectHistoryHint =
  "สลิปที่ปฏิเสธแล้วยังดูย้อนหลังได้ที่หน้าบิลของห้องนี้ หัวข้อประวัติการชำระ พร้อมเหตุผลว่าปฏิเสธ ไม่นำมาปิดบิล";

interface Decision {
  slip: Slip;
  action: SlipResolveAction;
}

function roomLabel(slip: Slip): string {
  return slip.bill === null ? unknownRoom : slip.bill.roomNumber;
}

function tenantLabel(slip: Slip): string {
  const name = slip.bill?.tenantName ?? "";
  return name === "" ? unknownTenant : name;
}

function reasonLabel(reason: SlipReason | null): string {
  return reason === null ? "ไม่ระบุสาเหตุ" : reasonLabels[reason];
}

function reasonTone(reason: SlipReason | null): BadgeTone {
  return reason === null ? "neutral" : reasonTones[reason];
}

function billTotalLabel(slip: Slip): string {
  return slip.bill === null ? "ไม่มีบิลเทียบ" : `${baht(slip.bill.total)} บาท`;
}

function amountLabel(value: number | null): string {
  return value === null ? "ไม่มียอด" : `${baht(value)} บาท`;
}

function deltaOf(slip: Slip): number | null {
  if (slip.slipAmount === null || slip.bill === null) {
    return null;
  }

  return slip.slipAmount - slip.bill.total;
}

interface DeltaFigure {
  value: string;
  unit: string;
}

function deltaFigure(delta: number | null): DeltaFigure {
  if (delta === null) {
    return { value: "—", unit: "" };
  }

  return { value: `${delta > 0 ? "+" : ""}${baht(delta)}`, unit: " บาท" };
}

function deltaLabel(delta: number | null): string {
  if (delta === null) {
    return "เทียบไม่ได้";
  }

  if (delta === 0) {
    return "ยอดตรงกัน";
  }

  return `${delta > 0 ? "+" : ""}${baht(delta)} บาท`;
}

interface DeltaBadge {
  tone: BadgeTone;
  label: string;
}

function deltaBadge(delta: number | null): DeltaBadge {
  if (delta === null) {
    return { tone: "neutral", label: "ไม่มีบิลเทียบ" };
  }

  if (delta === 0) {
    return { tone: "paid", label: "ยอดตรงกัน" };
  }

  return delta < 0
    ? { tone: "danger", label: "สลิปขาด" }
    : { tone: "review", label: "สลิปเกิน" };
}

/**
 * เหตุผลของผลตรวจ อ่านแล้วรู้ว่าต้องทำอะไรต่อ
 *
 * เดิมขึ้นแค่ "SlipOK ตรวจไม่ผ่าน" ซึ่งไม่บอกอะไรเลยว่าที่ไม่ผ่านคือสลิปปลอม
 * รูปอ่านไม่ออก หรือระบบเราติดต่อผู้ให้บริการไม่ได้ — สามอย่างนี้ต้องแก้คนละทาง
 */
function verifyDetail(slip: Slip): string {
  if (slip.verified) {
    return "สลิปจริง";
  }

  if (slip.reason === "verify_failed") {
    return slip.verify.detail === null ? "ตรวจไม่ได้" : `ตรวจไม่ได้: ${slip.verify.detail}`;
  }

  if (slip.reason === "duplicate_slip") {
    return slip.verify.message === null
      ? "ผู้ให้บริการแจ้งว่าสลิปนี้เคยถูกส่งเข้ามาแล้ว"
      : `ผู้ให้บริการแจ้งว่าซ้ำ: ${slip.verify.message}`;
  }

  if (slip.verify.message !== null) {
    return slip.verify.code === null
      ? `ตรวจไม่ผ่าน: ${slip.verify.message}`
      : `ตรวจไม่ผ่าน (${slip.verify.code}): ${slip.verify.message}`;
  }

  return "ตรวจไม่ผ่าน";
}

function transRefLabel(slip: Slip): string {
  const transRef = slip.verify.transRef;

  return transRef === null ? "ไม่พบเลขอ้างอิงการโอน" : `เลขอ้างอิง ${transRef}`;
}

function transferLabel(slip: Slip): string {
  const when = slip.transferAt ?? slip.verify.date;

  return when === null ? "ไม่พบเวลาที่โอน" : stampLabel(when);
}

function SlipThumb({ slip }: { slip: Slip }) {
  return (
    <img
      src={slip.imageUrl}
      alt={`สลิปของห้อง ${roomLabel(slip)}`}
      loading="lazy"
      decoding="async"
      className="h-14 w-14 shrink-0 rounded-lg border border-ash bg-paper-mist object-cover"
    />
  );
}

function ConfirmRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-steel">{label}</span>
      <span className="num text-right text-charcoal">{value}</span>
    </div>
  );
}

interface FilterTabsProps {
  value: FilterId;
  onChange: (value: FilterId) => void;
}

function FilterTabs({ value, onChange }: FilterTabsProps) {
  return (
    <div
      className="flex flex-wrap gap-1 rounded-lg border border-ash p-1"
      role="group"
      aria-label="ตัวกรองสลิปรอตรวจ"
    >
      {filterOptions.map((option) => {
        const active = option.id === value;

        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            className={`btn ${active ? "bg-status-unpaid-bg font-medium text-deep-sapphire" : "text-steel hover:bg-paper-mist"}`}
            onClick={() => {
              onChange(option.id);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function ReviewPage() {
  const [items, setItems] = useState<Slip[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<FilterId>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void fetchSlips()
      .then((list) => {
        if (active) {
          setItems(list);
          setQueueError(null);
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        setItems((prev) => prev ?? []);
        setQueueError(
          error instanceof ApiError ? error.message : queueLoadFailed,
        );
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (toast === null) {
      return;
    }

    const timer = window.setTimeout(() => {
      setToast(null);
    }, 3200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [toast]);

  const refreshQuietly = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

  const retryLoad = useCallback(() => {
    setItems(null);
    setQueueError(null);
    setReloadKey((value) => value + 1);
  }, []);

  const visible = (items ?? []).filter(
    (item) => filter === "all" || item.reason === filter,
  );
  const selected =
    visible.find((item) => item.id === selectedId) ?? visible[0] ?? null;
  const selectedKey = selected === null ? null : selected.id;
  const selectedDelta = selected === null ? null : deltaOf(selected);
  const mismatchCount = (items ?? []).filter(
    (item) => item.reason === "mismatch",
  ).length;
  const notVerifiedCount = (items ?? []).filter(
    (item) => item.reason === "not_verified",
  ).length;

  useEffect(() => {
    setActionError(null);
  }, [selectedKey]);

  const runResolve = (slip: Slip, action: SlipResolveAction) => {
    if (busy) {
      return;
    }

    const room = roomLabel(slip);
    const total = slip.bill === null ? null : slip.bill.total;

    setBusy(true);
    setActionError(null);

    void resolveSlip(slip.id, action)
      .then((updated) => {
        setDecision(null);
        setItems((prev) =>
          (prev ?? []).filter((item) => item.id !== updated.id),
        );
        setSelectedId(null);
        refreshQuietly();
        announceReviewQueueChanged();
        setToast(
          action === "settle"
            ? `ปิดบิลห้อง ${room} ยอด ${total === null ? "" : `${baht(total)} บาท `}ด้วยสลิปนี้แล้ว บิลเป็นจ่ายแล้ว และผู้เช่าได้รับการยืนยันทาง LINE`
            : `ปฏิเสธสลิปห้อง ${room} แล้ว บิลไม่เปลี่ยนแปลง`,
        );
      })
      .catch((error: unknown) => {
        const message =
          error instanceof ApiError ? error.message : resolveFailed;

        setDecision(null);
        setActionError(message);
        setToast(message);
        refreshQuietly();
        announceReviewQueueChanged();
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const loading = items === null;
  const list = items ?? [];
  const supporting = loading
    ? "กำลังโหลดคิวสลิป"
    : `${list.length} รายการรอตรวจ · ยอดไม่ตรง ${mismatchCount} · ตรวจไม่ผ่าน ${notVerifiedCount}`;

  return (
    <div>
      <PageHeader
        title="รอตรวจ"
        supporting={supporting}
        actions={
          loading || list.length === 0 ? undefined : (
            <FilterTabs value={filter} onChange={setFilter} />
          )
        }
      />

      {loading ? (
        <div
          className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
          aria-busy="true"
        >
          <Card>
            <div className="grid gap-3">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-2/3" />
            </div>
          </Card>
          <Card>
            <div className="grid gap-3">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-56 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </Card>
        </div>
      ) : list.length === 0 ? (
        queueError === null ? (
          <Card>
            <EmptyState
              icon="check_circle"
              title="ไม่มีสลิปรอตรวจ"
              description="สลิปที่ยอดไม่ตรงหรือ SlipOK ตรวจไม่ผ่าน พร้อมยอดเทียบก่อนปิดบิล จะแสดงที่นี่"
              action={
                <Button
                  variant="secondary"
                  icon="receipt_long"
                  onClick={() => {
                    window.location.hash = "#bills";
                  }}
                >
                  ไปหน้าบิล
                </Button>
              }
            />
          </Card>
        ) : (
          <Card>
            <EmptyState
              icon="cloud_off"
              title="โหลดคิวสลิปไม่สำเร็จ"
              description={queueError}
              action={
                <Button variant="secondary" icon="refresh" onClick={retryLoad}>
                  ลองใหม่
                </Button>
              }
            />
          </Card>
        )
      ) : (
        <>
          {queueError !== null && (
            <Card className="mb-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-danger">{`โหลดคิวสลิปไม่สำเร็จ: ${queueError}`}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="refresh"
                  onClick={retryLoad}
                >
                  ลองใหม่
                </Button>
              </div>
            </Card>
          )}

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Card className="lg:max-h-[calc(100vh-9rem)] lg:overflow-y-auto">
              <CardHeader
                title="คิวสลิป"
                description={`แสดง ${visible.length} จาก ${list.length} รายการ`}
              />
              {visible.length === 0 ? (
                <p className="py-6 text-center text-sm text-fog">
                  ไม่พบสลิปที่ตรงกับตัวกรองที่เลือก
                </p>
              ) : (
                <ul className="grid gap-2">
                  {visible.map((item) => {
                    const active = selected !== null && item.id === selected.id;

                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          aria-pressed={active}
                          onClick={() => {
                            setSelectedId(item.id);
                          }}
                          className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                            active
                              ? "border-pebble bg-paper-mist"
                              : "border-ash hover:bg-paper-mist"
                          }`}
                        >
                          <SlipThumb slip={item} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="truncate text-sm font-medium text-charcoal">{`ห้อง ${roomLabel(item)}`}</span>
                              <Badge tone={reasonTone(item.reason)}>
                                {reasonLabel(item.reason)}
                              </Badge>
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-fog">
                              {tenantLabel(item)}
                            </span>
                            <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-steel">
                              <span>
                                สลิป{" "}
                                <span className="num text-charcoal">
                                  {amountLabel(item.slipAmount)}
                                </span>
                              </span>
                              <span>
                                บิล{" "}
                                <span className="num text-charcoal">
                                  {billTotalLabel(item)}
                                </span>
                              </span>
                            </span>
                            <span className="mt-1 block text-[0.6875rem] text-fog">{`ส่งเมื่อ ${stampLabel(item.createdAt)}`}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            {selected === null ? (
              <Card>
                <EmptyState
                  icon="fact_check"
                  title="ยังไม่ได้เลือกสลิป"
                  description="เลือกสลิปจากคิวด้านซ้ายเพื่อดูรายละเอียดและเทียบยอดก่อนปิดบิล"
                />
              </Card>
            ) : (
              <Card>
                <CardHeader
                  title={`สลิปห้อง ${roomLabel(selected)}`}
                  description={`${tenantLabel(selected)} · ส่งเมื่อ ${stampLabel(selected.createdAt)}`}
                  actions={
                    <Badge tone={reasonTone(selected.reason)} icon="fact_check">
                      {reasonLabel(selected.reason)}
                    </Badge>
                  }
                />

                <div className="grid gap-3">
                  <div className="panel-muted">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-charcoal">
                        สลิปโอนเงินที่ผู้เช่าส่งมา
                      </span>
                      <Badge tone={selected.verified ? "paid" : "danger"}>
                        {selected.verified ? "สลิปจริง" : "ตรวจไม่ผ่าน"}
                      </Badge>
                    </div>
                    <a
                      href={selected.imageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 block"
                    >
                      <img
                        src={selected.imageUrl}
                        alt={`สลิปโอนเงินของห้อง ${roomLabel(selected)}`}
                        decoding="async"
                        className="mx-auto max-h-[420px] w-full rounded-lg border border-ash bg-canvas-white object-contain"
                      />
                    </a>
                    <p className="mt-2 text-xs text-fog">{`กดที่รูปเพื่อเปิดสลิปขนาดเต็ม · โอนเมื่อ ${transferLabel(selected)}`}</p>
                  </div>

                  <div className="rounded-lg border border-ash px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-sm text-steel">ผลตรวจจาก SlipOK</span>
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge
                          tone={selected.verified ? "paid" : "danger"}
                          icon={selected.verified ? "verified" : "error"}
                        >
                          {selected.verified ? "สลิปจริง" : "ตรวจไม่ผ่าน"}
                        </Badge>
                        <span className="num text-xs text-fog">
                          {transRefLabel(selected)}
                        </span>
                      </span>
                    </div>
                    {!selected.verified && (
                      <p className="mt-2 text-sm text-charcoal">{verifyDetail(selected)}</p>
                    )}
                    {selected.reason === "verify_failed" && (
                      <p className="mt-1 text-xs text-fog">
                        ระบบติดต่อผู้ให้บริการตรวจสลิปไม่ได้ จึงยังยืนยันไม่ได้ว่า
                        สลิปจริงหรือไม่ — ตรวจรูปเทียบกับรายการเดินบัญชีเองแล้วตัดสิน
                      </p>
                    )}
                    {selected.reason === "duplicate_slip" && (
                      <p className="mt-1 text-xs text-fog">
                        ผู้ให้บริการยืนยันว่าสลิปใบนี้เคยถูกส่งเข้ามาแล้ว
                        แต่ระบบไม่พบบิลที่ปิดด้วยสลิปนี้
                        {selected.verify.usedSlipId === null
                          ? " — ตรวจยอดกับรายการเดินบัญชีก่อนตัดสิน"
                          : " — มีสลิปที่ปิดบิลด้วยเลขอ้างอิงเดียวกันอยู่ ตรวจว่าใช่ใบเดียวกันหรือไม่"}
                      </p>
                    )}
                  </div>

                  <div className="rounded-lg border border-ash p-4">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div>
                        <p className="text-xs text-fog">ยอดโอนจากสลิป</p>
                        <p className="num mt-1 text-lg text-charcoal">
                          {selected.slipAmount === null
                            ? "—"
                            : baht(selected.slipAmount)}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-fog">ยอดบิล</p>
                        <p className="num mt-1 text-lg text-charcoal">
                          {selected.bill === null
                            ? "—"
                            : baht(selected.bill.total)}
                        </p>
                      </div>
                      <div className="flex flex-col items-start gap-1 sm:items-end sm:text-right">
                        <HeroMoney
                          value={deltaFigure(selectedDelta).value}
                          unit={deltaFigure(selectedDelta).unit}
                          label="ผลต่าง"
                        />
                        <Badge tone={deltaBadge(selectedDelta).tone}>
                          {deltaBadge(selectedDelta).label}
                        </Badge>
                      </div>
                    </div>

                    <div className="mt-3 border-t border-ash pt-3">
                      <p className="text-xs text-fog">บิลที่นำมาเทียบ</p>
                      {selected.bill === null ? (
                        <p className="mt-1 text-sm text-charcoal">
                          สลิปนี้ไม่มีบิลให้เทียบ — ตอนบอทรับสลิป
                          ห้องนี้ไม่มีบิลค้างที่ยังไม่จ่าย
                          (สลิปอาจมาถึงก่อนออกบิล หรือบิลถูกรับชำระไปก่อนแล้ว)
                          ปิดบิลด้วยสลิปนี้จากตรงนี้ไม่ได้
                          ให้ปฏิเสธสลิปแล้วปิดบิลด้วยมือจากหน้าบิล
                        </p>
                      ) : (
                        <>
                          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm text-charcoal">
                              {`ห้อง ${selected.bill.roomNumber} · ${tenantLabel(selected)}`}
                            </span>
                            <a href="#bills" className="text-sm">
                              ดูบิล
                            </a>
                          </div>
                          <p className="mt-0.5 text-xs text-fog">
                            {`รอบบิล ${periodLabel(selected.bill.period)} · เลขที่ใบแจ้งหนี้ ${billNumber(selected.bill)}`}
                          </p>
                          {selected.reason === "no_unpaid_bill" && (
                            <p className="mt-1 text-xs text-fog">
                              บิลใบนี้ถูกปิดไปก่อนที่ระบบจะตรวจสลิปเสร็จ
                              จึงไม่ถูกนับเป็นการปิดอัตโนมัติจากสลิปนี้ —
                              ตรวจว่าเป็นการชำระครั้งเดียวกันหรือไม่ก่อนตัดสิน
                            </p>
                          )}
                        </>
                      )}
                    </div>

                    <div className="mt-3 border-t border-ash pt-3">
                      <p className="text-xs text-fog">วันเวลาที่โอน</p>
                      <p className="num mt-1 text-sm text-charcoal">
                        {transferLabel(selected)}
                      </p>
                    </div>
                  </div>

                  <p className="text-xs text-steel">
                    ระบบเทียบยอดสลิปกับบิลล่าสุดของห้องนี้แล้ว
                    ตรวจทานยอดให้ตรงก่อนตัดสินใจ
                  </p>

                  {actionError !== null && (
                    <p className="text-sm text-danger">{actionError}</p>
                  )}

                  <div className="flex flex-wrap justify-end gap-2 border-t border-ash pt-3">
                    <Button
                      variant="danger-soft"
                      icon="block"
                      disabled={busy}
                      onClick={() => {
                        setDecision({ slip: selected, action: "reject" });
                      }}
                    >
                      ปฏิเสธสลิป
                    </Button>
                    <Button
                      variant="primary"
                      icon="task_alt"
                      disabled={busy || selected.bill === null}
                      title={
                        selected.bill === null ? settleBlockedReason : undefined
                      }
                      onClick={() => {
                        setDecision({ slip: selected, action: "settle" });
                      }}
                    >
                      ปิดบิลด้วยสลิปนี้
                    </Button>
                  </div>

                  {selected.bill === null && (
                    <p className="text-xs text-fog">{settleBlockedReason}</p>
                  )}
                </div>
              </Card>
            )}
          </div>
        </>
      )}

      <Dialog
        open={decision !== null}
        onClose={() => {
          setDecision(null);
        }}
        title={
          decision !== null && decision.action === "reject"
            ? "ยืนยันปฏิเสธสลิป"
            : "ยืนยันปิดบิลใบนี้"
        }
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDecision(null);
              }}
            >
              ยกเลิก
            </Button>
            {decision !== null && decision.action === "reject" ? (
              <Button
                variant="danger-soft"
                icon="block"
                disabled={busy}
                onClick={() => {
                  runResolve(decision.slip, "reject");
                }}
              >
                {busy ? "กำลังปฏิเสธสลิป" : "ยืนยันปฏิเสธสลิป"}
              </Button>
            ) : (
              <Button
                variant="primary"
                icon="task_alt"
                disabled={busy}
                onClick={() => {
                  if (decision !== null) {
                    runResolve(decision.slip, "settle");
                  }
                }}
              >
                {busy ? "กำลังปิดบิล" : "ยืนยันปิดบิล"}
              </Button>
            )}
          </div>
        }
      >
        {decision !== null && (
          <div className="grid gap-3 text-sm">
            <dl className="grid gap-2">
              <ConfirmRow label="ห้อง" value={roomLabel(decision.slip)} />
              <ConfirmRow label="ผู้เช่า" value={tenantLabel(decision.slip)} />
              <ConfirmRow
                label="ยอดในสลิป"
                value={amountLabel(decision.slip.slipAmount)}
              />
              <ConfirmRow
                label="ยอดบิล"
                value={billTotalLabel(decision.slip)}
              />
              <ConfirmRow
                label="ผลต่าง"
                value={deltaLabel(deltaOf(decision.slip))}
              />
            </dl>
            {decision.action === "reject" ? (
              <>
                <p className="text-steel">{rejectNote}</p>
                <p className="text-xs text-fog">{rejectHistoryHint}</p>
              </>
            ) : (
              <p className="text-steel">
                ปิดบิลแล้วย้อนกลับไม่ได้ ระบบจะแจ้งผลให้ผู้เช่าทาง LINE
              </p>
            )}
          </div>
        )}
      </Dialog>

      <Toast message={toast ?? ""} open={toast !== null} />
    </div>
  );
}
