type StoredState = {
  lastUp: boolean | null;           // null = unknown (first run)
  lastCheckedAt: number | null;     // ms epoch
  lastUpAt: number | null;          // ms epoch
  lastDownAt: number | null;        // ms epoch
  consecutiveFailures: number;
};

interface Env {
  UPTIME_KV: KVNamespace;

  HEALTHCHECK_URL: string;
  EXPECT_STATUS: string;
  TIMEOUT_MS: string;
  CHECK_NAME: string;
  RECOVERY_NOTIFY?: string;

  // Secrets (set via: npx wrangler secret put ...)
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;

  // Optional secret: if set, manual HTTP checks require this key
  // via header `x-admin-key` or query param `?key=...`
  ADMIN_KEY?: string;
}

const STATE_KEY = "state:v1";

function nowIso() {
  return new Date().toISOString();
}

function boolFromEnv(value: string | undefined, defaultValue = false): boolean {
  if (value == null) return defaultValue;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

async function loadState(env: Env): Promise<StoredState> {
  const raw = await env.UPTIME_KV.get(STATE_KEY);
  if (!raw) {
    return {
      lastUp: null,
      lastCheckedAt: null,
      lastUpAt: null,
      lastDownAt: null,
      consecutiveFailures: 0,
    };
  }
  try {
    const parsed = JSON.parse(raw) as StoredState;
    return {
      lastUp: parsed.lastUp ?? null,
      lastCheckedAt: parsed.lastCheckedAt ?? null,
      lastUpAt: parsed.lastUpAt ?? null,
      lastDownAt: parsed.lastDownAt ?? null,
      consecutiveFailures: parsed.consecutiveFailures ?? 0,
    };
  } catch {
    // If state becomes corrupted, reset.
    return {
      lastUp: null,
      lastCheckedAt: null,
      lastUpAt: null,
      lastDownAt: null,
      consecutiveFailures: 0,
    };
  }
}

async function saveState(env: Env, state: StoredState): Promise<void> {
  await env.UPTIME_KV.put(STATE_KEY, JSON.stringify(state));
}

async function sendTelegram(env: Env, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json;charset=UTF-8" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${res.statusText} ${body}`);
  }
}

async function pingHealth(url: string, timeoutMs: number): Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }> {
  const controller = new AbortController();
  const t0 = Date.now();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "uptime-telegram-worker/1.0",
        "cache-control": "no-cache",
        "pragma": "no-cache",
      },
    });
    const latencyMs = Date.now() - t0;
    return { ok: res.ok, status: res.status, latencyMs };
  } catch (e: any) {
    const latencyMs = Date.now() - t0;
    const msg = typeof e?.message === "string" ? e.message : String(e);
    return { ok: false, latencyMs, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

function fmtMs(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export async function runCheck(env: Env): Promise<{
  isUp: boolean;
  expectedStatus: number;
  actualStatus?: number;
  latencyMs: number;
  error?: string;
  state: StoredState;
}> {
  const expectedStatus = Number(env.EXPECT_STATUS || "200");
  const timeoutMs = Number(env.TIMEOUT_MS || "8000");

  const state = await loadState(env);

  const result = await pingHealth(env.HEALTHCHECK_URL, timeoutMs);
  const isUp = result.ok && result.status === expectedStatus;

  const checkedAt = Date.now();
  state.lastCheckedAt = checkedAt;

  const wasUp = state.lastUp;

  if (isUp) {
    state.lastUp = true;
    state.lastUpAt = checkedAt;
    state.consecutiveFailures = 0;

    const shouldNotifyRecovery = boolFromEnv(env.RECOVERY_NOTIFY, false);
    if (shouldNotifyRecovery && wasUp === false) {
      const msg =
        `✅ RECOVERED: ${env.CHECK_NAME}\n` +
        `URL: ${env.HEALTHCHECK_URL}\n` +
        `Status: ${result.status} (expected ${expectedStatus})\n` +
        `Latency: ${fmtMs(result.latencyMs)}\n` +
        `Time: ${nowIso()}`;
      await sendTelegram(env, msg);
    }
  } else {
    state.lastUp = false;
    state.lastDownAt = checkedAt;
    state.consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;

    // Only alert on the transition: up/unknown -> down
    if (wasUp !== false) {
      const reason =
        result.error ? `Error: ${result.error}` :
        typeof result.status === "number" ? `Status: ${result.status} (expected ${expectedStatus})` :
        `Unknown failure`;

      const msg =
        `🚨 DOWN: ${env.CHECK_NAME}\n` +
        `URL: ${env.HEALTHCHECK_URL}\n` +
        `${reason}\n` +
        `Latency: ${fmtMs(result.latencyMs)}\n` +
        `Time: ${nowIso()}`;

      await sendTelegram(env, msg);
    }
  }

  await saveState(env, state);

  return {
    isUp,
    expectedStatus,
    actualStatus: result.status,
    latencyMs: result.latencyMs,
    error: result.error,
    state,
  };
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Optional protection for manual checks:
    if (env.ADMIN_KEY && env.ADMIN_KEY.length > 0) {
      const key = url.searchParams.get("key") || request.headers.get("x-admin-key");
      if (key !== env.ADMIN_KEY) return unauthorized();
    }

    if (url.pathname === "/" || url.pathname === "/__check") {
      try {
        const out = await runCheck(env);
        return json({ ok: true, ...out });
      } catch (e: any) {
        return json({ ok: false, error: e?.message ?? String(e) }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          await runCheck(env);
        } catch {
          // If Telegram send fails, we don't want the Worker run to crash-loop.
          // You can inspect failures with: npx wrangler tail
        }
      })()
    );
  },
};
