import { jwtVerify } from "jose";
import { findUserById } from "../db.js";

/**
 * HS256 JWT verification helper.
 *
 * The Next.js app (which owns Better Auth sessions) mints tokens in
 * `/api/auth/token`. This server verifies them, then re-reads the user from
 * the database so a role / block / plan change takes effect immediately —
 * claims inside the token are never trusted on their own.
 */

function secretKey() {
  const secret = process.env.JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing JWT_SECRET (or BETTER_AUTH_SECRET) environment variable.");
  }
  return new TextEncoder().encode(secret);
}

export async function verifyToken(token) {
  const { payload } = await jwtVerify(token, secretKey(), {
    issuer: "pizzahub-web",
    audience: "pizzahub-api",
  });
  return payload;
}
