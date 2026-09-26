import { NextResponse } from "next/server";
import { getFloodTweetsCollection } from "@/lib/mongodb";
import { locationQuery } from "@/lib/geocode";
import type { MapPin } from "@/types/tweet";

// Always read the database at request time, never at build time
export const dynamic = "force-dynamic";

/**
 * GET /api/pins
 * Tweets grouped into map pins - tweets whose locations resolved to exactly the
 * same coordinates share a pin
 */
export async function GET() {
  try {
    const collection = await getFloodTweetsCollection();
    const tweets = await collection
      .find(
        { locations: { $elemMatch: { coordinates: { $ne: null } } } },
        { projection: { _id: 0 } }
      )
      .sort({ id: 1 })
      .toArray();

    const pins = new Map<string, MapPin>();
    for (const tweet of tweets) {
      for (const location of tweet.locations) {
        if (!location.coordinates) continue;

        const { lat, lng } = location.coordinates;
        const key = `${lat},${lng}`;
        const pin = pins.get(key) ?? {
          id: key,
          lat,
          lng,
          place: locationQuery(location),
          tweets: [],
        };
        // A tweet naming two places that resolve to the same spot counts once
        if (pin.tweets.at(-1)?.id !== tweet.id) {
          pin.tweets.push({
            id: tweet.id,
            text: tweet.text,
            score: tweet.score,
            time: tweet.time?.toISOString() ?? null,
          });
        }
        pins.set(key, pin);
      }
    }

    return NextResponse.json([...pins.values()]);
  } catch (error) {
    console.error("Failed to load pins:", error);
    return NextResponse.json(
      { error: "Couldn't reach the tweet database" },
      { status: 503 }
    );
  }
}
