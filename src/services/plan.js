import { menuItems, users, findUserById } from "../db.js";
import { FREE_PLAN_ACTIVE_LIMIT, PREMIUM_DURATION_DAYS } from "../constants.js";

/** Premium is time-boxed: an expired subscription silently falls back to free. */
export function hasActivePremium(user) {
  if (!user || user.plan !== "premium") return false;
  if (!user.subscriptionExpiresAt) return true;
  const expires = new Date(user.subscriptionExpiresAt);
  return !Number.isNaN(expires.getTime()) && expires.getTime() > Date.now();
}

/** Number of menu items currently live for a vendor. */
export async function activeCountForVendor(vendorId) {
  if (!vendorId) return 0;
  return await menuItems().countDocuments({ vendorId: String(vendorId), status: "approved" });
}

/** Free plan = at most 3 approved items; premium = unlimited. */
export async function canPublishMore(user) {
  if (!user) return false;
  if (user.role === "admin") return true; // admins have no subscription plan
  if (user.role !== "vendor") return false;
  if (hasActivePremium(user)) return true;
  const active = await activeCountForVendor(user.id);
  return active < FREE_PLAN_ACTIVE_LIMIT;
}

/** Extends a vendor's premium subscription by PREMIUM_DURATION_DAYS from now (or later). */
export async function grantPremium(vendorId, { extendFromNow = true } = {}) {
  const current = await findUserById(vendorId);
  const now = Date.now();
  let base = now;
  if (!extendFromNow && current?.subscriptionExpiresAt) {
    const existing = new Date(current.subscriptionExpiresAt).getTime();
    if (Number.isFinite(existing) && existing > now) base = existing;
  }
  const expiresAt = new Date(base + PREMIUM_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  if (current) {
    await users().updateOne(
      { _id: current._id },
      { $set: { subscriptionPlan: "premium", subscriptionExpiresAt: expiresAt } }
    );
  }
  return expiresAt;
}

