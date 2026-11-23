import "dotenv/config";
import express from "express";
import cors from "cors";

import { connectToDatabase, closeDatabase } from "./src/db.js";
import { notFound, errorMiddleware } from "./src/middleware/errors.js";
import menuRoutes from "./src/routes/menu.routes.js";
import orderRoutes from "./src/routes/order.routes.js";
import userRoutes from "./src/routes/user.routes.js";
import profileRoutes from "./src/routes/profile.routes.js";
import overviewRoutes from "./src/routes/overview.routes.js";
import transactionRoutes from "./src/routes/transaction.routes.js";
import subscriptionRoutes from "./src/routes/subscription.routes.js";
import webhookRoutes from "./src/routes/webhook.routes.js";

const app = express();
const port = Number(process.env.PORT) || 5000;
const clientUrl = process.env.CLIENT_URL?.trim() || "http://localhost:3000";

await connectToDatabase();

app.disable("x-powered-by");

app.use(
  cors({
    origin: [clientUrl, process.env.ALLOWED_ORIGIN?.trim()].filter(Boolean),
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  })
);


app.use("/api/webhooks", webhookRoutes);

app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({ service: "PizzaHub API", status: "ok" });
});

app.get("/api/health", async (_req, res) => {
  try {
    await (await import("./src/db.js")).users().findOne({ _id: "__ping__" });
    res.json({ status: "ok", database: "connected" });
  } catch (err) {
    res.status(500).json({ status: "error", database: err.message });
  }
});

app.use("/api/menu", menuRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/users", userRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/overview", overviewRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/subscription", subscriptionRoutes);

app.use(notFound);
app.use(errorMiddleware);

const server = app.listen(port, () => {
  console.log(`[PizzaHub API] listening on http://localhost:${port}`);
  console.log(`[PizzaHub API] CORS origin: ${clientUrl}`);
  console.log(
    `[PizzaHub API] Stripe: ${process.env.STRIPE_SECRET_KEY ? "configured" : "NOT configured (vendor checkout will return 503)"}`
  );
});

async function shutdown() {
  server.close();
  await closeDatabase();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
