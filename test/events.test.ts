import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Collector } from "../src/collector.js";
import { Store } from "../src/db.js";
import { ForecastCache } from "../src/forecast.js";
import { createApp } from "../src/server.js";

const H = 3600;
const loc = { id: "home", name: "Home", latitude: 35, longitude: -78 };
const store = new Store(":memory:");
const settings = {
  port: 0, dbPath: ":memory:", locationsFile: "", retentionDays: 365, backfillDays: 365, collectMinute: 5,
  forecastDays: 7, nwsUserAgent: "test",
};
const server = createApp(store, [loc], new Collector(store, [loc], settings), new ForecastCache(7));
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (body: unknown) =>
  fetch(`${base}/api/events`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

test("log, list with pressure context, and delete an event", async () => {
  const now = Math.floor(Date.now() / 1000);
  const hour = Math.round((now - 2 * H) / H) * H;
  const r = (ts: number, p: number) => ({
    ts, surfacePressure: p, mslPressure: p + 13, temperature: null, precipitation: null, precipProbability: null,
  });
  store.upsert("home", "open-meteo", [r(hour - 24 * H, 1015), r(hour, 1007)]);

  const created = await post({ location: "home", kind: "migraine", ts: now - 2 * H, note: "  left side  " });
  assert.equal(created.status, 201);
  const event = (await created.json()) as { id: number; note: string };
  assert.equal(event.note, "left side");
  assert.equal((await post({ location: "home", kind: "pre-migraine" })).status, 201);

  const list = (await (await fetch(`${base}/api/events?location=home&from=${now - 86400}&to=${now + 60}`)).json()) as {
    kind: string; pressure: number | null; change24h: number | null;
  }[];
  assert.deepEqual(list.map((e) => e.kind), ["migraine", "pre-migraine"]);
  assert.equal(list[0]?.pressure, 1007);
  assert.equal(list[0]?.change24h, -8);

  assert.equal((await fetch(`${base}/api/events/${event.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await fetch(`${base}/api/events/${event.id}`, { method: "DELETE" })).status, 404);
});

test("rejects bad events", async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await post({ location: "nope", kind: "migraine" })).status, 404);
  assert.equal((await post({ location: "home", kind: "headache" })).status, 400);
  assert.equal((await post({ location: "home", kind: "migraine", ts: now + 86400 })).status, 400);
  assert.equal((await post({ location: "home", kind: "migraine", ts: "soon" })).status, 400);
  assert.equal((await post({ location: "home", kind: "migraine", note: "x".repeat(5000) })).status, 413);
  const bad = await fetch(`${base}/api/events`, { method: "POST", body: "[1]" });
  assert.equal(bad.status, 400);
});
