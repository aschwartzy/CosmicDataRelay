# CosmicDataRelay

CosmicDataRelay turns data displayed in curated web apps into rate-limited HTTP and WebSocket feeds backed by Prisma + SQLite. It enforces polite crawling (minimum 20s per source), retains history for only four hours, and exposes normalized payloads defined in YAML configs.

## Prerequisites
- Node.js LTS
- `pnpm` for package management
- SQLite (bundled with Prisma for local development)
- Playwright browser binaries (`pnpm exec playwright install chromium`), required the first time you run crawlers

## Installation
```bash
pnpm install
pnpm exec prisma generate
```

## Database setup (Prisma)
- Initialize or apply migrations:
  ```bash
  pnpm exec prisma migrate dev --name init
  # or apply existing migrations in CI/production
  pnpm exec prisma migrate deploy
  ```
- Inspect the database during development:
  ```bash
  pnpm exec prisma studio
  ```

## Running the service
- Development (watch + ts-node):
  ```bash
  pnpm dev
  ```
- Build TypeScript:
  ```bash
  pnpm build
  ```
- Run compiled server:
  ```bash
  pnpm start
  ```

The server listens on `PORT` (default `3000`) and loads YAML configs from `sources/`, enforcing a minimum crawl interval of 20 seconds per source and a four-hour retention window for historical rows.

## HTTP API routes
- `GET /api/sources` — list sources with metadata and current status fields.
- `GET /api/sources/:id` — fetch a source with its recent status history and resolved config (without internal parsers).
- `GET /api/sources/:id/latest` — latest data within the 4h retention window; `404` if none.
- `GET /api/sources/:id/history?from&to` — historical rows, clamped to the last 4h and validated date ranges.
- `GET /api/config/sources` — resolved configs currently loaded by the service.

## WebSocket endpoint
- `GET /ws/sources/:id`
  - On connect: validates the source, sends `{ type: "connected" }`, then pushes the latest value within the retention window.
  - Live updates: broadcasts `{ type: "update" | "latest", sourceId, payload }` for new data or errors.

## Scheduling, retention, and backoff
- **Minimum interval**: `effectiveIntervalMs = max(20_000ms, schedule.intervalMs)` from the YAML config.
- **Jitter**: optional `schedule.jitterMs` spreads requests around the target interval.
- **Backoff**: exponential backoff using `schedule.backoffMultiplier` up to `schedule.maxBackoffMs`; after `failureLimit` consecutive failures, the source is paused for 24h.
- **Retention**: rows older than 4 hours are deleted every minute; API/WS queries also respect this window.

## Adding a new source
1. Copy [`sources/example-source.yaml`](sources/example-source.yaml) into `sources/` and edit the fields.
2. Set `allowedToScrape: true` and `enabled: true` to allow the scheduler to run it.
3. Define selectors (`css` or `xpath`) for each field you want to capture and map them to an `outputSchema` of typed fields.
4. Add optional parse rules (regex/unit stripping, casts) to normalize values before validation.
5. Restart the server; configs are validated with Zod on startup and persisted to the database. Invalid configs fail startup with explicit error messages.

See `CONFIG.md` for detailed schema guidance, selector examples, and parser recipes.
