import { NextRequest, NextResponse } from "next/server";
import { startJob } from "@/lib/pipeline";

// Vercel accepts request bodies up to 4.5 MB
const MAX_BYTES = 4 * 1024 * 1024;

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/upload  (form field "file": a raw tweets CSV)
 * Sends the CSV to the processing pipeline and returns its job id (202). Check
 * progress with GET /api/upload/[jobId], then save the result with
 * POST /api/upload/[jobId]. The CSV is passed straight through, never stored.
 */
export async function POST(request: NextRequest) {
  if (!process.env.PIPELINE_TOKEN) {
    return NextResponse.json(
      { error: "Uploads aren't set up yet - PIPELINE_TOKEN is missing" },
      { status: 503 },
    );
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Choose a CSV file to upload" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "That CSV is over 4 MB - the most an upload can be" },
      { status: 413 },
    );
  }

  try {
    const jobId = await startJob(file, file.name || "tweets.csv");
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    console.error("Failed to start pipeline job:", error);
    return NextResponse.json(
      { error: "Couldn't reach the tweet processing service - try again" },
      { status: 502 },
    );
  }
}
