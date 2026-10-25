import { useEffect, useId, useRef, useState, type FocusEvent } from "react";
import {
  notificationDetail,
  notificationHref,
  notificationIcon,
  notificationText,
  type AppNotification,
} from "./notifications";

export interface NotificationButtonProps {
  /** full = จอใหญ่ · icon = จอเล็กในแถบบน */
  variant: "full" | "icon";
  items: readonly AppNotification[];
  /** จำนวนที่ยังไม่อ่าน — แสดงเป็นตัวเลขบนปุ่ม */
  unread: number;
  /** เปิดแผงแล้ว ถือว่าอ่านทั้งหมด */
  onOpen: () => void;
  /** ล้างรายการทั้งหมด */
  onClear: () => void;
}

/**
 * ปุ่มแจ้งเตือนบนแถบบน + แผงรายการที่ผูกกับปุ่ม
 *
 * เป็นแผงแบบเดียวกับเมนูบัญชี (`account.tsx`) ไม่ใช่ modal เพราะรายการเหล่านี้
 * เป็น "ข่าวที่เพิ่งเข้ามา" ไม่ใช่คำถามที่ต้องตอบ — บังคับให้กดปิดก่อนทำงานต่อ
 * จะรบกวนคนที่กำลังทำอย่างอื่นอยู่
 *
 * ปุ่มนี้ถูกออกแบบไว้ใน `design/index.html` ตั้งแต่ต้นแต่ยังไม่มีอะไรอยู่ข้างหลัง
 * ตอนนี้ทำหน้าที่เป็นที่เก็บรายการที่ก่อนหน้านี้โผล่เป็น toast แล้วหายไปใน 5 วินาที
 * — ใครที่ไม่ได้จ้องจอตอนนั้นจะไม่พลาดอีก
 */
export function NotificationButton({
  variant,
  items,
  unread,
  onOpen,
  onClear,
}: NotificationButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  /**
   * ปิดเมื่อคลิกที่อื่นหรือกด Esc — เช็คจาก wrapper ไม่ใช่จากแผง
   *
   * เหตุผลเดียวกับเมนูบัญชี: ปุ่มเปิดก็ต้องไม่นับเป็น "ที่อื่น" ไม่งั้น
   * pointerdown จะปิดแผงก่อน แล้ว click ของปุ่มจะเปิดมันกลับมาทันที
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

  // โฟกัสเข้าแผงเมื่อเปิด เพื่อให้โปรแกรมอ่านหน้าจออ่านรายการก่อน แล้ว Tab ต่อได้
  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    }
  }, [open]);

  /** ปิดเมื่อโฟกัสออกจากทั้งปุ่มและแผง ไม่ให้แผงลอยค้างโดยไม่รู้ว่าโฟกัสอยู่ไหน */
  const closeWhenFocusLeaves = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) {
      return;
    }

    setOpen(false);
  };

  const label =
    unread > 0 ? `แจ้งเตือน ${unread} รายการที่ยังไม่ได้อ่าน` : "แจ้งเตือน";

  return (
    <div className="relative" ref={wrapperRef} onBlur={closeWhenFocusLeaves}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          const next = !open;

          setOpen(next);

          if (next) {
            onOpen();
          }
        }}
        className="icon-btn h-11 w-11"
      >
        <span className="ms text-[1.25rem]" aria-hidden="true">
          {unread > 0 ? "notifications_active" : "notifications"}
        </span>
        {unread > 0 && (
          <span className="num absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-status-unpaid-bg px-1 text-[0.6875rem] font-medium text-status-unpaid-fg">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          id={panelId}
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-label="แจ้งเตือน"
          className={`z-40 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-ash bg-canvas-white shadow-sm ${
            /**
             * จอใหญ่: ปุ่มอยู่ชิดขวา จึงยึดแผงกับขอบขวาของปุ่มแบบ dropdown
             *
             * จอเล็ก: ปุ่มอยู่ซ้ายถัดจากโลโก้ การยึดกับปุ่มไม่ว่าซ้ายหรือขวาจะล้น
             * ออกนอกจอ (ลองแล้วทั้งสองทาง) จึงยึดกับ **ขอบจอ** แทน — กว้างเท่าจอ
             * ลบระยะขอบทั้งสองข้าง จึงไม่มีทางล้นไม่ว่าปุ่มจะอยู่ตรงไหน
             */
            variant === "icon"
              ? "fixed left-3 right-3 top-[3.75rem] w-auto"
              : "absolute right-0 top-[calc(100%+6px)]"
          }`}
        >
          <div className="flex items-center justify-between gap-3 border-b border-ash px-4 py-3">
            <p className="text-[0.8125rem] font-semibold text-charcoal">แจ้งเตือน</p>
            {items.length > 0 && (
              <button
                type="button"
                className="-m-2 min-h-11 p-2 text-[0.75rem] text-electric-blue underline underline-offset-2 md:min-h-0"
                onClick={onClear}
              >
                ล้างทั้งหมด
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-[0.8125rem] text-fog">
              ยังไม่มีการแจ้งเตือน
              <span className="mt-1 block text-[0.75rem]">
                เมื่อมีผู้เช่าชำระเงิน รายการจะขึ้นที่นี่
              </span>
            </p>
          ) : (
            <ul className="max-h-[min(24rem,60vh)] overflow-y-auto p-1.5">
              {items.map((item) => (
                <li key={item.id}>
                  <a
                    href={notificationHref(item)}
                    onClick={() => {
                      // ปิดแผงเมื่อออกไปดู ไม่งั้นมันค้างทับหน้าที่เพิ่งเปิดมา
                      setOpen(false);
                    }}
                    className="flex items-start gap-2.5 rounded-lg px-3 py-2.5 no-underline transition-colors hover:bg-paper-mist"
                  >
                    <span
                      className={`ms mt-0.5 text-[1.125rem] ${
                        item.read
                          ? "text-silver"
                          : item.kind === "tenant-joined"
                            ? "text-electric-blue"
                            : "text-status-paid-fg"
                      }`}
                      aria-hidden="true"
                    >
                      {notificationIcon(item)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[0.8125rem] text-charcoal">
                        {notificationText(item)}
                      </span>
                      <span className="mt-0.5 block truncate text-[0.6875rem] text-fog">
                        {notificationDetail(item)}
                      </span>
                    </span>
                    {!item.read && (
                      <span
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-electric-blue"
                        aria-label="ยังไม่ได้อ่าน"
                      />
                    )}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
