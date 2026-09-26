/**
 * Search results from the old file cache (data/place-cache.json), from before
 * they were kept in MongoDB
 */

import fs from "node:fs";
import type { Db } from "mongodb";
import { addPlaceSearches } from "../lib/geotag";
import type { Place } from "../lib/geocode";

const OLD_CACHE_PATH = "data/place-cache.json";

/**
 * Moves the old file's results into MongoDB, so they aren't searched again, then
 * renames the file so this only happens once
 */
export async function moveOldPlaceCache(db: Db) {
  if (!fs.existsSync(OLD_CACHE_PATH)) return;

  const saved = JSON.parse(fs.readFileSync(OLD_CACHE_PATH, "utf8")) as Record<
    string,
    Place | null
  >;
  await addPlaceSearches(db, Object.entries(saved));

  const movedPath = OLD_CACHE_PATH.replace(/\.json$/, ".moved.json");
  fs.renameSync(OLD_CACHE_PATH, movedPath);
  console.log(
    `Moved ${Object.keys(saved).length} saved search(es) into MongoDB ` +
      `(old file kept as ${movedPath})`,
  );
}
