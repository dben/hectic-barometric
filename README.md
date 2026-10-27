# hectic-barometric

Records hourly barometric pressure, temperature, precipitation and rain chance for a fixed set of locations, keeps a year of history in SQLite, and serves a one-page dashboard that charts it and highlights large pressure swings.

## Run it

```sh
docker compose up -d
```

Then open http://localhost:8080. Edit `config/locations.yaml` and restart the container to change locations.

The image is published to `ghcr.io/dben/hectic-barometric` (tags: `latest` from `main`, `X.Y.Z` / `X.Y` from `vX.Y.Z` git tags, and `sha-…`). It's built for amd64 and arm64.

If the package is private, log in first: `echo $TOKEN | docker login ghcr.io -u <user> --password-stdin` with a token that has `read:packages`.

## Locations

```yaml
locations:
  - id: raleigh            # lowercase key used in URLs and the database
    name: Raleigh, NC      # dashboard label
    latitude: 35.58
    longitude: -78.80
    timezone: America/New_York   # optional; time axis zone (defaults to the browser's)
    nwsStation: KRDU             # optional; US only
```

To find a nearby NWS station, open `https://api.weather.gov/points/{lat},{lon}/stations` and take the first `stationIdentifier`.

## Data sources

| | Open-Meteo | NWS (api.weather.gov) |
|---|---|---|
| What | Model data blended with observations | Measured readings from an airport station |
| Coverage | Worldwide | US only, needs `nwsStation` |
| History on first start | 1 year (archive API) | ~7 days (all the API keeps) |
| Surface pressure | `surface_pressure` | Derived from the altimeter setting and station elevation |
| Sea-level pressure | `pressure_msl` | `seaLevelPressure` from the hourly METAR, else the altimeter setting |
| Temperature | `temperature_2m` | `temperature` |
| Precipitation | `precipitation` (mm/h) | `precipitationLastHour`, often missing |
| Rain chance | `precipitation_probability` (forecast API only, so not in backfilled history) | — |

NWS stations report every few minutes; the collector keeps the reading nearest each top of the hour, preferring the routine METAR.

Open-Meteo's free API is for non-commercial use, capped at 10,000 calls a day. This app makes about 24 per location per day.

## How collection works

- On start, and then every hour at `COLLECT_MINUTE` past, each location is synced from its last stored hour up to now. A new location backfills `BACKFILL_DAYS` from the Open-Meteo archive, and gaps from downtime fill in on the next run (up to 92 days through the forecast API, older through the archive).
- Readings older than `RETENTION_DAYS` are deleted after each run.
- A failed source is logged and shown in the dashboard header. The next run picks up where it left off.

## Swings

A swing is any stretch where pressure moved by at least the threshold within the window, for example 6 hPa in 12 h. Overlapping windows in the same direction merge, and each band is trimmed to the high and low points inside it. The window, threshold and source are set on the dashboard. A 3 h window mostly picks up the normal daily pressure cycle; 12–24 h windows catch fronts and storms.

## Settings

| Variable | Default (in the image) | |
|---|---|---|
| `PORT` | `8080` | |
| `DB_PATH` | `/data/barometric.db` | Mount a volume at `/data` |
| `LOCATIONS_FILE` | `/config/locations.yaml` | |
| `RETENTION_DAYS` | `365` | |
| `BACKFILL_DAYS` | `365` | |
| `COLLECT_MINUTE` | `5` | Minute past each hour (UTC) |
| `NWS_USER_AGENT` | `hectic-barometric (https://github.com/dben/hectic-barometric)` | NWS asks for a contact, e.g. `myapp (me@example.com)` |

## API

| Endpoint | |
|---|---|
| `GET /api/locations` | Configured locations |
| `GET /api/series?location=&from=&to=` | Hourly readings for both sources on shared timestamps (unix seconds) |
| `GET /api/swings?location=&from=&to=&source=open-meteo\|nws&field=surface\|msl&window=12&threshold=6` | Detected swings; threshold in hPa |
| `GET /api/status` | Last collection run, errors, row counts |
| `GET /healthz` | Liveness |

## Development

Requires Node 22.13+ (uses the built-in `node:sqlite`).

```sh
npm ci
npm test
DB_PATH=./data/dev.db npm run dev
```

CI (`.github/workflows/docker.yml`) runs the tests, then builds the image, and pushes it on `main` and `v*` tags. Pull requests build without pushing.
