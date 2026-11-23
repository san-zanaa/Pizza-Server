import { Router } from "express";
import { menuItems, orders, transactions, users } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errors.js";
import { hasActivePremium, activeCountForVendor } from "../services/plan.js";
import { FREE_PLAN_ACTIVE_LIMIT } from "../constants.js";

const router = Router();

/**
 * GET /api/overview — role-dependent dashboard totals.
 * Admin: platform-wide · Vendor: own menu + order pipeline · Customer: own orders.
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role === "admin") {
      const [totalUsers, totalVendors, totalCustomers, totalMenuItems, pendingMenuItems, totalTransactions] =
        await Promise.all([
          users().countDocuments({}),
          users().countDocuments({ role: "vendor" }),
          users().countDocuments({ role: "customer" }),
          menuItems().countDocuments({}),
          menuItems().countDocuments({ status: "pending" }),
          transactions().countDocuments({}),
        ]);

      return res.json({
        totalUsers,
        totalVendors,
        totalCustomers,
        totalMenuItems,
        pendingMenuItems,
        totalTransactions,
      });
    }

    if (req.user.role === "vendor") {
      const [totalItems, pendingOrders, acceptedOrders, rejectedOrders] = await Promise.all([
        menuItems().countDocuments({ vendorId: req.user.id }),
        orders().countDocuments({ vendorId: req.user.id, status: "pending" }),
        orders().countDocuments({ vendorId: req.user.id, status: "accepted" }),
        orders().countDocuments({ vendorId: req.user.id, status: "rejected" }),
      ]);
      const activeItems = await activeCountForVendor(req.user.id);

      return res.json({
        totalItems,
        activeItems,
        pendingOrders,
        acceptedOrders,
        rejectedOrders,
        plan: hasActivePremium(req.user) ? "premium" : "free",
        planLimit: hasActivePremium(req.user) ? null : FREE_PLAN_ACTIVE_LIMIT,
        subscriptionExpiresAt: req.user.subscriptionExpiresAt ?? null,
      });
    }

    const [totalOrders, pendingOrders, acceptedOrders, rejectedOrders, cancelledOrders] =
      await Promise.all([
        orders().countDocuments({ customerId: req.user.id }),
        orders().countDocuments({ customerId: req.user.id, status: "pending" }),
        orders().countDocuments({ customerId: req.user.id, status: "accepted" }),
        orders().countDocuments({ customerId: req.user.id, status: "rejected" }),
        orders().countDocuments({ customerId: req.user.id, status: "cancelled" }),
      ]);

    return res.json({ totalOrders, pendingOrders, acceptedOrders, rejectedOrders, cancelledOrders });
  })
);

export default router;
