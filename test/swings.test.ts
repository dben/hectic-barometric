import assert from "node:assert/strict";
import { test } from "node:test";
import { findSwings } from "../src/swings.js";

const H = 3600;
const series = (values: number[]) => ({ ts: values.map((_, i) => i * H), values });

test("flat series has no swings", () => {
  const { ts, values } = series([1013, 1013.2, 1013.1, 1012.9, 1013]);
  assert.deepEqual(findSwings(ts, values, 3, 3), []);
});

test("a steady fall is one swing trimmed to its high and low points", () => {
  const { ts, values } = series([1015, 1016, 1015, 1013, 1011, 1009, 1008, 1008.5, 1009]);
  const swings = findSwings(ts, values, 3, 3);
  assert.equal(swings.length, 1);
  assert.deepEqual(swings[0], { start: 1 * H, end: 6 * H, direction: "fall", change: -8, maxRate: 6 });
});

test("a fall then a rise are separate swings", () => {
  const { ts, values } = series([1010, 1006, 1002, 1002, 1006, 1010]);
  const swings = findSwings(ts, values, 2, 4);
  assert.deepEqual(swings.map((s) => [s.direction, s.start / H, s.end / H, s.change]), [
    ["fall", 0, 2, -8],
    ["rise", 2, 5, 8],
  ]);
});

test("gaps are not bridged", () => {
  const ts = [0, H, 2 * H, 10 * H, 11 * H];
  const values = [1010, 1010, 1010, 1000, 1000];
  assert.deepEqual(findSwings(ts, values, 3, 3), []);
});

test("nulls are skipped", () => {
  const { ts } = series([0, 0, 0, 0]);
  assert.equal(findSwings(ts, [1010, null, null, 1005], 3, 3).length, 1);
});
