import { useEffect, useState } from "react";
import {
  ApiError,
  fetchBillPeriods,
  fetchBillsRange,
} from "../api";
import { downloadBillsWorkbook } from "../bills-export-file";
import {
  defaultExportRange,
  trailingYearRange,
  yearToDateRange,
} from "../bills-export-range";
import { Button, Dialog, Select } from "../ui";
import { periodLabel } from "../period";

export interface ExportBillsDialogProps {
  open: boolean;
  onClose: () => void;
  /** เดือนที่กำลังดูอยู่บนจอ — ใช้เป็นค่าเริ่มต้นของช่วงถ้ามีบิลแล้ว */
  currentPeriod: string;
  onDone: (message: string) => void;
}

type LoadState = "loading" | "error" | "empty" | "ready";

/**
 * หน้าต่างเลือกช่วงเดือนแล้วดาวน์โหลดไฟล์ Excel — ดึงรายการเดือนที่มีบิลใหม่
 * ทุกครั้งที่เปิด เพราะอาจเพิ่งสร้างบิลเดือนใหม่ระหว่างที่ผู้ใช้อยู่หน้านี้
 */
export function ExportBillsDialog({
  open,
  onClose,
  currentPeriod,
  onDone,
}: ExportBillsDialogProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [billed, setBilled] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoadState("loading");
    setError(null);

    void fetchBillPeriods()
      .then((periods) => {
        if (!active) return;
        setBilled(periods);
        if (periods.length === 0) {
          setLoadState("empty");
          return;
        }
        const range = defaultExportRange(periods, currentPeriod);
        if (range !== null) {
          setFrom(range.from);
          setTo(range.to);
        }
        setLoadState("ready");
      })
      .catch(() => {
        if (active) setLoadState("error");
      });

    return () => {
      active = false;
    };
  }, [open, currentPeriod]);

  const monthOptions = billed.map((period) => ({
    value: period,
    label: periodLabel(period),
  }));
  const thisYear = yearToDateRange(billed);
  const trailing12 = trailingYearRange(billed);
  const rangeInvalid = from !== "" && to !== "" && from > to;
  const canConfirm = loadState === "ready" && !rangeInvalid && !exporting;

  const close = () => {
    if (exporting) return;
    onClose();
  };

  const confirm = () => {
    if (!canConfirm || from === "" || to === "") return;
    setExporting(true);
    setError(null);

    void fetchBillsRange(from, to)
      .then((bills) => {
        if (bills.length === 0) {
          setError("ไม่มีบิลในช่วงที่เลือก");
          return undefined;
        }
        return downloadBillsWorkbook(bills, { from, to }).then((result) => {
          onDone(`ส่งออก ${result.bills} บิล (${result.rooms} ห้อง) แล้ว`);
          onClose();
        });
      })
      .catch((exportError: unknown) => {
        setError(
          exportError instanceof ApiError
            ? exportError.message
            : "ส่งออกไม่สำเร็จ ลองใหม่อีกครั้ง",
        );
      })
      .finally(() => {
        setExporting(false);
      });
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="ส่งออก Excel"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={exporting}>
            ยกเลิก
          </Button>
          <Button
            variant="primary"
            icon="download"
            disabled={!canConfirm}
            onClick={confirm}
          >
            {exporting ? "กำลังสร้างไฟล์" : "ดาวน์โหลด"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm">
        {loadState === "loading" && (
          <p className="text-steel">กำลังโหลดรายการเดือน</p>
        )}
        {loadState === "error" && (
          <p className="text-danger">โหลดรายการเดือนไม่สำเร็จ</p>
        )}
        {loadState === "empty" && (
          <p className="text-steel">ยังไม่มีบิลให้ส่งออก</p>
        )}
        {loadState === "ready" && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label="ตั้งแต่"
                value={from}
                onChange={setFrom}
                options={monthOptions}
              />
              <Select
                label="ถึง"
                value={to}
                onChange={setTo}
                options={monthOptions}
              />
            </div>
            {(thisYear !== null || trailing12 !== null) && (
              <div className="flex flex-wrap gap-2">
                {thisYear !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFrom(thisYear.from);
                      setTo(thisYear.to);
                    }}
                  >
                    ปีนี้
                  </Button>
                )}
                {trailing12 !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFrom(trailing12.from);
                      setTo(trailing12.to);
                    }}
                  >
                    12 เดือนล่าสุด
                  </Button>
                )}
              </div>
            )}
            {rangeInvalid && (
              <p className="text-xs text-danger">
                เดือนเริ่มต้องไม่เกินเดือนสุดท้าย
              </p>
            )}
            {error !== null && <p className="text-xs text-danger">{error}</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}
