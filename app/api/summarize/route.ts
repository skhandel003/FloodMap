import { NextRequest, NextResponse } from "next/server";
import { getFloodTweetsCollection } from "@/lib/mongodb";
import { locationLabel } from "@/lib/geocode";
import { summarizeTweets } from "@/lib/gemini";

// Only the most relevant tweets are summarised, to keep it quick
const MAX_TWEETS = 20;

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/summarize  { "pinId": "51.0447,-114.0719" }
 * Summarises a pin's 20 highest-scoring tweets with Gemini.
 *
 * Tweets are read from the database rather than sent by the browser, so the
 * endpoint can't be used to send arbitrary text to Gemini.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const pinId = String(body?.pinId ?? "");
  const [lat, lng] = pinId.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: 'pinId must be "lat,lng"' }, { status: 400 });
  }

  if (!process.env.GEMINi) {
    return NextResponse.json(
      { error: "Summaries aren't set up yet - the GEMINi key is missing" },
      { status: 503 }
    );
  }

  let tweets;
  try {
    const collection = await getFloodTweetsCollection();
    tweets = await collection
      .find(
        { locations: { $elemMatch: { "coordinates.lat": lat, "coordinates.lng": lng } } },
        { projection: { _id: 0, text: 1, locations: 1 } }
      )
      // Same order as the pin's tweet list: highest score first, ties in CSV order
      .sort({ score: -1, id: 1 })
      .limit(MAX_TWEETS)
      .toArray();
  } catch (error) {
    console.error("Failed to load tweets to summarise:", error);
    return NextResponse.json({ error: "Couldn't reach the tweet database" }, { status: 503 });
  }

  if (tweets.length === 0) {
    return NextResponse.json({ error: "No tweets found for this pin" }, { status: 404 });
  }

  const location = tweets[0].locations.find(
    (l) => l.coordinates?.lat === lat && l.coordinates?.lng === lng
  );
  const place = location ? locationLabel(location) : `${lat}, ${lng}`;

  try {
    const summary = await summarizeTweets(
      place,
      tweets.map((tweet) => tweet.text)
    );
    return NextResponse.json({ summary, tweetCount: tweets.length });
  } catch (error) {
    console.error("Gemini summary failed:", error);
    return NextResponse.json(
      { error: "Couldn't get a summary from Gemini - try again" },
      { status: 502 }
    );
  }
}
