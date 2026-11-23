import { menuItems, users } from "../db.js";
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
  const current = await users().findOne({ _id: String(vendorId) });
  const now = Date.now();
  let base = now;
  if (!extendFromNow && current?.subscriptionExpiresAt) {
    const existing = new Date(current.subscriptionExpiresAt).getTime();
    if (Number.isFinite(existing) && existing > now) base = existing;
  }
  const expiresAt = new Date(base + PREMIUM_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await users().updateOne(
    { _id: String(vendorId) },
    { $set: { subscriptionPlan: "premium", subscriptionExpiresAt: expiresAt } }
  );
  return expiresAt;
}

export async function downgradeIfExpired(vendorId) {
  const user = await users().findOne({ _id: String(vendorId) });
  if (!user) return null;
  if (user.subscriptionPlan !== "premium") return user;
  if (!user.subscriptionExpiresAt) return user;
  const expired = new Date(user.subscriptionExpiresAt).getTime() <= Date.now();
  if (!expired) return user;
  await users().updateOne(
    { _id: String(vendorId) },
    { $set: { subscriptionPlan: "free" } }
  );
  return { ...user, subscriptionPlan: "free", plan: "free" };
}
