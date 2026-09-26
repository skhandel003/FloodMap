"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { MapPin } from "@/types/tweet";

// How often to check for new pins (e.g. while an import is running)
const REFRESH_MS = 20_000;

/**
 * Loads the tweet pins from /api/pins when the map opens, then checks again every
 * 20 seconds while the tab is visible - and straight away when it becomes visible
 * again - so pins added to the database appear without a reload
 *
 * - The pins only change when the data does, so a check that finds nothing new
 *   doesn't redraw the map
 * - Only the first failure is reported; a missed check just waits for the next one
 *
 * @returns Pins to draw; empty until loaded or if the database can't be reached
 */
export function useTweetPins() {
  const [pins, setPins] = useState<MapPin[]>([]);

  useEffect(() => {
    let isMounted = true;
    let latestRequest = 0;
    let lastBody: string | null = null;
    let hasWarned = false;

    const loadPins = async () => {
      // A slow response mustn't overwrite a newer one
      const request = ++latestRequest;
      try {
        const response = await fetch("/api/pins", { cache: "no-store" });
        const body = await response.text();
        if (!isMounted || request !== latestRequest) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
        if (body === lastBody) return;

        const isFirstLoad = lastBody === null;
        lastBody = body;
        const data = JSON.parse(body) as MapPin[];
        setPins(data);
        if (isFirstLoad && data.length === 0) {
          toast.info("No tweets with coordinates in the database yet");
        }
      } catch (error) {
        console.error("Failed to load tweet pins:", error);
        if (isMounted && !hasWarned) {
          hasWarned = true;
          toast.error("Couldn't load tweets from the database");
        }
      }
    };

    const loadIfVisible = () => {
      if (document.visibilityState === "visible") loadPins();
    };

    loadPins();
    const timer = setInterval(loadIfVisible, REFRESH_MS);
    document.addEventListener("visibilitychange", loadIfVisible);

    return () => {
      isMounted = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", loadIfVisible);
    };
  }, []);

  return pins;
}
