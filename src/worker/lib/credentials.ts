/**
 * Credential ของ LINE OA และ SlipOK — ค่าที่เจ้าของหอกรอกเองได้จากหน้าตั้งค่า
 *
 * เดิมทั้งห้าเป็น wrangler secret/vars ล้วน (ดูวิธีตั้งใน README) การเปลี่ยน OA
 * หรือคีย์ SlipOK จึงต้องรันคำสั่งบนเครื่องที่ deploy ได้ ตอนนี้ค่าเหล่านี้ถูกเก็บ
 * ในตาราง settings ของครอบครัวเจ้าของช่อง (คีย์ใน credentialSpecs) โดย **ค่าที่กรอก
 * ชนะ env** — env ยังเป็นค่าถอยหลังให้เครื่อง dev และการติดตั้งเดิมทำงานเหมือนเดิม
 *
 * ค่าจริงถูกใช้ฝั่ง server เท่านั้น ไม่มี endpoint ไหนคืนค่าจริงออกไป: หน้าจอได้แค่
 * สถานะ (ตั้งไว้หรือยัง + มาจากไหน) ส่วนค่าที่ไม่ใช่ความลับ (LIFF ID, branch id)
 * คืนค่าจริงได้เพราะยังไงก็แสดงอยู่แล้ว
 *
 * จุดที่เรียก LINE/SlipOK ต้องใช้ env ที่ผ่าน integrationEnv() แล้วเท่านั้น ไม่งั้นค่า
 * ที่เจ้าของกรอกจะไม่ถูกใช้ — ปัจจุบันมีที่ routes/line.ts (webhook + แจ้งเตือน),
 * routes/register.ts, routes/bills.ts, routes/slips-admin.ts และ routes/settings.ts
 */

interface CredentialSpec {
  /** คีย์ในตาราง settings */
  readonly key: string;
  /** ชื่อ env ที่ค่านี้ทับ */
  readonly env: keyof Env;
  /** ความลับไหม — ความลับห้ามคืนค่าจริงออกไปทาง API */
  readonly secret: boolean;
  /** ชื่อที่ใช้ในข้อความ validation */
  readonly label: string;
  readonly maxLength: number;
}

export const credentialSpecs = {
  lineAccessToken: {
    key: "line_channel_access_token",
    env: "LINE_CHANNEL_ACCESS_TOKEN",
    secret: true,
    label: "Channel access token",
    maxLength: 512,
  },
  lineChannelSecret: {
    key: "line_channel_secret",
    env: "LINE_CHANNEL_SECRET",
    secret: true,
    label: "Channel secret",
    maxLength: 128,
  },
  liffId: {
    key: "liff_id",
    env: "LIFF_ID",
    secret: false,
    label: "LIFF ID",
    maxLength: 64,
  },
  slipOkApiKey: {
    key: "slipok_api_key",
    env: "SLIPOK_API_KEY",
    secret: true,
    label: "API key ของ SlipOK",
    maxLength: 256,
  },
  slipOkBranchId: {
    key: "slipok_branch_id",
    env: "SLIPOK_BRANCH_ID",
    secret: false,
    label: "Branch ID",
    maxLength: 32,
  },
} as const satisfies Record<string, CredentialSpec>;

export type CredentialName = keyof typeof credentialSpecs;

export const credentialNames = Object.keys(credentialSpecs) as CredentialName[];

export interface CredentialStatus {
  /** ตั้งค่าไว้หรือยัง (จากที่ไหนก็ตาม) */
  configured: boolean;
  /** ที่มาของค่าที่ใช้จริง — null เมื่อยังไม่มีค่าเลย */
  source: "settings" | "env" | null;
  /** ค่าจริง — คืนเฉพาะรายการที่ไม่ใช่ความลับ */
  value: string | null;
}

export type CredentialsStatus = Record<CredentialName, CredentialStatus>;

export function isCredentialName(value: string): value is CredentialName {
  return Object.prototype.hasOwnProperty.call(credentialSpecs, value);
}

function nameOfKey(key: string): CredentialName | null {
  for (const name of credentialNames) {
    if (credentialSpecs[name].key === key) {
      return name;
    }
  }

  return null;
}

/**
 * ค่าที่เจ้าของกรอกไว้ของครอบครัวหนึ่ง
 *
 * แถวที่ค่าว่างถูกมองว่า "ไม่มีค่า" เหมือนกับไม่มีแถว เพราะการล้างค่าทำได้ทั้ง
 * ลบแถวและเซ็ตเป็นสตริงว่าง (แล้วแต่เส้นทางที่เขียน) ผลลัพธ์จึงต้องเหมือนกัน
 */
export async function loadStoredCredentials(
  db: D1Database,
  familyId: string,
): Promise<Map<CredentialName, string>> {
  const keys = credentialNames.map((name) => credentialSpecs[name].key);
  const placeholders = keys.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT key, value FROM settings WHERE family_id = ? AND key IN (${placeholders})`)
    .bind(familyId, ...keys)
    .all<{ key: string; value: string }>();

  const stored = new Map<CredentialName, string>();

  for (const row of result.results) {
    const name = nameOfKey(row.key);
    const value = typeof row.value === "string" ? row.value.trim() : "";

    if (name !== null && value !== "") {
      stored.set(name, value);
    }
  }

  return stored;
}

/**
 * env สำหรับงานที่ต้องเรียก LINE/SlipOK — ค่าที่เจ้าของกรอกทับ env ทีละรายการ
 *
 * ใช้ Proxy แทนการคัดลอกด้วย {...env} เพราะ env ของ Worker ถือ binding อยู่หลายตัว
 * (D1, R2, Durable Object) การคัดลอกไม่ได้ทำให้อะไรดีขึ้นและเสี่ยงกับ binding ที่
 * ยกมาไม่ได้ — Proxy อ่านค่าที่เหลือผ่านไปที่ env ตัวจริงเสมอ
 */
export async function integrationEnv(env: Env, familyId: string): Promise<Env> {
  const stored = await loadStoredCredentials(env.DB, familyId);

  if (stored.size === 0) {
    return env;
  }

  const overrides: Partial<Record<keyof Env, string>> = {};

  for (const [name, value] of stored) {
    overrides[credentialSpecs[name].env] = value;
  }

  return new Proxy(env, {
    get(target, property, receiver) {
      if (
        typeof property === "string" &&
        Object.prototype.hasOwnProperty.call(overrides, property)
      ) {
        return overrides[property as keyof Env];
      }

      // Reflect.get ถูกประกาศคืน any — เก็บเป็น unknown ก่อนคืนเพื่อไม่ให้ any รั่วออกไป
      const fallback: unknown = Reflect.get(target, property, receiver);

      return fallback;
    },
  });
}

const upsertSql =
  "INSERT INTO settings (family_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(family_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at";

/** บันทึก/ล้างค่าที่เจ้าของกรอก — null = ลบแถว (กลับไปใช้ค่าเดิมของ env) */
export async function saveCredentials(
  db: D1Database,
  familyId: string,
  updates: Map<CredentialName, string | null>,
): Promise<void> {
  const statements = [...updates].map(([name, value]) => {
    const { key } = credentialSpecs[name];

    return value === null
      ? db.prepare("DELETE FROM settings WHERE family_id = ? AND key = ?").bind(familyId, key)
      : db.prepare(upsertSql).bind(familyId, key, value);
  });

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

/**
 * สถานะของทั้งห้ารายการสำหรับหน้าตั้งค่า
 *
 * `source` บอกว่าค่าที่ใช้จริงมาจากไหน เพราะสองที่มาไม่เหมือนกัน: ค่าที่กรอกใน
 * หน้าตั้งค่าชนะ และเมื่อล้างค่าจึงกลับไปใช้ wrangler secret เดิม — เจ้าของต้อง
 * เห็นได้ว่าตอนนี้ใช้ค่าตัวไหนอยู่ ไม่งั้นจะแก้ค่าที่ไม่มีผลแล้วไม่รู้ตัว
 */
export async function credentialsStatus(
  env: Env,
  familyId: string,
): Promise<CredentialsStatus> {
  const stored = await loadStoredCredentials(env.DB, familyId);
  const values = new Map<string, string>();

  for (const [name, value] of stored) {
    values.set(credentialSpecs[name].key, value);
  }

  return credentialStatusFrom(env, values);
}

/**
 * สถานะจากแถว settings ที่อ่านมาแล้ว — ใช้เมื่อผู้เรียกมี Map ของทั้งตารางอยู่แล้ว
 * (เช่น loadSettings ของหน้าตั้งค่า) จะได้ไม่ต้องยิง D1 ซ้ำอีกรอบ
 */
export function credentialStatusFrom(
  env: Env,
  values: Map<string, string>,
): CredentialsStatus {
  const status = {} as CredentialsStatus;

  for (const name of credentialNames) {
    const spec = credentialSpecs[name];
    const fromSettings = (values.get(spec.key) ?? "").trim();
    const envValue: unknown = env[spec.env];
    const fromEnv = typeof envValue === "string" ? envValue.trim() : "";
    const source =
      fromSettings !== "" ? "settings" : fromEnv !== "" ? "env" : null;

    status[name] = {
      configured: source !== null,
      source,
      value: spec.secret
        ? null
        : source === "settings"
          ? fromSettings
          : source === "env"
            ? fromEnv
            : null,
    };
  }

  return status;
}

/**
 * ค่าที่กรอกใช้ได้ไหม — คืนข้อความไทยเมื่อไม่ผ่าน, null เมื่อผ่าน
 *
 * ค่าที่ว่างเปล่าถือว่า "ล้างค่า" จึงผ่านเสมอ (ผู้เรียกตัดสินเองว่าจะลบแถว)
 */
export function credentialError(name: CredentialName, value: string): string | null {
  const spec = credentialSpecs[name];

  if (value.length > spec.maxLength) {
    return `${spec.label} ยาวเกินไป (ไม่เกิน ${spec.maxLength} ตัวอักษร)`;
  }

  if (/\s/.test(value)) {
    return `${spec.label} ต้องไม่มีช่องว่าง`;
  }

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x7f) {
      return `${spec.label} มีอักขระที่ใช้ไม่ได้`;
    }
  }

  // LIFF ID ถูกใช้เป็น "channel id ของ LINE Login" ด้วย (ดู routes/register.ts)
  // หน้าตัดหน้า "-" จึงต้องมีรูปแบบจริง ไม่งั้นผู้เช่าจะเปิดฟอร์มลงทะเบียนไม่ได้
  if (name === "liffId" && !/^\d{6,}-[A-Za-z0-9]{4,}$/.test(value)) {
    return "LIFF ID ต้องมีรูปแบบ 1234567890-abcdEFGH (ดูได้จาก LINE Developers Console)";
  }

  // branch id ของ SlipOK เป็นตัวเลขเสมอ และถูกใส่ใน URL ตรง ๆ
  if (name === "slipOkBranchId" && !/^\d{1,12}$/.test(value)) {
    return "Branch ID ของ SlipOK ต้องเป็นตัวเลขเท่านั้น";
  }

  return null;
}
