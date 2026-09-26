"use client";

import { useEffect, useState } from "react";
import { X, MapPin, Clock } from "lucide-react";
import { Drawer } from "vaul";
import type { MapPin as TweetPin } from "@/types/tweet";
import { PinSummary } from "./PinSummary";

interface PinTweetsPanelProps {
  pin: TweetPin | null;
  onClose: () => void;
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

// Cuts off rather than rounds, so 0.99992 shows as 99.99% - never 100% unless it is
const scoreFormat = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 2,
  roundingMode: "trunc",
});

/**
 * PinTweetsPanel - Lists every tweet behind a map pin, most relevant first, with a
 * floating button that summarises them
 * Desktop: Side panel on the left
 * Mobile: Bottom drawer
 */
export function PinTweetsPanel({ pin, onClose }: PinTweetsPanelProps) {
  const [isMobile, setIsMobile] = useState(false);
  const snapPoints = [0.4, 1];
  const [snap, setSnap] = useState<number | string | null>(snapPoints[0]);

  // Detect mobile viewport
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  if (!pin) return null;

  const count = pin.tweets.length;

  const content = (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Header - extra top space on desktop clears the floating search bar */}
      <div className="flex items-start gap-3 px-6 pt-4 md:pt-24 pb-4 border-b dark:border-gray-800">
        <MapPin className="mt-1 h-5 w-5 flex-shrink-0 text-rose-600" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white break-words">
            {pin.place}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {count} tweet{count !== 1 ? "s" : ""}
          </p>
        </div>
        {!isMobile && (
          <button
            onClick={onClose}
            className="p-2 -mr-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5 text-gray-700 dark:text-gray-300" />
          </button>
        )}
      </div>

      {/* Tweets (most relevant first), with the summary button floating over them */}
      <div className="relative flex-1 min-h-0">
        <ul className="h-full overflow-y-auto scrollbar-thin divide-y dark:divide-gray-800 pt-14">
          {pin.tweets.map((tweet) => (
            <li key={tweet.id} className="px-6 py-4">
              <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-line break-words">
                {tweet.text}
              </p>
              <div className="mt-2 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                <span className="flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                  {tweet.time ? timeFormat.format(new Date(tweet.time)) : "Time unknown"}
                </span>
                <span>{scoreFormat.format(tweet.score)} relevant</span>
                <span className="ml-auto" title="Tweet number">#{tweet.id}</span>
              </div>
            </li>
          ))}
        </ul>
        <PinSummary key={pin.id} pinId={pin.id} tweetCount={count} />
      </div>
    </div>
  );

  // Mobile: Use Drawer with snap points - no overlay to keep map accessible
  if (isMobile) {
    return (
      <Drawer.Root
        open={!!pin}
        onOpenChange={(open) => !open && onClose()}
        snapPoints={snapPoints}
        activeSnapPoint={snap}
        setActiveSnapPoint={setSnap}
        modal={false}
        noBodyStyles
      >
        <Drawer.Portal>
          <Drawer.Content
            className="fixed flex flex-col bg-white dark:bg-gray-900 rounded-t-[10px] bottom-0 left-0 right-0 h-full max-h-[97%] !z-[1100] shadow-[0_-10px_40px_rgba(0,0,0,0.2)]"
            aria-describedby={undefined}
          >
            <div className="mx-auto mt-4 h-2 w-[100px] rounded-full bg-gray-300 dark:bg-gray-600" />
            <div className="flex-1 overflow-hidden">
              <Drawer.Title className="sr-only">{pin.place}</Drawer.Title>
              {content}
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  // Desktop: Side Panel
  return (
    <div className="absolute top-0 left-0 h-full w-96 shadow-2xl z-[1000]">
      {content}
    </div>
  );
}
