import "dotenv/config";
import { connectToDatabase, closeDatabase, menuItems, users, orders, transactions } from "../src/db.js";

/**
 * One-time (idempotent) migration to the schema in the assignment's
 * "Database design (MongoDB)" table:
 *
 *   menuItems: vendorId, itemName, category, description, price, location,
 *              images[], status(pending|approved|rejected|inactive), createdAt
 *   users:     isBlocked, businessName, subscriptionPlan, subscriptionExpiresAt
 *
 * Run with:  npm run migrate   (from assignment-9-server/)
 */

const SEED_VENDOR_ID = "seed-pizzahub-kitchen";
const SEED_VENDOR_NAME = "PizzaHub Kitchen";
const DEFAULT_LOCATION = "Dhanmondi, Dhaka";

const CATEGORY_MAP = {
  Appetizers: "Sides & Appetizers",
  Sides: "Sides & Appetizers",
  Beverages: "Beverages & Desserts",
  Desserts: "Beverages & Desserts",
  Pasta: "Specialty / Gourmet Pizzas",
  Pizzas: "Classic Pizzas",
};

const SPEC_CATEGORIES = [
  "Classic Pizzas",
  "Vegetarian Pizzas",
  "Meat Lovers",
  "Specialty / Gourmet Pizzas",
  "Sides & Appetizers",
  "Beverages & Desserts",
];

const MEAT_RX = /(pepperoni|chicken|beef|meat|sausage|bacon|lamb|kebab|bbq|tandoori)/i;
const VEG_RX = /(veggie|vegetarian|cheese|margherita|mushroom|paneer|potato|onion|spinach|corn|caprese|feta)/i;

/** Splits the seeded "Pizzas" bucket into the three pizza categories from the spec. */
function refinePizzaCategory(itemName) {
  const name = String(itemName ?? "");
  if (MEAT_RX.test(name)) return "Meat Lovers";
  if (VEG_RX.test(name)) return "Vegetarian Pizzas";
  return "Classic Pizzas";
}

function normalizeStatus(existing) {
  if (!existing) return "approved"; // legacy seed items are published so the shop isn't empty
  const status = String(existing).toLowerCase();
  if (status === "pending") return "pending";
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  if (status === "inactive") return "inactive";
  return "pending";
}

async function migrateMenuItems() {
  const docs = await menuItems().find({}).toArray();
  let touched = 0;

  for (const doc of docs) {
    const $set = {};
    const $unset = {};

    if (!doc.itemName) {
      $set.itemName = String(doc.name ?? doc.itemName ?? "").trim() || "Untitled item";
    }
    if (!Array.isArray(doc.images) || doc.images.length === 0) {
      const single = doc.image || doc.imageUrl;
      $set.images = single ? [single] : [];
    }

    const previousCategory = doc.category ?? "";
    const targetCategory =
      previousCategory === "Pizzas"
        ? refinePizzaCategory(doc.itemName ?? doc.name)
        : CATEGORY_MAP[previousCategory] ?? (SPEC_CATEGORIES.includes(previousCategory) ? previousCategory : "Classic Pizzas");
    if (doc.category !== targetCategory) $set.category = targetCategory;

    const targetStatus = normalizeStatus(doc.status);
    if (doc.status !== targetStatus) $set.status = targetStatus;

    if (!doc.vendorId) {
      $set.vendorId = SEED_VENDOR_ID;
      $set.vendorName = SEED_VENDOR_NAME;
    } else if (!doc.vendorName) {
      $set.vendorName = SEED_VENDOR_NAME;
    }
    if (!doc.location) $set.location = DEFAULT_LOCATION;
    if (!doc.createdAt) $set.createdAt = new Date().toISOString();
    $set.updatedAt = new Date().toISOString();

    if (doc.name !== undefined) $unset.name = "";
    if (doc.image !== undefined) $unset.image = "";
    if (doc.imageUrl !== undefined) $unset.imageUrl = "";
    if (doc.availability !== undefined) $unset.availability = "";
    if (doc.isAvailable !== undefined) $unset.isAvailable = "";

    if (Object.keys($set).length || Object.keys($unset).length) {
      const update = {};
      if (Object.keys($set).length) update.$set = $set;
      if (Object.keys($unset).length) update.$unset = $unset;
      await menuItems().updateOne({ _id: doc._id }, update);
      touched++;
    }
  }

  console.log(`[migrate] menuItems: ${touched}/${docs.length} updated`);
}

async function migrateUsers() {
  const docs = await users().find({}).toArray();
  let touched = 0;

  for (const doc of docs) {
    const $set = {};
    const $unset = {};

    if (doc.isBlocked === undefined) $set.isBlocked = doc.blocked === true;
    if (doc.subscriptionPlan === undefined) {
      $set.subscriptionPlan = doc.plan === "premium" ? "premium" : "free";
    }
    if (doc.role === undefined || doc.role === null || doc.role === "") $set.role = "customer";
    if (doc.role === "admin") $set.isBlocked = false; // admins are never blocked

    if (doc.blocked !== undefined) $unset.blocked = "";
    if (doc.plan !== undefined) $unset.plan = "";

    if (Object.keys($set).length || Object.keys($unset).length) {
      const update = {};
      if (Object.keys($set).length) update.$set = $set;
      if (Object.keys($unset).length) update.$unset = $unset;
      await users().updateOne({ _id: doc._id }, update);
      touched++;
    }
  }

  console.log(`[migrate] users: ${touched}/${docs.length} updated`);
}

async function ensureIndexes() {
  await menuItems().createIndexes([
    { key: { status: 1 } },
    { key: { vendorId: 1, status: 1 } },
    { key: { category: 1 } },
    { key: { itemName: 1 } },
  ]);
  await orders().createIndexes([
    { key: { vendorId: 1, status: 1 } },
    { key: { customerId: 1, status: 1 } },
    { key: { itemId: 1, customerId: 1, deliveryDate: 1 } },
  ]);
  await transactions().createIndexes([
    { key: { vendorId: 1 } },
    { key: { stripeSessionId: 1 }, unique: true },
  ]);
  console.log("[migrate] indexes ensured");
}

async function main() {
  await connectToDatabase();
  await migrateMenuItems();
  await migrateUsers();
  await ensureIndexes();
  await closeDatabase();
  console.log("[migrate] done");
}

main().catch(async (err) => {
  console.error("[migrate] failed:", err);
  await closeDatabase();
  process.exit(1);
});
