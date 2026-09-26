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
// Give up on a search that hangs, so a background run can't stall
const TIMEOUT_MS = 10_000;

export interface Coordinates {
  lat: number;
  lng: number;
}

/** A search result: its point, the area it covers and its country */
export interface Place extends Coordinates {
  /** [south, north, west, east] */
  bbox: [number, number, number, number];
  /** Lowercase ISO code, e.g. "ca" */
  countryCode: string | null;
}

/**
 * One Nominatim search - see https://nominatim.org/release-docs/latest/api/Search/
 */
export interface PlaceSearch {
  q: string;
  /** "state" only matches provinces and states; "settlement" cities, towns and villages */
  featureType?: "state" | "settlement";
  /** Only accept results inside this area */
  within?: Place["bbox"];
  /** Only accept results in these countries (comma-separated ISO codes) */
  countryCodes?: string;
}

interface NominatimResult {
  lat: string;
  lon: string;
  /** [south, north, west, east] */
  boundingbox: [string, string, string, string];
  address?: { country_code?: string };
}

let lastRequestAt = 0;

/**
 * Pin label for a location, down to the level its coordinates belong to, most
 * specific first - e.g. "millennium park, Calgary, Alberta", or just "Alberta"
 * when only the province could be placed
 */
export function locationLabel(location: TweetLocation): string {
  const parts =
    location.precision === "province"
      ? [location.province]
      : location.precision === "city"
        ? [location.city, location.province]
        : [location.closeLocation, location.city, location.province];
  return parts.filter(Boolean).join(", ");
}

function searchParams(search: PlaceSearch): Record<string, string> {
  const params: Record<string, string> = { q: search.q };
  if (search.featureType) params.featureType = search.featureType;
  if (search.within) {
    const [south, north, west, east] = search.within;
    params.viewbox = `${west},${north},${east},${south}`;
    params.bounded = "1";
  }
  if (search.countryCodes) params.countrycodes = search.countryCodes;
  return params;
}

/** Text that identifies a search, for saving results - changes whenever the search does */
export function searchKey(search: PlaceSearch): string {
  return new URLSearchParams(searchParams(search)).toString().toLowerCase();
}

/**
 * Runs a search and returns the best match, or null when nothing matches.
 * Calls are spaced out automatically to respect the one-per-second limit.
 */
export async function searchPlace(search: PlaceSearch): Promise<Place | null> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const params = new URLSearchParams({
    ...searchParams(search),
    format: "jsonv2",
    limit: "1",
    addressdetails: "1",
  });
  const response = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Nominatim returned ${response.status}`);
  }

  const [result] = (await response.json()) as NominatimResult[];
  if (!result) return null;

  const [south, north, west, east] = result.boundingbox.map(Number);
  return {
    lat: Number(result.lat),
    lng: Number(result.lon),
    bbox: [south, north, west, east],
    countryCode: result.address?.country_code ?? null,
  };
}
