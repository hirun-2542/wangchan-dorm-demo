import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchPeaAccounts,
  fetchLatestPeaBill,
  type PeaBill,
} from "../api";
import { Button, Field, Skeleton } from "../ui";
import { periodLabel } from "../period";
import { dateLabel } from "./bills-shared";

export interface PeaBillPanelProps {
  title: string;
  /** งวดบิลที่จะเขียนทับ (YYYY-MM) — แสดงคู่กับงวดของ PEA เพื่อกันเลือกผิดเดือน */
  period: string;
  onClose: () => void;
  onImport: (bill: PeaBill) => void;
}

/** ตัวเลข 1–12 หลัก — เก็บเป็นข้อความเพื่อไม่ให้ศูนย์นำหน้าหาย */
export const peaDigits = /^[0-9]{1,12}$/;

/** ปลายทางของกล่องไฟรวม — คีย์ที่จำคู่ CA/รหัสเครื่องวัดฝั่งเซิร์ฟเวอร์ (ห้องใช้ id ห้อง) */
export const peaSharedTarget = "shared";

export const moneyFormat = new Intl.NumberFormat("th-TH", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

type Lookup =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; bill: PeaBill | null };

/**
 * ดึงประวัติบิลจากการไฟฟ้า (PEA) ของบิลรวมมาเติมยอดในเครื่องคิดค่าไฟ — ไม่บันทึกบิล
 * ไม่ตั้งอัตราไฟ และไม่แตะเลขมิเตอร์ แสดงเฉพาะบิลล่าสุดของ PEA — ผู้ใช้ต้องเทียบงวดกับงวดในแอปแล้วกดยืนยัน
 *
 * mount เฉพาะตอนเปิด จึงไม่ค้างข้อมูลของครั้งก่อน
 * คำขอที่ค้างอยู่ถูกทิ้งเมื่อเปลี่ยนคู่ที่ค้นหรือปิดกล่อง (ลำดับคำขอ + cleanup)
 * หน้าจอที่ถูกทิ้งจึงแก้ยอดที่ผู้ใช้พิมพ์ไว้ไม่ได้
 */
export function PeaBillPanel({
  title,
  period,
  onClose,
  onImport,
}: PeaBillPanelProps) {
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [ca, setCa] = useState("");
  const [peano, setPeano] = useState("");
  const [remembered, setRemembered] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [lookup, setLookup] = useState<Lookup>({ status: "idle" });
  /**
   * ผู้ใช้แตะช่องใดช่องหนึ่งแล้ว — ค่าที่จำไว้ที่โหลดมาช้าต้องไม่ทับสิ่งที่พิมพ์อยู่
   * และต้องไม่เติมครึ่งเดียว เพราะ CA ของบัญชีหนึ่งคู่กับรหัสเครื่องวัดของอีก
   * บัญชีจะกลายเป็นคู่ที่ผิด
   */
  const editedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const sequenceRef = useRef(0);

  // เพิ่งกดเปิดจากปุ่ม — ย้ายโฟกัสเข้าช่องแรก ไม่ทิ้งไว้ที่ปุ่มเดิมที่อยู่เหนือขึ้นไป
  useEffect(() => {
    rootRef.current?.querySelector("input")?.focus();
  }, []);

  const runLookup = (nextCa: string, nextPeano: string) => {
    const sequence = sequenceRef.current + 1;

    sequenceRef.current = sequence;
    setLookup({ status: "loading" });

    void fetchLatestPeaBill({
      target: peaSharedTarget,
      ca: nextCa.trim(),
      peano: nextPeano.trim(),
    })
      .then((result) => {
        if (sequenceRef.current === sequence) {
          setLookup({ status: "ready", bill: result.bill });
        }
      })
      .catch((error: unknown) => {
        if (sequenceRef.current !== sequence) {
          return;
        }

        setLookup({
          status: "error",
          message:
            error instanceof ApiError
              ? error.message
              : "ดึงบิลล่าสุดจาก PEA ไม่สำเร็จ",
        });
      });
  };

  useEffect(() => {
    let active = true;

    void fetchPeaAccounts()
      .then((accounts) => {
        if (!active) {
          return;
        }

        setAccountsLoaded(true);

        const account = accounts.find((item) => item.target === peaSharedTarget);

        if (account === undefined || editedRef.current) {
          return;
        }

        setCa(account.ca);
        setPeano(account.peano);
        setRemembered(true);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        setAccountsLoaded(true);
        setAccountsError(
          error instanceof ApiError
            ? error.message
            : "โหลดหมายเลขที่จำไว้ไม่ได้ — กรอกเองได้ตามปกติ",
        );
      });

    return () => {
      active = false;
    };
  }, []);

  // ออกจากกล่อง = คำขอที่ยังค้างอยู่ไม่มีสิทธิ์เขียนลง state ของกล่องที่ถูกทิ้ง
  useEffect(
    () => () => {
      sequenceRef.current += 1;
    },
    [],
  );

  const caValue = ca.trim();
  const peanoValue = peano.trim();
  const caError =
    attempted && !peaDigits.test(caValue)
      ? "กรอกหมายเลขผู้ใช้ไฟฟ้าเป็นตัวเลข 1–12 หลัก"
      : undefined;
  const peanoError =
    attempted && !peaDigits.test(peanoValue)
      ? "กรอกรหัสเครื่องวัดเป็นตัวเลข 1–12 หลัก"
      : undefined;
  const searching = lookup.status === "loading";

  // แก้หมายเลขระหว่างรอคำตอบ = คำตอบของคู่นี้ไม่ใช้แล้ว ต้องทิ้งไม่ให้โผล่มาให้นำไปใช้ผิด
  const invalidateLookup = () => {
    sequenceRef.current += 1;
    setLookup({ status: "idle" });
  };

  const submit = () => {
    setAttempted(true);

    if (!peaDigits.test(caValue) || !peaDigits.test(peanoValue)) {
      return;
    }

    runLookup(caValue, peanoValue);
  };

  const chosen = lookup.status === "ready" ? lookup.bill : null;
  // ช่องเหมาจ่ายรับ 0 ได้ แต่เครื่องคิดค่าไฟรวมต้องได้ยอดมากกว่า 0 และหน่วยเต็มบวก
  const blockedReason =
    chosen === null
      ? null
      : !Number.isFinite(chosen.amount) || chosen.amount <= 0
        ? `บิลล่าสุดมียอด ${Number.isFinite(chosen.amount) ? moneyFormat.format(chosen.amount) : "ไม่ระบุ"} บาท ซึ่งใช้กับเครื่องคิดค่าไฟรวมไม่ได้ — กรอกยอดเองแทน`
        : !(Number.isInteger(chosen.units) && chosen.units > 0)
          ? `บิลล่าสุดมีจำนวนหน่วย ${Number.isFinite(chosen.units) ? chosen.units.toLocaleString("th-TH") : "ไม่ระบุ"} ซึ่งไม่ใช่จำนวนเต็มบวก เครื่องคิดค่าไฟรวมจึงใช้ไม่ได้ — กรอกยอดเองแทน`
          : null;
  const destination = periodLabel(period);

  return (
    <div ref={rootRef} className="mt-3 border-t border-ash pt-3">
      <h3 className="text-sm font-medium text-charcoal">{title}</h3>
      <p className="mt-1 text-xs text-fog">
        ดึงยอดเงินและจำนวนหน่วยจากการไฟฟ้า (PEA) มาเติมในกล่องบิลรวม — เลขมิเตอร์ยังกรอกเอง ระบบไม่ตั้งอัตราไฟให้จนกว่าจะกดใช้กับห้อง และห้องที่เลือกไว้ไม่เปลี่ยน
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field
          label="หมายเลขผู้ใช้ไฟฟ้า"
          value={ca}
          onChange={(value) => {
            editedRef.current = true;
            setRemembered(false);
            invalidateLookup();
            setCa(value);
          }}
          inputMode="numeric"
          helper="ตัวเลข 1–12 หลัก ตามใบแจ้งค่าไฟฟ้า"
          error={caError}
        />
        <Field
          label="รหัสเครื่องวัด"
          value={peano}
          onChange={(value) => {
            editedRef.current = true;
            setRemembered(false);
            invalidateLookup();
            setPeano(value);
          }}
          inputMode="numeric"
          helper="รหัสเครื่องวัดจากใบแจ้งค่าไฟฟ้า"
          error={peanoError}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="secondary"
          icon="search"
          className="border-electric-blue bg-status-unpaid-bg text-deep-sapphire hover:border-deep-sapphire"
          disabled={searching}
          onClick={submit}
        >
          {searching ? "กำลังดึงบิล…" : "ดึงบิลล่าสุด"}
        </Button>
        <p className="text-xs text-fog">
          {!accountsLoaded
            ? "กำลังโหลดหมายเลขที่จำไว้…"
            : remembered
              ? "เติมหมายเลขที่เคยใช้กับที่นี่อัตโนมัติ — แก้ได้ตามต้องการ"
              : "ระบบจำคู่นี้ไว้กับที่นี่หลังดึงสำเร็จเท่านั้น"}
        </p>
      </div>

      {accountsError !== null && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {accountsError}
        </p>
      )}

      {searching && (
        <div className="mt-4 grid gap-2" aria-busy="true">
          <p role="status" className="text-xs text-fog">
            กำลังดึงบิลล่าสุดจาก PEA…
          </p>
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {lookup.status === "error" && (
        <div className="mt-4 rounded-xl border border-danger bg-danger-soft px-3 py-2.5">
          <p role="alert" className="text-sm text-danger">
            {lookup.message}
          </p>
          <p className="mt-1 text-xs text-steel">
            ตรวจหมายเลขผู้ใช้ไฟฟ้ากับรหัสเครื่องวัด แล้วลองอีกครั้ง —
            ยอดที่กรอกไว้ในหน้าเดิมยังอยู่ครบ
          </p>
          <Button
            variant="ghost"
            size="sm"
            icon="refresh"
            className="mt-1 -ml-3"
            onClick={submit}
          >
            ลองใหม่
          </Button>
        </div>
      )}

      {lookup.status === "ready" && chosen === null && (
        <div className="panel-muted mt-4">
          <p className="text-sm text-charcoal">
            PEA ไม่พบบิลสำหรับคู่นี้
          </p>
          <p className="mt-1 text-xs text-steel">
            บิลอาจยังไม่ขึ้นในระบบการไฟฟ้า — กรอกยอดเองได้ตามปกติ
          </p>
        </div>
      )}

      {lookup.status === "ready" && chosen !== null && (
        <div className="panel-muted mt-4">
          <p className="text-sm font-medium text-charcoal">บิลล่าสุดจาก PEA</p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs text-fog">งวดบิลในแอป</p>
              <p className="num text-sm text-charcoal">
                {destination === "" ? "—" : destination}
              </p>
            </div>
            <div>
              <p className="text-xs text-fog">งวดบิลจาก PEA</p>
              <p className="text-sm text-charcoal">{chosen.billPeriod}</p>
            </div>
          </div>

          {blockedReason !== null ? (
            <p role="alert" className="mt-3 text-xs text-danger">
              {blockedReason}
            </p>
          ) : (
            <>
              <p className="num mt-3 text-sm text-charcoal">
                {`${moneyFormat.format(chosen.amount)} บาท · ${chosen.units.toLocaleString("th-TH")} หน่วย`}
              </p>
              <p className="mt-1 text-xs text-steel">
                {chosen.paidAt === null
                  ? "ยังไม่ชำระ"
                  : `ชำระเมื่อ ${dateLabel(chosen.paidAt)}`}
              </p>
              <p className="mt-2 text-xs text-steel">
                นำยอดไปใช้จะเติมยอดเงินกับจำนวนหน่วยในกล่องบิลรวมเท่านั้น — ต้องกดใช้กับห้องอีกครั้งเพื่อตั้งอัตราไฟ และห้องที่เลือกไว้ไม่เปลี่ยน
              </p>
            </>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          ยกเลิก
        </Button>
        <Button
          variant="secondary"
          icon="download"
          disabled={chosen === null || blockedReason !== null}
          onClick={() => {
            if (chosen !== null) {
              onImport(chosen);
              onClose();
            }
          }}
        >
          นำยอดไปใช้
        </Button>
      </div>
    </div>
  );
}

export interface PeaImportButtonProps {
  children: string;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * ปุ่ม "ดึงบิลล่าสุดจาก PEA" ในแท็บคำนวณจากบิลรวม — ใช้ภาษาสีฟ้าชุดเดียวกับตัวเลือก
 * "ที่เลือกอยู่" ของแอป (พื้นฟ้าอ่อน ตัวอักษรเข้ม ขอบฟ้า) ให้เห็นชัดกว่าปุ่มรอง
 * และสูง 44px จากฐานของ `.btn` ทุกขนาดหน้าจอ
 */
export function PeaImportButton({
  children,
  onClick,
  disabled,
}: PeaImportButtonProps) {
  return (
    <Button
      variant="secondary"
      icon="download"
      className="max-w-full whitespace-normal border-electric-blue bg-status-unpaid-bg text-center leading-snug text-deep-sapphire hover:border-deep-sapphire"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
