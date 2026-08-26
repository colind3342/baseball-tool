const PARK_DATA = {
  'Coors Field':                     { runFactor: 1.28, hrFactor: 1.33, lat: 39.7559,  lon: -104.9942 },
  'Great American Ball Park':        { runFactor: 1.12, hrFactor: 1.16, lat: 39.0979,  lon: -84.5088  },
  'Globe Life Field':                { runFactor: 1.09, hrFactor: 1.12, lat: 32.7473,  lon: -97.0836  },
  'Fenway Park':                     { runFactor: 1.06, hrFactor: 0.97, lat: 42.3467,  lon: -71.0972  },
  'Wrigley Field':                   { runFactor: 1.05, hrFactor: 1.08, lat: 41.9484,  lon: -87.6553  },
  'Yankee Stadium':                  { runFactor: 1.05, hrFactor: 1.15, lat: 40.8296,  lon: -73.9262  },
  'Chase Field':                     { runFactor: 1.04, hrFactor: 1.08, lat: 33.4453,  lon: -112.0667 },
  'Citizens Bank Park':              { runFactor: 1.04, hrFactor: 1.10, lat: 39.9061,  lon: -75.1665  },
  'Rogers Centre':                   { runFactor: 1.02, hrFactor: 1.08, lat: 43.6414,  lon: -79.3894  },
  'Truist Park':                     { runFactor: 1.00, hrFactor: 1.01, lat: 33.8907,  lon: -84.4677  },
  'Nationals Park':                  { runFactor: 1.00, hrFactor: 1.00, lat: 38.8730,  lon: -77.0074  },
  'Oriole Park at Camden Yards':     { runFactor: 1.01, hrFactor: 1.05, lat: 39.2838,  lon: -76.6216  },
  'Progressive Field':               { runFactor: 0.99, hrFactor: 1.02, lat: 41.4962,  lon: -81.6852  },
  'Minute Maid Park':                { runFactor: 0.99, hrFactor: 0.98, lat: 29.7572,  lon: -95.3555  },
  'Guaranteed Rate Field':           { runFactor: 0.97, hrFactor: 1.02, lat: 41.8300,  lon: -87.6338  },
  'Kauffman Stadium':                { runFactor: 0.97, hrFactor: 0.92, lat: 39.0517,  lon: -94.4803  },
  'American Family Field':           { runFactor: 0.98, hrFactor: 0.97, lat: 43.0280,  lon: -87.9712  },
  'Angel Stadium':                   { runFactor: 0.97, hrFactor: 0.97, lat: 33.8003,  lon: -117.8827 },
  'PNC Park':                        { runFactor: 0.97, hrFactor: 0.98, lat: 40.4469,  lon: -80.0057  },
  'Target Field':                    { runFactor: 0.96, hrFactor: 0.95, lat: 44.9817,  lon: -93.2781  },
  'Comerica Park':                   { runFactor: 0.94, hrFactor: 0.88, lat: 42.3390,  lon: -83.0485  },
  'Oracle Park':                     { runFactor: 0.93, hrFactor: 0.82, lat: 37.7786,  lon: -122.3893 },
  'Tropicana Field':                 { runFactor: 0.93, hrFactor: 0.87, lat: 27.7683,  lon: -82.6534  },
  'T-Mobile Park':                   { runFactor: 0.93, hrFactor: 0.90, lat: 47.5914,  lon: -122.3326 },
  'Petco Park':                      { runFactor: 0.94, hrFactor: 0.90, lat: 32.7076,  lon: -117.1570 },
  'Dodger Stadium':                  { runFactor: 0.96, hrFactor: 0.92, lat: 34.0739,  lon: -118.2400 },
  'Citi Field':                      { runFactor: 0.97, hrFactor: 0.94, lat: 40.7571,  lon: -73.8458  },
  'Busch Stadium':                   { runFactor: 0.95, hrFactor: 0.90, lat: 38.6226,  lon: -90.1928  },
  'loanDepot park':                  { runFactor: 0.92, hrFactor: 0.88, lat: 25.7781,  lon: -80.2197  },
  'Sutter Health Park':              { runFactor: 0.98, hrFactor: 0.95, lat: 38.5807,  lon: -121.5006 },
  'Oakland Coliseum':                { runFactor: 0.93, hrFactor: 0.88, lat: 37.7516,  lon: -122.2005 }
};

function getParkFactor(venueName) {
  if (!venueName) return { runFactor: 1.00, hrFactor: 1.00 };
  if (PARK_DATA[venueName]) return PARK_DATA[venueName];

  // Fuzzy match on partial name
  const lower = venueName.toLowerCase();
  const key = Object.keys(PARK_DATA).find(k =>
    lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)
  );
  return key ? PARK_DATA[key] : { runFactor: 1.00, hrFactor: 1.00 };
}

function getParkLabel(runFactor) {
  if (runFactor >= 1.10) return { label: "Extreme Hitter's Park", cls: 'park-hitter-extreme' };
  if (runFactor >= 1.04) return { label: "Hitter's Park",         cls: 'park-hitter'         };
  if (runFactor >= 0.97) return { label: 'Neutral Park',          cls: 'park-neutral'         };
  if (runFactor >= 0.93) return { label: "Pitcher's Park",        cls: 'park-pitcher'         };
  return                        { label: "Extreme Pitcher's Park", cls: 'park-pitcher-extreme' };
}

module.exports = { getParkFactor, getParkLabel, PARK_DATA };
