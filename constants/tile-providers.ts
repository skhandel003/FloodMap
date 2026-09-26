/**
 * Tile provider configuration
 */

import type { TileProvider } from '@/types/map';

/**
 * Esri World Imagery - the only basemap the app uses (no API key required)
 */
export const SATELLITE_TILE_PROVIDER: TileProvider = {
  id: 'satellite',
  name: 'Satellite',
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  // Pin locations come from Nominatim, whose licence requires the OSM credit
  attribution:
    '&copy; <a href="https://www.esri.com/">Esri World Imagery </a> | ' +
    'Places &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 18,
  category: 'satellite',
};
