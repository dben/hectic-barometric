export type Source = "open-meteo" | "nws";

export const SOURCES: readonly Source[] = ["open-meteo", "nws"];

/** One hourly reading. Pressures in hPa, temperature in °C, precipitation in mm, humidity and probability in %. */
export interface Reading {
  ts: number; // unix seconds, UTC, top of the hour
  surfacePressure: number | null;
  mslPressure: number | null;
  temperature: number | null;
  humidity: number | null;
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

export const EVENT_KINDS = ["pre-migraine", "migraine"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Something the user logged, e.g. the start of a migraine. Not pruned with readings. */
export interface LoggedEvent {
  id: number;
  locationId: string;
  kind: EventKind;
  ts: number; // unix seconds
  note: string | null;
}
