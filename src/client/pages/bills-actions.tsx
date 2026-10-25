import { useEffect, useState } from "react";
import { chargeFromFlatAmount, chargeFromUnits } from "../../shared/billing";
import {
  ApiError,
  announceBillsChanged,
  deleteBill,
  markBillPaid,
  updateBill,
  type Bill,
  type BillCharge,
  type BillPaidMethod,
  type BillUpdate,
} from "../api";
import { Button, Dialog, Drawer, Field, IconButton, Select } from "../ui";
import {
  baht,
  chargeDrafts,
  chargesTotal as sumCharges,
  isEmptyDraft,
  newChargeDraft,
  parseChargeAmount,
  todayIso,
  type ChargeDraft,
} from "./bills-shared";
import { periodLabel } from "../period";

type Reading =
  { ok: true; value: number } | { ok: false; reason: "empty" | "invalid" };

function parseReading(value: string): Reading {
  const trimmed = value.trim();

  if (trimmed === "") {
    return { ok: false, reason: "empty" };
  }

  const parsed = Number(trimmed);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, value: parsed };
}

function readingHint(
  reading: Reading,
  previous: number,
  label: string,
): string | null {
  if (reading.ok) {
    return reading.value < previous ? `น้อยกว่าครั้งก่อน ${previous}` : null;
  }

  return reading.reason === "empty"
    ? `กรอก${label}ครั้งนี้`
    : "กรอกตัวเลขไม่ติดลบ";
}

interface BillEditForm {
  waterCurrent: string;
  electricCurrent: string;
  flatAmount: string;
  charges: ChargeDraft[];
}

function billEditForm(bill: Bill): BillEditForm {
  return {
    waterCurrent: String(bill.waterCurrent),
    electricCurrent: String(bill.electricCurrent),
    flatAmount: bill.electricMode === "flat" ? String(bill.electricAmount) : "",
    charges: chargeDrafts(bill.charges),
  };
}

interface EditCalc {
  water: Reading;
  electric: Reading;
  flat: Reading;
  waterUnits: number | null;
  waterAmount: number;
  waterHint: string | null;
  electricUnits: number | null;
  electricRate: number | null;
  electricAmount: number;
  electricHint: string | null;
  flatHint: string | null;
  charges: BillCharge[];
  chargesTotal: number;
  chargesInvalid: boolean;
  total: number;
  canSave: boolean;
}

function computeEdit(bill: Bill, form: BillEditForm): EditCalc {
  const isFlat = bill.electricMode === "flat";
  const water = parseReading(form.waterCurrent);
  const waterHint = readingHint(water, bill.waterPrevious, "เลขมิเตอร์น้ำ");
  const waterUnits =
    water.ok && waterHint === null ? water.value - bill.waterPrevious : null;
  const waterAmount =
    waterUnits === null ? 0 : chargeFromUnits(waterUnits, bill.waterRate);

  const electric = parseReading(form.electricCurrent);
  const electricHint = readingHint(
    electric,
    bill.electricPrevious,
    "เลขมิเตอร์ไฟ",
  );
  const flat = parseReading(form.flatAmount);
  const flatHint = !isFlat
    ? null
    : flat.ok
      ? null
      : flat.reason === "empty"
        ? "กรอกยอดค่าไฟเหมาจ่าย"
        : "กรอกตัวเลขไม่ติดลบ";
  const electricUnits =
    isFlat || !electric.ok || electric.value < bill.electricPrevious
      ? null
      : electric.value - bill.electricPrevious;
  const electricRate = isFlat ? null : (bill.electricRate ?? 0);
  const electricAmount = isFlat
    ? flat.ok
      ? chargeFromFlatAmount(flat.value)
      : 0
    : electricUnits === null
      ? 0
      : chargeFromUnits(electricUnits, bill.electricRate ?? 0);

  const resolved = form.charges
    .filter(
      (charge) => !(charge.name.trim() === "" && charge.amount.trim() === ""),
    )
    .map((charge) => {
      const name = charge.name.trim();
      const amount = parseChargeAmount(charge.amount);

      return name === "" || amount === null ? null : { name, amount };
    });
  const charges = resolved.filter(
    (charge): charge is BillCharge => charge !== null,
  );
  const chargesTotal = sumCharges(charges);
  const chargesInvalid = resolved.some((charge) => charge === null);
  const total = bill.rent + waterAmount + electricAmount + chargesTotal;
  const canSave =
    waterHint === null &&
    electricHint === null &&
    flatHint === null &&
    !chargesInvalid;

  return {
    water,
    electric,
    flat,
    waterUnits,
    waterAmount,
    waterHint,
    electricUnits,
    electricRate,
    electricAmount,
    electricHint,
    flatHint,
    charges,
    chargesTotal,
    chargesInvalid,
    total,
    canSave,
  };
}

interface FieldError {
  message: string;
  field?: string;
}

export interface BillEditDrawerProps {
  open: boolean;
  bill: Bill | null;
  onClose: () => void;
  onSaved: (bill: Bill) => void;
}

export function BillEditDrawer({
  open,
  bill,
  onClose,
  onSaved,
}: BillEditDrawerProps) {
  const [form, setForm] = useState<BillEditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<FieldError | null>(null);
  const billId = bill?.id ?? null;

  useEffect(() => {
    if (open && bill !== null) {
      setForm(billEditForm(bill));
      setError(null);
      setSaving(false);
    }
  }, [open, billId, bill]);

  const isFlat = bill !== null && bill.electricMode === "flat";
  const calc = bill !== null && form !== null ? computeEdit(bill, form) : null;

  const fieldError = (name: string): string | undefined =>
    error !== null && error.field === name ? error.message : undefined;

  const update = (patch: Partial<BillEditForm>) => {
    setForm((prev) => (prev === null ? prev : { ...prev, ...patch }));
  };

  const updateCharge = (
    id: string,
    patch: Partial<Pick<ChargeDraft, "name" | "amount">>,
  ) => {
    setForm((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            charges: prev.charges.map((charge) =>
              charge.id === id ? { ...charge, ...patch } : charge,
            ),
          },
    );
  };

  const save = () => {
    if (bill === null || form === null || calc === null || !calc.canSave) {
      return;
    }

    const payload: BillUpdate = {
      waterCurrent: calc.water.ok ? calc.water.value : bill.waterCurrent,
      electricCurrent: calc.electric.ok
        ? calc.electric.value
        : bill.electricCurrent,
      charges: calc.charges,
    };

    if (isFlat && calc.flat.ok) {
      payload.flatElectricAmount = calc.flat.value;
    }

    setSaving(true);
    setError(null);

    void updateBill(bill.id, payload)
      .then((updated) => {
        onSaved(updated);
      })
      .catch((saveError: unknown) => {
        if (saveError instanceof ApiError) {
          setError(
            saveError.field === undefined
              ? { message: saveError.message }
              : { message: saveError.message, field: saveError.field },
          );
        } else {
          setError({ message: "บันทึกบิลไม่สำเร็จ" });
        }
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={bill === null ? "แก้ไขบิล" : `แก้ไขบิลห้อง ${bill.roomNumber}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button
            variant="primary"
            icon="save"
            disabled={calc === null || !calc.canSave || saving}
            onClick={save}
          >
            {saving ? "กำลังบันทึก" : "บันทึกบิล"}
          </Button>
        </>
      }
    >
      {bill !== null && form !== null && calc !== null && (
        <div className="grid gap-4">
          <div className="panel-muted">
            <p className="text-xs text-fog">ยอดรวมหลังบันทึก</p>
            <p className="num mt-1 text-lg text-charcoal">
              {baht(calc.total)} บาท
            </p>
            <p className="mt-1 text-[0.6875rem] text-fog">
              {`ค่าเช่า ${baht(bill.rent)} · ค่าน้ำ ${baht(calc.waterAmount)}${calc.waterUnits === null ? "" : ` (${calc.waterUnits} หน่วย)`} · ค่าไฟ ${baht(calc.electricAmount)}${!isFlat && calc.electricUnits !== null ? ` (${calc.electricUnits} หน่วย)` : ""} · ค่าใช้จ่ายเพิ่มเติม ${baht(calc.chargesTotal)}`}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="เลขมิเตอร์น้ำครั้งนี้"
              value={form.waterCurrent}
              inputMode="numeric"
              helper={`ครั้งก่อน ${bill.waterPrevious} · ${bill.waterRate} บาท/หน่วย${calc.waterUnits === null ? "" : ` · ใช้ ${calc.waterUnits} หน่วย`}`}
              error={calc.waterHint ?? fieldError("waterCurrent")}
              onChange={(value) => {
                update({ waterCurrent: value });
              }}
            />
            <Field
              label="เลขมิเตอร์ไฟครั้งนี้"
              value={form.electricCurrent}
              inputMode="numeric"
              helper={
                isFlat
                  ? `ครั้งก่อน ${bill.electricPrevious}`
                  : `ครั้งก่อน ${bill.electricPrevious} · ${bill.electricRate ?? 0} บาท/หน่วย${calc.electricUnits === null ? "" : ` · ใช้ ${calc.electricUnits} หน่วย`}`
              }
              error={calc.electricHint ?? fieldError("electricCurrent")}
              onChange={(value) => {
                update({ electricCurrent: value });
              }}
            />
          </div>

          {isFlat && (
            <Field
              label="ยอดค่าไฟเหมาจ่าย (บาท)"
              value={form.flatAmount}
              inputMode="numeric"
              helper="ห้องนี้คิดค่าไฟแบบเหมาจ่าย มิเตอร์ยังถูกบันทึกไว้"
              error={calc.flatHint ?? fieldError("flatElectricAmount")}
              onChange={(value) => {
                update({ flatAmount: value });
              }}
            />
          )}

          <div className="border-t border-ash pt-4">
            <h3 className="text-sm text-charcoal">ค่าใช้จ่ายเพิ่มเติม</h3>
            {form.charges.length === 0 ? (
              <p className="mt-1.5 text-xs text-fog">
                บิลนี้ยังไม่มีค่าใช้จ่ายเพิ่มเติม
              </p>
            ) : (
              <div className="mt-3 grid gap-3">
                {form.charges.map((charge) => (
                  <div key={charge.id} className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <Field
                        label="ชื่อรายการ"
                        value={charge.name}
                        error={
                          !isEmptyDraft(charge) && charge.name.trim() === ""
                            ? "กรอกชื่อรายการ"
                            : undefined
                        }
                        onChange={(value) => {
                          updateCharge(charge.id, { name: value });
                        }}
                      />
                    </div>
                    <div className="w-24 shrink-0">
                      <Field
                        label="จำนวนเงิน"
                        value={charge.amount}
                        inputMode="numeric"
                        error={
                          !isEmptyDraft(charge) &&
                          parseChargeAmount(charge.amount) === null
                            ? "กรอกจำนวนเงินเป็นจำนวนเต็ม"
                            : undefined
                        }
                        onChange={(value) => {
                          updateCharge(charge.id, { amount: value });
                        }}
                      />
                    </div>
                    <IconButton
                      icon="delete"
                      label={`ลบ ${charge.name === "" ? "รายการนี้" : charge.name}`}
                      onClick={() => {
                        setForm((prev) =>
                          prev === null
                            ? prev
                            : {
                                ...prev,
                                charges: prev.charges.filter(
                                  (item) => item.id !== charge.id,
                                ),
                              },
                        );
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
            {calc.chargesInvalid && (
              <p className="mt-2 text-xs text-danger">
                {fieldError("charges") ??
                  "ตรวจสอบค่าใช้จ่ายเพิ่มเติมให้ครบก่อนบันทึก"}
              </p>
            )}
            <Button
              variant="ghost"
              icon="add"
              className="mt-3"
              onClick={() => {
                setForm((prev) =>
                  prev === null
                    ? prev
                    : { ...prev, charges: [...prev.charges, newChargeDraft()] },
                );
              }}
            >
              เพิ่มรายการ
            </Button>
          </div>

          {error !== null && error.field === undefined && (
            <p className="text-xs text-danger">{error.message}</p>
          )}
        </div>
      )}
    </Drawer>
  );
}

export interface MarkPaidDialogProps {
  open: boolean;
  bill: Bill | null;
  onClose: () => void;
  onPaid: (bill: Bill) => void;
}

export function MarkPaidDialog({
  open,
  bill,
  onClose,
  onPaid,
}: MarkPaidDialogProps) {
  const [method, setMethod] = useState<BillPaidMethod>("transfer");
  const [paidAt, setPaidAt] = useState<string>(() => todayIso());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMethod("transfer");
      setPaidAt(todayIso());
      setError(null);
      setSaving(false);
    }
  }, [open]);

  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(paidAt);
  const canConfirm = bill !== null && dateValid && !saving;

  const confirm = () => {
    if (bill === null || !dateValid) {
      return;
    }

    setSaving(true);
    setError(null);

    void markBillPaid(bill.id, { method, paidAt })
      .then((updated) => {
        onPaid(updated);
        // เส้นทางนี้ไม่ส่ง WebSocket event กลับมาหาแท็บตัวเอง (กัน toast ซ้ำ)
        // แดชบอร์ดในแท็บนี้จึงต้องรู้จาก event ภายในแบบเดิม
        announceBillsChanged();
      })
      .catch((paidError: unknown) => {
        setError(
          paidError instanceof ApiError ? paidError.message : "ปิดบิลไม่สำเร็จ",
        );
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        bill === null
          ? "ปิดบิลด้วยมือ"
          : `ปิดบิลด้วยมือ ห้อง ${bill.roomNumber}`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button
            variant="primary"
            icon="check_circle"
            disabled={!canConfirm}
            onClick={confirm}
          >
            {saving ? "กำลังปิดบิล" : "ยืนยันปิดบิล"}
          </Button>
        </>
      }
    >
      {bill !== null && (
        <div className="grid gap-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-ash px-3 py-2">
            <span className="text-sm text-steel">ยอดที่รับชำระ</span>
            <span className="num text-base text-charcoal">
              {baht(bill.total)} บาท
            </span>
          </div>

          <Select
            label="ช่องทาง"
            value={method}
            onChange={(value) => {
              if (value === "transfer" || value === "cash") {
                setMethod(value);
              }
            }}
            options={[
              { value: "transfer", label: "โอน" },
              { value: "cash", label: "เงินสด" },
            ]}
          />

          <Field
            label="วันที่รับเงิน"
            type="date"
            value={paidAt}
            error={dateValid ? undefined : "เลือกวันที่รับเงิน"}
            onChange={setPaidAt}
          />

          <p className="text-xs text-fog">
            หลังยืนยัน บิลนี้จะปิดทันทีและแก้ไขหรือลบไม่ได้อีก
          </p>

          {error !== null && <p className="text-xs text-danger">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}

export interface DeleteBillDialogProps {
  open: boolean;
  bill: Bill | null;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteBillDialog({
  open,
  bill,
  onClose,
  onDeleted,
}: DeleteBillDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setError(null);
      setDeleting(false);
    }
  }, [open]);

  const confirm = () => {
    if (bill === null) {
      return;
    }

    setDeleting(true);
    setError(null);

    void deleteBill(bill.id)
      .then(() => {
        onDeleted();
      })
      .catch((removeError: unknown) => {
        setError(
          removeError instanceof ApiError
            ? removeError.message
            : "ลบบิลไม่สำเร็จ",
        );
      })
      .finally(() => {
        setDeleting(false);
      });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={bill === null ? "ลบบิล" : `ลบบิลห้อง ${bill.roomNumber}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button
            variant="danger-soft"
            icon="delete"
            disabled={bill === null || deleting}
            onClick={confirm}
          >
            {deleting ? "กำลังลบ" : "ลบบิล"}
          </Button>
        </>
      }
    >
      {bill !== null && (
        <div className="grid gap-3">
          <p className="text-sm text-steel">
            ลบบิลห้อง {bill.roomNumber} ของ {periodLabel(bill.period)} ยอด{" "}
            {baht(bill.total)} บาท พร้อมค่าใช้จ่ายเพิ่มเติมทั้งหมด
          </p>
          <p className="text-xs text-fog">
            ลบบิลได้เฉพาะบิลที่ยังไม่จ่าย
            หลังลบแล้วห้องนี้จะกลับไปออกบิลใหม่ในเดือนนี้ได้
          </p>
          {error !== null && <p className="text-xs text-danger">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
