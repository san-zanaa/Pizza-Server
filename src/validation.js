import {
  MENU_CATEGORIES,
  MENU_STATUSES,
  ORDER_STATUSES,
  USER_ROLES,
} from "./constants.js";

/** Returns a normalised value or throws an Error carrying the user-facing message. */

const str = (value) => (typeof value === "string" ? value.trim() : "");

export function isImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function expectName(value, label = "Item name") {
  const name = str(value);
  if (name.length < 2 || name.length > 80) {
    throw new Error(`${label} must be between 2 and 80 characters.`);
  }
  return name;
}

export function expectCategory(value) {
  const category = str(value);
  if (!MENU_CATEGORIES.includes(category)) {
    throw new Error("Pick a valid category.");
  }
  return category;
}

export function expectDescription(value) {
  const description = str(value);
  if (description.length < 10 || description.length > 1000) {
    throw new Error("Description must be between 10 and 1000 characters.");
  }
  return description;
}

export function expectPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0 || price > 10000) {
    throw new Error("Price must be a positive amount (max 10,000).");
  }
  return Math.round(price * 100) / 100;
}

export function expectLocation(value) {
  const location = str(value);
  if (location.length < 2 || location.length > 120) {
    throw new Error("Location (area / city) is required.");
  }
  return location;
}

export function expectImages(value) {
  const list = (Array.isArray(value) ? value : [value]).map(str).filter(Boolean);
  if (list.length === 0) throw new Error("An item image link is required.");
  if (list.length > 6) throw new Error("A maximum of 6 image links is allowed.");
  for (const image of list) {
    if (!isImageUrl(image)) {
      throw new Error("Each item image must be a valid http/https link.");
    }
  }
  return list;
}

export function expectStatus(value, allowed = MENU_STATUSES) {
  const status = str(value);
  if (!allowed.includes(status)) throw new Error(`Status must be one of: ${allowed.join(", ")}.`);
  return status;
}

export function expectRole(value) {
  const role = str(value);
  if (!USER_ROLES.includes(role)) throw new Error("Pick a valid account role.");
  return role;
}

export function expectOrderStatus(value) {
  return expectStatus(value, ORDER_STATUSES);
}

/**
 * Validates a create/update payload for a menu item.
 * Returns the cleaned patch object; throws an Error on the first problem.
 */
export function validateMenuItem(body = {}, { partial = false } = {}) {
  const patch = {};

  if (body.itemName !== undefined || !partial) patch.itemName = expectName(body.itemName);
  if (body.category !== undefined || !partial) patch.category = expectCategory(body.category);
  if (body.description !== undefined || !partial) {
    patch.description = expectDescription(body.description);
  }
  if (body.price !== undefined || !partial) patch.price = expectPrice(body.price);
  if (body.location !== undefined || !partial) patch.location = expectLocation(body.location);
  if (body.images !== undefined || !partial) patch.images = expectImages(body.images);
  if (body.status !== undefined) patch.status = expectStatus(body.status);

  return patch;
}

export function isFutureDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date >= new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
}
