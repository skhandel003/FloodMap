"use client";

import { useState, useCallback, useMemo } from "react";
import { LeafletMap } from "./LeafletMap";
import { LeafletTileLayer } from "./LeafletTileLayer";
import { LeafletGeoJSON } from "./LeafletGeoJSON";
import { MapSearchBar } from "./MapSearchBar";
import { MapTopBar } from "./MapTopBar";
import { MapControls } from "./MapControls";
import { MapDetailsPanel } from "./MapDetailsPanel";
import { MapMeasurementPanel } from "./MapMeasurementPanel";
import { MapContextMenu } from "./MapContextMenu";
import { TweetPinLayer } from "./TweetPinLayer";
import { PinTweetsPanel } from "./PinTweetsPanel";
import { useMapContextMenu } from "@/hooks/useMapContextMenu";
import { useMapMarkers } from "@/hooks/useMapMarkers";
import { useTweetPins } from "@/hooks/useTweetPins";
import { SATELLITE_TILE_PROVIDER } from "@/constants/tile-providers";
import type { MapPin } from "@/types/tweet";

// Memoized style object to prevent unnecessary re-renders
const GEOJSON_STYLE = {
  fillColor: "#3b82f6",
  fillOpacity: 0.2,
  color: "#2563eb",
  weight: 2,
} as const;

/**
 * MapMain - Main map component on satellite imagery
 *
 * Optimizations:
 * - Memoized callbacks to prevent unnecessary re-renders
 * - Static style object for GeoJSON
 * - Stable function references
 */
export function MapMain() {
  const [selectedCountry, setSelectedCountry] =
    useState<GeoJSON.Feature | null>(null);
  const [isMeasurementOpen, setIsMeasurementOpen] = useState(false);
  const [clickedPin, setClickedPin] = useState<MapPin | null>(null);

  // Tweet pins from the database
  const { pins, refresh: refreshPins } = useTweetPins();

  // The open pin's tweet list follows each refresh (e.g. tweets geotagged since
  // it was clicked). If the pin is gone - its tweets moved to more precise pins -
  // the panel falls back to the pin as it was when clicked.
  const selectedPin = useMemo(
    () =>
      clickedPin &&
      (pins.find((pin) => pin.id === clickedPin.id) ?? clickedPin),
    [pins, clickedPin]
  );

  // Context menu hook
  const {
    isOpen: isContextMenuOpen,
    position: contextMenuPosition,
    close: closeContextMenu,
  } = useMapContextMenu();

  // User markers hook
  const { addMarker } = useMapMarkers();

  // Memoized callbacks to prevent unnecessary re-renders
  const handleCountrySelect = useCallback(async (countryId: string) => {
    try {
      const response = await fetch(
        `/api/countries/${encodeURIComponent(countryId)}`
      );
      const feature = await response.json();
      // Both panels open on the left, so only one shows at a time
      setClickedPin(null);
      setSelectedCountry(feature);
    } catch (error) {
      console.error("Error loading country GeoJSON:", error);
    }
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedCountry(null);
  }, []);

  const handlePinClick = useCallback((pin: MapPin) => {
    setSelectedCountry(null);
    setClickedPin(pin);
  }, []);

  const handleClosePin = useCallback(() => {
    setClickedPin(null);
  }, []);

  const handleMeasurementOpen = useCallback(() => {
    setIsMeasurementOpen(true);
  }, []);

  const handleMeasurementClose = useCallback(() => {
    setIsMeasurementOpen(false);
  }, []);

  // Context menu handlers
  const handleAddMarker = useCallback(
    (lat: number, lng: number) => {
      addMarker(lat, lng);
    },
    [addMarker]
  );

  const handleContextMenuMeasurement = useCallback(() => {
    setIsMeasurementOpen(true);
  }, []);

  return (
    <div className="relative h-screen w-full overflow-hidden">
      {/* Map */}
      <LeafletMap className="w-full h-full">
        <LeafletTileLayer
          url={SATELLITE_TILE_PROVIDER.url}
          attribution={SATELLITE_TILE_PROVIDER.attribution}
          maxZoom={SATELLITE_TILE_PROVIDER.maxZoom}
        />
        <LeafletGeoJSON data={selectedCountry} style={GEOJSON_STYLE} />
        <TweetPinLayer pins={pins} onPinClick={handlePinClick} />
      </LeafletMap>

      {/* Search Bar */}
      <MapSearchBar
        onCountrySelect={handleCountrySelect}
        selectedCountry={selectedCountry}
        onClearSelection={handleClearSelection}
        onMeasurementClick={handleMeasurementOpen}
      />

      {/* Top Bar */}
      <MapTopBar onUploaded={refreshPins} />

      {/* Map Controls */}
      <MapControls />

      {/* Country Details Panel */}
      <MapDetailsPanel
        country={selectedCountry}
        onClose={handleClearSelection}
      />

      {/* Tweets behind the clicked pin */}
      <PinTweetsPanel pin={selectedPin} onClose={handleClosePin} />

      {/* Measurement Panel */}
      <MapMeasurementPanel
        isOpen={isMeasurementOpen}
        onClose={handleMeasurementClose}
      />

      {/* Context Menu */}
      <MapContextMenu
        isOpen={isContextMenuOpen}
        position={contextMenuPosition}
        onClose={closeContextMenu}
        onAddMarker={handleAddMarker}
        onStartMeasurement={handleContextMenuMeasurement}
      />
    </div>
  );
}
