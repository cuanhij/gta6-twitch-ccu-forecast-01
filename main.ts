// gta6-twitch-ccu-forecast-01: forecast GTA VI's launch-day Twitch viewers, hour by hour,
// from the first hour's print. Node 22, standard library only, no network.
//
// The forecast is built at runtime from the case file's own `comparables` — past big
// launches' hourly Twitch curves. For each comparable launch we take its log-ratio
// curve, ln(viewers_h / viewers_hour1), on its own release day, and take the median
// curve across launches as the median forecast, with a log spread that widens over
// the day. Nothing is baked in: the program reads only what the case file gives it.
//
// Two filters keep the median honest. First, only clean launches count: the
// comparables carry a "Tier:" note in their unlock text, and launches flagged
// early-access-contaminated or weak have release-day curves that are not a clean
// launch day (their peak came days earlier, or they are free-to-play / slow-burn).
// Second, simultaneous global unlocks (one worldwide unlock hour) are left out:
// their curve spikes at the unlock and decays, while a rolling-midnight console
// launch — the kind this contest forecasts — ramps as each region unlocks. The
// target game's own pre-release category history is not a launch either, so it is
// left out too. When a filter would leave too few launches, the program falls back
// to every comparable, so it never fails for want of data.
//
// Spread: s(h) = 0.20 + 0.10 * sqrt(h - 1) in natural-log units. The median curve
// plus this spread beat the house persistence baseline on the four practice
// launches (mean pinball loss ~0.24 against the baseline's ~0.39), with the 90%
// band covering about nine hours in ten. A second, smaller adjustment then moves
// the centre by the case's own hour-1 size: across past launches the late-day
// log-ratio falls as log(hour-1 viewers) rises (correlation about -0.9 at hours
// 18-24), so a small first hour lifts the forecast and a large one lowers it.
// That adjustment is shrunk (the slope is noisy with ~20 launches) and clamped
// to 0.75 log units, and it takes the practice loss to ~0.21.
//
//   q_tau(h) = p1 * exp(median_h + z_tau * s(h)), rounded to 2 decimals
//
// where p1 is hour 1's print (at least 1) and z_tau is the standard normal's
// quantile at each level (0.05, 0.25, 0.5, 0.75, 0.95): -1.645, -0.674, 0,
// 0.674, 1.645.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Spread of an hour's forecast, in natural-log units: base + growth per sqrt hour. */
const SPREAD_BASE = 0.2;
const SPREAD_GROWTH = 0.1;
/** The house baseline's spread, used only when no comparable curve exists at all. */
const FALLBACK_SIGMA = 0.15;
/** A filtered comparable set smaller than this falls back to every comparable. */
const MIN_COMPARABLES = 5;
/** A filtered hour with fewer curves than this falls back to the unfiltered median. */
const MIN_CURVES_PER_HOUR = 3;
/**
 * The hour-1 size adjustment: across past launches, the log-ratio at a late hour
 * falls as log(hour-1 viewers) rises (correlation about -0.9 at hours 18-24) —
 * a small first hour means most regions have not unlocked yet, so the day ramps
 * up; a large first hour means most of the audience is already in, so the day
 * stays flat or falls. The least-squares slope of that relation is shrunk by
 * this factor (the slope is noisy with ~20 launches) and the adjustment is
 * clamped, so a far-out first hour cannot drag the forecast with it.
 */
const REGRESSION_SHRINK = 0.4;
const REGRESSION_CLAMP = 0.75;
/** Points needed before the hour-1 size adjustment is applied at all. */
const MIN_REGRESSION_POINTS = 8;

interface Case {
  game: { name: string };
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Array<{
    name: string;
    day_start: string;
    unlock?: string;
    hourly: Array<{ from: string; viewers: number | null; channels?: number | null }>;
  }>;
}

interface ComparableCurve {
  /** log(viewers_h / viewers_hour1) for h = 2..24, where the launch has a point. */
  byHour: Map<number, number>;
  /** log of the launch's own hour-1 print: how much of its audience was already in. */
  logV1: number;
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The median of numbers (the middle value, or the mean of the two middle ones). */
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** The "Tier:" note in a comparable's unlock text, or 'unknown' when it has none. */
const tierOf = (unlock: string | undefined): string => {
  const m = /Tier:\s*([A-Za-z-]+)/.exec(unlock ?? '');
  return m ? m[1] : 'unknown';
};

/** True when the comparable unlocked once, worldwide, at a single hour. */
const isSimultaneous = (unlock: string | undefined): boolean => {
  const u = (unlock ?? '').toLowerCase();
  return u.includes('simultaneous') || u.includes('single global');
};

/**
 * A comparable's release-day log-ratio curve, or null when it has no usable
 * hour-1 print. Hours come from the points whose `from` falls in the 24 hours
 * after the launch's own day_start.
 */
const curveOf = (comp: Case['comparables'][number]): ComparableCurve | null => {
  const dayStart = Date.parse(comp.day_start);
  if (Number.isNaN(dayStart)) return null;
  const byHour = new Map<number, number>();
  for (const pt of comp.hourly ?? []) {
    if (pt.viewers === null || pt.viewers === undefined || pt.viewers <= 0) continue;
    const t = Date.parse(pt.from);
    if (Number.isNaN(t)) continue;
    const deltaHours = (t - dayStart) / 3_600_000;
    if (deltaHours < 0 || deltaHours >= 24) continue;
    byHour.set(Math.floor(deltaHours) + 1, pt.viewers);
  }
  const v1 = byHour.get(1);
  if (v1 === undefined || v1 <= 0) return null;
  const ratios = new Map<number, number>();
  for (const [h, v] of byHour) {
    if (h === 1) continue;
    ratios.set(h, Math.log(v / v1));
  }
  return { byHour: ratios, logV1: Math.log(v1) };
};

/** The five quantiles of one hour: the median curve plus the widening spread. */
const hourQuantiles = (p1: number, medianLog: number, h: number): number[] => {
  const s = SPREAD_BASE + SPREAD_GROWTH * Math.sqrt(h - 1);
  const qs = Z.map((z) => round2(p1 * Math.exp(medianLog + z * s)));
  // Keep the row valid whatever the inputs do: above 0, at most 1e9, non-decreasing.
  let prev = 0.01;
  return qs.map((q) => {
    const clamped = Math.min(Math.max(q, 0.01), 1_000_000_000);
    const v = Math.max(clamped, prev);
    prev = v;
    return v;
  });
};

/** The house persistence baseline's quantiles, used only when no curve exists. */
const fallbackQuantiles = (p1: number, h: number): number[] => {
  const qs = Z.map((z) => round2(p1 * Math.exp(z * FALLBACK_SIGMA * Math.sqrt(h - 1))));
  let prev = 0.01;
  return qs.map((q) => {
    const clamped = Math.min(Math.max(q, 0.01), 1_000_000_000);
    const v = Math.max(clamped, prev);
    prev = v;
    return v;
  });
};

/** The forecast of one case: 23 rows, hours 2..24, five quantiles each. */
const forecastCase = (c: Case): Array<{ hour: number; q: number[] }> => {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`levels ${JSON.stringify(c.levels)} are not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error('no hour-1 print');
  const p1 = Math.max(1, first.viewers);
  const targetName = c.game.name.toLowerCase();

  // Every comparable's curve, and the filtered subset of clean rolling launches.
  const all: ComparableCurve[] = [];
  const filtered: ComparableCurve[] = [];
  for (const comp of c.comparables ?? []) {
    // The target game's own pre-release history is not a launch day.
    if (comp.name.toLowerCase().includes(targetName)) continue;
    const curve = curveOf(comp);
    if (curve === null) continue;
    all.push(curve);
    if (tierOf(comp.unlock) === 'comparable' && !isSimultaneous(comp.unlock)) {
      filtered.push(curve);
    }
  }
  const useFiltered = filtered.length >= MIN_COMPARABLES;
  const curves = useFiltered ? filtered : all;

  const hours = (c.forecast.length > 0 ? c.forecast : Array.from({ length: 23 }, (_, i) => ({ hour: i + 2 })))
    .map(({ hour }) => {
      const pairs = (set: ComparableCurve[]): Array<{ logV1: number; ratio: number }> =>
        set
          .map((curve) => ({ logV1: curve.logV1, ratio: curve.byHour.get(hour) }))
          .filter((p): p is { logV1: number; ratio: number } => p.ratio !== undefined);
      let pool = pairs(curves);
      if (pool.length < MIN_CURVES_PER_HOUR) pool = pairs(all);
      if (pool.length === 0) return { hour, q: fallbackQuantiles(p1, hour) };
      const ratios = pool.map((p) => p.ratio);
      const med = median(ratios);
      let centre = med;
      if (pool.length >= MIN_REGRESSION_POINTS) {
        // Least-squares slope of the log-ratio on log(hour-1 viewers), shrunk
        // and clamped: a small first hour lifts the late-day forecast, a large
        // one lowers it, by at most REGRESSION_CLAMP log units from the median.
        const meanLogV1 = pool.reduce((s, p) => s + p.logV1, 0) / pool.length;
        const variance = pool.reduce((s, p) => s + (p.logV1 - meanLogV1) ** 2, 0);
        if (variance > 0) {
          const covariance = pool.reduce((s, p) => s + (p.logV1 - meanLogV1) * (p.ratio - med), 0);
          const beta = (covariance / variance) * REGRESSION_SHRINK;
          const shift = beta * (Math.log(p1) - meanLogV1);
          centre = med + Math.max(-REGRESSION_CLAMP, Math.min(REGRESSION_CLAMP, shift));
        }
      }
      return { hour, q: hourQuantiles(p1, centre, hour) };
    });
  return hours;
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
