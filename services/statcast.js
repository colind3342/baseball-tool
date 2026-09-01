'use strict';

const fetch = require('node-fetch');

const SEASON = new Date().getFullYear();

// Daily cache — Savant data doesn't change intraday
let _cache = { map: {}, date: null };

/**
 * Parse a single CSV line, respecting quoted fields (handles "Wheeler, Zack" correctly).
 */
function parseCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; } // escaped quote
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Fetch pitcher whiff/swing/K% from Baseball Savant custom leaderboard.
 * Caches result for the calendar day.
 */
async function refreshStatcast() {
  const today = new Date().toDateString();
  if (_cache.date === today && Object.keys(_cache.map).length > 0) {
    console.log('Statcast: cache fresh, skipping fetch');
    return;
  }

  const url =
    `https://baseballsavant.mlb.com/leaderboard/custom?year=${SEASON}&type=pitcher` +
    `&filter=&min=25&selections=player_id%2Ck_percent%2Cbb_percent%2Cwhiff_percent%2Cswing_percent` +
    `%2Cxera%2Chard_hit_percent%2Cbarrel_batted_rate&csv=true`;

  try {
    console.log('Fetching Baseball Savant statcast data...');
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MLBAnalyzer/1.0)' },
      timeout: 20000
    });

    if (!res.ok) {
      console.warn(`Statcast fetch failed: HTTP ${res.status}`);
      return;
    }

    const text = await res.text();

    // Guard against HTML error pages
    if (!text.includes('player_id')) {
      console.warn('Statcast: unexpected response format (no player_id column)');
      return;
    }

    const lines = text.trim().split('\n');
    if (lines.length < 2) { console.warn('Statcast: empty CSV'); return; }

    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/"/g, ''));
    const map     = {};

    for (let i = 1; i < lines.length; i++) {
      const vals = parseCSVLine(lines[i]);
      if (vals.length < headers.length) continue;

      const row = {};
      headers.forEach((h, j) => { row[h] = vals[j]; });

      const id = parseInt(row['player_id']);
      if (!id || isNaN(id)) continue;

      const kPct     = parseFloat(row['k_percent'])     / 100 || null;
      const bbPct    = parseFloat(row['bb_percent'])    / 100 || null;
      const whiffPct = parseFloat(row['whiff_percent']) / 100 || null;
      const swingPct = parseFloat(row['swing_percent']) / 100 || null;

      // SwStr% = whiff rate × swing rate
      // xK% per PA ≈ 2.7 × SwStr% (empirical, R² ~0.85 historically)
      const swStr = (whiffPct != null && swingPct != null) ? whiffPct * swingPct : null;
      const xKPct = swStr != null ? Math.min(0.45, 2.7 * swStr) : null;

      // Quality-of-contact metrics (may be absent in older Savant exports — parse gracefully)
      const xERAraw      = parseFloat(row['xera']);
      const hardHitRaw   = parseFloat(row['hard_hit_percent']);
      const barrelRaw    = parseFloat(row['barrel_batted_rate']);
      const xERA         = isNaN(xERAraw)    ? null : xERAraw;
      const hardHitPct   = isNaN(hardHitRaw) ? null : hardHitRaw / 100;
      const barrelPct    = isNaN(barrelRaw)  ? null : barrelRaw  / 100;

      map[String(id)] = { kPct, bbPct, whiffPct, swingPct, swStr, xKPct, xERA, hardHitPct, barrelPct };
    }

    _cache = { map, date: today };
    console.log(`Statcast loaded: ${Object.keys(map).length} pitchers`);
  } catch (e) {
    console.warn('refreshStatcast error:', e.message);
    // Keep stale cache if present — degrade gracefully
  }
}

function getStatcastMap() { return _cache.map; }

module.exports = { refreshStatcast, getStatcastMap };
