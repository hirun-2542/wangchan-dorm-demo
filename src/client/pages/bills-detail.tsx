import { useEffect, useState } from "react";
import { ApiError, fetchSlips, sendBill, type Bill, type Slip } from "../api";
import { Badge, Button, Card, HeroMoney, PageHeader, StatusBadge } from "../ui";
import {
  InvoicePreview,
  LineStateBadge,
  baht,
  billNumber,
  dateLabel,
  paidMethodLabel,
  stampLabel,
  toInvoice,
  type PaymentRecord,
} from "./bills-shared";
import { periodLabel } from "../period";
import {
  BillEditDrawer,
  DeleteBillDialog,
  MarkPaidDialog,
} from "./bills-actions";

export interface BillDetailProps {
  bill: Bill;
  dormName: string | null;
  ownerName: string | null;
  promptpayId: string | null;
  connected: boolean | null;
  onBack: () => void;
  onSaved: (bill: Bill) => void;
  onSent: (bill: Bill) => void;
  onSendError: (message: string) => void;
  onDeleted: () => void;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-steel">{label}</span>
      <span className="num text-charcoal">{value}</span>
    </div>
  );
}

function paymentHistory(
  bill: Bill,
  includeManualClose: boolean,
): PaymentRecord[] {
  if (
    includeManualClose === false ||
    bill.status !== "paid" ||
    bill.paidAt === null
  ) {
    return [];
  }

  return [
    {
      method: paidMethodLabel(bill.paidMethod),
      when: stampLabel(bill.paidAt),
      note: "ปิดบิลด้วยมือ",
    },
  ];
}

function slipTransferLabel(slip: Slip): string {
  const when = slip.transferAt ?? slip.verify.date;

  return when === null ? "ไม่พบเวลาที่โอน" : `โอนเมื่อ ${stampLabel(when)}`;
}

function SlipImage({ slip, alt }: { slip: Slip; alt: string }) {
  return (
    <a
      href={slip.imageUrl}
      target="_blank"
      rel="noreferrer"
      className="mt-2 block"
    >
      <img
        src={slip.imageUrl}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="h-28 w-full rounded-lg border border-ash bg-paper-mist object-contain"
      />
    </a>
  );
}

function SlipHistoryEntry({
  slip,
  billTotal,
}: {
  slip: Slip;
  billTotal: number;
}) {
  const delta = slip.slipAmount === null ? null : slip.slipAmount - billTotal;
  const note =
    delta === null
      ? "ปิดบิลด้วยสลิปนี้แล้ว"
      : delta === 0
        ? "สลิปยอดตรง ปิดบิลด้วยสลิปนี้แล้ว"
        : `ปิดบิลด้วยสลิปนี้แล้ว · ยอดสลิปต่างจากยอดบิล ${baht(Math.abs(delta))} บาท`;

  return (
    <li className="rounded-lg border border-ash px-3 py-2">
      <div className="flex items-start justify-between gap-3 text-sm">
        <Badge tone={delta === 0 ? "paid" : "review"} icon="check_circle">
          ปิดบิลด้วยสลิป
        </Badge>
        <span className="num text-charcoal">{`สลิป ${baht(slip.slipAmount ?? billTotal)} บาท`}</span>
      </div>
      <SlipImage slip={slip} alt="สลิปที่ผู้เช่าส่งมา" />
      <p className="num mt-1.5 text-[0.6875rem] text-fog">
        {slipTransferLabel(slip)}
      </p>
      <p className="mt-0.5 text-[0.6875rem] text-fog">{note}</p>
    </li>
  );
}

function RejectedSlipEntry({ slip }: { slip: Slip }) {
  return (
    <li className="rounded-lg border border-ash px-3 py-2">
      <div className="flex items-start justify-between gap-3 text-sm">
        <Badge tone="danger" icon="block">
          ปฏิเสธสลิป
        </Badge>
        <span className="num text-charcoal">
          {slip.slipAmount === null
            ? "ไม่มียอด"
            : `สลิป ${baht(slip.slipAmount)} บาท`}
        </span>
      </div>
      <SlipImage slip={slip} alt="สลิปที่ถูกปฏิเสธ" />
      <p className="num mt-1.5 text-[0.6875rem] text-fog">
        {slipTransferLabel(slip)}
      </p>
      <p className="mt-0.5 text-[0.6875rem] text-fog">
        เจ้าของปฏิเสธสลิปนี้ ไม่นำมาปิดบิล บิลไม่เปลี่ยนแปลง
      </p>
    </li>
  );
}

export function BillDetail({
  bill,
  dormName,
  ownerName,
  promptpayId,
  connected,
  onBack,
  onSaved,
  onSent,
  onSendError,
  onDeleted,
}: BillDetailProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [slips, setSlips] = useState<Slip[]>([]);
  const [slipHistoryError, setSlipHistoryError] = useState<string | null>(null);

  const billId = bill.id;

  useEffect(() => {
    let active = true;

    void fetchSlips({ billId })
      .then((list) => {
        if (active) {
          setSlips(list);
          setSlipHistoryError(null);
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        setSlips([]);
        setSlipHistoryError(
          error instanceof ApiError
            ? error.message
            : "โหลดสลิปของบิลนี้ไม่สำเร็จ",
        );
      });

    return () => {
      active = false;
    };
  }, [billId]);

  const acceptedSlips = slips.filter((slip) => slip.status === "matched");
  const declinedSlips = slips.filter((slip) => slip.status === "rejected");
  const history = paymentHistory(bill, acceptedSlips.length === 0);
  const hasHistory =
    history.length > 0 || acceptedSlips.length > 0 || declinedSlips.length > 0;
  const isPaid = bill.status === "paid";
  const number = billNumber(bill);
  const sendBlockedReason =
    connected === null
      ? "ยังไม่ทราบสถานะ LINE ของผู้เช่า"
      : "ผู้เช่ายังไม่เชื่อม LINE";

  const handleSend = () => {
    if (connected === false || sending) {
      return;
    }

    setSending(true);

    void sendBill(bill.id)
      .then((updated) => {
        onSent(updated);
      })
      .catch((error: unknown) => {
        onSendError(
          error instanceof ApiError
            ? error.message
            : "ส่งบิลทาง LINE ไม่สำเร็จ",
        );
      })
      .finally(() => {
        setSending(false);
      });
  };

  const handleSaved = (updated: Bill) => {
    setEditOpen(false);
    setPayOpen(false);
    onSaved(updated);
  };

  const handleDeleted = () => {
    setDeleteOpen(false);
    onDeleted();
  };

  return (
    <div>
      <button
        type="button"
        className="btn btn-ghost btn-sm mb-3"
        onClick={onBack}
      >
        <span className="ms text-[1.125rem]" aria-hidden="true">
          arrow_back
        </span>
        กลับรายการบิล
      </button>

      <PageHeader
        title={`บิลห้อง ${bill.roomNumber}`}
        supporting={`${bill.tenantName} · ${periodLabel(bill.period)} · เลขที่ใบแจ้งหนี้ ${number}`}
        actions={<StatusBadge status={bill.status} />}
      />

      <Card className="mb-5">
        <HeroMoney value={baht(bill.total)} label="ยอดรวมทั้งสิ้น" />
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
        <InvoicePreview
          data={toInvoice(bill)}
          dormName={dormName}
          qr={{ billId: bill.id }}
          meta={{
            ownerName,
            promptpayId,
            number,
            issueDate: dateLabel(bill.createdAt),
          }}
        />

        <aside className="card lg:sticky lg:top-20">
          {isPaid ? (
            <div>
              <h2 className="text-[0.9375rem] text-charcoal">ข้อมูลการชำระเงิน</h2>
              <div className="mt-3 grid gap-2">
                <InfoRow
                  label="ช่องทาง"
                  value={paidMethodLabel(bill.paidMethod)}
                />
                <InfoRow
                  label="เวลาที่ปิดบิล"
                  value={
                    bill.paidAt === null ? "ไม่ระบุ" : stampLabel(bill.paidAt)
                  }
                />
                <InfoRow label="ยอดที่ชำระ" value={`${baht(bill.total)} บาท`} />
              </div>
              <p className="mt-3 text-xs text-fog">
                บิลที่จ่ายแล้วแก้ไขหรือลบไม่ได้
              </p>
            </div>
          ) : (
            <div>
              <h2 className="text-[0.9375rem] text-charcoal">การจัดการบิล</h2>
              <p className="mt-1.5 text-sm text-steel">
                แก้ไขมิเตอร์และค่าใช้จ่าย ปิดบิลด้วยมือ หรือลบบิลที่ยังไม่จ่าย
              </p>

              <div className="mt-4 grid gap-2">
                <Button
                  variant="secondary"
                  icon="send"
                  className="w-full justify-start"
                  disabled={connected === false || sending}
                  title={
                    connected === false || connected === null
                      ? sendBlockedReason
                      : undefined
                  }
                  onClick={handleSend}
                >
                  {sending ? "กำลังส่งบิล" : "ส่ง LINE อีกครั้ง"}
                </Button>
                {connected === false ? (
                  <p className="text-[0.6875rem] text-fog">{sendBlockedReason}</p>
                ) : (
                  <p className="text-[0.6875rem] text-fog">
                    {bill.sentAt === null
                      ? "ยังไม่ได้ส่งบิลนี้ทาง LINE"
                      : `ส่งล่าสุด ${stampLabel(bill.sentAt)}`}
                  </p>
                )}

                <Button
                  variant="secondary"
                  icon="edit"
                  className="mt-2 w-full justify-start"
                  onClick={() => {
                    setEditOpen(true);
                  }}
                >
                  แก้ไขบิล
                </Button>
                <Button
                  variant="secondary"
                  icon="check_circle"
                  className="w-full justify-start"
                  onClick={() => {
                    setPayOpen(true);
                  }}
                >
                  ปิดบิลด้วยมือ
                </Button>
                <Button
                  variant="danger-soft"
                  icon="delete"
                  className="mt-2 w-full justify-start"
                  onClick={() => {
                    setDeleteOpen(true);
                  }}
                >
                  ลบบิล
                </Button>
              </div>
            </div>
          )}

          <div className="mt-4 border-t border-ash pt-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm text-charcoal">สถานะ LINE</h3>
              <LineStateBadge sentAt={bill.sentAt} connected={connected} />
            </div>
            <p className="mt-1.5 text-xs text-fog">
              {bill.sentAt === null
                ? "ยังไม่ได้ส่งบิลทาง LINE"
                : `ส่งล่าสุด ${stampLabel(bill.sentAt)}`}
            </p>
          </div>

          <div className="mt-4 border-t border-ash pt-4">
            <h3 className="text-sm text-charcoal">ประวัติการชำระ</h3>
            {hasHistory ? (
              <ul className="mt-2 grid gap-2">
                {acceptedSlips.map((slip) => (
                  <SlipHistoryEntry
                    key={slip.id}
                    slip={slip}
                    billTotal={bill.total}
                  />
                ))}
                {history.map((entry) => (
                  <li
                    key={entry.when}
                    className="rounded-lg border border-ash px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-charcoal">{entry.method}</span>
                      <span className="num text-charcoal">
                        {baht(bill.total)} บาท
                      </span>
                    </div>
                    <p className="num mt-0.5 text-[0.6875rem] text-fog">
                      {entry.when}
                    </p>
                    <p className="mt-0.5 text-[0.6875rem] text-fog">{entry.note}</p>
                  </li>
                ))}
                {declinedSlips.map((slip) => (
                  <RejectedSlipEntry key={slip.id} slip={slip} />
                ))}
              </ul>
            ) : slipHistoryError === null ? (
              <p className="mt-1.5 text-xs text-fog">
                ยังไม่มีประวัติการชำระ บิลนี้ยังไม่ปิด
              </p>
            ) : null}
            {slipHistoryError !== null && slips.length === 0 && (
              <p className="mt-1.5 text-xs text-danger">{`โหลดสลิปของบิลนี้ไม่สำเร็จ: ${slipHistoryError}`}</p>
            )}
            {bill.status === "unpaid" && hasHistory && (
              <p className="mt-1.5 text-xs text-fog">บิลนี้ยังไม่ปิด</p>
            )}
          </div>
        </aside>
      </div>

      <BillEditDrawer
        open={editOpen}
        bill={bill}
        onClose={() => {
          setEditOpen(false);
        }}
        onSaved={handleSaved}
      />

      <MarkPaidDialog
        open={payOpen}
        bill={bill}
        onClose={() => {
          setPayOpen(false);
        }}
        onPaid={handleSaved}
      />

      <DeleteBillDialog
        open={deleteOpen}
        bill={bill}
        onClose={() => {
          setDeleteOpen(false);
        }}
        onDeleted={handleDeleted}
      />
    </div>
  );
}
