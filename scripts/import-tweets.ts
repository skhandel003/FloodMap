/**
 * Import the processed tweets CSV into MongoDB (Floods.FloodTweets)
 *
 * Usage:
 *   npm run import:tweets -- [processed.csv] [--dry-run]
 *
 * - processed.csv: classifier output with tweet, score and locations columns plus
 *   an optional time column (default: data/results/location_results.csv).
 *   locations is a flat list of (province, city, close location) triples, e.g.
 *   ['Alberta', 'Calgary', 'millennium park', 'Alberta', 'High River', None]
 * - --dry-run: print the converted objects without touching the database or the
 *   geocoding API
 * - --no-geocode: import only, skip looking up new places
 *
 * Each tweet's id is its line in the processed CSV. Re-running is safe: tweets are
 * upserted by id and ids no longer in the file are removed, so the collection
 * always mirrors the latest CSV.
 *
 * After saving, places without coordinates are looked up with Nominatim, one per
 * second and most-mentioned first. Each result is written to MongoDB straight away
 * so the map can show pins while the rest are still being looked up. Lookups are
 * saved in data/geocode-cache.json, so each place is only ever searched once. Set
 * GEOCODE_COUNTRY (e.g. "ca") in .env.local to restrict results to one country.
 */

import fs from "node:fs";
import Papa from "papaparse";
import { MongoClient, type Collection } from "mongodb";
import { geocode, locationQuery, type Coordinates } from "../lib/geocode";
import type { FloodTweet, TweetLocation } from "../types/tweet";

const COLLECTION = "FloodTweets";
const REQUIRED_COLUMNS = ["tweet", "score", "locations"];
const TIME_COLUMNS = ["time", "timestamp", "created_at", "date"];
const GEOCODE_CACHE_PATH = "data/geocode-cache.json";
const MAX_FAILURES_IN_A_ROW = 5;

try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local is optional - fall back to the local defaults below
}
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017/";
const MONGODB_DB = process.env.MONGODB_DB ?? "Floods";
const GEOCODE_COUNTRY = process.env.GEOCODE_COUNTRY || undefined;

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const skipGeocoding = args.includes("--no-geocode");
const csvPath =
  args.find((arg) => !arg.startsWith("--")) ?? "data/results/location_results.csv";

function readCsv(filePath: string) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  const { data, errors, meta } = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  if (errors.length > 0) {
    throw new Error(`${filePath}: ${errors[0].message} (row ${errors[0].row})`);
  }
  return { rows: data, columns: meta.fields ?? [] };
}

/**
 * Line where each data row starts (the header is line 1) - a tweet containing
 * line breaks pushes every later row down
 */
function startLines(rows: Record<string, string>[]): number[] {
  const lines: number[] = [];
  let line = 2;
  for (const row of rows) {
    lines.push(line);
    line += 1 + (Object.values(row).join("").match(/\n/g)?.length ?? 0);
  }
  return lines;
}

/**
 * Splits the classifier's list text into items, keeping empty slots so the
 * (province, city, close location) triples stay aligned. Understands Python and
 * JSON quoting; None, null, nan and empty slots become null, and a cell that is
 * just None (or blank) means no locations.
 * e.g. ['Alberta', "Prince's Island Park", None] -> ["Alberta", "Prince's Island Park", null]
 */
function parseList(value: string): (string | null)[] {
  if (/^(none|null|nan)?$/i.test(value.trim())) return [];

  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];

  // Split on commas that aren't inside quotes
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (quote) {
      if (char === "\\") {
        current += char + (inner[i + 1] ?? "");
        i++;
        continue;
      }
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts.map((part) => {
    const item = part.trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(item);
    if (quoted) return quoted[2].replace(/\\(.)/g, "$1");
    return /^(none|null|nan)?$/i.test(item) ? null : item;
  });
}

/**
 * Strips hashtag marks and extra spaces; empty values and quoted 'None', 'null'
 * or 'nan' become null
 */
function cleanValue(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/^#+/, "").replace(/\s+/g, " ").trim();
  return cleaned && !/^(none|null|nan)$/i.test(cleaned) ? cleaned : null;
}

/**
 * Groups list items into (province, city, close location) triples, dropping
 * empty triples and case-insensitive repeats
 */
function toLocations(items: (string | null)[]): TweetLocation[] {
  const seen = new Set<string>();
  const locations: TweetLocation[] = [];
  for (let i = 0; i < items.length; i += 3) {
    const province = cleanValue(items[i]);
    const city = cleanValue(items[i + 1]);
    const closeLocation = cleanValue(items[i + 2]);
    if (!province && !city && !closeLocation) continue;

    const key = [province, city, closeLocation].join("|").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push({ province, city, closeLocation, coordinates: null });
  }
  return locations;
}

/** Saved lookups keyed by lowercase search text; null means "searched, not found" */
type GeocodeCache = Record<string, Coordinates | null>;

interface PendingPlace {
  query: string;
  tweets: Set<FloodTweet>;
}

function loadGeocodeCache(): GeocodeCache {
  return fs.existsSync(GEOCODE_CACHE_PATH)
    ? JSON.parse(fs.readFileSync(GEOCODE_CACHE_PATH, "utf8"))
    : {};
}

function saveGeocodeCache(cache: GeocodeCache) {
  fs.writeFileSync(GEOCODE_CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

/**
 * Fills in coordinates from saved lookups and returns the places still to look
 * up, keyed by lowercase search text
 */
function applySavedLookups(tweets: FloodTweet[], cache: GeocodeCache) {
  const pending = new Map<string, PendingPlace>();
  for (const tweet of tweets) {
    for (const location of tweet.locations) {
      const query = locationQuery(location);
      const key = query.toLowerCase();
      if (key in cache) {
        location.coordinates = cache[key];
        continue;
      }
      const place = pending.get(key) ?? { query, tweets: new Set<FloodTweet>() };
      place.tweets.add(tweet);
      pending.set(key, place);
    }
  }
  return pending;
}

/**
 * Looks up each pending place, most-mentioned first, and saves every result to
 * the cache and to the tweets that mention it straight away. Safe to stop with
 * Ctrl+C - re-running picks up where it left off.
 */
async function geocodePending(
  collection: Collection<FloodTweet>,
  pending: Map<string, PendingPlace>,
  cache: GeocodeCache
) {
  const queue = [...pending.entries()].sort(
    ([, a], [, b]) => b.tweets.size - a.tweets.size
  );
  console.log(
    `Looking up ${queue.length} place(s), about ` +
      `${Math.ceil((queue.length * 1.1) / 60)} min (Ctrl+C is safe - re-run to resume)`
  );

  let failuresInARow = 0;
  for (const [i, [key, place]] of queue.entries()) {
    const progress = `  [${i + 1}/${queue.length}] ${place.query}`;

    let coordinates: Coordinates | null;
    try {
      coordinates = await geocode(place.query, GEOCODE_COUNTRY);
      failuresInARow = 0;
    } catch (error) {
      console.warn(`${progress}: ${error instanceof Error ? error.message : error}`);
      if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) {
        console.error(
          `Stopped after ${MAX_FAILURES_IN_A_ROW} failed lookups in a row - re-run later to resume`
        );
        return;
      }
      continue;
    }

    cache[key] = coordinates;
    saveGeocodeCache(cache);

    if (coordinates) {
      for (const tweet of place.tweets) {
        for (const location of tweet.locations) {
          if (locationQuery(location).toLowerCase() === key) {
            location.coordinates = coordinates;
          }
        }
      }
      await collection.bulkWrite(
        [...place.tweets].map((tweet) => ({
          updateOne: {
            filter: { id: tweet.id },
            update: { $set: { locations: tweet.locations } },
          },
        }))
      );
    }

    const found = coordinates
      ? `${coordinates.lat.toFixed(4)}, ${coordinates.lng.toFixed(4)}`
      : "not found";
    console.log(`${progress} -> ${found} (${place.tweets.size} tweet(s))`);
  }
}

async function main() {
  const { rows, columns } = readCsv(csvPath);

  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    throw new Error(`${csvPath} is missing column(s): ${missing.join(", ")}`);
  }
  const timeColumn = TIME_COLUMNS.find((c) => columns.includes(c));
  const lines = startLines(rows);

  const unreadableTimes: string[] = [];
  const brokenLocationLists: string[] = [];
  const tweets: FloodTweet[] = rows.map((row, i) => {
    const items = parseList(row.locations);
    if (items.length % 3 !== 0) {
      brokenLocationLists.push(`line ${lines[i]}: ${row.locations}`);
    }

    const timeText = (timeColumn && row[timeColumn]?.trim()) || "";
    let time: Date | null = null;
    if (timeText) {
      const parsed = new Date(timeText);
      if (Number.isNaN(parsed.getTime())) {
        unreadableTimes.push(`line ${lines[i]}: "${timeText}"`);
      } else {
        time = parsed;
      }
    }

    return {
      id: lines[i],
      text: row.tweet,
      locations: toLocations(items),
      score: Number(row.score),
      time,
    };
  });

  if (unreadableTimes.length > 0) {
    console.warn(
      `${unreadableTimes.length} time value(s) couldn't be read and were stored as null, ` +
        `e.g. ${unreadableTimes[0]}`
    );
  }
  if (brokenLocationLists.length > 0) {
    console.warn(
      `${brokenLocationLists.length} location list(s) aren't in groups of 3 ` +
        `(missing values filled with null), e.g. ${brokenLocationLists[0]}`
    );
  }

  const cache = loadGeocodeCache();
  const pending = applySavedLookups(tweets, cache);

  const uniquePlaces = new Set(
    tweets.flatMap((t) => t.locations.map((l) => locationQuery(l).toLowerCase()))
  );
  const summary = [
    `  ${tweets.filter((t) => t.locations.length > 0).length} with a location, ` +
      `${uniquePlaces.size} unique places`,
    `  ${uniquePlaces.size - pending.size} place(s) already looked up, ` +
      `${pending.size} still to look up`,
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

  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const collection = client.db(MONGODB_DB).collection<FloodTweet>(COLLECTION);

    await collection.createIndexes([
      { key: { id: 1 }, unique: true },
      { key: { "locations.city": 1 } },
      { key: { time: 1 } },
    ]);

    const written = await collection.bulkWrite(
      tweets.map((tweet) => ({
        replaceOne: { filter: { id: tweet.id }, replacement: tweet, upsert: true },
      })),
      { ordered: false }
    );
    const removed = await collection.deleteMany({
      id: { $nin: tweets.map((t) => t.id) },
    });

    console.log(`Imported ${tweets.length} tweets into ${MONGODB_DB}.${COLLECTION}`);
    console.log(
      `  inserted ${written.upsertedCount}, updated ${written.modifiedCount}, ` +
        `removed ${removed.deletedCount} no longer in the CSV`
    );
    console.log(summary.join("\n"));

    if (pending.size > 0 && !skipGeocoding) {
      await geocodePending(collection, pending, cache);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
