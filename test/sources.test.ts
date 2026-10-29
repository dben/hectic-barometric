import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLocations } from "../src/config.js";
import { parseObservations, stationPressure } from "../src/sources/nws.js";
import { parseOpenMeteo } from "../src/sources/openmeteo.js";

test("parseOpenMeteo drops future hours and empty rows", () => {
  const json = {
    hourly: {
      time: [0, 3600, 7200, 10800],
      surface_pressure: [1000, null, 1001, 1002],
      pressure_msl: [1013, null, 1014, 1015],
      temperature_2m: [10, null, 11, 12],
      relative_humidity_2m: [80, null, 75, 70],
      precipitation: [0, null, 0.4, 0],
      precipitation_probability: [5, null, 40, 10],
    },
  };
  const rows = parseOpenMeteo(json, (ts) => ts <= 7200);
  assert.deepEqual(rows.map((r) => r.ts), [0, 7200]);
  assert.deepEqual(rows[1], {
    ts: 7200, surfacePressure: 1001, mslPressure: 1014, temperature: 11, humidity: 75, precipitation: 0.4, precipProbability: 40,
  });
});

test("parseOpenMeteo tolerates a missing variable (archive has no probability)", () => {
  const rows = parseOpenMeteo({ hourly: { time: [0], surface_pressure: [990], pressure_msl: [1010] } }, () => true);
  assert.equal(rows[0]?.precipProbability, null);
});

test("stationPressure inverts the altimeter setting", () => {
  // KRDU, 133 m: altimeter 30.39 inHg (1029.1 hPa) is about 1013.3 hPa at the station
  assert.ok(Math.abs(stationPressure(1029.1, 133) - 1013.3) < 0.3);
  assert.ok(Math.abs(stationPressure(1013.25, 0) - 1013.25) < 0.01);
});

const obs = (timestamp: string, altPa: number | null, extra: Record<string, unknown> = {}) => ({
  properties: {
    timestamp,
    elevation: { value: 133 },
    barometricPressure: { value: altPa },
    seaLevelPressure: { value: null },
    temperature: { value: 6 },
    relativeHumidity: { value: 81.234 },
    ...extra,
  },
});

test("parseObservations keeps one reading per hour, preferring the METAR", () => {
  const rows = parseObservations([
    obs("2026-10-26T09:55:00+00:00", 102946),
    obs("2026-10-26T09:51:00+00:00", 102910, { rawMessage: "KRDU 260951Z ...", seaLevelPressure: { value: 102920 } }),
    obs("2026-10-26T10:10:00+00:00", 102912),
    obs("2026-10-26T08:30:00+00:00", null),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.ts, Date.parse("2026-10-26T10:00:00Z") / 1000);
  assert.equal(rows[0]?.mslPressure, 1029.2);
  assert.equal(rows[0]?.humidity, 81.2);
  assert.ok(rows[0]!.surfacePressure! > 1012 && rows[0]!.surfacePressure! < 1014);
});

test("parseLocations validates entries", () => {
  const locs = parseLocations("locations:\n  - id: home\n    name: Home\n    latitude: 35\n    longitude: -78\n    nwsStation: krdu\n");
  assert.deepEqual(locs, [{ id: "home", name: "Home", latitude: 35, longitude: -78, nwsStation: "KRDU" }]);
  assert.throws(() => parseLocations("locations: []"), /non-empty/);
  assert.throws(() => parseLocations("locations:\n  - id: Bad Id\n    latitude: 1\n    longitude: 1\n"), /id/);
  assert.throws(() => parseLocations("locations:\n  - id: a\n    latitude: 100\n    longitude: 1\n"), /latitude/);
});
