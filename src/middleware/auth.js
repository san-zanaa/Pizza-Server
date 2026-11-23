import { verifyToken } from "../lib/token.js";
import { users } from "../db.js";

/** 401 for missing/invalid credentials, 403 for known-but-forbidden ones. */

export function unauthorized(res, message = "Authentication required.") {
  return res.status(401).json({ error: message });
}

export function forbidden(res, message = "You don't have permission to do that.") {
  return res.status(403).json({ error: message });
}

export function badRequest(res, message = "Invalid request.") {
  return res.status(400).json({ error: message });
}

function readBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (typeof header !== "string") return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

/**
 * Verifies the Bearer token AND re-reads the user from the database.
 * Attaches `req.user` = { id, name, email, role, blocked, plan, businessName, subscriptionExpiresAt }.
 */
export async function requireAuth(req, res, next) {
  try {
    const token = readBearer(req);
    if (!token) return unauthorized(res, "You must be signed in to do that.");

    let claims;
    try {
      claims = await verifyToken(token);
    } catch {
      return unauthorized(res, "Your session has expired. Please sign in again.");
    }

    const user = await users().findOne({ _id: String(claims.sub) });
    if (!user) return unauthorized(res, "Your account no longer exists.");

    req.user = {
      id: String(user._id),
      name: user.name ?? "",
      email: user.email ?? "",
      role: user.role === "vendor" || user.role === "admin" ? user.role : "customer",
      blocked: user.isBlocked === true,
      plan: user.subscriptionPlan === "premium" ? "premium" : "free",
      businessName: user.businessName ?? "",
      subscriptionExpiresAt: user.subscriptionExpiresAt ?? null,
    };

    if (req.user.blocked) {
      return forbidden(
        res,
        "Your account has been blocked by an administrator. Contact support to restore access."
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Optional auth — never rejects, just attaches when a valid token is present. */
export async function optionalAuth(req, _res, next) {
  try {
    const token = readBearer(req);
    if (token) {
      try {
        const claims = await verifyToken(token);
        const user = await users().findOne({ _id: String(claims.sub) });
        if (user && user.isBlocked !== true) {
          req.user = {
            id: String(user._id),
            name: user.name ?? "",
            email: user.email ?? "",
            role: user.role === "vendor" || user.role === "admin" ? user.role : "customer",
            blocked: false,
            plan: user.subscriptionPlan === "premium" ? "premium" : "free",
            businessName: user.businessName ?? "",
            subscriptionExpiresAt: user.subscriptionExpiresAt ?? null,
          };
        }
      } catch {
        /* ignore — treat as anonymous */
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Role-based middleware: requireRole(res, ["vendor", "admin"]). */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return unauthorized(res);
    if (!roles.includes(req.user.role)) {
      return forbidden(res, `This action requires the ${roles.join(" or ")} role.`);
    }
    next();
  };
}

/** Throws a 403 unless `resourceVendorId` belongs to the signed-in vendor. */
export function assertOwnership(req, res, ownerVendorId) {
  if (req.user.role === "admin") return true;
  if (req.user.role === "vendor" && ownerVendorId && String(ownerVendorId) === req.user.id) {
    return true;
  }
  forbidden(res, "You can only modify your own resources.");
  return false;
}
