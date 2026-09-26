/**
 * The tweet processing pipeline (a Docker app on Hugging Face Spaces) - server
 * code only, it reads the PIPELINE_TOKEN secret
 *
 * It classifies a raw tweets CSV and extracts locations, as a job:
 * send the CSV -> check until it's done -> download the result (only once - the
 * pipeline deletes it after that).
 */

// PIPELINE_URL can point somewhere else, e.g. a local copy of the pipeline
const DEFAULT_PIPELINE_URL = "https://skhandel003-flood-tweet-pipeline.hf.space";
// Give up on a call that hangs rather than hold a request open
const TIMEOUT_MS = 30_000;
const FAILED_STATUSES = new Set(["failed", "error", "errored", "cancelled", "canceled"]);

export interface PipelineJob {
  status: "processing" | "done" | "failed";
  /** What the pipeline is working on, e.g. "classifying" */
  step: string | null;
  /** Why it failed */
  error: string | null;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env.PIPELINE_TOKEN;
  if (!token) throw new Error("PIPELINE_TOKEN is not set");

  const baseUrl = process.env.PIPELINE_URL || DEFAULT_PIPELINE_URL;
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Pipeline ${init.method ?? "GET"} ${path} returned ${response.status}: ` +
        (await response.text()).slice(0, 300),
    );
  }
  return response;
}

/** Sends a raw tweets CSV and returns the job's id */
export async function startJob(csv: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", csv, filename);
  const job = await (await call("/jobs", { method: "POST", body: form })).json();
  const id = job.id ?? job.job_id;
  if (!id) throw new Error(`Pipeline returned no job id: ${JSON.stringify(job)}`);
  return String(id);
}

export async function getJob(id: string): Promise<PipelineJob> {
  const job = await (await call(`/jobs/${encodeURIComponent(id)}`)).json();
  const status = String(job.status ?? "").toLowerCase();
  const error = job.error ?? job.detail ?? null;
  return {
    status:
      status === "done" ? "done" : FAILED_STATUSES.has(status) ? "failed" : "processing",
    step: job.step == null ? null : String(job.step),
    error: error == null ? null : typeof error === "string" ? error : JSON.stringify(error),
  };
}

/** Downloads the processed CSV - works once, the pipeline deletes it afterwards */
export async function downloadResult(id: string): Promise<string> {
  return (await call(`/jobs/${encodeURIComponent(id)}/result`)).text();
}
