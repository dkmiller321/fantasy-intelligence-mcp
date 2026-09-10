import stadiums from "../data/stadiums.json";
import type { Env } from "../env";
import { OpenMeteoProvider, type WeatherRequest } from "../providers/weather/openmeteo";

interface UpcomingGame {
  id: string;
  home: string;
  kickoff: string | null;
  roof: string | null;
}

/** Domes and closed roofs are never looked up; the weather does not reach the field. */
function isOutdoor(roof: string | null): boolean {
  return roof === "outdoors" || roof === "open";
}

/**
 * Forecast every upcoming outdoor game in one request and store it on the game row.
 *
 * Small enough for a Worker cron: one subrequest, and the response is narrowed to the
 * days actually being played (DECISIONS D13 keeps the large jobs out of here).
 */
export async function syncWeather(env: Env, now: Date): Promise<number> {
  const coords = stadiums as Record<string, { venue: string; lat: number; lng: number }>;

  // Open-Meteo forecasts roughly a fortnight ahead; anything further is not yet knowable.
  const horizon = new Date(now.getTime() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const res = await env.DB.prepare(
    `SELECT id, home, kickoff, roof FROM games
     WHERE kickoff IS NOT NULL
       AND substr(kickoff, 1, 10) >= ?
       AND substr(kickoff, 1, 10) <= ?
     ORDER BY kickoff`,
  )
    .bind(today, horizon)
    .all<UpcomingGame>();

  const requests: WeatherRequest[] = [];
  for (const g of res.results) {
    if (!isOutdoor(g.roof) || !g.kickoff) continue;
    const venue = coords[g.home];
    if (!venue) continue;
    requests.push({ key: g.id, lat: venue.lat, lng: venue.lng, kickoff: g.kickoff });
  }
  if (requests.length === 0) return 0;

  const provider = new OpenMeteoProvider(() => now);
  const forecasts = await provider.forecast(requests);
  if (forecasts.size === 0) return 0;

  const asOf = now.toISOString();
  const stmt = env.DB.prepare(
    `UPDATE games SET temp_f = ?, wind_mph = ?, precip_prob = ?, weather_as_of = ?
     WHERE id = ?`,
  );
  const batch = [...forecasts.entries()].map(([id, w]) =>
    stmt.bind(w.tempF, w.windMph, w.precipProb, asOf, id),
  );
  await env.DB.batch(batch);
  return batch.length;
}
