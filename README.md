# WFA Asia — order & dashboard app (standalone)

This started out as a Claude artifact — pulled out into a normal
website so it can actually call the Stripe payments backend
(`wfa-pay-BE`). Claude's artifact preview blocks that kind of outbound
network call for security; a real deployed site doesn't have that
restriction.

## What's in here

**Customer-facing ordering page:**
- QR-code table ordering (and outlet picking, if you run more than one
  location)
- Menu with categories, photos, and per-item **taste profile popups**
  (a radar chart — body / sweetness / acidity / tannin — plus food
  pairing notes; tap any item to see it)
- Rotating ad banner — images, GIFs, or short MP4 clips
- Stripe Checkout for payment, same-tab redirect

**Merchant dashboard** (PIN-gated):
- **Sales** — revenue/orders overview by day/week/month/year
- **Outlets** — manage multiple locations, grouped under **chains**
  (e.g. every branch of one brand rolls up into a single filter option
  across the whole dashboard)
- **Tables** — add/rename/remove tables per outlet, download/print QR
  codes
- **Menu** — add/edit/delete items: pricing, photos, RFID tier, taste
  profile sliders, pairing notes
- **Banner** — upload/manage the rotating ad content
- **Reports** — a filterable, sortable transaction table (Power BI–
  style), plus product/table/outlet breakdowns and CSV export
- **Charts** — a drag-and-drop-ish chart builder: pick an X-axis, an
  optional second breakdown axis, a measure, and a chart type (bar,
  line, area, pie)

## How data storage works

Orders, notifications, the menu, tables, outlets, and banners all live
on the backend (`wfa-pay-BE`), not in this app's own browser storage —
that's what makes them show up consistently across a guest's phone and
the merchant's dashboard device.

The backend itself supports two modes:
- **Firestore** (real database) — data survives server restarts. Set up
  by adding a `GOOGLE_SERVICE_ACCOUNT_JSON` environment variable on
  Render; see `wfa-pay-BE`'s own README for setup steps.
- **In-memory fallback** — used automatically if Firestore isn't
  configured. Works fine for quick testing, but all data resets
  whenever the server restarts (Render's free tier does this after
  ~15 minutes idle, and on every redeploy).

If `BACKEND_URL`/`STRIPE_PUBLISHABLE_KEY` at the top of `src/App.jsx`
aren't filled in yet, the app falls back to browser `localStorage`
instead — fine for solo local testing, but orders won't be shared
across devices in that mode.

**Uploaded files** (menu photos, ad banners) go through a separate
path — the picked file gets sent to the backend's `/upload` endpoint,
which saves it to **Cloud Storage** and returns a short URL; that URL
is what actually gets stored in the menu/banner data, not the file
itself. This matters because Firestore documents cap out at 1MiB, which
a single photo or video clip can exceed on its own — see `wfa-pay-BE`'s
README for the Cloud Storage setup steps. If Cloud Storage isn't set up
yet, uploads still work by embedding the file directly (matching the
old behavior) — fine for a couple of small photos, but will eventually
hit that 1MiB ceiling once anything gets larger.

## Content specs

**Menu item photos** (Merchant → Menu → per item): any reasonable photo
works — square-ish crops look best (displayed as small thumbnails). No
strict size requirement.

**Taste profiles** (Merchant → Menu → per item): four sliders, each
0–5 — **Body, Sweetness, Acidity, Tannin** — plus an optional "Pairs
well with" text note. These render as a radar chart when a guest taps
the item on the ordering page. Leaving all four at 0 just hides the
chart for that item (shows a "no profile set" message instead).

**Ad banners** (Merchant → Banner): images, GIFs, and short MP4 clips
all work. The banner area's aspect ratio is:
- **16:7** on mobile
- **16:6** on desktop

Since one asset needs to work across both, and it's displayed with
`object-cover` (fills the frame, cropping edges rather than stretching
or letterboxing):

- **Recommended size: 1600 × 700px** (or a multiple, e.g. 1920 × 840px)
- Keep important content (text, logos, product shots) centered in the
  middle ~60% of the frame — the top/bottom edges are what gets cropped
  on wider desktop screens
- **Video clips**: keep them short (5–15s is a good range) — a video
  banner plays to completion before advancing to the next one, so a
  long clip holds up the whole rotation. Always muted (autoplay
  browsers require this), so audio doesn't matter.
- **File size**: with Cloud Storage set up (see `wfa-pay-BE`'s README),
  uploads go to real file storage and this isn't much of a concern.
  Without it, uploads embed directly in the shared data instead — keep
  those small (well under 1MB) to stay clear of Firestore's document
  size limit.

## Run it locally

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`.

## Deploy to Vercel

1. Push this folder to a GitHub repo (a separate repo from the backend
   — e.g. `FD-payment`)
2. Go to [vercel.com](https://vercel.com) → sign in → **Add New** →
   **Project**
3. Import that repo — Vercel auto-detects Vite, no config needed
4. Click **Deploy**
5. You'll get a URL like `https://your-project.vercel.app`

## After deploying

**Update CORS on the backend.** Right now `wfa-pay-BE`'s
`ALLOWED_ORIGIN` is set to `*` (any site can call it) — fine for
testing, but once you have a real frontend URL, tighten it:

1. Render → `wfa-pay-BE` → Environment
2. Change `ALLOWED_ORIGIN` to your Vercel URL, e.g.
   `https://your-project.vercel.app`
3. Save — Render redeploys automatically

**Print QR codes from the real URL.** Table QR codes encode whatever
URL the app is running at (outlet + table), so generate/print them
*from the deployed Vercel site*, not from anywhere else — otherwise
they'll point guests at a URL that doesn't exist.

## Test a real payment

1. Open your Vercel URL, pick an outlet (if you have more than one)
   and a table, add an item, checkout
2. Fill in name/email, tap Pay — opens Stripe's Checkout page in the
   same tab, then redirects back automatically once paid
3. Use test card `4242 4242 4242 4242`, any future expiry, any CVC
4. Confirm the payment in Stripe's test dashboard, and confirm the
   order shows up on the merchant dashboard (may take up to ~15s, or
   refresh manually)
