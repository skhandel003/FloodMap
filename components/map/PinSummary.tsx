"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";

interface PinSummaryProps {
  pinId: string;
  /** How many tweets the pin holds in total */
  tweetCount: number;
}

type SummaryState =
  | { status: "loading" }
  | { status: "done"; summary: string; tweetCount: number }
  | { status: "error"; message: string };

/**
 * Three dots bouncing one after another while the summary loads
 */
function LoadingDots() {
  return (
    <div className="flex items-center gap-1.5 py-2" role="status" aria-label="Summarizing tweets">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-2 w-2 rounded-full bg-white animate-bounce"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * PinSummary - "Summarize" button floating over a pin's tweets. Clicking it opens
 * a box in the same style that shows loading dots, then Gemini's summary of the
 * pin's 20 most relevant tweets.
 *
 * - The summary is fetched once; closing and reopening the box reuses it
 * - After an error, reopening the box (or "Try again") asks again
 * - Render with key={pinId} so it starts fresh for each pin
 */
export function PinSummary({ pinId, tweetCount }: PinSummaryProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<SummaryState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cancel a pending request when the panel closes or switches pin
  useEffect(() => () => abortRef.current?.abort(), []);

  const summarize = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "loading" });

    try {
      const response = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinId }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setState({ status: "done", summary: data.summary, tweetCount: data.tweetCount });
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("Failed to summarize tweets:", error);
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Couldn't get a summary",
      });
    }
  };

  const handleOpen = () => {
    setIsOpen(true);
    if (state?.status !== "done" && state?.status !== "loading") {
      summarize();
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={handleOpen}
        className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-full bg-rose-600 hover:bg-rose-700 px-4 py-2 text-sm font-semibold text-white shadow-lg transition-colors"
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        Summarize
      </button>
    );
  }

  return (
    <div className="absolute top-3 left-4 right-4 z-10 flex max-h-[calc(100%-1.5rem)] flex-col rounded-2xl bg-rose-600 text-white shadow-lg">
      <div className="flex items-start gap-2 pl-4 pr-2 pt-2">
        <Sparkles className="mt-1.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0 pt-1">
          <p className="text-sm font-semibold">Summary</p>
          {state?.status === "done" && (
            <p className="text-xs text-white/80">
              {state.tweetCount < tweetCount
                ? `Top ${state.tweetCount} of ${tweetCount} tweets`
                : `${state.tweetCount} tweet${state.tweetCount !== 1 ? "s" : ""}`}
            </p>
          )}
        </div>
        <button
          onClick={() => setIsOpen(false)}
          className="p-1.5 rounded-full hover:bg-white/20 transition-colors"
          aria-label="Close summary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="overflow-y-auto scrollbar-thin px-4 pb-4 pt-1 text-sm leading-relaxed" aria-live="polite">
        {state?.status === "loading" && <LoadingDots />}
        {state?.status === "done" && <p className="whitespace-pre-line">{state.summary}</p>}
        {state?.status === "error" && (
          <div className="space-y-2">
            <p>{state.message}</p>
            <button
              onClick={summarize}
              className="rounded-full bg-white/20 hover:bg-white/30 px-3 py-1 text-xs font-semibold transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
