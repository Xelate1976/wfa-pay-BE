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

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

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
    }
    res.json({ received: true });
  }
);

app.use(express.json());

/* ---------------------------------------------------------------------
   1. Create a Checkout Session for the current cart total, and return
   its hosted URL. The app opens this URL in a new tab (window.open) —
   that's just a normal navigation, not a script load, so it works even
   in sandboxes that block loading third-party JS (like Claude artifacts).
--------------------------------------------------------------------- */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { amount, currency = "sgd", table, customer, items, returnUrl } = req.body;

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
   Shared store — orders, the menu, and the table list all live here now
   instead of in each browser's own localStorage, so a guest's phone and
   the merchant's dashboard device actually see the same data.

   ⚠️ This is in-memory only — it resets whenever this server restarts
   (Render's free tier does this after ~15 min of inactivity, and on
   every redeploy). That's fine for a prototype, but before relying on
   this for a real service night after night, swap this for a real
   database (e.g. Postgres) so data survives restarts. Happy to build
   that when you're ready — it's a bigger, deliberate step up, not
   something to do accidentally.
--------------------------------------------------------------------- */
const store = {};

app.get("/store/:key", (req, res) => {
  const entry = store[req.params.key];
  if (entry === undefined) return res.status(404).json({ error: "not found" });
  res.json({ value: entry });
});

app.post("/store/:key", (req, res) => {
  store[req.params.key] = req.body.value;
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
   That's the bug this fixes: the server does the "add one order" step
   itself, in a single request, so two orders arriving close together
   both survive no matter what order they arrive in.
--------------------------------------------------------------------- */
let ordersList = [];
let notificationsList = [];

app.get("/orders", (_req, res) => {
  res.json({ orders: ordersList });
});

app.post("/orders", (req, res) => {
  const { order } = req.body;
  if (!order || !order.id) return res.status(400).json({ error: "order required" });
  ordersList = [order, ...ordersList];
  res.json({ ok: true, count: ordersList.length });
});

// Only used once, to load the initial 90 days of demo history — guarded
// so it can't accidentally wipe real orders that have already come in.
app.post("/orders/seed", (req, res) => {
  const { orders } = req.body;
  if (ordersList.length > 0) {
    return res.json({ ok: false, reason: "orders already exist, seed skipped", count: ordersList.length });
  }
  ordersList = Array.isArray(orders) ? orders : [];
  res.json({ ok: true, count: ordersList.length });
});

app.get("/notifications", (_req, res) => {
  res.json({ notifications: notificationsList });
});

app.post("/notifications", (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: "items array required" });
  notificationsList = [...items, ...notificationsList].slice(0, 40);
  res.json({ ok: true });
});


const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`WFA payments backend listening on :${port}`));
