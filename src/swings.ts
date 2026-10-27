export interface Swing {
  start: number; // unix seconds
  end: number;
  direction: "rise" | "fall";
  change: number; // value at end minus value at start, hPa
  maxRate: number; // largest absolute change seen over one window, hPa
}

/**
 * Find stretches where the value moved by at least `threshold` within `windowHours`.
 * Every point whose value differs from the point `windowHours` earlier by >= threshold
 * marks that window; overlapping windows with the same direction merge into one swing,
 * which is then trimmed to the extremes inside it.
 */
export function findSwings(
  ts: number[],
  values: (number | null)[],
  windowHours: number,
  threshold: number,
): Swing[] {
  const windowSec = Math.round(windowHours * 3600);
  if (windowSec <= 0 || threshold <= 0) return [];
  const byTs = new Map<number, number>();
  ts.forEach((t, i) => {
    const v = values[i];
    if (v != null) byTs.set(t, v);
  });

  const raw: { start: number; end: number; dir: 1 | -1; rate: number }[] = [];
  for (const [t, v] of byTs) {
    const earlier = byTs.get(t - windowSec);
    if (earlier === undefined) continue;
    const delta = v - earlier;
    if (Math.abs(delta) >= threshold) {
      raw.push({ start: t - windowSec, end: t, dir: delta > 0 ? 1 : -1, rate: Math.abs(delta) });
    }
  }
  raw.sort((a, b) => a.start - b.start);

  const merged: typeof raw = [];
  for (const w of raw) {
    const last = merged[merged.length - 1];
    if (last && last.dir === w.dir && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
      last.rate = Math.max(last.rate, w.rate);
    } else {
      merged.push({ ...w });
    }
  }

  const points = [...byTs].sort((a, b) => a[0] - b[0]);
  return merged.map((m) => {
    // Trim to the extremes so the band covers the actual move: for a fall, from the highest
    // point to the lowest point after it; for a rise, the reverse.
    const inside = points.filter(([t]) => t >= m.start && t <= m.end);
    const better = (a: number, b: number) => (m.dir === -1 ? a > b : a < b);
    let first = 0;
    inside.forEach(([, v], i) => { if (better(v, inside[first]![1])) first = i; });
    let last = first;
    for (let i = first; i < inside.length; i++) if (better(inside[last]![1], inside[i]![1])) last = i;
    const [startT, startV] = inside[first]!;
    const [endT, endV] = inside[last]!;
    return {
      start: startT,
      end: endT,
      direction: m.dir === 1 ? "rise" : "fall",
      change: Math.round((endV - startV) * 100) / 100,
      maxRate: Math.round(m.rate * 100) / 100,
    };
  });
}
