# WFA Asia — Payments Backend (wfa-pay-BE)

Express/Node backend for the WFA Asia ordering system. Handles menu,
outlets, tables, banners, orders, membership, and real user accounts
via Firestore, media uploads via Cloud Storage, payments via Stripe
Checkout + webhooks, and order notifications via WhatsApp, Telegram,
and email. Serves every WFA Asia frontend — `FD-payment`,
`wfa-live-orders`, `wfa-order-ready`, and eventually `wfa-pos`.

- **Frontend repos**: `Xelate1976/FD-payment`, `wfa-live-orders`,
  `wfa-order-ready`
- **Live (Cloud Run)**: https://wfa-pay-be-191248130012.asia-southeast1.run.app
- **Live (Render, legacy/backup)**: https://wfa-pay-be.onrender.com

---

## What's in here

- **Real auth** — hashed passwords, signed tokens, three roles
  (outlet/group/master), server-enforced data scoping
- **Server-verified pricing** — every checkout amount (online and POS)
  is computed from the real menu and real tax settings in Firestore,
  never trusted from the request itself
- **Stripe Checkout + webhook** — creates sessions, records paid
  orders reliably (survives a guest's browser never completing the
  return trip), fires notifications
- **Order/queue numbering** — permanent per-outlet order numbers,
  toggleable queue numbers, transaction-safe against duplicates
- **Order ready status** — server-tracked (not per-device): ready →
  on the public board → collected (removed) → re-broadcastable if
  cleared by mistake
- **Membership** — first-order discount + separate marketing consent,
  transaction-guarded against double use
- **POS** — staff-entered cash orders, same numbering/notification/
  pricing pipeline as online orders, no Stripe involved
- **Rate limiting** — strict on login/bootstrap, looser everywhere else
- **Firestore** — persistent storage for outlets, menu, tables,
  banners, orders, members, users, and counters
- **Cloud Storage** — real file storage for uploaded media
- **Notifications** — WhatsApp (Green-API), Telegram, and email
  (Resend), each independently optional, configurable **per outlet**
- **CORS** — supports multiple allowed origins at once (comma-separated
  `ALLOWED_ORIGIN`), since several frontends now share this backend

---

## Environment variables

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the registered webhook endpoint (`whsec_...`) |
| `ALLOWED_ORIGIN` | **Comma-separated** list of every frontend's deployed origin — no trailing slashes, no spaces around commas |
| `AUTH_TOKEN_SECRET` | Long random string signing login tokens. If unset, a temporary one is generated per process — every login gets invalidated on the next restart/redeploy, fine for testing, not for real use |
| `ADMIN_API_KEY` | Shared secret protecting `/outlet-secrets/*` and `/auth/bootstrap-master` |
| `GCS_BUCKET_NAME` | Cloud Storage bucket name for media uploads |
| `FIRESTORE_DATABASE_ID` | Firestore database ID — see gotcha below, this is **not** `(default)` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | (Render only) explicit service account credentials JSON |
| `GREENAPI_INSTANCE_ID` / `GREENAPI_API_TOKEN` | Shared fallback WhatsApp credentials |
| `MERCHANT_WHATSAPP_NUMBER` / `SUPPLIER_WHATSAPP_NUMBER` | Shared fallback WhatsApp recipient numbers (digits only, no `+`) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Shared fallback Telegram credentials |
| `RESEND_API_KEY` / `RECEIPT_FROM_EMAIL` | Email receipts to customers |

**Dependencies** (`package.json` — must include all of these or the
deploy fails with `ERR_MODULE_NOT_FOUND`):
`express`, `cors`, `stripe`, `dotenv`, `firebase-admin`,
`@google-cloud/storage`, `express-rate-limit`. (`crypto` is Node's
own built-in, no install needed.)

---

## Security — server-side price verification

Every checkout amount is now **re-derived from real data**, never
trusted from what the request claims:

1. `create-checkout-session` and `pos/complete-order` both take the
   cart's `items` (id, qty, kind, selected modifiers) and look each one
   up against the **real, current menu** in Firestore — chain catalog +
   that outlet's own price overrides + availability
2. Any item that doesn't exist, is inactive, or references a modifier
   that doesn't actually belong to it is **rejected outright** — not
   silently patched over
3. GST and service charge are computed from the outlet's **real** tax
   settings, using the exact same math as the frontend
   (`computeOrderTotals()`, kept deliberately identical on both sides)
4. The client-sent `amount`/`subtotal`/`serviceCharge`/`gst`/`total`
   fields are **never used for what actually gets charged** — only the
   server-computed numbers are

**A related gap closed at the same time**: the guest's own browser
fallback push (`POST /orders`, used for instant UI feedback / as a
backup if the primary recording path fails) used to accept a full
client-constructed order object with `merge: true`. If that call
landed *after* the real, verified order was already recorded, it could
silently overwrite the verified total with whatever the browser
believed. Fixed by stripping `total`/`subtotal`/`serviceCharge`/`gst`/
`items` from what that endpoint can ever write — those fields are only
ever set by the verified path now.

**Payment methods**: `create-checkout-session` no longer hardcodes
`payment_method_types: ["card"]`. That line was silently overriding
whatever's enabled in Stripe Dashboard → Settings → Payment methods
(PayNow, GrabPay, Apple Pay, etc.) — removing it lets Stripe show
whatever's actually turned on there (dynamic payment methods).

---

## Rate limiting

Two tiers, via `express-rate-limit`:
- **Strict** (`authLimiter`) on `/auth/login` and
  `/auth/bootstrap-master` — 10 attempts per IP per 15 minutes. Real
  people mistyping a password are unaffected; brute-force scripts are
  effectively blocked.
- **General** (`generalLimiter`, applied globally) — 120 requests per
  IP per minute. Generous enough for real usage (Live Orders polling
  every 5s, customers browsing); mainly guards against scripted abuse
  driving up Cloud Run's per-request billing.

Requires `app.set("trust proxy", 1)` — Cloud Run sits behind Google's
load balancer, so without this, every request would appear to come
from the same proxy IP instead of the real client.

---

## Auth

Three roles, each carrying a **scope**:

| Role | `scope` is | Sees |
|---|---|---|
| `outlet` | one outlet id | Only that outlet |
| `group` | one chain name | Every outlet under that chain |
| `master` | `null` | Everything |

**Passwords**: hashed with Node's built-in `scrypt` (no extra
dependency, memory-hard). **Tokens**: a minimal hand-rolled
HMAC-SHA256 signed payload — same idea as a JWT, intentionally smaller
and fully auditable in this one file rather than a black-box library.
7-day expiry.

**A known, deliberate tradeoff**: tokens are returned in the JSON
response body and stored in `localStorage` on the frontend, not in an
`httpOnly` cookie. Cookie-based storage would be more resistant to XSS
token theft, but requires the backend to set `Set-Cookie`, CORS
`credentials: true`, and CSRF protection — a real change, more
involved given multiple separate frontend origins (ordering site, Live
Orders, Order Ready, POS) would all need the cookie shared correctly.
Worth revisiting, not yet done.

**Endpoints:**
- `POST /auth/login` — rate-limited, returns a token
- `GET /auth/me` — verify a token, get back role/scope/name
- `POST /auth/bootstrap-master` — creates the **first** master account
  only (refuses once any user exists), gated behind `x-admin-key` *and*
  rate-limited
- `POST /auth/users`, `GET /auth/users`, `DELETE /auth/users/:email` —
  master manages all other accounts

**Creating the first account** (one-time, no UI for this deliberately):
```bash
curl -X POST https://wfa-pay-be-191248130012.asia-southeast1.run.app/auth/bootstrap-master \
  -H "Content-Type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -d '{"email":"you@example.com","password":"yourpassword123","name":"Your Name"}'
```

**What's actually protected:** `GET /orders` and `GET /notifications`
use *soft* auth — no token returns an empty array rather than a 401,
since the customer-facing ordering site calls these too on every load
(for demo-seed checking) and shouldn't error out. `POST /store/:key`
(writes to menu/outlets/tables/banners) uses *hard* `requireAuth` — a
401 if not logged in. This closed a real pre-existing hole: before
this, **anyone on the internet** could overwrite the entire menu with
zero authentication.

---

## Order numbers & queue numbers

`assignOrderAndQueueNumbers(outletId)` — Firestore-transaction-safe,
same reasoning as the notification dedup below: a plain
read-increment-write has a race window where two near-simultaneous
orders could both grab the same number.

- **Order number**: per-outlet, continuously incrementing, never resets
- **Queue number**: only assigned while that outlet's
  `queueModeEnabled` flag is on; `POST /counters/:outletId/reset-queue`
  resets it to 0 (so the next order becomes #1) — called by the
  frontend every time queue mode gets switched on

Both numbers are idempotent against the webhook and `/order-paid`
racing each other for the same order — whichever call recorded it
first "wins," the second reuses the existing numbers rather than
burning fresh ones.

---

## Order ready status

Real, server-tracked — not a per-device thing. Three states an order
moves through: **active** (not yet ready) → **on the board** (ready,
not collected) → **collected** (removed from the board). This is what
makes every screen (dashboard Live Orders tab, the standalone kiosk
site, *and* the public customer-facing board) agree on what's actually
happening.

- `POST /orders/:id/mark-ready` — marks one order ready, outlet-scoped
- `POST /orders/mark-all-ready` — bulk version, powers "Clear all"
- `POST /orders/:id/mark-collected` — takes it OFF the public board —
  distinct from "ready": ready means kitchen's done, collected means
  the customer actually has it in hand
- `POST /orders/:id/rebroadcast` — puts it back on the board (fixes an
  accidental "Collected" tap, or a customer saying they were never
  called), refreshes `readyAt` so it shows as freshly-arrived again
- `GET /orders/ready-board?outlet=X` — **deliberately public, no
  login**. Unlike every other order endpoint, this must never return
  customer name/email/phone/items — only order number, queue number,
  and when it became ready. Collected orders are filtered out; a
  30-minute window is a safety net for anything that never gets
  manually marked collected at all.

⚠️ `mark-all-ready` and `ready-board` use Firestore compound queries
that need a one-time composite index. The first time each runs,
Firestore's error response includes a direct link to create it — check
Cloud Run's logs if either looks stuck rather than actually broken.

---

## Membership

`members` collection, keyed by email — global across every outlet and
brand (not scoped per outlet or chain).

- First-order discount (10%) checked and applied **server-side**,
  inside a Firestore transaction, baked directly into whatever amount
  gets charged (Stripe checkout or POS cash total) — never just a
  frontend display trick
- Marketing consent is a **separate** field from the discount itself —
  someone can remain a member while opting out of promos
- `POST /members/unsubscribe` — withdraws marketing consent only,
  no login required (matches how any unsubscribe link needs to work),
  doesn't leak whether an email is registered
- `MEMBERSHIP_CONSENT_VERSION` is stamped on every member record, so
  it's always clear which version of the consent wording someone
  actually agreed to

---

## POS — cash orders

`POST /pos/complete-order` — requires login, outlet-scoped (an outlet
login can only complete sales for their own outlet; group/master for
outlets within their scope). Prices are server-verified exactly like
online checkout (see Security section above) — no Stripe involved at
all, but reuses:

- The same real-menu price lookup and verification
- The same order/queue numbering as online orders
- The same membership discount transaction logic
- The same `notifyOnPayment()` — WhatsApp/Telegram/email all fire
  identically regardless of payment channel

Orders get `paymentMethod: "cash"` and `staffUser: <who processed it>`
for real accountability, distinguishing them from Stripe-paid orders
in Reports.

---

## Order notifications — WhatsApp, Telegram, email

### WhatsApp (Green-API)
Per-outlet instance/token, configured from the dashboard's Outlets
panel — includes live QR-code linking (auto-refreshes every 15s) and
status polling, no need to leave the dashboard.

### Telegram
Simpler and more reliable — no device linking, just a bot token + chat
ID.
1. Message **@BotFather**, `/newbot`, get a token
2. Save it for the outlet (or as the shared `TELEGRAM_BOT_TOKEN`
   fallback)
3. Message the bot once from the target chat
4. Use "Find my Chat ID" (calls `GET /outlet-secrets/:outletId/telegram-chat-id`)

If that button comes back empty despite a confirmed-correct token: the
reliable manual workaround is messaging **@userinfobot** (an
independent utility bot) — its reply is your numeric ID, and for a
private 1-on-1 chat with any bot, that number **is** the chat ID.
Things worth checking first: wrong token (verify via `getMe`), a
webhook already registered on that bot (`getWebhookInfo` — a non-empty
`url` means Telegram routes updates there instead), or group privacy
mode blocking the bot from seeing messages.

### Email via Resend
Customer receipts only, not a merchant alert channel. Needs
`RESEND_API_KEY` and a real verified `RECEIPT_FROM_EMAIL` before going
live.

### Why notifications used to arrive twice
`notifyOnPayment()` is called from both the Stripe webhook and
`/order-paid` (a frontend convenience call for instant UI feedback).
Fixed via `markNotifiedOnce(sessionId)` — a Firestore **transaction**
sets a `notified` flag, so only whichever call arrives first actually
sends anything.

---

## Credentials — how Firestore/Storage auth works

Two paths, falling through gracefully:

1. **Explicit key** (`GOOGLE_SERVICE_ACCOUNT_JSON` set) — used on
   **Render**, which has no built-in Google Cloud identity
2. **Application Default Credentials (ADC)** — used on **Cloud Run**
   automatically via the attached service account, no key file needed

Startup logs which path was used. If Firestore doesn't connect at all,
the app falls back to a fully **in-memory** store — fine for quick
testing, but everything resets on restart/redeploy, role-based data
scoping degrades to master-only, and **price verification for
checkout is unavailable entirely** (it requires real menu data, so
checkout is blocked with a clear error rather than falling back to
trusting the client).

---

## Deploying

### Cloud Run — primary
Continuous deploy from GitHub `main` via Developer Connect +
buildpacks. The Cloud Build service account
(`[PROJECT_NUMBER]-compute@developer.gserviceaccount.com`) needs the
**"Developer Connect Read Token Accessor (Beta)"** role in IAM & Admin
→ IAM, or every build fails at `FETCHSOURCE` with a 403.

**"Redeploy" doesn't pull new code** — it rebuilds the exact same
snapshot. Always push a real commit; check the build log for a new
image hash to confirm it picked up the change.

### Render — legacy/backup
- https://wfa-pay-be.onrender.com
- Uses `GOOGLE_SERVICE_ACCOUNT_JSON` for auth
- Free tier spins down after ~15 min idle — cold-start delay on the
  first request after that
- **Same `package.json` feeds both platforms** — a missing dependency
  breaks both Render and Cloud Run identically, not just one

---

## Known gotchas

### Firestore database name — the #1 silent failure
`(default)` is empty; the real database is `wfa-data`. If
`FIRESTORE_DATABASE_ID` is unset or `(default)`, every read/write
silently fails with `{"error":"5 NOT_FOUND: "}` — no stack trace, just
empty responses. Always confirm `FIRESTORE_DATABASE_ID=wfa-data` in
whatever environment you're deploying to, and check the startup log
line says `database: "wfa-data"`.

**Quick check**: console.cloud.google.com → Firestore → Firestore
Studio → breadcrumb should read `Database: wfa-data`, with real
documents in the `kv`, `users`, `members`, `orders`, and `counters`
collections.

### Firestore security rules — not yet locked down, worth checking
Since the frontend never talks to Firestore directly (only through
this backend, via the Admin SDK, which bypasses rules entirely), this
matters less than usual — but if the database was ever created in
Firestore's default "test mode," anyone with the Firebase project ID
could read/write directly via the client SDK, completely bypassing
this backend's auth and price verification. Check Firestore → Rules in
the console; if it's still the test-mode default, lock it down with a
deny-all rule (safe, since nothing legitimate uses the client SDK
anyway):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

### Firestore composite indexes
A few newer endpoints (`mark-all-ready`, `ready-board`, queue reset)
use compound `where()` queries that need a one-time index. First run
throws an error with a direct creation link — check Cloud Run's logs.

### CORS mismatches are silent
A missing origin in `ALLOWED_ORIGIN` doesn't throw an obvious
server-side error — requests just get blocked by the browser. Always
double-check for exact matches (no trailing slash) across every
frontend if API calls stop working after adding a new site.

### Cloud Storage IAM
The service account needs **Storage Object Admin** explicitly granted,
or uploads fail silently.

### `server.js` exists in every frontend repo too
Always double-check which repo you're editing in — backend logic
belongs here, in `wfa-pay-BE`, not in any frontend.

### Verifying a deployment actually works
Don't trust the dashboard/console alone — hit a real endpoint directly:
```
https://wfa-pay-be-191248130012.asia-southeast1.run.app/store/wfa-outlets
```

---

## Stripe webhook setup

`POST /webhook`, listens for `checkout.session.completed`. Uses
`express.raw()` (not `express.json()`) for this route specifically,
since signature verification needs the raw body.

1. Stripe Dashboard → Developers → Webhooks → Add destination
2. Endpoint URL: `<backend URL>/webhook`
3. Select `checkout.session.completed`
4. Copy the signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`

**Test and live mode webhooks are entirely separate** — switching keys
requires registering a new webhook too. Same applies when switching
to a different Stripe account entirely — the webhook doesn't carry
over, it needs re-registering on the new account.

---

## Local development

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env`. Without `GOOGLE_SERVICE_ACCOUNT_JSON`
set, the app uses the in-memory fallback automatically (with the
checkout-blocking caveat noted in the Credentials section above).
