import { z } from "zod";
import { getJson } from "../http";
import type { Provider, ProviderHealth } from "../types";

/**
 * Open-Meteo hourly forecasts. Keyless, and it accepts many coordinates in one request,
 * so a whole week's outdoor slate costs a single subrequest.
 *
 * SPEC section 5 lists OpenWeather as optional; Open-Meteo is primary because it needs
 * no key. Only outdoor and open-roof games are ever looked up.
 */

const forecastSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(z.number().nullable()),
    wind_speed_10m: z.array(z.number().nullable()),
    precipitation_probability: z.array(z.number().nullable()),
  }),
});

const responseSchema = z.union([forecastSchema, z.array(forecastSchema)]);

export interface WeatherPoint {
  tempF: number | null;
  windMph: number | null;
  /** 0-1, not a percentage. */
  precipProb: number | null;
}

export interface WeatherRequest {
  key: string;
  lat: number;
  lng: number;
  /** Local Eastern kickoff, "YYYY-MM-DDTHH:mm", matching nflverse. */
  kickoff: string;
}

export class OpenMeteoProvider implements Provider {
  readonly name = "open-meteo";

  constructor(private readonly now: () => Date) {}

  async health(): Promise<ProviderHealth> {
    const asOf = this.now().toISOString();
    try {
      await this.forecast([{ key: "probe", lat: 39.048, lng: -94.484, kickoff: "" }]);
      return { name: this.name, ok: true, asOf };
    } catch (err) {
      return {
        name: this.name,
        ok: false,
        asOf,
        note: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * One request for every location. The date window is narrowed to the days actually
   * needed so the response stays small enough to parse inside the CPU budget.
   */
  async forecast(requests: readonly WeatherRequest[]): Promise<Map<string, WeatherPoint>> {
    const out = new Map<string, WeatherPoint>();
    if (requests.length === 0) return out;

    const days = requests
      .map((r) => r.kickoff.slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    const startDate = days[0];
    const endDate = days[days.length - 1];

    const params = new URLSearchParams({
      latitude: requests.map((r) => r.lat.toFixed(4)).join(","),
      longitude: requests.map((r) => r.lng.toFixed(4)).join(","),
      hourly: "temperature_2m,wind_speed_10m,precipitation_probability",
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
      timezone: "America/New_York",
    });
    if (startDate && endDate) {
      params.set("start_date", startDate);
      params.set("end_date", endDate);
    }

    const raw = await getJson<unknown>(
      {
        provider: this.name,
        url: `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
        cacheTtlSec: 3 * 3600,
      },
      this.now(),
    );

    const parsed = responseSchema.parse(raw);
    // A single coordinate returns an object; several return an array.
    const list = Array.isArray(parsed) ? parsed : [parsed];

    requests.forEach((req, i) => {
      const f = list[i];
      if (!f) return;
      const hourKey = `${req.kickoff.slice(0, 13)}:00`;
      let idx = f.hourly.time.indexOf(hourKey);
      // Kickoff times are on the hour, but fall back to the nearest listed hour.
      if (idx < 0) idx = nearestHourIndex(f.hourly.time, req.kickoff);
      if (idx < 0) return;

      const precip = f.hourly.precipitation_probability[idx];
      out.set(req.key, {
        tempF: f.hourly.temperature_2m[idx] ?? null,
        windMph: f.hourly.wind_speed_10m[idx] ?? null,
        precipProb: precip === null || precip === undefined ? null : precip / 100,
      });
    });

    return out;
  }
}

function nearestHourIndex(times: readonly string[], kickoff: string): number {
  const target = Date.parse(`${kickoff}:00`);
  if (Number.isNaN(target)) return -1;
  let best = -1;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < times.length; i++) {
    const t = Date.parse(`${times[i]}:00`);
    if (Number.isNaN(t)) continue;
    const delta = Math.abs(t - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  // Beyond a few hours the forecast is not describing this game.
  return bestDelta <= 3 * 3600 * 1000 ? best : -1;
}
