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
function calcKProjection({ pitcherStats, statcastData, oppHitting, umpAdj = 0, propLine = null, propBooks = [] }) {
  const k9 = parseFloat(pitcherStats?.k9);
  const ip  = parseFloat(pitcherStats?.ip);
  const gs  = parseFloat(pitcherStats?.gs);

  // Expected IP per start (capped at 7 — modern usage)
  const expectedIP = (gs > 0 && !isNaN(ip)) ? Math.min(7, ip / gs) : 5.5;

  // ── Statcast layer ──────────────────────────────────────────────────────────
  const swStr = statcastData?.swStr ?? null;  // precomputed in statcast.js
  const xKPct = statcastData?.xKPct ?? null;  // 2.7 × SwStr%

  // ── Pitcher actual K% per batter faced ─────────────────────────────────────
  // K/9 ÷ 9 ÷ BF/inn (league avg ~4.3) → Ks per batter faced
  const pitcherActualKPct = (!isNaN(k9) && k9 > 0) ? k9 / (9 * 4.3) : null;

  // ── Opponent K% (default to league avg 22% if missing) ─────────────────────
  const oppKPct = oppHitting?.kPct ?? 0.22;

  // ── Blended K% per batter ──────────────────────────────────────────────────
  let blendedKPct;
  if (xKPct != null && pitcherActualKPct != null) {
    // Full Statcast model: 50% Statcast, 30% season K%, 20% opp lineup K%
    blendedKPct = 0.50 * xKPct + 0.30 * pitcherActualKPct + 0.20 * oppKPct;
  } else if (pitcherActualKPct != null) {
    // Degraded: 60% season K%, 40% opp lineup K%
    blendedKPct = 0.60 * pitcherActualKPct + 0.40 * oppKPct;
  } else {
    // No pitcher stats — cannot project
    return { swStr, xKPct, baseProj: null, umpKAdj: 0, finalProjKs: null, modelProb: null, impliedProb: null, edge: null, ev: null, kelly: null };
  }

  // ── Expected batters faced ──────────────────────────────────────────────────
  const expectedBF = expectedIP * 4.3;
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

  // 1. K/9 rate (±20 pts) — league avg ~8.5
  const k9 = parseFloat(pitcherStats?.k9);
  if (!isNaN(k9) && k9 > 0) {
    const pts = clamp(((k9 - 8.5) / 2.5) * 20, -20, 20);
    score += pts;
    factors.push({ label: `K/9 ${k9}`, impact: pts > 5 ? 'pos' : pts < -5 ? 'neg' : 'neu', pts: Math.round(pts) });
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
  const ip  = parseFloat(pitcherStats?.ip);
  const gs  = parseFloat(pitcherStats?.gs);
  const expectedIP      = (gs > 0 && !isNaN(ip)) ? Math.min(7, ip / gs) : 5.5;
  const seasonKPerStart = (!isNaN(k9) && expectedIP > 0) ? (k9 / 9) * expectedIP : null;

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
