/**
 * WFA Asia — payments backend
 * -----------------------------------------------------------------------
 * Minimal Express server that:
 *   1. Creates a Stripe PaymentIntent for a cart total (kept server-side —
 *      never expose your Stripe SECRET key to the browser).
 *   2. Verifies successful payments and fires WhatsApp (Twilio) + email
 *      (Resend) notifications. Two paths call notifyOnPayment():
 *        - /order-paid: called by the app right after the browser
 *          confirms the card payment (fast, but skipped if the guest
 *          closes the tab before this request finishes).
 *        - /webhook: Stripe calls this directly, so it's the reliable
 *          source of truth. Set this up in production; /order-paid is a
 *          nice-to-have for instant feedback.
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
   express.json(). Register this URL + these events in the Stripe
   dashboard (or `stripe listen` for local testing). See README.
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

    if (event.type === "payment_intent.succeeded") {
      await notifyOnPayment(event.data.object);
    }
    res.json({ received: true });
  }
);

app.use(express.json());

/* ---------------------------------------------------------------------
   1. Create a PaymentIntent for the current cart total.
   Called by the app before it shows the card form.
--------------------------------------------------------------------- */
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount, currency = "sgd", table, customer, items } = req.body;

    if (!Number.isInteger(amount) || amount < 50) {
      return res.status(400).json({ error: "Invalid amount (must be integer cents, min 50)." });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount, // cents — the app converts dollars -> cents before calling this
      currency,
      receipt_email: customer?.email,
      metadata: {
        table: table ? String(table) : "",
        customerName: customer?.name || "",
        customerEmail: customer?.email || "",
        customerPhone: customer?.phone || "",
        items: (items || []).map((i) => `${i.qty}x ${i.name} (${i.kind})`).join(", ").slice(0, 500),
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error("create-payment-intent failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------------
   2. Convenience confirmation — called by the app right after Stripe.js
   confirms the card payment client-side. We re-check status with Stripe
   (never trust the client's word alone) before sending notifications.
--------------------------------------------------------------------- */
app.post("/order-paid", async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) return res.status(400).json({ error: "paymentIntentId required" });

    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== "succeeded") {
      return res.status(400).json({ error: `Payment not confirmed (status: ${pi.status})` });
    }

    await notifyOnPayment(pi);
    res.json({ ok: true });
  } catch (err) {
    console.error("order-paid failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------------
   Notifications — fill in your real credentials in .env. Each block is
   independently optional: if the relevant env vars are missing, that
   channel is just skipped (logged, not thrown).
--------------------------------------------------------------------- */
async function notifyOnPayment(paymentIntent) {
  const total = (paymentIntent.amount / 100).toFixed(2);
  const { table, customerEmail, items } = paymentIntent.metadata || {};

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

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`WFA payments backend listening on :${port}`));
