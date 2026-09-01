'use strict';

const { oddsToImpliedProb } = require('./odds');

const LG_AVG_ERA = 4.20;
const LG_AVG_FIP = 4.20;
const LG_AVG_OPS = 0.720;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sigmoid(x)       { return 1 / (1 + Math.exp(-x)); }

/**
 * Fielding Independent Pitching — removes defense from ERA.
 * Formula: (13×HR/9 + 3×BB/9 − 2×K/9) / 9 + 3.10
 * Requires K/9, BB/9, HR/9 and at least 30 IP to be meaningful.
 */
function calcFIP(k9, bb9, hr9, ip) {
  const k  = parseFloat(k9);
  const bb = parseFloat(bb9);
  const hr = parseFloat(hr9);
  const innings = parseFloat(ip);
  if (isNaN(k) || isNaN(bb) || isNaN(hr) || isNaN(innings) || innings < 30) return null;
  return (13 * hr + 3 * bb - 2 * k) / 9 + 3.10;
}

/**
 * Composite SP quality ERA — blends xERA, FIP, and ERA by confidence weight.
 * xERA:  stabilizes fastest (~50 IP), removes defense and batted-ball luck
 * FIP:   stabilizes in ~60 IP, removes defense entirely
 * ERA:   slowest to stabilize, but reflects actual results
 *
 * Also returns a contact quality penalty: high barrel/hard-hit rate bumps
 * the composite ERA upward (pitcher is giving up dangerous contact even if
 * results haven't shown yet).
 *
 * @param {object} pitcherStats — MLB Stats API pitcher stats
 * @param {object|null} sc      — Statcast data for this pitcher
 * @returns {{ composite, fip, xERA, era, contactAdj, source }}
 */
function spQuality(pitcherStats, sc) {
  const era = parseFloat(pitcherStats?.era) || null;
  const fip = calcFIP(pitcherStats?.k9, pitcherStats?.bb9, pitcherStats?.hr9, pitcherStats?.ip);
  const xERA = sc?.xERA ?? null;

  // Contact quality adjustment: barrel% above league avg (8.5%) adds ~0.15 ERA per point
  const LG_BARREL = 0.085;
  const LG_HARDHIT = 0.375;
  const barrelAdj  = sc?.barrelPct  != null ? (sc.barrelPct  - LG_BARREL)  * 3.5 : 0;
  const hardHitAdj = sc?.hardHitPct != null ? (sc.hardHitPct - LG_HARDHIT) * 1.2 : 0;
  const contactAdj = clamp(barrelAdj + hardHitAdj, -0.6, 0.8);

  let composite, source;
  if (xERA != null && fip != null && era != null) {
    composite = 0.45 * xERA + 0.35 * fip + 0.20 * era;
    source    = 'xERA+FIP+ERA';
  } else if (xERA != null && era != null) {
    composite = 0.60 * xERA + 0.40 * era;
    source    = 'xERA+ERA';
  } else if (fip != null && era != null) {
    composite = 0.55 * fip + 0.45 * era;
    source    = 'FIP+ERA';
  } else if (era != null) {
    composite = era;
    source    = 'ERA only';
  } else {
    composite = null;
    source    = 'none';
  }

  const adjusted = composite != null ? composite + contactAdj : null;

  return {
    composite: adjusted, raw: composite,
    fip, xERA, era, contactAdj, source,
    hardHitPct: sc?.hardHitPct ?? null,
    barrelPct:  sc?.barrelPct  ?? null
  };
}

// Standard normal CDF — Abramowitz & Stegun approximation (|error| < 7.5e-8)
function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return z >= 0 ? p : 1 - p;
}

const FATIGUE_SCORE = { low: 0, medium: 1, high: 2, unknown: 0.5 };
const fatigueNum = level => FATIGUE_SCORE[level] ?? 0.5;

/**
 * Expected runs scored by one side.
 * @param {number} ops           — offensive OPS
 * @param {number} spComposite   — opposing SP composite ERA (xERA/FIP/ERA blend)
 * @param {number} teamERA       — opposing overall team pitching ERA
 * @param {number} parkFactor    — run factor (1.0 = neutral)
 */
function expectedRuns(ops, spComposite, teamERA, parkFactor) {
  const offBase = Math.max(0.5, (ops - 0.300) * 10.5);
  const spFact  = clamp(LG_AVG_ERA / (spComposite || LG_AVG_ERA), 0.50, 1.70);
  const penFact = clamp(LG_AVG_ERA / (teamERA     || LG_AVG_ERA), 0.55, 1.65);
  return offBase * (0.65 * spFact + 0.35 * penFact) * (parkFactor || 1.0);
}

/**
 * Compute EV metrics for one side of a bet.
 * @param {number|null} modelProb — our model's probability
 * @param {number|null} bestOdds  — best American odds available
 */
function calcEV(modelProb, bestOdds) {
  if (modelProb == null || bestOdds == null) {
    return { modelProb, impliedProb: null, edge: null, ev: null, kelly: null, bestOdds };
  }
  const impliedProb = oddsToImpliedProb(bestOdds);
  const edge        = modelProb - impliedProb;
  const b           = bestOdds >= 0 ? bestOdds / 100 : 100 / Math.abs(bestOdds);
  const ev          = modelProb * b - (1 - modelProb);
  const kelly       = Math.max(0, Math.min(0.25, (modelProb * b - (1 - modelProb)) / b));
  return { modelProb, impliedProb, edge, ev, kelly, bestOdds };
}

/**
 * Run the full game model for one game from cache.games.
 *
 * @param {object} game        — enriched game object from cache.games
 * @param {object} statcastMap — map of pitcher MLBAM id → Statcast data
 *
 * Returns:
 *   homeWinProb, awayWinProb, homeExpRuns, awayExpRuns, totalExp, ouLine,
 *   overProb, underProb, homeCoversProb, awayCoversProb,
 *   ml:  { home: EVResult, away: EVResult },
 *   ou:  { over: EVResult, under: EVResult },
 *   spQuality: { home: SPQuality, away: SPQuality },
 *   factors: [{ label, dir, magnitude }],
 *   quality: { dot fields }, qualityScore (0–8)
 */
function calcGameModel(game, statcastMap = {}) {
  // ── Record data ──────────────────────────────────────────────────────────────
  const homeRec = game.home.record;
  const awayRec = game.away.record;

  const homeTotal = (homeRec?.wins ?? 0) + (homeRec?.losses ?? 0);
  const awayTotal = (awayRec?.wins ?? 0) + (awayRec?.losses ?? 0);
  const homeWinP  = homeTotal > 0 ? homeRec.wins / homeTotal : null;
  const awayWinP  = awayTotal > 0 ? awayRec.wins / awayTotal : null;

  const homeL10   = homeRec?.last10 || null;
  const awayL10   = awayRec?.last10 || null;
  const homeL10N  = homeL10 ? homeL10.w + homeL10.l : 0;
  const awayL10N  = awayL10 ? awayL10.w + awayL10.l : 0;
  const homeL10P  = homeL10N > 0 ? homeL10.w / homeL10N : null;
  const awayL10P  = awayL10N > 0 ? awayL10.w / awayL10N : null;

  const homeHomeN  = (homeRec?.home?.w ?? 0) + (homeRec?.home?.l ?? 0);
  const awayAwayN  = (awayRec?.away?.w ?? 0) + (awayRec?.away?.l ?? 0);
  const homeHomeP  = homeHomeN > 0 ? (homeRec?.home?.w ?? 0) / homeHomeN : null;
  const awayAwayP  = awayAwayN > 0 ? (awayRec?.away?.w ?? 0) / awayAwayN : null;

  // ── Pitcher data + Statcast quality ──────────────────────────────────────────
  const homeSPId = String(game.home.probablePitcher?.id || '');
  const awaySPId = String(game.away.probablePitcher?.id || '');
  const homeSC   = statcastMap[homeSPId] || null;
  const awaySC   = statcastMap[awaySPId] || null;

  const homeSpQ  = spQuality(game.home.pitcherStats, homeSC);
  const awaySpQ  = spQuality(game.away.pitcherStats, awaySC);

  // Composite ERA (FIP/xERA/ERA blend) — falls back to league avg if no data
  const homeSpERA = homeSpQ.composite ?? null;
  const awaySpERA = awaySpQ.composite ?? null;

  // Raw ERA still used for factor labels so the user sees recognizable numbers
  const homeSpERARaw = homeSpQ.era ?? null;
  const awaySpERARaw = awaySpQ.era ?? null;

  const homeSpK9  = parseFloat(game.home.pitcherStats?.k9) || null;
  const awaySpK9  = parseFloat(game.away.pitcherStats?.k9) || null;

  // ── Team data ────────────────────────────────────────────────────────────────
  const homeOPS    = parseFloat(game.home.teamStats?.hitting?.ops)  || null;
  const awayOPS    = parseFloat(game.away.teamStats?.hitting?.ops)  || null;
  const homeTeamERA = parseFloat(game.home.teamStats?.pitching?.era) || null;
  const awayTeamERA = parseFloat(game.away.teamStats?.pitching?.era) || null;

  const homeFat = fatigueNum(game.home.bullpen?.fatigueLevel);
  const awayFat = fatigueNum(game.away.bullpen?.fatigueLevel);

  // ── Park / weather ───────────────────────────────────────────────────────────
  const parkFactor = game.park?.runFactor ?? 1.0;
  const precipProb = game.weather?.precipProb ?? 0;
  const domeOrRoof = game.weather?.domeOrRoof ?? false;

  // ── Logistic model ───────────────────────────────────────────────────────────
  const factors = [];
  let logit = 0.12; // home field advantage intercept

  // β₁ — Season win% (1.50)
  if (homeWinP != null && awayWinP != null) {
    const diff = homeWinP - awayWinP;
    const c = 1.50 * diff;
    logit += c;
    if (Math.abs(diff) >= 0.03) {
      factors.push({
        label:     `Season ${(homeWinP * 100).toFixed(0)}% vs ${(awayWinP * 100).toFixed(0)}%`,
        dir:       diff > 0 ? 'home' : 'away',
        magnitude: Math.abs(c)
      });
    }
  }

  // β₂ — Recent form L10 (0.60)
  if (homeL10P != null && awayL10P != null) {
    const diff = homeL10P - awayL10P;
    const c = 0.60 * diff;
    logit += c;
    if (Math.abs(diff) >= 0.10) {
      factors.push({
        label:     `L10 ${homeL10?.w}-${homeL10?.l} vs ${awayL10?.w}-${awayL10?.l}`,
        dir:       diff > 0 ? 'home' : 'away',
        magnitude: Math.abs(c)
      });
    }
  }

  // β₃ — Home/away situational splits (0.50)
  if (homeHomeP != null && awayAwayP != null) {
    const diff = homeHomeP - awayAwayP;
    const c = 0.50 * diff;
    logit += c;
    if (Math.abs(diff) >= 0.05) {
      factors.push({
        label:     `Home/road split ${(homeHomeP * 100).toFixed(0)}% vs ${(awayAwayP * 100).toFixed(0)}%`,
        dir:       diff > 0 ? 'home' : 'away',
        magnitude: Math.abs(c)
      });
    }
  }

  // β₄ — SP composite ERA differential (0.18): uses xERA/FIP/ERA blend
  // Higher coefficient than raw ERA because composite is more signal, less noise
  {
    const hComp = homeSpERA ?? LG_AVG_ERA;
    const aComp = awaySpERA ?? LG_AVG_ERA;
    const diff  = aComp - hComp; // positive = away composite ERA worse → favors home
    const c     = 0.18 * diff;
    logit += c;
    if (homeSpERA != null && awaySpERA != null && Math.abs(diff) >= 0.25) {
      // Label shows composite metric for transparency
      const hLabel = homeSpERARaw != null ? homeSpERARaw.toFixed(2) : '—';
      const aLabel = awaySpERARaw != null ? awaySpERARaw.toFixed(2) : '—';
      const srcTag = homeSpQ.source !== 'ERA only' || awaySpQ.source !== 'ERA only'
        ? ` (${homeSpQ.source})` : '';
      factors.push({
        label:     `SP quality ERA ${hLabel} vs ${aLabel}${srcTag}`,
        dir:       diff > 0 ? 'home' : 'away',
        magnitude: Math.abs(c)
      });
    }
  }

  // β₅ — SP K/9 edge (0.06)
  if (homeSpK9 != null && awaySpK9 != null) {
    const diff = homeSpK9 - awaySpK9;
    const c = 0.06 * diff;
    logit += c;
    if (Math.abs(diff) >= 1.0) {
      factors.push({
        label:     `K/9 ${homeSpK9.toFixed(1)} vs ${awaySpK9.toFixed(1)}`,
        dir:       diff > 0 ? 'home' : 'away',
        magnitude: Math.abs(c)
      });
    }
  }

  // β₆ — Team OPS (2.00)
  if (homeOPS != null && awayOPS != null) {
    const diff = homeOPS - awayOPS;
    const c = 2.00 * diff;
    logit += c;
    if (Math.abs(diff) >= 0.015) {
      factors.push({
        label:     `Offense OPS .${Math.round(homeOPS * 1000)} vs .${Math.round(awayOPS * 1000)}`,
        dir:       diff > 0 ? 'home' : 'away',
        magnitude: Math.abs(c)
      });
    }
  }

  // β₇ — Team ERA depth (0.12): awayTeamERA - homeTeamERA
  {
    const hTERA = homeTeamERA ?? LG_AVG_ERA;
    const aTERA = awayTeamERA ?? LG_AVG_ERA;
    const diff = aTERA - hTERA;
    const c = 0.12 * diff;
    logit += c;
    if (homeTeamERA != null && awayTeamERA != null && Math.abs(diff) >= 0.40) {
      factors.push({
        label:     `Team ERA ${homeTeamERA.toFixed(2)} vs ${awayTeamERA.toFixed(2)}`,
        dir:       diff > 0 ? 'home' : 'away',
        magnitude: Math.abs(c)
      });
    }
  }

  // β₈ — Bullpen fatigue (0.20): awayFat - homeFat
  {
    const diff = awayFat - homeFat;
    const c = 0.20 * diff;
    logit += c;
    if (Math.abs(diff) >= 1.0) {
      factors.push({
        label:     `Bullpen fatigue: ${game.home.bullpen?.fatigueLevel || '?'} vs ${game.away.bullpen?.fatigueLevel || '?'}`,
        dir:       diff > 0 ? 'home' : 'away',
        magnitude: Math.abs(c)
      });
    }
  }

  // β₉ — Park amplifier on OPS edge (0.80 × ΔOPS × (parkFactor - 1))
  if (homeOPS != null && awayOPS != null && Math.abs(parkFactor - 1.0) >= 0.02) {
    const opsDiff = homeOPS - awayOPS;
    const c = 0.80 * opsDiff * (parkFactor - 1.0);
    logit += c;
    if (Math.abs(c) >= 0.03) {
      factors.push({
        label:     `${game.park?.label || 'Park'} ${parkFactor}x amplifies edge`,
        dir:       c > 0 ? 'home' : 'away',
        magnitude: Math.abs(c)
      });
    }
  }

  // β₁₀ — Rain chaos (-0.10 × precipProb/100)
  if (!domeOrRoof && precipProb >= 20) {
    const c = -0.10 * (precipProb / 100);
    logit += c;
    if (precipProb >= 30) {
      factors.push({
        label:     `Rain ${precipProb}%`,
        dir:       'chaos',
        magnitude: Math.abs(c)
      });
    }
  }

  // ── Win probabilities ─────────────────────────────────────────────────────────
  const homeWinProb = sigmoid(logit);
  const awayWinProb = 1 - homeWinProb;

  // ── Expected runs ─────────────────────────────────────────────────────────────
  const hOPS   = homeOPS     ?? LG_AVG_OPS;
  const aOPS   = awayOPS     ?? LG_AVG_OPS;
  const hComp  = homeSpERA   ?? LG_AVG_ERA;   // home SP composite ERA (vs away batters)
  const aComp  = awaySpERA   ?? LG_AVG_ERA;   // away SP composite ERA (vs home batters)
  const hTERA  = homeTeamERA ?? LG_AVG_ERA;
  const aTERA  = awayTeamERA ?? LG_AVG_ERA;

  // Home scores against away SP; away scores against home SP
  const homeExpRuns = expectedRuns(hOPS, aComp, aTERA, parkFactor);
  const awayExpRuns = expectedRuns(aOPS, hComp, hTERA, parkFactor);
  const totalExp    = homeExpRuns + awayExpRuns;

  // Run differential: D = homeRuns - awayRuns ~ N(mu, σ²)
  const mu    = homeExpRuns - awayExpRuns;
  const sigma = Math.sqrt(Math.max(totalExp, 1)) * 1.1;

  // P(home wins by 2+) = P(D >= 1.5)
  const homeCoversProb = 1 - normalCDF((1.5 - mu) / sigma);
  // P(away wins by 2+) = P(D <= -1.5)
  const awayCoversProb = normalCDF((-1.5 - mu) / sigma);

  // ── O/U ──────────────────────────────────────────────────────────────────────
  const books   = game.odds?.books ? Object.values(game.odds.books) : [];
  const ouLines = books.map(b => b.total?.line).filter(n => n != null);
  const ouLine  = ouLines.length ? ouLines.reduce((a, b) => a + b, 0) / ouLines.length : null;

  let overProb = null, underProb = null;
  if (ouLine != null) {
    const sigma_total = sigma; // same distribution scale
    overProb  = 1 - normalCDF((ouLine - totalExp) / sigma_total);
    underProb = 1 - overProb;
  }

  // ── Best odds helpers ─────────────────────────────────────────────────────────
  const bestOddsFor = fn => {
    const vals = books.map(fn).filter(n => n != null);
    return vals.length ? Math.max(...vals) : null;
  };

  // ── EV per market ─────────────────────────────────────────────────────────────
  const mlHome  = calcEV(homeWinProb, bestOddsFor(b => b.ml?.home));
  const mlAway  = calcEV(awayWinProb, bestOddsFor(b => b.ml?.away));
  const ouOver  = calcEV(overProb,    bestOddsFor(b => b.total?.overOdds));
  const ouUnder = calcEV(underProb,   bestOddsFor(b => b.total?.underOdds));

  // ── Data quality ──────────────────────────────────────────────────────────────
  const quality = {
    homeRecord:    homeWinP != null,
    awayRecord:    awayWinP != null,
    homeSP:        homeSpQ.era != null,
    awaySP:        awaySpQ.era != null,
    homeStatcast:  homeSC != null,
    awayStatcast:  awaySC != null,
    homeOffense:   homeOPS != null,
    awayOffense:   awayOPS != null,
    odds:          books.length > 0
  };
  const qualityScore = Object.values(quality).filter(Boolean).length;

  // ── Top factors (by magnitude, capped at 4) ──────────────────────────────────
  factors.sort((a, b) => b.magnitude - a.magnitude);

  return {
    homeWinProb,
    awayWinProb,
    homeExpRuns: parseFloat(homeExpRuns.toFixed(2)),
    awayExpRuns: parseFloat(awayExpRuns.toFixed(2)),
    totalExp:    parseFloat(totalExp.toFixed(2)),
    homeCoversProb,
    awayCoversProb,
    ouLine,
    overProb,
    underProb,
    ml: { home: mlHome, away: mlAway },
    ou: { over: ouOver, under: ouUnder },
    spQuality: { home: homeSpQ, away: awaySpQ },
    factors: factors.slice(0, 4),
    quality,
    qualityScore
  };
}

module.exports = { calcGameModel };
