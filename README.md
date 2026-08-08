# WFA Asia — payments & shared-data backend

The Express server behind the WFA Asia ordering app (`FD-payment` /
`fd-payment.vercel.app`). It does two separate jobs:

1. **Payments** — creates Stripe Checkout Sessions, verifies them, and
   fires WhatsApp (Twilio) + email (Resend) notifications once a guest
   pays.
2. **Shared data store** — orders, the menu, tables, outlets, and ad
   banners all live here (in Firestore, if configured — see below), so
   a guest's phone and the merchant's dashboard device see the same
   data instead of each being stuck with their own local copy.

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
3. **IAM & Admin → Service Accounts → Create Service Account** → give
   it the **Cloud Datastore User** role
4. That service account → **Keys** → **Add Key → Create new key →
   JSON** — downloads a `.json` file
5. Copy that file's entire contents into a Render environment variable
   named `GOOGLE_SERVICE_ACCOUNT_JSON`

Check Render's **Logs** tab after it redeploys — you should see:
```
Firestore connected — data will persist across restarts.
```
If instead you see `[notice] GOOGLE_SERVICE_ACCOUNT_JSON not set...`,
the env var isn't actually set (or got mangled during copy/paste) —
the server still runs fine either way, just without persistence.

## 6. WhatsApp and email (optional)

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

The frontend's menu photos and ad banners (images/GIFs/short MP4 clips)
get sent here as part of the `/store/:key` payload. The body parser is
set to accept up to **25mb** per request — comfortably covers a few
photos or a short, compressed video clip, but if you see a `413
Payload Too Large` error, that's this limit (`express.json({ limit:
... })` near the top of `server.js`) — raise it if you need to, though
see the frontend README's content specs for why keeping uploads small
is the better fix.

## What each endpoint does

| Endpoint | Purpose |
|---|---|
| `POST /create-checkout-session` | Starts a Stripe Checkout for a cart total |
| `GET /checkout-session/:id` | Looks up a session's payment status |
| `POST /order-paid` | Re-verifies a session, fires notifications |
| `POST /webhook` | Stripe's own confirmation — the reliable source of truth |
| `GET /orders`, `POST /orders` | Shared order list (each order is its own record — safe against two orders arriving at once) |
| `POST /orders/seed` | One-time demo history load, guarded against overwriting real orders |
| `GET /notifications`, `POST /notifications` | Shared WhatsApp/email activity log |
| `GET /store/:key`, `POST /store/:key` | Generic storage for the menu, tables, outlets, banners |

## Before relying on this for real

- Tighten `ALLOWED_ORIGIN` to your actual frontend domain instead of `*`
- Set up Firestore (step 5) if you haven't — in-memory storage will
  quietly lose data on every restart otherwise
- Add real request logging/monitoring
- Consider rate-limiting the public endpoints
- Move off Twilio's WhatsApp sandbox to a verified business sender
  before depending on those notifications for real service
