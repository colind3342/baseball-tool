const fetch = require('node-fetch');

const BASE   = 'https://statsapi.mlb.com/api/v1';
const SEASON = new Date().getFullYear();

function dateStr(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

async function safeFetch(url) {
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// ── Schedule ────────────────────────────────────────────────────────────────
async function getTodaySchedule() {
  const today = dateStr(0);
  const data = await safeFetch(
    `${BASE}/schedule?sportId=1&date=${today}&hydrate=probablePitcher,linescore,team,venue,officials`
  );
  if (!data?.dates?.length) return [];

  return data.dates[0].games.map(g => {
    const hpUmp = (g.officials || []).find(o => o.officialType === 'Home Plate');
    return {
    gamePk:   g.gamePk,
    gameDate: g.gameDate,
    status:   g.status.detailedState,
    statusCode: g.status.codedGameState,
    inning:   g.linescore?.currentInning,
    inningHalf: g.linescore?.inningHalf,
    venue: {
      id:   g.venue?.id,
      name: g.venue?.name
    },
    umpire: hpUmp ? { id: hpUmp.official?.id, name: hpUmp.official?.fullName } : null,
    away: {
      teamId:          g.teams.away.team.id,
      teamName:        g.teams.away.team.name,
      abbr:            g.teams.away.team.abbreviation,
      score:           g.teams.away.score ?? null,
      probablePitcher: g.teams.away.probablePitcher
        ? { id: g.teams.away.probablePitcher.id, name: g.teams.away.probablePitcher.fullName }
        : null
    },
    home: {
      teamId:          g.teams.home.team.id,
      teamName:        g.teams.home.team.name,
      abbr:            g.teams.home.team.abbreviation,
      score:           g.teams.home.score ?? null,
      probablePitcher: g.teams.home.probablePitcher
        ? { id: g.teams.home.probablePitcher.id, name: g.teams.home.probablePitcher.fullName }
        : null
    }
  };});
}

// ── Pitcher Stats ────────────────────────────────────────────────────────────
async function getPitcherStats(id) {
  if (!id) return null;
  const data = await safeFetch(
    `${BASE}/people/${id}/stats?stats=season&group=pitching&season=${SEASON}`
  );
  const s = data?.stats?.[0]?.splits?.[0]?.stat;
  if (!s) return null;
  return {
    era:    s.era,
    whip:   s.whip,
    wins:   s.wins,
    losses: s.losses,
    ip:     s.inningsPitched,
    k9:     s.strikeoutsPer9Inn,
    bb9:    s.walksPer9Inn,
    hr9:    s.homeRunsPer9,
    avg:    s.avg,
    ops:    s.ops,
    kbb:    s.strikeoutWalkRatio,
    gs:     s.gamesStarted,
    saves:  s.saves
  };
}

async function fetchAllPitcherStats(ids) {
  const map = {};
  await Promise.all(ids.map(async id => { map[id] = await getPitcherStats(id); }));
  return map;
}

// ── Team Stats ───────────────────────────────────────────────────────────────
async function getTeamStats(teamId) {
  const [hitData, pitchData] = await Promise.all([
    safeFetch(`${BASE}/teams/${teamId}/stats?stats=season&group=hitting&season=${SEASON}`),
    safeFetch(`${BASE}/teams/${teamId}/stats?stats=season&group=pitching&season=${SEASON}`)
  ]);

  const h = hitData?.stats?.[0]?.splits?.[0]?.stat || {};
  const p = pitchData?.stats?.[0]?.splits?.[0]?.stat || {};

  const hSO = h.strikeOuts ?? 0;
  const hPA = h.plateAppearances ?? 1;

  return {
    hitting: {
      avg:  h.avg,
      obp:  h.obp,
      slg:  h.slg,
      ops:  h.ops,
      hrs:  h.homeRuns,
      runs: h.runs,
      so:   hSO,
      pa:   hPA,
      kPct: hPA > 0 ? hSO / hPA : null
    },
    pitching: {
      era:  p.era,
      whip: p.whip,
      k9:   p.strikeoutsPer9Inn,
      bb9:  p.walksPer9Inn,
      hr9:  p.homeRunsPer9
    }
  };
}

async function fetchAllTeamStats(teamIds) {
  const map = {};
  await Promise.all(teamIds.map(async id => { map[id] = await getTeamStats(id); }));
  return map;
}

// ── Standings & Recent Games ─────────────────────────────────────────────────
async function getStandings() {
  const data = await safeFetch(
    `${BASE}/standings?leagueId=103,104&season=${SEASON}&hydrate=team`
  );
  const map = {};
  for (const div of (data?.records || [])) {
    for (const t of (div.teamRecords || [])) {
      const splits = t.records?.splitRecords || [];
      const homeRec  = splits.find(r => r.type === 'home')  || {};
      const awayRec  = splits.find(r => r.type === 'away')  || {};
      const last10   = splits.find(r => r.type === 'lastTen') || {};
      map[t.team.id] = {
        wins:    t.wins,
        losses:  t.losses,
        pct:     t.winningPercentage,
        streak:  t.streak?.streakCode || '',
        gb:      t.gamesBack,
        home:    { w: homeRec.wins ?? 0, l: homeRec.losses ?? 0 },
        away:    { w: awayRec.wins ?? 0, l: awayRec.losses ?? 0 },
        last10:  { w: last10.wins ?? 0, l: last10.losses ?? 0 }
      };
    }
  }
  return map;
}

// ── Recent Scoring Trends (last 10 final games) ──────────────────────────────
async function getTeamRecentGames(teamId) {
  const start = dateStr(14);
  const end   = dateStr(0);
  const data  = await safeFetch(
    `${BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${end}&hydrate=linescore`
  );

  const games = [];
  for (const date of (data?.dates || [])) {
    for (const g of date.games) {
      if (g.status.codedGameState !== 'F') continue;
      const isHome   = g.teams.home.team.id === teamId;
      const myScore  = isHome ? g.teams.home.score : g.teams.away.score;
      const oppScore = isHome ? g.teams.away.score : g.teams.home.score;
      games.push({ won: myScore > oppScore, rs: myScore || 0, ra: oppScore || 0 });
    }
  }

  const last10  = games.slice(-10);
  const rs      = last10.reduce((a, g) => a + g.rs, 0);
  const ra      = last10.reduce((a, g) => a + g.ra, 0);
  const n       = last10.length || 1;
  return {
    rsPerGame: (rs / n).toFixed(1),
    raPerGame: (ra / n).toFixed(1),
    last10: { w: last10.filter(g => g.won).length, l: last10.filter(g => !g.won).length }
  };
}

async function fetchAllRecentGames(teamIds) {
  const map = {};
  await Promise.all(teamIds.map(async id => { map[id] = await getTeamRecentGames(id); }));
  return map;
}

// ── Bullpen Usage ────────────────────────────────────────────────────────────
async function getBullpenUsageForTeam(teamId, starterPitcherId) {
  try {
    // Get last 4 days of final games for this team
    const start = dateStr(4);
    const end   = dateStr(1);
    const sched = await safeFetch(
      `${BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${end}`
    );

    const games = [];
    for (const date of (sched?.dates || [])) {
      for (const g of date.games) {
        if (g.status.codedGameState === 'F') games.push({ gamePk: g.gamePk, date: date.date });
      }
    }

    // Fetch boxscores (last 3 games max to limit calls)
    const recent = games.slice(-3);
    const pitcherDays = {}; // pitcherId -> { name, daysAgo[] }
    const today = new Date();

    await Promise.all(recent.map(async ({ gamePk, date }) => {
      const box = await safeFetch(`${BASE}/game/${gamePk}/boxscore`);
      if (!box) return;

      const isHome   = box.teams.home.team.id === teamId;
      const teamBox  = isHome ? box.teams.home : box.teams.away;
      const daysAgo  = Math.round((today - new Date(date)) / 86400000);

      for (const pid of (teamBox.pitchers || [])) {
        if (String(pid) === String(starterPitcherId)) continue;
        const player = teamBox.players[`ID${pid}`];
        if (!player) continue;
        const ip = player.stats?.pitching?.inningsPitched;
        if (!ip || ip === '0.0' || ip === '0') continue;

        const sid = String(pid);
        if (!pitcherDays[sid]) {
          pitcherDays[sid] = { name: player.person.fullName, days: [] };
        }
        pitcherDays[sid].days.push(daysAgo);
      }
    }));

    const relievers = Object.values(pitcherDays).map(p => ({
      name:         p.name,
      appearances:  p.days.length,
      consecutive:  hasConsecutiveDays(p.days)
    })).sort((a, b) => b.appearances - a.appearances);

    const highLoad = relievers.filter(r => r.appearances >= 3).length;
    const medLoad  = relievers.filter(r => r.appearances >= 2).length;
    const fatigueLevel = highLoad >= 2 ? 'high' : medLoad >= 3 ? 'medium' : 'low';

    return { relievers: relievers.slice(0, 5), fatigueLevel };
  } catch (e) {
    return { relievers: [], fatigueLevel: 'unknown' };
  }
}

function hasConsecutiveDays(days) {
  const unique = [...new Set(days)].sort((a, b) => a - b);
  for (let i = 0; i < unique.length - 1; i++) {
    if (unique[i + 1] - unique[i] === 1) return true;
  }
  return false;
}

async function fetchAllBullpenUsage(games) {
  const map = {};
  // Process teams sequentially to avoid flooding the boxscore endpoint
  const pairs = games.flatMap(g => [
    { teamId: g.away.teamId, starterId: g.away.probablePitcher?.id },
    { teamId: g.home.teamId, starterId: g.home.probablePitcher?.id }
  ]);

  // Dedupe by teamId
  const seen = new Set();
  const unique = pairs.filter(p => {
    if (seen.has(p.teamId)) return false;
    seen.add(p.teamId);
    return true;
  });

  // Process in batches of 4 to avoid overwhelming the API
  for (let i = 0; i < unique.length; i += 4) {
    const batch = unique.slice(i, i + 4);
    await Promise.all(batch.map(async ({ teamId, starterId }) => {
      map[teamId] = await getBullpenUsageForTeam(teamId, starterId);
    }));
  }

  return map;
}

// ── Game Lineup ───────────────────────────────────────────────────────────────
async function getGameLineup(gamePk) {
  const data = await safeFetch(`${BASE}/game/${gamePk}/boxscore`);
  if (!data) return null;

  const result = {};
  for (const side of ['away', 'home']) {
    const team  = data.teams[side];
    const order = team.battingOrder || [];

    result[side] = {
      teamId:   team.team.id,
      teamName: team.team.name,
      lineup: order.map(pid => {
        const p = team.players[`ID${pid}`];
        if (!p) return null;
        return {
          id:       pid,
          name:     p.person.fullName,
          position: p.position?.abbreviation || '—',
          order:    p.battingOrder
        };
      }).filter(Boolean)
    };
  }
  return result;
}

// ── Batter Season Stats ───────────────────────────────────────────────────────
async function getBatterSeasonStats(batterId) {
  const data = await safeFetch(
    `${BASE}/people/${batterId}/stats?stats=season&group=hitting&season=${SEASON}`
  );
  const s = data?.stats?.[0]?.splits?.[0]?.stat;
  if (!s) return null;
  return {
    avg: s.avg,
    obp: s.obp,
    slg: s.slg,
    ops: s.ops,
    hr:  s.homeRuns,
    rbi: s.rbi,
    sb:  s.stolenBases,
    so:  s.strikeOuts,
    bb:  s.baseOnBalls,
    ab:  s.atBats,
    hits: s.hits
  };
}

// ── Batter vs Pitcher (career) ────────────────────────────────────────────────
async function getBatterVsPitcher(batterId, pitcherId) {
  const data = await safeFetch(
    `${BASE}/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting`
  );
  const s = data?.stats?.[0]?.splits?.[0]?.stat;
  if (!s || !s.atBats) return null;
  return {
    ab:   s.atBats,
    hits: s.hits,
    avg:  s.avg,
    hr:   s.homeRuns,
    rbi:  s.rbi,
    so:   s.strikeOuts,
    bb:   s.baseOnBalls,
    ops:  s.ops
  };
}

// ── Full lineup enrichment (lineup + season stats + H2H) ─────────────────────
async function getEnrichedLineup(gamePk, awayPitcherId, homePitcherId) {
  const lineup = await getGameLineup(gamePk);
  if (!lineup) return null;

  // Fetch season stats + H2H for all batters in parallel
  await Promise.all([
    ...lineup.away.lineup.map(async batter => {
      const [season, h2h] = await Promise.all([
        getBatterSeasonStats(batter.id),
        homePitcherId ? getBatterVsPitcher(batter.id, homePitcherId) : null
      ]);
      batter.season = season;
      batter.h2h    = h2h;
    }),
    ...lineup.home.lineup.map(async batter => {
      const [season, h2h] = await Promise.all([
        getBatterSeasonStats(batter.id),
        awayPitcherId ? getBatterVsPitcher(batter.id, awayPitcherId) : null
      ]);
      batter.season = season;
      batter.h2h    = h2h;
    })
  ]);

  return lineup;
}

// ── Pitcher Recent Starts (game log) ─────────────────────────────────────────
async function getPitcherRecentStarts(id, n = 5) {
  if (!id) return [];
  const data = await safeFetch(
    `${BASE}/people/${id}/stats?stats=gameLog&group=pitching&season=${SEASON}`
  );
  const splits = data?.stats?.[0]?.splits || [];
  return splits
    .filter(s => (s.stat?.gamesStarted ?? 0) > 0 || (parseFloat(s.stat?.inningsPitched) || 0) >= 3)
    .slice(-n)
    .map(s => ({
      date:        s.date,
      opponent:    s.opponent?.name || '',
      strikeOuts:  s.stat?.strikeOuts ?? 0,
      ip:          s.stat?.inningsPitched ?? '0.0',
      hits:        s.stat?.hits ?? 0,
      walks:       s.stat?.baseOnBalls ?? 0,
      earnedRuns:  s.stat?.earnedRuns ?? 0
    }));
}

async function fetchAllPitcherRecentStarts(ids, n = 5) {
  const map = {};
  await Promise.all(ids.map(async id => { map[id] = await getPitcherRecentStarts(id, n); }));
  return map;
}

module.exports = {
  getTodaySchedule,
  fetchAllPitcherStats,
  fetchAllTeamStats,
  getStandings,
  fetchAllRecentGames,
  fetchAllBullpenUsage,
  getEnrichedLineup,
  fetchAllPitcherRecentStarts
};
