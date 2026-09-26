import { after, NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/mongodb";
import { downloadResult, getJob } from "@/lib/pipeline";
import { parseTweetsCsv, replaceTweets } from "@/lib/tweet-import";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Context {
  params: Promise<{ jobId: string }>;
}

/**
 * GET /api/upload/[jobId]
 * How the pipeline job is going: { status: "processing" | "done" | "failed", step, error }
 */
export async function GET(_request: NextRequest, context: Context) {
  const { jobId } = await context.params;
  try {
    return NextResponse.json(await getJob(jobId));
  } catch (error) {
    console.error("Failed to check pipeline job:", error);
    return NextResponse.json(
      { error: "Couldn't check on the tweet processing service" },
      { status: 502 },
    );
  }
}

/**
 * POST /api/upload/[jobId]
 * Once the job is done: downloads the processed CSV, replaces the tweets in the
 * database with it (repeated texts skipped), and starts placing them on the map
 * in the background. The CSV is only held in memory - nothing is kept, and the
 * pipeline deletes its copy once it's downloaded.
 */
export async function POST(request: NextRequest, context: Context) {
  const { jobId } = await context.params;

  let csv: string;
  try {
    csv = await downloadResult(jobId);
  } catch (error) {
    console.error("Failed to download pipeline result:", error);
    return NextResponse.json(
      { error: "Couldn't download the processed CSV - try the upload again" },
      { status: 502 },
    );
  }

  let parsed;
  try {
    parsed = parseTweetsCsv(csv);
  } catch (error) {
    return NextResponse.json(
      {
        error: `The processed CSV couldn't be read: ${error instanceof Error ? error.message : error}`,
      },
      { status: 422 },
    );
  }
  if (parsed.tweets.length === 0) {
    return NextResponse.json(
      { error: "The processed CSV has no flood tweets in it" },
      { status: 422 },
    );
  }

  try {
    const db = await getDatabase();
    await replaceTweets(db, parsed.tweets);
  } catch (error) {
    console.error("Failed to save uploaded tweets:", error);
    return NextResponse.json(
      { error: "Couldn't save the tweets to the database" },
      { status: 503 },
    );
  }

  // Place the new tweets on the map in the background
  after(async () => {
    try {
      await fetch(new URL("/api/geotag", request.url), { method: "POST" });
    } catch (error) {
      console.error("Failed to start geotagging:", error);
    }
  });

  return NextResponse.json({
    tweets: parsed.tweets.length,
    repeats: parsed.rowCount - parsed.tweets.length,
    withLocation: parsed.tweets.filter((t) => t.locations.length > 0).length,
  });
}
