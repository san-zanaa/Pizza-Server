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

