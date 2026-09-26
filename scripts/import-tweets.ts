import fs from "node:fs";
import Papa from "papaparse";
import { MongoClient, type Collection } from "mongodb";
import {
  searchKey,
  searchPlace,
  type Place,
  type PlaceSearch,
} from "../lib/geocode";
import type { FloodTweet, TweetLocation } from "../types/tweet";

const COLLECTION = "FloodTweets";
const REQUIRED_COLUMNS = ["tweet", "score", "locations"];
const TIME_COLUMNS = ["time", "timestamp", "created_at", "date"];
const PLACE_CACHE_PATH = "data/place-cache.json";
const MAX_FAILURES_IN_A_ROW = 5;
// Words the classifier sometimes returns as a place name
const NOT_PLACES = new Set([
  "the",
  "a",
  "an",
  "it",
  "this",
  "that",
  "here",
  "there",
  "us",
  "we",
  "our",
  "city",
  "town",
  "area",
]);
// A bare number or ordinal like "3rd" - part of a street name, not a place
const ORDINAL = /^\d+(st|nd|rd|th)?$/i;

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
  args.find((arg) => !arg.startsWith("--")) ??
  "data/results/location_results.csv";

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
 * Strips hashtag marks and extra spaces; empty values, quoted 'None', 'null' or
 * 'nan', and words that aren't places (e.g. "The", "3rd") become null
 */
function cleanValue(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/^#+/, "").replace(/\s+/g, " ").trim();
  return cleaned &&
    !/^(none|null|nan)$/i.test(cleaned) &&
    !NOT_PLACES.has(cleaned.toLowerCase()) &&
    !ORDINAL.test(cleaned)
    ? cleaned
    : null;
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
    locations.push({
      province,
      city,
      closeLocation,
      coordinates: null,
      precision: null,
    });
  }
  return locations;
}

/**
 * Keeps only the first tweet with each text - repeats (mostly retweets) carry
 * the same score and locations, so nothing is lost
 */
function dropRepeatedTexts(tweets: FloodTweet[]): FloodTweet[] {
  const seen = new Set<string>();
  return tweets.filter((tweet) => {
    if (seen.has(tweet.text)) return false;
    seen.add(tweet.text);
    return true;
  });
}

/** Saved searches keyed by searchKey(); null means "searched, not found" */
type PlaceCache = Record<string, Place | null>;

/** A search still to run, with the tweets waiting on it */
interface PendingSearch {
  search: PlaceSearch;
  tweets: Set<FloodTweet>;
}

/** What a location comes to from the searches saved so far */
interface Resolution {
  /** The most specific part found so far */
  place: Place | null;
  precision: TweetLocation["precision"];
  /** The next search the location needs, or null when it's settled */
  next: PlaceSearch | null;
}

function loadPlaceCache(): PlaceCache {
  return fs.existsSync(PLACE_CACHE_PATH)
    ? JSON.parse(fs.readFileSync(PLACE_CACHE_PATH, "utf8"))
    : {};
}

function savePlaceCache(cache: PlaceCache) {
  fs.writeFileSync(PLACE_CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

const joinParts = (...parts: (string | null)[]) =>
  parts.filter(Boolean).join(", ");

function provinceSearch(province: string): PlaceSearch {
  return { q: province, featureType: "state", countryCodes: GEOCODE_COUNTRY };
}

/**
 * Keeps a search inside `parent` - or inside the dataset's main area when there's
 * no parent
 */
function inside(
  parent: Place | null,
  mainArea: Place | null,
): Pick<PlaceSearch, "within" | "countryCodes"> {
  const area = parent ?? mainArea;
  return area
    ? { within: area.bbox, countryCodes: area.countryCode ?? GEOCODE_COUNTRY }
    : { countryCodes: GEOCODE_COUNTRY };
}

/**
 * Works out a location from saved searches, level by level (see the notes at the
 * top of this file). Stops at the first search not run yet and returns it as
 * `next`, along with the best part found up to that point.
 */
function resolveLocation(
  location: TweetLocation,
  cache: PlaceCache,
  mainArea: Place | null,
): Resolution {
  const resolution: Resolution = { place: null, precision: null, next: null };
  const found = (place: Place | null, precision: Resolution["precision"]) => {
    if (place) {
      resolution.place = place;
      resolution.precision = precision;
    }
  };

  let province: Place | null = null;
  if (location.province) {
    const search = provinceSearch(location.province);
    const saved = cache[searchKey(search)];
    if (saved === undefined) return { ...resolution, next: search };
    province = saved;
    found(province, "province");
  }

  let city: Place | null = null;
  if (location.city) {
    const search: PlaceSearch = {
      q: location.city,
      featureType: "settlement",
      ...inside(province, mainArea),
    };
    const saved = cache[searchKey(search)];
    if (saved === undefined) return { ...resolution, next: search };
    city = saved;
    found(city, "city");
  }

  if (location.closeLocation) {
    // Inside the city, else inside the province - naming them helps Nominatim
    // match e.g. "millennium park, Calgary, Alberta"
    const searches: PlaceSearch[] = [];
    if (city) {
      searches.push({
        q: joinParts(location.closeLocation, location.city, location.province),
        ...inside(city, mainArea),
      });
    }
    if (province) {
      searches.push({
        q: joinParts(location.closeLocation, location.province),
        ...inside(province, mainArea),
      });
    }
    if (!city && !province) {
      searches.push({ q: location.closeLocation, ...inside(null, mainArea) });
    }

    for (const search of searches) {
      const saved = cache[searchKey(search)];
      if (saved === undefined) return { ...resolution, next: search };
      if (saved) {
        found(saved, "place");
        break;
      }
    }
  }

  return resolution;
}

/**
 * The province most tweets name (e.g. Alberta) - the dataset's main area, used
 * for parts that come without a province. null until provinces are looked up.
 */
function findMainArea(
  tweets: FloodTweet[],
  cache: PlaceCache,
): { name: string; place: Place } | null {
  const counts = new Map<
    string,
    { name: string; place: Place; tweets: number }
  >();
  for (const tweet of tweets) {
    const provinces = new Map<string, { name: string; place: Place }>();
    for (const location of tweet.locations) {
      const place =
        location.province &&
        cache[searchKey(provinceSearch(location.province))];
      if (place)
        provinces.set(`${place.lat},${place.lng}`, {
          name: location.province!,
          place,
        });
    }
    for (const [key, { name, place }] of provinces) {
      const entry = counts.get(key) ?? { name, place, tweets: 0 };
      entry.tweets++;
      counts.set(key, entry);
    }
  }
  const [top] = [...counts.values()].sort((a, b) => b.tweets - a.tweets);
  return top ? { name: top.name, place: top.place } : null;
}

/**
 * Sets every location's coordinates from the searches saved so far and returns
 * the searches still needed, keyed by searchKey()
 */
function applySavedSearches(
  tweets: FloodTweet[],
  cache: PlaceCache,
  mainArea: Place | null,
) {
  const pending = new Map<string, PendingSearch>();
  for (const tweet of tweets) {
    for (const location of tweet.locations) {
      const { place, precision, next } = resolveLocation(
        location,
        cache,
        mainArea,
      );
      location.coordinates = place && { lat: place.lat, lng: place.lng };
      location.precision = precision;
      if (!next) continue;

      const key = searchKey(next);
      const entry = pending.get(key) ?? {
        search: next,
        tweets: new Set<FloodTweet>(),
      };
      entry.tweets.add(tweet);
      pending.set(key, entry);
    }
  }
  return pending;
}

function describeSearch(search: PlaceSearch): string {
  const kind =
    search.featureType === "state"
      ? "province"
      : search.featureType === "settlement"
        ? "city"
        : "place";
  return `${kind} "${search.q}"`;
}

/**
 * Runs searches, most-waited-on first, saving each result straight away - safe
 * to stop with Ctrl+C, re-running picks up where it left off. Gives up after
 * repeated failures.
 */
async function runSearches(
  pending: Map<string, PendingSearch>,
  cache: PlaceCache,
) {
  const queue = [...pending.entries()].sort(
    ([, a], [, b]) => b.tweets.size - a.tweets.size,
  );
  console.log(
    `Running ${queue.length} search(es), about ` +
      `${Math.ceil((queue.length * 1.1) / 60)} min (Ctrl+C is safe - re-run to resume)`,
  );

  let ran = 0;
  let failuresInARow = 0;
  for (const [i, [key, { search, tweets }]] of queue.entries()) {
    const progress = `  [${i + 1}/${queue.length}] ${describeSearch(search)}`;

    let place: Place | null;
    try {
      place = await searchPlace(search);
      failuresInARow = 0;
    } catch (error) {
      console.warn(
        `${progress}: ${error instanceof Error ? error.message : error}`,
      );
      if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) {
        console.error(
          `Stopped after ${MAX_FAILURES_IN_A_ROW} failed searches in a row - re-run later to resume`,
        );
        return { ran, stopped: true };
      }
      continue;
    }

    cache[key] = place;
    savePlaceCache(cache);
    ran++;

    const found = place
      ? `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)} (${place.countryCode})`
      : "not found";
    console.log(`${progress} -> ${found} (${tweets.size} tweet(s))`);
  }
  return { ran, stopped: false };
}

/** e.g. "812 at a specific place, 1403 at a city, 950 at a province only, 310 not placed" */
function describePlacement(tweets: FloodTweet[]): string {
  const counts = { place: 0, city: 0, province: 0, none: 0 };
  for (const tweet of tweets) {
    for (const location of tweet.locations)
      counts[location.precision ?? "none"]++;
  }
  return (
    `${counts.place} at a specific place, ${counts.city} at a city, ` +
    `${counts.province} at a province only, ${counts.none} not placed`
  );
}

function saveTweets(collection: Collection<FloodTweet>, tweets: FloodTweet[]) {
  return collection.bulkWrite(
    tweets.map((tweet) => ({
      replaceOne: {
        filter: { id: tweet.id },
        replacement: tweet,
        upsert: true,
      },
    })),
    { ordered: false },
  );
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
  const allTweets: FloodTweet[] = rows.map((row, i) => {
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
  const tweets = dropRepeatedTexts(allTweets);

  if (unreadableTimes.length > 0) {
    console.warn(
      `${unreadableTimes.length} time value(s) couldn't be read and were stored as null, ` +
        `e.g. ${unreadableTimes[0]}`,
    );
  }
  if (brokenLocationLists.length > 0) {
    console.warn(
      `${brokenLocationLists.length} location list(s) aren't in groups of 3 ` +
        `(missing values filled with null), e.g. ${brokenLocationLists[0]}`,
    );
  }

  const cache = loadPlaceCache();
  let mainArea = findMainArea(tweets, cache);
  let pending = applySavedSearches(tweets, cache, mainArea?.place ?? null);

  const uniqueLocations = new Set(
    tweets.flatMap((t) =>
      t.locations.map((l) =>
        joinParts(l.closeLocation, l.city, l.province).toLowerCase(),
      ),
    ),
  );
  const summary = [
    `  ${allTweets.length} rows, ${tweets.length} unique tweet texts ` +
      `(${allTweets.length - tweets.length} repeated row(s) skipped)`,
    `  ${tweets.filter((t) => t.locations.length > 0).length} with a location, ` +
      `${uniqueLocations.size} unique locations`,
    `  locations placed so far: ${describePlacement(tweets)}`,
    `  main area: ${mainArea ? mainArea.name : "not known yet (found from the provinces)"}`,
    `  ${pending.size} search(es) to run next - more follow as each level is found`,
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
    const collection = client.db(MONGODB_DB).collection<FloodTweet>(COLLECTION);

    // Remove stale tweets first - ids no longer kept (e.g. repeats) or whose text
    // changed - so neither the saves below nor the unique text index can clash
    const textById = new Map(tweets.map((t) => [t.id, t.text]));
    const saved = await collection
      .find({}, { projection: { _id: 0, id: 1, text: 1 } })
      .toArray();
    const staleIds = saved
      .filter((t) => textById.get(t.id) !== t.text)
      .map((t) => t.id);
    const removed = await collection.deleteMany({ id: { $in: staleIds } });

    await collection.createIndexes([
      { key: { id: 1 }, unique: true },
      { key: { text: 1 }, unique: true },
      { key: { "locations.city": 1 } },
      { key: { time: 1 } },
    ]);

    console.log(
      `Importing ${tweets.length} tweets into ${MONGODB_DB}.${COLLECTION}`,
    );
    console.log(
      `  removed ${removed.deletedCount} (repeats, changed or no longer in the CSV)`,
    );
    console.log(summary.join("\n"));

    // Round by round: provinces first (they decide the main area), then each round
    // unlocks the next level. Tweets are saved after every round, so pins sharpen
    // from province to city to place while the rest are still being looked up.
    let isSaved = false;
    while (!skipGeocoding && pending.size > 0) {
      const provinces = new Map(
        [...pending].filter(([, { search }]) => search.featureType === "state"),
      );
      const { ran, stopped } = await runSearches(
        provinces.size > 0 ? provinces : pending,
        cache,
      );

      mainArea = findMainArea(tweets, cache);
      pending = applySavedSearches(tweets, cache, mainArea?.place ?? null);
      await saveTweets(collection, tweets);
      isSaved = true;
      console.log(
        `Saved ${tweets.length} tweets - locations: ${describePlacement(tweets)}`,
      );
      if (mainArea) console.log(`  main area: ${mainArea.name}`);
      if (stopped || ran === 0) break;
    }

    if (!isSaved) {
      await saveTweets(collection, tweets);
      console.log(
        `Saved ${tweets.length} tweets - locations: ${describePlacement(tweets)}`,
      );
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
