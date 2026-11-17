# Uptime + heartbeat monitor (Cloudflare Workers + Telegram)

Deployed at https://uptime-telegram-worker.akwiat.workers.dev. It sends Telegram messages for two kinds of checks,
both configured in `wrangler.toml` `[vars]`:

- **`CHECKS`**: URLs the cron (every 5 min) fetches. After `FAIL_THRESHOLD` (3) failures in a row it sends
  `🚨 DOWN`, and `✅ RECOVERED` when the check passes again. There is one alert per outage, no repeats.
- **`HEARTBEATS`**: dead man's switches. A job POSTs `/hb/<name>` when it succeeds. If no success arrives within
  `maxAgeMinutes`, the cron sends `🚨 MISSED`, repeats it every `REMIND_HOURS` (24) while still overdue, and
  sends `✅ … is reporting again` when pings resume. A dead server or a broken timer therefore alerts too.
  `POST /hb/<name>/fail` (body = details) sends `🚨 FAILED` right away. The next success after it sends
  `✅ … succeeded again`.

Current users: `radify-backup` on step1 and step2 (`~/radify/server/radify-backup.sh`) pings
`backup-step1` / `backup-step2` after every run (every 6h, so `maxAgeMinutes` is 420). It reads `MONITOR_URL`,
`MONITOR_KEY` and `MONITOR_NAME` from the root-only `/etc/radify/monitor.env` on each server.

## Endpoints

All of them need a key, sent in the `x-key` header (or `?key=`). Without one they return 401 or 404.

| path | key | what |
|---|---|---|
| `POST /hb/<name>` | `HEARTBEAT_KEY` | record a success (body: optional note) |
| `POST /hb/<name>/fail` | `HEARTBEAT_KEY` | record a failure and alert now (body: details) |
| `GET /status` | `HEARTBEAT_KEY` or `ADMIN_KEY` | config, stored state, last ping per heartbeat |
| `GET /__check` | `ADMIN_KEY` | run the cron logic now and return the results |

Pass the key through curl's stdin so it doesn't show up in `ps`:

```bash
printf 'header = "x-key: %s"\n' "$KEY" | curl -fsS -K - --data-binary "note" https://uptime-telegram-worker.akwiat.workers.dev/hb/<name>
```

KV reads can be up to ~60 s stale, so `/status` may lag a fresh ping by a minute.

## Adding a check

- **URL**: add `{ "name": "...", "url": "https://.../healthz" }` to `CHECKS`. Optional fields: `expect`
  (a status or a list, default 200), `redirect: "manual"` (judge a 3xx itself instead of following it), and
  `timeoutMs`. Apps behind the radify Google gate answer `/healthz` with a 307 to the login page. Those use
  `"redirect": "manual", "expect": [200, 307]`, which proves the server, Caddy and the gate are up, but not the
  app itself.
- **Heartbeat**: add `{ "name": "my-job", "maxAgeMinutes": N }` to `HEARTBEATS` (names are `[a-z0-9-]`). Make
  the job POST `/hb/my-job` on success, and `/hb/my-job/fail` on failure if it can. Monitoring starts at the first
  cron run after deploy, so a job that never pings alerts once `maxAgeMinutes` have passed. Pings for names not in
  the config get a 404.

Then run `npx wrangler deploy`. Removing an entry also drops its state.

## Deploy / secrets

```bash
npm install
CLOUDFLARE_API_TOKEN=<workers token> npx wrangler deploy     # Andy: CLOUDFLARE_WORKERS_TOKEN in ~/.config/akwiat/secrets.env
npx wrangler secret put TELEGRAM_BOT_TOKEN                   # from @BotFather
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put HEARTBEAT_KEY                        # also in /etc/radify/monitor.env on the servers
npx wrangler secret put ADMIN_KEY                            # optional, for /__check
npx wrangler tail                                            # live logs
```

KV namespace `UPTIME_KV` holds `state:v2` (check and heartbeat alert state, written only when it changes) and
`hb:<name>` (last ping per heartbeat). That keeps the writes well under the free tier's 1000 per day.

Telegram setup, if you ever need a new bot: talk to @BotFather (`/newbot`) to get the token. Message the bot once,
then read `chat.id` from `https://api.telegram.org/bot<TOKEN>/getUpdates`.
