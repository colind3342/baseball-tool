const fetch = require('node-fetch');
const { PARK_DATA } = require('./parkFactors');

const WMO_CODES = {
  0: 'Clear', 1: 'Mainly Clear', 2: 'Partly Cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Fog', 51: 'Light Drizzle', 53: 'Drizzle', 55: 'Heavy Drizzle',
  61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain',
  71: 'Light Snow', 73: 'Snow', 75: 'Heavy Snow',
  80: 'Showers', 81: 'Showers', 82: 'Heavy Showers',
  95: 'Thunderstorm', 96: 'T-Storm + Hail', 99: 'T-Storm + Heavy Hail'
};

const WIND_DIRS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

function windDirectionText(deg) {
  return WIND_DIRS[Math.round(deg / 22.5) % 16];
}

function weatherIcon(code) {
  if (code === 0 || code === 1) return '☀️';
  if (code === 2)               return '⛅';
  if (code === 3)               return '☁️';
  if (code <= 55)               return '🌧️';
  if (code <= 65)               return '🌧️';
  if (code <= 77)               return '❄️';
  if (code <= 82)               return '🌦️';
  return '⛈️';
}

async function getWeatherForGame(venueName, gameTimeUTC) {
  try {
    // Find coordinates — try exact match then partial
    const parkKey = Object.keys(PARK_DATA).find(k =>
      k === venueName ||
      (venueName && venueName.toLowerCase().includes(k.toLowerCase()))
    );
    if (!parkKey) return null;

    const { lat, lon } = PARK_DATA[parkKey];
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,windspeed_10m,winddirection_10m,precipitation_probability,weathercode` +
      `&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=auto&forecast_days=3`;

    const res = await fetch(url);
    const data = await res.json();
    if (!data.hourly) return null;

    // Find closest hour to game time
    const gameMs = new Date(gameTimeUTC).getTime();
    let idx = 0;
    let closest = Infinity;
    data.hourly.time.forEach((t, i) => {
      const diff = Math.abs(new Date(t).getTime() - gameMs);
      if (diff < closest) { closest = diff; idx = i; }
    });

    const temp       = Math.round(data.hourly.temperature_2m[idx]);
    const windSpeed  = Math.round(data.hourly.windspeed_10m[idx]);
    const windDeg    = data.hourly.winddirection_10m[idx];
    const precipProb = data.hourly.precipitation_probability[idx];
    const code       = data.hourly.weathercode[idx];

    return {
      temp,
      windSpeed,
      windDeg,
      windDir:   windDirectionText(windDeg),
      precipProb,
      condition: WMO_CODES[code] || 'Unknown',
      icon:      weatherIcon(code),
      // betting flags
      strongWind:  windSpeed >= 12,
      rainRisk:    precipProb >= 40,
      domeOrRoof:  ['Rogers Centre', 'Chase Field', 'Tropicana Field', 'Minute Maid Park',
                    'American Family Field', 'loanDepot park'].includes(venueName)
    };
  } catch (e) {
    console.error('Weather error:', e.message);
    return null;
  }
}

module.exports = { getWeatherForGame };
