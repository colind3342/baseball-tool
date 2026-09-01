require('dotenv').config();
const express  = require('express');
const cron     = require('node-cron');
const path     = require('path');

const {
  getTodaySchedule,
  fetchAllPitcherStats,
  fetchAllTeamStats,
  getStandings,
  fetchAllRecentGames,
  fetchAllBullpenUsage,
  getEnrichedLineup,
  fetchAllPitcherRecentStarts
} = require('./services/mlb');
const { scorePitcher } = require('./services/strikeouts');
const { getMLBOdds }        = require('./services/odds');
const { getWeatherForGame } = require('./services/weather');
const { getParkFactor, getParkLabel } = require('./services/parkFactors');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const PORT        = process.env.PORT || 3000;

// ── On-demand caches ──────────────────────────────────────────────────────────
const lineupCache  = {}; // gamePk -> { data, fetchedAt }
const propsCache   = {}; // gamePk -> { data, fetchedAt }
const kPropsCache  = { data: null, fetchedAt: null };
const LINEUP_TTL   = 10 * 60 * 1000;  // 10 min
const PROPS_TTL    = 60 * 60 * 1000;  // 60 min
const KPROPS_TTL   =  4 * 60 * 60 * 1000;  // 4 hours (saves API credits)

// ── In-memory cache ──────────────────────────────────────────────────────────
const cache = {
  games:           [],
  rawOdds:         {},
  openingOdds:     {},
  openingOddsDate: null,
  lastUpdated:     null,
  oddsUpdated:     null,
  refreshing:      false
};

// ── Odds matching ─────────────────────────────────────────────────────────────
function lastWord(str) {
  const parts = (str || '').trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

function findOddsEntry(oddsMap, awayTeam, homeTeam) {
  for (const entry of Object.values(oddsMap)) {
    const awayMatch = lastWord(entry.awayTeam) === lastWord(awayTeam) ||
                      entry.awayTeam.toLowerCase().includes(awayTeam.toLowerCase().split(' ').pop());
    const homeMatch = lastWord(entry.homeTeam) === lastWord(homeTeam) ||
                      entry.homeTeam.toLowerCase().includes(homeTeam.toLowerCase().split(' ').pop());
    if (awayMatch && homeMatch) return entry;
  }
  return null;
}

// ── Line movement ─────────────────────────────────────────────────────────────
function calcMovement(opening, current) {
  if (!opening || !current) return null;
  const openBooks = opening.books || {};
  const currBooks = current.books  || {};

  // Find consensus ML movement
  const awayOpen = Object.values(openBooks).map(b => b.ml.away).filter(Boolean);
  const homeOpen = Object.values(openBooks).map(b => b.ml.home).filter(Boolean);
  const awayCurr = Object.values(currBooks).map(b => b.ml.away).filter(Boolean);
  const homeCurr = Object.values(currBooks).map(b => b.ml.home).filter(Boolean);

  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

  const openAway = avg(awayOpen);
  const openHome = avg(homeOpen);
  const currAway = avg(awayCurr);
  const currHome = avg(homeCurr);

  return {
    away: { open: openAway, current: currAway, moved: openAway != null && currAway != null && openAway !== currAway },
    home: { open: openHome, current: currHome, moved: openHome != null && currHome != null && openHome !== currHome }
  };
}

// ── Refresh: Odds (every 60 min) ─────────────────────────────────────────────
async function refreshOdds() {
  if (!ODDS_API_KEY) { console.warn('No ODDS_API_KEY set'); return; }
  try {
    console.log('Refreshing odds...');
    const raw = await getMLBOdds(ODDS_API_KEY);

    // Store opening odds once per day
    const today = new Date().toDateString();
    if (cache.openingOddsDate !== today) {
      cache.openingOdds     = raw;
      cache.openingOddsDate = today;
    }

    cache.rawOdds    = raw;
    cache.oddsUpdated = new Date().toISOString();
    console.log(`Odds updated — ${Object.keys(raw).length} games`);
  } catch (e) {
    console.error('refreshOdds error:', e.message);
  }
}

// ── Picks engine ─────────────────────────────────────────────────────────────
function fmtOdds(n) { return n == null ? '—' : n > 0 ? `+${n}` : `${n}`; }

function generatePicks(game) {
  const candidates = [];

  // 1. ML value (odds spread across books)
  if (game.odds?.consensus && game.odds?.books) {
    const cons  = game.odds.consensus;
    const bvals = Object.values(game.odds.books);
    const nBooks = bvals.length;

    if (cons.awaySpread >= 0.03) {
      const best = Math.max(...bvals.map(b => b.ml.away).filter(n => n != null));
      candidates.push({
        type: 'ml', team: game.away.abbr, line: best,
        label: `${game.away.abbr} ML ${fmtOdds(best)}`,
        rationale: `${(cons.awaySpread * 100).toFixed(1)}pp edge across ${nBooks} books`,
        confidence: cons.awaySpread >= 0.05 ? 'high' : 'medium'
      });
    }
    if (cons.homeSpread >= 0.03) {
      const best = Math.max(...bvals.map(b => b.ml.home).filter(n => n != null));
      candidates.push({
        type: 'ml', team: game.home.abbr, line: best,
        label: `${game.home.abbr} ML ${fmtOdds(best)}`,
        rationale: `${(cons.homeSpread * 100).toFixed(1)}pp edge across ${nBooks} books`,
        confidence: cons.homeSpread >= 0.05 ? 'high' : 'medium'
      });
    }
  }

  // 2. SP advantage (ERA gap)
  const awayERA = parseFloat(game.away.pitcherStats?.era);
  const homeERA = parseFloat(game.home.pitcherStats?.era);
  if (!isNaN(awayERA) && !isNaN(homeERA)) {
    const diff = Math.abs(awayERA - homeERA);
    if (diff >= 0.75) {
      const better   = awayERA < homeERA ? game.away : game.home;
      const betterERA = Math.min(awayERA, homeERA).toFixed(2);
      const worseERA  = Math.max(awayERA, homeERA).toFixed(2);
      const spName    = better.probablePitcher?.name.split(' ').pop() || 'SP';
      candidates.push({
        type: 'pitcher', team: better.abbr,
        label: `${better.abbr} SP Edge`,
        rationale: `${spName} ERA ${betterERA} vs ${worseERA} (${diff.toFixed(2)} gap)`,
        confidence: diff >= 1.5 ? 'high' : 'medium'
      });
    }
  }

  // 3. Bullpen fatigue edge
  const fatRank = { low: 0, medium: 1, high: 2, unknown: -1 };
  const awayFat = game.away.bullpen?.fatigueLevel;
  const homeFat = game.home.bullpen?.fatigueLevel;
  if (awayFat && homeFat && fatRank[awayFat] >= 0 && fatRank[homeFat] >= 0 && fatRank[awayFat] !== fatRank[homeFat]) {
    const better    = fatRank[awayFat] < fatRank[homeFat] ? game.away : game.home;
    const worse     = fatRank[awayFat] < fatRank[homeFat] ? game.home : game.away;
    const betterFat = fatRank[awayFat] < fatRank[homeFat] ? awayFat  : homeFat;
    const worseFat  = fatRank[awayFat] < fatRank[homeFat] ? homeFat  : awayFat;
    candidates.push({
      type: 'bullpen', team: better.abbr,
      label: `${better.abbr} Bullpen`,
      rationale: `${better.abbr} ${betterFat} fatigue vs ${worse.abbr} ${worseFat}`,
      confidence: betterFat === 'low' && worseFat === 'high' ? 'high' : 'medium'
    });
  }

  // 4. Park + weather → O/U angle
  const park    = game.park;
  const weather = game.weather;
  if (park && !weather?.domeOrRoof) {
    const hitterPark  = park.runFactor >= 1.08;
    const pitcherPark = park.runFactor <= 0.93;
    const hot         = (weather?.temp || 0) >= 78;
    const cold        = (weather?.temp || 999) <= 55;
    const windOut     = (weather?.windSpeed || 0) >= 10 &&
                        /out|blowing out|L to R|R to L/i.test(weather?.windDir || '');
    const rainRisk    = (weather?.precipProb || 0) >= 40;

    if (hitterPark && (hot || windOut)) {
      candidates.push({
        type: 'total', side: 'over',
        label: 'Over Play',
        rationale: [
          `${park.label} (${park.runFactor}x run factor)`,
          hot     ? `${weather.temp}°F` : '',
          windOut ? `${weather.windSpeed}mph wind out` : ''
        ].filter(Boolean).join(' · '),
        confidence: hitterPark && hot && windOut ? 'high' : 'medium'
      });
    } else if (pitcherPark || rainRisk || cold) {
      candidates.push({
        type: 'total', side: 'under',
        label: 'Under Play',
        rationale: [
          pitcherPark ? `${park.label} (${park.runFactor}x)` : '',
          rainRisk    ? `Rain ${weather.precipProb}%` : '',
          cold        ? `${weather.temp}°F` : ''
        ].filter(Boolean).join(' · '),
        confidence: pitcherPark && (rainRisk || cold) ? 'high' : 'medium'
      });
    }
  }

  // 5. Hot streak (4+ wins)
  for (const side of ['away', 'home']) {
    const streak = game[side].record?.streak || '';
    const num    = parseInt(streak.replace(/\D/g, '')) || 0;
    if (streak.startsWith('W') && num >= 4) {
      candidates.push({
        type: 'streak', team: game[side].abbr,
        label: `${game[side].abbr} W${num}`,
        rationale: `On a ${num}-game winning streak`,
        confidence: num >= 6 ? 'high' : 'medium'
      });
    }
  }

  // Sort: high confidence first, then pick top 3 with type variety
  const confRank = { high: 0, medium: 1, low: 2 };
  candidates.sort((a, b) => confRank[a.confidence] - confRank[b.confidence]);

  const seen = new Set();
  const top  = [];
  // First pass: one per type
  for (const p of candidates) {
    if (top.length >= 3) break;
    if (!seen.has(p.type)) { top.push(p); seen.add(p.type); }
  }
  // Second pass: fill remaining slots
  for (const p of candidates) {
    if (top.length >= 3) break;
    if (!top.includes(p)) top.push(p);
  }

  return top;
}

// ── Refresh: Games (every 15 min) ────────────────────────────────────────────
async function refreshGames() {
  if (cache.refreshing) return;
  cache.refreshing = true;

  try {
    console.log('Refreshing game data...');
    const schedule = await getTodaySchedule();

    if (!schedule.length) {
      cache.games       = [];
      cache.lastUpdated = new Date().toISOString();
      console.log('No games today');
      return;
    }

    // Collect unique IDs
    const pitcherIds = [...new Set(
      schedule.flatMap(g => [g.away.probablePitcher?.id, g.home.probablePitcher?.id]).filter(Boolean)
    )];
    const teamIds = [...new Set(schedule.flatMap(g => [g.away.teamId, g.home.teamId]))];

    // Batch-fetch all data in parallel
    const [pitcherMap, teamStatMap, standings, recentMap, bullpenMap, weatherArr] = await Promise.all([
      fetchAllPitcherStats(pitcherIds),
      fetchAllTeamStats(teamIds),
      getStandings(),
      fetchAllRecentGames(teamIds),
      fetchAllBullpenUsage(schedule),
      Promise.all(schedule.map(g => getWeatherForGame(g.venue.name, g.gameDate)))
    ]);

    // Build enriched game objects
    const games = schedule.map((g, i) => {
      const parkRaw   = getParkFactor(g.venue.name);
      const parkLabel = getParkLabel(parkRaw.runFactor);
      const weather   = weatherArr[i];

      const currentOdds = findOddsEntry(cache.rawOdds,    g.away.teamName, g.home.teamName);
      const openingOdds = findOddsEntry(cache.openingOdds, g.away.teamName, g.home.teamName);
      const movement    = calcMovement(openingOdds, currentOdds);

      return {
        gamePk:     g.gamePk,
        gameDate:   g.gameDate,
        status:     g.status,
        statusCode: g.statusCode,
        inning:     g.inning,
        inningHalf: g.inningHalf,
        venue:      g.venue,
        park:       { ...parkRaw, ...parkLabel },
        weather:    weather,
        away: {
          ...g.away,
          pitcherStats: pitcherMap[g.away.probablePitcher?.id] || null,
          teamStats:    teamStatMap[g.away.teamId]             || null,
          record:       standings[g.away.teamId]               || null,
          recent:       recentMap[g.away.teamId]               || null,
          bullpen:      bullpenMap[g.away.teamId]              || null
        },
        home: {
          ...g.home,
          pitcherStats: pitcherMap[g.home.probablePitcher?.id] || null,
          teamStats:    teamStatMap[g.home.teamId]             || null,
          record:       standings[g.home.teamId]               || null,
          recent:       recentMap[g.home.teamId]               || null,
          bullpen:      bullpenMap[g.home.teamId]              || null
        },
        odds:        currentOdds || null,
        openingOdds: openingOdds || null,
        movement,
        picks:       []  // filled below after object is complete
      };
    });

    // Generate picks now that each game object is fully assembled
    games.forEach(game => { game.picks = generatePicks(game); });

    cache.games       = games;
    cache.lastUpdated = new Date().toISOString();
    console.log(`Game data updated — ${games.length} games`);
  } catch (e) {
    console.error('refreshGames error:', e.message);
  } finally {
    cache.refreshing = false;
  }
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/games', (req, res) => {
  res.json({
    games:        cache.games,
    lastUpdated:  cache.lastUpdated,
    oddsUpdated:  cache.oddsUpdated
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', games: cache.games.length, lastUpdated: cache.lastUpdated });
});

// ── On-demand: lineups + H2H ─────────────────────────────────────────────────
app.get('/api/game/:gamePk/lineups', async (req, res) => {
  const gamePk = parseInt(req.params.gamePk);
  const game   = cache.games.find(g => g.gamePk === gamePk);

  // Serve from cache if fresh
  if (lineupCache[gamePk] && Date.now() - lineupCache[gamePk].fetchedAt < LINEUP_TTL) {
    return res.json(lineupCache[gamePk].data);
  }

  try {
    const awayPitcherId = game?.away?.probablePitcher?.id || null;
    const homePitcherId = game?.home?.probablePitcher?.id || null;
    const lineup = await getEnrichedLineup(gamePk, awayPitcherId, homePitcherId);

    const payload = { lineup, awayPitcher: game?.away?.probablePitcher, homePitcher: game?.home?.probablePitcher };
    lineupCache[gamePk] = { data: payload, fetchedAt: Date.now() };
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── On-demand: player props ──────────────────────────────────────────────────
app.get('/api/game/:gamePk/props', async (req, res) => {
  const gamePk = parseInt(req.params.gamePk);
  const game   = cache.games.find(g => g.gamePk === gamePk);

  if (!ODDS_API_KEY)         return res.json({ props: null, error: 'No API key' });
  if (!game?.odds?.oddsApiId) return res.json({ props: null, error: 'No odds ID for this game' });

  // Serve from cache if fresh
  if (propsCache[gamePk] && Date.now() - propsCache[gamePk].fetchedAt < PROPS_TTL) {
    return res.json({ props: propsCache[gamePk].data });
  }

  try {
    const fetch = require('node-fetch');
    const markets = [
      'pitcher_strikeouts', 'pitcher_hits_allowed', 'pitcher_walks', 'pitcher_earned_runs',
      'batter_home_runs', 'batter_hits', 'batter_total_bases', 'batter_rbis',
      'batter_runs_scored', 'batter_stolen_bases', 'batter_doubles'
    ].join(',');
    const url   = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${game.odds.oddsApiId}/odds` +
      `?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=american`;

    const apiRes  = await fetch(url);
    const remaining = apiRes.headers.get('x-requests-remaining');
    if (remaining) console.log(`Props fetch — requests remaining: ${remaining}`);

    if (!apiRes.ok) {
      const txt = await apiRes.text();
      return res.json({ props: null, error: txt });
    }

    const data = await apiRes.json();
    propsCache[gamePk] = { data, fetchedAt: Date.now() };
    res.json({ props: data });
  } catch (e) {
    res.status(500).json({ props: null, error: e.message });
  }
});

// ── Strikeout Props Ranker ────────────────────────────────────────────────────
app.get('/api/strikeout-props', async (req, res) => {
  // Serve from cache unless forced refresh
  if (!req.query.refresh && kPropsCache.data && Date.now() - kPropsCache.fetchedAt < KPROPS_TTL) {
    return res.json(kPropsCache.data);
  }

  if (!ODDS_API_KEY) return res.json({ error: 'No ODDS_API_KEY', pitchers: [] });
  if (!cache.games.length) return res.json({ error: 'No games loaded yet', pitchers: [] });

  try {
    const fetch = require('node-fetch');

    // Games that have probable pitchers and an Odds API event ID
    const gamesWithOdds = cache.games.filter(g =>
      g.odds?.oddsApiId && (g.away.probablePitcher || g.home.probablePitcher)
    );

    // Fetch pitcher_strikeouts for each game (reuse propsCache when fresh)
    const kPropsPerGame = {};
    await Promise.all(gamesWithOdds.map(async game => {
      // Reuse full props cache if it already has K markets
      if (propsCache[game.gamePk] && Date.now() - propsCache[game.gamePk].fetchedAt < PROPS_TTL) {
        kPropsPerGame[game.gamePk] = propsCache[game.gamePk].data;
        return;
      }

      const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${game.odds.oddsApiId}/odds` +
        `?apiKey=${ODDS_API_KEY}&regions=us&markets=pitcher_strikeouts&oddsFormat=american`;

      try {
        const apiRes   = await fetch(url);
        const remaining = apiRes.headers.get('x-requests-remaining');
        if (remaining) console.log(`K props (${game.away.abbr}@${game.home.abbr}) — remaining: ${remaining}`);
        if (apiRes.ok) {
          const data = await apiRes.json();
          kPropsPerGame[game.gamePk] = data;
          if (!propsCache[game.gamePk]) propsCache[game.gamePk] = { data, fetchedAt: Date.now() };
        }
      } catch (e) {
        console.warn(`K props fetch failed for gamePk ${game.gamePk}:`, e.message);
      }
    }));

    // Fetch recent starts for all probable pitchers
    const pitcherIds = [...new Set(
      cache.games.flatMap(g => [g.away.probablePitcher?.id, g.home.probablePitcher?.id]).filter(Boolean)
    )];
    const recentStartsMap = await fetchAllPitcherRecentStarts(pitcherIds, 5);

    // Build ranked list
    const pitchers = [];
    for (const game of cache.games) {
      for (const side of ['away', 'home']) {
        const team = game[side];
        const opp  = game[side === 'away' ? 'home' : 'away'];
        if (!team.probablePitcher) continue;

        const pitcher      = team.probablePitcher;
        const stats        = team.pitcherStats;
        const oppHitting   = opp.teamStats?.hitting;
        const recentStarts = recentStartsMap[pitcher.id] || [];
        const kData        = kPropsPerGame[game.gamePk];

        // Extract K line + best books for this pitcher
        let propLine = null;
        const propBooks = [];
        if (kData?.bookmakers) {
          const lastName = pitcher.name.split(' ').slice(1).join(' ').toLowerCase();
          for (const bm of kData.bookmakers) {
            const mkt = bm.markets?.find(m => m.key === 'pitcher_strikeouts');
            if (!mkt) continue;
            // Match by last name (prop player names vary by book)
            const over  = mkt.outcomes?.find(o => o.description === 'Over'  && o.name.toLowerCase().includes(lastName));
            const under = mkt.outcomes?.find(o => o.description === 'Under' && o.name.toLowerCase().includes(lastName));
            if (over?.point != null) {
              if (propLine == null) propLine = over.point;
              propBooks.push({ book: bm.title, line: over.point, over: over.price, under: under?.price ?? null });
            }
          }
        }

        const { score, tier, tierCls, factors } = scorePitcher({
          pitcherStats: stats,
          recentStarts,
          propLine,
          oppHitting
        });

        pitchers.push({
          pitcher,
          team:         { abbr: team.abbr, teamName: team.teamName },
          opponent:     { abbr: opp.abbr,  teamName: opp.teamName },
          gamePk:       game.gamePk,
          gameDate:     game.gameDate,
          stats,
          recentStarts: recentStarts.slice(-3),
          propLine,
          propBooks,
          score,
          tier,
          tierCls,
          factors
        });
      }
    }

    pitchers.sort((a, b) => b.score - a.score);

    const result = {
      pitchers,
      fetchedAt:      new Date().toISOString(),
      gamesWithProps: Object.keys(kPropsPerGame).length
    };

    kPropsCache.data      = result;
    kPropsCache.fetchedAt = Date.now();

    res.json(result);
  } catch (e) {
    console.error('strikeout-props error:', e.message);
    res.status(500).json({ error: e.message, pitchers: [] });
  }
});

// ── Cron schedules ────────────────────────────────────────────────────────────
cron.schedule('*/15 * * * *', refreshGames); // every 15 min
cron.schedule('0 * * * *',    refreshOdds);  // every hour on the hour

// ── Boot ──────────────────────────────────────────────────────────────────────
async function init() {
  await refreshOdds();
  await refreshGames();
}

app.listen(PORT, () => {
  console.log(`MLB Analyzer running on port ${PORT}`);
  init();
});
