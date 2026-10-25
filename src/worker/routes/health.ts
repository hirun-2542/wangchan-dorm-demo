import { Hono } from "hono";

const health = new Hono<{ Bindings: Env }>();

async function runCheck(name: string, probe: () => Promise<unknown>): Promise<string> {
  try {
    await probe();
    return "ok";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "health check failed", check: name, error: detail }));
    return "error";
  }
}

health.get("/", async (c) => {
  const d1 = await runCheck("d1", () => c.env.DB.prepare("SELECT 1").first());
  const r2 = await runCheck("r2", () => c.env.SLIPS.list({ limit: 1 }));
  const checks = { d1, r2 };
  const ok = d1 === "ok" && r2 === "ok";

  return c.json({ ok, time: new Date().toISOString(), checks }, ok ? 200 : 503);
});

export default health;
