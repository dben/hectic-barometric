"use strict";

const HOUR = 3600;
const SOURCE_NAMES = { "open-meteo": "Open-Meteo", nws: "NWS" };
const SOURCE_COLOR = { "open-meteo": "--series-1", nws: "--series-2" };

const UNITS = {
  metric: {
    pressure: { label: "hPa", conv: (v) => v, back: (v) => v, digits: 1 },
    temp: { label: "°C", conv: (v) => v, digits: 1 },
    precip: { label: "mm", conv: (v) => v, digits: 1 },
  },
  us: {
    pressure: { label: "inHg", conv: (v) => v * 0.0295300, back: (v) => v / 0.0295300, digits: 2 },
    temp: { label: "°F", conv: (v) => v * 9 / 5 + 32, digits: 0 },
    precip: { label: "in", conv: (v) => v / 25.4, digits: 2 },
  },
};

const DEFAULTS = {
  location: null,
  days: 30,
  field: "surface",
  sources: ["open-meteo", "nws"],
  units: "metric",
  windowHours: 12,
  thresholdHpa: 6,
  swingSource: "open-meteo",
};

const $ = (id) => document.getElementById(id);

function loadPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("barometric.prefs") || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}
function savePrefs() {
  try {
    localStorage.setItem("barometric.prefs", JSON.stringify(state));
  } catch {
    /* storage unavailable; prefs just won't persist */
  }
}

const state = loadPrefs();
let locations = [];
let data = null; // { ts, series }
let swings = [];
let charts = [];

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const units = () => UNITS[state.units];
const fieldKey = () => (state.field === "msl" ? "mslPressure" : "surfacePressure");
const currentLocation = () => locations.find((l) => l.id === state.location);

function fmt(v, digits) {
  return v == null || Number.isNaN(v) ? "–" : v.toFixed(digits);
}

function fmtTime(ts, withYear = false) {
  const tz = currentLocation()?.timezone;
  return new Date(ts * 1000).toLocaleString(undefined, {
    timeZone: tz,
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
  });
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// ---------- controls ----------

function bindSeg(id, attr, isOn, onClick) {
  const el = $(id);
  const sync = () => {
    for (const b of el.querySelectorAll("button")) b.setAttribute("aria-pressed", String(isOn(b.dataset[attr])));
  };
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    onClick(b.dataset[attr]);
    sync();
  });
  sync();
}

function setupControls() {
  const sel = $("location");
  sel.innerHTML = "";
  for (const l of locations) sel.add(new Option(l.name, l.id));
  if (!currentLocation()) state.location = locations[0]?.id ?? null;
  sel.value = state.location;
  sel.addEventListener("change", () => {
    state.location = sel.value;
    refresh();
  });

  bindSeg("range", "days", (v) => Number(v) === state.days, (v) => {
    state.days = Number(v);
    refresh();
  });
  bindSeg("field", "field", (v) => v === state.field, (v) => {
    state.field = v;
    refreshSwings();
  });
  bindSeg("sources", "source", (v) => state.sources.includes(v), (v) => {
    state.sources = state.sources.includes(v) ? state.sources.filter((s) => s !== v) : [...state.sources, v];
    render();
  });
  bindSeg("units", "units", (v) => v === state.units, (v) => {
    state.units = v;
    syncSwingInputs();
    render();
  });

  syncSwingInputs();
  let debounce;
  const onSwingInput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const t = Number($("threshold").value);
      const w = Number($("window").value);
      if (t > 0) state.thresholdHpa = units().pressure.back(t);
      if (w >= 1) state.windowHours = Math.round(w);
      refreshSwings();
    }, 300);
  };
  $("threshold").addEventListener("input", onSwingInput);
  $("window").addEventListener("input", onSwingInput);
  $("swing-source").value = state.swingSource;
  $("swing-source").addEventListener("change", (e) => {
    state.swingSource = e.target.value;
    refreshSwings();
  });
}

function syncSwingInputs() {
  const p = units().pressure;
  $("threshold").value = Number(p.conv(state.thresholdHpa).toFixed(p.digits));
  $("threshold").step = state.units === "us" ? "0.01" : "0.5";
  $("threshold-unit").textContent = p.label;
  $("window").value = state.windowHours;
}

// ---------- data ----------

function rangeParams() {
  const to = Math.floor(Date.now() / 1000);
  return { from: to - state.days * 86400, to };
}

async function refresh() {
  if (!state.location) return;
  const { from, to } = rangeParams();
  const q = `location=${encodeURIComponent(state.location)}&from=${from}&to=${to}`;
  const [series, sw] = await Promise.all([getJson(`/api/series?${q}`), fetchSwings(from, to)]);
  data = series;
  swings = sw;
  render();
}

function fetchSwings(from, to) {
  const q = new URLSearchParams({
    location: state.location,
    from,
    to,
    source: state.swingSource,
    field: state.field,
    window: state.windowHours,
    threshold: state.thresholdHpa,
  });
  return getJson(`/api/swings?${q}`);
}

async function refreshSwings() {
  if (!data) return;
  swings = await fetchSwings(data.from, data.to);
  render();
}

async function refreshStatus() {
  try {
    const s = await getJson("/api/status");
    const c = s.collector;
    const parts = [];
    if (c.finishedAt) parts.push(`Updated ${fmtTime(c.finishedAt)}`);
    else if (c.startedAt) parts.push("Collecting…");
    if (c.errors.length) parts.push(`${c.errors.length} source error${c.errors.length > 1 ? "s" : ""}`);
    $("status").textContent = parts.join(" · ");
    $("status").title = c.errors.map((e) => `${e.locationId} ${e.source}: ${e.message}`).join("\n");
  } catch {
    $("status").textContent = "";
  }
}

// ---------- rendering ----------

function render() {
  savePrefs();
  renderTiles();
  renderSwingTable();
  renderCharts();
}

/** Latest value for the active source, plus its change over the last 3 and 24 hours. */
function renderTiles() {
  const el = $("tiles");
  el.innerHTML = "";
  if (!data) return;
  const p = units().pressure;
  for (const source of state.sources) {
    const col = data.series[source]?.[fieldKey()];
    if (!col) continue;
    let i = col.length - 1;
    while (i >= 0 && col[i] == null) i--;
    if (i < 0) continue;
    const now = col[i];
    const t = data.ts[i];
    const at = (hoursAgo) => {
      const j = data.ts.indexOf(t - hoursAgo * HOUR);
      return j >= 0 ? col[j] : null;
    };
    const tile = (k, v, s, cls = "") => {
      const d = document.createElement("div");
      d.className = "tile";
      d.innerHTML = `<div class="k"></div><div class="v ${cls}"></div><div class="s"></div>`;
      d.children[0].textContent = k;
      d.children[1].textContent = v;
      d.children[2].textContent = s;
      el.append(d);
    };
    tile(`${SOURCE_NAMES[source]} now`, `${fmt(p.conv(now), p.digits)} ${p.label}`, fmtTime(t));
    for (const h of [3, 24]) {
      const then = at(h);
      if (then == null) continue;
      const d = p.conv(now) - p.conv(then);
      const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "";
      tile(`${h} h change`, `${arrow} ${d > 0 ? "+" : ""}${fmt(d, p.digits)}`, SOURCE_NAMES[source],
        d > 0 ? "rise" : d < 0 ? "fall" : "");
    }
  }
}

function renderSwingTable() {
  const p = units().pressure;
  const body = $("swing-rows");
  body.innerHTML = "";
  $("swing-count").textContent = swings.length ? `${swings.length} found` : "none in this range";
  for (const s of [...swings].reverse()) {
    const tr = document.createElement("tr");
    const cells = [
      fmtTime(s.start, state.days > 300),
      fmtTime(s.end, state.days > 300),
      String(Math.round((s.end - s.start) / HOUR)),
      `${s.direction === "fall" ? "▼" : "▲"} ${s.change > 0 ? "+" : ""}${fmt(p.conv(s.change), p.digits)} ${p.label}`,
      `${fmt(p.conv(s.maxRate), p.digits)} / ${state.windowHours} h`,
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i >= 2) td.className = "num";
      if (i === 3) td.classList.add(`dir-${s.direction}`);
      tr.append(td);
    });
    tr.addEventListener("click", () => zoomTo(s.start - 12 * HOUR, s.end + 12 * HOUR));
    body.append(tr);
  }
}

function zoomTo(min, max) {
  charts[0]?.setScale("x", { min, max });
  document.querySelector(".charts").scrollIntoView({ behavior: "smooth", block: "start" });
}

/** uPlot plugin: shade swing intervals behind the lines and label the larger ones. */
function swingBands() {
  return {
    hooks: {
      drawClear: (u) => {
        const { ctx, bbox } = u;
        const p = units().pressure;
        ctx.save();
        ctx.beginPath();
        ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
        ctx.clip();
        for (const s of swings) {
          const x0 = u.valToPos(s.start, "x", true);
          const x1 = u.valToPos(s.end, "x", true);
          const w = Math.max(x1 - x0, 2 * devicePixelRatio);
          ctx.fillStyle = css(s.direction === "fall" ? "--band-fall" : "--band-rise");
          ctx.fillRect(x0, bbox.top, w, bbox.height);
          if (w > 44 * devicePixelRatio) {
            ctx.fillStyle = css(s.direction === "fall" ? "--fall" : "--rise");
            ctx.font = `${11 * devicePixelRatio}px system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            const sign = s.change > 0 ? "+" : "";
            ctx.fillText(`${sign}${fmt(p.conv(s.change), p.digits)}`, x0 + w / 2, bbox.top + 4 * devicePixelRatio);
          }
        }
        ctx.restore();
      },
    },
  };
}

function axis(unitLabel, digits) {
  return {
    stroke: css("--muted"),
    grid: { stroke: css("--grid"), width: 1 },
    ticks: { stroke: css("--axis"), width: 1, size: 4 },
    values: (u, splits) => splits.map((v) => v.toFixed(digits)),
    label: unitLabel,
    labelSize: 18,
    labelFont: "12px system-ui, sans-serif",
    font: "11px system-ui, sans-serif",
    size: 56,
    space: 24,
  };
}

function lineSeries(source, label, digits, unitLabel) {
  return {
    label,
    stroke: css(SOURCE_COLOR[source]),
    width: 2,
    spanGaps: false,
    points: { show: false },
    value: (u, v) => (v == null ? "–" : `${v.toFixed(digits)} ${unitLabel}`),
  };
}

let syncing = false;

function makeChart(el, height, series, cols, extra = {}) {
  const tz = currentLocation()?.timezone;
  const opts = {
    width: el.clientWidth,
    height,
    tzDate: tz ? (ts) => uPlot.tzDate(new Date(ts * 1e3), tz) : undefined,
    cursor: {
      sync: { key: "wx", setSeries: false },
      drag: { x: true, y: false },
      points: { size: 8, width: 2 },
    },
    scales: { x: { time: true } },
    legend: { live: true },
    axes: [
      {
        stroke: css("--muted"),
        grid: { stroke: css("--grid"), width: 1 },
        ticks: { stroke: css("--axis"), width: 1, size: 4 },
        font: "11px system-ui, sans-serif",
      },
      extra.yAxis,
    ],
    series: [{ value: (u, ts) => (ts == null ? "–" : fmtTime(ts)) }, ...series],
    hooks: {
      setScale: [
        (u, key) => {
          if (key !== "x" || syncing) return;
          syncing = true;
          const { min, max } = u.scales.x;
          for (const c of charts) if (c !== u) c.setScale("x", { min, max });
          syncing = false;
        },
      ],
    },
    plugins: extra.plugins ?? [],
  };
  if (!tz) delete opts.tzDate;
  return new uPlot(opts, [data.ts, ...cols], el);
}

function renderCharts() {
  for (const c of charts) c.destroy();
  charts = [];
  const empty = $("empty");
  if (!data || data.ts.length === 0) {
    empty.hidden = false;
    empty.textContent =
      "No readings yet. On first start the collector backfills a year of history, which can take a minute. Refresh shortly.";
    return;
  }
  empty.hidden = true;

  const u = units();
  const active = ["open-meteo", "nws"].filter((s) => state.sources.includes(s) && data.series[s]);
  const col = (source, key, conv) => data.series[source][key].map((v) => (v == null ? null : conv(v)));

  $("pressure-caption").textContent = state.field === "msl" ? "sea level" : "surface";

  charts.push(
    makeChart(
      $("chart-pressure"),
      300,
      active.map((s) => lineSeries(s, SOURCE_NAMES[s], u.pressure.digits, u.pressure.label)),
      active.map((s) => col(s, fieldKey(), u.pressure.conv)),
      { yAxis: axis(u.pressure.label, u.pressure.digits), plugins: [swingBands()] },
    ),
  );
  charts.push(
    makeChart(
      $("chart-temp"),
      160,
      active.map((s) => lineSeries(s, SOURCE_NAMES[s], u.temp.digits, u.temp.label)),
      active.map((s) => col(s, "temperature", u.temp.conv)),
      { yAxis: axis(u.temp.label, 0) },
    ),
  );
  charts.push(
    makeChart(
      $("chart-precip"),
      140,
      active.map((s) => ({
        ...lineSeries(s, SOURCE_NAMES[s], u.precip.digits, u.precip.label),
        width: 0,
        fill: css(SOURCE_COLOR[s]),
        paths: uPlot.paths.bars({ size: [0.8, 8], align: active.length > 1 ? (s === "nws" ? 1 : -1) : 0 }),
      })),
      active.map((s) => col(s, "precipitation", u.precip.conv)),
      { yAxis: axis(u.precip.label, u.precip.digits) },
    ),
  );
  charts.push(
    makeChart(
      $("chart-prob"),
      120,
      [lineSeries("open-meteo", "Open-Meteo", 0, "%")],
      [col("open-meteo", "precipProbability", (v) => v)],
      { yAxis: axis("%", 0) },
    ),
  );
}

function resizeCharts() {
  for (const c of charts) c.setSize({ width: c.root.parentElement.clientWidth, height: c.height });
}

// ---------- boot ----------

async function main() {
  locations = await getJson("/api/locations");
  setupControls();
  await Promise.all([refresh(), refreshStatus()]);
  new ResizeObserver(resizeCharts).observe(document.querySelector(".charts"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderCharts);
  // Pick up new hourly readings without a manual reload.
  setInterval(() => {
    refresh();
    refreshStatus();
  }, 10 * 60 * 1000);
}

main().catch((err) => {
  console.error(err);
  $("empty").hidden = false;
  $("empty").textContent = `Couldn't load data: ${err.message}`;
});
