// Uptime + heartbeat monitor on Cloudflare Workers, alerting via Telegram.
//
// Two kinds of checks, both configured in wrangler.toml [vars]:
//   CHECKS      URLs polled by the cron (every 5 min). Alert after FAIL_THRESHOLD consecutive failures,
//               "recovered" message when it comes back (RECOVERY_NOTIFY).
//   HEARTBEATS  dead man's switches. Something (e.g. a backup script) POSTs /hb/<name> when it succeeds.
//               If no successful ping arrives within maxAgeMinutes, the cron alerts (and re-alerts every
//               REMIND_HOURS while it stays overdue). POST /hb/<name>/fail alerts right away.
//
// Secrets (npx wrangler secret put ...): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, HEARTBEAT_KEY, ADMIN_KEY (optional).

type CheckCfg = {
  name: string;
  url: string;
  expect?: number | number[];        // accepted status codes, default 200
  redirect?: "follow" | "manual";    // default "follow"; "manual" lets a 3xx count as the answer
  timeoutMs?: number;
};

type HeartbeatCfg = {
  name: string;           // [a-z0-9-]+, used in the URL
  maxAgeMinutes: number;  // alert when the last successful ping is older than this
};

type CheckState = { up: boolean | null; failures: number; since: number | null };
type HbState = { firstSeenAt: number; alertedAt: number | null };
type State = { checks: Record<string, CheckState>; heartbeats: Record<string, HbState> };

// Written by the ping endpoint only (one key per heartbeat), so pings never race the cron's state blob.
type Ping = { lastOkAt: number | null; lastFailAt: number | null; lastMsg: string | null };

interface Env {
  UPTIME_KV: KVNamespace;

  CHECKS: string;       // JSON CheckCfg[]
  HEARTBEATS: string;   // JSON HeartbeatCfg[]
  TIMEOUT_MS?: string;
  RECOVERY_NOTIFY?: string;
  FAIL_THRESHOLD?: string;
  REMIND_HOURS?: string;

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  HEARTBEAT_KEY?: string;  // required for /hb/* and accepted for GET /status
  ADMIN_KEY?: string;      // required for /__check (runs everything now) and accepted for /status
}

const STATE_KEY = "state:v2";
const pingKey = (name: string) => `hb:${name}`;

const nowIso = (t = Date.now()) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
const boolFromEnv = (v: string | undefined, d = false) =>
  v == null ? d : ["1", "true", "yes", "y", "on"].includes(v.trim().toLowerCase());

function fmtAge(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function parseList<T>(raw: string | undefined, what: string): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) throw new Error("not an array");
    return v as T[];
  } catch (e: any) {
    throw new Error(`${what} in wrangler.toml is not a valid JSON array: ${e?.message ?? e}`);
  }
}
const checksOf = (env: Env) => parseList<CheckCfg>(env.CHECKS, "CHECKS");
const heartbeatsOf = (env: Env) => parseList<HeartbeatCfg>(env.HEARTBEATS, "HEARTBEATS");

async function loadState(env: Env): Promise<State> {
  try {
    const s = JSON.parse((await env.UPTIME_KV.get(STATE_KEY)) ?? "{}");
    return { checks: s.checks ?? {}, heartbeats: s.heartbeats ?? {} };
  } catch {
    return { checks: {}, heartbeats: {} };
  }
}

async function loadPing(env: Env, name: string): Promise<Ping> {
  try {
    const p = JSON.parse((await env.UPTIME_KV.get(pingKey(name))) ?? "{}");
    return { lastOkAt: p.lastOkAt ?? null, lastFailAt: p.lastFailAt ?? null, lastMsg: p.lastMsg ?? null };
  } catch {
    return { lastOkAt: null, lastFailAt: null, lastMsg: null };
  }
}

async function sendTelegram(env: Env, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------- URL checks

type ProbeResult = { ok: boolean; status?: number; latencyMs: number; error?: string };

async function probe(c: CheckCfg, defaultTimeout: number): Promise<ProbeResult> {
  const expect = Array.isArray(c.expect) ? c.expect : [c.expect ?? 200];
  const t0 = Date.now();
  try {
    const res = await fetch(c.url, {
      method: "GET",
      redirect: c.redirect ?? "follow",
      signal: AbortSignal.timeout(c.timeoutMs ?? defaultTimeout),
      headers: { "user-agent": "uptime-telegram-worker/2.0", "cache-control": "no-cache" },
    });
    await res.body?.cancel().catch(() => {});
    return { ok: expect.includes(res.status), status: res.status, latencyMs: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - t0, error: e?.message ?? String(e) };
  }
}

async function runChecks(env: Env, state: State, alerts: string[]) {
  const timeout = Number(env.TIMEOUT_MS || "8000");
  const threshold = Math.max(1, Number(env.FAIL_THRESHOLD || "3"));
  const recovery = boolFromEnv(env.RECOVERY_NOTIFY, false);
  const checks = checksOf(env);
  const results = await Promise.all(checks.map((c) => probe(c, timeout)));
  const now = Date.now();
  const report: Record<string, ProbeResult> = {};

  checks.forEach((c, i) => {
    const r = results[i];
    report[c.name] = r;
    const s = (state.checks[c.name] ??= { up: null, failures: 0, since: null });
    if (r.ok) {
      if (s.up === false && recovery) {
        alerts.push(`✅ RECOVERED: ${c.name}\n${c.url}\nStatus ${r.status}, was down for ${fmtAge(now - (s.since ?? now))}`);
      }
      if (s.up !== true) { s.up = true; s.since = now; }
      s.failures = 0;
    } else if (s.up !== false) {
      // Only count up to the threshold, so a check that stays down doesn't rewrite KV on every run.
      s.failures += 1;
      if (s.failures >= threshold) {
        s.up = false;
        s.since = now;
        const why = r.error ? `Error: ${r.error}` : `Status ${r.status}`;
        alerts.push(`🚨 DOWN: ${c.name}\n${c.url}\n${why}\n${s.failures} failures in a row`);
      }
    }
  });
  for (const name of Object.keys(state.checks)) if (!checks.some((c) => c.name === name)) delete state.checks[name];
  return report;
}

// ---------------------------------------------------------------- heartbeats

async function runHeartbeats(env: Env, state: State, alerts: string[]) {
  const remindMs = Number(env.REMIND_HOURS || "24") * 3600_000;
  const now = Date.now();
  const hbs = heartbeatsOf(env);
  const report: Record<string, unknown> = {};

  for (const hb of hbs) {
    const s = (state.heartbeats[hb.name] ??= { firstSeenAt: now, alertedAt: null });
    const p = await loadPing(env, hb.name);
    // A heartbeat that has never pinged counts from when the cron first saw it in the config.
    const ref = Math.max(p.lastOkAt ?? 0, s.firstSeenAt);
    const age = now - ref;
    const overdue = age > hb.maxAgeMinutes * 60_000;
    report[hb.name] = {
      overdue,
      maxAgeMinutes: hb.maxAgeMinutes,
      lastOkAt: p.lastOkAt && nowIso(p.lastOkAt),
      lastFailAt: p.lastFailAt && nowIso(p.lastFailAt),
      lastMsg: p.lastMsg,
    };

    if (overdue && (s.alertedAt == null || now - s.alertedAt >= remindMs)) {
      const last = p.lastOkAt
        ? `last success ${nowIso(p.lastOkAt)} (${fmtAge(now - p.lastOkAt)} ago)`
        : `no success since monitoring started ${fmtAge(age)} ago`;
      const failed = p.lastFailAt && (!p.lastOkAt || p.lastFailAt > p.lastOkAt)
        ? `\nLast failure ${nowIso(p.lastFailAt)}: ${p.lastMsg ?? ""}`
        : "";
      alerts.push(
        `${s.alertedAt == null ? "🚨" : "⏰ STILL"} MISSED: ${hb.name}\n` +
          `No heartbeat for over ${fmtAge(hb.maxAgeMinutes * 60_000)}; ${last}${failed}`,
      );
      s.alertedAt = now;
    } else if (!overdue && s.alertedAt != null) {
      alerts.push(`✅ ${hb.name} is reporting again (last success ${nowIso(p.lastOkAt ?? now)})`);
      s.alertedAt = null;
    }
  }
  for (const name of Object.keys(state.heartbeats)) if (!hbs.some((h) => h.name === name)) delete state.heartbeats[name];
  return report;
}

// ---------------------------------------------------------------- cron

async function runAll(env: Env) {
  const state = await loadState(env);
  const before = JSON.stringify(state);
  const alerts: string[] = [];
  const checks = await runChecks(env, state, alerts);
  const heartbeats = await runHeartbeats(env, state, alerts);

  // Send before saving: if Telegram fails, the same transitions are detected and retried on the next run.
  const sent: string[] = [];
  let telegramError: string | undefined;
  for (const a of alerts) {
    try {
      await sendTelegram(env, a);
      sent.push(a);
    } catch (e: any) {
      telegramError = e?.message ?? String(e);
      break;
    }
  }
  if (!telegramError && JSON.stringify(state) !== before) await env.UPTIME_KV.put(STATE_KEY, JSON.stringify(state));
  if (telegramError) console.error(telegramError);
  return { checks, heartbeats, alerts: sent, telegramError, state };
}

// ---------------------------------------------------------------- HTTP

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function keyMatches(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}

async function notify(env: Env, text: string): Promise<string> {
  try {
    await sendTelegram(env, text);
    return "sent";
  } catch (e: any) {
    return `error: ${e?.message ?? e}`;
  }
}

async function handlePing(request: Request, env: Env, name: string, failed: boolean): Promise<Response> {
  if (!heartbeatsOf(env).some((h) => h.name === name)) return json({ ok: false, error: `unknown heartbeat '${name}'` }, 404);
  const msg = request.method === "POST" ? (await request.text()).slice(0, 1000).trim() || null : null;
  const p = await loadPing(env, name);
  const now = Date.now();
  let telegram = "not needed";

  if (failed) {
    p.lastFailAt = now;
    p.lastMsg = msg;
    telegram = await notify(env, `🚨 FAILED: ${name}\n${msg ?? "(no details)"}\n${nowIso(now)}`);
  } else {
    const wasFailing = p.lastFailAt != null && (p.lastOkAt == null || p.lastFailAt > p.lastOkAt);
    p.lastOkAt = now;
    if (msg) p.lastMsg = msg;
    if (wasFailing) telegram = await notify(env, `✅ ${name} succeeded again${msg ? `\n${msg}` : ""}`);
  }
  await env.UPTIME_KV.put(pingKey(name), JSON.stringify(p));
  return json({ ok: true, name, recorded: failed ? "fail" : "ok", at: nowIso(now), telegram });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = request.headers.get("x-key") || url.searchParams.get("key");

    try {
      // /hb/<name>        success ping (POST or GET; POST body = optional note)
      // /hb/<name>/fail   failure, alerts immediately (POST body = details)
      const hb = url.pathname.match(/^\/hb\/([a-z0-9-]{1,64})(\/fail)?\/?$/);
      if (hb) {
        if (!keyMatches(key, env.HEARTBEAT_KEY)) return json({ ok: false, error: "unauthorized" }, 401);
        return await handlePing(request, env, hb[1], !!hb[2]);
      }
      if (url.pathname === "/status" && (keyMatches(key, env.HEARTBEAT_KEY) || keyMatches(key, env.ADMIN_KEY))) {
        const pings: Record<string, Ping> = {};
        for (const h of heartbeatsOf(env)) pings[h.name] = await loadPing(env, h.name);
        return json({ ok: true, now: nowIso(), state: await loadState(env), pings, checks: checksOf(env), heartbeats: heartbeatsOf(env) });
      }
      if ((url.pathname === "/" || url.pathname === "/__check") && keyMatches(key, env.ADMIN_KEY)) {
        return json({ ok: true, ...(await runAll(env)) });
      }
    } catch (e: any) {
      return json({ ok: false, error: e?.message ?? String(e) }, 500);
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runAll(env).then(
        (r) => { if (r.alerts.length) console.log(`alerts sent: ${r.alerts.length}`); },
        (e) => console.error("run failed:", e?.message ?? e),
      ),
    );
  },
};
