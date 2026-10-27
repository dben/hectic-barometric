export type Source = "open-meteo" | "nws";

export const SOURCES: readonly Source[] = ["open-meteo", "nws"];

/** One hourly reading. Pressures in hPa, temperature in °C, precipitation in mm, probability in %. */
export interface Reading {
  ts: number; // unix seconds, UTC, top of the hour
  surfacePressure: number | null;
  mslPressure: number | null;
  temperature: number | null;
  precipitation: number | null;
  precipProbability: number | null;
}

export interface Location {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  nwsStation?: string;
}
