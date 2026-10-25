/**
 * Google Sign-In (OAuth 2.0 + OIDC)
 *
 * ใช้ flow ฝั่งเซิร์ฟเวอร์: ผู้ใช้ถูกพาไปหน้าของ Google แล้ว Google ส่ง code
 * กลับมาที่ /api/auth/google/callback ตัว Worker แลก code เป็น access token
 * ด้วย client secret (ความลับไม่เคยออกไปฝั่งเบราว์เซอร์) แล้วถามโปรไฟล์จาก
 * userinfo endpoint
 *
 * ไม่ตรวจลายเซ็น id_token เองโดยเจตนา: access token ที่ได้มาจากการแลก code
 * กับ Google ตรง ๆ บน TLS และถูกใช้ยิงกลับไปที่ Google ทันที ผลลัพธ์จึงมาจาก
 * Google จริงโดยไม่ต้องแบกตัวตรวจ JWKS + JWT ไว้ในโปรเจกต์
 */

const authorizeEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const userinfoEndpoint = "https://www.googleapis.com/oauth2/v3/userinfo";

/** เก็บ state ที่เราสร้างไว้ชั่วคราว เพื่อกันคำขอปลอมที่ไม่ได้เริ่มจากเรา */
export const googleStateCookieName = "wangchan_google_state";
const stateSeconds = 600;

export interface GoogleProfile {
  email: string;
  displayName: string;
}

export function googleRedirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/api/auth/google/callback`;
}

export function googleAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(authorizeEndpoint);

  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");

  return url.toString();
}

export function googleStateCookie(state: string, secure: boolean): string {
  const flags = [
    `${googleStateCookieName}=${state}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${stateSeconds}`,
  ];

  if (secure) {
    flags.push("Secure");
  }

  return flags.join("; ");
}

export function clearedGoogleStateCookie(secure: boolean): string {
  const flags = [`${googleStateCookieName}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];

  if (secure) {
    flags.push("Secure");
  }

  return flags.join("; ");
}

/**
 * คุกกี้พา "ที่หมายปลายทาง" ข้าม Google OAuth
 *
 * ต้องเป็นคุกกี้ ไม่ใช่ query ใน `state` เพราะ fragment ของแอปนี้ (`#bills/…`)
 * ไม่ถูกส่งไปเซิร์ฟเวอร์เลยตอนเบราว์เซอร์พาไป Google — ที่หมายจึงต้องฝากฝั่ง
 * เซิร์ฟเวอร์ของเราเอง และคุกกี้ตัวนี้ก็ต้องมีอายุสั้นเท่า state เพราะเป็นข้อมูล
 * ของรอบล็อกอินครั้งเดียว
 *
 * แยกจาก `googleStateCookie` โดยตั้งใจ: state ต้องเทียบเท่ากับ nonce ที่ Google
 * ส่งกลับเท่านั้น การยัดข้อมูลอื่นปนลงไปทำให้การเทียบพร่ามัวโดยไม่ได้อะไร
 */
export const googleReturnCookieName = "wangchan_google_next";

export function googleReturnCookie(returnPath: string, secure: boolean): string {
  const flags = [
    `${googleReturnCookieName}=${encodeURIComponent(returnPath)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${stateSeconds}`,
  ];

  if (secure) {
    flags.push("Secure");
  }

  return flags.join("; ");
}

export function clearedGoogleReturnCookie(secure: boolean): string {
  const flags = [`${googleReturnCookieName}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];

  if (secure) {
    flags.push("Secure");
  }

  return flags.join("; ");
}

/** อ่านที่หมายที่ฝากไว้ — ค่าที่ถอดรหัสไม่ได้ถือว่าไม่มี (ไม่ throw) */
export function readGoogleReturnCookie(header: string | undefined): string | null {
  const raw = readCookieValue(header, googleReturnCookieName);

  if (raw === null) {
    return null;
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** อ่านค่าคุกกี้ตามชื่อ; SameSite=Lax ทำให้คุกกี้ยังถูกส่งตอน Google เด้งกลับมา */
function readCookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) {
    return null;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) {
      continue;
    }

    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value === "" ? null : value;
    }
  }

  return null;
}

/** อ่าน state ที่เราตั้งไว้เอง; SameSite=Lax ทำให้คุกกี้ยังถูกส่งตอน Google เด้งกลับมา */
export function readGoogleStateCookie(header: string | undefined): string | null {
  return readCookieValue(header, googleStateCookieName);
}

interface UserinfoBody {
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  given_name?: unknown;
}

/**
 * แลก code เป็นโปรไฟล์ คืน null เมื่อขั้นตอนใดไม่สำเร็จ
 * อีเมลที่ยอมรับได้ต้องถูก Google ยืนยันแล้วเท่านั้น (email_verified === true)
 */
export async function exchangeGoogleCode(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GoogleProfile | null> {
  const tokenResponse = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: options.code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!tokenResponse.ok) {
    return null;
  }

  let accessToken: unknown;

  try {
    accessToken = (await tokenResponse.json<{ access_token?: unknown }>()).access_token;
  } catch {
    return null;
  }

  if (typeof accessToken !== "string" || accessToken === "") {
    return null;
  }

  const userinfoResponse = await fetch(userinfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!userinfoResponse.ok) {
    return null;
  }

  let body: UserinfoBody;

  try {
    body = await userinfoResponse.json<UserinfoBody>();
  } catch {
    return null;
  }

  if (body.email_verified !== true || typeof body.email !== "string") {
    return null;
  }

  const email = body.email.trim().toLowerCase();

  if (email === "") {
    return null;
  }

  const rawName =
    typeof body.name === "string" && body.name.trim() !== ""
      ? body.name
      : typeof body.given_name === "string"
        ? body.given_name
        : email.split("@")[0] ?? "";

  return { email, displayName: rawName.trim().replace(/\s+/g, " ").slice(0, 80) };
}
