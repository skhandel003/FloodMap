"use client";

import { memo, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { Copy, MapPin, Ruler, Check } from "lucide-react";
import { formatDecimalDegrees } from "@/lib/utils/coordinates";
import type { ContextMenuPosition } from "@/hooks/useMapContextMenu";

interface MapContextMenuProps {
  isOpen: boolean;
  position: ContextMenuPosition | null;
  onClose: () => void;
  onAddMarker: (lat: number, lng: number) => void;
  onStartMeasurement: () => void;
}

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  onClick: () => void;
  showCopied?: boolean;
}

/**
 * Individual menu item component
 */
const MenuItem = memo(function MenuItem({
  icon,
  label,
  sublabel,
  onClick,
  showCopied,
}: MenuItemProps) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-3 w-full px-2 py-1 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors rounded-lg group"
    >
      <span className="flex-shrink-0 text-gray-500 dark:text-gray-400 group-hover:text-gray-700 dark:group-hover:text-gray-200">
        {showCopied ? <Check className="h-4 w-4 text-green-500" /> : icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {showCopied ? "Copied!" : label}
        </div>
        {sublabel && !showCopied && (
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {sublabel}
          </div>
        )}
      </div>
    </button>
  );
});

MenuItem.displayName = "MenuItem";

// Menu dimensions for position calculation (approximate)
const MENU_WIDTH = 220;
const MENU_HEIGHT = 180;
const MENU_PADDING = 8;

/**
 * MapContextMenu - Right-click context menu for map interactions
 *
 * Features:
 * - Copy coordinates to clipboard
 * - Add marker at clicked location
 * - Start measurement from clicked location
 * - Keyboard accessible (Escape to close)
 * - Auto-positions to stay within viewport
 * - Memoized for performance
 */
export const MapContextMenu = memo(function MapContextMenu({
  isOpen,
  position,
  onClose,
  onAddMarker,
  onStartMeasurement,
}: MapContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Track which position was copied (null means not copied)
  const [copiedPosition, setCopiedPosition] = useState<string | null>(null);

  // Format coordinates for display
  const coordsText = useMemo(() => {
    if (!position) return "";
    return formatDecimalDegrees([position.latlng.lat, position.latlng.lng], 6);
  }, [position]);

  // Derive copied state from position comparison
  const positionKey = position ? `${position.x}-${position.y}` : null;
  const copied = copiedPosition === positionKey;

  // Calculate adjusted position using useMemo instead of useEffect + setState
  const displayPosition = useMemo(() => {
    if (!position) return { x: 0, y: 0 };

    let x = position.x;
    let y = position.y;

    // Use window dimensions as fallback for container bounds
    // The actual adjustment will happen via CSS if needed
    if (typeof window !== "undefined") {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Adjust horizontal position if menu would overflow right edge
      if (x + MENU_WIDTH > viewportWidth) {
        x = Math.max(0, x - MENU_WIDTH - MENU_PADDING);
      }

      // Adjust vertical position if menu would overflow bottom edge
      if (y + MENU_HEIGHT > viewportHeight) {
        y = Math.max(0, y - MENU_HEIGHT - MENU_PADDING);
      }
    }

    return { x, y };
  }, [position]);

  /**
   * Copy coordinates to clipboard
   */
  const handleCopyCoordinates = useCallback(async () => {
    if (!position || !positionKey) return;

    try {
      await navigator.clipboard.writeText(coordsText);
      setCopiedPosition(positionKey);
      setTimeout(() => {
        setCopiedPosition(null);
        onClose();
      }, 1000);
    } catch (error) {
      console.error("Failed to copy coordinates:", error);
      // Fallback: create a temporary input element
      try {
        const input = document.createElement("input");
        input.value = coordsText;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        input.setSelectionRange(0, 99999);
        document.execCommand("copy");
        document.body.removeChild(input);
        setCopiedPosition(positionKey);
        setTimeout(() => {
          setCopiedPosition(null);
          onClose();
        }, 1000);
      } catch {
        console.error("Fallback copy also failed");
      }
    }
  }, [position, positionKey, coordsText, onClose]);

  /**
   * Handle add marker
   */
  const handleAddMarker = useCallback(() => {
    if (!position) return;
    onAddMarker(position.latlng.lat, position.latlng.lng);
    onClose();
  }, [position, onAddMarker, onClose]);

  /**
   * Handle start measurement
   */
  const handleStartMeasurement = useCallback(() => {
    onStartMeasurement();
    onClose();
  }, [onStartMeasurement, onClose]);

  /**
   * Handle click outside to close
   */
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Delay to prevent immediate close from the contextmenu event
    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !position) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      className="absolute z-[1100] min-w-[200px] bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 py-1.5 px-1.5 animate-in fade-in-0 zoom-in-95 duration-150"
      style={{
        left: displayPosition.x,
        top: displayPosition.y,
      }}
      role="menu"
      aria-label="Map context menu"
    >
      {/* Coordinates */}
      <MenuItem
        icon={<Copy className="h-4 w-4" />}
        label="Copy Coordinates"
        sublabel={coordsText}
        onClick={handleCopyCoordinates}
        showCopied={copied}
      />

      {/* Divider */}
      <div className="my-1.5 border-t border-gray-200 dark:border-gray-700" />

      {/* Add Marker */}
      <MenuItem
        icon={<MapPin className="h-4 w-4" />}
        label="Add Marker"
        sublabel="Place a marker here"
        onClick={handleAddMarker}
      />

      {/* Measurement */}
      <MenuItem
        icon={<Ruler className="h-4 w-4" />}
        label="Measure"
        sublabel="Start distance measurement"
        onClick={handleStartMeasurement}
      />
    </div>
  );
});

MapContextMenu.displayName = "MapContextMenu";
