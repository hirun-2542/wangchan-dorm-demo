import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ApiError,
  deletePeaAccount,
  fetchLatestPeaBill,
  fetchPeaAccounts,
  type MeterSheetRow,
  type PeaAccount,
  type PeaBill,
} from "../api";
import { periodLabel } from "../period";
import { Badge, Button, Dialog, Field, IconButton, Select, Skeleton } from "../ui";
import { moneyFormat, peaDigits } from "./bills-pea-import";
import { SharedElectricPanel } from "./bills-shared-electric";

/** ห้องค่าไฟเหมาจ่ายที่ยังไม่ออกบิล พร้อมค่าที่ผู้ใช้กรอกไว้ตอนนี้ — ใช้เทียบก่อนเขียนทับ */
export interface PeaRoom {
  roomId: string;
  roomNumber: string;
  tenantName: string;
  flatAmount: string;
  electricCurrent: string;
  electricPrevious: number;
}

/** ค่าที่จะเขียนลงแถวของห้อง — `electricCurrent` ไม่มี = ไม่แตะมิเตอร์ */
export interface PeaImportItem {
  roomId: string;
  flatAmount: string;
  electricCurrent?: string;
}

interface ElectricManageModalProps {
  open: boolean;
  period: string;
  sheet: MeterSheetRow[];
  rememberedRoomIds: string[];
  peaRooms: PeaRoom[];
  onClose: () => void;
  onSharedApplied: (rate: number, roomIds: string[]) => void;
  onPeaImport: (items: PeaImportItem[]) => void;
}

type TabId = "shared" | "pea";

const tabOptions: { id: TabId; label: string }[] = [
  { id: "shared", label: "คำนวณจากบิลรวม" },
  { id: "pea", label: "ดึงข้อมูลจาก PEA" },
];

/**
 * กล่องจัดการค่าไฟของหน้าสร้างบิล — รวมเครื่องคิดค่าไฟจากบิลรวมกับการดึงยอดจาก PEA ไว้ที่เดียว
 * เนื้อหา mount เฉพาะตอนเปิด (ปิดแล้ว state ของแท็บล้างทิ้ง) แต่ตัว `<dialog>` อยู่ตลอด
 * เพื่อให้ `close()` ของเบราว์เซอร์คืนโฟกัสให้ปุ่มที่เปิดเอง
 */
export function ElectricManageModal({
  open,
  period,
  sheet,
  rememberedRoomIds,
  peaRooms,
  onClose,
  onSharedApplied,
  onPeaImport,
}: ElectricManageModalProps) {
  return (
    <Dialog open={open} onClose={onClose} title={`จัดการค่าไฟ · ${periodLabel(period)}`}>
      {open && (
        <ElectricModalBody
          period={period}
          sheet={sheet}
          rememberedRoomIds={rememberedRoomIds}
          peaRooms={peaRooms}
          onSharedApplied={onSharedApplied}
          onPeaImport={onPeaImport}
        />
      )}
    </Dialog>
  );
}

function ElectricModalBody({
  period,
  sheet,
  rememberedRoomIds,
  peaRooms,
  onSharedApplied,
  onPeaImport,
}: Omit<ElectricManageModalProps, "open" | "onClose">) {
  const [tab, setTab] = useState<TabId>(() =>
    sheet.some((row) => row.electricMode === "meter") || peaRooms.length === 0 ? "shared" : "pea",
  );

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }

    event.preventDefault();

    const next = tabOptions[(index + (event.key === "ArrowRight" ? 1 : -1) + tabOptions.length) % tabOptions.length];

    if (next !== undefined) {
      setTab(next.id);
      document.getElementById(`electric-tab-${next.id}`)?.focus();
    }
  };

  return (
    <div className="electric-modal">
      <p className="mb-3 text-sm text-steel">
        กำหนดค่าไฟของห้อง: คิดอัตราต่อหน่วยจากบิลรวม หรือดึงยอดบิลล่าสุดจาก PEA (การไฟฟ้าส่วนภูมิภาค)
      </p>
      <div role="tablist" aria-label="วิธีกำหนดค่าไฟ" className="flex gap-1 rounded-lg border border-ash p-1">
        {tabOptions.map((option, index) => {
          const active = option.id === tab;

          return (
            <button
              key={option.id}
              id={`electric-tab-${option.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`electric-panel-${option.id}`}
              tabIndex={active ? 0 : -1}
              className={`btn flex-1 ${active ? "bg-status-unpaid-bg font-medium text-deep-sapphire" : "text-steel"}`}
              onClick={() => {
                setTab(option.id);
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

      {/* ซ่อนแท็บที่ไม่ได้ดูด้วย hidden ไม่ถอดออก — ยอดที่พิมพ์ค้างไว้ไม่หายเมื่อสลับแท็บ */}
      <div
        id="electric-panel-shared"
        role="tabpanel"
        aria-labelledby="electric-tab-shared"
        hidden={tab !== "shared"}
        className="mt-3"
      >
        <SharedElectricPanel
          sheet={sheet}
          rememberedRoomIds={rememberedRoomIds}
          period={period}
          onApplied={onSharedApplied}
        />
      </div>
      <div
        id="electric-panel-pea"
        role="tabpanel"
        aria-labelledby="electric-tab-pea"
        hidden={tab !== "pea"}
        className="mt-3"
      >
        <PeaRoomsPanel period={period} rooms={peaRooms} onImport={onPeaImport} />
      </div>
    </div>
  );
}

type Lookup =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; bill: PeaBill | null };

/**
 * ฟอร์มเชื่อมต่อที่แทนเนื้อหาในแท็บ (ไม่เปิดกล่องซ้อน)
 * `roomId` ว่าง = ยังไม่เลือกห้อง; `checked` คือคู่ที่กดตรวจแล้วผ่าน
 */
interface ConnectForm {
  roomId: string;
  ca: string;
  peano: string;
  attempted: boolean;
  /** ค่าที่ตรวจผ่านแล้ว — ใช้ยืนยันว่า `บันทึก` บันทึกคู่ที่เพิ่งตรวจ ไม่ใช่ค่าที่แก้ทีหลัง */
  checked: { ca: string; peano: string } | null;
  checking: boolean;
  saving: boolean;
  error: string | null;
  notice: string | null;
}

interface Change {
  from: string;
  to: string;
  /** มีค่าที่ผู้ใช้กรอกไว้และต่างจากค่าของ PEA */
  overwrite: boolean;
}

interface Plan {
  flat: Change;
  meter: Change | null;
  /** เหตุที่ไม่แตะเลขมิเตอร์ — แสดงให้เห็นแทนการข้ามเงียบ ๆ */
  meterNote: string | null;
}

const meterFormat = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 });

/** ยอดที่ใช้เป็นค่าไฟเหมาจ่ายไม่ได้ (ไม่ใช่ตัวเลขหรือติดลบ) → null ให้ผู้เรียกแจ้งเหตุ */
function planImport(room: PeaRoom, bill: PeaBill): Plan | null {
  if (!Number.isFinite(bill.amount) || bill.amount < 0) {
    return null;
  }

  const typedFlat = room.flatAmount.trim();
  const typedMeter = room.electricCurrent.trim();
  const flat: Change = {
    from: typedFlat,
    to: String(bill.amount),
    overwrite: typedFlat !== "" && Number(typedFlat) !== bill.amount,
  };

  if (bill.meter === null) {
    return { flat, meter: null, meterNote: "PEA ไม่ส่งเลขมิเตอร์ — มิเตอร์ไฟคงเดิม" };
  }

  if (bill.meter < room.electricPrevious) {
    return {
      flat,
      meter: null,
      meterNote: `เลขมิเตอร์ PEA ${meterFormat.format(bill.meter)} น้อยกว่าครั้งก่อน ${meterFormat.format(room.electricPrevious)} ในแอป — มิเตอร์ไฟคงเดิม`,
    };
  }

  return {
    flat,
    meter: {
      from: typedMeter,
      to: String(bill.meter),
      overwrite: typedMeter !== "" && Number(typedMeter) !== bill.meter,
    },
    meterNote: null,
  };
}

function ChangeLine({ label, change, format, unit }: { label: string; change: Change; format: (value: number) => string; unit?: string }) {
  const suffix = unit === undefined ? "" : ` ${unit}`;

  return (
    <>
      <dt className="text-fog">{label}</dt>
      <dd className="num min-w-0 text-charcoal">
        {change.from === "" ? (
          <span className="text-fog">ยังไม่กรอก</span>
        ) : (
          <span className={change.overwrite ? "text-fog line-through" : ""}>{change.from}</span>
        )}
        {" → "}
        <strong className="font-medium">{`${format(Number(change.to))}${suffix}`}</strong>
        {change.overwrite && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs text-status-review-fg">
            <span className="ms text-[0.875rem]" aria-hidden="true">
              warning
            </span>
            เขียนทับค่าที่กรอกไว้
          </span>
        )}
      </dd>
    </>
  );
}

const lookupConcurrency = 3;

function PeaRoomsPanel({
  period,
  rooms,
  onImport,
}: {
  period: string;
  rooms: PeaRoom[];
  onImport: (items: PeaImportItem[]) => void;
}) {
  const [accounts, setAccounts] = useState<PeaAccount[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [accountsKey, setAccountsKey] = useState(0);
  const [lookups, setLookups] = useState<Record<string, Lookup>>({});
  const [form, setForm] = useState<ConnectForm | null>(null);
  const [confirming, setConfirming] = useState<{ roomId: string; roomNumber: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const sequences = useRef<Record<string, number>>({});
  const alive = useRef(true);

  // ปิดกล่อง = คำขอที่ยังค้างอยู่ไม่มีสิทธิ์เขียนลง state ที่ถูกทิ้ง
  // ต้องตั้งกลับเป็น true ตอน setup ด้วย: StrictMode ใน dev mount/cleanup/mount ซ้ำ
  // ถ้าตั้งแค่ตอนสร้าง ref รอบที่สองจะเห็น false ค้าง แล้วผลดึงทั้งหมดถูกทิ้ง (ค้างที่ "กำลังดึง…")
  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    setAccountsError(null);
    void fetchPeaAccounts()
      .then((list) => {
        if (active) {
          setAccounts(list);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setAccountsError(error instanceof ApiError ? error.message : "โหลดหมายเลข PEA ที่จำไว้ไม่สำเร็จ");
        }
      });

    return () => {
      active = false;
    };
  }, [accountsKey]);

  const accountOf = (roomId: string): PeaAccount | undefined =>
    accounts?.find((item) => item.target === roomId);

  const lookupOf = (roomId: string): Lookup => lookups[roomId] ?? { status: "idle" };

  /**
   * ไม่ reject — ความล้มเหลวถูกเก็บเป็นสถานะของห้องนั้น เพื่อให้ดึงทีละหลายห้องได้โดยห้องหนึ่งพังไม่ทำให้ห้องอื่นหยุด
   *
   * ต้องเป็น `verifyOnly` เสมอ: "ดึงข้อมูล" คือการอ่าน ถ้าไม่ส่ง flag นี้ เซิร์ฟเวอร์จะ upsert คู่กลับลง settings
   * ทำให้ห้องที่เพิ่งถูกยกเลิกการเชื่อมต่อระหว่างคิวกลับมาเชื่อมต่อเอง (คู่ที่บันทึกอยู่แล้วไม่ต้องเขียนซ้ำ)
   * การเชื่อมต่อจริงมีทางเดียวคือ `saveConnection`
   */
  const run = (roomId: string, ca: string, peano: string): Promise<void> => {
    const token = (sequences.current[roomId] ?? 0) + 1;

    sequences.current[roomId] = token;
    setLookups((prev) => ({ ...prev, [roomId]: { status: "loading" } }));

    return fetchLatestPeaBill({ target: roomId, ca, peano, verifyOnly: true })
      .then((result) => {
        if (!alive.current || sequences.current[roomId] !== token) {
          return;
        }

        setExcluded((prev) => {
          const next = new Set(prev);

          next.delete(roomId);

          return next;
        });
        setLookups((prev) => ({ ...prev, [roomId]: { status: "ready", bill: result.bill } }));
      })
      .catch((error: unknown) => {
        if (!alive.current || sequences.current[roomId] !== token) {
          return;
        }

        setLookups((prev) => ({
          ...prev,
          [roomId]: {
            status: "error",
            message: error instanceof ApiError ? error.message : "ดึงบิลล่าสุดจาก PEA ไม่สำเร็จ",
          },
        }));
      });
  };

  const connectedRooms = rooms.filter((room) => accountOf(room.roomId) !== undefined);

  const fetchAll = () => {
    const queue = connectedRooms.filter((room) => lookupOf(room.roomId).status !== "loading");
    // ค่าตั้งต้นของ token ต่อห้อง ณ ตอนเข้าคิว — ใช้ดูว่ามีใครแก้/ยกเลิกการเชื่อมต่อระหว่างรอหรือไม่
    const baseline = new Map(queue.map((room) => [room.roomId, sequences.current[room.roomId] ?? 0]));
    let next = 0;

    /**
     * คิวอาจยาวกว่าจำนวน worker — ห้องที่ยังไม่ถึงคิวจึงถูกยกเลิก/แก้การเชื่อมต่อได้ระหว่างรอ
     * ก่อนยิงคำขอจริงต้องยืนยันว่า token ไม่ขยับ (แก้หรือยกเลิกจะ bump token) และคู่ที่จำไว้ยังเป็นคู่เดิม
     * ไม่งั้นห้องที่ถูกยกเลิกไปแล้วจะยิงคำขอด้วยคู่เก่าแล้วกลับมาแสดงว่ายังเชื่อมอยู่
     */
    const stillQueued = (roomId: string, account: PeaAccount): boolean => {
      const current = accountOf(roomId);

      return (
        (sequences.current[roomId] ?? 0) === baseline.get(roomId) &&
        current?.ca === account.ca &&
        current?.peano === account.peano
      );
    };

    const worker = async () => {
      while (alive.current && next < queue.length) {
        const room = queue[next];

        next += 1;

        const account = room === undefined ? undefined : accountOf(room.roomId);

        if (room !== undefined && account !== undefined && stillQueued(room.roomId, account)) {
          await run(room.roomId, account.ca, account.peano);
        }
      }
    };

    void Promise.all(Array.from({ length: lookupConcurrency }, worker));
  };

  const openForm = (roomId: string) => {
    const account = roomId === "" ? undefined : accountOf(roomId);

    setRemoveError(null);
    setForm({
      roomId,
      ca: account?.ca ?? "",
      peano: account?.peano ?? "",
      attempted: false,
      checked: null,
      checking: false,
      saving: false,
      error: null,
      notice: null,
    });
  };

  /**
   * แก้ข้อมูลในฟอร์ม = ผลตรวจ/ผลดึงของค่าเดิมใช้ไม่ได้แล้ว
   * ทิ้งคำขอของห้องเดิมและผลที่ได้มา ไม่ให้นำเข้าของบัญชีอื่นหรือทับสิ่งที่เพิ่งพิมพ์
   */
  const editForm = (patch: Partial<Pick<ConnectForm, "ca" | "peano" | "roomId">>) => {
    setForm((prev) => {
      if (prev === null) {
        return prev;
      }

      if (patch.roomId !== undefined && patch.roomId !== prev.roomId) {
        const account = accountOf(patch.roomId);

        return {
          ...prev,
          roomId: patch.roomId,
          ca: account?.ca ?? "",
          peano: account?.peano ?? "",
          attempted: false,
          checked: null,
          error: null,
          notice: null,
        };
      }

      if (prev.roomId !== "") {
        sequences.current[prev.roomId] = (sequences.current[prev.roomId] ?? 0) + 1;
        setLookups((current) => ({ ...current, [prev.roomId]: { status: "idle" } }));
      }

      return { ...prev, ...patch, checked: null, notice: null };
    });
  };

  /** เรียก PEA ด้วย `verifyOnly` เพื่อดูว่าใช้ได้จริง แต่ยังไม่บันทึกคู่ */
  const checkConnection = () => {
    if (form === null) {
      return;
    }

    const ca = form.ca.trim();
    const peano = form.peano.trim();

    if (form.roomId === "" || !peaDigits.test(ca) || !peaDigits.test(peano)) {
      setForm({ ...form, attempted: true });

      return;
    }

    setForm({ ...form, checking: true, error: null, notice: null });

    void fetchLatestPeaBill({ target: form.roomId, ca, peano, verifyOnly: true })
      .then((result) => {
        if (!alive.current) {
          return;
        }

        setForm((prev) => {
          // ค่าเปลี่ยนระหว่างรอ = ผลนี้ใช้ไม่ได้แล้ว แต่ต้องปลด `checking` ด้วย ไม่งั้นปุ่มทุกตัว
          // (รวม "ย้อนกลับ") ค้าง disabled ตลอดไปเพราะไม่มีคำขอใหม่มาปล่อย
          if (prev === null) {
            return prev;
          }

          if (prev.roomId !== form.roomId || prev.ca.trim() !== ca || prev.peano.trim() !== peano) {
            return { ...prev, checking: false };
          }

          return {
            ...prev,
            checking: false,
            checked: { ca, peano },
            notice:
              result.bill === null
                ? "เชื่อมต่อได้ แต่ PEA ยังไม่มีบิลของหมายเลขนี้"
                : `เชื่อมต่อได้ · บิลล่าสุด ${result.bill.billPeriod} ${moneyFormat.format(result.bill.amount)} บาท`,
          };
        });
      })
      .catch((error: unknown) => {
        if (!alive.current) {
          return;
        }

        setForm((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                checking: false,
                error: error instanceof ApiError ? error.message : "ตรวจสอบการเชื่อมต่อกับ PEA ไม่สำเร็จ",
              },
        );
      });
  };

  /** บันทึกผ่าน endpoint เดิม — เซิร์ฟเวอร์บันทึกคู่ให้เองเมื่อ PEA ตอบสำเร็จ */
  const saveConnection = () => {
    if (form === null) {
      return;
    }

    const ca = form.ca.trim();
    const peano = form.peano.trim();

    if (form.roomId === "" || !peaDigits.test(ca) || !peaDigits.test(peano)) {
      setForm({ ...form, attempted: true });

      return;
    }

    setForm({ ...form, saving: true, error: null, notice: null });

    void fetchLatestPeaBill({ target: form.roomId, ca, peano })
      .then((result) => {
        if (!alive.current) {
          return;
        }

        // เซิร์ฟเวอร์เพิ่งบันทึกคู่นี้ — รายการกลับมาแสดงห้องที่เชื่อมแล้ว พร้อมดึงข้อมูลได้ทันที
        setAccounts((prev) => [...(prev ?? []).filter((item) => item.target !== form.roomId), result.account]);
        setLookups((prev) => ({
          ...prev,
          [form.roomId]: { status: "ready", bill: result.bill },
        }));
        setForm(null);
      })
      .catch((error: unknown) => {
        if (!alive.current) {
          return;
        }

        setForm((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                saving: false,
                error: error instanceof ApiError ? error.message : "บันทึกการเชื่อมต่อไม่สำเร็จ",
              },
        );
      });
  };

  const disconnect = () => {
    if (confirming === null) {
      return;
    }

    const roomId = confirming.roomId;

    setRemoving(true);
    setRemoveError(null);

    void deletePeaAccount(roomId)
      .then(() => {
        if (!alive.current) {
          return;
        }

        sequences.current[roomId] = (sequences.current[roomId] ?? 0) + 1;
        setAccounts((prev) => (prev ?? []).filter((item) => item.target !== roomId));
        setLookups((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== roomId)));
        setExcluded((prev) => {
          const next = new Set(prev);

          next.delete(roomId);

          return next;
        });
        setConfirming(null);
      })
      .catch((error: unknown) => {
        if (!alive.current) {
          return;
        }

        setRemoveError(error instanceof ApiError ? error.message : "ยกเลิกการเชื่อมต่อไม่สำเร็จ");
      })
      .finally(() => {
        if (alive.current) {
          setRemoving(false);
        }
      });
  };

  const importable = rooms.flatMap((room) => {
    const lookup = lookupOf(room.roomId);

    if (lookup.status !== "ready" || lookup.bill === null || excluded.has(room.roomId)) {
      return [];
    }

    const plan = planImport(room, lookup.bill);

    return plan === null ? [] : [{ room, plan }];
  });
  const overwriteCount = importable.filter(
    ({ plan }) => plan.flat.overwrite || plan.meter?.overwrite === true,
  ).length;

  const confirm = () => {
    onImport(
      importable.map(({ room, plan }) => ({
        roomId: room.roomId,
        flatAmount: plan.flat.to,
        ...(plan.meter === null ? {} : { electricCurrent: plan.meter.to }),
      })),
    );
  };

  if (rooms.length === 0) {
    return (
      <p className="text-sm text-steel">
        ไม่มีห้องค่าไฟเหมาจ่ายที่ยังไม่ออกบิลในเดือนนี้ — PEA นำเข้าได้เฉพาะห้องเหมาจ่าย
        ส่วนห้องที่คิดตามมิเตอร์ให้ใช้แท็บ “คำนวณจากบิลรวม”
      </p>
    );
  }

  // ฟอร์มเชื่อมต่อแทนเนื้อหาเดิมของแท็บ (ไม่เปิดกล่องซ้อน) — กลับมาแล้วเห็นรายการพร้อมดึงข้อมูลได้
  if (form !== null) {
    const editing = form.roomId !== "" && accountOf(form.roomId) !== undefined;
    const roomOptions = (editing ? rooms.filter((room) => room.roomId === form.roomId) : rooms.filter((room) => accountOf(room.roomId) === undefined)).map(
      (room) => ({ value: room.roomId, label: `ห้อง ${room.roomNumber} · ${room.tenantName}` }),
    );
    const busy = form.checking || form.saving;
    const caError =
      form.attempted && !peaDigits.test(form.ca.trim()) ? "กรอกหมายเลขผู้ใช้ไฟฟ้า (CA) 1–12 หลัก" : undefined;
    const peanoError =
      form.attempted && !peaDigits.test(form.peano.trim()) ? "กรอกรหัสเครื่องวัด 1–12 หลัก" : undefined;
    const roomError = form.attempted && form.roomId === "" ? "เลือกห้องที่ต้องการเชื่อมต่อ" : undefined;
    const checkedCurrent =
      form.checked !== null &&
      form.checked.ca === form.ca.trim() &&
      form.checked.peano === form.peano.trim();

    return (
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-charcoal">
            {editing ? "แก้ไขการเชื่อมต่อ PEA" : "เชื่อมต่อ PEA"}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            icon="arrow_back"
            disabled={busy}
            onClick={() => {
              setForm(null);
            }}
          >
            ย้อนกลับ
          </Button>
        </div>
        <p className="mt-1 text-xs text-fog">
          ใช้หมายเลขผู้ใช้ไฟฟ้า (CA) กับรหัสเครื่องวัดจากใบแจ้งค่าไฟฟ้า — ระบบบันทึกคู่หมายเลขไว้ของห้องนั้น
          ไม่ได้เก็บประวัติบิล
        </p>

        <div className="mt-3 grid gap-3">
          {editing ? (
            <div>
              <p className="field-label">ห้อง</p>
              <p className="num text-sm text-charcoal">
                {`ห้อง ${rooms.find((room) => room.roomId === form.roomId)?.roomNumber ?? "—"} · ${rooms.find((room) => room.roomId === form.roomId)?.tenantName ?? ""}`}
              </p>
              <p className="mt-1 text-xs text-fog">
                ย้ายการเชื่อมต่อไปห้องอื่นให้ยกเลิกของห้องนี้ก่อน — หนึ่งห้องมีได้คู่เดียว
              </p>
            </div>
          ) : (
            <Select
              label="เลือกห้องพัก"
              value={form.roomId}
              onChange={(value) => {
                editForm({ roomId: value });
              }}
              options={[{ value: "", label: "เลือกห้อง" }, ...roomOptions]}
              helper={roomOptions.length === 0 ? "ทุกห้องที่ออกบิลได้เชื่อมต่อครบแล้ว" : undefined}
            />
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="หมายเลขผู้ใช้ไฟฟ้า (CA)"
              value={form.ca}
              onChange={(value) => {
                editForm({ ca: value });
              }}
              inputMode="numeric"
              helper="ตัวเลข 1–12 หลัก ตามใบแจ้งค่าไฟฟ้า"
              error={caError ?? roomError}
            />
            <Field
              label="รหัสเครื่องวัด"
              value={form.peano}
              onChange={(value) => {
                editForm({ peano: value });
              }}
              inputMode="numeric"
              helper="รหัสเครื่องวัดจากใบแจ้งค่าไฟฟ้า"
              error={peanoError}
            />
          </div>
        </div>

        {form.error !== null && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {form.error}
          </p>
        )}
        {form.notice !== null && (
          <p role="status" className="mt-2 text-xs text-status-paid-fg">
            {form.notice}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-ash pt-3">
          <Button variant="secondary" icon="search" disabled={busy} onClick={checkConnection}>
            {form.checking ? "กำลังตรวจสอบ…" : "ตรวจสอบการเชื่อมต่อ"}
          </Button>
          <Button variant="primary" icon="save" disabled={busy} onClick={saveConnection}>
            {form.saving ? "กำลังบันทึก…" : editing ? "บันทึกการแก้ไข" : "บันทึก"}
          </Button>
        </div>
        <p className="mt-1 text-xs text-fog">
          {checkedCurrent
            ? "ตรวจสอบผ่านแล้ว — กดบันทึกเพื่อใช้คู่นี้กับห้อง"
            : "ตรวจสอบก่อนบันทึกได้ ระบบยังไม่บันทึกอะไรจนกว่าจะกดบันทึก"}
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs text-fog">
        {`ดึงบิลล่าสุดของแต่ละห้องจาก PEA แล้วตรวจงวดให้ตรงกับ ${periodLabel(period)} ก่อนยืนยัน — ระบบเติมเฉพาะค่าไฟเหมาจ่ายกับเลขมิเตอร์ไฟ ไม่ตั้งอัตราและไม่แตะน้ำหรือค่าใช้จ่ายอื่น`}
      </p>
      <dl className="panel-muted mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="font-medium text-charcoal">CA</dt>
        <dd className="text-steel">หมายเลขผู้ใช้ไฟฟ้า — เลขประจำบัญชีผู้ใช้ไฟของห้อง อยู่บนใบแจ้งค่าไฟฟ้า</dd>
        <dt className="font-medium text-charcoal">รหัสเครื่องวัด</dt>
        <dd className="text-steel">เลขประจำตัวมิเตอร์ของห้อง อยู่บนใบแจ้งค่าไฟฟ้า</dd>
        <dt className="font-medium text-charcoal">ค่าไฟเหมาจ่าย</dt>
        <dd className="text-steel">ยอดบิลล่าสุดจาก PEA (บาท) ที่จะใส่เป็นค่าไฟของห้อง</dd>
        <dt className="font-medium text-charcoal">มิเตอร์ไฟ</dt>
        <dd className="text-steel">เลขมิเตอร์หลังใช้ตามบิล จะใส่ในช่องมิเตอร์ไฟของตาราง</dd>
      </dl>

      {accountsError !== null ? (
        <div className="mt-3 rounded-xl border border-danger bg-danger-soft px-3 py-2.5">
          <p role="alert" className="text-sm text-danger">
            {accountsError}
          </p>
          <Button
            variant="ghost"
            size="sm"
            icon="refresh"
            className="mt-1 -ml-3"
            onClick={() => {
              setAccountsKey((value) => value + 1);
            }}
          >
            ลองใหม่
          </Button>
        </div>
      ) : accounts === null ? (
        <div className="mt-3 grid gap-2" aria-busy="true">
          <p role="status" className="text-xs text-fog">
            กำลังโหลดห้องที่เชื่อม PEA…
          </p>
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-charcoal">
              {`เชื่อมแล้ว ${connectedRooms.length} จาก ${rooms.length} ห้อง`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon="add"
                disabled={rooms.length === connectedRooms.length}
                onClick={() => {
                  openForm("");
                }}
              >
                เชื่อมต่อห้อง
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon="download"
                disabled={connectedRooms.length === 0}
                onClick={fetchAll}
              >
                {`ดึงทุกห้องที่เชื่อมแล้ว (${connectedRooms.length})`}
              </Button>
            </div>
          </div>

          {removeError !== null && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {removeError}
            </p>
          )}

          <ul className="mt-2 divide-y divide-ash border-y border-ash">
            {rooms.map((room) => {
              const account = accountOf(room.roomId);
              const lookup = lookupOf(room.roomId);
              const loading = lookup.status === "loading";
              const plan = lookup.status === "ready" && lookup.bill !== null ? planImport(room, lookup.bill) : null;

              return (
                <li key={room.roomId} className="py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <div className="min-w-0 flex-1 basis-32">
                      <span className="num text-sm font-medium text-charcoal">{`ห้อง ${room.roomNumber}`}</span>
                      <span className="ml-2 break-words text-xs text-fog">{room.tenantName}</span>
                      {account !== undefined && (
                        <span className="num mt-0.5 block text-xs text-steel">
                          {`CA ${account.ca} · รหัสเครื่องวัด ${account.peano}`}
                        </span>
                      )}
                    </div>
                    {account === undefined ? (
                      <Badge tone="review" icon="link_off">
                        ยังไม่เชื่อม
                      </Badge>
                    ) : (
                      <Badge tone="paid" icon="check_circle">
                        เชื่อมแล้ว
                      </Badge>
                    )}
                    {account === undefined ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="add"
                        aria-label={`เชื่อมต่อ PEA ห้อง ${room.roomNumber}`}
                        disabled={loading}
                        onClick={() => {
                          openForm(room.roomId);
                        }}
                      >
                        เชื่อมต่อ
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          icon="download"
                          aria-label={loading ? undefined : `${lookup.status === "ready" ? "ดึงใหม่" : "ดึงข้อมูล"} PEA ห้อง ${room.roomNumber}`}
                          disabled={loading}
                          onClick={() => {
                            void run(room.roomId, account.ca, account.peano);
                          }}
                        >
                          {loading ? "กำลังดึง…" : lookup.status === "ready" ? "ดึงใหม่" : "ดึงข้อมูล"}
                        </Button>
                        <IconButton
                          icon="edit"
                          label={`แก้ไขการเชื่อมต่อ PEA ห้อง ${room.roomNumber}`}
                          disabled={loading}
                          onClick={() => {
                            openForm(room.roomId);
                          }}
                        />
                        <IconButton
                          icon="link_off"
                          label={`ยกเลิกการเชื่อมต่อ PEA ห้อง ${room.roomNumber}`}
                          disabled={loading}
                          onClick={() => {
                            setRemoveError(null);
                            setConfirming({ roomId: room.roomId, roomNumber: room.roomNumber });
                          }}
                        />
                      </>
                    )}
                  </div>

                  {loading && (
                    <div className="mt-2" aria-busy="true">
                      <p role="status" className="text-xs text-fog">
                        {`กำลังดึงบิลล่าสุดของห้อง ${room.roomNumber} จาก PEA…`}
                      </p>
                      <Skeleton className="mt-1 h-10 w-full" />
                    </div>
                  )}

                  {lookup.status === "error" && (
                    <p role="alert" className="mt-2 text-xs text-danger">
                      {`ห้อง ${room.roomNumber}: ${lookup.message} — ค่าที่กรอกไว้ในตารางยังอยู่ครบ`}
                    </p>
                  )}

                  {lookup.status === "ready" && lookup.bill === null && (
                    <p className="mt-2 text-xs text-steel">
                      PEA ไม่พบบิลของหมายเลขนี้ — บิลอาจยังไม่ขึ้นในระบบการไฟฟ้า กรอกยอดเองได้ตามปกติ
                    </p>
                  )}

                  {lookup.status === "ready" && lookup.bill !== null && plan === null && (
                    <p role="alert" className="mt-2 text-xs text-danger">
                      {`บิลล่าสุดมียอด ${Number.isFinite(lookup.bill.amount) ? moneyFormat.format(lookup.bill.amount) : "ไม่ระบุ"} บาท ใช้เป็นค่าไฟเหมาจ่ายไม่ได้ — กรอกยอดเองแทน`}
                    </p>
                  )}

                  {lookup.status === "ready" && lookup.bill !== null && plan !== null && (
                    <div className="panel-muted mt-2">
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                        <p className="text-xs text-steel">
                          {`งวด PEA ${lookup.bill.billPeriod} · ${lookup.bill.paidAt === null ? "ยังไม่ชำระ" : `ชำระแล้ว ${lookup.bill.paidAt}`}`}
                        </p>
                        <label className="flex min-h-11 items-center gap-2 text-sm text-charcoal">
                          <input
                            type="checkbox"
                            className="h-5 w-5 accent-charcoal"
                            checked={!excluded.has(room.roomId)}
                            onChange={(event) => {
                              setExcluded((prev) => {
                                const next = new Set(prev);

                                if (event.target.checked) {
                                  next.delete(room.roomId);
                                } else {
                                  next.add(room.roomId);
                                }

                                return next;
                              });
                            }}
                          />
                          นำเข้าห้องนี้
                        </label>
                      </div>
                      <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                        <ChangeLine
                          label="ค่าไฟเหมาจ่าย"
                          change={plan.flat}
                          format={(value) => moneyFormat.format(value)}
                          unit="บาท"
                        />
                        {plan.meter !== null ? (
                          <ChangeLine
                            label="มิเตอร์ไฟ"
                            change={plan.meter}
                            format={(value) => meterFormat.format(value)}
                          />
                        ) : (
                          <>
                            <dt className="text-fog">มิเตอร์ไฟ</dt>
                            <dd className="text-xs text-steel">{plan.meterNote}</dd>
                          </>
                        )}
                      </dl>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="text-xs text-steel">
              {importable.length === 0
                ? "ดึงข้อมูลอย่างน้อยหนึ่งห้องเพื่อดูตัวอย่างก่อนนำเข้า"
                : overwriteCount > 0
                  ? `${overwriteCount} จาก ${importable.length} ห้องจะเขียนทับค่าที่กรอกไว้ — ตรวจตัวอย่างก่อนยืนยัน`
                  : `ไม่มีค่าที่กรอกไว้ถูกเขียนทับ ${importable.length} ห้อง`}
            </p>
            <Button variant="primary" icon="check" disabled={importable.length === 0} onClick={confirm}>
              {overwriteCount > 0
                ? `เขียนทับและนำเข้า ${importable.length} ห้อง`
                : `นำเข้า ${importable.length} ห้อง`}
            </Button>
          </div>
        </>
      )}

      {/* ยืนยันในบรรทัด ไม่เปิดกล่องซ้อน: dialog ซ้อนในโมดัลทำให้ Esc ปิดทั้งสองชั้นพร้อมกัน */}
      {confirming !== null && (
        <div className="mt-3 rounded-xl border border-danger-line bg-danger-soft px-3 py-2.5">
          <p className="text-sm text-charcoal">
            {`ยกเลิกการเชื่อมต่อ PEA ของห้อง ${confirming.roomNumber}?`}
          </p>
          <p className="mt-1 text-xs text-steel">
            บิล เลขมิเตอร์ และค่าที่กรอกไว้ในตารางยังอยู่ครบ — ลบเฉพาะคู่หมายเลข PEA ที่จำไว้
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="danger-soft" icon="link_off" disabled={removing} onClick={disconnect}>
              {removing ? "กำลังยกเลิก…" : "ยกเลิกการเชื่อมต่อ"}
            </Button>
            <Button
              variant="ghost"
              disabled={removing}
              onClick={() => {
                setConfirming(null);
              }}
            >
              ไม่ยกเลิก
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
