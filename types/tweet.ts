/**
 * Tweet type definitions
 */

/**
 * A place mentioned in a tweet - at least one of province, city and
 * closeLocation is set
 */
export interface TweetLocation {
  province: string | null;
  city: string | null;
  /** A specific spot, e.g. a park, building or neighbourhood */
  closeLocation: string | null;
  /** null until the place has been geocoded */
  coordinates: { lat: number; lng: number } | null;
  /**
   * Which part the coordinates belong to - the most specific one that could be
   * found, e.g. "province" when only Alberta could be placed; null with no coordinates
   */
  precision: "place" | "city" | "province" | null;
}

/**
 * A processed tweet as stored in the Floods.FloodTweets MongoDB collection
 */
export interface FloodTweet {
  /**
   * Unique number. Tweets loaded into an empty collection (or by
   * `npm run import:tweets`) use the line in the processed CSV where the tweet
   * starts (the header is line 1); tweets uploaded after that are numbered on
   * from the highest id already there.
   */
  id: number;
  /** Unique across the collection */
  text: string;
  /** Places mentioned, no repeats; empty when none were found */
  locations: TweetLocation[];
  /** Classifier confidence, 0-1 */
  score: number;
  /** From the CSV's time column; null when the cell is empty */
  time: Date | null;
  /**
   * true once every location has been looked up (see lib/geotag.ts); tweets
   * without it are geotagged in the background
   */
  geotagged?: boolean;
}

/**
 * A tweet as sent to the map (time serialised as an ISO string)
 */
export interface PinTweet {
  id: number;
  text: string;
  score: number;
  time: string | null;
}

/**
 * Tweets whose locations resolved to exactly the same coordinates
 */
export interface MapPin {
  /** "lat,lng" */
  id: string;
  lat: number;
  lng: number;
  /** Search text of the place, e.g. "Saddledome, Calgary, Alberta" */
  place: string;
  tweets: PinTweet[];
}
