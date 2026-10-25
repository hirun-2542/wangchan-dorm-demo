import { setRealtimeConnectionId } from "./api";
import type { BillPaidNotice, TenantJoinedNotice } from "./notifications";

// ชนิดข้อมูลอยู่ที่ notifications.ts (โมดูลข้อมูลล้วน) แล้ว re-export ให้ผู้เรียกเดิม
export type { BillPaidNotice, TenantJoinedNotice } from "./notifications";

export interface RealtimeHandlers {
  onBillPaid: (notice: BillPaidNotice) => void;
  onTenantJoined: (notice: TenantJoinedNotice) => void;
  /** ต่อกลับมาได้หลังหลุด — ข้อมูลหน้าจออาจค้าง ต้องโหลดใหม่หนึ่งครั้ง */
  onReconnected: () => void;
}

/**
 * หน่วงก่อนลองต่อใหม่ ไล่ทีละขั้นแล้วค้างที่ขั้นสุดท้าย
 *
 * เพดาน 30 วินาทีคือค่าที่ตั้งใจให้ไกลพอไม่ให้รบกวน log ของ worker ที่ปิดอยู่
 * แต่ใกล้พอที่แท็บที่เปิดค้างไว้ทั้งวันจะกลับมาต่อเองได้เร็วหลัง deploy
 */
const backoffStepsMs = [1000, 2000, 4000, 8000, 30000];

/** จังหวะ ping — คู่กับ WebSocketAutoResponse ฝั่ง Durable Object ที่ตอบ "pong" เอง */
const pingIntervalMs = 30_000;

function realtimeUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";

  return `${scheme}//${location.host}/api/realtime`;
}

function billPaidNoticeOf(value: unknown): BillPaidNotice | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.billId !== "string" ||
    typeof record.roomNumber !== "string" ||
    typeof record.tenantName !== "string" ||
    typeof record.period !== "string" ||
    typeof record.total !== "number" ||
    typeof record.methodLabel !== "string" ||
    typeof record.paidAt !== "string"
  ) {
    return null;
  }

  return {
    billId: record.billId,
    roomNumber: record.roomNumber,
    tenantName: record.tenantName,
    period: record.period,
    total: record.total,
    methodLabel: record.methodLabel,
    paidAt: record.paidAt,
  };
}

/**
 * ผู้เช่าใหม่ — ตรวจชนิดให้ครบก่อนใช้ ไม่เชื่อ payload ตรง ๆ
 *
 * `source` ต้องเป็นค่าที่รู้จักเท่านั้น ถ้าไม่ใช่ให้ปฏิเสธทั้งข้อความ ดีกว่าจะ
 * เดาเป็น "self" แล้วขึ้นข้อความผิดความหมายให้เจ้าของอ่าน
 */
function tenantJoinedNoticeOf(value: unknown): TenantJoinedNotice | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.tenantId !== "string" ||
    typeof record.roomNumber !== "string" ||
    typeof record.tenantName !== "string" ||
    typeof record.joinedAt !== "string" ||
    (record.source !== "self" && record.source !== "owner")
  ) {
    return null;
  }

  return {
    tenantId: record.tenantId,
    roomNumber: record.roomNumber,
    tenantName: record.tenantName,
    source: record.source,
    joinedAt: record.joinedAt,
  };
}

/**
 * เปิด WebSocket ค้างไว้หนึ่งเส้นต่อแท็บ และต่อใหม่เองเมื่อหลุด
 *
 * ไม่มี replay: ข้อความที่หลุดตอน socket ปิดจะหายไป ฝั่งเว็บจึงถือว่า
 * "ต่อกลับมา" คือสัญญาณให้โหลดข้อมูลหน้าใหม่ ไม่ใช่รอข้อความที่ตกหล่น
 */
export function startRealtime(handlers: RealtimeHandlers): () => void {
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let pingTimer: number | null = null;
  let stepIndex = 0;
  let everOpened = false;
  let stopped = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearPingTimer = () => {
    if (pingTimer !== null) {
      window.clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const connect = () => {
    if (stopped) {
      return;
    }

    clearReconnectTimer();

    const next = new WebSocket(realtimeUrl());
    socket = next;

    next.addEventListener("open", () => {
      if (stopped) {
        return;
      }

      stepIndex = 0;

      pingTimer = window.setInterval(() => {
        if (next.readyState === WebSocket.OPEN) {
          next.send("ping");
        }
      }, pingIntervalMs);

      if (everOpened) {
        handlers.onReconnected();
      }

      everOpened = true;
    });

    next.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") {
        return;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(event.data);
      } catch {
        // "pong" ของ auto-response ไม่ใช่ JSON — ไม่ใช่ความผิดพลาด
        return;
      }

      if (typeof parsed !== "object" || parsed === null) {
        return;
      }

      const record = parsed as Record<string, unknown>;

      if (record.type === "hello" && typeof record.connectionId === "string") {
        setRealtimeConnectionId(record.connectionId);
        return;
      }

      if (record.type === "bill-paid") {
        const notice = billPaidNoticeOf(record);

        if (notice !== null) {
          handlers.onBillPaid(notice);
        }

        return;
      }

      if (record.type === "tenant-joined") {
        const notice = tenantJoinedNoticeOf(record);

        if (notice !== null) {
          handlers.onTenantJoined(notice);
        }
      }
    });

    const scheduleReconnect = () => {
      if (stopped) {
        return;
      }

      setRealtimeConnectionId(null);
      clearPingTimer();

      const delay = backoffStepsMs[Math.min(stepIndex, backoffStepsMs.length - 1)] ?? backoffStepsMs[0];
      stepIndex += 1;

      clearReconnectTimer();
      reconnectTimer = window.setTimeout(connect, delay);
    };

    /**
     * การเชื่อมต่อที่ล้มเหลวยิงทั้ง "error" และ "close" — ถ้าปล่อยให้ทั้งคู่
     * ตั้งเวลาใหม่ backoff จะไต่ขึ้นสองขั้นต่อการล้มหนึ่งครั้ง (ถึงเพดาน 30 วินาที
     * ภายในไม่กี่ครั้ง) จึงปิดประตูหลังเหตุการณ์แรกของ socket นี้
     */
    let settled = false;

    const onDisconnected = () => {
      if (settled) {
        return;
      }

      settled = true;
      scheduleReconnect();
    };

    next.addEventListener("close", onDisconnected);
    next.addEventListener("error", () => {
      // error อาจมาก่อน close หรือมาหลัง (readyState เป็น CLOSED แล้ว) —
      // ปิด socket ให้แน่ใจว่าไม่ค้างกึ่งกลาง แล้วให้ onDisconnected ตัดสินครั้งเดียว
      if (next.readyState !== WebSocket.CLOSED) {
        next.close();
      }

      onDisconnected();
    });
  };

  /**
   * กลับมาเปิดแท็บแล้ว socket ไม่ได้เปิดอยู่ = สัญญาณว่าเบราว์เซอร์อาจตัดการ
   * เชื่อมต่อทิ้งตอนอยู่เบื้องหลัง จึงต่อใหม่ทันที ไม่รอ backoff ที่อาจยาว 30 วินาที
   */
  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible" || stopped) {
      return;
    }

    if (socket !== null && socket.readyState !== WebSocket.CLOSED) {
      return;
    }

    stepIndex = 0;
    connect();
  };

  connect();
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    stopped = true;
    clearReconnectTimer();
    clearPingTimer();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    setRealtimeConnectionId(null);

    if (socket !== null) {
      const closing = socket;
      socket = null;
      closing.close();
    }
  };
}
