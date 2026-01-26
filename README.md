# Uptime Monitor (Cloudflare Workers + Telegram)

This Worker hits a health endpoint every 5 minutes (Cron Trigger) and sends you a Telegram message **only when it goes down** (transition from up→down).
Optionally, it can also notify you when it recovers.

---

## 1) Prereqs

- Node.js 18+ (Node 20+ recommended)
- A Cloudflare account with Workers enabled
- Telegram installed

---

## 2) Create a Telegram bot + get what you need

### A) Create a bot token
1. In Telegram, search for **@BotFather**
2. Start the chat and run: `/newbot`
3. Follow prompts to set a bot name + username
4. BotFather will give you a token that looks like: `123456789:ABCDEF...`
   - This is your **TELEGRAM_BOT_TOKEN**

Telegram’s official tutorial: https://core.telegram.org/bots/tutorial

### B) Get your chat_id
The quickest method:
1. Search for **@get_id_bot** (or similar “get my id” bots) and start it
2. It will show you your **chat id** (often a number like `123456789`)

Alternative method:
- Send a message to your bot first, then open:
  `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
  and look for `message.chat.id` in the JSON response.

---

## 3) Unzip + install

```bash
unzip uptime-telegram-worker.zip
cd uptime-telegram-worker
npm install
```

---

## 4) Login to Cloudflare (Wrangler)

```bash
npx wrangler login
```

Docs: https://developers.cloudflare.com/workers/get-started/guide/

---

## 5) Create a KV namespace (to store last state)

Create it:

```bash
npx wrangler kv namespace create UPTIME_KV
```

Copy the returned **id** into `wrangler.toml`:

```toml
kv_namespaces = [
  { binding = "UPTIME_KV", id = "PASTE_ID_HERE" }
]
```

---

## 6) Set your healthcheck URL + behavior

Edit `wrangler.toml`:

- `HEALTHCHECK_URL` (your endpoint)
- `EXPECT_STATUS` (usually 200)
- `TIMEOUT_MS` (e.g. 8000)
- `CHECK_NAME` (nice label)
- `RECOVERY_NOTIFY` to `"true"` if you want “Recovered” messages

---

## 7) Add secrets (Telegram token + chat id)

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

Optional (recommended if you’ll use the manual HTTP endpoint):
```bash
npx wrangler secret put ADMIN_KEY
```

Secrets docs: https://developers.cloudflare.com/workers/configuration/secrets/

---

## 8) Deploy

```bash
npx wrangler deploy
```

Wrangler commands reference: https://developers.cloudflare.com/workers/wrangler/commands/

---

## 9) Test it

After deploy, Wrangler prints a URL like:
`https://uptime-telegram-worker.<your-subdomain>.workers.dev`

Open:

- `https://.../`  (or `/__check`)

If you set `ADMIN_KEY`, include:
- `https://.../__check?key=YOUR_ADMIN_KEY`

You should get a JSON response with `isUp`, `latencyMs`, and stored state.

---

## How the “down alert” works

- It checks every 5 minutes (configured in `wrangler.toml` cron triggers).
- It sends a Telegram alert **only when status changes from up/unknown to down**.
- While it stays down, it won’t spam you every 5 minutes.
- When it comes back up, it can optionally send a recovery message (`RECOVERY_NOTIFY="true"`).

Cron triggers docs: https://developers.cloudflare.com/workers/configuration/cron-triggers/

---

## Troubleshooting

### See logs live
```bash
npx wrangler tail
```

### Common issues
- **No messages**: confirm your chat id, and that the bot can message you (you must have started a chat with your bot at least once).
- **Wrong endpoint**: verify HEALTHCHECK_URL and EXPECT_STATUS in wrangler.toml
- **KV not set**: make sure you replaced `REPLACE_ME_WITH_KV_ID` in wrangler.toml

