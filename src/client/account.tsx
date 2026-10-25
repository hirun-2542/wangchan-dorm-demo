import { useEffect, useId, useRef, useState, type FocusEvent, type FormEvent } from "react";
import {
  ApiError,
  fetchCredentials,
  saveCredentials,
  type AuthUser,
  type CredentialsStatus,
} from "./api";
import { useAuth } from "./auth";
import { CredentialField } from "./credential-field";
import { readThemePreference, setThemePreference, type ThemePreference } from "./theme";
import { Button, Dialog, RoleBadge } from "./ui";

/**
 * ตั้งหรือเปลี่ยนชื่อผู้ใช้และรหัสผ่านของตัวเอง เพื่อเข้าสู่ระบบได้โดยไม่ผ่าน Google
 *
 * ไม่ถามรหัสเดิม: คนที่เข้ามาถึงตรงนี้ล็อกอินอยู่แล้ว (โดยมากด้วย Google) เซสชันนั้นเป็น
 * ตัวยืนยันตัวตน ลืมรหัสเมื่อไรก็เข้าด้วย Google แล้วตั้งใหม่ได้ ไม่เป็นทางตันแบบ
 * ระบบรหัสผ่านเดิมที่ถูกถอดไปใน commit 01e9484 (ต้องรู้รหัสเดิมก่อนถึงเปลี่ยนได้)
 *
 * ฟอร์มถูกสร้างใหม่ทุกครั้งที่เปิด เพื่อไม่ให้รหัสผ่านที่พิมพ์ค้างอยู่ในหน่วยความจำ
 * ของหน้าหลังปิด
 */
function CredentialsForm({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<CredentialsStatus | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let cancelled = false;

    void fetchCredentials()
      .then((loaded) => {
        if (!cancelled) {
          setStatus(loaded);
          // เติมชื่อเดิมเฉพาะเมื่อยังไม่ได้พิมพ์อะไร ไม่ทับสิ่งที่ผู้ใช้กรอกระหว่างรอโหลด
          setUsername((typed) => (typed === "" ? (loaded.username ?? "") : typed));
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setError(
            failure instanceof ApiError
              ? failure
              : new ApiError("โหลดข้อมูลบัญชีไม่สำเร็จ", "UNKNOWN"),
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const mismatch = confirmation !== password;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);

    if (busy || username.trim() === "" || password === "" || mismatch) {
      return;
    }

    setBusy(true);
    setError(null);
    setSaved(false);

    void saveCredentials(username.trim(), password)
      .then((next) => {
        setStatus(next);
        setUsername(next.username ?? "");
        setPassword("");
        setConfirmation("");
        setSubmitted(false);
        setSaved(true);
      })
      .catch((failure: unknown) => {
        setError(
          failure instanceof ApiError
            ? failure
            : new ApiError("บันทึกไม่สำเร็จ กรุณาลองใหม่", "UNKNOWN"),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const fieldError = (field: string): string | undefined =>
    error?.field === field ? error.message : undefined;
  const notice = error !== null && error.field === undefined ? error.message : null;

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate>
      <p className="text-sm text-steel">
        {status?.hasPassword === true
          ? "ตั้งรหัสผ่านใหม่ได้เลยโดยไม่ต้องกรอกรหัสเดิม ถ้าลืมรหัสก็เข้าด้วย Google แล้วมาตั้งใหม่ที่นี่"
          : "ตั้งชื่อผู้ใช้และรหัสผ่านเพื่อเข้าสู่ระบบได้โดยไม่ต้องผ่าน Google (Google ยังใช้เข้าได้เหมือนเดิม)"}
      </p>
      <CredentialField
        label="ชื่อผู้ใช้"
        name="username"
        autoComplete="username"
        value={username}
        onChange={setUsername}
        helper="3-32 ตัว ใช้ a-z 0-9 . _ - ไม่แยกตัวพิมพ์เล็ก/ใหญ่"
        error={fieldError("username") ?? (submitted && username.trim() === "" ? "กรอกชื่อผู้ใช้" : undefined)}
      />
      <CredentialField
        label={status?.hasPassword === true ? "รหัสผ่านใหม่" : "รหัสผ่าน"}
        name="new-password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
        helper="ยาวอย่างน้อย 12 ตัวอักษร"
        error={fieldError("password") ?? (submitted && password === "" ? "กรอกรหัสผ่าน" : undefined)}
      />
      <CredentialField
        label="ยืนยันรหัสผ่าน"
        name="confirm-password"
        type="password"
        autoComplete="new-password"
        value={confirmation}
        onChange={setConfirmation}
        error={submitted && mismatch ? "รหัสผ่านสองช่องไม่ตรงกัน" : undefined}
      />
      {notice !== null && (
        <p className="text-xs text-danger" role="alert">
          {notice}
        </p>
      )}
      {saved && (
        <p className="text-xs text-steel" role="status">
          บันทึกแล้ว ใช้ชื่อผู้ใช้และรหัสผ่านนี้เข้าสู่ระบบได้ตั้งแต่ตอนนี้
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          ปิด
        </Button>
        {/*
          * ไม่ใช้ disabled: ปุ่มที่โฟกัสอยู่แล้วถูกปิดจะทำให้โฟกัสหลุดเป็น null เมนูบัญชีที่ห่อ
          * ฟอร์มนี้ (closeWhenFocusLeaves) จึงปิดตัวเองกลางการบันทึก ฟอร์มถูกถอดทิ้งพร้อมข้อความผลลัพธ์
          * การกดซ้ำถูกกันที่ submit() ด้วย busy อยู่แล้ว
          */}
        <Button variant="primary" type="submit" icon="key" aria-disabled={busy}>
          {busy ? "กำลังบันทึก" : "บันทึก"}
        </Button>
      </div>
    </form>
  );
}

function CredentialsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="ชื่อผู้ใช้และรหัสผ่าน">
      {open && <CredentialsForm onClose={onClose} />}
    </Dialog>
  );
}

const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "ตามระบบ" },
  { value: "light", label: "สว่าง" },
  { value: "dark", label: "มืด" },
];

/**
 * ตัวเลือกธีม — ใช้ pattern segmented เดียวกับตัวกรองในหน้าอื่น (role="group" + aria-pressed)
 *
 * ค่าเริ่มต้นคือ "สว่าง" (ดู readThemePreference) — คนที่ตั้ง OS เป็นมืดอยู่แล้วเลือก
 * "ตามระบบ" ครั้งเดียวก็จบ ส่วนคนที่อยากล็อกธีมก็เลือกทับได้ — ค่ามีผลทันทีและคงอยู่ข้ามการเปิดใหม่
 * (อ่าน/เขียนที่ theme.ts ที่เดียว ทั้งที่นี่และตอนบูตแอป)
 */
function ThemeControl() {
  const labelId = useId();
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());

  return (
    <div className="border-b border-ash px-4 py-3">
      <p className="field-label" id={labelId}>
        ธีม
      </p>
      <div role="group" aria-labelledby={labelId} className="flex gap-1 rounded-lg border border-ash p-1">
        {themeOptions.map((option) => {
          const selected = option.value === preference;

          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              className={`btn btn-sm flex-1 ${selected ? "bg-status-unpaid-bg font-medium text-deep-sapphire" : "text-steel hover:bg-paper-mist"}`}
              onClick={() => {
                setThemePreference(option.value);
                setPreference(option.value);
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * เมนูบัญชีที่เปิดจากชื่อผู้ใช้บนแถบบน
 *
 * เดิมเป็นโมดัลกลางจอ ทั้งที่คำถามที่คนกดเข้ามาหามีสองข้อ — "ตอนนี้ฉันเข้าใช้ด้วย
 * บัญชีอะไร" กับ "ออกจากระบบ" — จึงย่อลงเป็นเมนูที่ตอบสองข้อนั้นตรง ๆ
 * ตอนนี้เพิ่มข้อที่สามคือตั้งชื่อผู้ใช้/รหัสผ่าน (ดู CredentialsForm ว่าทำไมไม่ถามรหัสเดิม)
 *
 * แผงนี้ถูกสร้างใหม่ทุกครั้งที่เปิด (unmount ตอนปิด) ข้อความ error ที่ค้างอยู่
 * จึงไม่หลงเหลือข้ามการเปิด-ปิด โดยไม่ต้องมีโค้ดล้าง state
 */
function AccountMenu({
  user,
  panelId,
  onEditCredentials,
}: {
  user: AuthUser;
  panelId: string;
  onEditCredentials: () => void;
}) {
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // โฟกัสเข้าแผงก่อน เพื่อให้โปรแกรมอ่านหน้าจออ่านข้อมูลบัญชีแล้วค่อยให้ Tab ต่อ
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  /**
   * ออกจากระบบต้องยืนยันก่อน
   *
   * โมดัลยืนยันถูกสร้างไว้ในแผงนี้ (ไม่ใช่ที่อื่น) เพื่อให้การย้ายโฟกัสเข้าโมดัล
   * นับเป็น "อยู่ในแผง" แผงจึงไม่ปิดตัวลงเองระหว่างที่ผู้ใช้กำลังตัดสินใจอยู่
   */
  const leave = () => {
    if (signingOut) {
      return;
    }

    setSigningOut(true);
    setError(null);

    void signOut()
      .catch((failure: unknown) => {
        setError(
          failure instanceof ApiError
            ? failure
            : new ApiError("ออกจากระบบไม่สำเร็จ", "UNKNOWN"),
        );
        setSigningOut(false);
        setConfirming(false);
      });
  };

  return (
    <div
      id={panelId}
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label="บัญชีของฉัน"
      className="absolute right-0 top-[calc(100%+6px)] z-40 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-ash bg-canvas-white shadow-sm"
    >
      <div className="border-b border-ash px-4 py-3">
        <p className="truncate text-[0.8125rem] font-semibold text-charcoal">
          {user.displayName}
        </p>
        <p className="num mt-0.5 truncate text-[0.6875rem] text-fog">{user.email}</p>
        <div className="mt-2">
          <RoleBadge role={user.role} />
        </div>
      </div>

      <ThemeControl />

      <div className="p-1.5">
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[0.8125rem] text-charcoal transition-colors hover:bg-paper-mist"
          onClick={() => {
            onEditCredentials();
          }}
        >
          <span className="ms text-[1.125rem]" aria-hidden="true">
            key
          </span>
          ชื่อผู้ใช้และรหัสผ่าน
        </button>
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[0.8125rem] text-danger transition-colors hover:bg-danger-soft"
          onClick={() => {
            setConfirming(true);
          }}
        >
          <span className="ms text-[1.125rem]" aria-hidden="true">
            logout
          </span>
          ออกจากระบบ
        </button>
      </div>

      {error !== null && (
        <p className="border-t border-ash px-4 py-3 text-xs text-danger" role="alert">
          {error.message}
        </p>
      )}

      <Dialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
        }}
        title="ออกจากระบบ"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              ยกเลิก
            </Button>
            <Button
              variant="danger-soft"
              icon="logout"
              disabled={signingOut}
              onClick={leave}
            >
              {signingOut ? "กำลังออกจากระบบ" : "ออกจากระบบ"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-steel">
          ออกจากระบบแล้วต้องเข้าสู่ระบบใหม่อีกครั้ง
        </p>
      </Dialog>
    </div>
  );
}

export interface AccountButtonProps {
  /** full = ปุ่มมีชื่อบนแถบบนจอใหญ่ · icon = ปุ่มไอคอนจอเล็ก */
  variant: "full" | "icon";
}

export function AccountButton({ variant }: AccountButtonProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  /**
   * ปิดเมื่อคลิกที่อื่นหรือกด Esc
   *
   * เช็คจาก wrapper ไม่ใช่จากแผง เพราะปุ่มเปิดก็ต้องไม่นับเป็น "ที่อื่น"
   * ไม่งั้น pointerdown จะปิดแผงก่อน แล้ว click ของปุ่มจะเปิดมันกลับมาทันที
   */
  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (wrapperRef.current?.contains(event.target as Node)) {
        return;
      }

      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (user === null) {
    return null;
  }

  const initial = user.displayName.slice(0, 1);

  /**
   * ปิดเมื่อโฟกัสออกจากทั้งปุ่มและแผง
   *
   * ถ้าไม่ปิด การกด Tab ผ่านแผงไปจนสุดจะทิ้งแผงลอยค้างไว้กลางจอ
   * โดยไม่มีอะไรบอกว่าตอนนี้โฟกัสอยู่ไหน
   */
  const closeWhenFocusLeaves = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) {
      return;
    }

    setOpen(false);
  };

  return (
    <div className="relative" ref={wrapperRef} onBlur={closeWhenFocusLeaves}>
      {variant === "full" ? (
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => {
            setOpen((previous) => !previous);
          }}
          className="flex min-h-11 items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors hover:bg-paper-mist"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-paper-mist text-[0.8125rem] font-semibold text-charcoal">
            {initial}
          </span>
          <span className="hidden lg:block">
            <span className="block text-[0.8125rem] font-semibold text-charcoal">
              {user.displayName}
            </span>
            <span className="block text-[0.6875rem] text-fog">
              {user.role === "owner" ? "เจ้าของหอ" : "สมาชิก"}
            </span>
          </span>
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-label="บัญชีของฉัน"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => {
            setOpen((previous) => !previous);
          }}
          className="icon-btn h-11 w-11"
        >
          <span className="ms text-[1.25rem]" aria-hidden="true">
            account_circle
          </span>
        </button>
      )}
      {open && (
        <AccountMenu
          user={user}
          panelId={panelId}
          onEditCredentials={() => {
            // ปิดเมนูก่อนเปิดฟอร์ม: ฟอร์มอยู่นอกเมนู จึงไม่ถูกตัวปิดอัตโนมัติของเมนูแตะต้องอีก
            setOpen(false);
            setCredentialsOpen(true);
          }}
        />
      )}
      {/*
        * กล่องตั้งชื่อผู้ใช้/รหัสผ่านอยู่ที่นี่ ไม่ใช่ในเมนู — เมนูปิดตัวเองทันทีที่โฟกัสออกจากตัวมัน
        * (closeWhenFocusLeaves) และช่องชื่อผู้ใช้/รหัสผ่านทำให้เบราว์เซอร์เปิดตัวช่วยกรอกอัตโนมัติ/
        * เสนอรหัสผ่านแข็งแรงของตัวเอง ซึ่งแย่งโฟกัสไปโดยไม่มี relatedTarget ทำให้ทั้งเมนูและฟอร์มที่ซ้อน
        * อยู่ข้างในถูกถอดทิ้งกลางการกรอกทุกครั้ง (เห็นเป็นหน้าจอ "ดับเอง") เมนูที่ปิดไปแล้วไม่มีตัวปิดอัตโนมัติทำงาน
        */}
      <CredentialsDialog
        open={credentialsOpen}
        onClose={() => {
          setCredentialsOpen(false);
          /*
           * ต้องรอให้ dialog ปิดจริงก่อนจึงย้ายโฟกัส: ระหว่างที่ยังเปิดอยู่ เนื้อหานอก dialog
           * เป็น inert การ focus จึงไม่เกิด และตอน native close() คืนโฟกัสให้รายการเมนูที่ถูกถอดไปแล้ว
           * โฟกัสจะตกไปที่ <body> — setTimeout 0 รันหลัง React ปิด dialog ในเฟรมเดียวกันเสมอ
           */
          window.setTimeout(() => {
            triggerRef.current?.focus();
          }, 0);
        }}
      />
    </div>
  );
}
