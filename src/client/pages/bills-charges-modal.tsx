import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { MeterSheetRow } from "../api";
import { periodLabel } from "../period";
import { Button, Dialog, IconButton } from "../ui";
import {
  baht,
  isEmptyDraft,
  newChargeDraft,
  parseChargeAmount,
  toBillCharge,
  type ChargeDraft,
} from "./bills-shared";

export interface ChargesModalProps {
  /** null = ปิด */
  room: MeterSheetRow | null;
  period: string;
  charges: ChargeDraft[];
  onClose: () => void;
  /** ส่งเฉพาะแถวที่กรอกแล้ว (แถวว่างถูกตัดทิ้ง) และผ่านการตรวจครบทุกแถว */
  onSave: (charges: ChargeDraft[]) => void;
  /** true ตราบที่ในกล่องมีค่าที่พิมพ์ไว้แต่ยังไม่บันทึก — หน้าแม่ใช้เตือนตอนปิดแท็บ (ฟังก์ชันต้องคงที่ เช่น setState) */
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * แก้ค่าใช้จ่ายเพิ่มเติมของบิลห้องเดียวในหน้าสร้างบิล — แก้บนสำเนา (draft) แล้วค่อยบันทึกกลับ
 * ยกเลิก/Esc/คลิกพื้นหลังทิ้งการแก้ทั้งหมด `<dialog>` อยู่ตลอดเพื่อให้ `close()` คืนโฟกัสให้ปุ่มที่เปิด
 */
export function ChargesModal({ room, period, charges, onClose, onSave, onDirtyChange }: ChargesModalProps) {
  const formId = useId();

  return (
    <Dialog
      open={room !== null}
      onClose={onClose}
      title={room === null ? "ค่าใช้จ่ายเพิ่มเติม" : `ค่าใช้จ่ายเพิ่มเติม · ห้อง ${room.roomNumber}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button variant="primary" type="submit" form={formId}>
            บันทึก
          </Button>
        </>
      }
    >
      {room !== null && (
        <ChargesBody
          key={room.roomId}
          formId={formId}
          room={room}
          period={period}
          initial={charges}
          onSave={onSave}
          onDirtyChange={onDirtyChange}
        />
      )}
    </Dialog>
  );
}

type RowError = "name" | "amount" | null;

function rowError(charge: ChargeDraft): RowError {
  if (isEmptyDraft(charge)) {
    return null;
  }

  if (charge.name.trim() === "") {
    return "name";
  }

  return parseChargeAmount(charge.amount) === null ? "amount" : null;
}

/** แถวว่างไม่นับ และเทียบแบบตัดช่องว่าง — พิมพ์แล้วลบกลับจนเท่าเดิมไม่ถือว่าแก้ */
function draftsChanged(initial: ChargeDraft[], drafts: ChargeDraft[]): boolean {
  const key = (charges: ChargeDraft[]) =>
    charges
      .filter((charge) => !isEmptyDraft(charge))
      .map((charge) => `${charge.name.trim()}\u0000${charge.amount.trim()}`);
  const before = key(initial);
  const after = key(drafts);

  return before.length !== after.length || before.some((value, index) => value !== after[index]);
}

const errorText: Record<Exclude<RowError, null>, string> = {
  name: "กรอกชื่อรายการ",
  amount: "จำนวนเงินต้องเป็นจำนวนเต็มไม่ติดลบ",
};

function ChargesBody({
  formId,
  room,
  period,
  initial,
  onSave,
  onDirtyChange,
}: {
  formId: string;
  room: MeterSheetRow;
  period: string;
  initial: ChargeDraft[];
  onSave: (charges: ChargeDraft[]) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [drafts, setDrafts] = useState<ChargeDraft[]>(() =>
    initial.length === 0 ? [newChargeDraft()] : initial.map((charge) => ({ ...charge })),
  );
  // ผิดพลาดแสดงหลังกดบันทึกเท่านั้น (ไม่เตือนระหว่างที่ยังพิมพ์ชื่อและยังไม่ถึงช่องจำนวนเงิน)
  // ยกเว้นเปิดมาแล้วมีแถวที่ไม่ผ่านอยู่ก่อน เช่น จากลิงก์ "แก้ค่าใช้จ่ายเพิ่มเติมที่ยังไม่ครบ"
  const [submitted, setSubmitted] = useState(() => initial.some((charge) => rowError(charge) !== null));
  const listRef = useRef<HTMLDivElement>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  // เนื้อหา mount ก่อน <dialog> เปิด (showModal อยู่ใน effect ของ Dialog) จึงโฟกัสหลังเฟรมแรก
  // ไม่งั้นโฟกัสไปตกที่ปุ่มปิด — ไปที่ช่องที่ผิดก่อน ไม่มีก็ช่องแรก
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const list = listRef.current;

      (
        list?.querySelector<HTMLInputElement>('input[aria-invalid="true"]') ??
        list?.querySelector<HTMLInputElement>("input")
      )?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const dirty = draftsChanged(initial, drafts);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // ปิดกล่อง (บันทึก/ยกเลิก/Esc) = ไม่มีของค้างแล้ว
  useEffect(
    () => () => {
      onDirtyChange(false);
    },
    [onDirtyChange],
  );

  const total = drafts.reduce((sum, charge) => sum + (toBillCharge(charge)?.amount ?? 0), 0);

  const patch = (id: string, change: Partial<Pick<ChargeDraft, "name" | "amount">>) => {
    setDrafts((prev) => prev.map((charge) => (charge.id === id ? { ...charge, ...change } : charge)));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (drafts.some((charge) => rowError(charge) !== null)) {
      setSubmitted(true);
      window.requestAnimationFrame(() => {
        listRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus();
      });
      return;
    }

    onSave(drafts.filter((charge) => !isEmptyDraft(charge)));
  };

  return (
    <form id={formId} onSubmit={submit} noValidate>
      <p className="text-sm text-steel">
        {`${room.tenantName} · ${periodLabel(period)}`}
      </p>
      <p className="mt-1 text-xs text-fog">
        แก้เฉพาะบิลเดือนนี้ ไม่เปลี่ยนรายการประจำของห้อง
      </p>

      <div ref={listRef} className="mt-4">
        {drafts.length > 0 && (
          <div
            className="grid grid-cols-[minmax(0,1fr)_9rem_2.75rem] gap-x-2 border-b border-ash pb-2 text-xs text-fog"
            aria-hidden="true"
          >
            <span>ชื่อรายการ</span>
            <span className="text-right">จำนวนเงิน (บาท)</span>
            <span />
          </div>
        )}

        <ul className="divide-y divide-ash">
          {drafts.map((charge, index) => {
            const error = submitted ? rowError(charge) : null;
            const errorId = `${formId}-error-${charge.id}`;

            return (
              <li key={charge.id} className="py-2">
                <div className="grid grid-cols-[minmax(0,1fr)_9rem_2.75rem] items-center gap-x-2">
                  <input
                    type="text"
                    aria-label={`ชื่อรายการที่ ${index + 1}`}
                    placeholder="เช่น ค่าส่วนกลาง"
                    className="billing-input w-full text-left"
                    value={charge.name}
                    autoFocus={charge.id === focusId}
                    aria-invalid={error === "name"}
                    aria-describedby={error === "name" ? errorId : undefined}
                    onChange={(event) => {
                      patch(charge.id, { name: event.target.value });
                    }}
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label={`จำนวนเงินที่ ${index + 1}`}
                    placeholder="0"
                    className="billing-input num w-full"
                    value={charge.amount}
                    aria-invalid={error === "amount"}
                    aria-describedby={error === "amount" ? errorId : undefined}
                    onChange={(event) => {
                      patch(charge.id, { amount: event.target.value });
                    }}
                  />
                  <IconButton
                    icon="delete"
                    label={`ลบรายการที่ ${index + 1}`}
                    onClick={() => {
                      setDrafts((prev) => prev.filter((item) => item.id !== charge.id));
                    }}
                  />
                </div>
                {error !== null && (
                  <p id={errorId} className="mt-1 flex items-center gap-1 text-xs text-danger">
                    <span className="ms text-[0.875rem]" aria-hidden="true">
                      error
                    </span>
                    {errorText[error]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        {drafts.length === 0 && (
          <p className="border-b border-ash py-3 text-sm text-fog">
            ไม่มีรายการ — กดบันทึกเพื่อล้างค่าใช้จ่ายเพิ่มเติมของห้องนี้
          </p>
        )}

        <Button
          variant="ghost"
          size="sm"
          icon="add"
          className="mt-2"
          onClick={() => {
            const next = newChargeDraft();

            setFocusId(next.id);
            setDrafts((prev) => [...prev, next]);
          }}
        >
          เพิ่มรายการ
        </Button>
      </div>

      <div className="mt-4 flex items-baseline justify-between border-t border-charcoal pt-3">
        <span className="text-sm text-steel">รวมค่าใช้จ่ายเพิ่มเติม</span>
        <span className="num text-lg text-charcoal">{`${baht(total)} บาท`}</span>
      </div>
    </form>
  );
}
