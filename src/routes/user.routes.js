import { Router } from "express";
import { users, findUserById } from "../db.js";
import { requireAuth, requireRole, badRequest, forbidden } from "../middleware/auth.js";
import { asyncHandler, HttpError } from "../middleware/errors.js";
import { USER_ROLES } from "../constants.js";

const router = Router();

const asUser = (doc) =>
  doc
    ? {
        _id: String(doc._id),
        id: String(doc._id),
        name: doc.name ?? "",
        email: doc.email ?? "",
        image: doc.image ?? null,
        role: doc.role ?? "customer",
        blocked: doc.isBlocked === true,
        plan: doc.subscriptionPlan === "premium" ? "premium" : "free",
        businessName: doc.businessName ?? "",
        subscriptionExpiresAt: doc.subscriptionExpiresAt ?? null,
        createdAt: doc.createdAt ?? null,
      }
    : null;

/** GET /api/users — admin directory with search + role filter. */
router.get(
  "/",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { q, role } = req.query;
    const filter = {};

    if (q) {
      const rx = { $regex: String(q).trim(), $options: "i" };
      filter.$or = [{ name: rx }, { email: rx }];
    }
    if (role && USER_ROLES.includes(role)) filter.role = role;

    const found = await users().find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ users: found.map(asUser) });
  })
);

/** GET /api/users/:id — a single user's public-ish profile (admin). */
router.get(
  "/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const user = await findUserById(req.params.id);
    if (!user) throw new HttpError(404, "User not found.");
    res.json({ user: asUser(user) });
  })
);

/**
 * PATCH /api/users/:id — admin only, and the only field it accepts is `blocked`.
 * Role, plan and profile data are intentionally NOT updatable from here.
 */
router.patch(
  "/:id",
  requireAuth,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const existing = await findUserById(id);
    if (!existing) throw new HttpError(404, "User not found.");
    if (id === req.user.id) return forbidden(res, "You can't block your own admin account.");

    if (typeof req.body?.blocked !== "boolean") {
      return badRequest(res, "Expected a boolean `blocked` field.");
    }

    await users().updateOne({ _id: existing._id }, { $set: { isBlocked: req.body.blocked } });
    const updated = await users().findOne({ _id: existing._id });
    res.json({ user: asUser(updated) });
  })
);

export { asUser };
export default router;
