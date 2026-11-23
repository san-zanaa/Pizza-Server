/** Wraps async route handlers so thrown/rejected errors reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Turns thrown Errors into the { error } envelope the frontend already expects. */
export function errorMiddleware(err, _req, res, _next) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (status >= 500) console.error("[PizzaHub API]", err);
  res.status(status).json({ error: err?.message || "Something went wrong on the server." });
}

export function notFound(_req, res) {
  res.status(404).json({ error: "Route not found." });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
