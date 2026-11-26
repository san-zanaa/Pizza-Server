import { Router } from "express";
import { orders } from "../db.js";
import { findMenuItemById } from "./menu.routes.js";
import { requireAuth, requireRole, badRequest, forbidden } from "../middleware/auth.js";
import { getStripe, stripeNotConfigured, clientUrl } from "./subscription.routes.js";
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

/**
 * Shared fulfillment: turns a paid Stripe Checkout session into one or more
 * pending orders. Idempotent — keyed by `stripeSessionId`.
 * Returns { ok, orders?, reason? }.
 */
export async function fulfillOrderSession(session) {
  if (!session || (session.payment_status !== "paid" && session.status !== "complete")) {
    return { ok: false, reason: "not-paid" };
  }
  const meta = session.metadata || {};
  if (meta.type !== "order") return { ok: false, reason: "not-order" };

  const sessionId = String(session.id);
  const existing = await orders().find({ stripeSessionId: sessionId }).toArray();
  if (existing.length > 0) {
    return { ok: true, orders: existing.map(sanitize) };
  }

  const customerId = String(meta.customerId ?? "").trim();
  const customerName = meta.customerName ?? "";
  const customerEmail = meta.customerEmail ?? "";
  const deliveryDate = String(meta.deliveryDate ?? "").trim();
  const deliveryAddress = String(meta.deliveryAddress ?? "").trim();
  const message = String(meta.message ?? "").trim().slice(0, 1000);
  const isCombo = meta.isCombo === "true";

  if (!customerId || !isFutureDate(deliveryDate) || deliveryAddress.length < 5) {
    return { ok: false, reason: "invalid-payload" };
  }

  const now = new Date().toISOString();

  if (isCombo) {
    let itemIds = [];
    try {
      itemIds = JSON.parse(meta.itemIds || "[]");
    } catch {
      return { ok: false, reason: "invalid-payload" };
    }
    if (!Array.isArray(itemIds) || itemIds.length !== 2) {
      return { ok: false, reason: "invalid-payload" };
    }
    const items = await Promise.all(itemIds.map((id) => findMenuItemById(id)));
    if (items.some((it) => !it)) return { ok: false, reason: "item-not-found" };
    if (items.some((it) => it.status !== "approved")) {
      return { ok: false, reason: "not-approved" };
    }
    if (items.some((it) => String(it.vendorId) === customerId)) {
      return { ok: false, reason: "own-item" };
    }
    for (const item of items) {
      const dup = await orders().findOne({
        itemId: String(item._id),
        customerId,
        deliveryDate,
        status: { $in: ["pending", "accepted"] },
      });
      if (dup) return { ok: false, reason: "duplicate" };
    }

    const COMBO_DISCOUNT = 100;
    const total = items[0].price + items[1].price;
    const discount = Math.min(COMBO_DISCOUNT, total);
    const chargedFirst = Math.max(0, items[0].price - discount);

    const ordersToInsert = items.map((item, index) => ({
      _id: crypto.randomUUID(),
      itemId: item._id ? String(item._id) : item.id,
      itemName: item.itemName,
      itemImage: item.images?.[0] ?? "",
      itemPrice: index === 0 ? chargedFirst : item.price,
      comboOriginalPrice: item.price,
      comboDiscount: discount,
      comboPartnerItemId: itemIds[index === 0 ? 1 : 0],
      isCombo: true,
      vendorId: String(item.vendorId ?? ""),
      vendorName: item.vendorName ?? "",
      customerId,
      customerName,
      customerEmail,
      deliveryDate,
      deliveryAddress,
      message,
      status: "pending",
      stripeSessionId: sessionId,
      createdAt: now,
      updatedAt: now,
    }));

    await orders().insertMany(ordersToInsert);
    return { ok: true, orders: ordersToInsert.map(sanitize) };
  }

  const item = await findMenuItemById(meta.itemId);
  if (!item) return { ok: false, reason: "item-not-found" };
  if (item.status !== "approved") return { ok: false, reason: "not-approved" };
  if (String(item.vendorId) === customerId) return { ok: false, reason: "own-item" };

  const duplicate = await orders().findOne({
    itemId: meta.itemId,
    customerId,
    deliveryDate,
    status: { $in: ["pending", "accepted"] },
  });
  if (duplicate) return { ok: false, reason: "duplicate" };

  const order = {
    _id: crypto.randomUUID(),
    itemId: meta.itemId,
    itemName: item.itemName,
    itemImage: item.images?.[0] ?? "",
    itemPrice: item.price,
    vendorId: String(item.vendorId ?? ""),
    vendorName: item.vendorName ?? "",
    customerId,
    customerName,
    customerEmail,
    deliveryDate,
    deliveryAddress,
    message,
    status: "pending",
    stripeSessionId: sessionId,
    createdAt: now,
    updatedAt: now,
  };
  await orders().insertOne(order);
  return { ok: true, orders: [sanitize(order)] };
}

/**
 * POST /api/orders/checkout — creates a Stripe Checkout session for a single
 * dish or a combo. The order itself is created only after payment succeeds.
 */
router.post(
  "/checkout",
  requireAuth,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const deliveryDate = typeof body.deliveryDate === "string" ? body.deliveryDate.trim() : "";
    const deliveryAddress = typeof body.deliveryAddress === "string" ? body.deliveryAddress.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 1000) : "";

    if (!isFutureDate(deliveryDate)) {
      return badRequest(res, "A valid delivery date (today or later) is required.");
    }
    if (deliveryAddress.length < 5) {
      return badRequest(res, "Enter a delivery address (at least 5 characters).");
    }

    const stripe = getStripe();
    if (!stripe) return stripeNotConfigured(res);

    const isCombo = Array.isArray(body.itemIds) && body.itemIds.length === 2;
    let lineItem;
    let metadata;

    if (isCombo) {
      const itemIds = body.itemIds.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
      if (itemIds.length !== 2 || new Set(itemIds).size !== 2) {
        return badRequest(res, "A combo needs two different dishes.");
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
      const charged = Math.max(0, total - discount);

      lineItem = {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(charged * 100),
          product_data: {
            name: `${items[0].itemName} + ${items[1].itemName}`,
            description: `Combo (save 100) · ${items[0].vendorName || "PizzaHub"} & ${items[1].vendorName || "PizzaHub"}`,
          },
        },
      };
      metadata = {
        type: "order",
        isCombo: "true",
        itemIds: JSON.stringify(itemIds),
        deliveryDate,
        deliveryAddress,
        message,
        customerId: req.user.id,
        customerName: req.user.name,
        customerEmail: req.user.email,
      };
    } else {
      const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
      if (!itemId) return badRequest(res, "Item is required.");
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
        return badRequest(res, "You already have an active order for this item on that delivery date.");
      }

      lineItem = {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(item.price * 100),
          product_data: {
            name: item.itemName,
            description: `From ${item.vendorName || "PizzaHub vendor"}`,
          },
        },
      };
      metadata = {
        type: "order",
        isCombo: "false",
        itemId,
        deliveryDate,
        deliveryAddress,
        message,
        customerId: req.user.id,
        customerName: req.user.name,
        customerEmail: req.user.email,
      };
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [lineItem],
      client_reference_id: req.user.id,
      customer_email: req.user.email || undefined,
      metadata,
      success_url: `${clientUrl()}/payment/order-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl()}/payment/order-cancel`,
    });

    res.json({ url: session.url, sessionId: session.id });
  })
);

/**
 * GET /api/orders/verify-session?session_id=cs_... — used by the success page.
 * Retrieves the Stripe session, verifies payment, and creates the order
 * idempotently. Returns { status, orders }.
 */
router.get(
  "/verify-session",
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessionId = String(req.query.session_id ?? "").trim();
    if (!sessionId.startsWith("cs_")) {
      return badRequest(res, "Invalid session id.");
    }
    const stripe = getStripe();
    if (!stripe) return stripeNotConfigured(res);

    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      throw new HttpError(404, "Session not found.");
    }

    if (session.payment_status !== "paid") {
      return res.json({ status: session.payment_status, orders: [] });
    }

    // Only the paying customer may verify their own session.
    if (session.client_reference_id && String(session.client_reference_id) !== req.user.id) {
      return forbidden(res, "You can't verify another customer's payment.");
    }

    const result = await fulfillOrderSession(session);
    if (!result.ok) {
      // Surface a helpful message for known failure reasons.
      const messages = {
        "not-paid": "Payment not completed yet.",
        duplicate: "This order was already placed.",
        "item-not-found": "One of the dishes is no longer available.",
        "not-approved": "One of the dishes is no longer available for ordering.",
        "own-item": "You can't order your own dish.",
        "invalid-payload": "The order details were invalid.",
      };
      if (result.reason === "duplicate") {
        // Already placed — try to return the existing order.
        const existing = await orders().find({ stripeSessionId: sessionId }).toArray();
        if (existing.length > 0) {
          return res.json({ status: "paid", orders: existing.map(sanitize) });
        }
      }
      return badRequest(res, messages[result.reason] || "Couldn't complete the order.");
    }
    res.json({ status: "paid", orders: result.orders });
  })
);

export default router;
