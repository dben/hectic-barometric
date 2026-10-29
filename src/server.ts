import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Collector } from "./collector.js";
import type { Store } from "./db.js";
import type { ForecastCache } from "./forecast.js";
import { findSwings } from "./swings.js";
import { EVENT_KINDS, SOURCES, type EventKind, type Location, type LoggedEvent, type Reading, type Source } from "./types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_DIR = join(ROOT, "public");
const VENDOR = new Map([
  ["/vendor/uPlot.iife.min.js", join(ROOT, "node_modules/uplot/dist/uPlot.iife.min.js")],
  ["/vendor/uPlot.min.css", join(ROOT, "node_modules/uplot/dist/uPlot.min.css")],
]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const FIELDS = ["surfacePressure", "mslPressure", "temperature", "precipitation", "precipProbability"] as const;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function sendFile(res: ServerResponse, path: string): Promise<void> {
  const body = await readFile(path).catch(() => null);
  if (!body) throw new HttpError(404, "not found");
  res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
  res.end(body);
}

async function readJson(req: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new HttpError(413, "body too large");
  }
  try {
    const parsed: unknown = JSON.parse(body || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "body must be a JSON object");
}

/** Validate the optional event fields in a request body. Absent fields stay undefined. */
function eventFields(body: Record<string, unknown>): { kind?: EventKind; ts?: number; note?: string | null } {
  const out: { kind?: EventKind; ts?: number; note?: string | null } = {};
  if (body.kind !== undefined) {
    const kind = String(body.kind) as EventKind;
    if (!EVENT_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${EVENT_KINDS.join(", ")}`);
    out.kind = kind;
  }
  if (body.ts !== undefined && body.ts !== null) {
    const ts = Number(body.ts);
    if (!Number.isInteger(ts) || ts < 0) throw new HttpError(400, "ts must be unix seconds");
    if (ts > Math.floor(Date.now() / 1000) + 3600) throw new HttpError(400, "ts can't be in the future");
    out.ts = ts;
  }
  if (body.note !== undefined) {
    out.note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  }
  return out;
}

function num(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
  return n;
}

/** Merge each source's readings onto one shared, sorted list of timestamps. */
export function alignSeries(bySource: Partial<Record<Source, Reading[]>>) {
  const tsSet = new Set<number>();
  for (const rows of Object.values(bySource)) for (const r of rows) tsSet.add(r.ts);
  const ts = [...tsSet].sort((a, b) => a - b);
  const index = new Map(ts.map((t, i) => [t, i]));
  const series: Record<string, Record<string, (number | null)[]>> = {};
  for (const [source, rows] of Object.entries(bySource)) {
    const cols = Object.fromEntries(FIELDS.map((f) => [f, new Array<number | null>(ts.length).fill(null)]));
    for (const r of rows) {
      const i = index.get(r.ts)!;
      for (const f of FIELDS) cols[f]![i] = r[f];
    }
    series[source] = cols;
  }
  return { ts, series };
}

/**
 * Forecast hours plus the swings expected in them. Detection also looks back over the last
 * window of stored Open-Meteo history, so a swing already under way shows up as upcoming.
 */
export function forecastResponse(
  store: Store,
  loc: Location,
  rows: Reading[],
  field: "surfacePressure" | "mslPressure",
  windowHours: number,
  threshold: number,
  now = Math.floor(Date.now() / 1000),
) {
  const history = store.read(loc.id, "open-meteo", now - Math.ceil(windowHours + 1) * 3600, now);
  const lastHistory = history.at(-1)?.ts ?? now;
  const future = rows.filter((r) => r.ts > lastHistory);
  const all = [...history, ...future];
  const swings = findSwings(all.map((r) => r.ts), all.map((r) => r[field]), windowHours, threshold)
    .filter((s) => s.end > lastHistory);
  const series = Object.fromEntries(FIELDS.map((f) => [f, future.map((r) => r[f])]));
  return { ts: future.map((r) => r.ts), series, swings };
}

/** Each event with the Open-Meteo pressure at that hour and its change over the 24 h before. */
export function eventsWithPressure(
  store: Store,
  locationId: string,
  events: LoggedEvent[],
  field: "surfacePressure" | "mslPressure",
) {
  return events.map((e) => {
    const hour = Math.round(e.ts / 3600) * 3600;
    const rows = store.read(locationId, "open-meteo", hour - 86_400, hour);
    const at = (t: number) => rows.find((r) => r.ts === t)?.[field] ?? null;
    const pressure = at(hour);
    const before = at(hour - 86_400);
    const change24h = pressure !== null && before !== null ? Math.round((pressure - before) * 100) / 100 : null;
    return { id: e.id, kind: e.kind, ts: e.ts, note: e.note, pressure, change24h };
  });
}

export function createApp(store: Store, locations: Location[], collector: Collector, forecasts: ForecastCache) {
  const byId = new Map(locations.map((l) => [l.id, l]));

  function range(params: URLSearchParams): [number, number] {
    const now = Math.floor(Date.now() / 1000);
    const to = num(params, "to", now);
    const from = num(params, "from", to - 30 * 86_400);
    if (from > to) throw new HttpError(400, "from must be before to");
    return [from, to];
  }

  function location(params: URLSearchParams): Location {
    const loc = byId.get(params.get("location") ?? "");
    if (!loc) throw new HttpError(404, "unknown location");
    return loc;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.searchParams;

    if (url.pathname === "/api/events" && req.method === "POST") {
      const body = await readJson(req);
      const loc = byId.get(String(body.location ?? ""));
      if (!loc) throw new HttpError(404, "unknown location");
      const fields = eventFields(body);
      if (!fields.kind) throw new HttpError(400, `kind must be one of ${EVENT_KINDS.join(", ")}`);
      const ts = fields.ts ?? Math.floor(Date.now() / 1000);
      return sendJson(res, 201, store.addEvent(loc.id, fields.kind, ts, fields.note ?? null));
    }
    const eventId = /^\/api\/events\/(\d+)$/.exec(url.pathname)?.[1];
    if (eventId && req.method === "PATCH") {
      const updated = store.updateEvent(Number(eventId), eventFields(await readJson(req)));
      if (!updated) throw new HttpError(404, "no such event");
      return sendJson(res, 200, updated);
    }
    if (eventId && req.method === "DELETE") {
      if (!store.deleteEvent(Number(eventId))) throw new HttpError(404, "no such event");
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");

    switch (url.pathname) {
      case "/healthz":
        return sendJson(res, 200, { ok: true });
      case "/api/locations":
        return sendJson(res, 200, locations);
      case "/api/status":
        return sendJson(res, 200, { collector: collector.status, stored: store.stats() });
      case "/api/series": {
        const loc = location(p);
        const [from, to] = range(p);
        const bySource: Partial<Record<Source, Reading[]>> = {};
        for (const s of SOURCES) bySource[s] = store.read(loc.id, s, from, to);
        return sendJson(res, 200, { location: loc.id, from, to, ...alignSeries(bySource) });
      }
      case "/api/swings": {
        const loc = location(p);
        const [from, to] = range(p);
        const source = (p.get("source") ?? "open-meteo") as Source;
        if (!SOURCES.includes(source)) throw new HttpError(400, "unknown source");
        const field = p.get("field") === "msl" ? "mslPressure" : "surfacePressure";
        const rows = store.read(loc.id, source, from, to);
        const swings = findSwings(
          rows.map((r) => r.ts),
          rows.map((r) => r[field]),
          num(p, "window", 12),
          num(p, "threshold", 6),
        );
        return sendJson(res, 200, swings);
      }
      case "/api/events": {
        const loc = location(p);
        const [from, to] = range(p);
        const field = p.get("field") === "msl" ? "mslPressure" : "surfacePressure";
        return sendJson(res, 200, eventsWithPressure(store, loc.id, store.events(loc.id, from, to), field));
      }
      case "/api/forecast": {
        const loc = location(p);
        const field = p.get("field") === "msl" ? "mslPressure" : "surfacePressure";
        let rows: Reading[];
        try {
          rows = await forecasts.get(loc);
        } catch (err) {
          throw new HttpError(502, `forecast unavailable: ${err instanceof Error ? err.message : err}`);
        }
        return sendJson(res, 200, forecastResponse(store, loc, rows, field, num(p, "window", 12), num(p, "threshold", 6)));
      }
    }

    const vendor = VENDOR.get(url.pathname);
    if (vendor) return sendFile(res, vendor);
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const path = normalize(join(PUBLIC_DIR, rel));
    if (!path.startsWith(PUBLIC_DIR)) throw new HttpError(404, "not found");
    return sendFile(res, path);
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: err instanceof Error ? err.message : "error" });
    });
  });
}
