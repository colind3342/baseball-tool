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
  fetchAllBullpenUsage
} = require('./services/mlb');
const { getMLBOdds }        = require('./services/odds');
const { getWeatherForGame } = require('./services/weather');
const { getParkFactor, getParkLabel } = require('./services/parkFactors');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const PORT        = process.env.PORT || 3000;

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
        movement
      };
    });

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
