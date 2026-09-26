/**
 * MongoDB access for server code (API routes)
 *
 * One client is shared across requests and kept on globalThis, so development hot
 * reloads don't open a new connection each time.
 */

import { MongoClient } from "mongodb";
import type { FloodTweet } from "@/types/tweet";

const globalForMongo = globalThis as typeof globalThis & {
  mongoClientPromise?: Promise<MongoClient>;
};

function getClient(): Promise<MongoClient> {
  if (!globalForMongo.mongoClientPromise) {
    const client = new MongoClient(
      process.env.MONGODB_URI ?? "mongodb://localhost:27017/",
      { serverSelectionTimeoutMS: 5000 }
    );
    globalForMongo.mongoClientPromise = client.connect().catch((error) => {
      // Forget the failed attempt so the next request retries
      globalForMongo.mongoClientPromise = undefined;
      throw error;
    });
  }
  return globalForMongo.mongoClientPromise;
}

/**
 * The Floods database
 */
export async function getDatabase() {
  const client = await getClient();
  return client.db(process.env.MONGODB_DB ?? "Floods");
}

/**
 * The Floods.FloodTweets collection written by `npm run import:tweets`
 */
export async function getFloodTweetsCollection() {
  const db = await getDatabase();
  return db.collection<FloodTweet>("FloodTweets");
}
