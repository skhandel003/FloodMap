import { after, NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/mongodb";
import { geotagCollection } from "@/lib/geotag";

// Each run stops starting searches after this long and hands over to a fresh run,
// so it always finishes inside the function time limit below
const RUN_MS = 45_000;

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/geotag
 * Starts geotagging the tweets in the database and responds straight away (202) -
 * call it after adding tweets. The work happens after the response, so it never
 * holds up a page; new pins show up on the map at its next refresh.
 *
 * Each run works for up to 45 seconds, then starts the next with another POST,
 * until nothing is left to search. While a run is going, further calls do nothing.
 */
export async function POST(request: NextRequest) {
  after(async () => {
    try {
      const db = await getDatabase();
      const { status } = await geotagCollection(db, { timeLimitMs: RUN_MS });
      if (status === "paused") {
        await fetch(new URL("/api/geotag", request.url), { method: "POST" });
      }
    } catch (error) {
      console.error("Geotagging failed:", error);
    }
  });

  return NextResponse.json({ status: "started" }, { status: 202 });
}
