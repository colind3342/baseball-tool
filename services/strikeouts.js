'use strict';

const { oddsToImpliedProb } = require('./odds');

// ── Utilities ─────────────────────────────────────────────────────────────────
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

// ── Poisson Distribution ──────────────────────────────────────────────────────
function poissonLogPMF(k, lambda) {
  if (lambda <= 0 || k < 0) return -Infinity;
  let logP = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return logP;
}

function poissonPMF(k, lambda) {
  return Math.exp(poissonLogPMF(k, lambda));
}

function poissonCDF(lambda, maxK) {
  let total = 0;
  for (let k = 0; k <= maxK; k++) total += poissonPMF(k, lambda);
  return Math.min(1, total); // floating-point guard
}

/**
 * P(K props Over) = P(X >= threshold).
 * Handles half-integer lines (5.5 → threshold 6) and integer lines (5 → threshold 6).
 */
function poissonOverProb(lambda, line) {
  if (!lambda || lambda <= 0) return null;
  const threshold = line % 1 === 0 ? Math.floor(line) + 1 : Math.ceil(line);
  return Math.max(0, Math.min(1, 1 - poissonCDF(lambda, threshold - 1)));
}

// ── Statcast-Based K Projection ───────────────────────────────────────────────
/**
 * Project a starter's strikeout total using Statcast swinging-strike rate,
 * season K%, opponent lineup K%, and umpire zone adjustment.
 *
 * @param {object} opts
 * @param {object|null} opts.pitcherStats  — season stats from MLB Stats API
 * @param {object|null} opts.statcastData  — { kPct, whiffPct, swingPct, swStr, xKPct } from Savant
 * @param {object|null} opts.oppHitting    — { kPct } from opposing team stats
 * @param {number}      opts.umpAdj        — K/9 adjustment from umpire lookup (0 if unknown)
 * @param {number|null} opts.propLine      — e.g. 5.5
 * @param {Array}       opts.propBooks     — [{ book, line, over, under }]
 *
 * @returns {{ swStr, xKPct, baseProj, umpKAdj, finalProjKs,
 *             modelProb, impliedProb, edge, ev, kelly }}
 */
// League-average anchors for regression
const LEAGUE_K9      = 8.5;  // ~2024 MLB average
const REGRESSION_IP  = 60;   // full trust at 60+ IP

/**
 * Regress a pitcher's K/9 toward league average based on sample size.
 * Prevents small-sample rate inflation — a pitcher with 8 IP and 15 K/9
 * gets treated more like an 8.5 K/9 guy until he earns confidence.
 */
function regressedK9(rawK9, ip) {
  if (isNaN(rawK9) || rawK9 <= 0 || isNaN(ip) || ip <= 0) return LEAGUE_K9;
  const w = Math.min(1, ip / REGRESSION_IP);
  return w * rawK9 + (1 - w) * LEAGUE_K9;
}

function calcKProjection({ pitcherStats, statcastData, oppHitting, umpAdj = 0, propLine = null, propBooks = [] }) {
  const k9 = parseFloat(pitcherStats?.k9);
  const ip  = parseFloat(pitcherStats?.ip);
  const gs  = parseFloat(pitcherStats?.gs);

  const nullResult = (swStr, xKPct) => ({
    swStr, xKPct, baseProj: null, umpKAdj: 0, finalProjKs: null,
    modelProb: null, impliedProb: null, edge: null, ev: null, kelly: null
  });

  // Require at least 5 IP to project — relief scraps or debut noise
  if (isNaN(ip) || ip < 5) {
    return nullResult(statcastData?.swStr ?? null, statcastData?.xKPct ?? null);
  }

  // ── Expected IP per start ───────────────────────────────────────────────────
  // Use actual IP/GS when available; apply a sample-size-aware cap.
  // Spot starters (0 GS in MLB API) get a conservative 4.0 IP assumption.
  let expectedIP;
  if (!isNaN(gs) && gs > 0) {
    const avgIPPerStart = ip / gs;
    // Fewer starts = less predictable; don't let a 2-start sample drive a 7-inn proj
    const ipCap = gs >= 10 ? 6.5 : gs >= 5 ? 6.0 : 5.5;
    expectedIP = Math.min(ipCap, avgIPPerStart);
  } else {
    // No GS data — spot/bullpen start — assume shorter outing
    expectedIP = 4.0;
  }

  // ── Statcast layer ──────────────────────────────────────────────────────────
  const swStr = statcastData?.swStr ?? null;  // precomputed in statcast.js
  const xKPct = statcastData?.xKPct ?? null;  // calibrated in statcast.js: 2.3*SwStr - 0.032

  // ── Pitcher K% per batter — regressed toward league mean ───────────────────
  // Raw K/9 inflated from small samples → pulled toward 8.5 K/9 based on IP.
  const reliableK9        = regressedK9(k9, ip);
  const pitcherActualKPct = reliableK9 / (9 * 4.15); // 4.15 BF/inn (MLB starter avg)

  // ── Opponent K% — DIFFERENTIAL adjustment only ──────────────────────────────
  // The pitcher's K/9 already reflects facing league-average lineups (~22% K rate).
  // We adjust ONLY for how THIS lineup deviates — not blend in the raw rate.
  const LEAGUE_OPP_KPCT = 0.22;
  const oppKPct  = oppHitting?.kPct ?? LEAGUE_OPP_KPCT;
  const oppDelta = oppKPct - LEAGUE_OPP_KPCT;
  const oppAdj   = clamp(oppDelta * 0.35, -0.03, 0.03); // cap at ±3pp regardless of lineup

  // ── Blended K% per batter ──────────────────────────────────────────────────
  let blendedKPct;
  if (xKPct != null) {
    // Full Statcast model: 65% calibrated xK%, 35% regressed actual K%, plus opp delta
    blendedKPct = 0.65 * xKPct + 0.35 * pitcherActualKPct + oppAdj;
  } else {
    // No Statcast: regressed actual K% + opponent adjustment
    blendedKPct = pitcherActualKPct + oppAdj;
  }
  blendedKPct = clamp(blendedKPct, 0.10, 0.42); // sanity floor/ceiling

  // ── Expected batters faced ──────────────────────────────────────────────────
  const expectedBF = expectedIP * 4.15; // 4.15 BF/inn (consistent with K% denominator)
  const baseProj   = blendedKPct * expectedBF;

  // ── Umpire adjustment ───────────────────────────────────────────────────────
  // Convert ump K/9 adj → absolute Ks for this start's expected IP
  const umpKAdj    = umpAdj * (expectedIP / 9);
  const finalProjKs = Math.max(0, baseProj + umpKAdj);

  // ── EV calculation (needs a prop line + book odds) ──────────────────────────
  if (propLine == null || !propBooks.length) {
    return { swStr, xKPct, baseProj, umpKAdj, finalProjKs, modelProb: null, impliedProb: null, edge: null, ev: null, kelly: null };
  }

  const modelProb = poissonOverProb(finalProjKs, propLine);
  if (modelProb == null) {
    return { swStr, xKPct, baseProj, umpKAdj, finalProjKs, modelProb: null, impliedProb: null, edge: null, ev: null, kelly: null };
  }

  // Best over odds across all books (highest American number = best payout)
  const bestOverOdds = propBooks.reduce(
    (best, b) => (b.over != null && (best == null || b.over > best) ? b.over : best),
    null
  );
  if (bestOverOdds == null) {
    return { swStr, xKPct, baseProj, umpKAdj, finalProjKs, modelProb, impliedProb: null, edge: null, ev: null, kelly: null };
  }

  const impliedProb = oddsToImpliedProb(bestOverOdds);
  const edge        = modelProb - impliedProb;

  // Payout per $1 wagered (decimal odds format)
  const b     = bestOverOdds >= 0 ? bestOverOdds / 100 : 100 / Math.abs(bestOverOdds);
  const ev    = (modelProb * b) - (1 - modelProb);
  const kelly = Math.max(0, (modelProb * b - (1 - modelProb)) / b);

  return { swStr, xKPct, baseProj, umpKAdj, finalProjKs, modelProb, impliedProb, edge, ev, kelly };
}

// ── Legacy heuristic scorer (0–100) — still used on the card for context ─────
/**
 * Score a pitcher for their K prop value (0–100).
 * Factors: K/9, opp K%, K/BB control, recent start trend, line value.
 */
function scorePitcher({ pitcherStats, recentStarts, propLine, oppHitting }) {
  let score = 50;
  const factors = [];

  // 1. K/9 rate (±20 pts) — regressed toward league avg 8.5
  const k9 = parseFloat(pitcherStats?.k9);
  const ip  = parseFloat(pitcherStats?.ip);
  if (!isNaN(k9) && k9 > 0) {
    const rk9 = regressedK9(k9, ip);
    const pts = clamp(((rk9 - 8.5) / 2.5) * 20, -20, 20);
    score += pts;
    const label = !isNaN(ip) && ip < 30 ? `K/9 ${k9} (small sample)` : `K/9 ${k9}`;
    factors.push({ label, impact: pts > 5 ? 'pos' : pts < -5 ? 'neg' : 'neu', pts: Math.round(pts) });
  }

  // 2. Opponent K% (±15 pts) — league avg ~22%
  const oppKPct = oppHitting?.kPct;
  if (oppKPct != null && oppKPct > 0) {
    const pts = clamp(((oppKPct - 0.22) / 0.04) * 15, -15, 15);
    score += pts;
    factors.push({ label: `Opp K% ${(oppKPct * 100).toFixed(0)}%`, impact: pts > 4 ? 'pos' : pts < -4 ? 'neg' : 'neu', pts: Math.round(pts) });
  }

  // 3. K/BB ratio (±10 pts) — command = deeper starts = more K opps
  const kbb = parseFloat(pitcherStats?.kbb);
  if (!isNaN(kbb) && kbb > 0) {
    const pts = clamp(((kbb - 2.5) / 1.5) * 10, -10, 10);
    score += pts;
    factors.push({ label: `K/BB ${kbb}`, impact: pts > 3 ? 'pos' : pts < -3 ? 'neg' : 'neu', pts: Math.round(pts) });
  }

  // 4. Recent K trend (±10 pts)
  const gs  = parseFloat(pitcherStats?.gs);
  // Use regression-aware expectedIP for the score benchmark too
  const ipScore = !isNaN(ip) ? ip : 0;
  const expectedIPScore = (!isNaN(gs) && gs > 0 && !isNaN(ip))
    ? Math.min(gs >= 10 ? 6.5 : 6.0, ip / gs)
    : (!isNaN(gs) && gs === 0 ? 4.0 : 5.0);
  // Compare against regressed season Ks so recent trend is grounded in reality
  const rk9Score         = regressedK9(k9, ipScore);
  const seasonKPerStart  = (!isNaN(rk9Score) && expectedIPScore > 0) ? (rk9Score / 9) * expectedIPScore : null;

  if (recentStarts?.length >= 2) {
    const avgRecentK = recentStarts.reduce((a, s) => a + (s.strikeOuts || 0), 0) / recentStarts.length;
    if (seasonKPerStart != null && seasonKPerStart > 0) {
      const pts = clamp(((avgRecentK - seasonKPerStart) / seasonKPerStart) * 10, -10, 10);
      score += pts;
      factors.push({ label: `Recent ${avgRecentK.toFixed(1)} K/start (L${recentStarts.length})`, impact: pts > 2 ? 'pos' : pts < -2 ? 'neg' : 'neu', pts: Math.round(pts) });
    } else {
      factors.push({ label: `Recent ${avgRecentK.toFixed(1)} K/start (L${recentStarts.length})`, impact: 'neu', pts: 0 });
    }
  }

  // 5. Line value vs projection (±15 pts)
  if (propLine != null && seasonKPerStart != null) {
    const gap = seasonKPerStart - propLine;
    const pts = clamp((gap / Math.max(0.5, propLine)) * 20, -15, 15);
    score += pts;
    factors.push({ label: `Line ${propLine} · Proj ${seasonKPerStart.toFixed(1)}`, impact: pts > 3 ? 'pos' : pts < -3 ? 'neg' : 'neu', pts: Math.round(pts) });
  }

  score = clamp(Math.round(score), 0, 100);

  let tier, tierCls;
  if      (score >= 70) { tier = 'Elite';   tierCls = 'tier-elite'; }
  else if (score >= 58) { tier = 'Strong';  tierCls = 'tier-strong'; }
  else if (score >= 44) { tier = 'Neutral'; tierCls = 'tier-neutral'; }
  else if (score >= 32) { tier = 'Weak';    tierCls = 'tier-weak'; }
  else                  { tier = 'Fade';    tierCls = 'tier-fade'; }

  return { score, tier, tierCls, factors };
}

module.exports = { scorePitcher, calcKProjection };
