/**
 * ข้อความ "บิลถูกปิด" ที่รับมาทาง WebSocket
 *
 * ประกาศไว้ที่นี่ (โมดูลข้อมูลล้วน) ไม่ใช่ใน `realtime.ts` เพราะ `realtime.ts`
 * แตะ `window`/`document` — ถ้าโมดูลนี้ import ประเภทจากที่นั่น ไฟล์ฝั่ง DOM จะ
 * ถูกดึงเข้า tsconfig ของ worker (ซึ่งไม่มี lib DOM) แล้ว typecheck พังทั้งที่
 * โค้ดฝั่ง worker ไม่ได้เกี่ยวข้องอะไรด้วย
 */
export interface BillPaidNotice {
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
 * `source` แยกสองทางนี้เพราะความหมายต่อเจ้าของต่างกัน: `self` คือคนที่เจ้าของ
 * ยังไม่รู้จัก (ต้องเข้าไปดูว่าตั้งค่าไว้ถูกไหม) ส่วน `owner` คือคนที่เจ้าของ
 * เพิ่มเข้าไปเองแล้ว (แค่ยืนยันว่าเชื่อมติด)
 */
export interface TenantJoinedNotice {
  tenantId: string;
  roomNumber: string;
  tenantName: string;
  source: "self" | "owner";
  joinedAt: string;
}

/**
 * รายการแจ้งเตือนในกระดิ่ง — ประวัติจริงอยู่ที่เซิร์ฟเวอร์ (ตาราง notifications, migration 0014)
 *
 * สองชนิดเท่านั้น: บิลถูกปิด กับ ผู้เช่าใหม่ — ใช้ discriminated union เพื่อให้
 * การเพิ่มชนิดที่สามในอนาคตบังคับให้ TypeScript ชี้ทุกจุดที่ต้องแก้ (ตัว render
 * ข้อความ/ไอคอน/ลิงก์) แทนที่จะเงียบ ๆ ตกหล่น
 *
 * เซิร์ฟเวอร์บันทึกเหตุการณ์ตอนที่มันเกิด ไม่ว่าจะมีเบราว์เซอร์เปิดอยู่หรือไม่ หน้าเว็บอ่านรายการมา
 * ตอนเปิดหน้า ตอนเหตุการณ์สดเข้ามาทาง WebSocket ตอนต่อ socket ใหม่ และตอนกลับมาที่แท็บ
 * (เดิมเก็บแต่ในหน่วยความจำของแท็บจึงหายเมื่อรีเฟรช และไม่เคยรู้เรื่องที่เกิดตอนปิดเบราว์เซอร์)
 * สถานะอ่าน/ล้างเป็นรายผู้ใช้ และเก็บที่เซิร์ฟเวอร์เช่นกัน
 */
export interface BillPaidNotification {
  kind: "bill-paid";
  /** บิลใบหนึ่งถูกปิดได้ครั้งเดียว — ใช้ billId กันรายการซ้ำได้เอง */
  id: string;
  billId: string;
  roomNumber: string;
  tenantName: string;
  period: string;
  total: number;
  methodLabel: string;
  /** ISO string */
  paidAt: string;
  read: boolean;
}

export interface TenantJoinedNotification {
  kind: "tenant-joined";
  /** ผู้เช่าหนึ่งคนเข้าได้ครั้งเดียว (ลงทะเบียน/เชื่อม) — ใช้ tenantId กันซ้ำ */
  id: string;
  tenantId: string;
  roomNumber: string;
  tenantName: string;
  source: "self" | "owner";
  /** ISO string */
  joinedAt: string;
  read: boolean;
}

export type AppNotification = BillPaidNotification | TenantJoinedNotification;

export function notificationOf(notice: BillPaidNotice): BillPaidNotification {
  return {
    kind: "bill-paid",
    id: notice.billId,
    billId: notice.billId,
    roomNumber: notice.roomNumber,
    tenantName: notice.tenantName,
    period: notice.period,
    total: notice.total,
    methodLabel: notice.methodLabel,
    paidAt: notice.paidAt,
    read: false,
  };
}

export function tenantJoinedNotificationOf(
  notice: TenantJoinedNotice,
): TenantJoinedNotification {
  return {
    kind: "tenant-joined",
    id: notice.tenantId,
    tenantId: notice.tenantId,
    roomNumber: notice.roomNumber,
    tenantName: notice.tenantName,
    source: notice.source,
    joinedAt: notice.joinedAt,
    read: false,
  };
}

/** กุญแจกันซ้ำในแผง: ชนิด + id (id ของสองชนิดเป็นคนละเนมสเปซโดยความหมายแม้จะเป็น UUID เหมือนกัน) */
function dedupeKey(item: AppNotification): string {
  return `${item.kind}:${item.id}`;
}

/** จำนวนที่ยังไม่ได้อ่าน — ตัวเลขบนปุ่มกระดิ่ง */
export function unreadCount(list: readonly AppNotification[]): number {
  return list.reduce((total, item) => (item.read ? total : total + 1), 0);
}

/** ทำเครื่องหมายว่าอ่านแล้วทั้งหมด (ตอนเปิดแผง) */
export function markAllRead(list: readonly AppNotification[]): AppNotification[] {
  return list.map((item) => (item.read ? item : { ...item, read: true }));
}

/**
 * ข้อความบรรทัดเดียวที่ผู้ใช้เห็น — ใช้ทั้งบน toast และในแผง
 *
 * อยู่ที่นี่ที่เดียวเพื่อให้ทั้งสองที่ไม่พูดไม่ตรงกัน
 */
export function notificationText(item: AppNotification): string {
  if (item.kind === "tenant-joined") {
    return `ห้อง ${item.roomNumber} มีผู้เช่าใหม่ ${item.tenantName}`;
  }

  return `ห้อง ${item.roomNumber} ชำระแล้ว ${item.total.toLocaleString("en-US")} บาท`;
}

/** บรรทัดรองในแผง — บอกรายละเอียดที่ข้อความหลักไม่มีที่พอ */
export function notificationDetail(item: AppNotification): string {
  if (item.kind === "tenant-joined") {
    return item.source === "owner" ? "เชื่อม LINE ให้แล้ว" : "ลงทะเบียนเองผ่าน LINE";
  }

  return `${item.tenantName} · ${item.methodLabel} · ${notificationWhen(item.paidAt)}`;
}

/** ไอคอน Material Symbols ของแต่ละชนิด */
export function notificationIcon(item: AppNotification): string {
  return item.kind === "tenant-joined" ? "person_add" : "check_circle";
}

/**
 * ลิงก์ไปดูของจริง
 *
 * ผู้เช่าไม่มีหน้าของตัวเองให้เปิดตรง ๆ (รายชื่อผู้เช่าอยู่ในหน้าเดียวกับห้อง)
 * จึงพาไปที่หน้ารายชื่อผู้เช่า ส่วนบิลเปิดได้ตรงใบเพราะมี id กับรอบบิล
 */
export function notificationHref(item: AppNotification): string {
  if (item.kind === "tenant-joined") {
    return "#tenants";
  }

  return `#bills/detail/${encodeURIComponent(item.billId)}?period=${encodeURIComponent(item.period)}`;
}

/** เวลาที่แสดงในแผง — ใช้เวลาท้องถิ่นของเครื่อง ไม่ต้องแปลงเขตเวลาเอง */
export function notificationTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * เวลาของรายการในแผง — วันเดียวกับวันนี้แสดงแค่เวลา วันอื่นแสดงวันที่นำหน้า
 *
 * ประวัติอยู่ข้ามวันแล้ว (เก็บไว้หลังรีเฟรช) เวลาล้วน ๆ ของรายการเมื่อวานจึงอ่านเป็นของวันนี้ได้
 */
export function notificationWhen(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  const time = notificationTime(value);

  if (time === "") {
    return "";
  }

  if (date.toDateString() === now.toDateString()) {
    return time;
  }

  const day = date.toLocaleDateString("th-TH", { day: "numeric", month: "short" });

  return `${day} ${time}`;
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * แปลงหนึ่งแถวจากเซิร์ฟเวอร์เป็นรายการในแผง — รับเฉพาะที่ครบรูปจริง
 *
 * เซิร์ฟเวอร์เก็บ payload ตามรูปของเหตุการณ์ ณ วันที่เขียน แถวเก่าหรือแถวเสียต้องไม่ทำให้แผง
 * แสดง NaN/undefined หรือล่มทั้งแอป จึงข้ามเฉพาะแถวนั้น
 */
function notificationFromRow(row: Record<string, unknown>): AppNotification | null {
  const notice = typeof row.notice === "object" && row.notice !== null ? (row.notice as Record<string, unknown>) : null;

  if (notice === null || !isText(notice.roomNumber) || !isText(notice.tenantName)) {
    return null;
  }

  const read = row.read === true;

  if (row.kind === "bill-paid") {
    if (
      !isText(notice.billId) ||
      !isText(notice.period) ||
      typeof notice.total !== "number" ||
      !Number.isFinite(notice.total) ||
      !isText(notice.methodLabel) ||
      !isText(notice.paidAt)
    ) {
      return null;
    }

    return {
      ...notificationOf({
        billId: notice.billId,
        roomNumber: notice.roomNumber,
        tenantName: notice.tenantName,
        period: notice.period,
        total: notice.total,
        methodLabel: notice.methodLabel,
        paidAt: notice.paidAt,
      }),
      read,
    };
  }

  if (row.kind === "tenant-joined") {
    if (
      !isText(notice.tenantId) ||
      (notice.source !== "self" && notice.source !== "owner") ||
      !isText(notice.joinedAt)
    ) {
      return null;
    }

    return {
      ...tenantJoinedNotificationOf({
        tenantId: notice.tenantId,
        roomNumber: notice.roomNumber,
        tenantName: notice.tenantName,
        source: notice.source,
        joinedAt: notice.joinedAt,
      }),
      read,
    };
  }

  return null;
}

/**
 * รายการที่เซิร์ฟเวอร์ส่งมา (ใหม่สุดก่อน) -> รายการในแผง + ลำดับล่าสุดที่เห็น
 *
 * `newestSeq` คือค่าที่ต้องส่งกลับตอนกดอ่าน/ล้าง เพื่อบอกว่า "ถึงรายการที่ฉันเห็นแล้ว" — เหตุการณ์
 * ที่เข้ามาหลังจากนั้นจึงไม่ถูกนับว่าอ่าน/ล้างไปด้วย นับจากทุกแถวรวมแถวที่แสดงไม่ได้ ไม่งั้นแถวเสีย
 * จะค้างเป็น "ยังไม่อ่าน" ตลอดไป
 */
export function notificationsFromServer(rows: unknown): { items: AppNotification[]; newestSeq: number } {
  const items: AppNotification[] = [];
  const seen = new Set<string>();
  let newestSeq = 0;

  if (!Array.isArray(rows)) {
    return { items, newestSeq };
  }

  for (const entry of rows) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const row = entry as Record<string, unknown>;

    if (typeof row.seq === "number" && Number.isInteger(row.seq)) {
      newestSeq = Math.max(newestSeq, row.seq);
    }

    const item = notificationFromRow(row);

    if (item === null || seen.has(dedupeKey(item))) {
      continue;
    }

    seen.add(dedupeKey(item));
    items.push(item);
  }

  return { items, newestSeq };
}
