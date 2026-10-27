import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Collector } from "../src/collector.js";
import type { Settings } from "../src/config.js";
import { Store } from "../src/db.js";
import { alignSeries } from "../src/server.js";

const DAY = 86400;
const NOW = Date.parse("2026-10-26T12:00:00Z") / 1000;
const settings: Settings = {
  port: 0, dbPath: ":memory:", locationsFile: "", retentionDays: 365, backfillDays: 365, collectMinute: 5,
  nwsUserAgent: "test",
};
const loc = { id: "home", name: "Home", latitude: 35, longitude: -78 };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Fake Open-Meteo: hourly rows covering whatever range was asked for. */
function fakeOpenMeteo(calls: URL[]) {
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    let start: number;
    let end: number;
    if (url.hostname.startsWith("archive")) {
      start = Date.parse(url.searchParams.get("start_date")!) / 1000;
      end = Date.parse(url.searchParams.get("end_date")!) / 1000 + DAY - 3600;
    } else {
      const today = Math.floor(NOW / DAY) * DAY;
      start = today - Number(url.searchParams.get("past_days")) * DAY;
      end = today + DAY - 3600;
    }
    const time: number[] = [];
    for (let t = start; t <= end; t += 3600) time.push(t);
    const body = {
      hourly: {
        time,
        surface_pressure: time.map(() => 1000),
        pressure_msl: time.map(() => 1013),
        temperature_2m: time.map(() => 10),
        precipitation: time.map(() => 0),
      },
    };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

test("first run backfills a year from the archive, then fills recent days", async () => {
  const calls: URL[] = [];
  fakeOpenMeteo(calls);
  const store = new Store(":memory:");
  const c = new Collector(store, [loc], settings);
  await c.runOnce(NOW);

  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.hostname.startsWith("archive"));
  assert.equal(calls[1]!.searchParams.get("past_days"), "92");
  assert.equal(c.status.errors.length, 0);
  const [stat] = store.stats();
  assert.equal(stat!.last, NOW);
  assert.ok(stat!.first >= NOW - 365 * DAY);
  assert.ok(stat!.count > 364 * 24);

  // An hour later only a short recent window is requested.
  calls.length = 0;
  await c.runOnce(NOW + 3600);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.searchParams.get("past_days"), "2");
});

test("failures are recorded and don't stop other sources", async () => {
  globalThis.fetch = (async () => new Response("slow down", { status: 429 })) as typeof fetch;
  const store = new Store(":memory:");
  const c = new Collector(store, [{ ...loc, nwsStation: "KRDU" }], settings);
  await c.runOnce(NOW);
  assert.deepEqual(c.status.errors.map((e) => e.source), ["open-meteo", "nws"]);
});

test("upsert keeps stored values when a later response has nulls, and prune drops old rows", () => {
  const store = new Store(":memory:");
  const row = { ts: 100, surfacePressure: 1000, mslPressure: 1013, temperature: 5, precipitation: 0, precipProbability: 20 };
  store.upsert("home", "open-meteo", [row]);
  store.upsert("home", "open-meteo", [{ ...row, surfacePressure: 1001, precipProbability: null }]);
  assert.deepEqual(store.read("home", "open-meteo", 0, 200), [{ ...row, surfacePressure: 1001 }]);
  assert.equal(store.prune(101), 1);
  assert.equal(store.read("home", "open-meteo", 0, 200).length, 0);
});

test("alignSeries merges sources onto shared timestamps", () => {
  const r = (ts: number, p: number) => ({
    ts, surfacePressure: p, mslPressure: null, temperature: null, precipitation: null, precipProbability: null,
  });
  const { ts, series } = alignSeries({ "open-meteo": [r(0, 1), r(3600, 2)], nws: [r(3600, 3), r(7200, 4)] });
  assert.deepEqual(ts, [0, 3600, 7200]);
  assert.deepEqual(series["open-meteo"]!.surfacePressure, [1, 2, null]);
  assert.deepEqual(series.nws!.surfacePressure, [null, 3, 4]);
});
