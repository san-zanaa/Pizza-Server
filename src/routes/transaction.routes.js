import { Router } from "express";
import { transactions } from "../db.js";
import { requireAuth, forbidden } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errors.js";

const router = Router();

const sanitize = (doc) => (doc ? { ...doc, _id: String(doc._id) } : null);

/**
 * GET /api/transactions
 *  scope=admin | scope=all → every payment record (admin)
 *  scope=vendor|mine       → every record (admin) or the signed-in vendor's own
 *  default                 → all records for an admin, own records for a vendor
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
    const isAdmin = req.user.role === "admin";

    // Admins may open any transaction view; vendors only ever see their own.
    if (scope === "admin" || scope === "all") {
      if (!isAdmin) return forbidden(res, "Admin access required.");
    } else if (scope === "vendor" || scope === "mine") {
      if (isAdmin) {
        // admin inspecting the vendor view → every record
      } else if (req.user.role === "vendor") {
        filter.vendorId = req.user.id;
      } else {
        return forbidden(res, "Vendor access required.");
      }
    } else if (isAdmin) {
      // no scope: admin sees everything
    } else if (req.user.role === "vendor") {
      filter.vendorId = req.user.id;
    } else {
      return forbidden(res, "Vendor access required.");
    }

    const found = await transactions().find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ transactions: found.map(sanitize) });
  })
);

export default router;
