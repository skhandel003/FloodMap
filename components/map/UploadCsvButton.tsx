"use client";

import { useEffect, useRef, useState } from "react";
import { Clock, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

// How often to check on the pipeline while it processes the CSV
const POLL_MS = 3000;
// Vercel accepts uploads up to 4.5 MB
const MAX_BYTES = 4 * 1024 * 1024;
// Give up after this many failed checks in a row (a single miss is retried)
const MAX_CHECK_FAILURES = 5;

type Stage =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "processing"; step: string | null }
  | { kind: "saving" };

interface UploadCsvButtonProps {
  /** Called once the new tweets are in the database */
  onUploaded: () => void;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (response: Response) => response.json().catch(() => ({}));

function stageLabel(stage: Stage): string {
  switch (stage.kind) {
    case "uploading":
      return "Uploading…";
    case "processing":
      return stage.step ? `Processing: ${stage.step}` : "Processing…";
    case "saving":
      return "Saving tweets…";
    default:
      return "Upload CSV";
  }
}

/**
 * UploadCsvButton - Uploads a raw tweets CSV: the pipeline classifies it and
 * finds its locations, then its new tweets are added to the map (tweets already
 * there are skipped)
 *
 * While it works, a thin loading bar runs across the top of the screen and the
 * button shows the current stage. The pins appear as geotagging places them,
 * through the map's regular refresh.
 */
export function UploadCsvButton({ onUploaded }: UploadCsvButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isMountedRef = useRef(true);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const isBusy = stage.kind !== "idle";

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Leaving the page would abandon the upload before it's saved
  useEffect(() => {
    if (!isBusy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isBusy]);

  const upload = async (file: File) => {
    if (file.size > MAX_BYTES) {
      toast.error("That CSV is over 4 MB - the most an upload can be");
      return;
    }

    try {
      setStage({ kind: "uploading" });
      const form = new FormData();
      form.append("file", file);
      const started = await fetch("/api/upload", { method: "POST", body: form });
      const { jobId, error } = await readJson(started);
      if (!started.ok) throw new Error(error ?? `Upload failed (HTTP ${started.status})`);

      // Wait for the pipeline to finish
      setStage({ kind: "processing", step: null });
      const jobUrl = `/api/upload/${encodeURIComponent(jobId)}`;
      let failuresInARow = 0;
      while (true) {
        await wait(POLL_MS);
        if (!isMountedRef.current) return;

        let job;
        try {
          const response = await fetch(jobUrl, { cache: "no-store" });
          job = await readJson(response);
          if (!response.ok) throw new Error(job.error ?? `HTTP ${response.status}`);
        } catch (checkError) {
          if (++failuresInARow >= MAX_CHECK_FAILURES) throw checkError;
          continue;
        }
        failuresInARow = 0;

        if (job.status === "done") break;
        if (job.status === "failed") {
          throw new Error(`Processing failed${job.error ? `: ${job.error}` : ""}`);
        }
        setStage({ kind: "processing", step: job.step ?? null });
      }

      setStage({ kind: "saving" });
      const saved = await fetch(jobUrl, { method: "POST" });
      const result = await readJson(saved);
      if (!saved.ok) throw new Error(result.error ?? `Saving failed (HTTP ${saved.status})`);

      const skipped = [
        result.alreadySaved > 0 && `${result.alreadySaved} already on the map`,
        result.repeats > 0 && `${result.repeats} repeated in the file`,
      ].filter(Boolean);
      const skippedNote = skipped.length > 0 ? `Skipped ${skipped.join(" and ")}. ` : "";
      if (result.added > 0) {
        toast.success(`Added ${result.added} flood tweets`, {
          description: `${skippedNote}Pins appear on the map as their places are found.`,
        });
      } else {
        toast.info("No new tweets to add", { description: skippedNote });
      }
      onUploaded();
    } catch (error) {
      console.error("CSV upload failed:", error);
      if (isMountedRef.current) {
        toast.error(error instanceof Error ? error.message : "Upload failed");
      }
    } finally {
      if (isMountedRef.current) setStage({ kind: "idle" });
    }
  };

  return (
    <>
      {isBusy && (
        <div
          className="fixed inset-x-0 top-0 z-[2000] h-1 overflow-hidden bg-rose-600/20"
          role="progressbar"
          aria-label={stageLabel(stage)}
        >
          <div className="h-full w-1/4 bg-rose-600 animate-loading-bar" />
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Clear it so picking the same file again still triggers an upload
          event.target.value = "";
          if (file) upload(file);
        }}
      />
      <div className="relative">
        <button
          onClick={() => inputRef.current?.click()}
          disabled={isBusy}
          title={stageLabel(stage)}
          className="flex max-w-[260px] items-center gap-2 rounded-full bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:cursor-wait"
        >
          {isBusy ? (
            <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" aria-hidden="true" />
          ) : (
            <Upload className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{stageLabel(stage)}</span>
        </button>

        {/* Hangs below the button so the top bar doesn't shift */}
        {isBusy && (
          <div className="absolute right-0 top-full mt-2 flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white dark:bg-gray-800 px-3 py-1 text-xs text-gray-600 dark:text-gray-300 shadow-lg">
            <Clock className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            Processing a CSV takes a few minutes - keep this tab open
          </div>
        )}
      </div>
    </>
  );
}
