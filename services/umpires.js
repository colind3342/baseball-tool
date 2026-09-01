'use strict';

/**
 * Umpire K-rate adjustments: Ks above/below league average per 9 innings.
 * Positive = wider zone (more strikeouts), Negative = tighter zone (fewer).
 * Values are directional estimates based on multi-season umpire scorecard analysis.
 * Update these from UmpScorecards.com at the start of each season.
 */
const UMPIRE_ADJ = {
  // Wide zone — more Ks
  'CB Bucknor':           1.1,
  'Ron Kulpa':            0.9,
  'Mark Wegner':          0.7,
  'Bill Miller':          0.6,
  'Hunter Wendelstedt':   0.6,
  'Tim Timmons':          0.6,
  'Marvin Hudson':        0.5,
  'Phil Cuzzi':           0.4,
  'Ryan Blakney':         0.4,
  'Adam Hamari':          0.3,
  'Pat Hoberg':           0.4,
  'Mike Muchlinski':      0.3,
  'Malachi Moore':        0.3,

  // Near average
  'Jerry Meals':          0.2,
  'Brian Knight':         0.2,
  'Roberto Ortiz':        0.2,
  'Chris Conroy':         0.1,
  'Erich Bacchus':        0.2,
  'Nic Lentz':            0.1,
  'Quinn Wolcott':        0.0,
  'Scott Barry':          0.0,
  'Ted Barrett':          0.1,
  'Jordan Baker':         0.2,
  'David Rackley':        0.2,
  'Brennan Miller':       0.2,
  'Junior Valentine':     0.2,
  'Edwin Moscoso':       -0.2,
  'Lance Barrett':       -0.2,
  'D.J. Reyburn':        -0.1,
  'Laz Diaz':            -0.2,
  'Gabe Morales':        -0.2,

  // Tight zone — fewer Ks
  'Alfonso Marquez':     -0.3,
  'Vic Carapazza':       -0.4,
  'John Tumpane':        -0.3,
  'Brian Gorman':        -0.4,
  'Greg Gibson':         -0.4,
  'Mike DiMuro':         -0.5,
  'Dan Iassogna':        -0.5,
  'Jim Reynolds':        -0.7,
  'Fieldin Culbreth':    -0.9
};

/**
 * Return the K/9 adjustment for a given umpire name.
 * Tries exact match, then last-name fuzzy match.
 * Returns 0 (league average) if unknown.
 */
function getUmpireAdj(name) {
  if (!name) return 0;

  if (UMPIRE_ADJ[name] !== undefined) return UMPIRE_ADJ[name];

  // Last-name fuzzy match
  const lastName = name.split(' ').pop().toLowerCase();
  const match    = Object.entries(UMPIRE_ADJ).find(([k]) =>
    k.split(' ').pop().toLowerCase() === lastName
  );
  return match ? match[1] : 0;
}

module.exports = { getUmpireAdj, UMPIRE_ADJ };
