"use client";

import { useEffect, useRef } from "react";
import type { LayerGroup } from "leaflet";
import Supercluster from "supercluster";
import { useLeafletMap } from "@/hooks/useLeafletMap";
import type { MapPin } from "@/types/tweet";

interface TweetPinLayerProps {
  pins: MapPin[];
  onPinClick: (pin: MapPin) => void;
}

const PIN_COLOR = "#e11d48";
const PIN_SIZE = 32;
// Pins closer than this many screen pixels merge into a cluster
const CLUSTER_RADIUS_PX = 60;
// From this zoom level on, every pin shows on its own
const CLUSTER_MAX_ZOOM = 16;

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
 * Round bubble for a group of nearby pins, sized by its tweet count
 */
function clusterSize(count: number): number {
  return count >= 100 ? 52 : count >= 10 ? 44 : 38;
}

function clusterHtml(count: number): string {
  const size = clusterSize(count);
  return `
    <div style="
      width: ${size}px;
      height: ${size}px;
      background: ${PIN_COLOR};
      border: 3px solid rgba(255,255,255,0.85);
      border-radius: 50%;
      box-shadow: 0 0 0 5px rgba(225,29,72,0.35), 0 3px 8px rgba(0,0,0,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      font: 700 ${count >= 100 ? 13 : 14}px/1 system-ui, sans-serif;
      color: white;
    ">${count}</div>
  `;
}

/**
 * TweetPinLayer - Draws the tweet pins, merging nearby ones into numbered
 * clusters when zoomed out
 *
 * - A cluster shows how many different tweets its pins hold; clicking it zooms in
 *   until it splits apart
 * - A single pin shows its own tweet count; clicking it reports the pin
 * - Clusters are recalculated whenever the map stops moving or zooming
 * - The map zooms to fit the pins the first time they load
 *
 * Renders nothing itself - markers live in a Leaflet layer group.
 */
export function TweetPinLayer({ pins, onPinClick }: TweetPinLayerProps) {
  const map = useLeafletMap();
  const hasFittedRef = useRef(false);

  useEffect(() => {
    if (!map || pins.length === 0) return;

    let isMounted = true;
    let layer: LayerGroup | null = null;
    let redraw: (() => void) | null = null;

    const setupPins = async () => {
      // Dynamically import Leaflet to avoid SSR issues
      const L = await import("leaflet");
      if (!isMounted) return;

      const pinsById = new Map(pins.map((pin) => [pin.id, pin]));
      const index = new Supercluster<{ pinId: string }>({
        radius: CLUSTER_RADIUS_PX,
        maxZoom: CLUSTER_MAX_ZOOM,
      }).load(
        pins.map((pin) => ({
          type: "Feature",
          properties: { pinId: pin.id },
          geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
        }))
      );

      const pinLayer = L.layerGroup().addTo(map);
      layer = pinLayer;

      redraw = () => {
        const bounds = map.getBounds();
        const features = index.getClusters(
          [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
          Math.round(map.getZoom())
        );

        pinLayer.clearLayers();
        for (const feature of features) {
          const [lng, lat] = feature.geometry.coordinates;

          if ("cluster_id" in feature.properties) {
            const clusterId = feature.properties.cluster_id;
            // A tweet naming two places in the cluster counts once
            const tweetIds = new Set(
              index
                .getLeaves(clusterId, Infinity)
                .flatMap((leaf) => pinsById.get(leaf.properties.pinId)?.tweets ?? [])
                .map((tweet) => tweet.id)
            );
            const size = clusterSize(tweetIds.size);

            L.marker([lat, lng], {
              icon: L.divIcon({
                className: "tweet-cluster",
                html: clusterHtml(tweetIds.size),
                iconSize: [size, size],
                iconAnchor: [size / 2, size / 2],
              }),
              title: `${tweetIds.size} tweets - click to zoom in`,
              zIndexOffset: tweetIds.size * 1000,
            })
              .on("click", () => {
                map.flyTo([lat, lng], index.getClusterExpansionZoom(clusterId));
              })
              .addTo(pinLayer);
            continue;
          }

          const pin = pinsById.get(feature.properties.pinId);
          if (!pin) continue;

          L.marker([lat, lng], {
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
          })
            .on("click", () => onPinClick(pin))
            .addTo(pinLayer);
        }
      };

      if (!hasFittedRef.current) {
        hasFittedRef.current = true;
        map.fitBounds(
          L.latLngBounds(pins.map((pin) => [pin.lat, pin.lng])),
          { padding: [80, 80], maxZoom: 12 }
        );
      }

      redraw();
      map.on("moveend", redraw);
    };

    setupPins();

    return () => {
      isMounted = false;
      if (redraw) map.off("moveend", redraw);
      layer?.remove();
    };
  }, [map, pins, onPinClick]);

  // This component doesn't render anything visible
  return null;
}
