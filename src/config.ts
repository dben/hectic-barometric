import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Location } from "./types.js";

export interface Settings {
  port: number;
  dbPath: string;
  locationsFile: string;
  retentionDays: number;
  backfillDays: number;
  collectMinute: number;
  nwsUserAgent: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

export function loadSettings(): Settings {
  return {
    port: intEnv("PORT", 8080),
    dbPath: process.env.DB_PATH ?? "./data/barometric.db",
    locationsFile: process.env.LOCATIONS_FILE ?? "./config/locations.yaml",
    retentionDays: intEnv("RETENTION_DAYS", 365),
    backfillDays: intEnv("BACKFILL_DAYS", 365),
    collectMinute: intEnv("COLLECT_MINUTE", 5) % 60,
    nwsUserAgent:
      process.env.NWS_USER_AGENT ?? "hectic-barometric (https://github.com/dben/hectic-barometric)",
  };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function parseLocations(text: string): Location[] {
  const doc = parse(text) as { locations?: unknown } | null;
  const list = doc?.locations;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("locations file must contain a non-empty `locations:` list");
  }
  const seen = new Set<string>();
  return list.map((raw: Record<string, unknown>, i) => {
    const where = `locations[${i}]`;
    const id = String(raw.id ?? "");
    if (!ID_PATTERN.test(id)) throw new Error(`${where}.id must be lowercase letters, digits, - or _`);
    if (seen.has(id)) throw new Error(`${where}.id "${id}" is duplicated`);
    seen.add(id);
    const latitude = Number(raw.latitude);
    const longitude = Number(raw.longitude);
    if (!(latitude >= -90 && latitude <= 90)) throw new Error(`${where}.latitude is invalid`);
    if (!(longitude >= -180 && longitude <= 180)) throw new Error(`${where}.longitude is invalid`);
    const loc: Location = { id, name: String(raw.name ?? id), latitude, longitude };
    if (raw.timezone) loc.timezone = String(raw.timezone);
    if (raw.nwsStation) loc.nwsStation = String(raw.nwsStation).toUpperCase();
    return loc;
  });
}

export function loadLocations(path: string): Location[] {
  return parseLocations(readFileSync(path, "utf8"));
}
