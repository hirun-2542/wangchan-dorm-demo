export interface LineProfile {
  userId: string;
  displayName: string;
}

export type LineOutboundMessage = { type: string; [key: string]: unknown };

export interface LineContent {
  bytes: ArrayBuffer;
  contentType: string;
}

const lineApiBase = "https://api.line.me/v2/bot";

const lineDataBase = "https://api-data.line.me/v2/bot";

const maxImageContentBytes = 5 * 1024 * 1024;

const allowedImageContentTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * ทุกคำขอออกนอก Worker ต้องมีเพดานเวลา ไม่งั้น LINE หรือ SlipOK ที่ค้าง
 * จะลากคำขอของผู้ใช้ไปด้วยจนหมดเวลาของแพลตฟอร์ม
 */
export const lineOutboundTimeoutMs = 10_000;

/** อ่านรูปสลิปและส่งไฟล์ให้ผู้ให้บริการตรวจใช้เวลานานกว่าคำขอทั่วไป */
export const lineUploadTimeoutMs = 20_000;

/**
 * ช่อง LINE หนึ่งช่องเป็นของครอบครัวเดียว เพราะ secret และ token เป็นค่า
 * ระดับ Worker บันทึกไว้ที่ meta.line_family_id ตั้งแต่ migration 0010
 *
 * คืน null เมื่อยังไม่กำหนด เพื่อให้ผู้เรียกปฏิเสธงานแทนที่จะเดาครอบครัว
 */
export async function lineFamilyId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'line_family_id'").first<{ value: string }>();
  const value = typeof row?.value === "string" ? row.value.trim() : "";

  return value === "" ? null : value;
}

export function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logLineFailure(message: string, detail: string): void {
  console.error(JSON.stringify({ message, error: detail }));
}

/**
 * ตรวจตรงตัวเหมือน SEAM_PROBE — ปิดเป็นค่าเริ่มต้นเสมอ เปิดเฉพาะเมื่อ DEMO_MODE
 * เป็น "1" เท่านั้น ใช้เป็นการ์ดชั้นแรกก่อนถึงคีย์ในทุกจุดที่เรียกออกนอกระบบจริง
 * ไม่พึ่งการที่คีย์ LINE/SlipOK ถูกเว้นว่างเพียงอย่างเดียว เพราะคีย์ที่ตั้งไว้
 * ผิดที่บนสภาพแวดล้อมเดโม (เช่น copy จาก production มาผิด) ต้องไม่ทำให้ยิงออกจริง
 */
export function demoModeOn(env: Env): boolean {
  return String(env.DEMO_MODE) === "1";
}

function accessToken(env: Env): string {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  return typeof token === "string" ? token.trim() : "";
}

export function lineChannelConfigured(env: Env): boolean {
  return accessToken(env) !== "";
}

export async function replyMessage(env: Env, replyToken: string, message: LineOutboundMessage): Promise<void> {
  if (demoModeOn(env)) {
    logLineFailure("line reply skipped", "demo mode: outbound disabled");
    return;
  }

  const token = accessToken(env);

  if (token === "") {
    logLineFailure("line reply skipped", "LINE_CHANNEL_ACCESS_TOKEN is not configured");
    return;
  }

  if (replyToken === "") {
    logLineFailure("line reply skipped", "reply token is empty");
    return;
  }

  try {
    const response = await fetch(`${lineApiBase}/message/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ replyToken, messages: [message] }),
      signal: AbortSignal.timeout(lineOutboundTimeoutMs),
    });

    if (!response.ok) {
      logLineFailure("line reply failed", `status ${String(response.status)}`);
    }
  } catch (error) {
    logLineFailure("line reply failed", failureDetail(error));
  }
}

export async function pushMessage(env: Env, to: string, messages: readonly LineOutboundMessage[]): Promise<true | null> {
  if (demoModeOn(env)) {
    logLineFailure("line push skipped", "demo mode: outbound disabled");
    return null;
  }

  const token = accessToken(env);

  if (token === "") {
    logLineFailure("line push skipped", "LINE_CHANNEL_ACCESS_TOKEN is not configured");
    return null;
  }

  if (to === "") {
    logLineFailure("line push skipped", "target user id is empty");
    return null;
  }

  try {
    const response = await fetch(`${lineApiBase}/message/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages }),
      signal: AbortSignal.timeout(lineOutboundTimeoutMs),
    });

    if (!response.ok) {
      logLineFailure("line push failed", `status ${String(response.status)}`);
      return null;
    }

    return true;
  } catch (error) {
    logLineFailure("line push failed", failureDetail(error));
    return null;
  }
}

/** อ่านเนื้อหาคำตอบตามเพดานไบต์ระหว่างทาง (ใช้ร่วมกับ PEA) */
export async function readBodyWithin(response: Response, limit: number): Promise<ArrayBuffer | null> {
  const body = response.body;

  if (body === null) {
    return null;
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (value === undefined) {
      continue;
    }

    total += value.byteLength;

    if (total > limit) {
      await reader.cancel();
      return null;
    }

    chunks.push(value);
  }

  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer;
}

export async function fetchMessageContent(env: Env, messageId: string): Promise<LineContent | null> {
  if (demoModeOn(env)) {
    logLineFailure("line content skipped", "demo mode: outbound disabled");
    return null;
  }

  const token = accessToken(env);

  if (token === "") {
    logLineFailure("line content skipped", "LINE_CHANNEL_ACCESS_TOKEN is not configured");
    return null;
  }

  if (messageId === "") {
    logLineFailure("line content skipped", "message id is empty");
    return null;
  }

  try {
    const response = await fetch(`${lineDataBase}/message/${encodeURIComponent(messageId)}/content`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(lineUploadTimeoutMs),
    });

    if (!response.ok) {
      logLineFailure("line content failed", `status ${String(response.status)}`);
      return null;
    }

    const header = response.headers.get("content-type") ?? "";
    const contentType = header.split(";")[0]?.trim().toLowerCase() ?? "";

    if (!allowedImageContentTypes.has(contentType)) {
      logLineFailure("line content failed", `unexpected content type ${contentType === "" ? "unknown" : contentType}`);
      return null;
    }

    const declared = response.headers.get("content-length");

    if (declared !== null) {
      const size = Number.parseInt(declared, 10);

      if (Number.isFinite(size) && size > maxImageContentBytes) {
        logLineFailure("line content failed", `content length ${String(size)} exceeds ${String(maxImageContentBytes)} bytes`);
        return null;
      }
    }

    const bytes = await readBodyWithin(response, maxImageContentBytes);

    if (bytes === null) {
      logLineFailure("line content failed", `content body exceeds ${String(maxImageContentBytes)} bytes`);
      return null;
    }

    if (bytes.byteLength === 0) {
      logLineFailure("line content failed", "content body is empty");
      return null;
    }

    return { bytes, contentType };
  } catch (error) {
    logLineFailure("line content failed", failureDetail(error));
    return null;
  }
}

export async function fetchProfile(env: Env, userId: string): Promise<LineProfile | null> {
  if (demoModeOn(env)) {
    logLineFailure("line profile skipped", "demo mode: outbound disabled");
    return null;
  }

  const token = accessToken(env);

  if (token === "") {
    logLineFailure("line profile skipped", "LINE_CHANNEL_ACCESS_TOKEN is not configured");
    return null;
  }

  try {
    const response = await fetch(`${lineApiBase}/profile/${encodeURIComponent(userId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(lineOutboundTimeoutMs),
    });

    if (!response.ok) {
      logLineFailure("line profile failed", `status ${String(response.status)}`);
      return null;
    }

    const body = await response.json<{ displayName?: string }>();
    return { userId, displayName: typeof body.displayName === "string" ? body.displayName : "" };
  } catch (error) {
    logLineFailure("line profile failed", failureDetail(error));
    return null;
  }
}

export interface LineBotInfo {
  displayName: string;
  /** ชื่อที่ผู้ใช้ค้นหา/เพิ่มเพื่อนได้ เช่น "@490secnd" (ว่างเมื่อช่องยังไม่ตั้งชื่อ) */
  basicId: string;
  /** userId ของ OA เอง — ต่างจาก userId ของผู้ใช้แต่ละคน ใช้ push ไม่ได้ */
  userId: string;
}

/**
 * ข้อมูล OA ของหอ — ใช้บอกเจ้าของว่า "เพิ่มเพื่อน OA ตัวไหน" ก่อนพิมพ์รหัสเชื่อม
 *
 * ก่อนหน้านี้หน้าตั้งค่าสั่งให้ "เพิ่มเพื่อน OA ของหอ" โดยไม่มีที่ไหนบอกว่า OA คือ
 * อะไร เจ้าของจึงทำตามขั้นตอนไม่ได้เมื่อไม่ได้จำชื่อบอทเอง — ค่านี้ดึงจาก LINE
 * ตรง ๆ ไม่ต้องมีคนกรอก จึงไม่มีทางพิมพ์ผิดและเปลี่ยนตามเมื่อตั้งชื่อบอทใหม่
 *
 * fail-soft เหมือน fetchProfile: เรียกไม่ได้/ไม่ตั้ง token → null แล้วผู้เรียก
 * แสดงแค่คำแนะนำโดยไม่มี id (ไม่ทำให้หน้าตั้งค่าล้ม)
 */
export async function fetchBotInfo(env: Env): Promise<LineBotInfo | null> {
  if (demoModeOn(env)) {
    logLineFailure("line bot info skipped", "demo mode: outbound disabled");
    return null;
  }

  const token = accessToken(env);

  if (token === "") {
    logLineFailure("line bot info skipped", "LINE_CHANNEL_ACCESS_TOKEN is not configured");
    return null;
  }

  try {
    const response = await fetch(`${lineApiBase}/info`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(lineOutboundTimeoutMs),
    });

    if (!response.ok) {
      logLineFailure("line bot info failed", `status ${String(response.status)}`);
      return null;
    }

    const body = await response.json<{ displayName?: string; basicId?: string; userId?: string }>();

    return {
      displayName: typeof body.displayName === "string" ? body.displayName : "",
      basicId: typeof body.basicId === "string" ? body.basicId : "",
      userId: typeof body.userId === "string" ? body.userId : "",
    };
  } catch (error) {
    logLineFailure("line bot info failed", failureDetail(error));
    return null;
  }
}
