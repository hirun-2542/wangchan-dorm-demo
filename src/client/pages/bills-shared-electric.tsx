import { useRef, useState } from "react";
import { rateFromBill } from "../../shared/billing";
import { ApiError, applySharedElectricBill, type MeterSheetRow } from "../api";
import { Button, Field } from "../ui";
import { PeaBillPanel, PeaImportButton } from "./bills-pea-import";

interface SharedElectricPanelProps {
  /** แถวของเดือนนี้ — เลือกได้เฉพาะห้องที่คิดค่าไฟตามมิเตอร์ */
  sheet: MeterSheetRow[];
  /** ห้องที่ใช้บิลรวมครั้งล่าสุด (จากหน้าตั้งค่า) */
  rememberedRoomIds: string[];
  /** งวดบิลที่กำลังออก — ให้กล่องดึงยอดเทียบงวดจากการไฟฟ้าได้ */
  period: string;
  onApplied: (rate: number, roomIds: string[]) => void;
}

function positiveNumber(value: string): number | null {
  const parsed = Number(value.replace(/,/g, ""));
  return value.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * แท็บ "คำนวณจากบิลรวม" ในกล่องจัดการค่าไฟ — คิดค่าไฟต่อหน่วยจากบิลการไฟฟ้ารวมแล้วตั้งให้ห้องที่เลือก
 * ไม่มีกรอบการ์ดของตัวเอง เพราะอยู่ในกล่องโต้ตอบอยู่แล้ว
 */
export function SharedElectricPanel({ sheet, rememberedRoomIds, period, onApplied }: SharedElectricPanelProps) {
  const meterRows = sheet.filter((row) => row.electricMode === "meter");
  const meterIds = new Set(meterRows.map((row) => row.roomId));
  const remembered = rememberedRoomIds.filter((id) => meterIds.has(id));
  const [picked, setPicked] = useState<string[] | null>(null);
  const [amount, setAmount] = useState("");
  const [units, setUnits] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [peaOpen, setPeaOpen] = useState(false);
  const [peaFilled, setPeaFilled] = useState<string | null>(null);
  const peaTriggerRef = useRef<HTMLDivElement>(null);

  if (meterRows.length === 0) {
    return (
      <p className="text-sm text-steel">
        ไม่มีห้องที่คิดค่าไฟตามมิเตอร์ในเดือนนี้ — ห้องค่าไฟเหมาจ่ายใช้แท็บ “ดึงข้อมูลจาก PEA”
      </p>
    );
  }

  const roomIds = (picked ?? remembered).filter((id) => meterIds.has(id));
  const amountValue = positiveNumber(amount);
  const unitsValue = positiveNumber(units);
  const unitsInvalid = units.trim() !== "" && (unitsValue === null || !Number.isInteger(unitsValue));
  const amountInvalid = amount.trim() !== "" && amountValue === null;
  const rate =
    amountValue !== null && unitsValue !== null && !unitsInvalid ? rateFromBill(amountValue, unitsValue) : null;

  const toggle = (id: string) => {
    setApplied(null);
    setPicked(roomIds.includes(id) ? roomIds.filter((value) => value !== id) : [...roomIds, id]);
  };

  const apply = () => {
    if (amountValue === null || unitsValue === null || roomIds.length === 0) {
      return;
    }

    setSaving(true);
    setError(null);
    void applySharedElectricBill({ roomIds, billAmount: amountValue, billUnits: unitsValue })
      .then((result) => {
        setPicked(result.roomIds);
        setPeaFilled(null);
        setApplied(`ตั้งค่าไฟ ${result.rate.toFixed(2)} บาท/หน่วย ให้ ${result.roomIds.length} ห้องแล้ว`);
        onApplied(result.rate, result.roomIds);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "ตั้งค่าไฟจากบิลรวมไม่สำเร็จ");
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <div>
      <p className="text-xs text-fog">
        ใส่ยอดเงินกับจำนวนหน่วยจากบิลการไฟฟ้า ระบบหารให้แล้วปัดขึ้นทศนิยม 2 ตำแหน่ง
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field
          label="ยอดเงินในบิล (บาท)"
          value={amount}
          onChange={(value) => {
            setApplied(null);
            setPeaFilled(null);
            setAmount(value);
          }}
          inputMode="numeric"
          error={amountInvalid ? "กรอกยอดเงินที่มากกว่า 0" : undefined}
        />
        <Field
          label="จำนวนหน่วยในบิล"
          value={units}
          onChange={(value) => {
            setApplied(null);
            setPeaFilled(null);
            setUnits(value);
          }}
          inputMode="numeric"
          error={unitsInvalid ? "กรอกจำนวนหน่วยเป็นจำนวนเต็มที่มากกว่า 0" : undefined}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div ref={peaTriggerRef} className="contents">
          <PeaImportButton
            disabled={saving || peaOpen}
            onClick={() => {
              setPeaOpen(true);
            }}
          >
            ดึงบิลล่าสุดจาก PEA
          </PeaImportButton>
        </div>
        <p className="text-xs text-fog">
          ดึงบิลล่าสุดแล้วตรวจงวดบิลก่อนนำยอดมาเติม
        </p>
      </div>

      {peaOpen && (
        <PeaBillPanel
          title="ดึงยอดจากบิลการไฟฟ้า"
          period={period}
          onClose={() => {
            setPeaOpen(false);
            // แผงถูกถอดออกจาก DOM ที่โฟกัสอยู่ข้างใน — คืนโฟกัสให้ปุ่มที่เปิดเอง
            window.requestAnimationFrame(() => {
              peaTriggerRef.current?.querySelector("button")?.focus();
            });
          }}
          onImport={(bill) => {
            // เติมเฉพาะช่องในเครื่องคิด — อัตราไฟยังต้องกดปุ่มเดิมเพื่อยืนยัน
            setApplied(null);
            setAmount(String(bill.amount));
            setUnits(String(bill.units));
            setPeaFilled(
              `เติมยอดจากงวด ${bill.billPeriod} แล้ว — ตรวจงวดบิลก่อนกดใช้กับห้อง`,
            );
          }}
        />
      )}

      <p role="status" className="mt-1 text-xs text-status-paid-fg empty:hidden">
        {peaFilled}
      </p>

      <fieldset className="mt-3">
        <legend className="field-label">ใช้กับห้อง</legend>
        <div className="mt-1 flex flex-wrap gap-2" role="group">
          {meterRows.map((row) => {
            const selected = roomIds.includes(row.roomId);

            return (
              <button
                key={row.roomId}
                type="button"
                aria-pressed={selected}
                className={`btn btn-sm ${selected ? "border-electric-blue bg-status-unpaid-bg font-medium text-deep-sapphire" : "btn-secondary text-steel"}`}
                onClick={() => {
                  toggle(row.roomId);
                }}
              >
                {row.roomNumber}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-ash pt-3">
        <p className="num text-sm text-charcoal">
          {rate === null || amountValue === null || unitsValue === null ? (
            <span className="text-fog">ค่าไฟต่อหน่วยจะแสดงเมื่อกรอกครบ</span>
          ) : (
            <>
              {`${amountValue.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ÷ ${unitsValue.toLocaleString("th-TH")} → `}
              <strong>{`${rate.toFixed(2)} บาท/หน่วย`}</strong>
            </>
          )}
        </p>
        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          disabled={rate === null || roomIds.length === 0 || saving}
          onClick={apply}
        >
          {saving
            ? "กำลังบันทึก…"
            : rate === null
              ? `ใช้กับ ${roomIds.length} ห้อง`
              : `ใช้ ${rate.toFixed(2)} บาท/หน่วย กับ ${roomIds.length} ห้อง`}
        </Button>
      </div>
      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
      <p role="status" className="mt-2 text-xs text-status-paid-fg empty:hidden">
        {applied}
      </p>
    </div>
  );
}
