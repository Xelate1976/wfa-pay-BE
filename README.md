# WFA Asia — Payments Backend (wfa-pay-BE)

Express/Node backend for the WFA Asia ordering system. Handles menu,
outlets, tables, and banner data via Firestore, media uploads via
Cloud Storage, payments via Stripe Checkout + webhooks, and order
notifications via WhatsApp, Telegram, and email. Serves the
`FD-payment` frontend.

- **Frontend repo**: `Xelate1976/FD-payment`
- **Live (Cloud Run)**: https://wfa-pay-be-191248130012.asia-southeast1.run.app
- **Live (Render, legacy/backup)**: https://wfa-pay-be.onrender.com

---

## What's in here

- **Stripe Checkout** — creates checkout sessions for cart orders,
  redirects same-tab
- **Stripe webhook** (`POST /webhook`) — listens for
  `checkout.session.completed`, records the paid order and fires
  notifications
- **Firestore** — persistent storage for outlets, menu, tables,
  banners, orders, and notifications (all under a `kv` collection)
- **Cloud Storage** — real file storage for uploaded menu photos and
  banner media (images/GIFs/MP4), so Firestore's 1MiB document limit
  isn't a bottleneck
- **Order notifications** — WhatsApp (via Green-API), Telegram, and
  email (via Resend), each independently optional and configurable
  **per outlet** — see below
- **CORS** — locked to a single allowed origin (the deployed frontend)
  via `ALLOWED_ORIGIN`

---

## Environment variables

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the registered webhook endpoint (`whsec_...`) |
| `ALLOWED_ORIGIN` | Frontend's deployed origin, e.g. `https://fd-payment.vercel.app` — **no trailing slash** |
| `GCS_BUCKET_NAME` | Cloud Storage bucket name for media uploads, e.g. `wfa-project-504813-media` |
| `FIRESTORE_DATABASE_ID` | Firestore database ID — see gotcha below, this is **not** `(default)` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | (Render only) explicit service account credentials JSON. Not needed on Cloud Run — see Credentials section below |
| `ADMIN_API_KEY` | Shared secret protecting the `/outlet-secrets/*` endpoints — see Notifications section below |
| `GREENAPI_INSTANCE_ID` / `GREENAPI_API_TOKEN` | Shared fallback WhatsApp (Green-API) credentials, used by any outlet that hasn't set its own |
| `MERCHANT_WHATSAPP_NUMBER` / `SUPPLIER_WHATSAPP_NUMBER` | Shared fallback WhatsApp recipient numbers (digits only, no `+`) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Shared fallback Telegram credentials, used the same way as the Green-API fallback above |
| `RESEND_API_KEY` / `RECEIPT_FROM_EMAIL` | Email receipts to customers via Resend |

A `.env.example` in this repo lists these for local development.

---

## Credentials — how auth works

This backend tries two credential paths, falling through gracefully:

1. **Explicit key** (`GOOGLE_SERVICE_ACCOUNT_JSON` env var set) — parses
   the JSON and authenticates with it directly. This is the path used
   on **Render**, since Render has no built-in Google Cloud identity.
2. **Application Default Credentials (ADC)** — if no explicit key is
   set, tries ADC instead. On **Cloud Run**, this just works
   automatically using the service's attached service account — no
   key file needed. Anywhere else without `gcloud auth` configured
   (a bare laptop, etc.), this throws, and the app falls through to
   an in-memory fallback rather than crashing entirely.

Startup logs which path was used:
```
Firestore connected via ADC (database: "wfa-data") — data will persist across restarts.
```
or
```
Firestore connected via explicit key (database: "wfa-data") — data will persist across restarts.
```

If Firestore doesn't connect at all (bad credentials, wrong project,
etc.), the app falls back to a fully **in-memory** store — fine for
quick testing, but everything resets on restart/redeploy.

---

## Order notifications — WhatsApp, Telegram, email

Each order-paid event fires up to three channels, all independently
optional:

### Per-outlet vs. shared fallback
Every outlet can have its **own** WhatsApp/Telegram credentials —
useful since each physical location often has its own staff phone or
group chat. Set from the dashboard (**Merchant → Outlets → WhatsApp**
button on each outlet row). If an outlet hasn't configured its own,
notifications fall back to the shared `GREENAPI_*`/`TELEGRAM_*` env
vars above. This resolution happens automatically in
`notifyOnPayment()` — no code changes needed to onboard a new outlet's
own number.

### Why outlet credentials live in a separate Firestore collection
Per-outlet WhatsApp tokens and Telegram bot tokens are stored in a
dedicated `outletSecrets` collection — **not** mixed into the public
`kv/wfa-outlets` document that the customer ordering page fetches
openly. Mixing secrets into a document a guest's browser can read
would leak them straight into browser dev tools.

### `requireAdminKey` — protecting the outlet-secrets endpoints
All `/outlet-secrets/*` routes require an `x-admin-key` header
matching the `ADMIN_API_KEY` env var. If `ADMIN_API_KEY` isn't set,
the check is skipped (convenient for local dev — set it before going
live). The dashboard prompts for this key at runtime rather than
hardcoding it in the frontend bundle — see the frontend README for why
that distinction matters.

**Endpoints:**
| Route | Purpose |
|---|---|
| `GET /outlet-secrets/:outletId` | Fetch an outlet's saved WhatsApp/Telegram config |
| `POST /outlet-secrets/:outletId` | Save/update an outlet's config (merges, doesn't overwrite unset fields) |
| `GET /outlet-secrets/:outletId/qr` | Proxies Green-API's QR endpoint — lets the dashboard show a live "scan to link" QR code without opening Green-API's own console |
| `GET /outlet-secrets/:outletId/wa-status` | Polls whether that outlet's WhatsApp instance is authorized yet, so the dashboard can auto-detect a successful scan |
| `GET /outlet-secrets/:outletId/telegram-chat-id` | Looks up a Telegram chat's numeric ID automatically via `getUpdates`, after the merchant has messaged the bot once — saves hunting through Telegram's raw API by hand |

### WhatsApp via Green-API
Wraps a WhatsApp Web session in a REST API — no Meta Business
verification or template approval needed, so it's fast to set up.
Trade-off: it's not the official WhatsApp Business Platform, so it's
best suited to low-volume internal alerts (a merchant/supplier
number), not bulk customer-facing messaging. The WhatsApp *number*
itself needs to be linked once via QR code (console.green-api.com, or
directly from the dashboard's "Show QR to link" button) before
messages will actually deliver — an unlinked instance queues messages
without sending them, which looks like a silent failure if you don't
know to check.

**Common failure modes:**
- **QR code expired before scanning** — Green-API QR codes expire in
  ~15–20s. The dashboard's QR display auto-refreshes every 15s to
  cover this; if linking through Green-API's own console instead,
  regenerate the code right before scanning.
- **"Can't link new devices right now"** on WhatsApp's side — usually
  an expired/stale QR (see above), occasionally WhatsApp's own
  4-linked-device cap, rarely a temporary rate limit after several
  attempts in a short window.

### Telegram
Simpler and more reliable than WhatsApp for this use case — no device
linking, no expiring codes, just a bot token + chat ID.
1. Message **@BotFather** on Telegram, `/newbot`, follow the prompts →
   get a token like `123456789:ABC-defGhIJKlmNoPQ`
2. Save that token for the outlet (or as the shared `TELEGRAM_BOT_TOKEN`
   fallback)
3. Message the bot once from the chat you want alerts in
4. Use the dashboard's "Find my Chat ID" button (or call
   `GET /outlet-secrets/:outletId/telegram-chat-id` directly) to
   auto-fill the chat ID

#### If "Find my Chat ID" comes back empty
This has happened even with a freshly created bot, a confirmed-correct
saved token (verified directly against Firestore), and messages that
show as delivered (double checkmarks) in the Telegram client — with
`getUpdates` still reporting `"result":[]`, checked both from a
browser and from the backend itself. Root cause unconfirmed; possibly
a propagation delay on very new bots. Rather than chase it further in
the moment, there's a reliable manual workaround:
1. In Telegram, message **@userinfobot** (a long-running, independent
   community utility bot — not affiliated with this project)
2. It replies instantly with your numeric Telegram user ID
3. For a private 1-on-1 chat with any bot, that number **is** the chat
   ID — paste it directly into the **Telegram Chat ID** field and Save,
   skipping "Find my Chat ID" entirely

Things worth ruling out first if this comes up again:
- **Wrong token** — confirm via `GET https://api.telegram.org/bot<TOKEN>/getMe`
  that the `username` matches the bot you're actually messaging
- **A webhook already registered on that bot** — check
  `GET https://api.telegram.org/bot<TOKEN>/getWebhookInfo`; a non-empty
  `url` means Telegram is routing updates there instead of to
  `getUpdates`, and `deleteWebhook` needs to be called first
- **Group chat with bot privacy mode on** — bots can't see regular
  group messages by default; turn off Group Privacy for that bot via
  BotFather → `/mybots` → Bot Settings, or just message it directly
  instead of in a group

### Email via Resend
Sends a receipt to the *customer's* email on successful payment (not
a merchant alert channel like the two above). Requires `RESEND_API_KEY`
and, optionally, `RECEIPT_FROM_EMAIL` (defaults to a placeholder
address — set this to a real verified sending domain before going
live).

### Why notifications used to arrive twice
`notifyOnPayment()` is called from **two** places — the Stripe webhook
(`POST /webhook`, the reliable source of truth) and `/order-paid` (a
convenience call the frontend makes for instant UI feedback once it
notices payment succeeded via polling). Both routinely fire for the
same order within moments of each other, so without a guard, every
WhatsApp/Telegram/email notification went out **twice** per order.

Fixed via `markNotifiedOnce(sessionId)` — checks/sets a `notified`
flag on that session's `checkoutPending` Firestore document inside a
**transaction**, not a plain read-then-write. The transaction matters
specifically because a plain check has a race window where both
near-simultaneous calls could see "not yet notified" before either one
writes the flag — a transaction makes only one of them actually win.
Without Firestore configured (in-memory fallback mode), a simple
in-memory `Set` does the same job for a single server instance, though
it won't dedupe across multiple Cloud Run instances in that fallback
mode — one more reason Firestore should be considered required for any
real deployment, not just nice-to-have.

---

## Deployment

### Cloud Run (asia-southeast1) — primary
- Service: `wfa-pay-be`
- Region: `asia-southeast1`
- URL: https://wfa-pay-be-191248130012.asia-southeast1.run.app
- Continuously deployed from GitHub `main` via **Developer Connect +
  Google Cloud buildpacks** (no Dockerfile needed — buildpacks
  auto-detect Node.js from `package.json`)
- Entrypoint: `node server.js` (set explicitly, since there's no
  `"start"` script assumption to rely on)
- Env vars set in **Cloud Run → Edit & deploy new revision → Variables
  & Secrets** (see table above)
- Auth: Application Default Credentials (no `GOOGLE_SERVICE_ACCOUNT_JSON`
  needed here — the Cloud Run service account handles it)

**One-time IAM setup required**: the Cloud Build service account
(`[PROJECT_NUMBER]-compute@developer.gserviceaccount.com`) needs the
**"Developer Connect Read Token Accessor (Beta)"** role granted in
IAM & Admin → IAM. Without it, every GitHub-triggered build fails at
the `FETCHSOURCE` step with:
```
ERROR: error fetching DeveloperConnect credentials: googleapi: Error 403:
Permission 'developerconnect.gitRepositoryLinks.fetchReadToken' denied
```

**Deploying real changes vs. "Redeploy"**: Cloud Run/Vercel's
"Redeploy" option rebuilds the *exact same* previously-built snapshot
— it does **not** pull new commits from GitHub, no matter how many
times you click it. Always push a real, new commit to trigger a fresh
build; check the build log for a new bundle/image hash to confirm it
actually picked up your latest change.

### Render — legacy/backup
- URL: https://wfa-pay-be.onrender.com
- Uses `GOOGLE_SERVICE_ACCOUNT_JSON` for Firestore/Cloud Storage auth
  (Render has no native Google Cloud identity, unlike Cloud Run)
- Free tier spins down after ~15 min idle — first request after that
  has a cold-start delay

---

## Known gotchas

### Firestore database name — the #1 silent failure
Firestore projects can have multiple databases. This project has two:
- `(default)` — **empty**, created automatically by Google Cloud, not
  used
- `wfa-data` — the **real** database, holds everything (outlets, menu,
  banners, tables, orders, outletSecrets) under the `kv` and
  `outletSecrets` collections

If `FIRESTORE_DATABASE_ID` is unset or set to `(default)`, every
read/write silently fails with:
```json
{"error":"5 NOT_FOUND: "}
```
No stack trace, no obvious error — just empty responses. This has cost
real debugging time before. **Always confirm
`FIRESTORE_DATABASE_ID=wfa-data`** in whatever environment you're
deploying to (Render env, Cloud Run env vars, local `.env`, etc.).
Verify by checking the startup log line — it should say
`database: "wfa-data"`, not `database: "(default)"`.

#### How to check which Firestore database you're actually looking at
1. Go to **console.cloud.google.com** → search "Firestore" in the top
   search bar
2. Click **Firestore Studio** in the left sidebar
3. Look at the top breadcrumb: `All databases > Database: wfa-data` —
   that's the database you're currently browsing
4. Click **"All databases"** to see every database in the project and
   check whether `(default)` is empty
5. Confirm your target database has a `kv` collection with real
   documents (`wfa-outlets`, `wfa-menu`, `wfa-banners`, `wfa-tables`)

**Quick sanity check via query** — run in Firestore Studio:
```
db.pipeline().collection('/kv').limit(100)
```
Real rows back = correct database. Nothing back = you're probably in
`(default)`.

### Cloud Storage IAM
The service account running this backend needs the **Storage Object
Admin** role explicitly granted, or media uploads fail silently with
no clear error message.

### Cloud Build / Developer Connect permissions
See the Cloud Run deployment section above — the **Developer Connect
Read Token Accessor (Beta)** IAM role is required on the Cloud Build
service account for GitHub-triggered builds to succeed.

### Order writes — race conditions
Order saving uses **append-only** endpoints, not whole-array
overwrites, to avoid concurrent write collisions when multiple orders
come in around the same time.

### `server.js` exists in both repos
Both `FD-payment` and `wfa-pay-BE` have a file named `server.js` (or
similarly-named entry files) — always double-check which repo you're
editing in before making changes. Backend logic changes belong here,
in `wfa-pay-BE`, not in the frontend repo.

### Verifying a deployment actually works
Don't trust the Render dashboard or Firestore Studio console alone —
both have been slow/unreliable for confirming state. Instead, hit a
real API endpoint directly and check for actual JSON data, e.g.:
```
https://wfa-pay-be-191248130012.asia-southeast1.run.app/store/wfa-outlets
```

---

## Stripe webhook setup

The webhook handler lives at `POST /webhook` and listens for
`checkout.session.completed`. It uses `express.raw()` (not
`express.json()`) for this route specifically, since Stripe's
signature verification requires the raw, unparsed request body.

To register the webhook in Stripe:
1. Stripe Dashboard → **Developers → Webhooks → Add destination**
2. Endpoint URL: `<your backend URL>/webhook` — e.g.
   `https://wfa-pay-be-191248130012.asia-southeast1.run.app/webhook`
3. Select the `checkout.session.completed` event (and optionally
   `checkout.session.expired`)
4. After creating it, reveal and copy the **signing secret**
   (`whsec_...`) — this goes into `STRIPE_WEBHOOK_SECRET`

**Test mode and live mode webhooks are entirely separate.** Setting
one up doesn't carry over to the other — if you switch from test to
live Stripe keys, you need to register a new live-mode webhook
endpoint too.

---

## Local development

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env` and fill in your own values — for local
testing without Firestore, just leave `GOOGLE_SERVICE_ACCOUNT_JSON`
unset and the app will use the in-memory fallback automatically.
