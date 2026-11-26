import { Router, raw } from "express";
import { transactions } from "../db.js";
import { getStripe, stripeNotConfigured, recordSubscriptionPayment } from "./subscription.routes.js";
import { fulfillOrderSession } from "./order.routes.js";

/**
 * POST /api/webhooks/stripe
 *
 * The ONLY place that activates Premium. The success page redirect is never
 * trusted — it just polls this record's status for display purposes.
 *
 * Mounted with express.raw() so the Stripe signature can be verified against
 * the exact request bytes.
 */
const router = Router();
router.post("/stripe", raw({ type: "application/json" }), async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return stripeNotConfigured(res);

    const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    if (!secret) {
      return res
        .status(503)
        .json({ error: "Missing STRIPE_WEBHOOK_SECRET in assignment-9-server/.env." });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
    } catch (err) {
      return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.payment_status === "paid" || session.status === "complete") {
          if (session.metadata?.type === "order") {
            const result = await fulfillOrderSession(session);
            if (!result.ok && result.reason !== "duplicate") {
              return res.status(400).json({ error: `Could not apply payment: ${result.reason}` });
            }
          } else {
            const result = await recordSubscriptionPayment(session);
            if (!result.ok) {
              return res.status(400).json({ error: `Could not apply payment: ${result.reason}` });
            }
          }
        }
        break;
      }
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        const session = event.data.object;
        await transactions().updateOne(
          { stripeSessionId: session.id, status: { $ne: "paid" } },
          { $set: { status: "failed", updatedAt: new Date().toISOString() } }
        );
        break;
      }
      case "charge.refunded": {
        const charge = event.data.object;
        const intent =
          typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
        if (intent) {
          await transactions().updateOne(
            { stripePaymentIntentId: intent },
            { $set: { status: "failed", updatedAt: new Date().toISOString() } }
          );
        }
        break;
      }
      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error("[PizzaHub API] webhook error", err);
    res.status(500).json({ error: "Webhook handling failed." });
  }
});

export default router;
