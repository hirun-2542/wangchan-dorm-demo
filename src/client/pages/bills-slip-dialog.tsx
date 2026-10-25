import { useEffect, useState } from "react";
import { ApiError, fetchSlips, type Bill, type Slip } from "../api";
import { Button, Dialog, Skeleton } from "../ui";
import { baht, stampLabel } from "./bills-shared";

function transferLabel(slip: Slip): string {
  const when = slip.transferAt ?? slip.verify.date;

  return when === null ? "ไม่พบเวลาที่โอน" : `โอนเมื่อ ${stampLabel(when)}`;
}

/**
 * เนื้อหาโหลดสลิปที่ใช้ปิดบิลใบนี้ — mount ตอนเปิดเท่านั้น จึงโหลดใหม่ทุกครั้งที่เปิดและ
 * ไม่ค้างสลิปของห้องก่อนหน้า
 *
 * ดึงเฉพาะ `matched` เพราะหน้านี้ตอบคำถามเดียวว่า "ห้องนี้จ่ายด้วยสลิปใบไหน" สลิปที่ถูก
 * ปฏิเสธหรือรอตรวจดูได้ในหน้ารายละเอียดบิลและหน้ารอตรวจ
 */
function BillSlips({ bill }: { bill: Bill }) {
  const [slips, setSlips] = useState<Slip[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void fetchSlips({ billId: bill.id, status: "matched" })
      .then((list) => {
        if (active) {
          setSlips(list);
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setError(failure instanceof ApiError ? failure.message : "โหลดสลิปไม่สำเร็จ");
        }
      });

    return () => {
      active = false;
    };
  }, [bill.id]);

  if (error !== null) {
    return (
      <p className="text-sm text-danger" role="alert">
        {error}
      </p>
    );
  }

  if (slips === null) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (slips.length === 0) {
    return (
      <p className="text-sm text-steel">
        บิลนี้ปิดโดยไม่มีสลิป (เจ้าของกดปิดเอง) จึงไม่มีสลิปให้ดู
      </p>
    );
  }

  return (
    <ul className="grid gap-4">
      {slips.map((slip) => (
        <li key={slip.id}>
          <a href={slip.imageUrl} target="_blank" rel="noreferrer" className="block">
            <img
              src={slip.imageUrl}
              alt={`สลิปโอนเงินของห้อง ${bill.roomNumber}`}
              decoding="async"
              className="mx-auto max-h-[420px] w-full rounded-lg border border-ash bg-canvas-white object-contain"
            />
          </a>
          <p className="num mt-2 text-sm text-charcoal">
            {slip.slipAmount === null ? "ไม่พบยอดบนสลิป" : `สลิป ${baht(slip.slipAmount)} บาท`}
            {slip.slipAmount !== null && slip.slipAmount !== bill.total
              ? ` · ยอดบิล ${baht(bill.total)} บาท`
              : ""}
          </p>
          <p className="num mt-0.5 text-xs text-fog">{transferLabel(slip)}</p>
        </li>
      ))}
    </ul>
  );
}

export function BillSlipDialog({ bill, onClose }: { bill: Bill | null; onClose: () => void }) {
  return (
    <Dialog
      open={bill !== null}
      onClose={onClose}
      title={bill === null ? "สลิป" : `สลิปของห้อง ${bill.roomNumber}`}
      footer={
        <Button variant="ghost" onClick={onClose}>
          ปิด
        </Button>
      }
    >
      {bill !== null && <BillSlips key={bill.id} bill={bill} />}
    </Dialog>
  );
}
