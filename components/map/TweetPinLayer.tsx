"use client";

import { useEffect, useRef } from "react";
import type { LayerGroup } from "leaflet";
import { useLeafletMap } from "@/hooks/useLeafletMap";
import type { MapPin } from "@/types/tweet";

interface TweetPinLayerProps {
  pins: MapPin[];
  onPinClick: (pin: MapPin) => void;
}

const PIN_COLOR = "#e11d48";
const PIN_SIZE = 32;

/**
 * Teardrop marker showing how many tweets the pin holds (a dot for just one)
 */
function pinHtml(count: number): string {
  const label =
    count > 1
      ? `<span style="font: 600 ${count >= 100 ? 10 : 12}px/1 system-ui, sans-serif; color: white;">${count}</span>`
      : `<span style="width: 8px; height: 8px; border-radius: 50%; background: white;"></span>`;

  return `
    <div style="
      width: ${PIN_SIZE}px;
      height: ${PIN_SIZE}px;
      background: ${PIN_COLOR};
      border: 2px solid white;
      border-radius: 50% 50% 50% 0;
      transform: rotate(-45deg);
      box-shadow: 0 3px 8px rgba(0,0,0,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
    ">
      <div style="transform: rotate(45deg); display: flex;">${label}</div>
    </div>
  `;
}

/**
 * TweetPinLayer - Draws one marker per pin and reports which one was clicked
 *
 * Renders nothing itself - markers live in a Leaflet layer group that is rebuilt
 * whenever the pins change. The map zooms to fit the pins the first time they load.
 */
export function TweetPinLayer({ pins, onPinClick }: TweetPinLayerProps) {
  const map = useLeafletMap();
  const hasFittedRef = useRef(false);

  useEffect(() => {
    if (!map || pins.length === 0) return;

    let isMounted = true;
    let layer: LayerGroup | null = null;

    const drawPins = async () => {
      // Dynamically import Leaflet to avoid SSR issues
      const L = await import("leaflet");
      if (!isMounted) return;

      layer = L.layerGroup(
        pins.map((pin) =>
          L.marker([pin.lat, pin.lng], {
            icon: L.divIcon({
              className: "tweet-pin",
              html: pinHtml(pin.tweets.length),
              iconSize: [PIN_SIZE, PIN_SIZE],
              iconAnchor: [PIN_SIZE / 2, PIN_SIZE],
            }),
            title: pin.place,
            riseOnHover: true,
            // Busier pins draw on top of quieter ones (Leaflet otherwise stacks by
            // latitude, which buries numbered pins under nearby single ones)
            zIndexOffset: pin.tweets.length * 1000,
          }).on("click", () => onPinClick(pin))
        )
      ).addTo(map);

      if (!hasFittedRef.current) {
        hasFittedRef.current = true;
        map.fitBounds(
          L.latLngBounds(pins.map((pin) => [pin.lat, pin.lng])),
          { padding: [80, 80], maxZoom: 12 }
        );
      }
    };

    drawPins();

    return () => {
      isMounted = false;
      layer?.remove();
    };
  }, [map, pins, onPinClick]);

  // This component doesn't render anything visible
  return null;
}
