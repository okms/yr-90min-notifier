# yr-rain-notifier

A Cloudflare Worker that polls the [Yr/MET Norway Nowcast API](https://api.met.no/weatherapi/nowcast/2.0/documentation) every 5 minutes and sends push notifications via [ntfy.sh](https://ntfy.sh) when:

- **Rain is approaching** — currently dry, but rain is forecast within the next 90 minutes
- **Rain is clearing** — currently raining, but a dry window (≥ 15 min) is forecast

State is persisted in Cloudflare KV so duplicate notifications are suppressed (default: no repeat within 30 minutes for the same event type).

---

## Architecture

```
Cloudflare Worker (cron: */5 * * * *)
        │
        ▼
api.met.no/nowcast?lat=…&lon=…  (5-min intervals, 90 min horizon)
        │
        ▼
  Rain state machine
  • raining now?          precipRate > PRECIP_THRESHOLD
  • rain starting in X?   first rainy timestep in series
  • dry window ≥ Y min?   first consecutive dry run ≥ DRY_WINDOW_MIN
        │
        ▼
  Cloudflare KV  ◄── deduplication (suppress same type < DEDUP_WINDOW_MIN)
        │
        ▼ (new event only)
  ntfy.sh topic  ──► iPhone / Mac / Windows (ntfy app)
```

---

## Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org) ≥ 18
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- The [ntfy app](https://ntfy.sh) installed on your devices (iOS, Android, Windows, macOS, Linux — all free)

```bash
npm install -g wrangler
wrangler login
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create the KV namespace

```bash
# Production namespace
wrangler kv:namespace create RAIN_STATE

# Preview namespace (for wrangler dev)
wrangler kv:namespace create RAIN_STATE --preview
```

Copy the `id` and `preview_id` values printed and paste them into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RAIN_STATE"
id     = "paste-id-here"
preview_id = "paste-preview-id-here"
```

### 4. Configure your location and ntfy topic

Edit `wrangler.toml` — the `[vars]` section:

```toml
[vars]
LAT = "59.9133"          # your latitude
LON = "10.7389"          # your longitude
NTFY_TOPIC = "yr-rain-oslo-abc123xyz"  # pick something unguessable
```

> **Tip:** The ntfy topic is a shared secret — anyone who knows it can subscribe and receive your notifications. Pick a random string, e.g. `yr-rain-oslo-$(openssl rand -hex 8)`.

### 5. Subscribe on your devices

Open the ntfy app (or [ntfy.sh](https://ntfy.sh) in a browser) and subscribe to your topic:

```
https://ntfy.sh/yr-rain-oslo-abc123xyz
```

Everyone in your household can subscribe to the same topic — no accounts or sign-up needed.

### 6. Tune thresholds (optional)

In `wrangler.toml`:

| Variable | Default | Description |
|---|---|---|
| `PRECIP_THRESHOLD` | `0.1` | mm/h below which a timestep is "dry" |
| `DRY_WINDOW_MIN` | `15` | consecutive dry minutes to trigger a "clearing" notification |
| `DEDUP_WINDOW_MIN` | `30` | minutes before the same notification type can repeat |

### 7. Deploy

```bash
wrangler deploy
```

The worker will immediately start running on the cron schedule (`*/5 * * * *`).

---

## Manual trigger / health check

Once deployed:

```bash
# Check current persisted state
curl https://yr-rain-notifier.<your-subdomain>.workers.dev/health

# Manually trigger a check (useful for testing)
curl -X POST https://yr-rain-notifier.<your-subdomain>.workers.dev/trigger
```

---

## Local development

```bash
# Run locally (cron won't fire, but HTTP endpoints work)
wrangler dev

# Trigger manually against local worker
curl -X POST http://localhost:8787/trigger
```

---

## Self-hosting ntfy (optional)

If you prefer to keep notifications fully private, you can [self-host ntfy](https://docs.ntfy.sh/install/) on any VPS or home server. Change `NTFY_BASE_URL` in `wrangler.toml` to your server's URL.

---

## Notifications

| Emoji | Title | Meaning |
|---|---|---|
| 🌧️ | Regn på vei | Rain starting in ~X min |
| ☀️ | Oppholder snart | Rain clearing in ~X min, dry for ≥Y min |

Notifications are in Norwegian to match the Yr/MET context. Edit `src/index.ts` to translate if preferred.

---

## Coverage

The Yr Nowcast API covers **Norway, Sweden, Finland, and Denmark**. Precipitation data is radar-based; quality varies by location (indicated by the `RadarCoverage` field in the API response).
