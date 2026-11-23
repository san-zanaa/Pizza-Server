import { Router } from "express";
import { users, findUserById } from "../db.js";
import { requireAuth, badRequest, forbidden } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/errors.js";
import { isImageUrl } from "../validation.js";
import { hasActivePremium } from "../services/plan.js";

const router = Router();

/**
 * GET /api/profile — the signed-in user's editable profile.
 * The role / plan / blocked values come from the database and are read-only.
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const doc = await findUserById(req.user.id);
    res.json({
      user: {
        id: req.user.id,
        name: doc?.name ?? req.user.name,
        email: doc?.email ?? req.user.email,
        image: doc?.image ?? null,
        role: req.user.role,
        businessName: doc?.businessName ?? "",
        blocked: req.user.blocked,
        plan: hasActivePremium(req.user) ? "premium" : "free",
        subscriptionExpiresAt: doc?.subscriptionExpiresAt ?? null,
      },
    });
  })
);

/**
 * PATCH /api/profile — name, avatar link and (for vendors) business name.
 * Explicitly refuses role / plan / blocked changes so a client can't
 * promote itself or unblock itself.
 */
router.patch(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const patch = {};

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (name.length < 2 || name.length > 80) {
        return badRequest(res, "Name must be between 2 and 80 characters.");
      }
      patch.name = name;
    }

    if (body.image !== undefined) {
      const image = String(body.image).trim();
      if (image && !isImageUrl(image)) {
        return badRequest(res, "Profile image must be a valid http/https link.");
      }
      patch.image = image || null;
    }

    if (body.businessName !== undefined) {
      if (req.user.role !== "vendor") {
        return badRequest(res, "Business name only applies to vendor accounts.");
      }
      const businessName = String(body.businessName).trim();
      if (businessName.length < 2 || businessName.length > 80) {
        return badRequest(res, "Business name must be between 2 and 80 characters.");
      }
      patch.businessName = businessName;
    }

    const readOnly = ["role", "plan", "blocked", "isBlocked", "subscriptionPlan", "subscriptionExpiresAt", "email"];
    const attempted = readOnly.filter((key) => body[key] !== undefined);
    if (attempted.length) {
      return forbidden(
        res,
        `You can't change ${attempted.join(", ")} from your profile.`
      );
    }

    if (Object.keys(patch).length === 0) {
      return badRequest(res, "No profile fields to update.");
    }

    const userDoc = await findUserById(req.user.id);
    if (!userDoc) return badRequest(res, "Your account no longer exists.");
    await users().updateOne({ _id: userDoc._id }, { $set: patch });
    const updated = await findUserById(req.user.id);

    res.json({
      user: {
        id: req.user.id,
        name: updated?.name ?? "",
        email: updated?.email ?? "",
        image: updated?.image ?? null,
        role: req.user.role,
        businessName: updated?.businessName ?? "",
        blocked: req.user.blocked,
        plan: hasActivePremium(req.user) ? "premium" : "free",
        subscriptionExpiresAt: updated?.subscriptionExpiresAt ?? null,
      },
    });
  })
);

export default router;
