/**
 * Geotag the tweets already in MongoDB (Floods.FloodTweets) - see lib/geotag.ts
 *
 * Usage:
 *   npm run geotag -- [--clear-cache]
 *
 * --clear-cache forgets every saved search first, so all places are looked up
 * again (tweets keep their pins until their new ones are found).
 *
 * The web app does the same in the background through POST /api/geotag; only one
 * run happens at a time. Safe to stop with Ctrl+C - running again carries on.
 */

import { MongoClient } from "mongodb";
import {
  clearPlaceCache,
  geotagCollection,
  releaseGeotagLock,
} from "../lib/geotag";

try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local is optional - fall back to the local defaults below
}

async function main() {
  const client = new MongoClient(
    process.env.MONGODB_URI ?? "mongodb://localhost:27017/",
    { serverSelectionTimeoutMS: 5000 },
  );
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB ?? "Floods");

    if (process.argv.includes("--clear-cache")) {
      console.log(`Cleared ${await clearPlaceCache(db)} saved search(es)`);
    }

    // Free the lock on Ctrl+C, so the next run can start straight away
    process.once("SIGINT", () => {
      releaseGeotagLock(db).finally(() => process.exit(130));
    });
    const { status, searches } = await geotagCollection(db);
    console.log(`Finished (${status}) after ${searches} search(es)`);
    if (status !== "done") process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
