'use strict';

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Score a starting pitcher's K prop value for today.
 * Returns { score: 0–100, tier, tierCls, factors[] }
 *
 * Factors:
 *   1. K/9 rate          — raw strikeout stuff (±20 pts)
 *   2. Opponent K%       — how often the lineup whiffs (±15 pts)
 *   3. K/BB ratio        — control = stays deeper = more K opps (±10 pts)
 *   4. Recent K trend    — last 3–5 starts vs season projection (±10 pts)
 *   5. Line value        — projected Ks vs the prop line (±15 pts)
 */
function scorePitcher({ pitcherStats, recentStarts, propLine, oppHitting }) {
  let score = 50;
  const factors = [];

  // ── 1. K/9 rate (±20 pts) ──────────────────────────────────────────────────
  // League avg ~8.5. Elite ≥ 11, poor ≤ 6.
  const k9 = parseFloat(pitcherStats?.k9);
  if (!isNaN(k9) && k9 > 0) {
    const pts = clamp(((k9 - 8.5) / 2.5) * 20, -20, 20);
    score += pts;
    factors.push({
      label:  `K/9 ${k9}`,
      impact: pts > 5 ? 'pos' : pts < -5 ? 'neg' : 'neu',
      pts:    Math.round(pts)
    });
  }

  // ── 2. Opponent K% (±15 pts) ───────────────────────────────────────────────
  // League avg ~22%. High-K lineup ≥ 26%, contact lineup ≤ 18%.
  const oppKPct = oppHitting?.kPct;
  if (oppKPct != null && oppKPct > 0) {
    const pts = clamp(((oppKPct - 0.22) / 0.04) * 15, -15, 15);
    score += pts;
    factors.push({
      label:  `Opp K% ${(oppKPct * 100).toFixed(0)}%`,
      impact: pts > 4 ? 'pos' : pts < -4 ? 'neg' : 'neu',
      pts:    Math.round(pts)
    });
  }

  // ── 3. K/BB ratio — control & depth (±10 pts) ─────────────────────────────
  // League avg ~2.5. Elite ≥ 4, poor < 1.5.
  const kbb = parseFloat(pitcherStats?.kbb);
  if (!isNaN(kbb) && kbb > 0) {
    const pts = clamp(((kbb - 2.5) / 1.5) * 10, -10, 10);
    score += pts;
    factors.push({
      label:  `K/BB ${kbb}`,
      impact: pts > 3 ? 'pos' : pts < -3 ? 'neg' : 'neu',
      pts:    Math.round(pts)
    });
  }

  // ── 4. Recent K trend (±10 pts) ───────────────────────────────────────────
  const ip = parseFloat(pitcherStats?.ip);
  const gs = parseFloat(pitcherStats?.gs);
  const expectedIP      = (gs > 0 && !isNaN(ip)) ? Math.min(7, ip / gs) : 5.5;
  const seasonKPerStart = (!isNaN(k9) && expectedIP > 0) ? (k9 / 9) * expectedIP : null;

  if (recentStarts?.length >= 2) {
    const avgRecentK = recentStarts.reduce((a, s) => a + (s.strikeOuts || 0), 0) / recentStarts.length;

    if (seasonKPerStart != null && seasonKPerStart > 0) {
      const pts = clamp(((avgRecentK - seasonKPerStart) / seasonKPerStart) * 10, -10, 10);
      score += pts;
      factors.push({
        label:  `Recent ${avgRecentK.toFixed(1)} K/start (L${recentStarts.length})`,
        impact: pts > 2 ? 'pos' : pts < -2 ? 'neg' : 'neu',
        pts:    Math.round(pts)
      });
    } else {
      factors.push({
        label:  `Recent ${avgRecentK.toFixed(1)} K/start (L${recentStarts.length})`,
        impact: 'neu',
        pts:    0
      });
    }
  }

  // ── 5. Line value vs projection (±15 pts) ─────────────────────────────────
  // Projected = season K/9 × expected IP per start.
  // If projected > line: Over value. If line > projected: Under lean.
  if (propLine != null && seasonKPerStart != null) {
    const gap = seasonKPerStart - propLine;
    const pts = clamp((gap / Math.max(0.5, propLine)) * 20, -15, 15);
    score += pts;
    factors.push({
      label:  `Line ${propLine} · Proj ${seasonKPerStart.toFixed(1)}`,
      impact: pts > 3 ? 'pos' : pts < -3 ? 'neg' : 'neu',
      pts:    Math.round(pts)
    });
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

module.exports = { scorePitcher };
