import {
  type Bill,
  type BillCharge,
  type ElectricMode,
  type PromptpayType,
} from "../api";
import { buddhistYearOffset, periodLabel } from "../period";
import { Badge } from "../ui";

const thaiMonthsShort = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
];

export function baht(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function chargesTotal(charges: BillCharge[]): number {
  return charges.reduce((sum, charge) => sum + charge.amount, 0);
}

export interface ChargeDraft {
  id: string;
  name: string;
  amount: string;
}

let chargeSequence = 0;

function nextChargeId(): string {
  chargeSequence += 1;
  return `charge-${chargeSequence}`;
}

export function newChargeDraft(): ChargeDraft {
  return { id: nextChargeId(), name: "", amount: "" };
}

export function chargeDrafts(charges: BillCharge[]): ChargeDraft[] {
  return charges.map((charge) => ({
    id: nextChargeId(),
    name: charge.name,
    amount: String(charge.amount),
  }));
}

export function parseChargeAmount(value: string): number | null {
  const trimmed = value.trim();

  if (trimmed === "") {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** แถวที่เพิ่งกดเพิ่มแล้วยังไม่ได้กรอกอะไร ถือว่าไม่มีรายการนี้ */
export function isEmptyDraft(charge: ChargeDraft): boolean {
  return charge.name.trim() === "" && charge.amount.trim() === "";
}

export function toBillCharge(charge: ChargeDraft): BillCharge | null {
  const name = charge.name.trim();
  const amount = parseChargeAmount(charge.amount);

  return name === "" || amount === null ? null : { name, amount };
}

interface ThaiDate {
  day: number;
  monthName: string;
  buddhistYear: number;
  time: string;
}

function thaiDate(value: string): ThaiDate | null {
  const [datePart = "", timePart = ""] = value.split(/[T ]/);
  const [yearPart, monthPart, dayPart] = datePart.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const monthName = thaiMonthsShort[month - 1];

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(day) ||
    monthName === undefined
  ) {
    return null;
  }

  return {
    day,
    monthName,
    buddhistYear: year + buddhistYearOffset,
    time: timePart.slice(0, 5),
  };
}

/** ประทับเวลาแบบสั้น — ใช้ในบริบทที่พื้นที่จำกัด เช่น เวลาส่งหรือเวลาปิดบิล */
export function stampLabel(value: string): string {
  const parsed = thaiDate(value);

  if (parsed === null) {
    return value;
  }

  const stamp = `${parsed.day} ${parsed.monthName} ${String(parsed.buddhistYear % 100).padStart(2, "0")}`;

  return parsed.time === "" ? stamp : `${stamp} · ${parsed.time}`;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** วันที่เต็มปี พ.ศ. — ใช้บนเอกสารที่ต้องตรงกับใบแจ้งหนี้ PDF */
export function dateLabel(value: string): string {
  const parsed = thaiDate(value);

  return parsed === null
    ? value
    : `${parsed.day} ${parsed.monthName} ${parsed.buddhistYear}`;
}

export function billNumber(bill: {
  period: string;
  roomNumber: string;
}): string {
  const [yearPart, monthPart] = bill.period.split("-");
  const year = Number(yearPart);

  if (!Number.isInteger(year) || monthPart === undefined) {
    return `${bill.period}-${bill.roomNumber}`;
  }

  return `B${year + buddhistYearOffset}-${monthPart}-${bill.roomNumber}`;
}

export function paidMethodLabel(method: string | null): string {
  if (method === "transfer") {
    return "โอน";
  }

  if (method === "cash") {
    return "เงินสด";
  }

  return "ไม่ระบุ";
}

export type LineState = "sent" | "unsent" | "blocked";

export function lineStateOf(
  sentAt: string | null,
  connected: boolean | null,
): LineState {
  if (sentAt !== null) {
    return "sent";
  }

  return connected === false ? "blocked" : "unsent";
}

export function LineStateBadge({
  sentAt,
  connected,
}: {
  sentAt: string | null;
  connected: boolean | null;
}) {
  const state = lineStateOf(sentAt, connected);

  return (
    <span className="flex flex-wrap items-center gap-1">
      {state === "sent" ? (
        <Badge tone="paid" icon="check_circle">
          ส่งแล้ว
        </Badge>
      ) : (
        <Badge tone="neutral" icon="schedule">
          ยังไม่ส่ง
        </Badge>
      )}
      {state === "blocked" && (
        <Badge tone="review" icon="error">
          ยังไม่เชื่อม LINE
        </Badge>
      )}
    </span>
  );
}

export interface PaymentRecord {
  method: string;
  when: string;
  note: string;
}

export interface InvoiceData {
  roomNumber: string;
  tenantName: string;
  period: string;
  rent: number;
  waterPrevious: number;
  waterCurrent: number | null;
  waterUnits: number | null;
  waterRate: number;
  waterAmount: number;
  electricMode: ElectricMode;
  electricPrevious: number | null;
  electricCurrent: number | null;
  electricUnits: number | null;
  electricRate: number | null;
  electricAmount: number;
  charges: BillCharge[];
  total: number;
}

export function toInvoice(bill: Bill): InvoiceData {
  return {
    roomNumber: bill.roomNumber,
    tenantName: bill.tenantName,
    period: bill.period,
    rent: bill.rent,
    waterPrevious: bill.waterPrevious,
    waterCurrent: bill.waterCurrent,
    waterUnits: bill.waterUnits,
    waterRate: bill.waterRate,
    waterAmount: bill.waterAmount,
    electricMode: bill.electricMode,
    electricPrevious: bill.electricPrevious,
    electricCurrent: bill.electricCurrent,
    electricUnits: bill.electricUnits,
    electricRate: bill.electricRate,
    electricAmount: bill.electricAmount,
    charges: bill.charges,
    total: bill.total,
  };
}

function waterLine(data: InvoiceData): string {
  if (data.waterCurrent === null || data.waterUnits === null) {
    return "ยังไม่กรอกมิเตอร์";
  }

  return `${data.waterUnits} หน่วย × ${data.waterRate} บาท/หน่วย`;
}

function electricLine(data: InvoiceData): string {
  if (data.electricMode === "flat") {
    return "คิดแบบเหมาจ่าย";
  }

  if (
    data.electricCurrent === null ||
    data.electricUnits === null ||
    data.electricPrevious === null
  ) {
    return "ยังไม่กรอกมิเตอร์";
  }

  return `${data.electricUnits} หน่วย × ${data.electricRate ?? 0} บาท/หน่วย`;
}

export interface InvoiceQr {
  billId?: string | null;
  promptpayId?: string | null;
  promptpayType?: PromptpayType | null;
}

function promptpayTypeOf(promptpayId: string): PromptpayType {
  return promptpayId.replace(/\D/g, "").length === 13 ? "citizen-id" : "phone";
}

function qrImageUrl(qr: InvoiceQr | undefined, amount: number): string | null {
  const total = Math.round(amount);

  if (qr === undefined || total <= 0) {
    return null;
  }

  const billId = qr.billId ?? "";

  if (billId !== "") {
    return `/qr/${encodeURIComponent(billId)}.png`;
  }

  const promptpayId = qr.promptpayId ?? "";

  if (promptpayId === "") {
    return null;
  }

  const params = new URLSearchParams({
    id: promptpayId,
    type: qr.promptpayType ?? promptpayTypeOf(promptpayId),
    amount: String(total),
  });

  return `/qr/preview.png?${params.toString()}`;
}

export function QrBlock({ amount, qr }: { amount: number; qr?: InvoiceQr }) {
  const url = qrImageUrl(qr, amount);

  return (
    <div className="rounded-xl border border-ash p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-fog">พร้อมเพย์ · PromptPay</span>
        {url === null ? (
          <Badge tone="neutral" icon="link_off">
            ยังไม่มีรหัส
          </Badge>
        ) : (
          <Badge tone="paid" icon="qr_code_2">
            สแกนจ่ายได้
          </Badge>
        )}
      </div>
      {url === null ? (
        <>
          <div className="mx-auto mt-2 grid h-36 w-36 place-items-center rounded-lg border border-dashed border-ash px-3 text-center">
            <span className="text-[0.6875rem] text-fog">ยังสร้าง QR ไม่ได้</span>
          </div>
          <p className="mt-2 text-center text-[0.6875rem] text-fog">
            ต้องมีพร้อมเพย์และยอดบิลของบิลนี้ก่อน ระบบจึงจะสร้าง QR ให้ได้
          </p>
        </>
      ) : (
        <>
          <img
            src={url}
            alt={`QR พร้อมเพย์สำหรับสแกนจ่าย ${baht(amount)} บาท`}
            className="mx-auto mt-2 h-36 w-36"
          />
          <p className="num mt-2 text-center text-sm text-charcoal">
            {baht(amount)} บาท
          </p>
        </>
      )}
    </div>
  );
}

function Line({
  label,
  detail,
  value,
}: {
  label: string;
  detail?: string;
  value: number;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-steel">
        {label}
        {detail !== undefined && (
          <span className="mt-0.5 block text-[0.6875rem] text-fog">{detail}</span>
        )}
      </dt>
      <dd className="num whitespace-nowrap text-charcoal">{`${baht(value)} บาท`}</dd>
    </div>
  );
}

export interface InvoiceMeta {
  ownerName: string | null;
  promptpayId: string | null;
  number: string;
  issueDate: string;
}

/** เลขมิเตอร์รอบนี้ — ที่เดียวในใบที่แสดง readings ไม่ซ้ำกับรายละเอียดในตาราง */
function meterSummary(data: InvoiceData): string {
  const water = `${data.waterPrevious} → ${data.waterCurrent ?? "—"}`;
  const electric = `${data.electricPrevious ?? "—"} → ${data.electricCurrent ?? "—"}`;

  return `มิเตอร์น้ำ ${water} · มิเตอร์ไฟ ${electric}`;
}

function chargeDetails(charges: readonly BillCharge[]): (string | undefined)[] {
  return charges.map((_, index) =>
    index === 0 ? "ค่าใช้จ่ายเพิ่มเติม" : undefined,
  );
}

function ItemRow({
  label,
  detail,
  value,
}: {
  label: string;
  detail?: string;
  value: number;
}) {
  return (
    <tr className="border-t border-ash">
      <td className="px-3 py-2 align-top">
        <span className="block text-charcoal">{label}</span>
        {detail !== undefined && (
          <span className="mt-0.5 block text-[0.6875rem] text-fog">{detail}</span>
        )}
      </td>
      <td className="num px-3 py-2 text-right align-top text-charcoal">
        {baht(value)}
      </td>
    </tr>
  );
}

function FullInvoice({
  data,
  dormName,
  meta,
  qr,
}: {
  data: InvoiceData;
  dormName: string | null;
  meta: InvoiceMeta;
  qr?: InvoiceQr;
}) {
  const hasOwner = meta.ownerName !== null && meta.ownerName !== "";
  const hasPromptpay = meta.promptpayId !== null && meta.promptpayId !== "";

  return (
    <article className="card">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-charcoal">
            ใบแจ้งหนี้ค่าที่พัก
          </h2>
          {dormName !== null && dormName !== "" && (
            <p className="mt-0.5 truncate text-sm text-steel">{dormName}</p>
          )}
          {hasOwner && (
            <p className="mt-0.5 text-sm text-steel">
              เจ้าของหอ: {meta.ownerName}
            </p>
          )}
          {hasPromptpay && (
            <p className="num mt-0.5 text-sm text-steel">
              พร้อมเพย์: {meta.promptpayId}
            </p>
          )}
        </div>
        <dl className="shrink-0 text-right">
          <dt className="text-xs text-fog">เลขที่ใบแจ้งหนี้</dt>
          <dd className="num text-sm text-charcoal">{meta.number}</dd>
          <dt className="mt-2 text-xs text-fog">วันที่ออก</dt>
          <dd className="num text-sm text-charcoal">{meta.issueDate}</dd>
        </dl>
      </header>

      <div className="mt-4 rounded-xl border border-ash px-3 py-2.5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <p className="min-w-0 text-sm text-charcoal">
            {`ห้อง ${data.roomNumber} · ผู้เช่า ${data.tenantName}`}
          </p>
          <p className="shrink-0 text-sm text-charcoal">
            ประจำเดือน {periodLabel(data.period)}
          </p>
        </div>
        <p className="num mt-1.5 text-xs text-fog">{meterSummary(data)}</p>
      </div>

      <div className="mt-3 overflow-hidden rounded-xl border border-ash">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-fog">
              <th scope="col" className="px-3 py-2 font-normal">
                รายการ
              </th>
              <th scope="col" className="px-3 py-2 text-right font-normal">
                จำนวนเงิน (บาท)
              </th>
            </tr>
          </thead>
          <tbody>
            <ItemRow label="ค่าเช่าห้อง" detail="รายเดือน" value={data.rent} />
            <ItemRow
              label="ค่าน้ำ"
              detail={waterLine(data)}
              value={data.waterAmount}
            />
            <ItemRow
              label="ค่าไฟ"
              detail={electricLine(data)}
              value={data.electricAmount}
            />
            {data.charges.map((charge, index) => (
              <ItemRow
                key={`${charge.name}-${index}`}
                label={charge.name}
                detail={chargeDetails(data.charges)[index]}
                value={charge.amount}
              />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-[3px] border-double border-charcoal">
              <td className="px-3 py-2 font-medium text-charcoal">
                ยอดรวมทั้งสิ้น
              </td>
              <td className="num px-3 py-2 text-right text-base text-charcoal">
                {baht(data.total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-3">
        <QrBlock amount={data.total} qr={qr} />
      </div>

      <p className="mt-3 text-center text-[0.6875rem] text-fog">
        ขอบคุณที่ใช้บริการ · ส่งสลิปกลับในแชท LINE ของหอได้เลย
      </p>
    </article>
  );
}

function CompactInvoice({
  data,
  dormName,
  qr,
}: {
  data: InvoiceData;
  dormName: string | null;
  qr?: InvoiceQr;
}) {
  return (
    <article className="card">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-charcoal">
            ใบแจ้งหนี้ค่าที่พัก
          </h2>
          {dormName !== null && dormName !== "" && (
            <p className="mt-0.5 truncate text-xs text-fog">{dormName}</p>
          )}
        </div>
        <span className="chip">{`ห้อง ${data.roomNumber}`}</span>
      </header>

      <dl className="mt-3 grid gap-2.5 border-t border-ash pt-3 text-sm">
        <div className="flex items-start justify-between gap-3">
          <dt className="text-steel">ผู้เช่า</dt>
          <dd className="text-charcoal">{data.tenantName}</dd>
        </div>
        <div className="flex items-start justify-between gap-3">
          <dt className="text-steel">ประจำเดือน</dt>
          <dd className="text-charcoal">{periodLabel(data.period)}</dd>
        </div>
        <Line label="ค่าเช่าห้อง" detail="รายเดือน" value={data.rent} />
        <Line
          label="ค่าน้ำ"
          detail={waterLine(data)}
          value={data.waterAmount}
        />
        <Line
          label="ค่าไฟ"
          detail={electricLine(data)}
          value={data.electricAmount}
        />
        {data.charges.map((charge, index) => (
          <Line
            key={`${charge.name}-${index}`}
            label={charge.name}
            detail={chargeDetails(data.charges)[index]}
            value={charge.amount}
          />
        ))}
      </dl>

      <p className="num mt-3 border-t border-ash pt-3 text-xs text-fog">
        {meterSummary(data)}
      </p>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-ash pt-3">
        <span className="text-sm font-medium text-charcoal">
          ยอดรวมทั้งสิ้น
        </span>
        <span className="num text-lg text-charcoal">
          {baht(data.total)} บาท
        </span>
      </div>

      <div className="mt-3">
        <QrBlock amount={data.total} qr={qr} />
      </div>
    </article>
  );
}

export function InvoicePreview({
  data,
  dormName,
  meta,
  qr,
}: {
  data: InvoiceData;
  dormName: string | null;
  meta?: InvoiceMeta;
  qr?: InvoiceQr;
}) {
  if (meta === undefined) {
    return <CompactInvoice data={data} dormName={dormName} qr={qr} />;
  }

  return (
    <FullInvoice
      data={data}
      dormName={dormName}
      meta={meta}
      qr={qr ?? { promptpayId: meta.promptpayId, promptpayType: null }}
    />
  );
}

