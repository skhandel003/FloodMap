/**
 * Place name -> coordinates via Nominatim (OpenStreetMap's search API)
 *
 * Nominatim is free and needs no key, and its results may be stored. Its usage
 * policy asks apps to identify themselves and send at most one request per second.
 * Data © OpenStreetMap contributors (ODbL) - the map must credit it.
 */

import type { TweetLocation } from "@/types/tweet";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "FloodMap-hackathon/0.1";
const MIN_INTERVAL_MS = 1100;

export interface Coordinates {
  lat: number;
  lng: number;
}

let lastRequestAt = 0;

/**
 * Search text for a place, most specific part first,
 * e.g. "millennium park, Calgary, Alberta"
 */
export function locationQuery(location: TweetLocation): string {
  return [location.closeLocation, location.city, location.province]
    .filter(Boolean)
    .join(", ");
}

/**
 * Looks up a place and returns its coordinates, or null when nothing matches.
 * Calls are spaced out automatically to respect the one-per-second limit.
 *
 * @param countryCode - optional ISO country code(s) to restrict results, e.g. "ca"
 */
export async function geocode(
  query: string,
  countryCode?: string
): Promise<Coordinates | null> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1" });
  if (countryCode) params.set("countrycodes", countryCode);

  const response = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Nominatim returned ${response.status}`);
  }

  const [result] = (await response.json()) as { lat: string; lon: string }[];
  return result ? { lat: Number(result.lat), lng: Number(result.lon) } : null;
}
