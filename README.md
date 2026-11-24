# PizzaHub — Backend Server

Express.js API for the PizzaHub platform (MongoDB + Better Auth via JWT).

## Project Name

PizzaHub Server

## Description

Backend API for PizzaHub — a pizza ordering & delivery platform. Serves the client
(Next.js app in the separate **PizzaHub Client** repository) with role-based
authentication (JWT, admin / vendor / customer), a menu catalog, orders, subscriptions
via Stripe Checkout, and a signature-verified Stripe webhook that activates Premium.

## Table of Contents

- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [Environment Variables](#environment-variables)
- [Database](#database)
- [Installation](#installation)
- [Running the Server](#running-the-server)
- [Scripts](#scripts)
- [API Overview](#api-overview)
- [Development Notes](#development-notes)

## Key Features

- JWT-based auth verification middleware (`requireAuth`, `optionalAuth`)
- Role-based access control: `requireRole("admin")`, `requireRole("vendor")`, `requireRole("customer")`
- Menu catalog: list/search/filter/sort (`price_asc`, `price_desc`), approvals (admin), plan limits (Free: 3 active items)
- Orders: create, accept/reject (vendor, exactly once), cancel (customer, pending only), duplicate-order prevention
- Admin user management: search, role filter, block/unblock
- Transactions read-only ledger; Stripe webhook (`POST /api/webhooks/stripe`) for verified Premium activation
- Client-side `sort` support for the menu (price asc/desc)

## Tech Stack

Backend: Express.js, Node.js
Database: MongoDB (native driver)
Auth: JWT (HS256 via `jose`) — tokens minted by the client from the Next.js app
Payment: Stripe Checkout + signature-verified webhooks
Other: CORS, dotenv

## Environment Variables

Create a `.env` file in this repository (see `.env.example` style — `.env` is gitignored):

| Variable | Purpose | Required |
|---|---|---|
| `MONGODB_URL` | MongoDB connection string | Yes |
| `MONGODB_DB_NAME` | Database name (optional, defaults handled by driver) | No |
| `PORT` | Port to listen on (default 5000) | No |
| `CLIENT_URL` | Allowed CORS origin of the Next.js client (e.g. `http://localhost:3000`) | No (defaults to localhost:3000) |
| `JWT_SECRET` | HS256 secret for JWT signing/verification | Yes |
| `STRIPE_SECRET_KEY` | Stripe secret key (for Checkout + webhook processing) | Yes (for payments) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret — must match the webhook registered in the Stripe Dashboard | Yes (for payments) |
| `ALLOWED_ORIGIN` | Extra CORS origin (optional) | No |

Notes:

- Never commit real secrets — `.env` is ignored by git.
- For Stripe Checkout: the client calls `POST /api/subscription/checkout` (vendor only),
  you receive the session URL and redirect the browser to Stripe. Activation happens
  **only** in the verified webhook — never trust the client redirect.

## Database

Collections: `user` (Better Auth's collection, managed by the client app),
`menuItems`, `orders`, `transactions`. Indices are created on startup.
Run `npm run migrate` for a one-time legacy data normalization script.

## Installation

```bash
npm install
```

## Running the Server

```bash
# Development
npm run dev    # node --watch index.js

# Production
npm run start  # node index.js
```

The server listens on `http://localhost:5000` by default. Health check:

```bash
curl http://localhost:5000/api/health
```

## Scripts

```bash
npm start   # start the server (node index.js)
npm run dev # start with auto-reload (node --watch index.js)
npm run migrate
```

## API Overview

- `GET /` — service status JSON
- `GET /api/health` — database connectivity check
- Menu: `GET /api/menu` (public, approved; scopes `mine`/`admin`, filters `q`, `category`, `location`, `status`, `limit`, `sort=price_asc|price_desc|name_asc|name_desc`), `GET /api/menu/:id`, `POST /api/menu`, `PATCH /api/menu/:id`, `DELETE /api/menu/:id`, `GET /api/menu/categories`, `GET /api/menu/stats`
- Orders: `GET /api/orders`, `POST /api/orders`, `PATCH /api/orders/:id`

**Order lifecycle:** orders start as `pending` when placed. Vendors may
`PATCH` a pending order to `accepted` or `rejected` (exactly once, owner-only);
customers may `PATCH` a pending order to `cancelled`.

**Webhook flow:** `POST /api/webhooks/stripe` (signature-verified) is the ONLY
place Premium is activated — on `checkout.session.completed` with a paid
status, writing the transaction and extending `subscriptionExpiresAt`.
Failed/expired/refunded events mark the transaction as `failed`.
- Users: `GET /api/users`, `GET /api/users/:id`, `PATCH /api/users/:id` (blocked only)
- Profile: `GET /api/profile`, `PATCH /api/profile`
- Transactions: `GET /api/transactions` (read-only)
- Subscriptions: `POST /api/subscription/checkout`, `GET /api/subscription/status`, `POST /api/subscription/cancel`
- Webhook: `POST /api/webhooks/stripe` (Stripe-signature verified)

## Development Notes

- JWT tokens are HS256 with issuer `pizzahub-web`, audience `pizzahub-api`, 15-minute
  TTL. The DB is re-read on every protected request, so role/plan/blocked changes take
  effect immediately.
- Public routes (no auth): `GET /api/menu`, `GET /api/menu/categories`, `GET /api/menu/:id`
  (approved items), `GET /api/health`, Stripe webhook.
- Webhook flow: Stripe signs events; `checkout.session.completed` with a paid status
  writes the transaction and activates Premium in the database (idempotent by session id).
