import { Router } from "express";
import { transactions } from "../db.js";
import { requireAuth, forbidden } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errors.js";

const router = Router();

const sanitize = (doc) => (doc ? { ...doc, _id: String(doc._id) } : null);

/**
 * GET /api/transactions
 *  scope=admin → every payment record
 *  default     → the signed-in vendor's own records
 *
 * Deliberately read-only: there is no PATCH/PUT/DELETE here, so a payment
 * status can never be flipped by hand (it is only written by the verified
 * Stripe webhook).
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { scope } = req.query;
    const filter = {};

    if (scope === "admin") {
      if (req.user.role !== "admin") return forbidden(res, "Admin access required.");
    } else {
      if (req.user.role !== "vendor") return forbidden(res, "Vendor access required.");
      filter.vendorId = req.user.id;
    }

    const found = await transactions().find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ transactions: found.map(sanitize) });
  })
);

export default router;
