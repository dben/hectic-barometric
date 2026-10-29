import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Store } from "../src/db.js";
import { ForecastCache } from "../src/forecast.js";
import { forecastResponse } from "../src/server.js";
import { fetchForecast } from "../src/sources/openmeteo.js";
import type { Reading } from "../src/types.js";

const H = 3600;
const NOW = 1_800_000_000 - (1_800_000_000 % H);
const loc = { id: "home", name: "Home", latitude: 35, longitude: -78 };
const reading = (ts: number, p: number): Reading => ({
  ts, surfacePressure: p, mslPressure: p + 13, temperature: 10, humidity: 50, precipitation: 0, precipProbability: 0,
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("fetchForecast keeps only hours after now, up to the requested days", async () => {
  let asked: URL | undefined;
  globalThis.fetch = (async (input: string | URL) => {
    asked = new URL(String(input));
    const time = Array.from({ length: 24 * 4 }, (_, i) => NOW - 24 * H + i * H);
    const body = { hourly: { time, surface_pressure: time.map(() => 1000), pressure_msl: time.map(() => 1013) } };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  const rows = await fetchForecast(loc, 2, NOW);
  assert.equal(asked?.searchParams.get("forecast_days"), "3");
  assert.equal(rows[0]?.ts, NOW + H);
  assert.equal(rows.at(-1)?.ts, NOW + 48 * H);
});

test("ForecastCache reuses a fetch within the TTL and retries after a failure", async () => {
  let calls = 0;
  let fail = true;
  const cache = new ForecastCache(3, 2 * H, async () => {
    calls++;
    if (fail) throw new Error("boom");
    return [reading(NOW + H, 1000), reading(NOW + 2 * H, 1001)];
  });
  await assert.rejects(cache.get(loc, NOW), /boom/);
  fail = false;
  assert.equal((await cache.get(loc, NOW)).length, 2);
  // An hour later the first hour has passed and drops out, without refetching.
  assert.equal((await cache.get(loc, NOW + H)).length, 1);
  assert.equal(calls, 2);
  await cache.get(loc, NOW + 2 * H);
  assert.equal(calls, 3);
});

test("forecastResponse flags a swing that starts in history and continues into the forecast", () => {
  const store = new Store(":memory:");
  store.upsert("home", "open-meteo", [0, 1, 2, 3].map((i) => reading(NOW - (3 - i) * H, 1010 - i)));
  const future = [1, 2, 3, 4, 5, 6].map((i) => reading(NOW + i * H, 1007 - 2 * i));
  const res = forecastResponse(store, loc, future, "surfacePressure", 6, 6, NOW);
  assert.equal(res.ts.length, 6);
  assert.deepEqual(res.series.surfacePressure, [1005, 1003, 1001, 999, 997, 995]);
  assert.equal(res.swings.length, 1);
  assert.equal(res.swings[0]?.direction, "fall");
  assert.equal(res.swings[0]?.start, NOW - 3 * H);
  assert.equal(res.swings[0]?.end, NOW + 6 * H);
});

test("forecastResponse with no history still works", () => {
  const res = forecastResponse(new Store(":memory:"), loc, [reading(NOW + H, 1000)], "mslPressure", 12, 6, NOW);
  assert.deepEqual(res.series.mslPressure, [1013]);
  assert.deepEqual(res.swings, []);
});
