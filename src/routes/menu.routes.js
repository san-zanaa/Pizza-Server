import { Router } from "express";
import { menuItems, users, findUserById } from "../db.js";
import { requireAuth, optionalAuth, requireRole, badRequest, forbidden, unauthorized } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { validateMenuItem } from "../validation.js";
import { FREE_PLAN_ACTIVE_LIMIT, MENU_CATEGORIES, MENU_STATUSES } from "../constants.js";
import { activeCountForVendor, canPublishMore, hasActivePremium } from "../services/plan.js";

const router = Router();

export async function findMenuItemById(id) {
  const { ObjectId } = await import("mongodb");
  const str = String(id ?? "").trim();
  if (!str) return null;
  let wantObjectId = null;
  if (/^[0-9a-fA-F]{24}$/.test(str)) wantObjectId = new ObjectId(str);
  const or = [{ _id: str }, { id: str }];
  if (wantObjectId) or.push({ _id: wantObjectId });
  return menuItems().findOne({ $or: or });
}

const sanitize = (doc) => (doc ? { ...doc, _id: String(doc._id) } : null);

/** Sort helper: legacy seed items use ids like "food-039" → sort on the trailing number. */
function byId(a, b) {
  const na = Number(String(a.id ?? "").match(/(\d+)\s*$/)?.[1] ?? 0);
  const nb = Number(String(b.id ?? "").match(/(\d+)\s*$/)?.[1] ?? 0);
  if (na !== nb) return na - nb;
  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

/**
 * Sorting for the menu list.
 * Accepted: "price_asc", "price_desc", "name_asc", "name_desc",
 * "location_asc", "createdAt_asc", "createdAt_desc". Anything else → default.
 */
function applySort(items, sort) {
  const key = String(sort ?? "").trim().toLowerCase();
  const fieldMap = {
    price_asc: "price",
    price_desc: "price",
    name_asc: "itemName",
    name_desc: "itemName",
    location_asc: "location",
    location_desc: "location",
    createdat_asc: "createdAt",
    createdat_desc: "createdAt",
  };
  const field = fieldMap[key];
  if (!field) return items;

  const desc = key.endsWith("_desc");
  const a = items.map((item) => ({ item, field: item[field] ?? "" }));
  a.sort((x, y) => {
    const result =
      typeof x.field === "number" && typeof y.field === "number"
        ? x.field - y.field
        : String(x.field).localeCompare(String(y.field));
    return desc ? -result : result;
  });
  return a.map((entry) => entry.item);
}

/**
 * GET /api/menu
 * scope: "admin" (all, admin only) | "mine" (own, vendor only) | undefined (public: approved only)
 * q, category, location, status, limit, sort
 */
router.get(
  "/",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { scope, q, category, location, status, limit, sort } = req.query;
    const filter = {};

    if (scope !== undefined && scope !== "admin" && scope !== "mine") {
      throw new HttpError(400, "Invalid scope.");
    }
    if (status !== undefined && !MENU_STATUSES.includes(status)) {
      throw new HttpError(400, "Invalid status filter.");
    }

    if (scope === "admin") {
      if (!req.user) throw new HttpError(401, "You must be signed in to do that.");
      if (req.user.role !== "admin") throw new HttpError(403, "Admin access required.");
      if (status) filter.status = status;
    } else if (scope === "mine") {
      if (!req.user) throw new HttpError(401, "You must be signed in to do that.");
      if (req.user.role !== "vendor" && req.user.role !== "admin") {
        throw new HttpError(403, "Vendor access required.");
      }
      filter.vendorId = req.user.id;
      if (status) filter.status = status;
    } else {
      // Public storefront: only approved items are ever visible.
      filter.status = "approved";
    }

    if (category) filter.category = category;
    if (location) filter.location = { $regex: String(location).trim(), $options: "i" };
    if (q) {
      const rx = { $regex: String(q).trim(), $options: "i" };
      filter.$or = [{ itemName: rx }, { description: rx }, { vendorName: rx }];
    }

    let items = await menuItems().find(filter).toArray();
    items.sort(byId);

    const parsedLimit = Number(limit);
    if (limit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) {
      throw new HttpError(400, "Invalid limit.");
    }
    if (Number.isFinite(parsedLimit) && parsedLimit >= 1) {
      items = items.slice(0, Math.min(Math.floor(parsedLimit), 100));
    }

    items = applySort(items, sort);

    res.json({ items: items.map(sanitize) });
  })
);

/**
 * GET /api/menu/categories
 * Returns `[{ category, count }]` — only categories that actually have
 * approved items, in the spec's canonical order.
 */
router.get(
  "/categories",
  asyncHandler(async (_req, res) => {
    const counts = await menuItems()
      .aggregate([
        { $match: { status: "approved" } },
        { $group: { _id: "$category", count: { $sum: 1 } } },
      ])
      .toArray();

    const byName = new Map(counts.map((row) => [row._id, row.count]));
    const categories = MENU_CATEGORIES.filter((name) => byName.has(name)).map(
      (name) => ({ category: name, count: byName.get(name) })
    );

    // Anything outside the canonical list still shows up, ordered last.
    for (const row of counts) {
      if (row._id && !MENU_CATEGORIES.includes(row._id)) {
        categories.push({ category: row._id, count: row.count });
      }
    }

    res.json({ categories });
  })
);

/** GET /api/menu/stats — the counts the vendor overview card needs. */
router.get(
  "/stats",
  requireAuth,
  requireRole("vendor", "admin"),
  asyncHandler(async (req, res) => {
    const active = await activeCountForVendor(req.user.id);
    res.json({
      active,
      limit: hasActivePremium(req.user) ? null : FREE_PLAN_ACTIVE_LIMIT,
      premium: hasActivePremium(req.user),
      canPublish: await canPublishMore(req.user),
    });
  })
);

/** GET /api/menu/:id — approved items are public, everything else is owner/admin only. */
router.get(
  "/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const item = await findMenuItemById(req.params.id);
    if (!item) throw new HttpError(404, "This dish isn't on the menu.");

    const isOwner = req.user && item.vendorId && String(item.vendorId) === req.user.id;
    const isAdmin = req.user?.role === "admin";
    if (item.status !== "approved" && !isOwner && !isAdmin) {
      throw new HttpError(404, "This dish isn't available right now.");
    }

    res.json({ item: sanitize(item) });
  })
);

/**
 * POST /api/menu — vendors submit an item (status starts as "pending").
 * Admins may publish immediately. Never accepts client-supplied identity fields.
 */
router.post(
  "/",
  requireAuth,
  requireRole("vendor", "admin"),
  asyncHandler(async (req, res) => {
    let patch;
    try {
      patch = validateMenuItem(req.body ?? {});
    } catch (err) {
      return badRequest(res, err.message);
    }

    const isAdmin = req.user.role === "admin";
    if (!isAdmin && !(await canPublishMore(req.user))) {
      return forbidden(
        res,
        `Free plan allows up to ${FREE_PLAN_ACTIVE_LIMIT} active items. Upgrade to Premium for unlimited reach.`
      );
    }

    const now = new Date().toISOString();
    const item = {
      _id: crypto.randomUUID(),
      id: crypto.randomUUID(),
      ...patch,
      vendorId: req.user.id,
      vendorName: req.user.businessName || req.user.name || req.user.email,
      status: isAdmin ? "approved" : "pending",
      createdAt: now,
      updatedAt: now,
    };

    await menuItems().insertOne(item);
    res.status(201).json({ item: sanitize(item) });
  })
);

/**
 * PATCH /api/menu/:id
 *  - admins may edit everything and change the review status;
 *  - vendors may edit their own item's content and flip availability
 *    (approved ⇄ inactive) but can never approve their own item.
 */
router.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const existing = await findMenuItemById(id);
    if (!existing) throw new HttpError(404, "Menu item not found.");

    const isAdmin = req.user.role === "admin";
    const isOwner = req.user.role === "vendor" && String(existing.vendorId) === req.user.id;
    if (!isAdmin && !isOwner) {
      return forbidden(res, "You can only modify your own menu items.");
    }

    let content;
    try {
      content = validateMenuItem(req.body ?? {}, { partial: true });
    } catch (err) {
      return badRequest(res, err.message);
    }
    delete content.status;

    const patch = { ...content, updatedAt: new Date().toISOString() };

    if (req.body?.status !== undefined) {
      const next = String(req.body.status);

      if (isAdmin) {
        if (!["pending", "approved", "rejected", "inactive"].includes(next)) {
          return badRequest(res, "Invalid status.");
        }
        if (next === "approved" && existing.status !== "approved") {
          const overLimit = await exceedsFreeLimit(existing.vendorId);
          if (overLimit) {
            return forbidden(
              res,
              "This vendor is on the Free plan and already has 3 active items. Upgrade them to Premium first."
            );
          }
        }
        patch.status = next;
      } else {
        // Vendor: availability toggle only, and only on an already-approved item.
        if (!["approved", "inactive"].includes(next)) {
          return forbidden(res, "Only an administrator can approve or reject menu items.");
        }
        if (!["approved", "inactive"].includes(existing.status)) {
          return forbidden(res, "This item is waiting for admin approval.");
        }
        if (next === "approved" && existing.status !== "approved") {
          if (!(await canPublishMore(req.user))) {
            return forbidden(
              res,
              `Free plan allows up to ${FREE_PLAN_ACTIVE_LIMIT} active items. Upgrade to Premium for unlimited reach.`
            );
          }
        }
        patch.status = next;
      }
    }

    await menuItems().updateOne({ _id: existing._id }, { $set: patch });
    const updated = await findMenuItemById(existing._id);
    res.json({ item: sanitize(updated) });
  })
);

/** Free-plan cap when an admin publishes an item owned by a vendor. */
async function exceedsFreeLimit(vendorId) {
  if (!vendorId) return false;
  const vendor = await findUserById(vendorId);
  if (!vendor) return false;
  if (vendor.subscriptionPlan === "premium") {
    const expires = vendor.subscriptionExpiresAt ? new Date(vendor.subscriptionExpiresAt) : null;
    if (!expires || expires.getTime() > Date.now()) return false;
  }
  const active = await menuItems().countDocuments({ vendorId: String(vendorId), status: "approved" });
  return active >= FREE_PLAN_ACTIVE_LIMIT;
}

/** DELETE /api/menu/:id — owner vendor or admin. */
router.delete(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const existing = await findMenuItemById(id);
    if (!existing) throw new HttpError(404, "Menu item not found.");

    const isAdmin = req.user.role === "admin";
    const isOwner = req.user.role === "vendor" && String(existing.vendorId) === req.user.id;
    if (!isAdmin && !isOwner) {
      return forbidden(res, "You can only delete your own menu items.");
    }

    await menuItems().deleteOne({ _id: existing._id });
    res.json({ ok: true });
  })
);

export default router;
