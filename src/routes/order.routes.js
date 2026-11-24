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
      if (req.user.role !== "admin" && req.user.role !== "vendor") {
        return forbidden(res, "Vendor access required.");
      }
      // admins may inspect the vendor queue without being narrowed to one vendor
      if (req.user.role !== "admin") filter.vendorId = req.user.id;
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
 * POST /api/orders/combo — order two dishes together as a combo.
 * Applies a flat 100 tk discount to the combined total (taken off the
 * first item's charged price) and creates one pending order per dish so
 * each vendor can accept/reject independently.
 */
router.post(
  "/combo",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const itemIds = Array.isArray(body.itemIds)
      ? body.itemIds.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean)
      : [];
    const deliveryDate = typeof body.deliveryDate === "string" ? body.deliveryDate.trim() : "";
    const deliveryAddress =
      typeof body.deliveryAddress === "string" ? body.deliveryAddress.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 1000) : "";

    if (itemIds.length !== 2) return badRequest(res, "A combo needs exactly two dishes.");
    if (new Set(itemIds).size !== 2) return badRequest(res, "Combo dishes must be different.");
    if (!isFutureDate(deliveryDate)) {
      return badRequest(res, "A valid delivery date (today or later) is required.");
    }
    if (deliveryAddress.length < 5) {
      return badRequest(res, "Enter a delivery address (at least 5 characters).");
    }

    const items = await Promise.all(itemIds.map((id) => findMenuItemById(id)));
    if (items.some((it) => !it)) throw new HttpError(404, "One of the combo dishes was not found.");
    if (items.some((it) => it.status !== "approved")) {
      return badRequest(res, "One of the combo dishes isn't available for ordering.");
    }
    if (items.some((it) => String(it.vendorId) === req.user.id)) {
      return forbidden(res, "You can't order an item from your own menu.");
    }

    const COMBO_DISCOUNT = 100;
    const total = items[0].price + items[1].price;
    const discount = Math.min(COMBO_DISCOUNT, total);
    // Apply the discount to the first item (floored at 0).
    const chargedFirst = Math.max(0, items[0].price - discount);

    const now = new Date().toISOString();
    const ordersToInsert = items.map((item, index) => {
      const isCombo = true;
      const order = {
        _id: crypto.randomUUID(),
        itemId: item._id ? String(item._id) : item.id,
        itemName: item.itemName,
        itemImage: item.images?.[0] ?? "",
        itemPrice: index === 0 ? chargedFirst : item.price,
        comboOriginalPrice: item.price,
        comboDiscount: discount,
        comboPartnerItemId: itemIds[index === 0 ? 1 : 0],
        isCombo,
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
      return order;
    });

    // Duplicate guard per item + delivery date.
    for (const o of ordersToInsert) {
      const dup = await orders().findOne({
        itemId: o.itemId,
        customerId: req.user.id,
        deliveryDate,
        status: { $in: ["pending", "accepted"] },
      });
      if (dup) {
        return badRequest(res, `You already have an active order for ${o.itemName} on that delivery date.`);
      }
    }

    await orders().insertMany(ordersToInsert);
    res.status(201).json({ orders: ordersToInsert.map(sanitize), comboDiscount: discount });
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
