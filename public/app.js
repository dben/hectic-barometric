"use strict";

const HOUR = 3600;
const SOURCE_NAMES = { "open-meteo": "Open-Meteo", nws: "NWS" };
const SOURCE_COLOR = { "open-meteo": "--series-1", nws: "--series-2" };
const EVENT_NAMES = { "pre-migraine": "Pre-migraine", migraine: "Migraine" };

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
  forecastDays: 7,
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
let forecast = null; // { ts, series, swings } from /api/forecast, or null
let forecastError = null;
let events = []; // logged migraines in the visible range
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

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${url}: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
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
  bindSeg("forecast", "days", (v) => Number(v) === state.forecastDays, async (v) => {
    state.forecastDays = Number(v);
    forecast = await fetchForecast();
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
  const [series, sw, fc, ev] = await Promise.all([
    getJson(`/api/series?${q}`),
    fetchSwings(from, to),
    fetchForecast(),
    fetchEvents(from),
  ]);
  data = series;
  swings = sw;
  forecast = fc;
  events = ev;
  render();
}

function fetchEvents(from) {
  const q = new URLSearchParams({
    location: state.location,
    from,
    to: Math.floor(Date.now() / 1000) + 3600,
    field: state.field,
  });
  return getJson(`/api/events?${q}`);
}

/** Forecast for the next `state.forecastDays`; never throws, so history still renders without it. */
async function fetchForecast() {
  forecastError = null;
  if (!state.forecastDays || !state.location) return null;
  const q = new URLSearchParams({
    location: state.location,
    field: state.field,
    window: state.windowHours,
    threshold: state.thresholdHpa,
  });
  try {
    const fc = await getJson(`/api/forecast?${q}`);
    const end = Date.now() / 1000 + state.forecastDays * 86400;
    const keep = fc.ts.findLastIndex((t) => t <= end) + 1;
    return {
      ts: fc.ts.slice(0, keep),
      series: Object.fromEntries(Object.entries(fc.series).map(([k, v]) => [k, v.slice(0, keep)])),
      swings: fc.swings.filter((sw) => sw.start < end),
    };
  } catch {
    forecastError = "Forecast unavailable right now";
    return null;
  }
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
  [swings, forecast, events] = await Promise.all([fetchSwings(data.from, data.to), fetchForecast(), fetchEvents(data.from)]);
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
  renderUpcoming();
  renderTiles();
  renderSwingTable();
  renderEvents();
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
    const ahead = source === "open-meteo" && forecast ? forecast.ts.indexOf(t + 24 * HOUR) : -1;
    const next = ahead >= 0 ? forecast.series[fieldKey()][ahead] : null;
    if (next != null) {
      const d = p.conv(next) - p.conv(now);
      const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "";
      tile("Next 24 h", `${arrow} ${d > 0 ? "+" : ""}${fmt(d, p.digits)}`, "Forecast",
        d > 0 ? "rise" : d < 0 ? "fall" : "");
    }
  }
}

function swingChange(s, p) {
  return `${s.direction === "fall" ? "▼" : "▲"} ${s.change > 0 ? "+" : ""}${fmt(p.conv(s.change), p.digits)} ${p.label}`;
}

function renderUpcoming() {
  const section = $("upcoming");
  const list = $("upcoming-list");
  list.innerHTML = "";
  section.hidden = !state.forecastDays;
  if (!state.forecastDays) return;
  const p = units().pressure;
  const rule = `≥ ${fmt(p.conv(state.thresholdHpa), p.digits)} ${p.label} in ${state.windowHours} h`;
  $("upcoming-note").textContent = `next ${state.forecastDays} d · ${rule}`;
  const note = (text) => {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = text;
    list.append(li);
  };
  if (!forecast) return note(forecastError ?? "Loading…");
  if (!forecast.swings.length) return note("None forecast");
  const now = Date.now() / 1000;
  for (const s of forecast.swings) {
    const li = document.createElement("li");
    const change = document.createElement("span");
    change.className = `dir-${s.direction}`;
    change.textContent = swingChange(s, p);
    const hours = Math.round((s.start - now) / HOUR);
    const when = hours <= 0 ? "under way" : hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} d`;
    li.append(change, ` ${fmtTime(s.start)} → ${fmtTime(s.end)} · ${when}`);
    li.addEventListener("click", () => zoomTo(s.start - 12 * HOUR, s.end + 12 * HOUR));
    list.append(li);
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
      swingChange(s, p),
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

// ---------- migraine log ----------

let toastTimer;
function toast(text, undo) {
  const el = $("toast");
  $("toast-text").textContent = text;
  const btn = $("toast-undo");
  btn.hidden = !undo;
  btn.onclick = async () => {
    el.hidden = true;
    await undo();
  };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 8000);
}

async function reloadEvents() {
  if (!data) return;
  events = await fetchEvents(data.from);
  renderEvents();
  for (const c of charts) c.redraw(false);
}

async function logEvent(kind, ts, note) {
  try {
    const ev = await getJson("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: state.location, kind, ts, note }),
    });
    await reloadEvents();
    toast(`${EVENT_NAMES[kind]} logged · ${fmtTime(ev.ts)}`, async () => {
      await getJson(`/api/events/${ev.id}`, { method: "DELETE" });
      await reloadEvents();
    });
  } catch (err) {
    toast(`Couldn't log: ${err.message}`);
  }
}

async function deleteEvent(ev) {
  try {
    await getJson(`/api/events/${ev.id}`, { method: "DELETE" });
    await reloadEvents();
    toast(`${EVENT_NAMES[ev.kind]} deleted`, () => logEvent(ev.kind, ev.ts, ev.note));
  } catch (err) {
    toast(`Couldn't delete: ${err.message}`);
  }
}

/** "YYYY-MM-DDTHH:MM" in the browser's zone, for datetime-local inputs. */
function localInputValue(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function setupLog() {
  for (const btn of document.querySelectorAll(".log-now")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await logEvent(btn.dataset.kind, Math.floor(Date.now() / 1000), null);
      btn.disabled = false;
    });
  }
  const dialog = $("log-dialog");
  const when = $("log-when");
  for (const btn of document.querySelectorAll(".log-more")) {
    btn.addEventListener("click", () => {
      $("log-form").reset();
      dialog.querySelector(`input[value="${btn.dataset.kind}"]`).checked = true;
      const now = new Date();
      when.value = localInputValue(now);
      when.max = localInputValue(now);
      dialog.showModal();
    });
  }
  dialog.addEventListener("close", () => {
    if (dialog.returnValue !== "save") return;
    const kind = dialog.querySelector('input[name="kind"]:checked').value;
    const ts = Math.floor(new Date(when.value).getTime() / 1000);
    logEvent(kind, ts, $("log-note").value);
  });
}

function renderEvents() {
  const p = units().pressure;
  const body = $("event-rows");
  body.innerHTML = "";
  $("event-count").textContent = events.length ? `${events.length} in this range` : "none in this range";
  for (const ev of [...events].reverse()) {
    const tr = document.createElement("tr");
    const cells = [
      fmtTime(ev.ts, state.days > 300),
      EVENT_NAMES[ev.kind],
      ev.pressure == null ? "–" : `${fmt(p.conv(ev.pressure), p.digits)} ${p.label}`,
      ev.change24h == null ? "–" : `${ev.change24h > 0 ? "▲ +" : ev.change24h < 0 ? "▼ " : ""}${fmt(p.conv(ev.change24h), p.digits)}`,
      ev.note ?? "",
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i === 2 || i === 3) td.className = "num";
      if (i === 3 && ev.change24h) td.classList.add(ev.change24h < 0 ? "dir-fall" : "dir-rise");
      if (i === 4) td.className = "note";
      tr.append(td);
    });
    const td = document.createElement("td");
    const del = document.createElement("button");
    del.type = "button";
    del.className = "row-delete";
    del.textContent = "Delete";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteEvent(ev);
    });
    td.append(del);
    tr.append(td);
    tr.addEventListener("click", () => zoomTo(ev.ts - 36 * HOUR, ev.ts + 12 * HOUR));
    body.append(tr);
  }
}

/** uPlot plugin: a vertical line per logged event, solid for migraine, dashed for pre-migraine. */
function eventMarks({ labels }) {
  return {
    hooks: {
      draw: (u) => {
        const { ctx, bbox } = u;
        const dpr = devicePixelRatio;
        ctx.save();
        ctx.beginPath();
        ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
        ctx.clip();
        ctx.strokeStyle = ctx.fillStyle = css("--event");
        ctx.lineWidth = 2 * dpr;
        ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        for (const ev of events) {
          const x = Math.round(u.valToPos(ev.ts, "x", true));
          if (x < bbox.left || x > bbox.left + bbox.width) continue;
          ctx.setLineDash(ev.kind === "migraine" ? [] : [4 * dpr, 3 * dpr]);
          ctx.beginPath();
          ctx.moveTo(x, bbox.top);
          ctx.lineTo(x, bbox.top + bbox.height);
          ctx.stroke();
          if (labels) ctx.fillText(ev.kind === "migraine" ? "M" : "Pre", x + 3 * dpr, bbox.top + 18 * dpr);
        }
        ctx.restore();
      },
    },
  };
}

function zoomTo(min, max) {
  charts[0]?.setScale("x", { min, max });
  document.querySelector(".charts").scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * uPlot plugin: shade the forecast period and, on the pressure chart, swing intervals
 * (labelling the wider ones).
 */
function bands({ showSwings }) {
  return {
    hooks: {
      drawClear: (u) => {
        const { ctx, bbox } = u;
        const p = units().pressure;
        const dpr = devicePixelRatio;
        ctx.save();
        ctx.beginPath();
        ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
        ctx.clip();
        if (forecast?.ts.length) {
          const x0 = u.valToPos(data.ts.at(-1), "x", true);
          ctx.fillStyle = css("--forecast-bg");
          ctx.fillRect(x0, bbox.top, bbox.left + bbox.width - x0, bbox.height);
          ctx.fillStyle = css("--muted");
          ctx.font = `${11 * dpr}px system-ui, sans-serif`;
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.fillText("Forecast", x0 + 4 * dpr, bbox.top + bbox.height - 4 * dpr);
        }
        const all = showSwings ? [...swings, ...(forecast?.swings ?? [])] : [];
        for (const s of all) {
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

/** `cols` is the uPlot data array: [timestamps, ...one array per series]. */
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
  return new uPlot(opts, cols, el);
}

/** "#rrggbb" -> "rgba(r, g, b, a)"; canvas fills can't take color-mix(). */
function withAlpha(hex, a) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
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
  const fc = forecast?.ts.length ? forecast : null;
  const nHist = data.ts.length;
  const nFc = fc ? fc.ts.length : 0;
  const xs = fc ? [...data.ts, ...fc.ts] : data.ts;
  const conv = (fn) => (v) => (v == null ? null : fn(v));
  // History columns run into the forecast period as nulls.
  const col = (source, key, fn) => [
    ...data.series[source][key].map(conv(fn)),
    ...new Array(nFc).fill(null),
  ];
  // The forecast column starts at the last stored Open-Meteo value so the dashed line joins up.
  const fcCol = (key, fn, join = true) => {
    const out = [...new Array(nHist).fill(null), ...fc.series[key].map(conv(fn))];
    if (join) out[nHist - 1] = conv(fn)(data.series["open-meteo"]?.[key]?.[nHist - 1] ?? null);
    return out;
  };
  const fcLine = (digits, unitLabel) => ({
    ...lineSeries("open-meteo", "Forecast", digits, unitLabel),
    dash: [6, 4],
  });
  const withForecast = (series, cols, key, fn, digits, unitLabel) =>
    fc ? [[...series, fcLine(digits, unitLabel)], [...cols, fcCol(key, fn)]] : [series, cols];

  $("pressure-caption").textContent = state.field === "msl" ? "sea level" : "surface";

  const add = (el, height, [series, cols], yAxis, plugins = [bands({ showSwings: false }), eventMarks({ labels: false })]) =>
    charts.push(makeChart(el, height, series, [xs, ...cols], { yAxis, plugins }));

  add(
    $("chart-pressure"),
    300,
    withForecast(
      active.map((s) => lineSeries(s, SOURCE_NAMES[s], u.pressure.digits, u.pressure.label)),
      active.map((s) => col(s, fieldKey(), u.pressure.conv)),
      fieldKey(), u.pressure.conv, u.pressure.digits, u.pressure.label,
    ),
    axis(u.pressure.label, u.pressure.digits),
    [bands({ showSwings: true }), eventMarks({ labels: true })],
  );
  add(
    $("chart-temp"),
    160,
    withForecast(
      active.map((s) => lineSeries(s, SOURCE_NAMES[s], u.temp.digits, u.temp.label)),
      active.map((s) => col(s, "temperature", u.temp.conv)),
      "temperature", u.temp.conv, u.temp.digits, u.temp.label,
    ),
    axis(u.temp.label, 0),
  );
  const bar = (source, label, fill, align) => ({
    ...lineSeries(source, label, u.precip.digits, u.precip.label),
    width: 0,
    fill,
    paths: uPlot.paths.bars({ size: [0.8, 8], align }),
  });
  const precipSeries = active.map((s) =>
    bar(s, SOURCE_NAMES[s], css(SOURCE_COLOR[s]), active.length > 1 ? (s === "nws" ? 1 : -1) : 0));
  const precipCols = active.map((s) => col(s, "precipitation", u.precip.conv));
  if (fc) {
    precipSeries.push(bar("open-meteo", "Forecast", withAlpha(css("--series-1"), 0.45), 0));
    precipCols.push(fcCol("precipitation", u.precip.conv, false));
  }
  add($("chart-precip"), 140, [precipSeries, precipCols], axis(u.precip.label, u.precip.digits));
  add(
    $("chart-prob"),
    120,
    withForecast(
      [lineSeries("open-meteo", "Open-Meteo", 0, "%")],
      [col("open-meteo", "precipProbability", (v) => v)],
      "precipProbability", (v) => v, 0, "%",
    ),
    axis("%", 0),
  );
}

function resizeCharts() {
  for (const c of charts) c.setSize({ width: c.root.parentElement.clientWidth, height: c.height });
}

// ---------- boot ----------

async function main() {
  locations = await getJson("/api/locations");
  setupControls();
  setupLog();
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
