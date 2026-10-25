import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ApiError,
  fetchInvitePreview,
  googleSignInUrl,
  loginWithPassword,
  type InvitePreview,
} from "../api";
import { CredentialField } from "../credential-field";
import { Button, Card, Monogram, Skeleton } from "../ui";
import { dateLabel } from "./bills-shared";

/**
 * เตือนเมื่อเปิดหน้านี้ในเบราว์เซอร์ในแอป LINE
 *
 * Google **ปฏิเสธ** คำขอ OAuth ที่มาจาก embedded webview (ตอบ disallowed_useragent
 * ตั้งแต่ ก.ค. 2023) กดปุ่มด้านล่างจึงเจอหน้า "Access blocked" ของ Google ทันที
 * ไม่ใช่ความผิดพลาดของผู้ใช้และเขาแก้เองไม่ได้ถ้าไม่รู้ — จึงบอกให้เปิดในเบราว์เซอร์
 * ปกติ และให้ปุ่มคัดลอกลิงก์สำหรับวางใน Safari/Chrome
 *
 * ลิงก์ที่บอทส่งมาเติม `openExternalBrowser=1` แล้วจึงไม่ตกมาที่นี่ แต่คนที่จำ URL
 * เอง เปิดจากประวัติ หรือกดลิงก์เก่ายังเจอเคสนี้ได้
 */
function useLineInAppBrowser(): boolean {
  const [inLine, setInLine] = useState(false);

  useEffect(() => {
    // LINE ต่อท้าย UA ของ WebView ตัวเองด้วย "Line/" ทุกแพลตฟอร์ม
    setInLine(/\bLine\//.test(navigator.userAgent));
  }, []);

  return inLine;
}

function LineBrowserNotice({ detail }: { detail: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-status-review-fg/30 bg-status-review-bg px-3 py-2.5 text-xs"
      role="alert"
    >
      <span className="ms text-[1rem] text-status-review-fg" aria-hidden="true">
        warning
      </span>
      <span className="min-w-0">
        <span className="block text-status-review-fg">
          เปิดหน้านี้ในเบราว์เซอร์ของเครื่องก่อนเข้าสู่ระบบ
        </span>
        <span className="mt-0.5 block text-steel">{detail}</span>
        <Button
          size="sm"
          variant="secondary"
          icon={copied ? "check" : "content_copy"}
          className="mt-2"
          onClick={() => {
            void navigator.clipboard
              .writeText(window.location.href)
              .then(() => {
                setCopied(true);
              })
              .catch(() => {
                // คัดลอกไม่ได้ก็ไม่เป็นไร ที่อยู่ยังอยู่ในแถบที่อยู่ของเบราว์เซอร์
              });
          }}
        >
          {copied ? "คัดลอกลิงก์แล้ว" : "คัดลอกลิงก์นี้"}
        </Button>
      </span>
    </div>
  );
}

/** กล่องข้อผิดพลาดระดับหน้า — ทุกหน้าของการเข้าสู่ระบบใช้ร่วมกัน */
function FormNotice({
  message,
  detail,
}: {
  message: string;
  detail?: string;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-ash bg-danger-soft px-3 py-2.5 text-xs"
      role="alert"
    >
      <span className="ms text-[1rem] text-danger" aria-hidden="true">
        error
      </span>
      <span className="min-w-0">
        <span className="block text-danger">{message}</span>
        {detail !== undefined && (
          <span className="mt-0.5 block text-steel">{detail}</span>
        )}
      </span>
    </div>
  );
}

/** รหัสสาเหตุที่เซิร์ฟเวอร์ส่งกลับมาทาง query เมื่อเข้าสู่ระบบด้วย Google ไม่สำเร็จ */
const googleReasonMessages: Record<string, string> = {
  google_disabled: "เซิร์ฟเวอร์นี้ยังไม่ได้ตั้งค่า Google จึงเข้าใช้งานไม่ได้",
  denied: "ยกเลิกการเข้าสู่ระบบด้วย Google",
  state: "การยืนยันตัวตนไม่สมบูรณ์ กรุณาเริ่มใหม่จากหน้านี้",
  google_failed: "ยืนยันกับ Google ไม่สำเร็จ กรุณาลองใหม่",
  no_family: "บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งานหอนี้ กรุณาให้เจ้าของหอออกคำเชิญ",
  not_invited: "อีเมลนี้ยังไม่ได้รับคำเชิญจากเจ้าของหอ",
  family_full: "หอนี้มีผู้ใช้ครบจำนวนแล้ว",
};

/** อ่านเหตุผลจาก query แล้วลบทิ้ง เพื่อไม่ให้ข้อความเดิมกลับมาอีกตอนกด refresh */
function useGoogleFailureNotice(): string | null {
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (params.get("auth") !== "error") {
      return;
    }

    const reason = params.get("reason") ?? "";
    setNotice(googleReasonMessages[reason] ?? "เข้าสู่ระบบด้วย Google ไม่สำเร็จ");

    params.delete("auth");
    params.delete("reason");

    const rest = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${rest === "" ? "" : `?${rest}`}${window.location.hash}`,
    );
  }, []);

  return notice;
}

function AuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="grid min-h-screen items-start justify-items-center bg-canvas-white px-4 py-10 md:place-items-center md:py-16">
      <div className="w-full max-w-[420px]">
        <div className="mb-5 flex items-center gap-2.5">
          <Monogram className="h-11 w-11" />
          <span>
            <span className="block text-sm font-semibold text-charcoal">
              หอพักวังจันทร์
            </span>
            <span className="block text-[0.6875rem] text-fog">ระบบจัดการหอพัก</span>
          </span>
        </div>
        <Card>
          <h1 className="text-xl text-charcoal">{title}</h1>
          <p className="mt-1 text-sm text-steel">{description}</p>
          <div className="mt-4">{children}</div>
        </Card>
      </div>
    </main>
  );
}

/**
 * ตรา Google สี่สี (รูปทรงตามชุดแบรนด์ของ Google)
 *
 * ปุ่ม SSO ที่ใช้ไอคอนบัญชีทั่วไปต้อง "อ่าน" ข้อความถึงจะรู้ว่าพาไปไหน ตราที่คนจำได้อยู่แล้วทำให้
 * เลือกทางเข้าได้ในแวบเดียว แนวทางของ Google ให้วางตราสีบนพื้นขาวเท่านั้น จึงวางชิปขาวไว้เสมอ
 * (เดิมใส่ชิปเฉพาะปุ่มทึบสีเข้ม แต่ธีมมืดกลับสีปุ่มหลักเป็นพื้นสว่าง ชิปแบบมีเงื่อนไขจึงเดาไม่ถูกอีกต่อไป)
 */
function GoogleMark() {
  const mark = (
    <svg viewBox="0 0 48 48" className="h-[18px] w-[18px]" aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );

  // ชิปขาวตามแนวทางแบรนด์ Google: ตราสีต้องอยู่บนพื้นขาว — ใช้ทุกธีม
  // (บนปุ่มพื้นขาวของธีมสว่างชิปจะกลืนหายไปเอง ส่วนธีมมืดและปุ่มทึบของหน้าคำเชิญ ชิปคือสิ่งที่ทำให้ตราอ่านออก)
  return (
    <span className="grid h-[22px] w-[22px] place-items-center rounded-[5px] bg-white">{mark}</span>
  );
}

/**
 * ปุ่มเข้าด้วย Google
 *
 * เป็นปุ่มทึบสีเข้มเมื่อเป็นการกระทำเดียวของหน้า (หน้าคำเชิญ) แต่หน้าเข้าสู่ระบบมี
 * ฟอร์มรหัสผ่านที่ปุ่ม "เข้าสู่ระบบ" เป็นการกระทำหลัก ปุ่มนี้จึงลดเป็นปุ่มรอง
 * (DESIGN.md: หนึ่งการกระทำหลักต่อหนึ่งหน้าจอ)
 *
 * ถ้าตอนนี้มีที่หมายอยู่ใน fragment (เช่นเปิดจากปุ่ม "เปิดบิลในเว็บ" ในแชท LINE)
 * ต้องแนบไปด้วย ไม่งั้นล็อกอินเสร็จแล้วจะตกไปที่แดชบอร์ดและที่หมายหายไป
 */
function GoogleButton({
  label,
  variant = "primary",
}: {
  label: string;
  variant?: "primary" | "secondary";
}) {
  return (
    <Button
      variant={variant}
      className="w-full justify-center"
      onClick={() => {
        window.location.href = googleSignInUrl(window.location.hash);
      }}
    >
      <GoogleMark />
      {label}
    </Button>
  );
}

/**
 * เข้าด้วยชื่อผู้ใช้และรหัสผ่าน
 *
 * สำเร็จแล้วเซิร์ฟเวอร์ตั้งคุกกี้ให้ ไม่ได้พาออกจากหน้าเหมือน Google จึงถามเซสชันใหม่
 * ด้วย onSignedIn() แล้ว AuthGate จะสลับเข้าแอปเอง โดย fragment ปลายทางยังอยู่ที่เดิม
 *
 * ข้อความผิดพลาดของเซิร์ฟเวอร์ไม่แยกว่า "ไม่มีชื่อนี้" กับ "รหัสผิด" โดยตั้งใจ
 */
function PasswordLoginForm({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  /**
   * โฟกัสช่องชื่อผู้ใช้ตอนเปิดหน้า เฉพาะอุปกรณ์ที่มีเมาส์/แทร็กแพด
   *
   * บนมือถือการโฟกัสเองเด้งคีย์บอร์ดขึ้นมาบังคำเตือนของ LINE และข้อความจาก Google ที่อยู่
   * เหนือฟอร์มก่อนที่ผู้ใช้จะได้อ่าน (iOS ก็ไม่โฟกัสให้อยู่แล้วถ้าไม่ได้เกิดจากการแตะ)
   */
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) {
      usernameRef.current?.focus();
    }
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);

    // ย้ายโฟกัสไปช่องแรกที่ยังว่าง ไม่งั้นคนใช้คีย์บอร์ดหรือโปรแกรมอ่านหน้าจอ
    // ยังค้างอยู่ที่ปุ่มส่งโดยไม่รู้ว่าช่องไหนผิด
    if (username.trim() === "") {
      usernameRef.current?.focus();
      return;
    }

    if (password === "") {
      passwordRef.current?.focus();
      return;
    }

    if (busy) {
      return;
    }

    setBusy(true);
    setError(null);

    void loginWithPassword(username.trim(), password)
      .then(onSignedIn)
      .catch((failure: unknown) => {
        setError(
          failure instanceof ApiError
            ? failure.message
            : "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่",
        );
        setBusy(false);
        // รหัสผิดแล้วพิมพ์ใหม่ต่อได้ทันที ปุ่มที่เพิ่งกดไม่ควรเป็นที่ที่โฟกัสค้างอยู่
        passwordRef.current?.focus();
      });
  };

  return (
    <form className="grid gap-4" onSubmit={submit} noValidate aria-busy={busy}>
      <CredentialField
        label="ชื่อผู้ใช้"
        name="username"
        autoComplete="username"
        inputRef={usernameRef}
        value={username}
        onChange={setUsername}
        error={submitted && username.trim() === "" ? "กรอกชื่อผู้ใช้" : undefined}
      />
      <CredentialField
        label="รหัสผ่าน"
        name="password"
        type="password"
        autoComplete="current-password"
        inputRef={passwordRef}
        value={password}
        onChange={setPassword}
        error={submitted && password === "" ? "กรอกรหัสผ่าน" : undefined}
      />
      {error !== null && <FormNotice message={error} />}
      {/* aria-disabled ไม่ใช่ disabled: ปุ่มที่ถูกปิดขณะโฟกัสอยู่ทำให้โฟกัสหลุด (ดูเหตุผลเดียวกันที่ account.tsx) การกดซ้ำถูกกันด้วย busy ใน submit() */}
      <Button variant="primary" type="submit" icon="login" aria-disabled={busy}>
        {busy ? "กำลังเข้าสู่ระบบ" : "เข้าสู่ระบบ"}
      </Button>
    </form>
  );
}

export function AuthScreen({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const googleNotice = useGoogleFailureNotice();
  const lineBrowser = useLineInAppBrowser();

  return (
    <AuthLayout
      title="เข้าสู่ระบบ"
      description="ใช้ชื่อผู้ใช้และรหัสผ่าน หรือบัญชี Google ที่ผูกกับหอนี้"
    >
      {lineBrowser && (
        <LineBrowserNotice detail="Google ไม่อนุญาตให้เข้าสู่ระบบจากเบราว์เซอร์ในแอป LINE จึงต้องเปิดลิงก์นี้ใน Safari หรือ Chrome แทน" />
      )}

      {googleNotice !== null && (
        <div className={lineBrowser ? "mt-3" : ""}>
          <FormNotice message={googleNotice} />
        </div>
      )}

      <div className={lineBrowser || googleNotice !== null ? "mt-4" : ""}>
        <PasswordLoginForm onSignedIn={onSignedIn} />
      </div>

      <div className="my-4 flex items-center gap-3">
        <span className="h-px flex-1 bg-ash" aria-hidden="true" />
        <span className="text-xs text-fog">หรือ</span>
        <span className="h-px flex-1 bg-ash" aria-hidden="true" />
      </div>

      <GoogleButton variant="secondary" label="เข้าสู่ระบบด้วย Google" />

      <div className="mt-4 grid gap-1.5 border-t border-ash pt-3 text-[0.8125rem] leading-relaxed text-steel">
        <p>
          ลืมรหัสผ่าน หรือยังไม่เคยตั้งชื่อผู้ใช้? เข้าด้วย Google
          แล้วตั้งใหม่ได้ที่<span className="whitespace-nowrap">เมนูบัญชี</span>
        </p>
        <p>ผู้ช่วยต้องมีคำเชิญจากเจ้าของหอก่อนจึงจะเข้าได้</p>
      </div>
    </AuthLayout>
  );
}

export function InviteAcceptScreen({
  token,
  onLeave,
}: {
  token: string;
  onLeave: () => void;
}) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const lineBrowser = useLineInAppBrowser();

  /**
   * ถามข้อมูลคำเชิญก่อนให้กดปุ่ม
   *
   * คนที่เปิดลิงก์จาก LINE ต้องรู้ว่าใครเชิญให้ไปหอไหน และต้องรู้ทันทีถ้าลิงก์
   * ใช้ไม่ได้ แทนที่จะเสียเวลากดเข้าสู่ระบบแล้วเพิ่งเจอว่าตัวเองไม่ได้รับเชิญ
   */
  useEffect(() => {
    let cancelled = false;

    // ล้างของเดิมก่อนยิงใหม่ เพราะเบราว์เซอร์เปลี่ยนแค่ hash ได้ (แก้ลิงก์เอง)
    // ถ้าไม่ล้าง หน้าจะค้างอีเมลของคำเชิญอันก่อนไว้ทั้งที่โทเคนเปลี่ยนแล้ว
    setPreview(null);
    setPreviewError(null);
    setChecking(true);

    void fetchInvitePreview(token)
      .then((data) => {
        if (!cancelled) {
          setPreview(data);
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setPreviewError(
            failure instanceof ApiError ? failure.message : "เปิดคำเชิญไม่สำเร็จ",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setChecking(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (checking) {
    return (
      <AuthLayout title="รับคำเชิญ" description="กำลังตรวจสอบคำเชิญ">
        <div className="grid justify-items-center gap-3" aria-busy="true">
          <Skeleton className="h-2 w-40" />
        </div>
      </AuthLayout>
    );
  }

  // ลิงก์ใช้ไม่ได้ — บอกสาเหตุและทางออก ไม่ปล่อยให้กดปุ่มที่ไม่มีทางสำเร็จ
  if (preview === null) {
    return (
      <AuthLayout title="รับคำเชิญ" description="ลิงก์นี้ใช้ไม่ได้แล้ว">
        <FormNotice
          message={previewError ?? "เปิดคำเชิญไม่สำเร็จ"}
          detail="ขอคำเชิญใหม่จากเจ้าของหอ แล้วเปิดลิงก์นั้นอีกครั้ง"
        />
        <div className="mt-4 border-t border-ash pt-3">
          <button
            type="button"
            className="text-xs text-electric-blue underline underline-offset-2"
            onClick={onLeave}
          >
            ไปหน้าเข้าสู่ระบบ
          </button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="รับคำเชิญ"
      description={`เข้าร่วม${preview.familyName}ด้วยบัญชี Google`}
    >
      <dl className="grid gap-1.5 rounded-lg border border-ash bg-paper-mist px-3 py-2.5 text-xs">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-steel">อีเมลที่ถูกเชิญ</dt>
          <dd className="num truncate text-charcoal">{preview.email}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-steel">ใช้ได้ถึง</dt>
          <dd className="num text-charcoal">{dateLabel(preview.expiresAt)}</dd>
        </div>
      </dl>

      {lineBrowser && (
        <div className="mt-4">
          <LineBrowserNotice detail="ลิงก์คำเชิญเปิดจากแอป LINE ได้ แต่การเข้าสู่ระบบด้วย Google ต้องทำใน Safari หรือ Chrome — คัดลอกลิงก์นี้ไปเปิดในเบราว์เซอร์ของเครื่อง" />
        </div>
      )}

      <div className="mt-4">
        <GoogleButton label="เข้าสู่ระบบด้วย Google" />
      </div>

      <p className="mt-3 text-xs text-fog">
        เลือกบัญชี Google ที่ใช้อีเมล {preview.email} เท่านั้น
        แล้วระบบจะพาเข้าครอบครัวให้เอง
      </p>

      <div className="mt-4 border-t border-ash pt-3">
        <button
          type="button"
          className="text-xs text-electric-blue underline underline-offset-2"
          onClick={onLeave}
        >
          ไปหน้าเข้าสู่ระบบ
        </button>
      </div>
    </AuthLayout>
  );
}

export function AuthSplash() {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas-white px-4">
      <div
        className="grid w-full max-w-[360px] justify-items-center gap-3"
        aria-busy="true"
      >
        <Monogram className="h-12 w-12" />
        <p className="text-sm text-steel">กำลังตรวจสอบเซสชัน</p>
        <Skeleton className="h-2 w-40" />
      </div>
    </div>
  );
}
