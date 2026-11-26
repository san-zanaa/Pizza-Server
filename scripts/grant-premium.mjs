import "dotenv/config";
import { connectToDatabase, closeDatabase, findUserById } from "../src/db.js";
import { grantPremium } from "../src/services/plan.js";
import { PREMIUM_DURATION_DAYS } from "../src/constants.js";

const VENDOR_ID = "seed-pizzahub-kitchen";

await connectToDatabase();

const before = await findUserById(VENDOR_ID);
if (!before) {
  console.error(`No user with _id "${VENDOR_ID}". Run create-seed-vendor.mjs first.`);
  await closeDatabase();
  process.exit(1);
}

console.log("Before:", {
  email: before.email,
  role: before.role,
  subscriptionPlan: before.subscriptionPlan ?? "(unset)",
  subscriptionExpiresAt: before.subscriptionExpiresAt ?? "(unset)",
});

// Same code path Stripe's webhook uses (recordSubscriptionPayment → grantPremium).
const expiresAt = await grantPremium(VENDOR_ID, { extendFromNow: true });

const after = await findUserById(VENDOR_ID);
const active = new Date(expiresAt).getTime() > Date.now();

console.log("\nAfter:", {
  subscriptionPlan: after.subscriptionPlan,
  subscriptionExpiresAt: after.subscriptionExpiresAt,
  daysGranted: PREMIUM_DURATION_DAYS,
  premiumActive: active,
});

await closeDatabase();
