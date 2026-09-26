"use client";

import { memo } from "react";
import { MapThemeSwitcher } from "./MapThemeSwitcher";
import { MapUser } from "./MapUser";
import { UploadCsvButton } from "./UploadCsvButton";

interface MapTopBarProps {
  /** Called once an uploaded CSV's tweets are in the database */
  onUploaded: () => void;
}

/**
 * MapTopBar - Top navigation bar with CSV upload, theme switcher and user menu
 * Memoized to prevent unnecessary re-renders
 */
export const MapTopBar = memo(function MapTopBar({ onUploaded }: MapTopBarProps) {
  return (
    <div className="absolute left-4 right-4 top-4 flex items-center gap-2 z-[1000]">
      {/* Spacer for search bar */}
      <div className="w-[360px]" />

      {/* Right side icons */}
      <div className="hidden sm:flex ml-auto items-center gap-2 pointer-events-auto">
        {/* CSV Upload */}
        <UploadCsvButton onUploaded={onUploaded} />

        {/* Theme Switcher */}
        <MapThemeSwitcher />

        {/* User Menu */}
        <MapUser />
      </div>
    </div>
  );
});

MapTopBar.displayName = "MapTopBar";
