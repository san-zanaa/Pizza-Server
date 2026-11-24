import { Router } from "express";
import { orders } from "../db.js";
import { findMenuItemById } from "./menu.routes.js";
import { requireAuth, requireRole, badRequest, forbidden } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { isFutureDate } from "../validation.js";
import { ORDER_STATUSES } from "../constants.js";

const router = Router();

const sanitize = (doc) => (doc ? { ...doc, _id: String(doc._id) } : null);

/**
 * GET /api/orders
 *  scope=vendor → orders for the signed-in vendor's items
 *  scope=all    → every order (admin)
 *  default      → the signed-in customer's own orders
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { scope } = req.query;
    const filter = {};

    if (scope === "vendor") {
      if (req.user.role !== "vendor") return forbidden(res, "Vendor access required.");
      filter.vendorId = req.user.id;
    } else if (scope === "all") {
      if (req.user.role !== "admin") return forbidden(res, "Admin access required.");
    } else {
      filter.customerId = req.user.id;
    }

    const found = await orders().find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ orders: found.map(sanitize) });
  })
);

/**
 * POST /api/orders — customers only.
 * Guards: approved item, not the customer's own product, no duplicate
 * pending/accepted order for the same item + delivery date.
 */
router.post(
  "/",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
    const deliveryDate = typeof body.deliveryDate === "string" ? body.deliveryDate.trim() : "";
    const deliveryAddress =
      typeof body.deliveryAddress === "string" ? body.deliveryAddress.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 1000) : "";

    if (!itemId) return badRequest(res, "Item is required.");
    if (!isFutureDate(deliveryDate)) {
      return badRequest(res, "A valid delivery date (today or later) is required.");
    }
    if (deliveryAddress.length < 5) {
      return badRequest(res, "Enter a delivery address (at least 5 characters).");
    }

    // Seeded items store `_id` as an ObjectId while API-created ones use a
    // uuid string — `findMenuItemById` matches both.
    const item = await findMenuItemById(itemId);
    if (!item) throw new HttpError(404, "Menu item not found.");
    if (item.status !== "approved") {
      return badRequest(res, "This item is not available for ordering.");
    }
    if (String(item.vendorId) === req.user.id) {
      return forbidden(res, "You can't order an item from your own menu.");
    }

    const duplicate = await orders().findOne({
      itemId,
      customerId: req.user.id,
      deliveryDate,
      status: { $in: ["pending", "accepted"] },
    });
    if (duplicate) {
      return badRequest(
        res,
        "You already have an active order for this item on that delivery date."
      );
    }

    const now = new Date().toISOString();
    const order = {
      _id: crypto.randomUUID(),
      itemId,
      itemName: item.itemName,
      itemImage: item.images?.[0] ?? "",
      itemPrice: item.price,
      vendorId: String(item.vendorId ?? ""),
      vendorName: item.vendorName ?? "",
      customerId: req.user.id,
      customerName: req.user.name,
      customerEmail: req.user.email,
      deliveryDate,
      deliveryAddress,
      message,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    await orders().insertOne(order);
    res.status(201).json({ order: sanitize(order) });
  })
);

/**
 * PATCH /api/orders/:id — the only status transitions allowed:
 *  - vendor owner: pending → accepted | rejected   (exactly once)
 *  - customer owner: pending → cancelled
 */
router.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const existing = await orders().findOne({ _id: id });
    if (!existing) throw new HttpError(404, "Order not found.");

    const next = String(req.body?.status ?? "").toLowerCase();
    if (!ORDER_STATUSES.includes(next)) return badRequest(res, "Invalid order status.");

    const isVendorOwner = req.user.role === "vendor" && existing.vendorId === req.user.id;
    const isCustomerOwner = existing.customerId === req.user.id;

    let allowed = false;
    if (isVendorOwner && (next === "accepted" || next === "rejected")) {
      allowed = true;
    } else if (isCustomerOwner && next === "cancelled") {
      allowed = true;
    }

    if (!allowed) {
      return forbidden(res, "You're not allowed to change this order.");
    }
    if (existing.status !== "pending") {
      return badRequest(
        res,
        `This order is already ${existing.status} and can't be changed.`
      );
    }

    const now = new Date().toISOString();
    await orders().updateOne({ _id: id }, { $set: { status: next, updatedAt: now } });
    const updated = await orders().findOne({ _id: id });
    res.json({ order: sanitize(updated) });
  })
);

export default router;
