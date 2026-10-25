import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { safeReturnPath } from "../shared/return-path";
import { fetchDemoStatus, fetchMe, logout, onUnauthorized, type AuthUser } from "./api";
import { AuthScreen, AuthSplash, InviteAcceptScreen } from "./pages/auth";

export interface AuthValue {
  /** null = ยังไม่เข้าสู่ระบบ */
  user: AuthUser | null;
  /** กำลังตรวจเซสชันครั้งแรกก่อนตัดสินใจว่าจะแสดงหน้าใด */
  checking: boolean;
  /** รันอยู่บน Worker เดโมหรือไม่ — ใช้ตัดสินว่าหน้าเข้าสู่ระบบควรเสนอทางเข้าเดโม */
  demoMode: boolean;
  /** ออกจากระบบที่เซิร์ฟเวอร์แล้วพากลับหน้าเข้าสู่ระบบ */
  signOut: () => Promise<void>;
  /** ถามเซิร์ฟเวอร์ใหม่ว่าตอนนี้ใครล็อกอินอยู่ — ใช้หลังเข้าสู่ระบบด้วยรหัสผ่านที่ไม่พาออกจากหน้า */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [demoMode, setDemoMode] = useState(false);

  /**
   * ตรวจเซสชันจากคุกกี้
   *
   * ไม่มี "ตั้งผู้ใช้หลังเข้าสู่ระบบ" ให้เรียกแล้ว เพราะการเข้าสู่ระบบด้วย Google
   * ออกจากหน้าไปที่ Google แล้วกลับมาที่ / ทั้งหน้า โหลดครั้งถัดไปจึงเรียกตัวนี้
   * เองและได้เซสชันที่เซิร์ฟเวอร์เพิ่งสร้างให้
   */
  const load = useCallback(async () => {
    // ตรวจโหมดสาธิตคู่กับการตรวจสอบเซสชัน ไม่ต่อกันเป็นสองรอบ — หน้าเข้าสู่ระบบต้องรู้
    // ตั้งแต่เฟรมแรกว่าควรเสนอทางเข้าเดโมหรือไม่ ไม่งั้นผู้ชมจะเห็นหน้าแจ้งเข้าสู่ระบบ
    // ด้วย Google แล้วเพิ่งมีปุ่มโผล่มาทีหลัง
    const [me] = await Promise.all([
      fetchMe().catch(() => null),
      fetchDemoStatus()
        .then(setDemoMode)
        .catch(() => undefined),
    ]);

    setUser(me);
    setChecking(false);
  }, []);

  useEffect(() => {
    /**
     * ที่หมายที่เซิร์ฟเวอร์ส่งกลับมาหลังล็อกอินด้วย Google
     *
     * เซิร์ฟเวอร์เด้งมาที่ `/?next=%23bills%2Fdetail%2F…` แล้ว ต้องย้ายมาเป็น
     * fragment ของหน้าเดิม (ไม่ reload) และลบ query ทิ้ง เพื่อให้กด refresh แล้ว
     * ไม่ได้ที่หมายเดิมซ้ำ และไม่ให้ค้างอยู่ใน history
     *
     * ใช้ history.replaceState ไม่ใช่การตั้ง location.hash เพื่อไม่ให้เกิด
     * การโหลดหน้าใหม่ทั้งหน้า — เซสชันเพิ่งถูกตั้งในคำขอนี้แล้ว
     */
    const params = new URLSearchParams(window.location.search);
    const next = safeReturnPath(params.get("next"));

    if (next === null) {
      return;
    }

    params.delete("next");

    const rest = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${rest === "" ? "" : `?${rest}`}${next}`,
    );
    // แจ้ง router ให้อ่าน hash ใหม่
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // เซสชันหมดอายุระหว่างใช้งาน 401 จากคำขอใด ๆ จึงพากลับหน้าเข้าสู่ระบบทันที
  useEffect(() => onUnauthorized(() => setUser(null)), []);

  const signOut = useCallback(async () => {
    await logout();
    setUser(null);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      checking,
      demoMode,
      signOut,
      refresh: load,
    }),
    [user, checking, demoMode, signOut, load],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);

  if (value === null) {
    throw new Error("useAuth ต้องเรียกภายใน AuthProvider");
  }

  return value;
}

const inviteHashPrefix = "#invite/";

function inviteTokenOf(hash: string): string | null {
  if (!hash.startsWith(inviteHashPrefix)) {
    return null;
  }

  const token = (hash.slice(inviteHashPrefix.length).split("?")[0] ?? "").trim();

  return token === "" ? null : token;
}

function useInviteToken(): string | null {
  const [token, setToken] = useState<string | null>(() =>
    inviteTokenOf(window.location.hash),
  );

  useEffect(() => {
    const update = () => {
      setToken(inviteTokenOf(window.location.hash));
    };

    window.addEventListener("hashchange", update);

    return () => {
      window.removeEventListener("hashchange", update);
    };
  }, []);

  return token;
}

/** ด่านเดียวที่ตัดสินว่าใครเห็นอะไร: คำเชิญ · โหมดสาธิต · กำลังตรวจเซสชัน · เข้าสู่ระบบ · ตัวแอป */
export function AuthGate({ children }: { children: ReactNode }) {
  const { user, checking, demoMode, refresh } = useAuth();
  const inviteToken = useInviteToken();

  /**
   * บน Worker เดโม ผู้ชมไม่ควรเจอหน้าเข้าสู่ระบบเลย
   *
   * ปุ่มบนหน้าแนะนำพาไปที่ /api/demo/enter อยู่แล้ว แต่คนที่เปิด URL เดโมตรง ๆ หรือ
   * กด refresh หลังเซสชันหมดอายุ จะตกลงมาที่หน้านี้ และหน้าเข้าสู่ระบบไม่มีที่ให้ไปต่อ
   * จึงพาไปที่ทางเข้าเดโมเอง ซึ่งออกคุกกี้ใหม่แล้วรีไดเรกต์กลับมา ทำงานเหมือนกดปุ่ม
   */
  useEffect(() => {
    if (!checking && demoMode && user === null && inviteToken === null) {
      // ส่งที่หมายไปด้วย ไม่งั้นคนที่เปิดลิงก์บิลบน Worker เดโมจะตกไปที่แดชบอร์ด
      const hash = window.location.hash;

      window.location.replace(
        hash.startsWith("#") && hash.length > 1
          ? `/api/demo/enter?next=${encodeURIComponent(hash)}`
          : "/api/demo/enter",
      );
    }
  }, [checking, demoMode, user, inviteToken]);

  if (inviteToken !== null) {
    return (
      <InviteAcceptScreen
        // คำเชิญคนละใบต้องเริ่มจากสถานะของตัวเอง ไม่ค้างข้อมูลใบก่อนไว้
        key={inviteToken}
        token={inviteToken}
        onLeave={() => {
          window.location.hash = user === null ? "" : "#dashboard";
        }}
      />
    );
  }

  if (checking) {
    return <AuthSplash />;
  }

  // ระหว่างรอเบราว์เซอร์พาไป /api/demo/enter อย่าโชว์หน้าเข้าสู่ระบบค้างไว้
  if (demoMode && user === null) {
    return <AuthSplash />;
  }

  if (user === null) {
    return <AuthScreen onSignedIn={refresh} />;
  }

  return <>{children}</>;
}
