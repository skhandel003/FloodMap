/**
 * Geotagging: gives the tweets in the FloodTweets collection coordinates
 *
 * Works on the collection itself - reads the tweets, runs the Nominatim searches
 * they need (one per second, most-waited-on first) and writes each result back to
 * the affected tweets straight away. The map re-reads /api/pins every 20 seconds,
 * so new pins appear while the rest are still being looked up.
 *
 * It runs outside page requests - in the background from POST /api/geotag, or from
 * `npm run geotag` - so it never holds up the UI. A lock in the Jobs collection
 * allows one run at a time, which keeps to Nominatim's one-per-second limit.
 *
 * Each location is placed from its own (province, city, close location) triple:
 * - province: only provinces/states match
 * - city: only cities, towns and villages - inside the province when one was found
 * - close location: inside the city, else inside the province; never searched
 *   without one of them, so it can't land somewhere unrelated
 * The location gets the most specific level found. Search results are kept in the
 * PlaceSearches collection, so each search only ever runs once.
 */

import type { Collection, Db } from "mongodb";
import { searchKey, searchPlace, type Place, type PlaceSearch } from "./geocode";
import type { FloodTweet, TweetLocation } from "../types/tweet";

const TWEETS = "FloodTweets";
const PLACE_SEARCHES = "PlaceSearches";
const JOBS = "Jobs";
const LOCK_ID = "geotag";
// A run renews its lock after every search, so it only runs out if the run dies
const LOCK_MS = 2 * 60_000;
const MAX_FAILURES_IN_A_ROW = 5;

/** A saved search - place is null when nothing was found */
interface PlaceSearchDoc {
  _id: string;
  place: Place | null;
  searchedAt: Date;
}

interface JobDoc {
  _id: string;
  lockedUntil: Date;
}

/** Saved searches keyed by searchKey() */
type PlaceCache = Map<string, Place | null>;

/** What a location comes to from the searches saved so far */
interface Resolution {
  /** The most specific part found so far */
  place: Place | null;
  precision: TweetLocation["precision"];
  /** The next search the location needs, or null when it's settled */
  next: PlaceSearch | null;
}

export interface GeotagOptions {
  /** Stop starting searches after this long - a later run carries on */
  timeLimitMs?: number;
  log?: (message: string) => void;
}

export interface GeotagResult {
  /**
   * done: nothing left to search; paused: reached the time limit; busy: another
   * run holds the lock; failed: stopped after repeated search failures
   */
  status: "done" | "paused" | "busy" | "failed";
  /** How many searches this run made */
  searches: number;
}

const joinParts = (...parts: (string | null)[]) =>
  parts.filter(Boolean).join(", ");

// Read when needed - scripts load .env.local after importing this file
const geocodeCountry = () => process.env.GEOCODE_COUNTRY || undefined;

function provinceSearch(province: string): PlaceSearch {
  return { q: province, featureType: "state", countryCodes: geocodeCountry() };
}

/**
 * Keeps a search inside `parent` (and its country) when there is one
 */
function inside(
  parent: Place | null,
): Pick<PlaceSearch, "within" | "countryCodes"> {
  return parent
    ? {
        within: parent.bbox,
        countryCodes: parent.countryCode ?? geocodeCountry(),
      }
    : { countryCodes: geocodeCountry() };
}

/**
 * Works out a location from its own triple and saved searches, level by level
 * (see the notes at the top). Stops at the first search not run yet and returns
 * it as `next`, along with the best part found up to then.
 */
function resolveLocation(
  location: TweetLocation,
  cache: PlaceCache,
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
    const saved = cache.get(searchKey(search));
    if (saved === undefined) return { ...resolution, next: search };
    province = saved;
    found(province, "province");
  }

  let city: Place | null = null;
  if (location.city) {
    const search: PlaceSearch = {
      q: location.city,
      featureType: "settlement",
      ...inside(province),
    };
    const saved = cache.get(searchKey(search));
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
        ...inside(city),
      });
    }
    if (province) {
      searches.push({
        q: joinParts(location.closeLocation, location.province),
        ...inside(province),
      });
    }

    for (const search of searches) {
      const saved = cache.get(searchKey(search));
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
 * Sets a tweet's coordinates from the saved searches. Returns whether any of its
 * locations changed and the searches they still need.
 */
function applySavedSearches(tweet: FloodTweet, cache: PlaceCache) {
  let changed = false;
  const next: PlaceSearch[] = [];
  for (const location of tweet.locations) {
    const resolution = resolveLocation(location, cache);
    const coordinates = resolution.place && {
      lat: resolution.place.lat,
      lng: resolution.place.lng,
    };
    if (
      coordinates?.lat !== location.coordinates?.lat ||
      coordinates?.lng !== location.coordinates?.lng ||
      resolution.precision !== location.precision
    ) {
      location.coordinates = coordinates;
      location.precision = resolution.precision;
      changed = true;
    }
    if (resolution.next) next.push(resolution.next);
  }
  return { changed, next };
}

/**
 * Writes tweets' locations back. Matching on text as well as id means a run that
 * started before an upload can't write onto a new tweet that reuses an old id
 * (ids are CSV line numbers).
 */
async function saveLocations(
  collection: Collection<FloodTweet>,
  tweets: FloodTweet[],
) {
  if (tweets.length === 0) return;
  await collection.bulkWrite(
    tweets.map((tweet) => ({
      updateOne: {
        filter: { id: tweet.id, text: tweet.text },
        update: { $set: { locations: tweet.locations } },
      },
    })),
    { ordered: false },
  );
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

/** e.g. "812 at a specific place, 1403 at a city, 950 at a province only, 310 not placed" */
export function describePlacement(tweets: FloodTweet[]): string {
  const counts = { place: 0, city: 0, province: 0, none: 0 };
  for (const tweet of tweets) {
    for (const location of tweet.locations) {
      counts[location.precision ?? "none"]++;
    }
  }
  return (
    `${counts.place} at a specific place, ${counts.city} at a city, ` +
    `${counts.province} at a province only, ${counts.none} not placed`
  );
}

/**
 * Takes the geotagging lock unless a live run holds it. With no lock document,
 * or an expired one, the upsert takes it; a live one makes the upsert clash on _id.
 */
async function takeLock(jobs: Collection<JobDoc>): Promise<boolean> {
  const now = new Date();
  try {
    await jobs.updateOne(
      { _id: LOCK_ID, lockedUntil: { $lt: now } },
      { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
      { upsert: true },
    );
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
}

async function renewLock(jobs: Collection<JobDoc>) {
  await jobs.updateOne(
    { _id: LOCK_ID },
    { $set: { lockedUntil: new Date(Date.now() + LOCK_MS) } },
  );
}

/** Frees the lock - e.g. when a script is stopped with Ctrl+C mid-run */
export async function releaseGeotagLock(db: Db) {
  await db
    .collection<JobDoc>(JOBS)
    .updateOne({ _id: LOCK_ID }, { $set: { lockedUntil: new Date(0) } });
}

/**
 * Adds search results saved elsewhere (e.g. an old cache file), keeping any the
 * collection already has
 */
export async function addPlaceSearches(
  db: Db,
  results: [string, Place | null][],
) {
  if (results.length === 0) return;
  await db.collection<PlaceSearchDoc>(PLACE_SEARCHES).bulkWrite(
    results.map(([key, place]) => ({
      updateOne: {
        filter: { _id: key },
        update: { $setOnInsert: { place, searchedAt: new Date() } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

/**
 * Geotags the tweets in the collection until nothing is left to search, the time
 * limit is reached, or searches keep failing. Safe to stop and run again - it
 * carries on where it left off.
 */
export async function geotagCollection(
  db: Db,
  { timeLimitMs = Infinity, log = console.log }: GeotagOptions = {},
): Promise<GeotagResult> {
  const startedAt = Date.now();
  const jobs = db.collection<JobDoc>(JOBS);
  if (!(await takeLock(jobs))) {
    log("Geotagging is already running");
    return { status: "busy", searches: 0 };
  }

  let searches = 0;
  try {
    const tweetsCollection = db.collection<FloodTweet>(TWEETS);
    const searchesCollection = db.collection<PlaceSearchDoc>(PLACE_SEARCHES);
    const cache: PlaceCache = new Map(
      (await searchesCollection.find().toArray()).map((doc) => [
        doc._id,
        doc.place,
      ]),
    );

    while (true) {
      // Re-read the collection every round, so tweets added meanwhile are tagged too
      const tweets = await tweetsCollection
        .find({}, { projection: { _id: 0 } })
        .toArray();

      const pending = new Map<
        string,
        { search: PlaceSearch; tweets: Set<FloodTweet> }
      >();
      const changed: FloodTweet[] = [];
      for (const tweet of tweets) {
        const result = applySavedSearches(tweet, cache);
        if (result.changed) changed.push(tweet);
        for (const search of result.next) {
          const key = searchKey(search);
          const entry = pending.get(key) ?? {
            search,
            tweets: new Set<FloodTweet>(),
          };
          entry.tweets.add(tweet);
          pending.set(key, entry);
        }
      }
      await saveLocations(tweetsCollection, changed);

      if (pending.size === 0) {
        log(`Geotagging done - locations: ${describePlacement(tweets)}`);
        return { status: "done", searches };
      }
      log(
        `${pending.size} search(es) to run, about ${Math.ceil((pending.size * 1.1) / 60)} min ` +
          `- locations so far: ${describePlacement(tweets)}`,
      );

      const queue = [...pending.entries()].sort(
        ([, a], [, b]) => b.tweets.size - a.tweets.size,
      );
      let ranThisRound = 0;
      let failuresInARow = 0;
      for (const [i, [key, { search, tweets: waiting }]] of queue.entries()) {
        if (Date.now() - startedAt > timeLimitMs) {
          log(`Paused after ${searches} search(es) - the next run carries on`);
          return { status: "paused", searches };
        }
        const progress = `  [${i + 1}/${queue.length}] ${describeSearch(search)}`;

        let place: Place | null;
        try {
          place = await searchPlace(search);
          failuresInARow = 0;
        } catch (error) {
          log(`${progress}: ${error instanceof Error ? error.message : error}`);
          if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) {
            log(`Stopped after ${MAX_FAILURES_IN_A_ROW} failed searches in a row`);
            return { status: "failed", searches };
          }
          continue;
        }

        cache.set(key, place);
        await searchesCollection.updateOne(
          { _id: key },
          { $set: { place, searchedAt: new Date() } },
          { upsert: true },
        );
        searches++;
        ranThisRound++;

        // Write the result to the tweets waiting on it now, so their pins show up
        // on the map's next refresh rather than at the end of the round
        await saveLocations(
          tweetsCollection,
          [...waiting].filter((tweet) => applySavedSearches(tweet, cache).changed),
        );
        await renewLock(jobs);

        const found = place
          ? `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)} (${place.countryCode})`
          : "not found";
        log(`${progress} -> ${found} (${waiting.size} tweet(s))`);
      }

      // Only searches that keep failing are left - stop rather than retry forever
      if (ranThisRound === 0) return { status: "failed", searches };
    }
  } finally {
    await releaseGeotagLock(db);
  }
}
