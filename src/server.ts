import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Collector } from "./collector.js";
import type { Store } from "./db.js";
import { findSwings } from "./swings.js";
import { SOURCES, type Location, type Reading, type Source } from "./types.js";

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

export function createApp(store: Store, locations: Location[], collector: Collector) {
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
