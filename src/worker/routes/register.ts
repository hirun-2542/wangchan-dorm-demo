import { Hono } from "hono";
import { failureDetail, lineFamilyId, lineOutboundTimeoutMs, logLineFailure, pushMessage } from "../line/api";
import { integrationEnv } from "../lib/credentials";
import { broadcastTenantJoined } from "../lib/paid-notify";
import { errorBody, readJsonObject, roomNumberOrder } from "./shared";

const registerApi = new Hono<{ Bindings: Env }>();

export const registerPage = new Hono<{ Bindings: Env }>();

const lineProfileUrl = "https://api.line.me/v2/profile";

const lineVerifyUrl = "https://api.line.me/oauth2/v2.1/verify";

const invalidTokenMessage = "ลิงก์ยืนยันตัวตนไม่ถูกต้อง กรุณาเปิดฟอร์มจาก LINE อีกครั้ง";

const missingFamilyMessage = "หอนี้ยังตั้งค่าไม่เสร็จ กรุณาติดต่อเจ้าของหอ";

interface LineIdentity {
  userId: string;
  displayName: string;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return /^0\d{9}$/.test(digits) ? digits : "";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * รหัสช่องของ LIFF อยู่ใน LIFF ID รูปแบบ <channelId>-<suffix>
 *
 * token ที่ออกโดย LIFF จะมี client_id เป็นรหัสช่องนี้ ถ้าถอดรหัสช่องไม่ได้
 * ถือว่ายืนยันไม่ได้ และต้องไม่รับ token ใด ๆ
 */
function lineLoginChannelId(env: Env): string {
  const liffId = liffIdFrom(env);
  const separator = liffId.indexOf("-");
  const channelId = (separator === -1 ? liffId : liffId.slice(0, separator)).trim();

  return /^\d+$/.test(channelId) ? channelId : "";
}

async function fetchTokenChannelId(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(`${lineVerifyUrl}?access_token=${encodeURIComponent(accessToken)}`, {
      method: "GET",
      signal: AbortSignal.timeout(lineOutboundTimeoutMs),
    });

    if (!response.ok) {
      console.error(JSON.stringify({ message: "register token verify failed", status: response.status }));
      return null;
    }

    const body = await response.json<{ client_id?: unknown }>();
    const clientId = typeof body.client_id === "string" ? body.client_id.trim() : "";

    return clientId === "" ? null : clientId;
  } catch (error) {
    logLineFailure("register token verify failed", failureDetail(error));
    return null;
  }
}

async function fetchLineIdentity(accessToken: string): Promise<LineIdentity | null> {
  try {
    const response = await fetch(lineProfileUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(lineOutboundTimeoutMs),
    });

    if (!response.ok) {
      console.error(JSON.stringify({ message: "register line profile failed", status: response.status }));
      return null;
    }

    const body = await response.json<{ userId?: unknown; displayName?: unknown }>();
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";

    if (userId === "") {
      console.error(JSON.stringify({ message: "register line profile failed", reason: "missing user id" }));
      return null;
    }

    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";

    return { userId, displayName };
  } catch (error) {
    logLineFailure("register line profile failed", failureDetail(error));
    return null;
  }
}

function ownerRegisterMessage(name: string, roomNumber: string, phone: string): string {
  return `ผู้เช่าลงทะเบียนใหม่: ${name} ห้อง ${roomNumber} เบอร์ ${phone}`;
}

function tenantRegisterMessage(roomNumber: string): string {
  return `ลงทะเบียนห้อง ${roomNumber} เรียบร้อยแล้ว เจ้าของหอจะตรวจสอบและติดต่อกลับ`;
}

async function alertRegistration(env: Env, family: string, name: string, roomNumber: string, phone: string, lineUserId: string): Promise<void> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE family_id = ? AND key = 'owner_line_user_id'")
      .bind(family)
      .first<{ value: string }>();
    const ownerId = (row?.value ?? "").trim();

    if (ownerId === "") {
      console.log(JSON.stringify({ message: "register owner alert skipped", reason: "owner line is not linked" }));
    } else {
      const delivered = await pushMessage(env, ownerId, [{ type: "text", text: ownerRegisterMessage(name, roomNumber, phone) }]);
      console.log(JSON.stringify({ message: "register owner alerted", delivered: delivered === true }));
    }
  } catch (error) {
    logLineFailure("register owner alert failed", failureDetail(error));
  }

  try {
    const delivered = await pushMessage(env, lineUserId, [{ type: "text", text: tenantRegisterMessage(roomNumber) }]);
    console.log(JSON.stringify({ message: "register tenant confirmed", delivered: delivered === true }));
  } catch (error) {
    logLineFailure("register tenant confirm failed", failureDetail(error));
  }
}

registerApi.get("/rooms", async (c) => {
  const family = await lineFamilyId(c.env);

  if (family === null) {
    console.error(JSON.stringify({ message: "list register rooms failed", error: "meta.line_family_id is not configured" }));
    return c.json(errorBody("INTERNAL", missingFamilyMessage), 500);
  }

  try {
    const result = await c.env.DB.prepare(
      `SELECT id, room_number FROM rooms WHERE family_id = ? AND status = 'vacant' ORDER BY ${roomNumberOrder("room_number")}`,
    )
      .bind(family)
      .all<{
        id: string;
        room_number: string;
      }>();

    return c.json({ ok: true, rooms: result.results.map((row) => ({ id: row.id, roomNumber: row.room_number })) }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "list register rooms failed", error: detail }));
    return c.json(errorBody("INTERNAL", "โหลดรายการห้องไม่สำเร็จ"), 500);
  }
});

registerApi.post("/", async (c) => {
  const body = await readJsonObject(c.req.raw);

  if (body === null) {
    return c.json(errorBody("VALIDATION", "รูปแบบข้อมูลไม่ถูกต้อง"), 400);
  }

  const name = readText(body.name);

  if (name.length < 2) {
    return c.json(errorBody("VALIDATION", "กรุณากรอกชื่อ-นามสกุล", "name"), 400);
  }

  const phone = normalizePhone(readText(body.phone));

  if (phone === "") {
    return c.json(errorBody("VALIDATION", "กรุณากรอกเบอร์โทรให้ถูกต้อง", "phone"), 400);
  }

  const roomId = readText(body.roomId);

  if (roomId === "") {
    return c.json(errorBody("VALIDATION", "กรุณาเลือกห้อง", "roomId"), 400);
  }

  const accessToken = readText(body.accessToken);

  if (accessToken === "") {
    return c.json(errorBody("VALIDATION", "ไม่พบข้อมูลยืนยันตัวตน กรุณาเปิดฟอร์มจาก LINE อีกครั้ง", "accessToken"), 400);
  }

  const family = await lineFamilyId(c.env);

  if (family === null) {
    console.error(JSON.stringify({ message: "register failed", error: "meta.line_family_id is not configured" }));
    return c.json(errorBody("INTERNAL", missingFamilyMessage), 500);
  }

  // ค่าที่เจ้าของกรอกในหน้าตั้งค่าชนะ env — LIFF ID และ token ต้องมาจากที่เดียวกัน
  const env = await integrationEnv(c.env, family);
  const expectedChannelId = lineLoginChannelId(env);
  const tokenChannelId = expectedChannelId === "" ? null : await fetchTokenChannelId(accessToken);

  if (tokenChannelId === null || tokenChannelId !== expectedChannelId) {
    console.error(
      JSON.stringify({
        message: "register token rejected",
        reason: expectedChannelId === "" ? "this app's LINE login channel is not configured" : "token belongs to another channel",
      }),
    );
    return c.json(errorBody("VALIDATION", invalidTokenMessage), 401);
  }

  const identity = await fetchLineIdentity(accessToken);

  if (identity === null) {
    return c.json(errorBody("VALIDATION", invalidTokenMessage), 401);
  }

  try {
    const existing = await c.env.DB.prepare(
      "SELECT r.room_number FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE t.family_id = ? AND r.family_id = ? AND t.line_user_id = ?",
    )
      .bind(family, family, identity.userId)
      .first<{ room_number: string }>();

    if (existing !== null) {
      return c.json(errorBody("CONFLICT", `LINE นี้ลงทะเบียนห้อง ${existing.room_number} ไว้แล้ว กรุณาติดต่อเจ้าของหอ`), 409);
    }

    const room = await c.env.DB.prepare("SELECT id, status, room_number FROM rooms WHERE id = ? AND family_id = ?")
      .bind(roomId, family)
      .first<{ id: string; status: string; room_number: string }>();

    if (room === null) {
      return c.json(errorBody("NOT_FOUND", "ไม่พบห้องที่เลือก", "roomId"), 404);
    }

    if (room.status !== "vacant") {
      return c.json(errorBody("CONFLICT", "ห้องนี้มีผู้เช่าอยู่แล้ว กรุณาติดต่อเจ้าของ", "roomId"), 409);
    }

    const id = crypto.randomUUID();

    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO tenants (id, family_id, full_name, phone, room_id, check_in_date, line_user_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'current')",
      ).bind(id, family, name, phone, roomId, todayIso(), identity.userId),
      c.env.DB.prepare("UPDATE rooms SET status = 'occupied' WHERE id = ? AND family_id = ?").bind(roomId, family),
      c.env.DB.prepare("DELETE FROM line_pending WHERE line_user_id = ? AND family_id = ?").bind(identity.userId, family),
    ]);

    console.log(JSON.stringify({ message: "tenant self-registered", tenantId: id, roomNumber: room.room_number }));

    /**
     * ลงทะเบียนสำเร็จไปแล้วใน D1 — การแจ้งเตือนต้องไม่ทำให้คำขอล้มเหลว
     * จึง await ก่อนตอบ (ให้แท็บที่เปิดอยู่รู้ทันที) แต่ห่อความผิดพลาดไว้ข้างใน
     */
    await broadcastTenantJoined(env, family, {
      tenantId: id,
      roomNumber: room.room_number,
      tenantName: name,
      source: "self",
      joinedAt: new Date().toISOString(),
    });

    await alertRegistration(env, family, name, room.room_number, phone, identity.userId);

    return c.json({ ok: true, tenant: { name, roomNumber: room.room_number } }, 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "register tenant failed", roomId, error: detail }));

    if (detail.includes("UNIQUE")) {
      return c.json(errorBody("CONFLICT", "ห้องนี้มีผู้เช่าอยู่แล้ว กรุณาติดต่อเจ้าของ", "roomId"), 409);
    }

    return c.json(errorBody("INTERNAL", "ลงทะเบียนไม่สำเร็จ"), 500);
  }
});

function liffIdFrom(env: Env): string {
  const value: unknown = env.LIFF_ID;
  return typeof value === "string" ? value.trim() : "";
}

function jsonForScript(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const registerStyles = `
      :root {
        --canvas: #ffffff;
        --paper: #f5f5f5;
        --ash: #e5e5e5;
        --ink: #0a0a0a;
        --charcoal: #171717;
        --steel: #525252;
        --fog: #737373;
        --blue: #2563eb;
        --danger: #dc2626;
        --mint: #dcfce7;
        --mint-ink: #15803d;
        --radius-input: 6px;
        --radius-btn: 8px;
        --radius-card: 12px;
        --radius-panel: 16px;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; }
      body {
        background: var(--paper);
        color: var(--charcoal);
        font-family: Inter, "Noto Sans Thai", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        font-size: 16px;
        line-height: 1.5;
        -webkit-text-size-adjust: 100%;
        display: grid;
        align-content: center;
        justify-items: center;
        min-height: 100vh;
        min-height: 100dvh;
        padding: 32px 16px;
      }
      .page { width: 100%; max-width: 420px; }
      .brand { display: flex; align-items: center; gap: 8px; margin: 0 0 16px; }
      .brand-mark {
        width: 28px; height: 28px; border-radius: 8px; background: var(--ink); color: #ffffff;
        display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600;
      }
      .brand-name { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
      .card {
        background: var(--canvas); border: 1px solid var(--ash); border-radius: var(--radius-card); padding: 20px;
      }
      h1 { margin: 0 0 10px; font-size: 26px; line-height: 1.3; font-weight: 700; letter-spacing: -0.01em; }
      p { margin: 0 0 12px; max-width: 44ch; color: var(--steel); font-size: 15px; line-height: 1.65; }
      .row { margin-bottom: 14px; }
      label { display: block; margin-bottom: 6px; color: var(--steel); font-size: 13px; font-weight: 500; }
      input, select {
        width: 100%; min-height: 44px; padding: 0 12px;
        border: 1px solid var(--ink); border-radius: var(--radius-input);
        background: var(--canvas); color: var(--charcoal); font: inherit; font-size: 16px;
        -webkit-appearance: none; appearance: none;
      }
      input::placeholder { color: var(--fog); }
      input:focus, select:focus { outline: none; border-color: var(--blue); }
      select:disabled { background: var(--paper); color: var(--fog); }
      .field-error { min-height: 18px; margin: 4px 0 0; color: var(--danger); font-size: 13px; }
      .form-error { margin: 0 0 12px; color: var(--danger); font-size: 14px; }
      .submit {
        width: 100%; min-height: 48px; border: 0; border-radius: var(--radius-btn);
        background: var(--ink); color: #ffffff; font: inherit; font-size: 16px; font-weight: 600;
        box-shadow: rgba(0, 0, 0, 0.05) 0 1px 2px; cursor: pointer;
      }
      .submit:disabled { opacity: 0.5; cursor: not-allowed; }
      .close-btn {
        width: 100%; min-height: 48px; border: 1px solid var(--ash); border-radius: var(--radius-btn);
        background: var(--canvas); color: var(--charcoal); font: inherit; font-size: 16px; font-weight: 600; cursor: pointer;
      }
      .success-mark {
        width: 48px; height: 48px; margin-bottom: 12px; border-radius: 9999px; background: var(--mint); color: var(--mint-ink);
        display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 600;
      }
      .summary { margin: 12px 0 20px; border: 1px solid var(--ash); border-radius: var(--radius-card); padding: 4px 14px; }
      .summary-row { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; font-size: 14px; }
      .summary-row + .summary-row { border-top: 1px solid var(--ash); }
      .summary-label { color: var(--steel); }
      .summary-value { font-weight: 600; font-variant-numeric: tabular-nums; }
      [hidden] { display: none !important; }
`;

const registerScript = `
    (function () {
      "use strict";
      var LIFF_ID = window.__LIFF_ID__ || "";
      var SCREEN_IDS = ["screen-loading", "screen-unavailable", "screen-form", "screen-success"];
      var token = "";

      function byId(id) { return document.getElementById(id); }

      function show(id) {
        for (var i = 0; i < SCREEN_IDS.length; i += 1) {
          var node = byId(SCREEN_IDS[i]);
          if (node) { node.hidden = SCREEN_IDS[i] !== id; }
        }
      }

      function showUnavailable(title, detail) {
        var heading = byId("unavailable-title");
        var body = byId("unavailable-detail");
        if (title && heading) { heading.textContent = title; }
        if (detail && body) { body.textContent = detail; }
        show("screen-unavailable");
      }

      function fieldError(name, message) {
        var node = byId("error-" + name);
        if (node) { node.textContent = message || ""; }
      }

      function clearErrors() {
        fieldError("name", "");
        fieldError("phone", "");
        fieldError("room", "");
        var general = byId("form-error");
        if (general) { general.textContent = ""; }
      }

      function normalizePhone(value) {
        var digits = String(value || "").replace(/\\D/g, "");
        return digits.length === 10 && digits.charAt(0) === "0" ? digits : "";
      }

      function setBusy(busy) {
        var submit = byId("submit-btn");
        if (!submit) { return; }
        submit.disabled = busy;
        submit.textContent = busy ? "กำลังลงทะเบียน" : "ลงทะเบียน";
      }

      function fillRooms(rooms) {
        var select = byId("field-room");
        if (!select) { return; }
        select.innerHTML = "";
        if (!rooms.length) {
          var empty = document.createElement("option");
          empty.value = "";
          empty.textContent = "ยังไม่มีห้องว่างให้ลงทะเบียน";
          select.appendChild(empty);
          select.disabled = true;
          var submit = byId("submit-btn");
          if (submit) { submit.disabled = true; }
          return;
        }
        var placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "เลือกห้อง";
        select.appendChild(placeholder);
        for (var i = 0; i < rooms.length; i += 1) {
          var option = document.createElement("option");
          option.value = rooms[i].id;
          option.textContent = rooms[i].roomNumber;
          select.appendChild(option);
        }
        select.disabled = false;
      }

      function loadRooms() {
        return fetch("/api/register/rooms", { headers: { accept: "application/json" } }).then(function (response) {
          return response.json().then(function (body) {
            if (!response.ok || !body || body.ok !== true || !Array.isArray(body.rooms)) {
              throw new Error("rooms");
            }
            fillRooms(body.rooms);
          });
        });
      }

      function showSuccess(name, roomNumber) {
        var nameNode = byId("success-name");
        var roomNode = byId("success-room");
        if (nameNode) { nameNode.textContent = name; }
        if (roomNode) { roomNode.textContent = roomNumber; }
        show("screen-success");
      }

      function submitForm(event) {
        event.preventDefault();
        clearErrors();
        var name = String(byId("field-name").value || "").trim();
        var phone = normalizePhone(byId("field-phone").value);
        var roomId = String(byId("field-room").value || "");
        var invalid = false;
        if (name.length < 2) { fieldError("name", "กรุณากรอกชื่อ-นามสกุลอย่างน้อย 2 ตัวอักษร"); invalid = true; }
        if (phone === "") { fieldError("phone", "กรุณากรอกเบอร์โทร 10 หลัก เริ่มด้วย 0"); invalid = true; }
        if (roomId === "") { fieldError("room", "กรุณาเลือกห้อง"); invalid = true; }
        if (invalid) { return; }
        if (token === "") {
          showUnavailable("กรุณาเปิดฟอร์มนี้จากในแอป LINE เท่านั้น", "ไม่พบข้อมูลยืนยันตัวตนจาก LINE กรุณาเปิดฟอร์มจากในแอป LINE อีกครั้ง");
          return;
        }
        setBusy(true);
        fetch("/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name, phone: phone, roomId: roomId, accessToken: token })
        }).then(function (response) {
          return response.json().then(function (body) {
            if (response.ok && body && body.ok === true && body.tenant) {
              showSuccess(body.tenant.name, body.tenant.roomNumber);
              return;
            }
            var message = body && body.error && body.error.message ? body.error.message : "ลงทะเบียนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
            var field = body && body.error && body.error.field ? body.error.field : "";
            if (field === "name" || field === "phone") {
              fieldError(field, message);
            } else if (field === "roomId") {
              fieldError("room", message);
            } else {
              var general = byId("form-error");
              if (general) { general.textContent = message; }
            }
          });
        }).catch(function () {
          var general = byId("form-error");
          if (general) { general.textContent = "เชื่อมต่อไม่ได้ กรุณาลองใหม่อีกครั้ง"; }
        }).then(function () {
          setBusy(false);
        });
      }

      function bind() {
        var form = byId("register-form");
        if (form) { form.addEventListener("submit", submitForm); }
        var close = byId("close-btn");
        if (close) {
          close.addEventListener("click", function () {
            if (typeof liff !== "undefined" && liff.closeWindow) { liff.closeWindow(); }
          });
        }
      }

      bind();

      if (!LIFF_ID) {
        showUnavailable();
        return;
      }

      if (typeof liff === "undefined") {
        showUnavailable("โหลดไลบรารีของ LINE ไม่สำเร็จ", "กรุณาเปิดฟอร์มจากในแอป LINE อีกครั้ง หากยังพบหน้านี้ให้แจ้งเจ้าของหอ");
        return;
      }

      liff.init({ liffId: LIFF_ID }).then(function () {
        if (!liff.isInClient || !liff.isInClient()) {
          showUnavailable("กรุณาเปิดฟอร์มนี้จากในแอป LINE เท่านั้น", "หากเปิดจากในแอป LINE แล้วยังพบหน้านี้ กรุณาแจ้งเจ้าของหอให้ตรวจสอบการตั้งค่า LIFF");
          return;
        }
        token = liff.getAccessToken() || "";
        if (token === "") {
          showUnavailable("กรุณาเปิดฟอร์มนี้จากในแอป LINE เท่านั้น", "ไม่พบข้อมูลยืนยันตัวตนจาก LINE กรุณาเปิดฟอร์มจากในแอป LINE อีกครั้ง");
          return;
        }
        loadRooms().then(function () {
          show("screen-form");
        }).catch(function () {
          showUnavailable("โหลดรายการห้องไม่สำเร็จ", "กรุณาเปิดฟอร์มจากในแอป LINE อีกครั้ง");
        });
      }).catch(function () {
        showUnavailable("เปิดฟอร์มจาก LINE ไม่สำเร็จ", "ลิงก์ลงทะเบียนนี้อาจหมดอายุหรือตั้งค่าไม่ครบ กรุณาเปิดจากในแอป LINE อีกครั้ง");
      });
    })();
`;

function loadingSection(): string {
  return `<section id="screen-loading" class="card">
        <h1>กำลังโหลด</h1>
        <p>กำลังเตรียมฟอร์มลงทะเบียน กรุณารอสักครู่</p>
      </section>`;
}

function unavailableSection(hidden: boolean, title: string, detail: string): string {
  return `<section id="screen-unavailable" class="card"${hidden ? " hidden" : ""}>
        <h1 id="unavailable-title">${title}</h1>
        <p id="unavailable-detail">${detail}</p>
      </section>`;
}

function formSection(): string {
  return `<section id="screen-form" class="card" hidden>
        <h1>ลงทะเบียนผู้เช่า</h1>
        <p>กรอกข้อมูลให้ครบถ้วนเพื่อผูก LINE ของคุณกับห้องพัก</p>
        <p id="form-error" class="form-error" role="alert"></p>
        <form id="register-form" novalidate>
          <div class="row">
            <label for="field-name">ชื่อ-นามสกุล</label>
            <input id="field-name" name="name" type="text" autocomplete="name" placeholder="เช่น สมชาย ใจดี" />
            <p class="field-error" id="error-name"></p>
          </div>
          <div class="row">
            <label for="field-phone">เบอร์โทร</label>
            <input id="field-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="เช่น 0812345678" />
            <p class="field-error" id="error-phone"></p>
          </div>
          <div class="row">
            <label for="field-room">ห้อง</label>
            <select id="field-room" name="roomId">
              <option value="">กำลังโหลดรายการห้อง</option>
            </select>
            <p class="field-error" id="error-room"></p>
          </div>
          <button id="submit-btn" class="submit" type="submit">ลงทะเบียน</button>
        </form>
      </section>`;
}

function successSection(): string {
  return `<section id="screen-success" class="card" hidden>
        <div class="success-mark" aria-hidden="true">✓</div>
        <h1>ลงทะเบียนสำเร็จ</h1>
        <p>เจ้าของหอจะตรวจสอบข้อมูลและติดต่อกลับ</p>
        <div class="summary">
          <div class="summary-row"><span class="summary-label">ชื่อ</span><span class="summary-value" id="success-name"></span></div>
          <div class="summary-row"><span class="summary-label">ห้อง</span><span class="summary-value" id="success-room"></span></div>
        </div>
        <button id="close-btn" class="close-btn" type="button">ปิดหน้าต่าง</button>
      </section>`;
}

const ownerSetupDetail =
  "หน้านี้เป็นฟอร์มลงทะเบียนผู้เช่า เปิดได้จากในแอป LINE ของหอพักเท่านั้น เจ้าของหอต้องสร้าง LIFF app ใน LINE Developers Console ตั้งค่า Endpoint URL เป็น /register ของเว็บนี้ ขนาด Full และเปิด scope profile แล้วนำ LIFF ID มาใส่ในการตั้งค่า LIFF_ID ของระบบ";

export function renderRegisterPage(liffId: string): string {
  const body =
    liffId === ""
      ? unavailableSection(false, "เปิดฟอร์มนี้จากในแอป LINE เท่านั้น", ownerSetupDetail)
      : `${loadingSection()}
      ${unavailableSection(true, "กรุณาเปิดฟอร์มนี้จากในแอป LINE เท่านั้น", "หากเปิดจากในแอป LINE แล้วยังพบหน้านี้ กรุณาแจ้งเจ้าของหอให้ตรวจสอบการตั้งค่า LIFF")}
      ${formSection()}
      ${successSection()}`;

  return `<!doctype html>
<html lang="th">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
    <title>ลงทะเบียนผู้เช่า</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Noto+Sans+Thai:wght@400;500;600&display=swap" rel="stylesheet" />
    <style>${registerStyles}</style>
  </head>
  <body>
    <main class="page">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">ว</span>
        <span class="brand-name">หอพักวังจันทร์</span>
      </div>
      ${body}
    </main>
    <script>window.__LIFF_ID__ = ${jsonForScript(liffId)};</script>
    <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
    <script>${registerScript}</script>
  </body>
</html>
`;
}

/**
 * LIFF ID มาจากค่าที่เจ้าของกรอกก่อน แล้วจึงเป็น env — หน้าฟอร์มเป็นสาธารณะ
 * จึงต้องรู้ครอบครัวจาก meta.line_family_id แบบเดียวกับ webhook
 */
registerPage.get("/", async (c) => {
  const family = await lineFamilyId(c.env);
  const env = family === null ? c.env : await integrationEnv(c.env, family);

  return c.html(renderRegisterPage(liffIdFrom(env)));
});

export default registerApi;
