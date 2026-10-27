import type { Settings } from "./config.js";
import type { Store } from "./db.js";
import * as nws from "./sources/nws.js";
import * as openMeteo from "./sources/openmeteo.js";
import type { Location } from "./types.js";

const DAY = 86_400;
const HOUR = 3_600;
// Open-Meteo's archive lags real time by a few days; the forecast endpoint's past_days covers the rest.
const ARCHIVE_LAG_DAYS = 5;
const NWS_HISTORY_DAYS = 7;

const isoDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

export interface RunStatus {
  startedAt: number | null;
  finishedAt: number | null;
  errors: { locationId: string; source: string; message: string; at: number }[];
}

export class Collector {
  readonly status: RunStatus = { startedAt: null, finishedAt: null, errors: [] };
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private store: Store,
    private locations: Location[],
    private settings: Settings,
  ) {}

  /** Fetch whatever each location is missing, from the last stored hour (or the backfill start) to now. */
  async syncOpenMeteo(loc: Location, now: number): Promise<number> {
    const floor = now - this.settings.backfillDays * DAY;
    const since = Math.max(this.store.latestTs(loc.id, "open-meteo") ?? floor, floor);
    let saved = 0;
    const archiveEnd = now - ARCHIVE_LAG_DAYS * DAY;
    if (now - since > (openMeteo.MAX_PAST_DAYS - 1) * DAY && since < archiveEnd) {
      const rows = await openMeteo.fetchArchive(loc, isoDate(since), isoDate(archiveEnd), now);
      saved += this.store.upsert(loc.id, "open-meteo", rows);
    }
    const pastDays = Math.ceil((now - since) / DAY) + 1;
    const rows = await openMeteo.fetchRecent(loc, pastDays, now);
    saved += this.store.upsert(loc.id, "open-meteo", rows.filter((r) => r.ts >= floor));
    return saved;
  }

  async syncNws(loc: Location, now: number): Promise<number> {
    if (!loc.nwsStation) return 0;
    const floor = now - NWS_HISTORY_DAYS * DAY;
    // Re-read the last couple of hours: late observations and corrections arrive after the fact.
    const latest = this.store.latestTs(loc.id, "nws");
    const since = Math.max(latest === null ? floor : latest - 2 * HOUR, floor);
    const rows = await nws.fetchObservations(loc.nwsStation, since, this.settings.nwsUserAgent);
    return this.store.upsert(loc.id, "nws", rows);
  }

  async runOnce(now = Math.floor(Date.now() / 1000)): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.status.startedAt = now;
    this.status.errors = [];
    try {
      for (const loc of this.locations) {
        const jobs = [
          ["open-meteo", () => this.syncOpenMeteo(loc, now)],
          ["nws", () => this.syncNws(loc, now)],
        ] as const;
        for (const [source, job] of jobs) {
          try {
            const n = await job();
            if (n > 0) console.log(`[collect] ${loc.id} ${source}: saved ${n} rows`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[collect] ${loc.id} ${source}: ${message}`);
            this.status.errors.push({ locationId: loc.id, source, message, at: now });
          }
        }
      }
      const pruned = this.store.prune(now - this.settings.retentionDays * DAY);
      if (pruned > 0) console.log(`[collect] pruned ${pruned} rows older than ${this.settings.retentionDays} days`);
    } finally {
      this.status.finishedAt = Math.floor(Date.now() / 1000);
      this.running = false;
    }
  }

  /** Run now, then every hour at `collectMinute` past. */
  start(): void {
    void this.runOnce();
    const scheduleNext = () => {
      const nowMs = Date.now();
      const next = new Date(nowMs);
      next.setUTCMinutes(this.settings.collectMinute, 0, 0);
      if (next.getTime() <= nowMs) next.setUTCHours(next.getUTCHours() + 1);
      this.timer = setTimeout(async () => {
        await this.runOnce();
        scheduleNext();
      }, next.getTime() - nowMs);
    };
    scheduleNext();
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}
