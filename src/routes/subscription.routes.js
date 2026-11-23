import Stripe from "stripe";
import { Router } from "express";
import { transactions, users, findUserById } from "../db.js";
import { requireAuth, requireRole, badRequest, forbidden } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errors.js";
import { PREMIUM_PRICE_CENTS, PREMIUM_DURATION_DAYS } from "../constants.js";
import { grantPremium, hasActivePremium } from "../services/plan.js";

const router = Router();

let stripeClient;
export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  stripeClient ??= new Stripe(key);
  return stripeClient;
}

export function stripeNotConfigured(res) {
  return res.status(503).json({
    error:
      "Stripe isn't configured on this deployment. Add STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET to assignment-9-server/.env.",
  });
}

const clientUrl = () => process.env.CLIENT_URL?.trim() || "http://localhost:3000";

const asTransaction = (doc) => (doc ? { ...doc, _id: String(doc._id) } : null);

/** GET /api/subscription/status — the vendor's current plan (+ optional session lookup). */
router.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const doc = await findUserById(req.user.id);
    const premium = hasActivePremium(req.user);

    let session = null;
    const sessionId = req.query.session_id;
    if (typeof sessionId === "string" && sessionId.startsWith("cs_")) {
      // Read-only: reports whether the verified webhook has landed yet.
      const record = await transactions().findOne({ stripeSessionId: sessionId });
      session = record
        ? { id: sessionId, status: record.status, paidAt: record.createdAt ?? null }
        : { id: sessionId, status: "processing", paidAt: null };
    }

    res.json({
      plan: premium ? "premium" : "free",
      premium,
      expiresAt: doc?.subscriptionExpiresAt ?? null,
      limit: premium ? null : 3,
      session,
    });
  })
);

/**
 * POST /api/subscription/checkout — creates the Stripe Checkout session.
 * The vendor identity always comes from the verified token, never the body.
 */
router.post(
  "/checkout",
  requireAuth,
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const stripe = getStripe();
    if (!stripe) return stripeNotConfigured(res);

    const requestedVendorId = req.body?.vendorId;
    if (requestedVendorId && String(requestedVendorId) !== req.user.id) {
      return forbidden(res, "You can't start a subscription for another vendor.");
    }
    if (hasActivePremium(req.user)) {
      return badRequest(res, "You're already on the Premium plan.");
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: PREMIUM_PRICE_CENTS,
            product_data: {
              name: "PizzaHub Premium — 30 days",
              description: "Unlimited active menu items, premium badge and featured placement.",
            },
          },
        },
      ],
      client_reference_id: req.user.id,
      customer_email: req.user.email || undefined,
      metadata: { vendorId: req.user.id, plan: "premium", source: "pizzahub-subscription" },
      success_url: `${clientUrl()}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl()}/payment/cancel`,
    });

    res.json({ url: session.url, sessionId: session.id });
  })
);

/**
 * POST /api/subscription/cancel — a vendor can end Premium at any time.
 * The plan drops back to free immediately (there is no partial refund).
 */
  router.post(
    "/cancel",
    requireAuth,
    requireRole("vendor"),
    asyncHandler(async (req, res) => {
      if (!hasActivePremium(req.user)) {
        return badRequest(res, "You don't have an active Premium subscription.");
      }
      const vendorDoc = await findUserById(req.user.id);
      if (!vendorDoc) throw new Error("Vendor not found.");
      await users().updateOne(
        { _id: vendorDoc._id },
        { $set: { subscriptionPlan: "free", subscriptionExpiresAt: new Date().toISOString() } }
      );
      res.json({ plan: "free", expiresAt: new Date().toISOString() });
    })
  );

/** Records a verified Stripe payment — idempotent, keyed by the session id. */
export async function recordSubscriptionPayment(session) {
  const vendorId = String(session.client_reference_id || session.metadata?.vendorId || "");
  if (!vendorId) return { ok: false, reason: "missing-vendor" };

  const expiresAt = await grantPremium(vendorId, { extendFromNow: true });
  const vendor = await findUserById(vendorId);

  const now = new Date().toISOString();
  await transactions().updateOne(
    { stripeSessionId: session.id },
    {
      $set: {
        stripeSessionId: session.id,
        stripePaymentIntentId:
          typeof session.payment_intent === "string" ? session.payment_intent : null,
        vendorId,
        vendorName: vendor?.businessName || vendor?.name || vendor?.email || "",
        vendorEmail: vendor?.email || "",
        plan: "premium",
        amount: (session.amount_total ?? PREMIUM_PRICE_CENTS) / 100,
        currency: (session.currency ?? "usd").toUpperCase(),
        status: "paid",
        createdAt: now,
        updatedAt: now,
        expiresAt,
      },
    },
    { upsert: true }
  );

  return { ok: true, vendorId, expiresAt };
}

export default router;
export { asTransaction };
