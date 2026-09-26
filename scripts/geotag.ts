/**
 * Geotag the tweets already in MongoDB (Floods.FloodTweets) - see lib/geotag.ts
 *
 * Usage:
 *   npm run geotag
 *
 * The web app does the same in the background through POST /api/geotag; only one
 * run happens at a time. Safe to stop with Ctrl+C - running again carries on.
 */

import { MongoClient } from "mongodb";
import { geotagCollection, releaseGeotagLock } from "../lib/geotag";
import { moveOldPlaceCache } from "./old-place-cache";

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
    await moveOldPlaceCache(db);

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
