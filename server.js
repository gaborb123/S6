import express from 'express';
import cors from 'cors';
import { createClient } from 'db-vendo-client';
import { profile as dbProfile } from 'db-vendo-client/p/dbweb/index.js';

const client = createClient(dbProfile, 's6-tracker-gabor/1.0');
const app = express();
app.use(cors());
app.use(express.static('.'));

const STOP_NAMES = { volksgarten: 'Düsseldorf-Volksgarten', essen: 'Essen Hbf' };
let stopIds = {};
let lastTrainCache = {}; // { 've': { date, time }, 'ev': { date, time } }

function isS6(line) {
  return !!(line && line.name && line.name.replace(/\s+/g, '').toUpperCase() === 'S6');
}

// Wrap any promise with a timeout so a slow upstream call can never hang the request forever.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Zeitüberschreitung: ${label}`)), ms))
  ]);
}

async function resolveStop(name) {
  const results = await withTimeout(client.locations(name, { results: 5, poi: false, addresses: false }), 8000, 'Stationssuche');
  const hit = results.find(r => r.type === 'stop' || r.type === 'station');
  if (!hit) throw new Error(`Station "${name}" nicht gefunden`);
  return hit.id;
}

async function ensureStops() {
  if (stopIds.volksgarten && stopIds.essen) return;
  const [vg, es] = await Promise.all([
    resolveStop(STOP_NAMES.volksgarten),
    resolveStop(STOP_NAMES.essen)
  ]);
  stopIds.volksgarten = vg;
  stopIds.essen = es;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Determine the last scheduled S6 departure today, cached once per day per direction.
async function getLastTrainToday(fromId, toId, dirKey) {
  const today = todayKey();
  if (lastTrainCache[dirKey] && lastTrainCache[dirKey].date === today) {
    return lastTrainCache[dirKey].time;
  }
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(23, 59, 0, 0);
  const minutesLeft = Math.max(10, Math.round((midnight - now) / 60000));

  const departures = await withTimeout(client.departures(fromId, {
    direction: toId,
    duration: minutesLeft,
    results: 200,
    products: { suburban: true, subway: false, tram: false, bus: false, ferry: false, express: false, regional: false }
  }), 8000, 'Tagesübersicht');
  const deps = (departures.departures || departures).filter(d => isS6(d.line) && !d.cancelled);
  if (!deps.length) return null;
  const last = deps.reduce((a, b) => new Date(a.plannedWhen || a.when) > new Date(b.plannedWhen || b.when) ? a : b);
  const time = last.plannedWhen || last.when;
  lastTrainCache[dirKey] = { date: today, time };
  return time;
}

async function fetchTripSafe(dep, fromKeyword, toKeyword) {
  try {
    const tripRes = await withTimeout(client.trip(dep.tripId, { stopovers: true }), 6000, 'Zugdetails');
    const trip = tripRes.trip || tripRes;
    const stopovers = (trip.stopovers || []).map(s => ({
      name: s.stop ? s.stop.name : null,
      arrival: s.arrival, departure: s.departure,
      arrivalDelay: s.arrivalDelay, departureDelay: s.departureDelay,
      cancelled: !!s.cancelled
    }));
    let sIdx = stopovers.findIndex(s => s.name && s.name.includes(fromKeyword));
    let eIdx = stopovers.findIndex(s => s.name && s.name.includes(toKeyword));
    if (sIdx === -1) sIdx = 0;
    if (eIdx === -1) eIdx = stopovers.length - 1;
    const lo = Math.min(sIdx, eIdx), hi = Math.max(sIdx, eIdx);
    return { tripId: dep.tripId, direction: dep.direction, stopovers: stopovers.slice(lo, hi + 1) };
  } catch (e) {
    return null; // skip a trip we couldn't fetch in time, keep the rest
  }
}

app.get('/api/board', async (req, res) => {
  try {
    await withTimeout(ensureStops(), 10000, 'Stationsauflösung');
    const direction = req.query.direction === 'ev' ? 'ev' : 've';
    const fromId = direction === 've' ? stopIds.volksgarten : stopIds.essen;
    const toId = direction === 've' ? stopIds.essen : stopIds.volksgarten;
    const fromKeyword = direction === 've' ? 'Volksgarten' : 'Essen';
    const toKeyword = direction === 've' ? 'Essen' : 'Volksgarten';

    const departures = await withTimeout(client.departures(fromId, {
      direction: toId,
      duration: 100,
      results: 20,
      products: { suburban: true, subway: false, tram: false, bus: false, ferry: false, express: false, regional: false }
    }), 8000, 'Abfahrten');

    const deps = (departures.departures || departures).filter(d => isS6(d.line));
    const cancelled = deps.filter(d => d.cancelled);
    const live = deps.filter(d => !d.cancelled).slice(0, 4);

    // Fetch all trip details in parallel instead of one after another.
    const tripResults = await Promise.all(live.map(dep => fetchTripSafe(dep, fromKeyword, toKeyword)));
    const trips = tripResults.filter(Boolean);

    // Last-train-of-the-day lookup runs but must never block or break the response.
    const lastTrainToday = await getLastTrainToday(fromId, toId, direction).catch(() => null);

    res.json({
      generatedAt: new Date().toISOString(),
      direction,
      lastTrainToday,
      cancelled: cancelled.map(c => ({ direction: c.direction, when: c.when, plannedWhen: c.plannedWhen })),
      trips
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('S6-Tracker läuft auf Port ' + PORT));
