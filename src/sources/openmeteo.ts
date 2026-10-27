import type { Location, Reading } from "../types.js";
import { getJson } from "./http.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

const FORECAST_VARS = "surface_pressure,pressure_msl,temperature_2m,precipitation,precipitation_probability";
// The archive has no precipitation probability.
const ARCHIVE_VARS = "surface_pressure,pressure_msl,temperature_2m,precipitation";

/** Open-Meteo's forecast endpoint returns at most 92 past days. */
export const MAX_PAST_DAYS = 92;

interface OpenMeteoResponse {
  hourly?: {
    time?: number[];
    surface_pressure?: (number | null)[];
    pressure_msl?: (number | null)[];
    temperature_2m?: (number | null)[];
    precipitation?: (number | null)[];
    precipitation_probability?: (number | null)[];
  };
}

/** Turn an Open-Meteo hourly response (timeformat=unixtime) into readings at or before `now`. */
export function parseOpenMeteo(json: unknown, now: number): Reading[] {
  const h = (json as OpenMeteoResponse).hourly;
  const times = h?.time ?? [];
  const out: Reading[] = [];
  times.forEach((ts, i) => {
    if (ts > now) return;
    const r: Reading = {
      ts,
      surfacePressure: h?.surface_pressure?.[i] ?? null,
      mslPressure: h?.pressure_msl?.[i] ?? null,
      temperature: h?.temperature_2m?.[i] ?? null,
      precipitation: h?.precipitation?.[i] ?? null,
      precipProbability: h?.precipitation_probability?.[i] ?? null,
    };
    if (r.surfacePressure === null && r.mslPressure === null && r.temperature === null) return;
    out.push(r);
  });
  return out;
}

function baseParams(loc: Location, vars: string): URLSearchParams {
  return new URLSearchParams({
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
    hourly: vars,
    timezone: "GMT",
    timeformat: "unixtime",
  });
}

export async function fetchRecent(loc: Location, pastDays: number, now: number): Promise<Reading[]> {
  const params = baseParams(loc, FORECAST_VARS);
  params.set("past_days", String(Math.min(Math.max(pastDays, 1), MAX_PAST_DAYS)));
  params.set("forecast_days", "1");
  return parseOpenMeteo(await getJson(`${FORECAST_URL}?${params}`), now);
}

/** Dates are YYYY-MM-DD (UTC), inclusive. */
export async function fetchArchive(loc: Location, startDate: string, endDate: string, now: number): Promise<Reading[]> {
  const params = baseParams(loc, ARCHIVE_VARS);
  params.set("start_date", startDate);
  params.set("end_date", endDate);
  return parseOpenMeteo(await getJson(`${ARCHIVE_URL}?${params}`), now);
}
