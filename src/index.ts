/**
 * Yr Rain Notifier — Cloudflare Worker
 *
 * Polls the Yr/MET Norway Nowcast API every 5 minutes and sends push
 * notifications via ntfy.sh when:
 *   • It is currently dry but rain is forecast within the next 90 min
 *   • It is currently raining but a dry window (≥ DRY_WINDOW_MIN) is forecast
 *
 * State is persisted in Cloudflare KV so duplicate notifications are suppressed.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Env {
  RAIN_STATE: KVNamespace;
  LAT: string;
  LON: string;
  NTFY_TOPIC: string;
  NTFY_BASE_URL: string;
  PRECIP_THRESHOLD: string; // mm/h, below this = "dry"
  DRY_WINDOW_MIN: string;   // min consecutive dry minutes to count as a dry window
  DEDUP_WINDOW_MIN: string; // suppress same notification type within this window
  LOCATION_URL: string;     // URL opened when notification is tapped
}

interface NowcastTimestep {
  time: string;
  data: {
    instant: {
      details: {
        precipitation_rate?: number;
        air_temperature?: number;
        wind_speed?: number;
      };
    };
    next_1_hours?: {
      summary: { symbol_code: string };
      details: { precipitation_amount?: number };
    };
  };
}

interface NowcastResponse {
  properties: {
    meta: { updated_at: string };
    timeseries: NowcastTimestep[];
  };
}

interface Timestep {
  time: Date;
  minutesFromNow: number;
  precipRate: number; // mm/h
}

type NotificationType = "rain_starting" | "rain_stopping";

interface PersistedState {
  wasRaining: boolean;
  lastNotifications: Partial<Record<NotificationType, string>>; // type → ISO timestamp
}

interface NotificationPayload {
  type: NotificationType;
  title: string;
  body: string;
  tags: string[];
  priority: "default" | "high";
}

// ---------------------------------------------------------------------------
// Worker entry points
// ---------------------------------------------------------------------------

export default {
  // Cron trigger — runs every 5 minutes
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(checkRain(env));
  },

  // HTTP handler — useful for manual triggers and health checks
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const state = await loadState(env.RAIN_STATE);
      return Response.json({ ok: true, state });
    }

    if (url.pathname === "/trigger" && request.method === "POST") {
      await checkRain(env);
      return Response.json({ ok: true, message: "Check triggered" });
    }

    return new Response("yr-rain-notifier\nGET /health  POST /trigger\n", { status: 200 });
  },
};

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function checkRain(env: Env): Promise<void> {
  const threshold = parseFloat(env.PRECIP_THRESHOLD);
  const dryWindowMin = parseInt(env.DRY_WINDOW_MIN, 10);
  const dedupWindowMin = parseInt(env.DEDUP_WINDOW_MIN, 10);

  // Fetch nowcast and load persisted state in parallel
  const [series, state] = await Promise.all([
    fetchNowcast(env.LAT, env.LON),
    loadState(env.RAIN_STATE),
  ]);

  const now = new Date();
  const currentRate = series[0]?.precipRate ?? 0;
  const isRainingNow = currentRate > threshold;

  let notification: NotificationPayload | null = null;

  if (isRainingNow) {
    // Currently raining — look for an upcoming dry window
    const dryWindow = findDryWindow(series, threshold, dryWindowMin);
    if (dryWindow && !isDuplicate(state, "rain_stopping", dedupWindowMin, now)) {
      const startsIn = Math.round(dryWindow.start.minutesFromNow);
      const duration = dryWindow.durationMinutes;
      notification = {
        type: "rain_stopping",
        title: `Opphold om ${startsIn} min ☀️`,
        body: `Tørt i minst ${duration} min`,
        tags: ["partly_sunny_rain"],
        priority: "default",
      };
    }
  } else {
    // Currently dry — look for upcoming rain
    const rainStart = findRainStart(series, threshold);
    if (rainStart && !isDuplicate(state, "rain_starting", dedupWindowMin, now)) {
      const startsIn = Math.round(rainStart.minutesFromNow);
      const rate = rainStart.precipRate.toFixed(1);
      notification = {
        type: "rain_starting",
        title: "Regn på vei 🌧️",
        body: `Regn starter om ca. ${startsIn} min (${rate} mm/t)`,
        tags: ["rain_cloud"],
        priority: "high",
      };
    }
  }

  // Persist updated state (always keep wasRaining current)
  const newState: PersistedState = {
    wasRaining: isRainingNow,
    lastNotifications: { ...state.lastNotifications },
  };

  if (notification) {
    await sendNtfy(env, notification);
    newState.lastNotifications[notification.type] = now.toISOString();
  }

  await saveState(env.RAIN_STATE, newState);
}

// ---------------------------------------------------------------------------
// Nowcast API
// ---------------------------------------------------------------------------

async function fetchNowcast(lat: string, lon: string): Promise<Timestep[]> {
  const url = `https://api.met.no/weatherapi/nowcast/2.0/complete?lat=${lat}&lon=${lon}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "yr-rain-notifier/1.0 (github.com/okms/yr-90min-notifier)",
    },
  });

  if (!resp.ok) {
    throw new Error(`Nowcast API error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as NowcastResponse;
  const now = Date.now();

  return data.properties.timeseries.map((ts) => {
    const time = new Date(ts.time);
    return {
      time,
      minutesFromNow: (time.getTime() - now) / 60_000,
      precipRate: ts.data.instant.details.precipitation_rate ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Rain analysis
// ---------------------------------------------------------------------------

/** Returns the first upcoming timestep where precipitation starts, or null. */
function findRainStart(series: Timestep[], threshold: number): Timestep | null {
  for (const ts of series) {
    if (ts.precipRate > threshold) return ts;
  }
  return null;
}

/**
 * Returns the first dry window of at least `minDryMinutes` consecutive dry
 * timesteps, or null.  Only looks at future timesteps (minutesFromNow ≥ 0).
 */
function findDryWindow(
  series: Timestep[],
  threshold: number,
  minDryMinutes: number,
): { start: Timestep; durationMinutes: number } | null {
  const INTERVAL_MIN = 5; // Nowcast resolution
  const requiredSteps = Math.ceil(minDryMinutes / INTERVAL_MIN);

  let dryRun: Timestep[] = [];

  for (const ts of series) {
    if (ts.minutesFromNow < 0) continue; // skip past timesteps

    if (ts.precipRate <= threshold) {
      dryRun.push(ts);
      if (dryRun.length >= requiredSteps) {
        return {
          start: dryRun[0],
          durationMinutes: dryRun.length * INTERVAL_MIN,
        };
      }
    } else {
      dryRun = [];
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// KV state persistence
// ---------------------------------------------------------------------------

const STATE_KEY = "rain-state-v1";

async function loadState(kv: KVNamespace): Promise<PersistedState> {
  const raw = await kv.get(STATE_KEY, "json");
  if (raw && typeof raw === "object") return raw as PersistedState;
  return { wasRaining: false, lastNotifications: {} };
}

async function saveState(kv: KVNamespace, state: PersistedState): Promise<void> {
  await kv.put(STATE_KEY, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Returns true if a notification of the given type was already sent within
 * the dedup window, so we should skip sending again.
 */
function isDuplicate(
  state: PersistedState,
  type: NotificationType,
  dedupWindowMin: number,
  now: Date,
): boolean {
  const last = state.lastNotifications[type];
  if (!last) return false;
  const ageMin = (now.getTime() - new Date(last).getTime()) / 60_000;
  return ageMin < dedupWindowMin;
}

// ---------------------------------------------------------------------------
// ntfy.sh notifications
// ---------------------------------------------------------------------------

async function sendNtfy(env: Env, payload: NotificationPayload): Promise<void> {
  const url = `${env.NTFY_BASE_URL}/${env.NTFY_TOPIC}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Title": payload.title,
      "X-Priority": payload.priority === "high" ? "4" : "3",
      "X-Tags": payload.tags.join(","),
      "X-Click": env.LOCATION_URL,
    },
    body: payload.body,
  });

  if (!resp.ok) {
    throw new Error(`ntfy error: ${resp.status} ${resp.statusText}`);
  }
}
