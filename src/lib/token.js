import { SignJWT, jwtVerify } from "jose";

/**
 * HS256 JWT helpers.
 *
 * The Next.js app (which owns Better Auth sessions) mints these tokens in
 * `/api/auth/token`. This server verifies them, then re-reads the user from
 * the database so a role / block / plan change takes effect immediately —
 * claims inside the token are never trusted on their own.
 */

const TOKEN_TTL = "15m";

function secretKey() {
  const secret = process.env.JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing JWT_SECRET (or BETTER_AUTH_SECRET) environment variable.");
  }
  return new TextEncoder().encode(secret);
}

export async function signToken(payload) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("pizzahub-web")
    .setAudience("pizzahub-api")
    .setExpirationTime(TOKEN_TTL)
    .sign(secretKey());
}

export async function verifyToken(token) {
  const { payload } = await jwtVerify(token, secretKey(), {
    issuer: "pizzahub-web",
    audience: "pizzahub-api",
  });
  return payload;
}
