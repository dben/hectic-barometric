import type { Reading } from "../types.js";
import { getJson } from "./http.js";

const BASE_URL = "https://api.weather.gov";
const MAX_PAGES = 20;

interface Quantity {
  value: number | null;
}

interface Observation {
  properties: {
    timestamp: string;
    rawMessage?: string;
    elevation?: Quantity;
    temperature?: Quantity;
    barometricPressure?: Quantity;
    seaLevelPressure?: Quantity;
    precipitationLastHour?: Quantity;
  };
}

interface ObservationPage {
  features?: Observation[];
  pagination?: { next?: string };
}

/**
 * NWS `barometricPressure` is the altimeter setting, which is reduced to sea level.
 * Invert the altimeter formula to get pressure at the station's elevation.
 * Inputs and output in hPa, elevation in metres.
 */
export function stationPressure(altimeterHpa: number, elevationM: number): number {
  const n = 0.190263;
  return Math.pow(Math.pow(altimeterHpa, n) - 8.417286e-5 * elevationM, 1 / n);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Stations report every few minutes. Keep one observation per hour: the one nearest the
 * top of the hour, preferring the routine METAR (it carries sea-level pressure).
 */
export function parseObservations(features: Observation[]): Reading[] {
  const best = new Map<number, { score: number; reading: Reading }>();
  for (const f of features) {
    const p = f.properties;
    const t = Date.parse(p.timestamp) / 1000;
    if (!Number.isFinite(t)) continue;
    const altimeter = p.barometricPressure?.value;
    if (altimeter == null) continue;
    const hour = Math.round(t / 3600) * 3600;
    const score = (p.rawMessage ? 0 : 10_000) + Math.abs(t - hour);
    const prev = best.get(hour);
    if (prev && prev.score <= score) continue;

    const altHpa = altimeter / 100;
    const elevation = p.elevation?.value ?? null;
    const slp = p.seaLevelPressure?.value;
    best.set(hour, {
      score,
      reading: {
        ts: hour,
        surfacePressure: elevation === null ? null : round2(stationPressure(altHpa, elevation)),
        mslPressure: round2(slp != null ? slp / 100 : altHpa),
        temperature: p.temperature?.value ?? null,
        precipitation: p.precipitationLastHour?.value ?? null,
        precipProbability: null,
      },
    });
  }
  return [...best.values()].map((b) => b.reading).sort((a, b) => a.ts - b.ts);
}

/** Observations since `start` (unix seconds). The API keeps about seven days. */
export async function fetchObservations(station: string, start: number, userAgent: string): Promise<Reading[]> {
  const headers = { "User-Agent": userAgent, Accept: "application/geo+json" };
  const params = new URLSearchParams({ start: new Date(start * 1000).toISOString().replace(".000Z", "Z") });
  let url: string | undefined = `${BASE_URL}/stations/${encodeURIComponent(station)}/observations?${params}`;
  const features: Observation[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const json = (await getJson(url, headers)) as ObservationPage;
    const batch = json.features ?? [];
    if (batch.length === 0) break;
    features.push(...batch);
    url = json.pagination?.next;
  }
  return parseObservations(features);
}
