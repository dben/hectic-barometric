import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventKind, LoggedEvent, Reading, Source } from "./types.js";

type Row = Record<string, number | string | null>;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS readings (
        location_id        TEXT    NOT NULL,
        source             TEXT    NOT NULL,
        ts                 INTEGER NOT NULL,
        surface_pressure   REAL,
        msl_pressure       REAL,
        temperature        REAL,
        precipitation      REAL,
        precip_probability REAL,
        PRIMARY KEY (location_id, source, ts)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY,
        location_id TEXT    NOT NULL,
        kind        TEXT    NOT NULL,
        ts          INTEGER NOT NULL,
        note        TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_by_time ON events (location_id, ts);
    `);
  }

  /**
   * Insert or update readings. A null in a new reading never overwrites a stored value,
   * so a later partial response can't erase data from an earlier, fuller one.
   */
  upsert(locationId: string, source: Source, readings: Reading[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO readings (location_id, source, ts, surface_pressure, msl_pressure,
                            temperature, precipitation, precip_probability)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (location_id, source, ts) DO UPDATE SET
        surface_pressure   = COALESCE(excluded.surface_pressure,   readings.surface_pressure),
        msl_pressure       = COALESCE(excluded.msl_pressure,       readings.msl_pressure),
        temperature        = COALESCE(excluded.temperature,        readings.temperature),
        precipitation      = COALESCE(excluded.precipitation,      readings.precipitation),
        precip_probability = COALESCE(excluded.precip_probability, readings.precip_probability)
    `);
    this.db.exec("BEGIN");
    try {
      for (const r of readings) {
        stmt.run(locationId, source, r.ts, r.surfacePressure, r.mslPressure,
          r.temperature, r.precipitation, r.precipProbability);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return readings.length;
  }

  /** Latest stored timestamp that has a pressure value, or null if none. */
  latestTs(locationId: string, source: Source): number | null {
    const row = this.db
      .prepare(`SELECT MAX(ts) AS ts FROM readings
                WHERE location_id = ? AND source = ?
                  AND (surface_pressure IS NOT NULL OR msl_pressure IS NOT NULL)`)
      .get(locationId, source) as Row | undefined;
    return typeof row?.ts === "number" ? row.ts : null;
  }

  read(locationId: string, source: Source, from: number, to: number): Reading[] {
    const rows = this.db
      .prepare(`SELECT ts, surface_pressure, msl_pressure, temperature, precipitation, precip_probability
                FROM readings WHERE location_id = ? AND source = ? AND ts >= ? AND ts <= ?
                ORDER BY ts`)
      .all(locationId, source, from, to) as Row[];
    return rows.map((r) => ({
      ts: r.ts as number,
      surfacePressure: r.surface_pressure as number | null,
      mslPressure: r.msl_pressure as number | null,
      temperature: r.temperature as number | null,
      precipitation: r.precipitation as number | null,
      precipProbability: r.precip_probability as number | null,
    }));
  }

  stats(): { locationId: string; source: string; count: number; first: number; last: number }[] {
    const rows = this.db
      .prepare(`SELECT location_id, source, COUNT(*) AS count, MIN(ts) AS first, MAX(ts) AS last
                FROM readings GROUP BY location_id, source`)
      .all() as Row[];
    return rows.map((r) => ({
      locationId: r.location_id as string,
      source: r.source as string,
      count: r.count as number,
      first: r.first as number,
      last: r.last as number,
    }));
  }

  prune(olderThan: number): number {
    const res = this.db.prepare("DELETE FROM readings WHERE ts < ?").run(olderThan);
    return Number(res.changes);
  }

  addEvent(locationId: string, kind: EventKind, ts: number, note: string | null): LoggedEvent {
    const res = this.db
      .prepare("INSERT INTO events (location_id, kind, ts, note, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(locationId, kind, ts, note, Math.floor(Date.now() / 1000));
    return { id: Number(res.lastInsertRowid), locationId, kind, ts, note };
  }

  events(locationId: string, from: number, to: number): LoggedEvent[] {
    const rows = this.db
      .prepare(`SELECT id, location_id, kind, ts, note FROM events
                WHERE location_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`)
      .all(locationId, from, to) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      locationId: r.location_id as string,
      kind: r.kind as EventKind,
      ts: r.ts as number,
      note: r.note as string | null,
    }));
  }

  deleteEvent(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM events WHERE id = ?").run(id).changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}
