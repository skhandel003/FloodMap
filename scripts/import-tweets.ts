/**
 * Import the processed tweets CSV into MongoDB (Floods.FloodTweets), then geotag it
 *
 * Usage:
 *   npm run import:tweets -- [processed.csv] [--dry-run] [--no-geocode]
 *
 * 1. Load: every tweet goes into the collection straight away, without
 *    coordinates (see lib/tweet-import.ts). Repeated tweet texts are skipped and
 *    tweets no longer in the CSV are removed, so the collection mirrors the file.
 * 2. Geotag: fills in coordinates on the collection, writing each result as it
 *    comes (see lib/geotag.ts) - the map shows new pins at its next refresh.
 *    --no-geocode skips this; run `npm run geotag` (or POST /api/geotag) later.
 *
 * --dry-run prints what would be loaded without touching the database.
 */

import fs from "node:fs";
import { MongoClient } from "mongodb";
import { geotagCollection, releaseGeotagLock } from "../lib/geotag";
import { parseTweetsCsv, replaceTweets } from "../lib/tweet-import";

try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local is optional - fall back to the local defaults below
}
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/";
const MONGODB_DB = process.env.MONGODB_DB ?? "Floods";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const skipGeocoding = args.includes("--no-geocode");
const csvPath =
  args.find((arg) => !arg.startsWith("--")) ??
  "data/results/location_results.csv";

async function main() {
  let parsed;
  try {
    parsed = parseTweetsCsv(fs.readFileSync(csvPath, "utf8"));
  } catch (error) {
    throw new Error(
      `${csvPath}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const { tweets, rowCount, timeColumn, warnings } = parsed;
  for (const warning of warnings) console.warn(warning);

  const uniqueLocations = new Set(
    tweets.flatMap((t) =>
      t.locations.map((l) =>
        [l.closeLocation, l.city, l.province].join("|").toLowerCase(),
      ),
    ),
  );
  const summary = [
    `  ${rowCount} rows, ${tweets.length} unique tweet texts ` +
      `(${rowCount - tweets.length} repeated row(s) skipped)`,
    `  ${tweets.filter((t) => t.locations.length > 0).length} with a location, ` +
      `${uniqueLocations.size} unique locations`,
    timeColumn
      ? `  time column "${timeColumn}": ${tweets.filter((t) => t.time).length} with a time`
      : "  no time column - time stored as null",
  ];

  if (isDryRun) {
    console.log(JSON.stringify(tweets.slice(0, 3), null, 2));
    console.log(`Dry run: converted ${tweets.length} tweets, nothing written`);
    console.log(summary.join("\n"));
    return;
  }

  const client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    const db = client.db(MONGODB_DB);

    // 1. Load every tweet straight away, without coordinates
    const saved = await replaceTweets(db, tweets);
    console.log(`Loaded ${tweets.length} tweets into ${MONGODB_DB}.FloodTweets`);
    console.log(
      `  inserted ${saved.inserted}, updated ${saved.updated}, ` +
        `removed ${saved.removed} (repeats, changed or no longer in the CSV)`,
    );
    console.log(summary.join("\n"));

    // 2. Geotag the collection
    if (skipGeocoding) {
      console.log("Skipped geotagging - run `npm run geotag` when ready");
      return;
    }
    // Free the lock on Ctrl+C, so the next run can start straight away
    process.once("SIGINT", () => {
      releaseGeotagLock(db).finally(() => process.exit(130));
    });
    const { status, searches } = await geotagCollection(db);
    console.log(`Geotagging finished (${status}) after ${searches} search(es)`);
    if (status !== "done") process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
