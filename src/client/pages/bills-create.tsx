import { useEffect, useMemo, useState } from "react";
import { chargeFromFlatAmount, chargeFromUnits } from "../../shared/billing";
import {
  ApiError,
  announceBillsChanged,
  fetchBillPeriods,
  fetchBills,
  fetchMeterSheet,
  generateBills,
  sendBills,
  type Bill,
  type BillCharge,
  type BillEntryInput,
  type MeterSheetRow,
  type SendAllResult,
  type Settings,
  type Tenant,
} from "../api";
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  HeroMoney,
  PageHeader,
  Select,
  Skeleton,
  type DataTableColumn,
} from "../ui";
import {
  LineStateBadge,
  baht,
  chargesTotal as sumCharges,
  isEmptyDraft,
  chargeDrafts,
  toBillCharge,
  type ChargeDraft,
} from "./bills-shared";
import { periodLabel, periodOptions } from "../period";
import { ChargesModal } from "./bills-charges-modal";
import { ElectricManageModal } from "./bills-electric-modal";
import "./bills-create.css";

export interface CreateWizardProps {
  settings: Settings | null;
  tenants: Tenant[] | null;
  onFinish: () => void;
}

/** ที่มาของค่าไฟที่เห็นในแถว — null = กรอกเอง/คำนวณจากอัตราของห้อง (ไม่ติดป้าย) */
type ElectricSource = "pea" | "shared" | null;

interface MeterRow {
  sheet: MeterSheetRow;
  selected: boolean;
  waterCurrent: string;
  electricCurrent: string;
  flatAmount: string;
  electricSource: ElectricSource;
  charges: ChargeDraft[];
}

type RowStatus = "ready" | "empty" | "error" | "billed";

interface RowCalc {
  isFlat: boolean;
  waterCurrent: number | null;
  waterUnits: number | null;
  waterAmount: number;
  waterInvalid: boolean;
  electricCurrent: number | null;
  electricUnits: number | null;
  /** หน่วยที่สูงจนน่าสงสัยเมื่อเทียบกับบิลล่าสุดของห้อง (ไม่บล็อกการสร้าง — แค่เตือน) */
  electricSuspect: boolean;
  flatAmount: number | null;
  flatAmountInvalid: boolean;
  electricAmount: number;
  electricInvalid: boolean;
  charges: BillCharge[];
  chargesTotal: number;
  chargeInvalid: boolean;
  total: number;
  status: RowStatus;
}

interface Entry {
  row: MeterRow;
  calc: RowCalc;
}

type ServerField = "waterCurrent" | "electricCurrent" | "flatElectricAmount";

interface RowError {
  roomId: string;
  field: ServerField;
  message: string;
}

function toNumber(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** ค่าใช้จ่ายเพิ่มเติมที่เจ้าของแก้เองหรือไม่ — เทียบกับรายการประจำที่ห้องมีตั้งแต่โหลดแถว */
function chargesEdited(row: MeterRow): boolean {
  const key = (name: string, amount: string | number) => `${name.trim()}\u0000${amount}`;
  const typed = row.charges
    .filter((charge) => !isEmptyDraft(charge))
    .map((charge) => key(charge.name, charge.amount.trim()));
  const initial = row.sheet.charges.map((charge) => key(charge.name, charge.amount));

  return typed.length !== initial.length || typed.some((value, index) => value !== initial[index]);
}

/** มีค่าที่เจ้าของพิมพ์ไว้ที่จะหายเมื่อเปลี่ยนงวดหรือปิดหน้า — ใช้ทั้งตัวยืนยันเปลี่ยนงวดกับ beforeunload */
function hasTypedData(rows: MeterRow[]): boolean {
  return rows.some(
    (row) =>
      row.waterCurrent.trim() !== "" ||
      row.electricCurrent.trim() !== "" ||
      row.flatAmount.trim() !== "" ||
      chargesEdited(row),
  );
}

function computeRow(row: MeterRow): RowCalc {
  const { sheet } = row;
  const isFlat = sheet.electricMode === "flat";
  const waterCurrent = toNumber(row.waterCurrent);
  const waterInvalid =
    waterCurrent !== null &&
    (Number.isNaN(waterCurrent) || waterCurrent < sheet.waterPrevious);
  const waterUnits =
    waterCurrent !== null && !waterInvalid
      ? waterCurrent - sheet.waterPrevious
      : null;
  const waterAmount =
    waterUnits === null ? 0 : chargeFromUnits(waterUnits, sheet.waterRate);

  const electricCurrent = toNumber(row.electricCurrent);
  const electricInvalid =
    electricCurrent !== null &&
    (Number.isNaN(electricCurrent) || electricCurrent < sheet.electricPrevious);
  const electricUnits =
    !isFlat && electricCurrent !== null && !electricInvalid
      ? electricCurrent - sheet.electricPrevious
      : null;
  /**
   * หน่วยที่มากกว่าบิลล่าสุดเกิน 2 เท่า = น่าจะพิมพ์เลขเกินหลัก
   * ไม่ใช่การบล็อก: หอจริงมีเดือนที่ใช้ไฟพุ่งได้ และไม่มีข้อมูลพอจะตัดสินแทนเจ้าของ
   * จึงเตือนให้ตรวจก่อนสร้างบิล (หน่วยเป็น 0 ก็ผิดปกติ แต่ปล่อยให้กฎ "ต่ำกว่าครั้งก่อน" จับอยู่แล้ว)
   */
  const previousUnits = sheet.electricUnitsPrevious;
  const electricSuspect =
    electricUnits !== null &&
    electricUnits > 0 &&
    previousUnits !== null &&
    previousUnits > 0 &&
    electricUnits > previousUnits * 2;
  const flatAmount = toNumber(row.flatAmount);
  // ค่าไฟเหมาจ่ายที่พิมพ์ผิด (ตัวอักษรหรือค่าติดลบ) ต้องไม่ถูกนับเป็นพร้อมสร้าง
  const flatAmountInvalid =
    isFlat &&
    flatAmount !== null &&
    (Number.isNaN(flatAmount) || flatAmount < 0);
  const electricRate = sheet.electricRate ?? 0;
  const electricAmount = isFlat
    ? flatAmount === null || Number.isNaN(flatAmount) || flatAmount < 0
      ? 0
      : chargeFromFlatAmount(flatAmount)
    : electricUnits === null
      ? 0
      : chargeFromUnits(electricUnits, electricRate);

  const resolvedCharges = row.charges
    .filter((charge) => !isEmptyDraft(charge))
    .map(toBillCharge);
  const charges = resolvedCharges.filter(
    (charge): charge is BillCharge => charge !== null,
  );
  const chargeInvalid = resolvedCharges.some((charge) => charge === null);
  const chargesTotal = sumCharges(charges);

  const filled =
    waterCurrent !== null &&
    electricCurrent !== null &&
    (!isFlat || flatAmount !== null);
  const status: RowStatus =
    sheet.existingBillId !== null
      ? "billed"
      : waterInvalid || electricInvalid || flatAmountInvalid || chargeInvalid
        ? "error"
        : filled
          ? "ready"
          : "empty";

  return {
    isFlat,
    waterCurrent:
      waterCurrent !== null && Number.isNaN(waterCurrent) ? null : waterCurrent,
    waterUnits,
    waterAmount,
    waterInvalid,
    electricCurrent:
      electricCurrent !== null && Number.isNaN(electricCurrent)
        ? null
        : electricCurrent,
    electricUnits,
    electricSuspect,
    flatAmount:
      flatAmount !== null && Number.isNaN(flatAmount) ? null : flatAmount,
    flatAmountInvalid,
    electricAmount,
    electricInvalid,
    charges,
    chargesTotal,
    chargeInvalid,
    total: sheet.rent + waterAmount + electricAmount + chargesTotal,
    status,
  };
}

function roomNumberFromMessage(message: string): string | null {
  const match = /ห้อง\s*([A-Za-z0-9-]+)/.exec(message);
  return match === null ? null : (match[1] ?? null);
}

function sendAllResultLabel(result: SendAllResult): string {
  if (result.sent > 0) {
    return `ส่งบิลทาง LINE แล้ว ${result.sent} ใบ`;
  }

  if (result.failed > 0) {
    return `ส่งบิลทาง LINE ไม่สำเร็จ ${result.failed} ใบ`;
  }

  return "ไม่มีบิลที่ส่งได้ในเดือนนี้";
}

/** หัวคอลัมน์น้ำ/ไฟ — ไอคอนช่วยแยกกลุ่มน้ำกับไฟตอนกวาดตา ตัวอักษรยังเป็นชื่อคอลัมน์เดิม */
function HeaderWithIcon({ icon, children }: { icon: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="ms text-[1rem]" aria-hidden="true">
        {icon}
      </span>
      {children}
    </span>
  );
}

function MeterStatus({ entry }: { entry: Entry }) {
  const { status, waterInvalid, electricInvalid, flatAmountInvalid } = entry.calc;

  if (status === "ready") {
    // เตือนแต่ไม่บล็อก — ยังนับเป็น "พร้อมสร้าง" เพื่อให้เจ้าของกดสร้างได้ถ้าตรวจแล้วว่าเลขถูก
    return entry.calc.electricSuspect ? (
      <Badge tone="review" icon="warning">
        หน่วยสูงผิดปกติ
      </Badge>
    ) : (
      <Badge tone="paid" icon="check_circle">
        พร้อมสร้าง
      </Badge>
    );
  }

  if (status === "error") {
    return (
      <Badge tone="danger" icon="error">
        {waterInvalid || electricInvalid
          ? "มิเตอร์ย้อนหลัง"
          : flatAmountInvalid
            ? "ค่าไฟเหมาจ่ายไม่ถูกต้อง"
            : "ค่าใช้จ่ายไม่ถูกต้อง"}
      </Badge>
    );
  }

  if (status === "billed") {
    return (
      <Badge tone="neutral" icon="receipt_long">
        ออกบิลแล้ว
      </Badge>
    );
  }

  return (
    <Badge tone="neutral" icon="schedule">
      ยังไม่กรอก
    </Badge>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn";
}) {
  const valueClass =
    tone === "good"
      ? "text-status-paid-fg"
      : tone === "warn"
        ? "text-status-review-fg"
        : "text-charcoal";

  return (
    <Card>
      <p className="text-xs text-fog">{label}</p>
      <p className={`num mt-1 text-lg ${valueClass}`}>{value}</p>
    </Card>
  );
}

function Stepper({ current }: { current: number }) {
  const steps = [
    { number: 1, title: "กรอกข้อมูลมิเตอร์", sub: "กรอกเลขปัจจุบัน" },
    { number: 2, title: "ตรวจสอบและยืนยัน", sub: "ตรวจยอดก่อนสร้าง" },
    { number: 3, title: "ผลการสร้างบิล", sub: "บิลที่บันทึกแล้ว" },
  ];

  return (
    <ol
      className="card mb-4 grid grid-cols-3 gap-3"
      aria-label="ขั้นตอนการสร้างบิล"
    >
      {steps.map((step) => {
        const done = step.number < current;
        const active = step.number === current;
        const dotClass = done
          ? "bg-status-paid-bg text-status-paid-fg"
          : active
            ? "bg-midnight-ink text-canvas-white"
            : "bg-paper-mist text-fog";

        return (
          <li
            key={step.number}
            className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3"
            aria-current={active ? "step" : undefined}
          >
            <span
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm ${dotClass}`}
            >
              {done ? (
                <span className="ms text-[1.125rem]" aria-hidden="true">
                  check
                </span>
              ) : (
                <span className="num" aria-hidden="true">
                  {step.number}
                </span>
              )}
            </span>
            <span className="min-w-0">
              <span
                className={`block text-xs sm:text-sm ${active ? "text-charcoal" : "text-steel"}`}
              >
                {step.title}
              </span>
              <span className="hidden text-xs text-fog sm:block">
                {step.sub}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function periodFromHash(): string {
  const [, searchPart = ""] = window.location.hash.replace(/^#/, "").split("?");
  const requested = new URLSearchParams(searchPart).get("period") ?? "";

  return /^\d{4}-\d{2}$/.test(requested) ? requested : "";
}

/**
 * ช่องเลือกทั้งชุดที่กำลังแสดงอยู่ ใช้ทั้งหัวตารางและแถบด้านล่างของมือถือ
 * จึงรับ checked/indeterminate จากภายนอก เพื่อให้ทั้งสองที่ตรงกันเสมอ
 */
function SelectAllCheckbox({
  checked,
  indeterminate,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  label: string;
  onToggle: (next: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      className="h-6 w-6 shrink-0 accent-charcoal md:h-5 md:w-5"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      ref={(node) => {
        if (node !== null) {
          node.indeterminate = indeterminate;
        }
      }}
      onChange={(event) => {
        onToggle(event.target.checked);
      }}
    />
  );
}

export function CreateWizard({
  settings,
  tenants,
  onFinish,
}: CreateWizardProps) {
  const [step, setStep] = useState(1);
  const [requestedPeriod] = useState<string>(() => periodFromHash());
  const [period, setPeriod] = useState<string>(() =>
    requestedPeriod === "" ? (periodOptions([])[0] ?? "") : requestedPeriod,
  );
  const [periods, setPeriods] = useState<string[]>(() => {
    const options = periodOptions([]);

    return requestedPeriod !== "" && !options.includes(requestedPeriod)
      ? [...options, requestedPeriod].sort().reverse()
      : options;
  });
  const [rows, setRows] = useState<MeterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [chargeRoomId, setChargeRoomId] = useState<string | null>(null);
  /** ในกล่องแก้ค่าใช้จ่ายมีค่าที่พิมพ์ไว้แต่ยังไม่บันทึก — ร่างอยู่ในกล่อง จึงต้องรายงานขึ้นมาให้ตัวเตือนปิดแท็บเห็น */
  const [chargesDraftDirty, setChargesDraftDirty] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [createdBills, setCreatedBills] = useState<Bill[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [rowError, setRowError] = useState<RowError | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [sendingAll, setSendingAll] = useState(false);
  const [sendAllError, setSendAllError] = useState<string | null>(null);
  const [sendAllResult, setSendAllResult] = useState<SendAllResult | null>(
    null,
  );
  const [sendConfirmOpen, setSendConfirmOpen] = useState(false);
  /** กล่องจัดการค่าไฟเปิดอยู่ — ออกจากขั้นกรอกมิเตอร์แล้วต้องไม่ค้างรอเปิดอีกเมื่อย้อนกลับมา */
  const [electricOpen, setElectricOpen] = useState(false);
  const [electricNotice, setElectricNotice] = useState<string | null>(null);

  useEffect(() => {
    if (step !== 1) {
      setElectricOpen(false);
    }
  }, [step]);

  // ปิดแท็บ/รีเฟรชระหว่างกรอกมิเตอร์ = งานต้นเดือนหายทั้งชุด เตือนเฉพาะเมื่อมีอะไรพิมพ์ไว้จริง
  useEffect(() => {
    if (!hasTypedData(rows) && !chargesDraftDirty) {
      return;
    }

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };

    window.addEventListener("beforeunload", warn);

    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [rows, chargesDraftDirty]);

  useEffect(() => {
    let active = true;

    void fetchBillPeriods()
      .then((billed) => {
        if (!active) {
          return;
        }

        const options = periodOptions(billed);

        setPeriods(
          requestedPeriod !== "" && !options.includes(requestedPeriod)
            ? [...options, requestedPeriod].sort().reverse()
            : options,
        );
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [requestedPeriod]);

  useEffect(() => {
    if (period === "") {
      return;
    }

    let active = true;
    setLoading(true);
    setLoadError(null);
    setElectricNotice(null);

    void fetchMeterSheet(period)
      .then((sheet) => {
        if (!active) {
          return;
        }

        setRows(
          sheet.map((row) => ({
            sheet: row,
            selected: row.existingBillId === null,
            waterCurrent: "",
            electricCurrent: "",
            flatAmount: "",
            electricSource: null,
            charges: chargeDrafts(row.charges),
          })),
        );
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        setRows([]);
        setLoadError(
          error instanceof ApiError
            ? error.message
            : "โหลดข้อมูลมิเตอร์ไม่สำเร็จ",
        );
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [period, reloadKey]);

  const updateRow = (
    roomId: string,
    patch: Partial<
      Pick<
        MeterRow,
        | "selected"
        | "waterCurrent"
        | "electricCurrent"
        | "flatAmount"
        | "charges"
        | "electricSource"
      >
    >,
  ) => {
    setRows((prev) =>
      prev.map((row) =>
        row.sheet.roomId === roomId ? { ...row, ...patch } : row,
      ),
    );
  };

  const chargeRow = rows.find((row) => row.sheet.roomId === chargeRoomId);

  const entries: Entry[] = rows.map((row) => ({ row, calc: computeRow(row) }));
  const ready = entries.filter((entry) => entry.calc.status === "ready");
  const emptyCount = entries.filter(
    (entry) => entry.calc.status === "empty",
  ).length;
  const errorCount = entries.filter(
    (entry) => entry.calc.status === "error",
  ).length;
  const billedEntries = entries.filter(
    (entry) => entry.calc.status === "billed",
  );
  const selectedEntries = entries.filter((entry) => entry.row.selected);
  const selectedReady = selectedEntries.filter(
    (entry) => entry.calc.status === "ready",
  );
  // แถวที่หน่วยสูงผิดปกติขึ้นก่อนเพื่อให้ตรวจได้ทันที ส่วนลำดับอื่นคงตามเลขห้อง
  const stepTwoRows = [...selectedReady].sort(
    (a, b) => Number(b.calc.electricSuspect) - Number(a.calc.electricSuspect),
  );
  const blocked = selectedEntries.some(
    (entry) => entry.calc.status === "error",
  );
  const blockedByMeter = selectedEntries.some(
    (entry) => entry.calc.waterInvalid || entry.calc.electricInvalid,
  );

  const firstChargeError = selectedEntries.find(
    (entry) => entry.calc.chargeInvalid,
  );

  /** เปิดกล่องแก้ค่าใช้จ่ายของห้องแรกที่ยังไม่ครบ — กล่องแสดงข้อผิดพลาดของแถวให้เองตอนเปิด */
  const focusFirstChargeError = () => {
    if (firstChargeError !== undefined) {
      setChargeRoomId(firstChargeError.row.sheet.roomId);
    }
  };

  const rentTotal = selectedReady.reduce(
    (sum, entry) => sum + entry.row.sheet.rent,
    0,
  );
  const waterTotal = selectedReady.reduce(
    (sum, entry) => sum + entry.calc.waterAmount,
    0,
  );
  const electricTotal = selectedReady.reduce(
    (sum, entry) => sum + entry.calc.electricAmount,
    0,
  );
  const chargeTotal = selectedReady.reduce(
    (sum, entry) => sum + entry.calc.chargesTotal,
    0,
  );
  const grandTotal = rentTotal + waterTotal + electricTotal + chargeTotal;

  const tenantById = useMemo(
    () => new Map((tenants ?? []).map((tenant) => [tenant.id, tenant])),
    [tenants],
  );

  const connectedOf = (tenantId: string): boolean | null => {
    const tenant = tenantById.get(tenantId);
    return tenant === undefined ? null : tenant.lineUserId !== null;
  };

  const connectedCount =
    tenants === null
      ? null
      : selectedReady.filter(
          (entry) => connectedOf(entry.row.sheet.tenantId) === true,
        ).length;
  const unconnectedEntries =
    tenants === null
      ? []
      : selectedReady.filter(
          (entry) => connectedOf(entry.row.sheet.tenantId) === false,
        );

  const query = search.trim().toLowerCase();
  const visibleEntries = entries.filter((entry) => {
    const matchesQuery =
      query === "" ||
      entry.row.sheet.roomNumber.toLowerCase().includes(query) ||
      entry.row.sheet.tenantName.toLowerCase().includes(query);
    const matchesStatus =
      statusFilter === "all" || entry.calc.status === statusFilter;
    return matchesQuery && matchesStatus;
  });

  // ห้องที่ออกบิลแล้วเลือกไม่ได้ จึงไม่นับเข้าชุด "เลือกทั้งหมด"
  const selectableVisible = visibleEntries.filter(
    (entry) => entry.calc.status !== "billed",
  );
  const selectedVisible = selectableVisible.filter(
    (entry) => entry.row.selected,
  );
  const allVisibleSelected =
    selectableVisible.length > 0 &&
    selectedVisible.length === selectableVisible.length;
  const someVisibleSelected =
    selectedVisible.length > 0 && !allVisibleSelected;

  const setSelectedFor = (roomIds: Set<string>, selected: boolean) => {
    setRows((prev) =>
      prev.map((row) =>
        roomIds.has(row.sheet.roomId) ? { ...row, selected } : row,
      ),
    );
  };

  const toggleAllVisible = (next: boolean) => {
    setSelectedFor(
      new Set(selectableVisible.map((entry) => entry.row.sheet.roomId)),
      next,
    );
  };

  const setSelectedOfKind = (kind: RowStatus, selected: boolean) => {
    setSelectedFor(
      new Set(
        entries
          .filter((entry) => entry.calc.status === kind)
          .map((entry) => entry.row.sheet.roomId),
      ),
      selected,
    );
  };

  const nextDisabled = blocked || selectedReady.length === 0;

  const waterRateOverridden = (entry: Entry): boolean =>
    settings !== null &&
    entry.row.sheet.waterRate !== settings.defaultWaterRate;

  const electricRateOverridden = (entry: Entry): boolean =>
    settings !== null &&
    entry.calc.isFlat === false &&
    entry.row.sheet.electricRate !== settings.defaultElectricRate;

  const meterCell = (
    entry: Entry,
    kind: "water" | "electric",
    variant: "table" | "card" = "table",
  ) => {
    const billed = entry.calc.status === "billed";
    const invalid =
      kind === "water" ? entry.calc.waterInvalid : entry.calc.electricInvalid;
    const value =
      kind === "water" ? entry.row.waterCurrent : entry.row.electricCurrent;
    const previous =
      kind === "water"
        ? entry.row.sheet.waterPrevious
        : entry.row.sheet.electricPrevious;
    const field: ServerField =
      kind === "water" ? "waterCurrent" : "electricCurrent";
    const serverMessage =
      rowError !== null &&
      rowError.roomId === entry.row.sheet.roomId &&
      rowError.field === field
        ? rowError.message
        : undefined;

    if (billed) {
      return <span className="text-fog">—</span>;
    }

    const inCard = variant === "card";

    return (
      <div className={`billing-meter ${inCard ? "" : "justify-items-end"}`}>
        <div className={`flex items-center gap-1 ${inCard ? "flex-wrap" : "justify-end"}`}>
          <span className="num text-xs text-fog">{previous}</span>
          <span className="text-xs text-silver" aria-hidden="true">
            →
          </span>
          <input
            type="text"
            inputMode="numeric"
            className="billing-input"
            placeholder="กรอกเลข"
            value={value}
            data-filled={value.trim() !== ""}
            aria-label={`มิเตอร์${kind === "water" ? "น้ำ" : "ไฟ"}ครั้งนี้ ห้อง ${entry.row.sheet.roomNumber}`}
            aria-invalid={invalid || serverMessage !== undefined}
            aria-describedby={
              invalid || serverMessage !== undefined
                ? `${entry.row.sheet.roomId}-${kind}-error${inCard ? "-card" : ""}`
                : undefined
            }
            onChange={(event) => {
              setRowError(null);
              updateRow(
                entry.row.sheet.roomId,
                kind === "water"
                  ? { waterCurrent: event.target.value }
                  : { electricCurrent: event.target.value },
              );
            }}
          />
        </div>
        {kind === "electric" && entry.calc.electricSuspect && (
          <span
            className={`flex items-center gap-1 text-xs text-status-review-fg ${inCard ? "" : "text-right"}`}
          >
            <span className="ms text-[0.875rem]" aria-hidden="true">
              warning
            </span>
            {`${entry.calc.electricUnits} หน่วย สูงกว่าครั้งก่อน (${entry.row.sheet.electricUnitsPrevious}) เกิน 2 เท่า`}
          </span>
        )}
        {(invalid || serverMessage !== undefined) && (
          <span
            id={`${entry.row.sheet.roomId}-${kind}-error${inCard ? "-card" : ""}`}
            className={`flex items-center gap-1 text-xs text-danger ${inCard ? "" : "text-right"}`}
          >
            <span className="ms text-[0.875rem]" aria-hidden="true">
              error
            </span>
            {serverMessage ?? `น้อยกว่าครั้งก่อน ${previous}`}
          </span>
        )}
      </div>
    );
  };

  const amountCell = (
    entry: Entry,
    kind: "water" | "electric",
    variant: "table" | "card" = "table",
  ) => {
    if (entry.calc.status === "billed") {
      return <span className="text-fog">—</span>;
    }

    const inCard = variant === "card";

    if (kind === "electric" && entry.calc.isFlat) {
      const serverMessage =
        rowError !== null &&
        rowError.roomId === entry.row.sheet.roomId &&
        rowError.field === "flatElectricAmount"
          ? rowError.message
          : undefined;
      const message =
        serverMessage ??
        (entry.calc.flatAmountInvalid
          ? "ยอดค่าไฟเหมาจ่ายต้องเป็นตัวเลขไม่ติดลบ"
          : undefined);

      return (
        <div
          className={`flex flex-col gap-1 ${inCard ? "items-start" : "items-end"}`}
        >
          <input
            type="text"
            inputMode="numeric"
            className="billing-input"
            value={entry.row.flatAmount}
            data-filled={entry.row.flatAmount.trim() !== ""}
            placeholder="กรอกยอด"
            aria-label={`ค่าไฟเหมาจ่าย (บาท) ห้อง ${entry.row.sheet.roomNumber}`}
            aria-invalid={message !== undefined}
            aria-describedby={
              message === undefined
                ? undefined
                : `${entry.row.sheet.roomId}-flat-error${inCard ? "-card" : ""}`
            }
            onChange={(event) => {
              setRowError(null);
              updateRow(entry.row.sheet.roomId, {
                flatAmount: event.target.value,
                electricSource: null,
              });
            }}
          />
          <span className="text-xs text-steel">ค่าไฟเหมาจ่าย (บาท)</span>
          {message !== undefined && (
            <span
              id={`${entry.row.sheet.roomId}-flat-error${inCard ? "-card" : ""}`}
              className={`text-xs text-danger ${inCard ? "" : "text-right"}`}
            >
              {message}
            </span>
          )}
          {entry.row.electricSource === "pea" && (
            <Badge tone="unpaid" icon="download">
              จาก PEA
            </Badge>
          )}
        </div>
      );
    }

    const amount =
      kind === "water" ? entry.calc.waterAmount : entry.calc.electricAmount;
    const units =
      kind === "water" ? entry.calc.waterUnits : entry.calc.electricUnits;
    const rate =
      kind === "water"
        ? entry.row.sheet.waterRate
        : (entry.row.sheet.electricRate ?? 0);

    return (
      <div className={`billing-calculated ${inCard ? "text-left" : "text-right"}`}>
        <span>{units === null ? "—" : `${baht(amount)} บาท`}</span>
        <small>
          {units === null ? "รอกรอก" : `${units} หน่วย × ${rate}`}
        </small>
        {kind === "electric" && entry.row.electricSource === "shared" && (
          <span>
            <Badge tone="unpaid" icon="bolt">
              บิลรวม
            </Badge>
          </span>
        )}
      </div>
    );
  };

  const chargesCell = (entry: Entry) => {
    if (entry.calc.status === "billed") {
      return <span className="text-fog">—</span>;
    }

    const roomId = entry.row.sheet.roomId;
    const roomNumber = entry.row.sheet.roomNumber;
    const names = entry.calc.charges.map((charge) => charge.name);
    const hasCharges = entry.row.charges.some((charge) => !isEmptyDraft(charge));

    return (
      <div className="flex flex-col items-start gap-1">
        <span
          className={`text-sm ${names.length === 0 ? "text-fog" : "num text-charcoal"}`}
        >
          {names.length === 0
            ? "ไม่มีรายการ"
            : `${baht(entry.calc.chargesTotal)} บาท`}
        </span>
        {names.length > 0 && (
          <span className="text-xs text-fog">{names.join(" · ")}</span>
        )}
        {entry.calc.chargeInvalid && (
          <span className="flex items-center gap-1 text-xs text-danger">
            <span className="ms text-[0.875rem]" aria-hidden="true">
              error
            </span>
            ค่าใช้จ่ายเพิ่มเติมต้องมีชื่อและจำนวนเงินเป็นจำนวนเต็มไม่ติดลบ
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={hasCharges ? "edit" : "add"}
          aria-label={`${hasCharges ? "แก้ไขรายการ" : "เพิ่มรายการ"} ห้อง ${roomNumber}`}
          onClick={() => {
            setRowError(null);
            setChargeRoomId(roomId);
          }}
        >
          {hasCharges ? "แก้ไขรายการ" : "เพิ่มรายการ"}
        </Button>
      </div>
    );
  };

  const columns: DataTableColumn<Entry>[] = [
    {
      key: "select",
      header: (
        <SelectAllCheckbox
          checked={allVisibleSelected}
          indeterminate={someVisibleSelected}
          disabled={selectableVisible.length === 0}
          label="เลือกทุกห้องที่แสดงอยู่"
          onToggle={toggleAllVisible}
        />
      ),
      render: (entry) => (
        <input
          type="checkbox"
          className="h-5 w-5 accent-charcoal"
          checked={entry.row.selected}
          disabled={entry.calc.status === "billed"}
          aria-label={`เลือกห้อง ${entry.row.sheet.roomNumber}`}
          onChange={(event) => {
            updateRow(entry.row.sheet.roomId, {
              selected: event.target.checked,
            });
          }}
        />
      ),
    },
    {
      key: "room",
      header: "ห้อง",
      render: (entry) => (
        <div>
          <span className="font-medium text-charcoal">
            {entry.row.sheet.roomNumber}
          </span>
          {waterRateOverridden(entry) || electricRateOverridden(entry) ? (
            <span className="chip mt-1 block w-fit">อัตราพิเศษ</span>
          ) : null}
          {entry.calc.status === "billed" && (
            <span className="mt-1 block text-xs text-fog">ออกบิลเดือนนี้แล้ว</span>
          )}
        </div>
      ),
    },
    {
      key: "tenant",
      header: "ผู้เช่า",
      render: (entry) => (
        <span className="text-steel">{entry.row.sheet.tenantName}</span>
      ),
    },
    {
      key: "rent",
      header: "ค่าเช่า",
      align: "right",
      render: (entry) => <span className="text-steel">{baht(entry.row.sheet.rent)}</span>,
    },
    {
      key: "waterMeter",
      header: <HeaderWithIcon icon="water_drop">มิเตอร์น้ำ</HeaderWithIcon>,
      align: "right",
      render: (entry) => meterCell(entry, "water"),
    },
    {
      key: "waterAmount",
      header: <HeaderWithIcon icon="water_drop">ค่าน้ำ</HeaderWithIcon>,
      align: "right",
      render: (entry) => amountCell(entry, "water"),
    },
    {
      key: "electricMeter",
      header: <HeaderWithIcon icon="bolt">มิเตอร์ไฟ</HeaderWithIcon>,
      align: "right",
      render: (entry) => meterCell(entry, "electric"),
    },
    {
      key: "electricAmount",
      header: <HeaderWithIcon icon="bolt">ค่าไฟ</HeaderWithIcon>,
      align: "right",
      render: (entry) => amountCell(entry, "electric"),
    },
    {
      key: "charges",
      header: "ค่าใช้จ่ายเพิ่มเติม",
      render: (entry) => chargesCell(entry),
    },
    {
      key: "total",
      header: "ยอดรวม",
      align: "right",
      render: (entry) =>
        entry.calc.status === "billed" || entry.calc.status === "error" ? (
          <span className="text-fog">—</span>
        ) : (
          <span className="font-medium">{baht(entry.calc.total)}</span>
        ),
    },
    {
      key: "status",
      header: "สถานะ",
      render: (entry) => <MeterStatus entry={entry} />,
    },
  ];

  const meterCard = (entry: Entry) => {
    const billed = entry.calc.status === "billed";

    return (
      <Card key={entry.row.sheet.roomId} className="billing-room-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {/* ห่อ label 44×44: ตัว checkbox 24px กดพลาดง่ายบนมือถือ — -m-2.5 ดึงกลับให้ตำแหน่งเดิม */}
            <label className="-m-2.5 grid h-11 w-11 shrink-0 place-items-center">
              <input
                type="checkbox"
                className="h-6 w-6 accent-charcoal"
                checked={entry.row.selected}
                disabled={billed}
                aria-label={`เลือกห้อง ${entry.row.sheet.roomNumber}`}
                onChange={(event) => {
                  updateRow(entry.row.sheet.roomId, {
                    selected: event.target.checked,
                  });
                }}
              />
            </label>
            <div className="min-w-0">
              <p className="font-medium text-charcoal">
                {entry.row.sheet.roomNumber}
              </p>
              <p className="text-xs text-fog">{entry.row.sheet.tenantName}</p>
              {(waterRateOverridden(entry) ||
                electricRateOverridden(entry)) && (
                <span className="chip mt-1">อัตราพิเศษ</span>
              )}
            </div>
          </div>
          <div className="shrink-0">
            <MeterStatus entry={entry} />
          </div>
        </div>

        {billed ? (
          <p className="mt-3 border-t border-ash pt-3 text-xs text-fog">
            ออกบิลเดือนนี้แล้ว · ห้องนี้ไม่ถูกเลือกให้สร้างบิลซ้ำ
          </p>
        ) : (
          <>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-ash pt-3">
              <div>
                <dt className="text-xs font-medium text-status-unpaid-fg">มิเตอร์น้ำ · ครั้งนี้</dt>
                <dd className="mt-1 flex flex-col gap-2">
                  {meterCell(entry, "water", "card")}
                  {amountCell(entry, "water", "card")}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-status-unpaid-fg">มิเตอร์ไฟ · ครั้งนี้</dt>
                <dd className="mt-1 flex flex-col gap-2">
                  {meterCell(entry, "electric", "card")}
                  {amountCell(entry, "electric", "card")}
                </dd>
              </div>
            </dl>

            <div className="mt-3 border-t border-ash pt-3">
              <p className="text-xs text-fog">ค่าใช้จ่ายเพิ่มเติม</p>
              <div className="mt-2">{chargesCell(entry)}</div>
            </div>

            <div className="mt-3 border-t border-ash pt-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-steel">ยอดรวม</span>
                <span className="num text-lg text-charcoal">
                  {entry.calc.status === "error" ? "—" : `${baht(entry.calc.total)} บาท`}
                </span>
              </div>
              <p className="num mt-1 text-xs text-fog">{`ค่าเช่า ${baht(entry.row.sheet.rent)} บาท`}</p>
            </div>
          </>
        )}
      </Card>
    );
  };

  const createdTotal = createdBills.reduce((sum, bill) => sum + bill.total, 0);
  const createdUnconnected = createdBills.filter(
    (bill) => connectedOf(bill.tenantId) === false,
  );

  const createBills = () => {
    const payload: BillEntryInput[] = selectedReady.map((entry) => {
      const input: BillEntryInput = {
        roomId: entry.row.sheet.roomId,
        waterCurrent: entry.calc.waterCurrent ?? 0,
        electricCurrent: entry.calc.electricCurrent ?? 0,
      };

      if (entry.calc.isFlat && entry.calc.flatAmount !== null) {
        input.flatElectricAmount = entry.calc.flatAmount;
      }

      if (entry.calc.charges.length > 0) {
        input.charges = entry.calc.charges;
      }

      return input;
    });

    setSubmitting(true);
    setRowError(null);
    setGenerateError(null);

    void generateBills(period, payload)
      .then((created) => {
        setCreatedBills(created);
        setStep(3);
        // หน้ารายการบิลโหลดไว้ก่อนแล้ว ต้องบอกให้ดึงใหม่ ไม่งั้นจะเห็นชุดบิลเดิม
        announceBillsChanged();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError) {
          setGenerateError(error.message);

          const roomNumber = roomNumberFromMessage(error.message);

          if (
            roomNumber !== null &&
            (error.field === "waterCurrent" ||
              error.field === "electricCurrent" ||
              error.field === "flatElectricAmount")
          ) {
            const target = rows.find(
              (row) => row.sheet.roomNumber === roomNumber,
            );

            if (target !== undefined) {
              setRowError({
                roomId: target.sheet.roomId,
                field: error.field,
                message: error.message,
              });
            }
          }
        } else {
          setGenerateError("สร้างบิลไม่สำเร็จ");
        }
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const reloadSheet = () => {
    setStep(1);
    setGenerateError(null);
    setRowError(null);
    setReloadKey((value) => value + 1);
  };

  const refreshCreatedBills = () => {
    const ids = new Set(createdBills.map((bill) => bill.id));

    void fetchBills(period)
      .then((list) => {
        setCreatedBills(list.filter((bill) => ids.has(bill.id)));
      })
      .catch(() => undefined);
  };

  const sendCreatedBills = (billIds?: string[]) => {
    setSendingAll(true);
    setSendAllError(null);
    setSendConfirmOpen(false);

    void sendBills(period, billIds)
      .then((result) => {
        setSendAllResult(result);
        refreshCreatedBills();
        // สถานะส่งของบิลเปลี่ยน หน้ารายการที่โหลดไว้ต้องเปลี่ยนตาม
        announceBillsChanged();
      })
      .catch((error: unknown) => {
        setSendAllError(
          error instanceof ApiError
            ? error.message
            : "ส่งบิลทาง LINE ไม่สำเร็จ",
        );
      })
      .finally(() => {
        setSendingAll(false);
      });
  };

  // ห้องเหมาจ่ายที่ยังไม่ออกบิล — แท็บ PEA ใช้ค่าที่กรอกไว้ตอนนี้เทียบก่อนเขียนทับ
  const peaRooms = entries
    .filter((entry) => entry.calc.isFlat && entry.calc.status !== "billed")
    .map((entry) => ({
      roomId: entry.row.sheet.roomId,
      roomNumber: entry.row.sheet.roomNumber,
      tenantName: entry.row.sheet.tenantName,
      flatAmount: entry.row.flatAmount,
      electricCurrent: entry.row.electricCurrent,
      electricPrevious: entry.row.sheet.electricPrevious,
    }));

  return (
    <div>
      <PageHeader
        title="สร้างบิล"
        supporting="กรอกเลขมิเตอร์ ตรวจยอด แล้วสร้างบิลทั้งหอ"
      />
      <Stepper current={step} />

      {step === 1 && (
        <>
          <div className="mb-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="field-label mb-0" htmlFor="wizard-period">
                รอบบิล
              </label>
              <select
                id="wizard-period"
                className="input w-auto"
                value={period}
                onChange={(event) => {
                  const next = event.target.value;

                  // เปลี่ยนงวด = โหลดแถวใหม่ทั้งชุด ค่าที่พิมพ์ไว้หายหมด
                  // ยืนยันก่อนถ้ามีอะไรให้เสีย เพื่อไม่ให้งานต้นเดือนหายเพราะเผลอเลือกผิด
                  if (
                    hasTypedData(rows) &&
                    !window.confirm(
                      `เปลี่ยนงวดเป็น ${periodLabel(next)}?\nค่าที่กรอกไว้ในงวดนี้จะหายทั้งหมด`,
                    )
                  ) {
                    // ผู้ใช้ยกเลิก — ค่าใน <select> ยังเปลี่ยนไปแล้ว ต้องบังคับให้ตรงกับ state
                    event.target.value = period;

                    return;
                  }

                  setPeriod(next);
                }}
              >
                {periods.map((option) => (
                  <option key={option} value={option}>
                    {periodLabel(option)}
                  </option>
                ))}
              </select>
              {loading ? (
                <Badge tone="neutral" icon="pending_actions">
                  กำลังโหลดข้อมูล
                </Badge>
              ) : billedEntries.length === 0 ? (
                <Badge tone="neutral" icon="pending_actions">
                  ยังไม่สร้างบิล
                </Badge>
              ) : billedEntries.length === entries.length ? (
                <Badge tone="paid" icon="check_circle">
                  {`ออกบิลครบแล้ว ${billedEntries.length} ห้อง`}
                </Badge>
              ) : (
                <Badge tone="review" icon="receipt_long">
                  {`ออกบิลแล้ว ${billedEntries.length} จาก ${entries.length} ห้อง`}
                </Badge>
              )}
              {!loading && loadError === null && rows.length > 0 && (
                <Button
                  variant="primary"
                  icon="bolt"
                  aria-haspopup="dialog"
                  onClick={() => {
                    setElectricNotice(null);
                    setElectricOpen(true);
                  }}
                >
                  จัดการค่าไฟ
                  <span className="rounded-full border border-current px-1.5 text-[0.6875rem] leading-4 opacity-80">
                    PEA
                  </span>
                </Button>
              )}
              <span role="status" className="text-xs text-status-paid-fg empty:hidden">
                {electricNotice}
              </span>
              <span className="ml-auto text-xs text-fog">
                สร้างเฉพาะห้องที่มีผู้เช่า
              </span>
            </div>
          </div>

          {loading ? (
            <Card>
              <div className="grid gap-3" aria-busy="true">
                <Skeleton className="h-5 w-44" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-2/3" />
              </div>
            </Card>
          ) : loadError !== null ? (
            <Card>
              <EmptyState
                icon="cloud_off"
                title="โหลดข้อมูลมิเตอร์ไม่สำเร็จ"
                description={loadError}
                action={
                  <Button
                    variant="secondary"
                    icon="refresh"
                    onClick={() => {
                      setReloadKey((value) => value + 1);
                    }}
                  >
                    ลองใหม่
                  </Button>
                }
              />
            </Card>
          ) : rows.length === 0 ? (
            <Card>
              <EmptyState
                icon="door_front"
                title="ยังไม่มีห้องที่มีผู้เช่า"
                description="เพิ่มผู้เช่าให้ห้องก่อน แล้วกลับมาเปิดบิลเดือนนี้"
                action={
                  <Button
                    variant="secondary"
                    icon="group"
                    onClick={() => {
                      window.location.hash = "#tenants";
                    }}
                  >
                    ไปหน้าผู้เช่า
                  </Button>
                }
              />
            </Card>
          ) : (
            <>

              {billedEntries.length > 0 && (
                <div className="panel-muted mb-4">
                  <div className="flex items-start gap-3">
                    <span
                      className="ms mt-0.5 text-[1.25rem] text-steel"
                      aria-hidden="true"
                    >
                      receipt_long
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-charcoal">{`มี ${billedEntries.length} ห้องที่ออกบิลเดือนนี้แล้ว`}</p>
                      <p className="mt-1 text-sm text-steel">
                        {billedEntries
                          .map((entry) => entry.row.sheet.roomNumber)
                          .join(" · ")}
                      </p>
                      <p className="mt-1 text-xs text-fog">
                        ห้องเหล่านี้ไม่ถูกเลือกให้สร้างบิลซ้ำในเดือนนี้
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div>
                  <Card>
                    <div className="mb-4">
                      <h2 className="flex items-baseline gap-2 text-base text-charcoal">
                        กรอกมิเตอร์
                        <span className="num text-sm font-normal text-fog">
                          {`กรอกครบ ${ready.length} / ${entries.length - billedEntries.length}`}
                        </span>
                      </h2>
                      <p className="mt-1 text-sm text-steel">กรอกเลขมิเตอร์ปัจจุบันของแต่ละห้อง แล้วตรวจยอดรวมก่อนสร้างบิล</p>
                    </div>
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="w-full sm:w-60">
                        <Field
                          label="ค้นหาห้องหรือผู้เช่า"
                          value={search}
                          onChange={setSearch}
                          placeholder="เช่น A101 หรือ สมชาย"
                        />
                      </div>
                      <div className="w-full sm:w-40">
                        <Select
                          label="สถานะ"
                          value={statusFilter}
                          onChange={setStatusFilter}
                          options={[
                            { value: "all", label: "ทั้งหมด" },
                            { value: "ready", label: "พร้อมสร้าง" },
                            { value: "empty", label: "ยังไม่กรอก" },
                            { value: "error", label: "ผิดพลาด" },
                            { value: "billed", label: "ออกบิลแล้ว" },
                          ]}
                        />
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ash pt-3">
                      <label className="flex min-h-11 items-center gap-2 text-sm text-charcoal min-[1440px]:hidden">
                        <SelectAllCheckbox
                          checked={allVisibleSelected}
                          indeterminate={someVisibleSelected}
                          disabled={selectableVisible.length === 0}
                          label="เลือกทุกห้องที่แสดงอยู่"
                          onToggle={toggleAllVisible}
                        />
                        {`เลือกที่แสดงอยู่ ${selectedVisible.length}/${selectableVisible.length}`}
                      </label>
                      <details className="billing-selection">
                        <summary>ตัวเลือกการเลือกห้อง</summary>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={selectableVisible.length === 0}
                            onClick={() => {
                              toggleAllVisible(true);
                            }}
                          >
                            {visibleEntries.length === entries.length
                              ? "เลือกทั้งหมด"
                              : "เลือกที่แสดงอยู่"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={selectedEntries.length === 0}
                            onClick={() => {
                              toggleAllVisible(false);
                            }}
                          >
                            ไม่เลือกเลย
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="done_all"
                            disabled={ready.length === 0}
                            aria-label={`เลือกเฉพาะที่กรอกครบ ${ready.length} ห้อง`}
                            onClick={() => {
                              setSelectedOfKind("ready", true);
                            }}
                          >
                            {`เลือกเฉพาะที่กรอกครบ ${ready.length}`}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="block"
                            disabled={emptyCount === 0}
                            aria-label={`ไม่เลือกที่ยังไม่กรอก ${emptyCount} ห้อง`}
                            onClick={() => {
                              setSelectedOfKind("empty", false);
                            }}
                          >
                            {`ไม่เลือกที่ยังไม่กรอก ${emptyCount}`}
                          </Button>
                        </div>
                      </details>
                    </div>
                  </Card>

                  <Card className="mt-4 hidden min-[1440px]:block">
                    {/* ตาราง 11 คอลัมน์แบบเดิมกว้าง 1126px หลังจากย่อช่องกรอกแล้ว จึงเปิดเฉพาะจอ ≥1440px
                        (เหลือที่ให้แถบเมนูและขอบหน้า) ต่ำกว่านี้ใช้การ์ดซึ่งกวาดตาง่ายกว่าและไม่ต้องเลื่อนข้างในตาราง */}
                    <DataTable
                      columns={columns}
                      rows={visibleEntries}
                      getRowKey={(entry) => entry.row.sheet.roomId}
                      minWidth={1080}
                      wrapClassName="billing-meter-table"
                      emptyMessage="ไม่พบห้องที่ตรงกับเงื่อนไข"
                    />
                  </Card>

                  <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 min-[1440px]:hidden">
                    {visibleEntries.length === 0 ? (
                      <Card className="md:col-span-2">
                        <EmptyState
                          icon="search_off"
                          title="ไม่พบห้องที่ตรงกับเงื่อนไข"
                          description="ลองล้างคำค้นหาหรือเปลี่ยนตัวกรองสถานะ"
                        />
                      </Card>
                    ) : (
                      visibleEntries.map((entry) => meterCard(entry))
                    )}
                  </div>
              </div>

              <div className="sticky bottom-[calc(56px_+_env(safe-area-inset-bottom))] z-20 -mx-4 mt-4 border-t border-ash bg-canvas-white px-4 py-3 md:-mx-6 md:bottom-0 md:px-6">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-ash pb-2">
                  <p className="num flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="text-status-paid-fg">{`กรอกครบ ${ready.length}`}</span>
                    <span className="text-status-review-fg">{`ยังไม่กรอก ${emptyCount}`}</span>
                    {errorCount > 0 && <span className="text-danger">{`ข้อผิดพลาด ${errorCount}`}</span>}
                    {billedEntries.length > 0 && (
                      <span className="text-fog">{`ออกบิลแล้ว ${billedEntries.length}`}</span>
                    )}
                    <span className="text-steel">{`จาก ${entries.length} ห้อง`}</span>
                  </p>
                  <p className="num ml-auto hidden text-sm text-charcoal sm:block">
                    {`เลือกไว้ ${selectedEntries.length} ห้อง · พร้อมสร้าง ${selectedReady.length}`}
                  </p>
                </div>

                <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-2">
                  <div>
                    <p className="text-xs text-fog">ยอดรวม</p>
                    <p className="num text-sm font-medium text-charcoal">
                      {baht(grandTotal)}
                    </p>
                  </div>
                  <div className="ml-auto flex flex-col items-end gap-1">
                    <Button
                      variant="primary"
                      icon="arrow_forward"
                      disabled={nextDisabled}
                      onClick={() => {
                        setStep(2);
                      }}
                    >
                      ตรวจสอบและยืนยัน
                    </Button>
                    <p className="text-xs text-fog">
                      {blocked ? (
                        blockedByMeter ? (
                          "แก้มิเตอร์ที่น้อยกว่าครั้งก่อนก่อนไปต่อ"
                        ) : (
                          <button
                            type="button"
                            className="text-steel underline underline-offset-4 hover:text-charcoal"
                            onClick={focusFirstChargeError}
                          >
                            แก้ค่าใช้จ่ายเพิ่มเติมที่ยังไม่ครบก่อนไปต่อ
                          </button>
                        )
                      ) : selectedReady.length === 0 ? (
                        "เลือกและกรอกมิเตอร์อย่างน้อย 1 ห้อง"
                      ) : (
                        `จะสร้าง ${selectedReady.length} บิล`
                      )}
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {step === 2 && (
        <>
          <Card className="mb-4">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
              <HeroMoney value={baht(grandTotal)} label="ยอดรวม" />
              <p className="text-sm text-steel">{`จะสร้าง ${selectedReady.length} บิล`}</p>
            </div>
          </Card>

          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <Metric
              label="LINE พร้อมส่ง"
              value={connectedCount === null ? "—" : `${connectedCount} คน`}
              tone="good"
            />
            <Metric
              label="LINE ยังไม่เชื่อม"
              value={tenants === null ? "—" : `${unconnectedEntries.length} คน`}
              tone={
                tenants !== null && unconnectedEntries.length > 0
                  ? "warn"
                  : undefined
              }
            />
          </div>

          {generateError !== null && (
            <div
              className="mt-4 rounded-xl border border-danger bg-danger-soft px-4 py-3"
              role="alert"
            >
              <p className="text-sm font-medium text-charcoal">
                สร้างบิลไม่สำเร็จ
              </p>
              <p className="mt-1 text-sm text-steel">{generateError}</p>
              <Button
                variant="secondary"
                icon="refresh"
                className="mt-3"
                onClick={() => {
                  reloadSheet();
                }}
              >
                โหลดข้อมูลมิเตอร์ใหม่
              </Button>
            </div>
          )}

          {unconnectedEntries.length > 0 && (
            <div className="panel-muted mt-4">
              <div className="flex items-start gap-3">
                <span
                  className="ms mt-0.5 text-[1.25rem] text-status-review-fg"
                  aria-hidden="true"
                >
                  warning
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-charcoal">
                    {`มี ${unconnectedEntries.length} ห้องที่ผู้เช่ายังไม่เชื่อม LINE`}
                  </p>
                  <p className="mt-1 text-sm text-steel">
                    {unconnectedEntries
                      .map(
                        (entry) =>
                          `${entry.row.sheet.roomNumber} ${entry.row.sheet.tenantName}`,
                      )
                      .join(" · ")}
                  </p>
                  <p className="mt-1 text-xs text-fog">
                    บิลยังสร้างได้ แต่ผู้เช่าเหล่านี้จะยังไม่ได้รับบิลทาง LINE
                  </p>
                </div>
              </div>
            </div>
          )}

          <Card className="mt-4">
            <DataTable
              minWidth={0}
              getRowKey={(entry) => entry.row.sheet.roomId}
              rows={stepTwoRows}
              columns={[
                {
                  key: "room",
                  header: "ห้อง",
                  render: (entry) => (
                    <span className="font-medium text-charcoal">
                      {entry.row.sheet.roomNumber}
                    </span>
                  ),
                },
                {
                  key: "tenant",
                  header: "ผู้เช่า",
                  render: (entry) => (
                    <span className="text-steel">
                      {entry.row.sheet.tenantName}
                    </span>
                  ),
                },
                {
                  key: "rent",
                  header: "ค่าเช่า",
                  align: "right",
                  render: (entry) => baht(entry.row.sheet.rent),
                },
                {
                  key: "water",
                  header: "ค่าน้ำ",
                  align: "right",
                  render: (entry) => baht(entry.calc.waterAmount),
                },
                {
                  key: "electric",
                  header: "ค่าไฟ",
                  align: "right",
                  render: (entry) =>
                    entry.calc.isFlat ? (
                      baht(entry.calc.electricAmount)
                    ) : (
                      <span className="num">
                        {entry.calc.electricUnits === null
                          ? baht(entry.calc.electricAmount)
                          : `${entry.calc.electricUnits.toLocaleString("th-TH")} หน่วย · ${baht(entry.calc.electricAmount)}`}
                        {entry.calc.electricSuspect && (
                          <span className="mt-1 flex items-center justify-end gap-1 text-xs text-status-review-fg">
                            <span className="ms text-[0.875rem]" aria-hidden="true">
                              warning
                            </span>
                            สูงผิดปกติ
                          </span>
                        )}
                      </span>
                    ),
                },
                {
                  key: "charges",
                  header: "ค่าใช้จ่ายเพิ่มเติม",
                  align: "right",
                  render: (entry) =>
                    entry.calc.chargesTotal === 0 ? (
                      <span className="text-fog">—</span>
                    ) : (
                      baht(entry.calc.chargesTotal)
                    ),
                },
                {
                  key: "total",
                  header: "รวม",
                  align: "right",
                  render: (entry) => (
                    <span className="font-medium">
                      {baht(entry.calc.total)}
                    </span>
                  ),
                },
                {
                  key: "line",
                  header: "LINE",
                  render: (entry) => {
                    const connected = connectedOf(entry.row.sheet.tenantId);

                    if (connected === null) {
                      return (
                        <Badge tone="neutral" icon="schedule">
                          ยังไม่ทราบสถานะ
                        </Badge>
                      );
                    }

                    return connected ? (
                      <Badge tone="paid" icon="check_circle">
                        เชื่อมแล้ว
                      </Badge>
                    ) : (
                      <Badge tone="review" icon="error">
                        ยังไม่เชื่อม
                      </Badge>
                    );
                  },
                },
              ]}
            />
          </Card>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              icon="arrow_back"
              onClick={() => {
                setStep(1);
              }}
            >
              ย้อนกลับแก้ไข
            </Button>
            <Button
              variant="primary"
              icon="receipt_long"
              disabled={selectedReady.length === 0 || submitting}
              onClick={createBills}
            >
              {submitting
                ? "กำลังสร้างบิล"
                : `สร้างบิล ${selectedReady.length} รายการ`}
            </Button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <Card className="mb-4">
            <div className="flex items-start gap-3">
              <span
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-status-paid-bg text-status-paid-fg"
                aria-hidden="true"
              >
                <span className="ms text-[1.5rem]">check_circle</span>
              </span>
              <div className="min-w-0">
                <h2 className="text-lg text-charcoal">สร้างบิลเรียบร้อย</h2>
                <p className="mt-0.5 text-sm text-steel">
                  {`บิลเดือน ${periodLabel(period)} ถูกบันทึกแล้ว ${createdBills.length} ใบ`}
                </p>
                <p className="mt-1 text-sm text-steel">
                  ส่งบิลให้ผู้เช่าที่เชื่อม LINE แล้วได้จากปุ่มด้านล่าง
                </p>
                <div className="mt-3">
                  <HeroMoney value={baht(createdTotal)} label="ยอดรวม" />
                </div>
              </div>
            </div>
          </Card>

          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <Metric
              label="LINE เชื่อมแล้ว"
              value={
                tenants === null
                  ? "—"
                  : `${createdBills.length - createdUnconnected.length} คน`
              }
              tone="good"
            />
            <Metric
              label="LINE ยังไม่เชื่อม"
              value={tenants === null ? "—" : `${createdUnconnected.length} คน`}
              tone={createdUnconnected.length > 0 ? "warn" : undefined}
            />
          </div>

          <Card className="mt-4">
            <DataTable
              minWidth={0}
              getRowKey={(bill) => bill.id}
              rows={createdBills}
              columns={[
                {
                  key: "room",
                  header: "ห้อง",
                  render: (bill) => (
                    <span className="font-medium text-charcoal">
                      {bill.roomNumber}
                    </span>
                  ),
                },
                {
                  key: "tenant",
                  header: "ผู้เช่า",
                  render: (bill) => (
                    <span className="text-steel">{bill.tenantName}</span>
                  ),
                },
                {
                  key: "water",
                  header: "ค่าน้ำ",
                  align: "right",
                  render: (bill) => baht(bill.waterAmount),
                },
                {
                  key: "electric",
                  header: "ค่าไฟ",
                  align: "right",
                  render: (bill) => baht(bill.electricAmount),
                },
                {
                  key: "total",
                  header: "รวม",
                  align: "right",
                  render: (bill) => (
                    <span className="font-medium">{baht(bill.total)}</span>
                  ),
                },
                {
                  key: "line",
                  header: "LINE",
                  render: (bill) => (
                    <LineStateBadge
                      sentAt={bill.sentAt}
                      connected={connectedOf(bill.tenantId)}
                    />
                  ),
                },
              ]}
            />
          </Card>

          {sendAllError !== null && (
            <div
              className="mt-4 rounded-xl border border-danger bg-danger-soft px-4 py-3"
              role="alert"
            >
              <p className="text-sm font-medium text-charcoal">
                ส่งบิลทาง LINE ไม่สำเร็จ
              </p>
              <p className="mt-1 text-sm text-steel">{sendAllError}</p>
            </div>
          )}

          {sendAllResult !== null && (
            <div className="panel-muted mt-4">
              <div className="flex items-start gap-3">
                {sendAllResult.sent > 0 ? (
                  <span
                    className="ms mt-0.5 text-[1.25rem] text-status-paid-fg"
                    aria-hidden="true"
                  >
                    task_alt
                  </span>
                ) : sendAllResult.failed > 0 ? (
                  <span
                    className="ms mt-0.5 text-[1.25rem] text-danger"
                    aria-hidden="true"
                  >
                    error
                  </span>
                ) : (
                  <span
                    className="ms mt-0.5 text-[1.25rem] text-steel"
                    aria-hidden="true"
                  >
                    schedule
                  </span>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-charcoal">
                    {sendAllResultLabel(sendAllResult)}
                  </p>
                  {sendAllResult.failed > 0 && (
                    <p className="mt-1 text-sm text-steel">{`ส่งไม่สำเร็จ ${sendAllResult.failed} ใบ`}</p>
                  )}
                  {sendAllResult.skipped.length > 0 && (
                    <p className="mt-1 text-xs text-fog">
                      {`ยังไม่เชื่อม LINE ${sendAllResult.skipped.length} ห้อง: ${sendAllResult.skipped.map((item) => `${item.roomNumber} ${item.tenantName}`).join(" · ")}`}
                    </p>
                  )}
                  {sendAllResult.failedIds.length > 0 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="refresh"
                      className="mt-2"
                      disabled={sendingAll}
                      onClick={() => {
                        sendCreatedBills(sendAllResult.failedIds);
                      }}
                    >
                      ส่งซ้ำเฉพาะที่ล้มเหลว
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {createdUnconnected.length > 0 && (
            <div className="panel-muted mt-4">
              <h3 className="text-sm font-medium text-charcoal">
                ห้องที่ยังไม่เชื่อม LINE
              </h3>
              <p className="mt-1 text-xs text-fog">
                ผู้เช่าเหล่านี้จะยังไม่ได้รับบิลทาง LINE จนกว่าจะเชื่อม LINE
                กับหอ
              </p>
              <ul className="mt-3 grid gap-2">
                {createdUnconnected.map((bill) => (
                  <li
                    key={bill.id}
                    className="rounded-lg border border-ash bg-canvas-white px-3 py-2"
                  >
                    <p className="text-sm text-charcoal">
                      {bill.roomNumber} · {bill.tenantName}
                    </p>
                    <p className="mt-0.5 text-xs text-fog">
                      ยังไม่เชื่อม LINE กับหอ
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" icon="arrow_back" onClick={onFinish}>
              กลับรายการบิล
            </Button>
            <Button
              variant="primary"
              icon="send"
              disabled={sendingAll || createdBills.length === 0}
              onClick={() => {
                setSendConfirmOpen(true);
              }}
            >
              {sendingAll ? "กำลังส่งบิล" : "ส่ง LINE ทั้งหมด"}
            </Button>
          </div>

          <Dialog
            open={sendConfirmOpen}
            onClose={() => {
              setSendConfirmOpen(false);
            }}
            title={`ส่งบิลทาง LINE · ${periodLabel(period)}`}
            footer={
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSendConfirmOpen(false);
                  }}
                >
                  ยกเลิก
                </Button>
                <Button
                  variant="primary"
                  icon="send"
                  disabled={sendingAll || createdBills.length === 0}
                  onClick={() => {
                    sendCreatedBills();
                  }}
                >
                  {sendingAll
                    ? "กำลังส่งบิล"
                    : `ส่งบิล ${createdBills.length} ใบ`}
                </Button>
              </div>
            }
          >
            <div className="grid gap-2 text-sm">
              <p className="text-steel">
                ระบบจะส่งบิลของเดือนนี้ให้ผู้เช่าที่เชื่อม LINE แล้ว
                และส่งสรุปยอดให้เจ้าของทาง LINE
              </p>
              {createdUnconnected.length > 0 && (
                <p className="text-fog">
                  {`ยังไม่เชื่อม LINE ${createdUnconnected.length} ห้อง: ${createdUnconnected.map((bill) => `${bill.roomNumber} ${bill.tenantName}`).join(" · ")}`}
                </p>
              )}
            </div>
          </Dialog>
        </>
      )}

      {step === 1 && (
        <ChargesModal
          room={chargeRow?.sheet ?? null}
          period={period}
          charges={chargeRow?.charges ?? []}
          onClose={() => {
            setChargeRoomId(null);
          }}
          onDirtyChange={setChargesDraftDirty}
          onSave={(charges) => {
            if (chargeRoomId !== null) {
              setRowError(null);
              updateRow(chargeRoomId, { charges });
            }

            setChargeRoomId(null);
          }}
        />
      )}

      {step === 1 && (
        <ElectricManageModal
          open={electricOpen}
          period={period}
          sheet={rows.map((row) => row.sheet)}
          rememberedRoomIds={settings?.sharedElectricRoomIds ?? []}
          peaRooms={peaRooms}
          onClose={() => {
            setElectricOpen(false);
          }}
          onSharedApplied={(rate, roomIds) => {
            setRows((prev) =>
              prev.map((row) =>
                roomIds.includes(row.sheet.roomId)
                  ? {
                      ...row,
                      sheet: { ...row.sheet, electricRate: rate },
                      electricSource: "shared",
                    }
                  : row,
              ),
            );
          }}
          onPeaImport={(items) => {
            // เขียนยอดเหมาจ่ายกับมิเตอร์ไฟ (ถ้า PEA ส่งมาและใช้ได้) — น้ำ/ค่าใช้จ่าย/การเลือกห้องคงเดิม
            // ยอดรวมกับสถานะของแถวคำนวณจาก state นี้ใน computeRow จึงเปลี่ยนตามเอง
            const byRoom = new Map(items.map((item) => [item.roomId, item]));

            setRowError(null);
            setRows((prev) =>
              prev.map((row) => {
                const item = byRoom.get(row.sheet.roomId);

                return item === undefined
                  ? row
                  : {
                      ...row,
                      flatAmount: item.flatAmount,
                      electricCurrent: item.electricCurrent ?? row.electricCurrent,
                      electricSource: "pea",
                    };
              }),
            );
            setElectricNotice(`นำเข้าจาก PEA ${items.length} ห้องแล้ว — ตรวจยอดในตารางก่อนสร้างบิล`);
            setElectricOpen(false);
          }}
        />
      )}
    </div>
  );
}
