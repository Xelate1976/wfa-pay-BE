# WFA Asia — payments & shared-data backend

The Express server behind the WFA Asia ordering app (`FD-payment` /
`fd-payment.vercel.app`). It does three separate jobs:

1. **Payments** — creates Stripe Checkout Sessions, verifies them, and
   fires WhatsApp (Twilio) + email (Resend) notifications once a guest
   pays.
2. **Shared data store** — orders, the menu, tables, outlets, and ad
   banners all live here (in Firestore, if configured — see below), so
   a guest's phone and the merchant's dashboard device see the same
   data instead of each being stuck with their own local copy.
3. **File uploads** — menu photos and ad banners (images/GIFs/video) go
   to Cloud Storage (if configured), returning a URL instead of
   embedding the whole file in Firestore.

This is a real working backend, not a toy — but it's sized for one
venue's worth of traffic, not a production platform. See "Before
relying on this for real" at the bottom for what to tighten up.

## 1. Get your Stripe keys

1. Sign in to the [Stripe dashboard](https://dashboard.stripe.com).
2. Developers → API keys → copy the **Publishable key** (`pk_test_...`)
   and **Secret key** (`sk_test_...`). Use test keys until you're ready
   to go live.
3. Put the secret key here as `STRIPE_SECRET_KEY` (see step 3 below).
4. Put the **publishable** key into the front-end app
   (`STRIPE_PUBLISHABLE_KEY` near the top of `src/App.jsx` in the
   `FD-payment` repo) — safe to expose in browser code; the secret key
   never is.

## 2. Run it locally

```bash
npm install
cp .env.example .env   # then fill in STRIPE_SECRET_KEY at minimum
npm run dev
```

Listens on `http://localhost:4000` by default.

## 3. Deploy it (Render)

1. Push this folder to its own GitHub repo (`wfa-pay-BE`)
2. [render.com](https://render.com) → **New +** → **Web Service** →
   connect that repo, branch `main`
3. Runtime: **Node** (not Docker) · Build command: `npm install` ·
   Start command: `npm start`
4. Under **Environment**, add at minimum:
   - `STRIPE_SECRET_KEY` → your `sk_test_...` key
   - `ALLOWED_ORIGIN` → `*` for now (tighten to your real frontend URL
     once you have one — see the frontend's own README)
5. Create the service — you'll get a URL like
   `https://wfa-pay-be.onrender.com`

Then put that URL into `BACKEND_URL` near the top of `src/App.jsx` in
the frontend repo.

## 4. Register the Stripe webhook

Dashboard → Developers → Webhooks → Add endpoint:
- URL: `https://YOUR-RENDER-URL/webhook`
- Event: `checkout.session.completed`

Copy the signing secret it gives you into `STRIPE_WEBHOOK_SECRET` on
Render.

## 5. Set up persistent storage (Firestore)

Without this, orders/menu/etc. live in server memory and **reset every
time the server restarts** (Render's free tier does this after ~15 min
idle, and on every redeploy). Firestore fixes that — data survives
restarts permanently.

1. [console.cloud.google.com](https://console.cloud.google.com) →
   create a project (or use an existing one)
2. Search **Firestore** → **Create database** → **Native mode** → pick
   a region
3. **⚠️ Note the exact database ID it gets** — shown at the top of the
   Firestore page (e.g. `wfa-data`). This is NOT necessarily
   `"(default)"`, and it matters — see the warning box below.
4. **IAM & Admin → Service Accounts → Create Service Account** → give
   it the **Cloud Datastore User** role
5. That service account → **Keys** → **Add Key → Create new key →
   JSON** — downloads a `.json` file
6. Copy that file's entire contents into a Render environment variable
   named `GOOGLE_SERVICE_ACCOUNT_JSON`
7. If your database ID isn't `wfa-data`, also add
   `FIRESTORE_DATABASE_ID` on Render set to the real one

Check Render's **Logs** tab after it redeploys — you should see:
```
Firestore connected (database: "wfa-data") — data will persist across restarts.
```

**⚠️ Database name gotcha (cost us a while to track down):** the
Firestore client defaults to a database literally named `"(default)"`.
If your database was created with a custom name (which the Firestore
console does by default) rather than `"(default)"`, connecting without
specifying the name doesn't fail loudly — it logs a successful-looking
"Firestore connected" message, but then every actual read/write fails
with a `5 NOT_FOUND` error, because it's silently trying to reach a
database that doesn't exist. This file already handles it correctly
(`getFirestore(app, databaseId)`, defaulting to `"wfa-data"`, override-
able via `FIRESTORE_DATABASE_ID`) — just make sure that name actually
matches what you see in the Firestore console.

If `GOOGLE_SERVICE_ACCOUNT_JSON` is missing entirely, you'll instead
see `[notice] GOOGLE_SERVICE_ACCOUNT_JSON not set...` — the server
still runs fine, just without persistence, until you set it.

## 6. Set up file storage (Cloud Storage)

Firestore caps every document at **1MiB** — a single decent photo, and
especially any video clip, can exceed that on its own. Without Cloud
Storage set up, menu photo/banner uploads will eventually fail with a
Firestore `INVALID_ARGUMENT: ... exceeds the maximum allowed size`
error once they get large enough.

1. Same Google Cloud project as above → search **Cloud Storage** →
   **Buckets** → **Create**
2. Name it anything globally unique (e.g.
   `your-project-id-media`) · same region as Firestore · leave
   **Uniform bucket-level access** on (Google's current default — the
   code is written to work with this)
3. **Remove Public Access Prevention** on the bucket (Bucket details →
   "Public access" section) — this has to be off before you can grant
   public read access in the next step
4. Bucket → **Permissions** → **Grant access** → principal `allUsers`
   → role **Storage Object Viewer** → Save (confirms it's making the
   bucket's contents publicly readable — expected, since these are
   guest-facing menu photos/banners)
5. **IAM & Admin → IAM** → find your service account (the same one
   from step 5 above) → edit → **Add another role** → **Storage Object
   Admin** — without this specific role, uploads fail with a `403:
   storage.objects.create` permission error even though Firestore
   itself works fine (these are separate Google services with
   separate permissions)
6. Add `GCS_BUCKET_NAME` on Render, set to your bucket's exact name

Check Render's Logs for:
```
Cloud Storage connected (bucket: "your-bucket-name").
```

If `GCS_BUCKET_NAME` isn't set, uploads keep working the old way
(embedded directly in Firestore) until they hit the 1MiB ceiling.

## 7. WhatsApp and email (optional)

Both are independently optional — if their env vars are missing, that
notification channel is just skipped (logged, not thrown).

- **WhatsApp**: Twilio's WhatsApp sandbox works immediately for testing
  (numbers must first "join" the sandbox by messaging a code). For a
  real business number, apply through Twilio for WhatsApp Business API
  access — involves Meta business verification, takes a few days.
- **Email**: [Resend](https://resend.com) needs a verified sending
  domain before `RECEIPT_FROM_EMAIL` will work. Any transactional
  email provider (Postmark, SendGrid) would drop in similarly — swap
  the `fetch` call in `notifyOnPayment()`.

Add these on Render → Environment:
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`,
`MERCHANT_WHATSAPP_NUMBER`, `SUPPLIER_WHATSAPP_NUMBER`,
`RESEND_API_KEY`, `RECEIPT_FROM_EMAIL`.

## Request size limit

Uploads are sent here as base64 in the request body before being
forwarded to Cloud Storage. The body parser accepts up to **25mb** per
request — comfortably covers a few photos or a short, compressed video
clip. A `413 Payload Too Large` error means this limit
(`express.json({ limit: ... })` near the top of `server.js`) needs
raising — though keeping uploads small in the first place is the
better fix; see the frontend README's content specs.

## What each endpoint does

| Endpoint | Purpose |
|---|---|
| `POST /create-checkout-session` | Starts a Stripe Checkout for a cart total |
| `GET /checkout-session/:id` | Looks up a session's payment status |
| `POST /order-paid` | Re-verifies a session, fires notifications |
| `POST /webhook` | Stripe's own confirmation — the reliable source of truth |
| `POST /upload` | Saves a file to Cloud Storage, returns its URL |
| `GET /orders`, `POST /orders` | Shared order list (each order is its own record — safe against two orders arriving at once) |
| `POST /orders/seed` | One-time demo history load, guarded against overwriting real orders |
| `GET /notifications`, `POST /notifications` | Shared WhatsApp/email activity log |
| `GET /store/:key`, `POST /store/:key` | Generic storage for the menu, tables, outlets, banners |

## Before relying on this for real

- Tighten `ALLOWED_ORIGIN` to your actual frontend domain instead of `*`
- Set up Firestore (step 5) and Cloud Storage (step 6) if you haven't
  — without them, data resets on restart and uploads eventually fail
- Add real request logging/monitoring
- Consider rate-limiting the public endpoints
- Move off Twilio's WhatsApp sandbox to a verified business sender
  before depending on those notifications for real service
