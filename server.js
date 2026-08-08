/**
 * WFA Asia — payments backend
 * -----------------------------------------------------------------------
 * Minimal Express server that:
 *   1. Creates a Stripe Checkout Session for a cart total and hands back
 *      its hosted URL. The app opens that URL in a new browser tab —
 *      Stripe's own page collects the card, so no card-handling code or
 *      script ever needs to load inside the ordering app itself.
 *   2. Lets the app poll a session's status after opening it (since the
 *      payment happens in a separate tab, there's no direct callback).
 *   3. Verifies successful payments and fires WhatsApp (Twilio) + email
 *      (Resend) notifications, via two paths that both call
 *      notifyOnPayment():
 *        - the webhook below (checkout.session.completed) — the
 *          reliable source of truth, fires even if the guest never
 *          returns to the ordering tab.
 *        - /order-paid — a convenience call the app makes once it sees
 *          (via polling) that the session succeeded, for instant
 *          feedback without waiting on the webhook round trip.
 *
 * This file is a starting point, not a finished production server —
 * see README.md for what to change before going live.
 * -----------------------------------------------------------------------
 */
import express from "express";
import cors from "cors";
import Stripe from "stripe";
import dotenv from "dotenv";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { Storage } from "@google-cloud/storage";

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

/* ---------------------------------------------------------------------
   Firestore — this is the real persistent store. Orders, the menu,
   tables, outlets, and banners all live here now, so they survive a
   server restart. In-memory hosting (like Render's free tier) loses
   everything on every restart/idle-spindown — on Cloud Run this
   doesn't matter since Firestore is the real store either way.

   ⚠️ Database name matters: admin.firestore() with no arguments always
   connects to a database literally named "(default)" — but a database
   created through the Firestore console (rather than via `gcloud`) is
   often given a different name instead. If yours isn't "(default)",
   using admin.firestore() silently points at a database that doesn't
   exist — every read/write then fails with a "5 NOT_FOUND" error, even
   though "Firestore connected" already logged successfully (that
   message only confirms the credentials parsed, not that the database
   name is right). getFirestore(firebaseApp, FIRESTORE_DATABASE_ID)
   below targets the real one explicitly instead of guessing.

   Two ways to authenticate, tried in this order:
   1. Application Default Credentials — automatic on Cloud Run (and any
      Google Cloud compute product), using whatever service account the
      service itself runs as. No JSON key, no env var, nothing to
      copy/paste or accidentally corrupt — just grant that service
      account the right IAM roles (see README) and it works.
   2. GOOGLE_SERVICE_ACCOUNT_JSON — a manually-created key, needed on
      hosts that aren't part of Google Cloud (Render, local dev, etc.)
      where ADC has nothing to automatically pick up.

   If neither is available, every storage function below falls back to
   plain in-memory behavior automatically, so this file still runs
   fine before Firestore is set up — it just won't persist anything.
--------------------------------------------------------------------- */
let db = null;
let bucket = null;
let credentialSource = null; // for logging only — "ADC" or "explicit key"
let explicitCredentials = null; // only set when using GOOGLE_SERVICE_ACCOUNT_JSON, needed again below for Storage

try {
  let firebaseApp;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    explicitCredentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    firebaseApp = admin.initializeApp({ credential: admin.credential.cert(explicitCredentials) });
    credentialSource = "explicit key";
  } else {
    // No explicit key provided — try ADC. On Cloud Run this just works;
    // anywhere else (a laptop with no `gcloud auth` set up, Render,
    // etc.) this throws, and we fall through to the in-memory fallback
    // below rather than crashing the whole server.
    firebaseApp = admin.initializeApp();
    credentialSource = "ADC";
  }

  // Set FIRESTORE_DATABASE_ID if your database isn't named "wfa-data" —
  // check console.cloud.google.com > Firestore > your database's actual ID.
  const databaseId = process.env.FIRESTORE_DATABASE_ID || "wfa-data";
  db = getFirestore(firebaseApp, databaseId);
  console.log(`Firestore connected via ${credentialSource} (database: "${databaseId}") — data will persist across restarts.`);

  // Cloud Storage — for menu photos and ad banners (images/GIFs/video).
  // Firestore caps every document at 1MiB, which a single photo or
  // clip can exceed on its own — that's not something splitting data
  // across more documents can fix. Real files need real file storage
  // instead of being embedded as base64 text. Only enabled if
  // GCS_BUCKET_NAME is set; see README for how to create the bucket.
  if (process.env.GCS_BUCKET_NAME) {
    const storage = explicitCredentials
      ? new Storage({ credentials: explicitCredentials, projectId: explicitCredentials.project_id })
      : new Storage(); // ADC again — picks up the same identity automatically
    bucket = storage.bucket(process.env.GCS_BUCKET_NAME);
    console.log(`Cloud Storage connected via ${credentialSource} (bucket: "${process.env.GCS_BUCKET_NAME}").`);
  } else {
    console.log("[notice] GCS_BUCKET_NAME not set — uploads will keep failing once they exceed Firestore's 1MiB document limit.");
  }
} catch (e) {
  console.error("Failed to initialize Firestore/Storage — falling back to in-memory store:", e.message);
}

// Only used as a fallback when Firestore isn't configured.
const memStore = {};
let memOrders = [];
let memNotifications = [];

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

// The reliable path: looks up what was saved at checkout-creation time
// (see /create-checkout-session) and writes it into the real orders
// collection, now confirmed paid. Uses the session id as the order's
// document id — same id the guest's own browser would use if IT
// successfully completes the return trip too, so having both paths
// fire just harmlessly overwrites the same record rather than
// creating a duplicate. Safe to call from both the webhook and
// /order-paid; whichever runs first wins, the other is a no-op.
async function recordOrderFromSession(session) {
  if (!db) return;
  try {
    const pendingDoc = await db.collection("checkoutPending").doc(session.id).get();
    if (!pendingDoc.exists) {
      console.error(`recordOrderFromSession: no checkoutPending record for ${session.id} — order may only exist if the guest's browser completed the return trip.`);
      return;
    }
    const p = pendingDoc.data();
    const order = {
      id: session.id,
      ts: p.createdAt || new Date().toISOString(),
      items: p.items || [],
      total: +(session.amount_total / 100).toFixed(2),
      subtotal: p.subtotal,
      serviceCharge: p.serviceCharge,
      gst: p.gst,
      customer: p.customerName || "",
      email: p.customerEmail || "",
      phone: p.customerPhone || "",
      outlet: p.outlet || null,
      table: p.table || null,
      sessionId: session.id,
      live: true,
    };
    await db.collection("orders").doc(session.id).set(order);
  } catch (e) {
    console.error("recordOrderFromSession failed:", e.message);
  }
}


/* ---------------------------------------------------------------------
   Stripe webhook — must read the RAW body, so this is mounted before
   express.json(). Register this URL + the checkout.session.completed
   event in the Stripe dashboard (or `stripe listen` for local testing).
   See README.
--------------------------------------------------------------------- */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.sendStatus(400);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      await notifyOnPayment({ amountCents: session.amount_total, metadata: session.metadata });
      await recordOrderFromSession(session);
    }
    res.json({ received: true });
  }
);

// Default limit is 100kb. Menu photos need a few MB; banner video clips
// need more — 25mb comfortably covers a short, small MP4. This is still
// an in-memory server on a free tier with limited RAM, so this isn't
// unlimited: keep video clips short and lightly compressed, and prefer
// pasting a URL to externally-hosted video over uploading large files
// directly when possible.
app.use(express.json({ limit: "25mb" }));

/* ---------------------------------------------------------------------
   1. Create a Checkout Session for the current cart total, and return
   its hosted URL. The app opens this URL in a new tab (window.open) —
   that's just a normal navigation, not a script load, so it works even
   in sandboxes that block loading third-party JS (like Claude artifacts).
--------------------------------------------------------------------- */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { amount, currency = "sgd", table, outlet, customer, items, subtotal, serviceCharge, gst, returnUrl } = req.body;

    if (!Number.isInteger(amount) || amount < 50) {
      return res.status(400).json({ error: "Invalid amount (must be integer cents, min 50)." });
    }
    if (!returnUrl) {
      return res.status(400).json({ error: "returnUrl is required (the ordering app's own URL)." });
    }

    // Bug fixed: this used to send guests to a static "you can close this
    // tab" page on the backend and rely on the ORIGINAL tab silently
    // polling in the background to notice payment succeeded. That's
    // fragile on mobile (background tabs get throttled/killed) and,
    // worse, never actually brings the guest back automatically. Stripe's
    // own recommended pattern is simpler and more reliable: redirect in
    // the SAME tab, back to the app's own URL, with the session id
    // attached — the app checks for that on load and shows the receipt.
    // {CHECKOUT_SESSION_ID} is a literal placeholder Stripe fills in.
    const successUrl = `${returnUrl}?session_id={CHECKOUT_SESSION_ID}&paid=1`;
    const cancelUrl = `${returnUrl}?paid=0`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: customer?.email,
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: `WFA Asia order${table ? ` — Table ${table}` : ""}`,
              description: (items || []).map((i) => `${i.qty}x ${i.name} (${i.kind})`).join(", ").slice(0, 500) || undefined,
            },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      metadata: {
        table: table ? String(table) : "",
        customerName: customer?.name || "",
        customerEmail: customer?.email || "",
        customerPhone: customer?.phone || "",
        items: (items || []).map((i) => `${i.qty}x ${i.name} (${i.kind})`).join(", ").slice(0, 500),
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    // ⚠️ Critical for reliability: the order used to only ever get
    // saved by the GUEST'S OWN BROWSER, after Stripe redirected them
    // back here. If that round trip never completes — tab closed right
    // after paying, connection drops, phone dies, anything — the guest
    // was genuinely charged, but no order record was ever created, and
    // the restaurant has no way to know the payment happened.
    //
    // Fixing that: the full order gets saved here, right now, BEFORE
    // the guest even reaches Stripe's page — marked not-yet-paid, keyed
    // by this session's id. The webhook below (which Stripe calls
    // server-to-server, independent of the guest's device entirely)
    // is what actually confirms and finalizes it once payment succeeds.
    // That's the reliable path now; the guest's own browser completing
    // the return trip is just a nice-to-have for instant UI feedback,
    // no longer the only way an order gets recorded.
    if (db) {
      try {
        await db.collection("checkoutPending").doc(session.id).set({
          items: items || [],
          table: table ? String(table) : null,
          outlet: outlet || null,
          subtotal: subtotal ?? null,
          serviceCharge: serviceCharge ?? null,
          gst: gst ?? null,
          customerName: customer?.name || "",
          customerEmail: customer?.email || "",
          customerPhone: customer?.phone || "",
          createdAt: new Date().toISOString(),
        });
      } catch (e) {
        console.error("Failed to persist checkoutPending (order will fall back to the guest's browser completing the return trip):", e.message);
      }
    }

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("create-checkout-session failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------------
   2. Poll this to find out if a session has been paid yet. The app
   calls it every couple of seconds after opening the Checkout tab.
--------------------------------------------------------------------- */
app.get("/checkout-session/:id", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    res.json({
      status: session.payment_status, // "paid" | "unpaid" | "no_payment_required"
      amountTotal: session.amount_total,
      metadata: session.metadata,
    });
  } catch (err) {
    console.error("checkout-session lookup failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------------
   3. Convenience confirmation — called by the app right after polling
   shows a session is paid. We re-check with Stripe (never trust the
   client's word alone) before sending notifications.
--------------------------------------------------------------------- */
app.post("/order-paid", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      return res.status(400).json({ error: `Payment not confirmed (status: ${session.payment_status})` });
    }

    await notifyOnPayment({ amountCents: session.amount_total, metadata: session.metadata });
    await recordOrderFromSession(session);
    res.json({ ok: true });
  } catch (err) {
    console.error("order-paid failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------------
   Plain landing pages Stripe redirects the Checkout tab to. The guest
   sees this in the tab Checkout opened in — they can close it and
   return to the ordering tab, which is independently polling and will
   pick up the confirmation on its own.
--------------------------------------------------------------------- */
app.get("/checkout-success", (_req, res) => {
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:4rem 1rem;">
    <h1>Payment received ✅</h1>
    <p>You can close this tab and return to your order.</p>
  </body></html>`);
});

app.get("/checkout-cancel", (_req, res) => {
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:4rem 1rem;">
    <h1>Payment cancelled</h1>
    <p>No charge was made. You can close this tab and try again.</p>
  </body></html>`);
});

/* ---------------------------------------------------------------------
   Notifications — fill in your real credentials in .env. Each block is
   independently optional: if the relevant env vars are missing, that
   channel is just skipped (logged, not thrown).
--------------------------------------------------------------------- */
async function notifyOnPayment({ amountCents, metadata }) {
  const total = (amountCents / 100).toFixed(2);
  const { table, customerEmail, items } = metadata || {};

  // --- WhatsApp via Twilio ---------------------------------------------
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    try {
      const { default: twilioLib } = await import("twilio");
      const client = twilioLib(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const from = `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`;

      if (process.env.MERCHANT_WHATSAPP_NUMBER) {
        await client.messages.create({
          from,
          to: `whatsapp:${process.env.MERCHANT_WHATSAPP_NUMBER}`,
          body: `New order paid${table ? ` — Table ${table}` : ""} — $${total}\n${items || ""}`,
        });
      }
      if (process.env.SUPPLIER_WHATSAPP_NUMBER) {
        await client.messages.create({
          from,
          to: `whatsapp:${process.env.SUPPLIER_WHATSAPP_NUMBER}`,
          body: `Restock check: ${items || "(no item detail)"}`,
        });
      }
    } catch (e) {
      console.error("WhatsApp send failed:", e.message);
    }
  } else {
    console.log("[skipped] WhatsApp not configured (TWILIO_* env vars missing)");
  }

  // --- Email via Resend --------------------------------------------------
  if (process.env.RESEND_API_KEY && customerEmail) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.RECEIPT_FROM_EMAIL || "receipts@yourdomain.com",
          to: customerEmail,
          subject: "Your WFA Asia receipt",
          html: `<p>Thanks for your order${table ? ` at Table ${table}` : ""}!</p><p>Total charged: <strong>$${total}</strong></p><p>${items || ""}</p>`,
        }),
      });
    } catch (e) {
      console.error("Email send failed:", e.message);
    }
  } else {
    console.log("[skipped] Email not configured (RESEND_API_KEY missing or no customer email)");
  }
}

app.get("/", (_req, res) => res.send("WFA Asia payments backend is running."));

/* ---------------------------------------------------------------------
   File uploads — menu photos and ad banners (images/GIFs/video) go here
   instead of into Firestore directly. The frontend converts a picked
   file to base64 and POSTs it here; this saves it to Cloud Storage and
   hands back a public URL, which is what actually gets saved in the
   menu/banner data (a short string, not the whole file).
--------------------------------------------------------------------- */
app.post("/upload", async (req, res) => {
  if (!bucket) {
    return res.status(501).json({
      error: "Cloud Storage isn't configured yet (set GCS_BUCKET_NAME on the backend) — see README for setup steps.",
    });
  }
  try {
    const { filename, contentType, dataBase64 } = req.body;
    if (!dataBase64) return res.status(400).json({ error: "dataBase64 required" });

    const buffer = Buffer.from(dataBase64, "base64");
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${(filename || "file").replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
    const path = `uploads/${safeName}`;
    const file = bucket.file(path);

    await file.save(buffer, {
      contentType: contentType || "application/octet-stream",
      metadata: { cacheControl: "public, max-age=31536000" },
      // Not passing `public: true` here on purpose — buckets created
      // with Uniform bucket-level access (Google's current default)
      // reject per-object ACL calls like that. Public read is instead
      // granted once at the bucket level (allUsers → Storage Object
      // Viewer) — see README — which works regardless of bucket mode.
    });

    const url = `https://storage.googleapis.com/${bucket.name}/${path}`;
    res.json({ url });
  } catch (e) {
    console.error("upload failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------------------------------------------------------
   Generic shared store — the menu, table list, outlets, and banners all
   live here (each under their own key). Backed by Firestore when
   configured (see the note near the top of this file); falls back to
   plain in-memory otherwise.
--------------------------------------------------------------------- */
app.get("/store/:key", async (req, res) => {
  const key = req.params.key;
  if (db) {
    try {
      const doc = await db.collection("kv").doc(key).get();
      if (!doc.exists) return res.status(404).json({ error: "not found" });
      return res.json({ value: doc.data().value });
    } catch (e) {
      console.error("Firestore get failed:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }
  const entry = memStore[key];
  if (entry === undefined) return res.status(404).json({ error: "not found" });
  res.json({ value: entry });
});

app.post("/store/:key", async (req, res) => {
  const key = req.params.key;
  if (db) {
    try {
      await db.collection("kv").doc(key).set({ value: req.body.value });
      return res.json({ ok: true });
    } catch (e) {
      console.error("Firestore set failed:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }
  memStore[key] = req.body.value;
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------
   Orders & notifications — dedicated endpoints, NOT the generic /store
   above. Here's why: the generic store is "fetch it, change it, save
   the whole thing back" — fine for the menu or table list (one person
   edits at a time), but with orders, two devices placing an order
   around the same moment would both fetch the same list, each add
   their own order, and each save their own version back. Whichever
   save happens last WINS — silently erasing the other guest's order.
   These endpoints avoid that: each order is its own Firestore document
   (or, without Firestore, the server appends to its own in-memory list
   in a single synchronous step) — either way, two orders arriving
   close together both survive no matter which one's request finishes
   first.
--------------------------------------------------------------------- */
app.get("/orders", async (_req, res) => {
  if (db) {
    try {
      const snap = await db.collection("orders").orderBy("ts", "desc").limit(1000).get();
      return res.json({ orders: snap.docs.map((d) => d.data()) });
    } catch (e) {
      console.error("Firestore orders fetch failed:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }
  res.json({ orders: memOrders });
});

app.post("/orders", async (req, res) => {
  const { order } = req.body;
  if (!order || !order.id) return res.status(400).json({ error: "order required" });
  if (db) {
    try {
      await db.collection("orders").doc(order.id).set(order);
      return res.json({ ok: true });
    } catch (e) {
      console.error("Firestore order write failed:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }
  memOrders = [order, ...memOrders];
  res.json({ ok: true, count: memOrders.length });
});

// Only used once, to load the initial 90 days of demo history — guarded
// so it can't accidentally wipe real orders that have already come in,
// and so two devices loading for the first time at once don't both seed.
app.post("/orders/seed", async (req, res) => {
  const { orders } = req.body;
  const toSeed = Array.isArray(orders) ? orders : [];

  if (db) {
    try {
      const existing = await db.collection("orders").limit(1).get();
      if (!existing.empty) {
        return res.json({ ok: false, reason: "orders already exist, seed skipped" });
      }
      // Firestore batches cap at 500 writes, so chunk larger seed sets.
      for (let i = 0; i < toSeed.length; i += 450) {
        const batch = db.batch();
        toSeed.slice(i, i + 450).forEach((o) => batch.set(db.collection("orders").doc(o.id), o));
        await batch.commit();
      }
      return res.json({ ok: true, count: toSeed.length });
    } catch (e) {
      console.error("Firestore seed failed:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (memOrders.length > 0) {
    return res.json({ ok: false, reason: "orders already exist, seed skipped" });
  }
  memOrders = toSeed;
  res.json({ ok: true, count: memOrders.length });
});

app.get("/notifications", async (_req, res) => {
  if (db) {
    try {
      const snap = await db.collection("notifications").orderBy("ts", "desc").limit(40).get();
      return res.json({ notifications: snap.docs.map((d) => d.data()) });
    } catch (e) {
      console.error("Firestore notifications fetch failed:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }
  res.json({ notifications: memNotifications });
});

app.post("/notifications", async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: "items array required" });
  if (db) {
    try {
      const batch = db.batch();
      items.forEach((item) => batch.set(db.collection("notifications").doc(), item));
      await batch.commit();
      return res.json({ ok: true });
    } catch (e) {
      console.error("Firestore notifications write failed:", e.message);
      return res.status(500).json({ error: e.message });
    }
  }
  memNotifications = [...items, ...memNotifications].slice(0, 40);
  res.json({ ok: true });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`WFA payments backend listening on :${port}`));
