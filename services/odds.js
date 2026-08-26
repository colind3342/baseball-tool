const fetch = require('node-fetch');

const BASE = 'https://api.the-odds-api.com/v4';

function oddsToImpliedProb(american) {
  if (!american) return null;
  if (american < 0) return Math.abs(american) / (Math.abs(american) + 100);
  return 100 / (american + 100);
}

function formatOdds(n) {
  if (!n && n !== 0) return '—';
  return n > 0 ? `+${n}` : `${n}`;
}

async function getMLBOdds(apiKey) {
  try {
    const url = `${BASE}/sports/baseball_mlb/odds/?apiKey=${apiKey}` +
      `&regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm,williamhill_us,betrivers,pointsbetus,bovada`;

    const res = await fetch(url);

    // Log remaining quota
    const remaining = res.headers.get('x-requests-remaining');
    if (remaining) console.log(`Odds API requests remaining: ${remaining}`);

    if (!res.ok) {
      console.error('Odds API error:', res.status, await res.text());
      return {};
    }

    const games = await res.json();
    const oddsMap = {};

    for (const game of games) {
      // Build per-book markets
      const books = {};
      for (const bm of (game.bookmakers || [])) {
        const h2h     = bm.markets.find(m => m.key === 'h2h');
        const spreads = bm.markets.find(m => m.key === 'spreads');
        const totals  = bm.markets.find(m => m.key === 'totals');

        books[bm.key] = {
          title: bm.title,
          ml: {
            away: h2h?.outcomes.find(o => o.name === game.away_team)?.price ?? null,
            home: h2h?.outcomes.find(o => o.name === game.home_team)?.price ?? null
          },
          rl: {
            awayLine: spreads?.outcomes.find(o => o.name === game.away_team)?.point ?? null,
            awayOdds: spreads?.outcomes.find(o => o.name === game.away_team)?.price ?? null,
            homeOdds: spreads?.outcomes.find(o => o.name === game.home_team)?.price ?? null
          },
          total: {
            line:      totals?.outcomes[0]?.point ?? null,
            overOdds:  totals?.outcomes.find(o => o.name === 'Over')?.price ?? null,
            underOdds: totals?.outcomes.find(o => o.name === 'Under')?.price ?? null
          }
        };
      }

      // Compute consensus ML (average implied prob across books)
      const awayProbs = Object.values(books)
        .map(b => oddsToImpliedProb(b.ml.away)).filter(Boolean);
      const homeProbs = Object.values(books)
        .map(b => oddsToImpliedProb(b.ml.home)).filter(Boolean);

      const avgAwayProb = awayProbs.length ? awayProbs.reduce((a, b) => a + b, 0) / awayProbs.length : null;
      const avgHomeProb = homeProbs.length ? homeProbs.reduce((a, b) => a + b, 0) / homeProbs.length : null;

      // Best ML (lowest implied prob = best price for bettor)
      const bestAway = awayProbs.length ? Math.min(...awayProbs) : null;
      const bestHome = homeProbs.length ? Math.min(...homeProbs) : null;

      // Line discrepancy — flag if spread >= 3pp across books
      const awaySpread = awayProbs.length >= 2 ? Math.max(...awayProbs) - Math.min(...awayProbs) : 0;
      const homeSpread = homeProbs.length >= 2 ? Math.max(...homeProbs) - Math.min(...homeProbs) : 0;

      // Best total line
      const allTotals = Object.values(books).map(b => b.total.line).filter(Boolean);
      const avgTotal  = allTotals.length ? (allTotals.reduce((a, b) => a + b, 0) / allTotals.length).toFixed(1) : null;

      oddsMap[game.id] = {
        oddsApiId:    game.id,
        commenceTime: game.commence_time,
        awayTeam:     game.away_team,
        homeTeam:     game.home_team,
        books,
        consensus: {
          awayProb:    avgAwayProb,
          homeProb:    avgHomeProb,
          bestAway,
          bestHome,
          awaySpread,
          homeSpread,
          avgTotal,
          hasValue: awaySpread >= 0.03 || homeSpread >= 0.03
        }
      };
    }

    return oddsMap;
  } catch (e) {
    console.error('getMLBOdds error:', e.message);
    return {};
  }
}

module.exports = { getMLBOdds, oddsToImpliedProb, formatOdds };
