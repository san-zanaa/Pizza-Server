/** Shared domain constants — must stay in sync with lib/types.ts in the Next.js app. */

export const MENU_CATEGORIES = [
  "Classic Pizzas",
  "Vegetarian Pizzas",
  "Meat Lovers",
  "Specialty / Gourmet Pizzas",
  "Sides & Appetizers",
  "Beverages & Desserts",
];

/** Order lifecycle: pending → accepted | rejected | cancelled. */
export const ORDER_STATUSES = ["pending", "accepted", "rejected", "cancelled"];

/** Menu lifecycle — `inactive` is an approved item the vendor switched off. */
export const MENU_STATUSES = ["pending", "approved", "rejected", "inactive"];

export const USER_ROLES = ["vendor", "customer", "admin"];

export const FREE_PLAN_ACTIVE_LIMIT = 3;
export const PREMIUM_PRICE_CENTS = 2900;
export const PREMIUM_DURATION_DAYS = 30;
