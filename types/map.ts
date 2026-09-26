/**
 * Map-related TypeScript type definitions
 */

import type { Map as LeafletMap } from 'leaflet';

/**
 * Map configuration options
 */
export interface MapConfig {
  defaultCenter: [number, number];
  defaultZoom: number;
  minZoom: number;
  maxZoom: number;
  zoomControl: boolean;
  attributionControl: boolean;
  /** The map can't be panned outside this area: [[south, west], [north, east]] */
  maxBounds: [[number, number], [number, number]];
  /** How firmly the edges of maxBounds hold, 0 (not at all) to 1 (solid) */
  maxBoundsViscosity: number;
}

/**
 * Tile provider configuration
 */
export interface TileProvider {
  id: string;
  name: string;
  url: string;
  attribution: string;
  maxZoom: number;
  category: 'standard' | 'satellite' | 'dark' | 'custom';
}

/**
 * Map context value type
 */
export interface MapContextValue {
  map: LeafletMap | null;
  setMap: (map: LeafletMap | null) => void;
  isReady: boolean;
  error: Error | null;
  isInitializing: boolean;
  setMapError: (error: Error | null) => void;
  startInitializing: () => void;
}

/**
 * Coordinate tuple type
 */
export type Coordinate = [number, number];

/**
 * Bounds type
 */
export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}
