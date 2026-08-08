# WFA Asia — Payments Backend (wfa-pay-BE)

Express/Node backend for the WFA Asia ordering system. Handles menu,
outlets, tables, and banner data via Firestore, media uploads via
Cloud Storage, and payments via Stripe Checkout + webhooks. Serves the
`FD-payment` frontend.

- **Frontend repo**: `Xelate1976/FD-payment`
- **Live (Cloud Run)**: https://wfa-pay-be-191248130012.asia-southeast1.run.app
- **Live (Render, legacy/backup)**: https://wfa-pay-be.onrender.com

---

## What's in here

- **Stripe Checkout** — creates checkout sessions for cart orders,
  redirects same-tab
- **Stripe webhook** (`POST /webhook`) — listens for
  `checkout.session.completed`, records the paid order and notifies
  the merchant dashboard
- **Firestore** — persistent storage for outlets, menu, tables,
  banners, orders, and notifications (all under a `kv` collection)
- **Cloud Storage** — real file storage for uploaded menu photos and
  banner media (images/GIFs/MP4), so Firestore's 1MiB document limit
  isn't a bottleneck
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
  banners, tables, orders) under the `kv` collection

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
