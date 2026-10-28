import { fetchForecast } from "./sources/openmeteo.js";
import type { Location, Reading } from "./types.js";

type Fetcher = (loc: Location, days: number, now: number) => Promise<Reading[]>;

/**
 * Forecasts are only kept in memory. Open-Meteo updates its models every hour or so,
 * so a short cache keeps dashboard refreshes from each costing an API call.
 */
export class ForecastCache {
  private entries = new Map<string, { at: number; rows: Promise<Reading[]> }>();

  constructor(
    private days: number,
    private ttlSec = 30 * 60,
    private fetcher: Fetcher = fetchForecast,
  ) {}

  get(loc: Location, now = Math.floor(Date.now() / 1000)): Promise<Reading[]> {
    const hit = this.entries.get(loc.id);
    if (hit && now - hit.at < this.ttlSec) return hit.rows.then((rows) => rows.filter((r) => r.ts > now));
    const rows = this.fetcher(loc, this.days, now);
    this.entries.set(loc.id, { at: now, rows });
    // Don't cache failures.
    rows.catch(() => {
      if (this.entries.get(loc.id)?.rows === rows) this.entries.delete(loc.id);
    });
    return rows;
  }
}
