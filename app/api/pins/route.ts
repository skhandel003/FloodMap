import { after, NextRequest, NextResponse } from "next/server";
import { getDatabase, getFloodTweetsCollection } from "@/lib/mongodb";
import { locationLabel } from "@/lib/geocode";
import { shouldStartGeotag } from "@/lib/geotag";
import type { MapPin } from "@/types/tweet";

// Always read the database at request time, never at build time
export const dynamic = "force-dynamic";

/**
 * GET /api/pins
 * Tweets grouped into map pins - tweets whose locations resolved to exactly the
 * same coordinates share a pin. Each pin lists its most relevant tweets first.
 *
 * After responding, it starts geotagging in the background if any tweets are
 * still waiting for coordinates (new data, a cleared cache, or a run that died) -
 * the map shows their pins on a later refresh.
 */
export async function GET(request: NextRequest) {
  after(async () => {
    try {
      if (await shouldStartGeotag(await getDatabase())) {
        await fetch(new URL("/api/geotag", request.url), { method: "POST" });
      }
    } catch (error) {
      console.error("Couldn't check for tweets to geotag:", error);
    }
  });

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
          place: locationLabel(location),
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

    // Highest score first, ties in CSV order - the same order /api/summarize uses
    for (const pin of pins.values()) {
      pin.tweets.sort((a, b) => b.score - a.score || a.id - b.id);
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
