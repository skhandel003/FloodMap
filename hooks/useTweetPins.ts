"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { MapPin } from "@/types/tweet";

/**
 * Loads the tweet pins from /api/pins once when the map opens
 *
 * @returns Pins to draw; empty until loaded or if the database can't be reached
 */
export function useTweetPins() {
  const [pins, setPins] = useState<MapPin[]>([]);

  useEffect(() => {
    let isMounted = true;

    const loadPins = async () => {
      try {
        const response = await fetch("/api/pins");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!isMounted) return;

        setPins(data);
        if (data.length === 0) {
          toast.info("No tweets with coordinates in the database yet");
        }
      } catch (error) {
        console.error("Failed to load tweet pins:", error);
        if (isMounted) toast.error("Couldn't load tweets from the database");
      }
    };

    loadPins();

    return () => {
      isMounted = false;
    };
  }, []);

  return pins;
}
