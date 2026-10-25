import { DurableObject } from "cloudflare:workers";

/** ซองข้อความเดียวที่ทุก event ใช้ร่วมกัน — ขยาย type ใหม่ได้โดยไม่แก้ client เก่า */
export interface RealtimeHello {
  v: 1;
  type: "hello";
  connectionId: string;
}

export interface RealtimeBillPaid {
  v: 1;
  type: "bill-paid";
  billId: string;
  roomNumber: string;
  tenantName: string;
  period: string;
  total: number;
  methodLabel: string;
  paidAt: string;
}

/**
 * ผู้เช่าใหม่เข้าระบบ — ลงทะเบียนเองผ่าน LIFF หรือเจ้าของกดเชื่อม LINE ให้
 *
 * `source` แยกสองทางนี้เพราะความหมายต่อเจ้าของต่างกัน: "ลงทะเบียน" คือคนที่
 * เจ้าของยังไม่รู้จัก (`self`) ส่วน "เชื่อม LINE" คือคนที่เจ้าของเพิ่มเข้าไปเอง
 * แล้ว (`owner`) การขึ้นข้อความเหมือนกันทั้งสองทางจะชวนให้สับสน
 */
export interface RealtimeTenantJoined {
  v: 1;
  type: "tenant-joined";
  tenantId: string;
  roomNumber: string;
  tenantName: string;
  source: "self" | "owner";
  joinedAt: string;
}

export type RealtimeEnvelope = RealtimeHello | RealtimeBillPaid | RealtimeTenantJoined;

interface ConnectionState {
  connectionId: string;
}

/**
 * หนึ่งครอบครัวหนึ่ง instance — เก็บเฉพาะ socket ที่ยังเปิดอยู่ ไม่มี state ถาวร
 *
 * ไม่มี replay buffer โดยตั้งใจ: ข้อความที่ส่งตอนไม่มีแท็บเปิดอยู่จะหายไป
 * ฝั่งเว็บถือว่าการต่อกลับมา (event `onopen` หลังเคยเปิดสำเร็จ) คือสัญญาณให้
 * โหลดข้อมูลหน้าใหม่หนึ่งครั้ง จึงไม่ต้องเก็บประวัติไว้กู้คืน
 */
export class FamilyRealtime extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // ตอบ ping โดยไม่ปลุก DO ที่กำลัง hibernate
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ไม่ใช้ request เลย: route /api/realtime ตรวจ upgrade, origin และ session
  // มาแล้วก่อนถึงตรงนี้ DO จึงมีงานเดียวคือรับ socket ใหม่เข้า pool
  override fetch(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const connectionId = crypto.randomUUID();

    // acceptWebSocket (ไม่ใช่ server.accept()) เพื่อให้ DO hibernation ได้
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connectionId } satisfies ConnectionState);
    server.send(JSON.stringify({ v: 1, type: "hello", connectionId } satisfies RealtimeHello));

    return new Response(null, { status: 101, webSocket: client });
  }

  /** ส่งให้ทุก socket ยกเว้นแท็บที่เป็นคนสั่งเอง (กัน toast ซ้ำ) */
  broadcast(payload: string, excludeConnectionId: string | null): number {
    let sent = 0;

    for (const socket of this.ctx.getWebSockets()) {
      const state = socket.deserializeAttachment() as ConnectionState | null;

      if (state !== null && state.connectionId === excludeConnectionId) {
        continue;
      }

      try {
        socket.send(payload);
        sent += 1;
      } catch (error) {
        // socket ที่ตายแล้วต้องไม่ล้มทั้ง loop
        console.error(
          JSON.stringify({
            message: "realtime send failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }

    return sent;
  }

  override webSocketMessage(): void {
    // "ping" ถูกตอบอัตโนมัติด้วย WebSocketRequestResponsePair แล้ว
    // ข้อความอื่นจาก client ไม่มีความหมาย ไม่ต้องทำอะไร
  }
}
