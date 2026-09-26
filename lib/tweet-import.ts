/**
 * Processed tweets CSV -> FloodTweets documents, and saving them
 *
 * Used by `npm run import:tweets` and by uploads in the web app (/api/upload).
 * The CSV comes from the classifier: tweet, score and locations columns plus an
 * optional time column. locations is a flat list of (province, city, close
 * location) triples, e.g.
 *   ['Alberta', 'Calgary', 'millennium park', 'Alberta', 'High River', None]
 *
 * Tweet texts are unique: repeats (mostly retweets) are dropped here, and a
 * unique index on text stops copies getting into the collection.
 */

import Papa from "papaparse";
import type { Db } from "mongodb";
import type { FloodTweet, TweetLocation } from "../types/tweet";

const COLLECTION = "FloodTweets";
const REQUIRED_COLUMNS = ["tweet", "score", "locations"];
const TIME_COLUMNS = ["time", "timestamp", "created_at", "date"];
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
// Words that narrow a province or city without naming a place, e.g. "Southern
// Alberta" - removed from provinces, cities and lone regions (see toLocations),
// but not from specific places, so "Central Memorial Park" keeps its name
const DIRECTION = /\b(southern|northern|eastern|western|central)\b/gi;

export interface ParsedTweets {
  /** One per unique tweet text, in file order */
  tweets: FloodTweet[];
  /** Data rows in the file, repeats included */
  rowCount: number;
  /** The column times were read from, if the file has one */
  timeColumn: string | undefined;
  /** Problems worth reporting that didn't stop the import */
  warnings: string[];
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
function parseList(value: string | undefined): (string | null)[] {
  if (!value || /^(none|null|nan)?$/i.test(value.trim())) return [];

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
 * case-insensitive repeats and triples with neither a province nor a city - a
 * close location alone (e.g. [None, None, 'Mission']) is too vague to place.
 *
 * The exception is a lone region like [None, None, 'Southern Alberta']: without
 * its direction word it's used as the province, e.g. [Alberta, None, None].
 */
function toLocations(items: (string | null)[]): TweetLocation[] {
  const seen = new Set<string>();
  const locations: TweetLocation[] = [];
  for (let i = 0; i < items.length; i += 3) {
    let province = cleanValue(items[i]?.replace(DIRECTION, ""));
    const city = cleanValue(items[i + 1]?.replace(DIRECTION, ""));
    let closeLocation = cleanValue(items[i + 2]);

    if (!province && !city && closeLocation) {
      const region = cleanValue(closeLocation.replace(DIRECTION, ""));
      if (region !== closeLocation) {
        province = region;
        closeLocation = null;
      }
    }
    if (!province && !city) continue;

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

/**
 * Reads a processed tweets CSV. Each tweet's id is the line it starts on (the
 * header is line 1). Throws when the file can't be read or lacks a required column.
 */
export function parseTweetsCsv(text: string): ParsedTweets {
  const { data: rows, errors, meta } = Papa.parse<Record<string, string>>(
    text.replace(/^﻿/, ""),
    { header: true, skipEmptyLines: true },
  );
  if (errors.length > 0) {
    throw new Error(`${errors[0].message} (row ${errors[0].row})`);
  }

  const columns = meta.fields ?? [];
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `missing column(s) ${missing.join(", ")} - it has ${columns.join(", ") || "none"}`,
    );
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

  const warnings: string[] = [];
  if (unreadableTimes.length > 0) {
    warnings.push(
      `${unreadableTimes.length} time value(s) couldn't be read and were stored as null, ` +
        `e.g. ${unreadableTimes[0]}`,
    );
  }
  if (brokenLocationLists.length > 0) {
    warnings.push(
      `${brokenLocationLists.length} location list(s) aren't in groups of 3 ` +
        `(missing values filled with null), e.g. ${brokenLocationLists[0]}`,
    );
  }

  return {
    tweets: dropRepeatedTexts(allTweets),
    rowCount: rows.length,
    timeColumn,
    warnings,
  };
}

/**
 * Makes the FloodTweets collection hold exactly these tweets, without coordinates
 * until geotagging fills them in. Tweets no longer there, or whose text changed,
 * are removed first, so neither the saves nor the unique text index can clash.
 */
export async function replaceTweets(db: Db, tweets: FloodTweet[]) {
  const collection = db.collection<FloodTweet>(COLLECTION);

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

  if (tweets.length === 0) {
    return { inserted: 0, updated: 0, removed: removed.deletedCount };
  }
  const written = await collection.bulkWrite(
    tweets.map((tweet) => ({
      replaceOne: {
        filter: { id: tweet.id },
        replacement: tweet,
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return {
    inserted: written.upsertedCount,
    updated: written.modifiedCount,
    removed: removed.deletedCount,
  };
}
