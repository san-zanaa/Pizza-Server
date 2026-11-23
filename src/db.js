import { MongoClient, ObjectId } from "mongodb";

/** Shared MongoDB connection + the four business collections from the spec. */

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

let client;
let database;

function resolveDbName(uri) {
  const fromUri = uri.match(/mongodb(?:\+srv)?:\/\/[^/?#]*\/([^/?#]*)/i)?.[1]?.trim();
  return process.env.MONGODB_DB_NAME?.trim() || fromUri || "pizzahub";
}

export async function connectToDatabase() {
  const uri = process.env.MONGODB_URL?.trim();
  if (!uri) {
    throw new Error(
      "Missing MONGODB_URL environment variable. Add it to assignment-9-server/.env"
    );
  }
  client = new MongoClient(uri);
  await client.connect();
  console.log(`[PizzaHub API] MongoDB connected → ${resolveDbName(uri)}`);
  database = client.db(resolveDbName(uri));
  return database;
}

function db() {
  if (!database) throw new Error("Database not initialised — call connectToDatabase() first.");
  return database;
}

/** Better Auth's own user collection ("user" is Better Auth's default name). */
export const users = () => db().collection("user");
export const menuItems = () => db().collection("menuItems");
export const orders = () => db().collection("orders");
export const transactions = () => db().collection("transactions");

/**
 * User lookups by id. Better Auth stores `_id` as ObjectId, but the wire
 * format everywhere is a string, so try the string first and the ObjectId
 * form second.
 */
export async function findUserById(id) {
  const str = String(id ?? "").trim();
  if (!str) return null;
  if (OBJECT_ID_RE.test(str)) {
    const byObjectId = await users().findOne({ _id: new ObjectId(str) });
    if (byObjectId) return byObjectId;
  }
  return users().findOne({ _id: str });
}

export async function closeDatabase() {
  if (client) await client.close();
}
