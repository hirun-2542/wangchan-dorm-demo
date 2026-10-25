import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccountButton } from "./account";
import { useAuth } from "./auth";
import { announceBillsChanged, announceReviewQueueChanged, announceTenantsChanged, clearNotifications, fetchBills, fetchDormCharges, fetchFamily, fetchLineMessages, fetchMeterSheet, fetchNotifications, fetchRooms, fetchSettings, fetchSlips, fetchTenants, markNotificationsRead, reviewQueueChangedEvent, type Room, type Tenant } from "./api";
import { ErrorBoundary } from "./error-boundary";
import { NotificationButton } from "./notification-button";
import {
  markAllRead,
  notificationOf,
  notificationText,
  tenantJoinedNotificationOf,
  unreadCount,
  type AppNotification,
} from "./notifications";
import { periodAt } from "./period";
import { SearchProvider, useSearch } from "./search";
import { startRealtime } from "./realtime";
import { Card, Monogram, Skeleton, Toast, type PageProps } from "./ui";

/**
 * โหลดแต่ละหน้าแบบ lazy แทนการ import ตรง ๆ — ก่อนหน้านี้ทุกหน้า (รวม
 * bills-create ที่ยาวกว่า 2,000 บรรทัด) ถูกมัดรวมเป็นชิ้นเดียวกว่า 500KB
 * ทำให้เปิดแอปครั้งแรกต้องโหลด+รันโค้ดของทุกหน้าทั้งที่ยังไม่ได้เข้าไปดู
 * เปลี่ยนเป็น code-split ตาม route ทำให้ครั้งแรกโหลดเฉพาะหน้าที่เปิดจริง
 * ส่วนหน้าอื่นค่อยโหลดตอนกดเมนูไปหน้านั้น (แล้วเบราว์เซอร์ cache ไว้)
 */
type PageComponent = (props: PageProps) => ReactNode;

/** หน้าที่โหลดโค้ดเสร็จแล้ว — ดู PageSlot ว่าทำไมต้องจำไว้นอก React.lazy */
const loadedPages = new Map<string, PageComponent>();

function pageLoader(id: string, load: () => Promise<PageComponent>): () => Promise<{ default: PageComponent }> {
  return () =>
    load().then((component) => {
      loadedPages.set(id, component);
      return { default: component };
    });
}

const pageLoaders = {
  dashboard: pageLoader("dashboard", () => import("./pages/dashboard").then((m) => m.DashboardPage)),
  rooms: pageLoader("rooms", () => import("./pages/rooms").then((m) => m.RoomsPage)),
  tenants: pageLoader("tenants", () => import("./pages/tenants").then((m) => m.TenantsPage)),
  bills: pageLoader("bills", () => import("./pages/bills").then((m) => m.BillsPage)),
  review: pageLoader("review", () => import("./pages/review").then((m) => m.ReviewPage)),
  line: pageLoader("line", () => import("./pages/line").then((m) => m.LinePage)),
  family: pageLoader("family", () => import("./pages/family").then((m) => m.FamilyPage)),
  settings: pageLoader("settings", () => import("./pages/settings").then((m) => m.SettingsPage)),
};

const DashboardPage = lazy(pageLoaders.dashboard);
const RoomsPage = lazy(pageLoaders.rooms);
const TenantsPage = lazy(pageLoaders.tenants);
const BillsPage = lazy(pageLoaders.bills);
const ReviewPage = lazy(pageLoaders.review);
const LinePage = lazy(pageLoaders.line);
const FamilyPage = lazy(pageLoaders.family);
const SettingsPage = lazy(pageLoaders.settings);

const routeList = [
  { id: "dashboard", label: "แดชบอร์ด", icon: "space_dashboard" },
  { id: "rooms", label: "ห้องพัก", icon: "door_front" },
  { id: "tenants", label: "ผู้เช่า", icon: "group" },
  { id: "bills", label: "บิล", icon: "receipt_long" },
  { id: "review", label: "รอตรวจ", icon: "fact_check" },
  { id: "line", label: "ข้อความ LINE", icon: "chat_bubble" },
  { id: "family", label: "ครอบครัว", icon: "groups" },
  { id: "settings", label: "ตั้งค่า", icon: "settings" },
] as const;

type RouteId = (typeof routeList)[number]["id"];

const pages: Record<RouteId, PageComponent> = {
  dashboard: DashboardPage,
  rooms: RoomsPage,
  tenants: TenantsPage,
  bills: BillsPage,
  review: ReviewPage,
  line: LinePage,
  family: FamilyPage,
  settings: SettingsPage,
};

const mobileTabs = [
  { id: "dashboard", label: "แดชบอร์ด", icon: "space_dashboard" },
  { id: "rooms", label: "ห้องพัก", icon: "door_front" },
  { id: "tenants", label: "ผู้เช่า", icon: "group" },
  { id: "bills", label: "บิล", icon: "receipt_long" },
] as const;

const moreItems = [
  { route: "review", label: "รอตรวจ", icon: "fact_check" },
  { route: "line", label: "ข้อความ LINE", icon: "chat_bubble" },
  { route: "family", label: "ครอบครัว", icon: "groups" },
  { route: "settings", label: "ตั้งค่า", icon: "settings" },
] as const;

const moreRoutes: RouteId[] = ["review", "line", "family", "settings"];

interface ParsedRoute {
  route: RouteId;
  view: string;
}

function findRoute(id: RouteId) {
  return routeList.find((item) => item.id === id) ?? routeList[0];
}

function parseRoute(hash: string): ParsedRoute {
  const [pathPart = ""] = hash.replace(/^#/, "").split("?");
  const [routePart = "", viewPart = ""] = pathPart.split("/");
  const match = routeList.find((item) => item.id === routePart);

  if (match === undefined) {
    return { route: "dashboard", view: "" };
  }

  return { route: match.id, view: viewPart };
}

function routeTitle(parsed: ParsedRoute) {
  if (parsed.route === "bills" && parsed.view === "create") {
    return "สร้างบิล";
  }

  return findRoute(parsed.route).label;
}

const desktopSearchQuery = "(min-width: 768px)";

function useDesktopSearch(): boolean {
  const [available, setAvailable] = useState<boolean>(() =>
    typeof window === "undefined" ? true : window.matchMedia(desktopSearchQuery).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(desktopSearchQuery);
    const update = () => {
      setAvailable(media.matches);
    };

    media.addEventListener("change", update);

    return () => {
      media.removeEventListener("change", update);
    };
  }, []);

  return available;
}

function searchOptionId(index: number): string {
  return `topbar-search-option-${index}`;
}

/**
 * อุปกรณ์ที่มีตัวชี้ละเอียด (เมาส์/แทร็กแพด) — ใช้ตัดสินว่าจะแสดงปุ่มลัด Ctrl K
 * แท็บเล็ตสัมผัสที่กว้างเกิน 768px มีช่องค้นหาได้ แต่กดคีย์ลัดไม่ได้
 */
const finePointerQuery = "(pointer: fine)";

function useFinePointer(): boolean {
  const [fine, setFine] = useState<boolean>(() =>
    typeof window === "undefined" ? true : window.matchMedia(finePointerQuery).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(finePointerQuery);
    const update = () => {
      setFine(media.matches);
    };

    media.addEventListener("change", update);

    return () => {
      media.removeEventListener("change", update);
    };
  }, []);

  return fine;
}

function useHashRoute(): ParsedRoute {
  const [parsed, setParsed] = useState<ParsedRoute>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHashChange = () => {
      setParsed(parseRoute(window.location.hash));
    };

    window.addEventListener("hashchange", onHashChange);

    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  useEffect(() => {
    document.title = `${routeTitle(parsed)} — หอพักวังจันทร์`;
    window.scrollTo(0, 0);
  }, [parsed]);

  return parsed;
}

interface NavLinkProps {
  route: RouteId;
  label: string;
  icon: string;
  active: boolean;
  badge?: number;
}

function NavLink({ route, label, icon, active, badge }: NavLinkProps) {
  return (
    <a
      href={`#${route}`}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={`relative flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm no-underline transition-colors md:justify-center xl:justify-start ${
        active ? "bg-status-unpaid-bg text-deep-sapphire" : "text-graphite hover:bg-paper-mist hover:text-charcoal"
      }`}
    >
      <span className={active ? "ms fill text-[1.125rem]" : "ms text-[1.125rem]"} aria-hidden="true">
        {icon}
      </span>
      <span className="hidden xl:inline">{label}</span>
      {badge !== undefined && badge > 0 && (
        <>
          <span className="absolute right-3 top-2 h-2 w-2 rounded-full bg-tangerine md:block xl:hidden" aria-hidden="true" />
          <span className="num ml-auto hidden rounded-full bg-status-review-bg px-2 py-0.5 text-[0.6875rem] font-medium text-status-review-fg xl:inline">
            {badge}
          </span>
        </>
      )}
    </a>
  );
}

function PendingLink({ className, badge, label }: { className: string; badge: number; label: string }) {
  return (
    <a href="#review" aria-label={label} className={className}>
      <span className="ms text-[1.25rem]" aria-hidden="true">
        fact_check
      </span>
      {badge > 0 && (
        <span className="num absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-status-review-bg px-1 text-[0.6875rem] font-medium text-status-review-fg">
          {badge}
        </span>
      )}
    </a>
  );
}

/** โครงหน้าตอนกำลังโหลดโค้ดของ route นั้น — โผล่สั้น ๆ ตอนกดเมนูไปหน้าที่ยังไม่เคยโหลด */
function RouteFallback() {
  return (
    <Card>
      <div className="grid gap-3" aria-busy="true">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </div>
    </Card>
  );
}

function Shell() {
  const parsed = useHashRoute();
  const { query, setQuery } = useSearch();
  const desktopSearch = useDesktopSearch();
  const finePointer = useFinePointer();
  const searchRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLDialogElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [pendingReviewCount, setPendingReviewCount] = useState(0);
  const [jumpRooms, setJumpRooms] = useState<Room[]>([]);
  const [jumpTenants, setJumpTenants] = useState<Tenant[]>([]);
  const [panelDismissed, setPanelDismissed] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  const [realtimeToast, setRealtimeToast] = useState<string | null>(null);
  /**
   * รายการแจ้งเตือนของกระดิ่ง — ประวัติจริงอยู่ที่เซิร์ฟเวอร์ (ดู notifications.ts)
   *
   * Toast ยังอยู่ เพราะเป็นสิ่งที่ทำให้รู้ตัวทันทีโดยไม่ต้องไปกดปุ่มกระดิ่ง
   * ส่วนรายการนี้ทำให้ "รู้ตัวช้า" ไม่กลายเป็น "ไม่รู้เลย" และครบแม้ปิดเบราว์เซอร์อยู่
   */
  // โหมดสาธิตมาจาก AuthProvider แล้ว (ตรวจคู่กับการตรวจเซสชันตั้งแต่เฟรมแรก)
  // ไม่ต้องยิง /api/demo/status ซ้ำที่นี่ ซึ่งเดิมทำให้ยิงสองครั้งต่อการโหลดหนึ่งครั้ง
  const { demoMode } = useAuth();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  /** ลำดับล่าสุดที่หน้านี้เห็น — ส่งกลับตอนกดอ่าน/ล้างเพื่อไม่ให้ครอบคลุมเหตุการณ์ที่ยังไม่เห็น */
  const newestSeqRef = useRef(0);
  const reloadRequestRef = useRef(0);

  const reloadNotifications = useCallback(() => {
    reloadRequestRef.current += 1;
    const request = reloadRequestRef.current;

    void fetchNotifications()
      .then(({ items, newestSeq }) => {
        // คำตอบของคำขอเก่าที่มาช้ากว่าคำขอใหม่ต้องไม่ทับของใหม่
        if (request !== reloadRequestRef.current) {
          return;
        }

        newestSeqRef.current = newestSeq;
        setNotifications(items);
      })
      .catch(() => undefined);
  }, []);

  const openNotifications = () => {
    if (unreadCount(notifications) === 0) {
      return;
    }

    setNotifications((previous) => markAllRead(previous));
    void markNotificationsRead(newestSeqRef.current).catch(() => undefined);
  };

  const clearAllNotifications = () => {
    setNotifications([]);
    void clearNotifications(newestSeqRef.current).catch(() => undefined);
  };

  /**
   * ดัชนีสำหรับค้นหาด่วน — โหลดซ้ำทุกครั้งที่โฟกัสช่องค้นหา
   * เพราะห้องและผู้เช่าแก้ได้จากหน้าอื่นโดยไม่เปลี่ยนเส้นทาง
   */
  const loadJumpIndex = useCallback(() => {
    void Promise.all([fetchRooms(), fetchTenants()])
      .then(([rooms, tenants]) => {
        setJumpRooms(rooms);
        setJumpTenants(tenants);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadJumpIndex();
  }, [loadJumpIndex]);

  /**
   * เข้าสู่ระบบแล้วและหน้าแรกวาดเสร็จ — โหลดโค้ดของหน้าอื่นกับตั้งค่าที่หลายหน้าใช้ไว้ล่วงหน้าตอนว่าง
   * เพื่อให้ "ช้า" เกิดแค่ตอนเปิดแอปครั้งแรก การกดเข้าหน้าอื่นครั้งแรกไม่ต้องรอโหลดโค้ดอีก
   * ข้ามเมื่อผู้ใช้เปิดโหมดประหยัดข้อมูล (ราว 90KB บีบอัดแล้วต่อรอบเปิดแอป)
   */
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;

    if (connection?.saveData === true) {
      return;
    }

    const warm = () => {
      for (const load of Object.values(pageLoaders)) {
        void load().catch(() => undefined);
      }

      // ข้อมูลที่หน้าอื่นขอตอนเข้าครั้งแรก (ตรงกับ URL ที่หน้านั้นยิงจริง จึงเข้าแคชแล้วหน้าแสดงผลทันที)
      // เฉพาะที่อ่าน D1 อย่างเดียว — ไม่เรียก LINE/PEA ภายนอกล่วงหน้า
      const period = periodAt(0);

      for (const prefetch of [
        fetchSettings(),
        fetchDormCharges(),
        fetchFamily(),
        fetchLineMessages(),
        fetchBills(period),
        fetchMeterSheet(period),
      ]) {
        void prefetch.catch(() => undefined);
      }
    };
    const hasIdle = typeof window.requestIdleCallback === "function";
    const handle = hasIdle ? window.requestIdleCallback(warm, { timeout: 4000 }) : window.setTimeout(warm, 1500);

    return () => {
      if (hasIdle) {
        window.cancelIdleCallback(handle);
      } else {
        window.clearTimeout(handle);
      }
    };
  }, []);

  /**
   * เปลี่ยน view ด้วย hash ไม่ได้ reload หน้า — ต้องย้ายโฟกัสไปเนื้อหาใหม่เอง
   * ไม่งั้นโปรแกรมอ่านหน้าจอไม่รู้ว่าเนื้อหาเปลี่ยน และ Tab ต่อไปจะเริ่มจากที่เดิม
   * (ข้ามการเลื่อนจอ เพราะ effect เดียวกันของ useHashRoute เลื่อนขึ้นบนสุดให้แล้ว)
   */
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [parsed]);

  /**
   * WebSocket กลางของทั้งแอป — ต่อหนึ่งเส้นต่อแท็บ
   *
   * ข้อความที่เข้ามาเป็นของ "บิลถูกปิด" เท่านั้น จึงไม่ต้องรู้ว่าผู้ใช้กำลังดู
   * หน้าไหน: ประกาศ event ให้หน้าที่สนใจโหลดข้อมูลของตัวเองใหม่แล้วเด้ง toast
   * ตรงนี้ที่เดียว (Toast รายหน้าเดิมยังทำงานเหมือนเดิม)
   */
  useEffect(() => {
    return startRealtime({
      onBillPaid: (notice) => {
        setRealtimeToast(notificationText(notificationOf(notice)));
        // เซิร์ฟเวอร์บันทึกเหตุการณ์นี้แล้วก่อนกระจาย — อ่านรายการจากที่นั่น ไม่ต่อรายการเอง
        // จะได้มีลำดับ (seq) ตรงกับเซิร์ฟเวอร์สำหรับตอนกดอ่าน/ล้าง
        reloadNotifications();
        announceBillsChanged();
        announceReviewQueueChanged();
      },
      onTenantJoined: (notice) => {
        setRealtimeToast(notificationText(tenantJoinedNotificationOf(notice)));
        reloadNotifications();
        // รายชื่อผู้เช่าเปลี่ยน — หน้าที่เปิดอยู่ต้องโหลดใหม่ (แดชบอร์ดนับห้องว่างด้วย)
        announceTenantsChanged();
      },
      onReconnected: () => {
        // ข้อความที่หลุดตอน socket ปิดไม่ถูกเก็บไว้ ต้องโหลดใหม่หนึ่งครั้ง
        // (แจ้งเตือนเองไม่หลุดแล้ว เพราะอ่านจากเซิร์ฟเวอร์)
        reloadNotifications();
        announceBillsChanged();
        announceReviewQueueChanged();
      },
    });
  }, [reloadNotifications]);

  // โหลดประวัติตอนเปิดหน้า และทุกครั้งที่กลับมาที่แท็บ — ได้ทั้งเหตุการณ์ที่เกิดตอนปิดเบราว์เซอร์
  // และการอ่าน/ล้างที่ทำจากอีกแท็บหรืออีกเครื่อง
  useEffect(() => {
    reloadNotifications();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        reloadNotifications();
      }
    };

    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reloadNotifications]);

  useEffect(() => {
    if (realtimeToast === null) {
      return;
    }

    const timer = window.setTimeout(() => setRealtimeToast(null), 5000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [realtimeToast]);

  useEffect(() => {
    let active = true;

    const refreshCount = () => {
      void fetchSlips()
        .then((slips) => {
          if (active) {
            setPendingReviewCount(slips.length);
          }
        })
        .catch(() => undefined);
    };

    refreshCount();
    window.addEventListener(reviewQueueChangedEvent, refreshCount);

    return () => {
      active = false;
      window.removeEventListener(reviewQueueChangedEvent, refreshCount);
    };
    // ไม่ผูกกับ parsed.route: ตัวเลขนี้เปลี่ยนเมื่อคิวเปลี่ยน (event) หรือหลังต่อ WebSocket ใหม่
    // การยิงใหม่ทุกครั้งที่เปลี่ยนหน้าเดิมซ้ำซ้อน — รายการสลิปยาวขึ้นเรื่อย ๆ ตามการใช้งาน
  }, []);

  useEffect(() => {
    if (!desktopSearch) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [desktopSearch]);

  useEffect(() => {
    setQuery("");
  }, [parsed.route, setQuery]);

  const closeMore = () => {
    moreRef.current?.close();
    setMoreOpen(false);
  };

  const openMore = () => {
    moreRef.current?.showModal();
    setMoreOpen(true);
  };

  // หน้าที่โหลดไว้แล้ว (เช่นโหลดล่วงหน้าตอนว่าง) วาดตรง ๆ ไม่ผ่าน React.lazy
  // เพราะ lazy ที่ยังไม่เคยวาดต้องหยุดรอหนึ่งรอบ แล้ว React จะค้าง fallback ไว้อย่างน้อย ~300ms
  // ก่อนเผยเนื้อหา แม้โค้ดอยู่ในเครื่องแล้ว — เป็นสาเหตุที่การเข้าหน้าอื่นครั้งแรกหลังโหลดไว้แล้วยังช้า
  // เลือกครั้งเดียวต่อ route (useMemo) — ถ้าสลับชนิดคอมโพเนนต์กลางทางเมื่อโหลดล่วงหน้าเสร็จ
  // หน้าที่เปิดอยู่จะถูกสร้างใหม่และฟอร์มที่พิมพ์ค้างไว้หาย
  const Page = useMemo(() => loadedPages.get(parsed.route) ?? pages[parsed.route], [parsed.route]);
  const moreActive = moreRoutes.includes(parsed.route);

  const needle = query.trim().toLowerCase();
  const jumpResults =
    needle === ""
      ? []
      : [
          ...jumpRooms
            .filter((room) => room.roomNumber.toLowerCase().includes(needle))
            .slice(0, 4)
            .map((room) => ({
              key: `room-${room.id}`,
              label: `ห้อง ${room.roomNumber}`,
              detail: room.occupiedBy ?? "ห้องว่าง",
              kind: "ห้องพัก",
              hash: "#rooms",
            })),
          ...jumpTenants
            .filter(
              (tenant) =>
                tenant.fullName.toLowerCase().includes(needle) ||
                tenant.roomNumber.toLowerCase().includes(needle) ||
                tenant.phone.includes(needle),
            )
            .slice(0, 4)
            .map((tenant) => ({
              key: `tenant-${tenant.id}`,
              label: tenant.fullName,
              detail: `ห้อง ${tenant.roomNumber}`,
              kind: "ผู้เช่า",
              hash: "#tenants",
            })),
        ].slice(0, 6);
  const searchPanelOpen = needle !== "" && !panelDismissed;
  const activeIndex = jumpResults.length === 0 ? -1 : Math.min(activeResult, jumpResults.length - 1);

  const openResult = (hash: string) => {
    setQuery("");
    setPanelDismissed(true);
    window.location.hash = hash;
  };

  return (
    <>
      {/*
       * ลิงก์ข้ามเมนูสำหรับคีย์บอร์ด — ซ่อนไว้เหนือจอจนกว่าจะโฟกัส (Tab แรกของหน้า)
       * ใช้ onClick แทนการพึ่ง hash เพราะ hash ทั้งแอปเป็นเส้นทางของ router (#main จะถูกตีความเป็น route)
       */}
      <a
        href="#main"
        className="absolute -top-24 left-4 z-50 rounded-lg border border-ash bg-canvas-white px-4 py-2 text-sm font-medium text-charcoal shadow-sm focus:top-4"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        ข้ามไปที่เนื้อหาหลัก
      </a>
      {demoMode && (
        <div
          role="status"
          className="flex min-h-9 items-center justify-center gap-1.5 bg-status-review-bg px-4 py-1.5 text-center text-[0.8125rem] font-medium text-status-review-fg"
        >
          <span className="ms text-[1rem]" aria-hidden="true">
            info
          </span>
          โหมดสาธิต — ข้อมูลทั้งหมดในหน้านี้เป็นข้อมูลตัวอย่าง อาจถูกผู้ชมคนอื่นแก้ไขหรือถูกรีเซ็ตได้ตลอดเวลา
        </div>
      )}
      <Toast message={realtimeToast ?? ""} open={realtimeToast !== null} />
      <div className="min-h-screen bg-canvas-white text-charcoal md:grid md:grid-cols-[72px_1fr] xl:grid-cols-[232px_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col overflow-y-auto border-r border-ash bg-canvas-white px-3 py-4 md:flex">
        <div className="flex items-center gap-2.5 px-1 pb-5 md:justify-center md:px-0 xl:justify-start xl:px-1">
          <Monogram />
          <span className="hidden xl:block">
            <span className="block text-sm font-semibold text-charcoal">หอพักวังจันทร์</span>
            <span className="block text-[0.6875rem] text-fog">ระบบจัดการหอพัก</span>
          </span>
        </div>

        <nav className="grid gap-1" aria-label="เมนูหลัก">
          {routeList.map((item) => (
            <div key={item.id}>
              <NavLink
                route={item.id}
                label={item.label}
                icon={item.icon}
                active={item.id === parsed.route}
                badge={item.id === "review" ? pendingReviewCount : undefined}
              />
              {item.id === "bills" && parsed.route === "bills" && (
                <div className="mt-1 hidden gap-1 pl-6 xl:grid">
                  <a
                    href="#bills/create"
                    aria-current={parsed.view === "create" ? "page" : undefined}
                    className={`flex min-h-9 items-center rounded-lg px-2.5 text-[0.8125rem] no-underline transition-colors ${
                      parsed.view === "create" ? "bg-status-unpaid-bg font-medium text-deep-sapphire" : "text-steel hover:bg-paper-mist"
                    }`}
                  >
                    สร้างบิล
                  </a>
                  <a
                    href="#bills"
                    aria-current={parsed.view === "" ? "page" : undefined}
                    className={`flex min-h-9 items-center rounded-lg px-2.5 text-[0.8125rem] no-underline transition-colors ${
                      parsed.view === "" ? "bg-status-unpaid-bg font-medium text-deep-sapphire" : "text-steel hover:bg-paper-mist"
                    }`}
                  >
                    รายการบิล
                  </a>
                </div>
              )}
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 hidden h-16 items-center gap-4 border-b border-ash bg-canvas-white px-6 md:flex">
          <div className="relative w-full max-w-[480px]">
            <span className="ms pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[1.125rem] text-fog" aria-hidden="true">
              search
            </span>
            <input
              ref={searchRef}
              type="search"
              role="combobox"
              aria-expanded={searchPanelOpen}
              aria-controls="topbar-search-results"
              aria-autocomplete="list"
              aria-activedescendant={searchPanelOpen && activeIndex >= 0 ? searchOptionId(activeIndex) : undefined}
              className="input h-11 pl-10 pr-20"
              placeholder="ค้นหาห้อง, ผู้เช่า, เบอร์โทร..."
              aria-label="ค้นหาห้อง, ผู้เช่า, เบอร์โทร"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPanelDismissed(false);
                setActiveResult(0);
              }}
              onFocus={loadJumpIndex}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  if (searchPanelOpen) {
                    event.preventDefault();
                    setPanelDismissed(true);
                  }

                  return;
                }

                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  if (jumpResults.length === 0) {
                    return;
                  }

                  event.preventDefault();

                  if (!searchPanelOpen) {
                    setPanelDismissed(false);
                    setActiveResult(event.key === "ArrowDown" ? 0 : jumpResults.length - 1);
                    return;
                  }

                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setActiveResult((activeIndex + step + jumpResults.length) % jumpResults.length);
                  return;
                }

                if (event.key === "Enter" && searchPanelOpen) {
                  const choice = jumpResults[activeIndex];

                  if (choice !== undefined) {
                    event.preventDefault();
                    openResult(choice.hash);
                  }
                }
              }}
            />
            {desktopSearch && finePointer && (
              <span className="kbd pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">Ctrl K</span>
            )}

            {searchPanelOpen && (
              <div
                id="topbar-search-results"
                className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 overflow-hidden rounded-xl border border-ash bg-canvas-white py-1 shadow-sm"
              >
                {jumpResults.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-steel">ไม่พบห้องหรือผู้เช่าที่ตรงกับคำค้น</p>
                ) : (
                  <div role="listbox" aria-label="ผลการค้นหาห้องและผู้เช่า">
                    {jumpResults.map((result, index) => (
                      <button
                        key={result.key}
                        id={searchOptionId(index)}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={index === activeIndex}
                        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors ${
                          index === activeIndex ? "bg-paper-mist" : "hover:bg-paper-mist"
                        }`}
                        onMouseEnter={() => {
                          setActiveResult(index);
                        }}
                        onClick={() => {
                          openResult(result.hash);
                        }}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-charcoal">{result.label}</span>
                          <span className="num block truncate text-xs text-fog">{result.detail}</span>
                        </span>
                        <span className="chip shrink-0">{result.kind}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="ml-auto flex items-center gap-3">
            <NotificationButton
              variant="full"
              items={notifications}
              unread={unreadCount(notifications)}
              onOpen={openNotifications}
              onClear={clearAllNotifications}
            />
            <PendingLink className="icon-btn" badge={pendingReviewCount} label="รอตรวจสลิป" />
            <AccountButton variant="full" />
          </div>
        </header>

        <header className="sticky top-0 z-30 flex h-14 items-center gap-2.5 border-b border-ash bg-canvas-white px-4 md:hidden">
          <Monogram />
          <NotificationButton
            variant="icon"
            items={notifications}
            unread={unreadCount(notifications)}
            onOpen={openNotifications}
            onClear={clearAllNotifications}
          />
          <PendingLink className="icon-btn ml-auto h-11 w-11" badge={pendingReviewCount} label="รอตรวจสลิป" />
          <AccountButton variant="icon" />
        </header>

        <main
          ref={mainRef}
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1400px] px-4 pb-28 pt-5 md:px-6 md:pb-12 md:pt-6"
        >
          <ErrorBoundary resetKey={`${parsed.route}/${parsed.view}`}>
            <Suspense fallback={<RouteFallback />}>
              <Page view={parsed.view} />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-ash bg-canvas-white md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="เมนูหลัก"
      >
        {mobileTabs.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            aria-current={item.id === parsed.route ? "page" : undefined}
            className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[0.6875rem] no-underline ${
              item.id === parsed.route ? "text-deep-sapphire" : "text-fog"
            }`}
          >
            <span className={item.id === parsed.route ? "ms fill text-[1.375rem]" : "ms text-[1.375rem]"} aria-hidden="true">
              {item.icon}
            </span>
            {item.label}
          </a>
        ))}
        <button
          type="button"
          onClick={openMore}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-current={moreActive ? "page" : undefined}
          className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[0.6875rem] ${moreActive ? "text-deep-sapphire" : "text-fog"}`}
        >
          <span className={moreActive ? "ms fill text-[1.375rem]" : "ms text-[1.375rem]"} aria-hidden="true">
            more_horiz
          </span>
          เพิ่มเติม
        </button>
      </nav>

      <dialog
        ref={moreRef}
        className="sheet"
        aria-label="เมนูเพิ่มเติม"
        onCancel={(event) => {
          event.preventDefault();
          closeMore();
        }}
        onClick={(event) => {
          if (event.target === moreRef.current) {
            closeMore();
          }
        }}
      >
        <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-smoke" aria-hidden="true" />
        <nav className="grid gap-1 px-4 pb-4 pt-3" aria-label="เมนูเพิ่มเติม">
          {moreItems.map((item) => (
            <a
              key={item.route}
              href={`#${item.route}`}
              onClick={closeMore}
              aria-current={item.route === parsed.route ? "page" : undefined}
              className={`flex min-h-12 items-center gap-3 rounded-lg px-3 text-sm no-underline ${
                item.route === parsed.route ? "bg-status-unpaid-bg text-deep-sapphire" : "text-charcoal hover:bg-paper-mist"
              }`}
            >
              <span className="ms text-[1.25rem]" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
              {item.route === "review" && pendingReviewCount > 0 && (
                <span className="num ml-auto rounded-full bg-status-review-bg px-2 py-0.5 text-[0.6875rem] font-medium text-status-review-fg">
                  {pendingReviewCount}
                </span>
              )}
            </a>
          ))}
        </nav>
      </dialog>
    </div>
    </>
  );
}

export default function App() {
  return (
    <SearchProvider>
      <Shell />
    </SearchProvider>
  );
}
