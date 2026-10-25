import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  deletePeaAccount,
  fetchLatestPeaBill,
  fetchPeaAccounts,
  type PeaAccount,
} from "../api";
import { Button, Field } from "../ui";
import { moneyFormat, peaDigits } from "./bills-pea-import";

interface RoomPeaConnectionProps {
  roomId: string;
}

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; account: PeaAccount | null };

type Busy = "checking" | "saving" | "removing" | null;

/**
 * ตั้งค่าการเชื่อมต่อ PEA ของห้องจากหน้าห้องพัก — คู่ CA/รหัสเครื่องวัดเดียวกับที่กล่อง
 * จัดการค่าไฟในหน้าบิลใช้ (เก็บใน settings ต่อห้อง) บันทึกทันทีโดยไม่รอปุ่ม "บันทึกห้อง"
 * เพราะเซิร์ฟเวอร์ต้องเรียก PEA ตรวจคู่ก่อนจำ
 */
export function RoomPeaConnection({ roomId }: RoomPeaConnectionProps) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [editing, setEditing] = useState(false);
  const [ca, setCa] = useState("");
  const [peano, setPeano] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setLoad({ status: "loading" });
    setEditing(false);
    setError(null);
    setNotice(null);

    void fetchPeaAccounts()
      .then((accounts) => {
        if (!alive.current) {
          return;
        }

        const account = accounts.find((item) => item.target === roomId) ?? null;

        setLoad({ status: "ready", account });
        setCa(account?.ca ?? "");
        setPeano(account?.peano ?? "");
      })
      .catch((failure: unknown) => {
        if (alive.current) {
          setLoad({
            status: "error",
            message:
              failure instanceof ApiError
                ? failure.message
                : "โหลดการเชื่อมต่อ PEA ไม่สำเร็จ",
          });
        }
      });
  }, [roomId]);

  if (load.status === "loading") {
    return <p className="text-xs text-fog">กำลังโหลดการเชื่อมต่อ PEA…</p>;
  }

  if (load.status === "error") {
    return (
      <p role="alert" className="text-xs text-danger">
        {load.message}
      </p>
    );
  }

  const account = load.account;
  const showForm = account === null || editing;
  const caValue = ca.trim();
  const peanoValue = peano.trim();
  const caError =
    attempted && !peaDigits.test(caValue)
      ? "กรอกหมายเลขผู้ใช้ไฟฟ้า (CA) 1–12 หลัก"
      : undefined;
  const peanoError =
    attempted && !peaDigits.test(peanoValue)
      ? "กรอกรหัสเครื่องวัด 1–12 หลัก"
      : undefined;

  const run = (mode: "checking" | "saving") => {
    if (!peaDigits.test(caValue) || !peaDigits.test(peanoValue)) {
      setAttempted(true);

      return;
    }

    setBusy(mode);
    setError(null);
    setNotice(null);

    void fetchLatestPeaBill({
      target: roomId,
      ca: caValue,
      peano: peanoValue,
      verifyOnly: mode === "checking",
    })
      .then((result) => {
        if (!alive.current) {
          return;
        }

        setBusy(null);

        if (mode === "saving") {
          setLoad({ status: "ready", account: result.account });
          setEditing(false);
          setNotice("บันทึกการเชื่อมต่อ PEA ของห้องนี้แล้ว");

          return;
        }

        setNotice(
          result.bill === null
            ? "เชื่อมต่อได้ แต่ PEA ยังไม่มีบิลของหมายเลขนี้"
            : `เชื่อมต่อได้ · บิลล่าสุด ${result.bill.billPeriod} ${moneyFormat.format(result.bill.amount)} บาท`,
        );
      })
      .catch((failure: unknown) => {
        if (alive.current) {
          setBusy(null);
          setError(
            failure instanceof ApiError
              ? failure.message
              : mode === "checking"
                ? "ตรวจสอบการเชื่อมต่อกับ PEA ไม่สำเร็จ"
                : "บันทึกการเชื่อมต่อไม่สำเร็จ",
          );
        }
      });
  };

  const disconnect = () => {
    setBusy("removing");
    setError(null);
    setNotice(null);

    void deletePeaAccount(roomId)
      .then(() => {
        if (!alive.current) {
          return;
        }

        setBusy(null);
        setLoad({ status: "ready", account: null });
        setCa("");
        setPeano("");
        setAttempted(false);
        setNotice("ยกเลิกการเชื่อมต่อ PEA ของห้องนี้แล้ว");
      })
      .catch((failure: unknown) => {
        if (alive.current) {
          setBusy(null);
          setError(
            failure instanceof ApiError
              ? failure.message
              : "ยกเลิกการเชื่อมต่อไม่สำเร็จ",
          );
        }
      });
  };

  const startEdit = () => {
    setEditing(true);
    setCa(account?.ca ?? "");
    setPeano(account?.peano ?? "");
    setAttempted(false);
    setError(null);
    setNotice(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setAttempted(false);
    setError(null);
    setNotice(null);
  };

  return (
    <div className="grid gap-3">
      {!showForm && account !== null && (
        <>
          <dl className="panel-muted grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt className="text-xs text-fog">CA</dt>
            <dd className="num text-charcoal">{account.ca}</dd>
            <dt className="text-xs text-fog">รหัสเครื่องวัด</dt>
            <dd className="num text-charcoal">{account.peano}</dd>
          </dl>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon="delete"
              disabled={busy !== null}
              onClick={disconnect}
            >
              {busy === "removing" ? "กำลังยกเลิก…" : "ยกเลิกการเชื่อมต่อ"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon="edit"
              disabled={busy !== null}
              onClick={startEdit}
            >
              แก้ไข
            </Button>
          </div>
        </>
      )}

      {showForm && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="หมายเลขผู้ใช้ไฟฟ้า (CA)"
              value={ca}
              onChange={setCa}
              inputMode="numeric"
              helper="ตัวเลข 1–12 หลัก ตามใบแจ้งค่าไฟฟ้า"
              error={caError}
            />
            <Field
              label="รหัสเครื่องวัด"
              value={peano}
              onChange={setPeano}
              inputMode="numeric"
              helper="รหัสเครื่องวัดจากใบแจ้งค่าไฟฟ้า"
              error={peanoError}
            />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {account !== null && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={cancelEdit}
              >
                ยกเลิกการแก้ไข
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon="search"
              disabled={busy !== null}
              onClick={() => {
                run("checking");
              }}
            >
              {busy === "checking" ? "กำลังตรวจสอบ…" : "ตรวจสอบการเชื่อมต่อ"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="save"
              disabled={busy !== null}
              onClick={() => {
                run("saving");
              }}
            >
              {busy === "saving" ? "กำลังบันทึก…" : "บันทึกการเชื่อมต่อ"}
            </Button>
          </div>
        </>
      )}

      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="text-xs text-status-paid-fg">
          {notice}
        </p>
      )}
    </div>
  );
}
