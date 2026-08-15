# WFA Asia — Payments Backend (wfa-pay-BE)

Express/Node backend for the WFA Asia ordering system. Handles menu,
outlets, tables, banners, orders, membership, and real user accounts
via Firestore, media uploads via Cloud Storage, payments via Airwallex
(hosted payment page + webhooks), and order notifications via
WhatsApp, Telegram, and email. Serves every WFA Asia frontend —
`FD-payment`, `wfa-live-orders`, `wfa-order-ready`, and eventually
`wfa-pos`.

- **Frontend repos**: `Xelate1976/FD-payment`, `wfa-live-orders`,
  `wfa-order-ready`
- **Live (Cloud Run)**: https://wfa-pay-be-191248130012.asia-southeast1.run.app
- **Live (Render, legacy/backup)**: https://wfa-pay-be.onrender.com

---

## What's in here

- **Real auth** — hashed passwords, signed tokens, three roles
  (outlet/group/master), server-enforced data scoping. Outlet-role
  logins can now be assigned **more than one outlet**, not just one.
- **Server-verified pricing** — every checkout amount (online and POS)
  is computed from the real menu and real tax settings in Firestore,
  never trusted from the request itself
- **Per-outlet tax overrides** — GST/service charge default to the
  chain's settings, but any specific outlet can override either (e.g.
  one GST-exempt location, or one that doesn't collect a service
  charge) — resolved server-side in `resolveTaxSettingsForOutlet()`,
  the same function that decides what a guest is actually charged
- **Modifier selections are fully recorded** — which options a guest
  picked (not just the base item) are validated, priced, and saved on
  the order itself (`unitLabel`, `modifiers[]`, `modifierSummary`),
  flowing through to Airwallex's checkout breakdown, notifications, and
  Reports — not discarded after pricing the way it used to be
- **Geocoding for the Sales Map** — `/outlets/geocode` turns a
  merchant-entered address into lat/lng, using a backend-only Google
  Geocoding API key (never exposed to the browser) — see Security below
- **Airwallex hosted payment page + webhook** — creates PaymentIntents,
  records paid orders reliably (survives a guest's browser never
  completing the return trip), fires notifications
- **Itemized Airwallex checkout** — guests see a real line-by-line
  breakdown on the payment page itself (each menu item, service
  charge, GST, membership discount), not just one flat total —
  verified safe by construction, see Security section below
- **Order/queue numbering** — permanent per-outlet order numbers,
  toggleable queue numbers, transaction-safe against duplicates
- **Order ready status** — server-tracked (not per-device): ready →
  on the public board → collected (removed) → re-broadcastable if
  cleared by mistake
- **Membership** — first-order discount + separate marketing consent,
  transaction-guarded against double use
- **POS** — staff-entered cash orders, same numbering/notification/
  pricing pipeline as online orders, no payment gateway involved
- **Rate limiting** — strict on login/bootstrap, looser everywhere else
- **Input validation (Zod)** — schema-checked on the endpoints that
  matter most (checkout, POS, login, account creation) before any
  business logic runs
- **Secret Manager** — all real secrets (Airwallex credentials, admin
  key, auth signing key) live in Google Secret Manager, not plain
  Cloud Run env vars
- **Least-privilege IAM** — runs on a dedicated service account
  (`wfa-pay-be-runtime`) scoped to exactly what it needs, not the
  shared default Compute account
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
| `AIRWALLEX_CLIENT_ID` | Airwallex Client ID — exchanged (with the API key) for a short-lived Bearer token |
| `AIRWALLEX_API_KEY` | Airwallex API Key — never exposed client-side, unlike Stripe's old publishable key which needed a frontend counterpart |
| `AIRWALLEX_WEBHOOK_SECRET` | Signing secret from the registered webhook (Airwallex web app → Developer → Webhooks) |
| `AIRWALLEX_ENDPOINT` | API base URL — `https://api.sandbox.airwallex.com` for testing, swap to the production URL when going live. Not sensitive, kept as a plain var (not a secret) |
| `GOOGLE_GEOCODING_API_KEY` | Backend-only key for turning outlet addresses into map coordinates (`/outlets/geocode`). **Must be unrestricted** (no HTTP-referrer restriction) — that restriction only works for browser requests, and this call is server-to-server. Restrict its **API access** to Geocoding API only instead. Kept in Secret Manager. See "Geocoding key gotchas" below — this one has bitten before |
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

**Where these actually live**: `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`,
`AIRWALLEX_WEBHOOK_SECRET`, `ADMIN_API_KEY`, and `AUTH_TOKEN_SECRET`
are all in **Google Secret Manager**, referenced by Cloud Run via
`--update-secrets`, not set as plain env vars. `AIRWALLEX_ENDPOINT` and
the rest of the table above are plain env vars — nothing sensitive
about a base URL or a bucket name.

**Dependencies** (`package.json` — must include all of these or the
deploy fails with `ERR_MODULE_NOT_FOUND`):
`express`, `cors`, `dotenv`, `firebase-admin`,
`@google-cloud/storage`, `express-rate-limit`, `zod`. (`crypto` is
Node's own built-in, no install needed.) **`stripe` is no longer a
dependency** — Airwallex is called directly via `fetch`, no SDK
package required.

---

## Security

### Server-side price verification
Every checkout amount is **re-derived from real data**, never trusted
from what the request claims:

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
   server-computed numbers are, then handed to Airwallex as the
   PaymentIntent amount

**A related gap closed at the same time**: the guest's own browser
fallback push (`POST /orders`, used for instant UI feedback / as a
backup if the primary recording path fails) used to accept a full
client-constructed order object with `merge: true`. If that call
landed *after* the real, verified order was already recorded, it could
silently overwrite the verified total with whatever the browser
believed. Fixed by stripping `total`/`subtotal`/`serviceCharge`/`gst`/
`items` from what that endpoint can ever write — those fields are only
ever set by the verified path now.

### Airwallex itemized breakdown — safe by construction
`create-checkout-session` sends Airwallex an `order.products` array so
guests see a real breakdown on the hosted payment page (each menu
item, then Service Charge and GST as their own lines, then a
**negative** Membership Discount line when one applies) instead of one
opaque total.

This is deliberately not just a display nicety — Airwallex's hosted
page has been observed in real testing to charge based on the **sum of
`order.products`**, not the flat `amount` field, whenever both are
present. An earlier version of this integration sent an itemized
breakdown that only summed to the subtotal (missing GST/service
charge as their own lines) and silently undercharged as a result — the
real fix at the time was to stop sending `order.products` at all.

To bring the breakdown back without repeating that bug: every cent of
`finalAmount` is represented as its own line, and the sum is checked
in code (`productsSum`) **before** the request is ever sent. If it
doesn't match `finalAmount` exactly, checkout is refused with a `500`
rather than risking a silent under/overcharge. If this check is ever
tripped in production, treat it as a real bug worth investigating
immediately, not a fluke to retry past — it means the itemized
breakdown and the actual verified total have diverged.

### Per-outlet tax override resolution — the exact order that matters
`resolveTaxSettingsForOutlet(outletId)` is the single source of truth
for what GST/service charge a guest is actually charged. Resolution
order: **outlet's own override fields (if any) win, anything not
explicitly overridden falls through to the chain's setting, and the
chain falls through to `DEFAULT_TAX_SETTINGS` if nothing's configured
at all.** An override is a *partial* object — only the fields present
on it apply; a merchant enabling "Custom settings" for an outlet in
the dashboard always writes the **complete** five-field object
(`gstEnabled`, `gstRate`, `gstMode`, `serviceChargeEnabled`,
`serviceChargeRate`), not a diff, so once an outlet has an override it
stops following *future* chain-level changes for those fields until
the merchant explicitly reverts it to "Use chain default" (which
deletes that outlet's entry from `wfa-tax-overrides` entirely).

### Modifier selections are validated, priced, AND recorded
`computeVerifiedSubtotal()` does three things with a cart line's
modifier selections, not just the first two it used to: (1) validates
each selected option id actually belongs to that menu item's
`modifierGroup`, (2) sums each option's real `priceDelta` (never
trusting a client-sent price), and (3) **keeps the resolved
selections** — `modifiers: [{id, label, priceDelta}, ...]` (one entry
per unit chosen — "3x Malbec" is three separate entries) plus a
pre-grouped `modifierSummary` string ("Malbec ×3, Cabernet ×5") — on
the object it returns. That object is what gets saved to the order in
Firestore, sent to Airwallex as the line-item name, and used in
WhatsApp/Telegram/email notification text. Before this existed, a
modifier selection was priced correctly but then discarded — the
saved order only ever showed the base item name, and Reports had
nothing to show for which wine was actually poured.

### Secrets — Google Secret Manager, not plain env vars
`AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`, `AIRWALLEX_WEBHOOK_SECRET`,
`ADMIN_API_KEY`, and `AUTH_TOKEN_SECRET` are stored in Secret Manager
and wired into Cloud Run via `--update-secrets`, not as plain
`--update-env-vars`. Plain env vars are visible to anyone with read
access to the Cloud Run service config; Secret Manager adds a genuine
access-control layer on top, auditable independently.

### Least-privilege IAM
Runs on a dedicated `wfa-pay-be-runtime@<project>.iam.gserviceaccount.com`
service account, granted only:
- `roles/datastore.user` (Firestore)
- `roles/storage.objectAdmin`, scoped to the one media bucket, not
  project-wide
- `roles/secretmanager.secretAccessor` on each of the 5 secrets above
  specifically, not a blanket grant

Not the shared default Compute service account, which carries broad
`roles/editor` across the entire project — far more access than this
service actually needs.

### Admin key — fails closed, not open
`requireAdminKey` middleware used to silently let every request
through if `ADMIN_API_KEY` simply wasn't set — meaning a misconfigured
or missing secret turned every admin-protected endpoint into open
access for anyone, with no error at all. Fixed: a missing key now
returns `503` and refuses every request, rather than defaulting to
"everyone's allowed in."

### Input validation (Zod)
Applied to the highest-value endpoints — `/create-checkout-session`,
`/pos/complete-order`, `/auth/login`, `/auth/bootstrap-master`,
`/auth/users`, `/members/unsubscribe`. Rejects malformed requests with
a specific, itemized error before any business logic runs. Purely
structural (right types, right shape) — never decides whether a price
or a login is *valid*, that's still the existing verification logic
doing its job exactly as before.

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
| `outlet` | an **array** of one or more outlet ids | Only those outlet(s) |
| `group` | one chain name | Every outlet under that chain |
| `master` | `null` | Everything |

**Outlet-role accounts can now be assigned multiple outlets** — a
login isn't limited to exactly one location anymore. `scope` is stored
as an array; old accounts created before this change (still a plain
string in Firestore) are normalized to a one-element array
automatically wherever scope is checked, so nothing needed migrating.

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
- `PATCH /auth/users/:email` — edit an existing account's assigned
  outlets (or chain, for group accounts) without deleting and
  recreating it. Previously the only way to add/remove an outlet from
  a login was to delete the whole account and start over, losing its
  password in the process.

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
401 if not logged in.

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
  gets charged (Airwallex checkout or POS cash total) — never just a
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
login can only complete sales for outlet(s) in their own scope;
group/master for outlets within their scope). Prices are
server-verified exactly like online checkout (see Security section
above) — no payment gateway touched at all for POS, but it reuses:

- The same real-menu price lookup and verification
- The same order/queue numbering as online orders
- The same membership discount transaction logic
- The same `notifyOnPayment()` — WhatsApp/Telegram/email all fire
  identically regardless of payment channel

Orders get `paymentMethod: "cash"` and `staffUser: <who processed it>`
for real accountability, distinguishing them from Airwallex-paid
orders in Reports.

---

---

## Sales Map — geocoding

`POST /outlets/geocode` (requires login) takes `{ address }`, calls
Google's Geocoding API server-side with `GOOGLE_GEOCODING_API_KEY`,
and returns `{ lat, lng, formattedAddress }`. Called from the
dashboard's Outlets → 📍 Add location panel, **once per outlet, only
when a merchant actually enters or changes an address** — not on
every Sales Map load. The resulting lat/lng is cached directly on the
outlet record in `wfa-outlets`, so opening the map itself never
triggers a fresh geocoding call.

**Setup, in order:**
1. In the same Google Cloud project already running this backend,
   enable **Geocoding API** (APIs & Services → Library)
2. Create a **new, separate** API key (Credentials → Create
   credentials → API key) — do not reuse the Maps JavaScript API key
   from the frontend
3. Application restrictions: **None** (this key is never sent to a
   browser — restricting by referrer would break it, see the gotcha
   below)
4. API restrictions: restrict to **Geocoding API only**
5. Add the key to Cloud Run as `GOOGLE_GEOCODING_API_KEY`, ideally via
   Secret Manager like the other secrets in this file, and deploy a
   new revision (adding an env var in the console alone doesn't take
   effect until a revision actually redeploys)

See "Geocoding key gotchas" under Known Gotchas below before
troubleshooting a failure here — this setup has a specific, repeatable
failure mode worth reading first.

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
`notifyOnPayment()` is called from both the Airwallex webhook and
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
   automatically via the attached `wfa-pay-be-runtime` service
   account, no key file needed

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

**Granting a new secret access, then switching Cloud Run to use it —
order matters.** Always run `gcloud secrets add-iam-policy-binding`
for the service account *before* `gcloud run services update
--update-secrets`. Doing it the other way round deploys a revision
that immediately fails with a permission-denied error on startup.

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

### Firestore security rules
Confirmed already correctly locked down — a deny-all rule on the
client SDK path:
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
This is safe and doesn't affect the app at all, since the frontend
never talks to Firestore directly — only through this backend, via the
Admin SDK, which bypasses these rules entirely regardless of what they
say.

### Tax settings doc name — a real production bug, fixed
`resolveTaxSettingsForOutlet()` was reading from a Firestore doc called
`wfa-tax-settings-by-chain`, which was completely empty — but the
admin panel (Merchant → Settings) actually writes to a **different**
doc, `wfa-tax-settings`. The result: every checkout silently fell back
to `DEFAULT_TAX_SETTINGS` (`gstEnabled: false, serviceChargeEnabled:
false`), so guests were charged the bare subtotal even though the
dashboard showed GST and service charge correctly configured and
enabled. Confirmed via a direct Cloud Shell Firestore read (not just
eyeballing the console) — `wfa-tax-settings-by-chain` had `{}`,
`wfa-tax-settings` had the real, correct per-chain settings. Fixed by
pointing the read at `wfa-tax-settings`. If GST/service charge ever
silently reads as zero again despite correct-looking dashboard
settings, check this doc name mismatch first, ideally via a direct
Firestore read rather than trusting the console's visual match — two
Firestore docs with similar names are easy to eyeball as "the same."

### Geocoding key gotchas — three separate real failures, in order
Setting up `GOOGLE_GEOCODING_API_KEY` hit three distinct, genuinely
separate problems in production, each producing the exact same
symptom ("The provided API key is invalid.") — worth knowing all
three, since fixing one doesn't rule out the others:

1. **Using the wrong key entirely.** The Maps JavaScript API key
   (client-side, HTTP-referrer-restricted, lives in `App.jsx`) and the
   Geocoding key (server-side, unrestricted) are **two separate keys**
   by necessity — a referrer restriction only means anything for a
   real browser request; Google flatly rejects a referrer-restricted
   key on any server-to-server call with `"API keys with referer
   restrictions cannot be used with this API."` If you only ever
   created one key, this is almost certainly it.
2. **Env var name mismatch.** The value can be perfect and the code
   still won't find it — `GOOGLE_GEOCODING_API_KEY` must match
   *exactly*. A Cloud Run env var accidentally named
   `GOOGLE_GEOCODING_NORESTRICT_API_KEY` (a very reasonable name to
   type by hand, and completely invisible as wrong just by looking at
   it) means `process.env.GOOGLE_GEOCODING_API_KEY` is simply
   `undefined` — the code throws its own "Geocoding isn't configured
   yet" error, not a Google API error at all.
3. **A single mistyped/mis-pasted character.** `AIza...` is how every
   real Google API key starts — capital A, capital I, lowercase z,
   lowercase a. A key that instead reads `Alza...` (capital A,
   **lowercase L**) is silently wrong and completely invisible to the
   eye in most fonts, including Cloud Run's own console input field —
   `I` and `l` render identically in a huge number of typefaces. This
   happened after a legitimate copy from the Cloud Console.

**How this was actually diagnosed** — worth reusing as a pattern for
any "this secret isn't working" report: never trust reading a
secret's value off a screenshot or a terminal by eye. Pull the *live*
value programmatically and test *that* directly against the real API,
with zero manual retyping anywhere in the chain:
```bash
KEY=$(gcloud run services describe wfa-pay-be --region=asia-southeast1 --format=json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); envs=d['spec']['template']['spec']['containers'][0]['env']; print(next((e['value'] for e in envs if e.get('name')=='GOOGLE_GEOCODING_API_KEY'), 'NOT_FOUND'))")
curl -G "https://maps.googleapis.com/maps/api/geocode/json" \
  --data-urlencode "address=some real address" \
  --data-urlencode "key=$KEY"
```
A real Google API key is always exactly **39 characters** —
`echo -n "$KEY" | wc -c` is a fast first sanity check before even
hitting the network.

### Airwallex always shows "x 1" for single-quantity lines
`order.products` lines without a `quantity` field (Service Charge,
GST, Membership Discount) still render as "unit_price x 1" on the
hosted payment page — Airwallex defaults `quantity` to 1 and always
shows the multiplier, regardless of whether the field was sent at all.
Confirmed by testing: omitting `quantity` entirely does not suppress
it. There's no documented way to hide this — it's fixed Hosted Payment
Page layout, not something the API exposes control over. Cosmetic
only; the underlying amounts are correct either way.

### Airwallex amounts are in major units, not cents
`29.00`, not `2900`. This is a genuine, confirmed difference from
Stripe (which needed `* 100` everywhere) — there's no unit conversion
anywhere in the Airwallex integration, the real total computed by
`computeOrderTotals()` is sent to Airwallex exactly as-is.

### Airwallex auth is a token exchange, not a static key
Unlike Stripe's single secret key used forever, Airwallex requires
exchanging the Client ID + API Key for a short-lived Bearer access
token first (`getAirwallexAccessToken()`), which is cached and
automatically refreshed shortly before it expires. If payments start
failing with an authentication error after having worked fine, check
that both `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` are still
correctly set in Secret Manager — a token refresh failure surfaces
there, not as a webhook problem.

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
The service account needs **Storage Object Admin** explicitly granted
on the specific bucket, or uploads fail silently.

### `server.js` exists in every frontend repo too
Always double-check which repo you're editing in — backend logic
belongs here, in `wfa-pay-BE`, not in any frontend.

### Verifying a deployment actually works
Don't trust the dashboard/console alone — hit a real endpoint directly:
```
https://wfa-pay-be-191248130012.asia-southeast1.run.app/store/wfa-outlets
```

---

## Airwallex webhook setup

`POST /webhook`, listens for `payment_intent.succeeded`. Uses
`express.raw()` (not `express.json()`) for this route specifically,
since signature verification needs the raw body.

Signature scheme (confirmed against Airwallex's own docs and code
sample): `HMAC-SHA256(secret, x-timestamp header + raw body)`, hex
digest, compared to the `x-signature` header — genuinely different
from Stripe's scheme, not just a renamed copy of the old logic.

1. Airwallex web app → Developer → Webhooks → Create webhook
2. Notification URL: `<backend URL>/webhook`
3. Under **Account events → Events**, expand **Payment Intent** and
   check `payment_intent.succeeded` (optionally also
   `payment_intent.requires_payment_method`, to catch failed attempts
   — not required, the backend only acts on `succeeded`). Leave
   **Billing** and **Spend** alone — unrelated products, not used here.
4. Create → copy the generated signing secret into
   `AIRWALLEX_WEBHOOK_SECRET` in Secret Manager

**Sandbox and production webhooks are entirely separate**, same
principle as Stripe's test/live split — going live means registering a
new webhook against the production account and updating
`AIRWALLEX_WEBHOOK_SECRET` to match.

---

## Local development

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env`. Without `GOOGLE_SERVICE_ACCOUNT_JSON`
set, the app uses the in-memory fallback automatically (with the
checkout-blocking caveat noted in the Credentials section above).
