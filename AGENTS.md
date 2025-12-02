# agents.md

This document defines how to collaborate with AI coding agents (Cursor, Copilot, ChatGPT, etc.) on the **web-ui-data-relay** project.

The goal:
Use agents as force multipliers **without** letting them hallucinate the architecture, ignore constraints, or silently change behavior.

---

## 1. Project summary

**One-liner**

> A private service that turns arbitrary live data displayed in web UIs into rate-limited WebSocket and HTTP data streams, driven by per-site configs.

**Core responsibilities**

1. Load curated websites in a headless browser (Playwright).
2. Extract values from DOM elements using config-defined selectors.
3. Parse & normalize those values (units, types, names).
4. Schedule polite crawling with:

   * **Global ceiling**: no source polled more often than every **20 seconds**.
   * Backoff and error handling.
5. Expose normalized data via:

   * **Primary**: WebSocket streams.
   * Secondary: REST API for latest + history (4h window).

**Non-goals (v1)**

* No generic “crawl the whole web.”
* No OCR / image-based scraping.
* No automatic discovery of new sites.
* No public multi-tenant service; this is **private** for you and close collaborators.
* No ignoring ToS or hammering servers.

---

## 2. Tech stack (hard constraints)

Agents **must stay inside** this stack unless explicitly told otherwise:

* **Language**: TypeScript
* **Runtime**: Node.js (LTS)
* **Package manager**: `pnpm`
* **HTTP framework**: Fastify
* **WebSockets**: `ws` (or Fastify-compatible plugin)
* **Headless browser**: Playwright
* **DB**: SQLite (v1) via Prisma
* **Schema validation**: Zod for config
* **Config format**: YAML files in `sources/` directory

If an agent proposes Python, NestJS, different DBs, etc., assume **no** by default.

---

## 3. Repository structure

Agents should **respect and extend** this structure instead of inventing new layouts:

```text
src/
  config/
    index.ts        // config types + loader (Zod + YAML)
  db/
    client.ts       // Prisma client
  crawler/
    crawler.ts      // crawlSource implementation
  scheduler/
    scheduler.ts    // scheduling logic
  api/
    server.ts       // Fastify routes
  ws/
    wsServer.ts     // WebSocket server + subscriptions
  bus/
    events.ts       // EventEmitter for internal pub/sub
  index.ts          // bootstrap everything
prisma/
  schema.prisma
sources/
  example-source.yaml
```

New modules should fit under one of these directories or be a small, well-scoped new folder.

---

## 4. Product constraints & priorities

These rules are **not negotiable** for agents:

### 4.1 Crawl frequency

* **Absolute minimum**: no source is ever crawled more frequently than **once every 20 seconds**, regardless of config.
* Each source can have its own `minIntervalMs`, but the system must enforce:

  * `effectiveMinIntervalMs = max(20000, config.minIntervalMs)`.

### 4.2 Data retention

* Historical `SourceData` retention: **max 4 hours**.
* Implement automatic cleanup:

  * Periodic job that deletes data older than `now - 4h`.
  * APIs should only rely on up to 4 hours of history.

### 4.3 Resource constraints / feature priority

When trade-offs are required:

1. **WebSocket streaming stays primary**

   * Real-time data delivery to consumers matters most.
2. **Stable, reliable scheduler**

   * It’s fine if parsing is imperfect as long as the crawl/stream loop is robust.
3. **Fancy parsing & unit conversion**

   * Additional derived fields, unit conversions, etc., are nice-to-have.
4. **UI/dashboard**

   * Minimal or none in v1; not a focus.

Agents should bias effort and complexity toward **WebSockets + scheduler** first, everything else second.

### 4.4 Privacy & usage

* Intended as a **private tool**:

  * You + trusted collaborators.
  * No public signup, no anonymous users.
* This affects:

  * Simplified auth is acceptable.
  * Stronger emphasis on stability and ergonomics than on multi-tenancy.

### 4.5 Error tolerance

* Each source:

  * Allows up to **5 consecutive failures** before being marked **degraded/disabled**.
* Status model should support at least:

  * `ok`
  * `error` (recent error but not yet at threshold)
  * `degraded` / `disabled` (after 5 consecutive failures).
* Recovery behavior:

  * Sources that hit the failure threshold should be automatically retried **the next day** (e.g., after ~24 hours or at a daily re-check window).
  * If they succeed later, they should move back toward `ok` and `consecutiveFailures` reset.

### 4.6 Scraping permission

Config must include:

```yaml
allowed_to_scrape: true | false
```

* The system **must refuse to run sources** where `allowed_to_scrape: false`.
* Agents must not add “helpful overrides” to bypass this.

### 4.7 Integration targets

Primary consumers:

* Your own **visualizer app**.
* Future “data toys” you haven’t built yet.

Implications:

* API/WS contracts should be:

  * Simple.
  * Stable enough for long-running visual apps.
* No heavy auth flows or complex multi-tenant models are necessary for v1.

---

## 5. Config complexity & v1 parsers

When we talk about “config complexity” here, we’re talking about **how much logic lives in config** vs in code.

For **v1**, keep it simple:

### 5.1 Source config responsibilities

Each config (YAML) should define:

* `id`, `name`, `description`
* `url`
* `allowed_to_scrape` (must be `true` to run)
* `browser` options:

  * `loadTimeoutMs`
  * `waitForSelector`
  * `userAgent` (optional)
  * `viewport` (width, height)
* `schedule`:

  * `minIntervalMs` (subject to 20s global minimum)
  * `jitterPct`
  * `maxConsecutiveFailures` (default 5 if omitted)
  * `backoffFactor`
* `selectors`: mapping from logicalField → selector definition:

  ```ts
  type SelectorDefinition = {
    css?: string;
    xpath?: string;
    attribute?: string; // default "textContent" if omitted
  };
  ```
* `parse`: mapping from logicalField → parse rule:

  ```ts
  type ParseRule = {
    type: "float" | "int" | "string" | "datetime";
    regex?: string;      // to extract the useful bit from UI text
    unit?: string;       // optional metadata
    scale?: number;      // optional multiplier, e.g. 0.001 to convert m to km
  };
  ```
* `outputSchema`: mapping from outputField → logicalField, e.g.:

  ```yaml
  outputSchema:
    solar_wind_speed_km_s: solar_wind_speed
    density_protons_cm3: density
  ```

### 5.2 What v1 parsers should and should not do

**Should:**

* Apply regex to extract a substring (optional).
* Convert to:

  * `float`
  * `int`
  * `string`
  * `datetime` (using a simple, documented format or `Date.parse`).
* Optionally apply a scalar multiplier (`scale`).

**Should not:**

* Support arbitrary JS expressions in config.
* Perform complex multi-step transforms.
* Do cross-field calculations in config.

Any advanced logic should live in code-level utilities, not in YAML for v1.

---

## 6. Agent roles

### 6.1 Architecture / Design Agent

**Job**

* Define and maintain:

  * TypeScript interfaces for config, sources, crawl results.
  * Data flow between modules:

    * config → crawler → DB → event bus → WebSocket/API.

**Deliverables**

* `SourceConfig` types.
* `CrawlResult` types.
* Clear comments about data flow order/assumptions.

**Do not:**

* Change API/WS contracts without updating docs and downstream modules.

---

### 6.2 Crawler / Scraper Agent

**Job**

Implement and refine:

```ts
async function crawlSource(source: Source, config: SourceConfig): Promise<CrawlResult> { ... }
```

Responsibilities:

* Use a **shared** Playwright browser instance.
* Page handling:

  * Apply `browser` config (viewport, user agent, timeouts).
  * `waitForSelector` if specified.
* Field extraction:

  * Use CSS or XPath from `selectors`.
  * Get `textContent` or specified attribute.
  * Apply `parse` rules (regex, type, optional `scale`).
* Emit normalized data and write:

  * New `SourceData` row.
  * Updated `Source` status: `lastRunAt`, `lastStatus`, `consecutiveFailures`.

Error behavior:

* On error, increment `consecutiveFailures`.
* If `consecutiveFailures >= maxConsecutiveFailures` (default 5):

  * Mark source as `degraded`/`disabled`.
* Log failures with:

  * `sourceId`, error type, stack.

---

### 6.3 Scheduler / Rate Limiter Agent

**Job**

Implement a scheduler that:

* Loads enabled sources.
* Calculates next run times using:

  * `minIntervalMs` (but never less than 20000 ms).
  * `jitterPct`.
  * `backoffFactor^consecutiveFailures` when there are recent errors.
* Respects a global concurrency cap:

  * e.g. `MAX_CONCURRENT_CRAWLS = 3`.

Behavior:

* Periodic tick (e.g. every 1s–5s):

  * Compute which sources are due and not currently running.
  * Skip:

    * Sources with `allowed_to_scrape = false`.
    * Sources in a hard `disabled` state (if implemented).
* For sources that hit failure threshold:

  * Stop regular scheduling until:

    * A “next-day re-check” job runs and attempts one new crawl.
    * On success, reset failures and re-enable.

Agents must avoid tight loops / busy waiting.

---

### 6.4 API / WebSocket Agent

**Job**

Expose the data to consumers.

**REST API**

* `GET /api/sources`

  * Returns: `id`, `name`, `description`, `url`, `lastRunAt`, `lastStatus`.
* `GET /api/sources/:id`

  * Returns full source info, including config (minus any sensitive bits).
* `GET /api/sources/:id/latest`

  * Returns latest `SourceData` within the 4h retention window.
* `GET /api/sources/:id/history?from&to`

  * Returns historical data within [from, to], clipped to last 4h.

**WebSocket**

* Endpoint: `/ws/sources/:id`
* On connect:

  * Validate `id`.
  * If valid and enabled:

    * Send latest value immediately (if it exists).
    * Subscribe client to internal `source_data:new` events for that id.
* On new data:

  * Push JSON payload to all subscribers of that `sourceId`.

**Error handling**

* 400: malformed params.
* 404: unknown source or disabled.
* 500: internal error (log the details, do not expose stack).

---

### 6.5 Config / DX Agent

**Job**

Make adding/editing sources painless.

Responsibilities:

* Maintain `SourceConfig` type + Zod schema.
* Provide `sources/example-source.yaml` with:

  * `allowed_to_scrape: true`
  * Realistic `schedule` values (>= 20s).
* Implement config loader:

  * Read YAML from `sources/`.
  * Validate via Zod.
  * Upsert into DB.

Guidelines:

* Errors in config should fail fast with clear messages during startup.
* Avoid DSL creep; keep YAML readable and limited to the fields described above.

---

### 6.6 Documentation Agent

**Job**

Keep docs aligned with reality:

* `README.md`

  * What it is.
  * How to run.
  * How to add a source.
* `CONFIG.md`

  * Config schema, explained.
  * One or two full example configs.
* Inline comments in tricky code paths:

  * Scheduler logic.
  * Failure/backoff logic.
  * Retention cleanup.

Docs should explicitly mention:

* 20s min polling interval.
* 4h retention.
* 5-failure threshold with next-day recheck.
* `allowed_to_scrape` behavior.

---

## 7. Collaboration rules for all agents

1. **Do not silently change contracts**

   * If you change types, routes, WS behavior:

     * Update types.
     * Update implementations.
     * Update docs/comments.

2. **Prefer small, composable modules**

   * Keep crawler, scheduler, API, WS, config, and cleanup separate.
   * No “god files.”

3. **Log everything important**

   * Crawls, failures, state changes (e.g., moving to degraded/disabled).
   * Keep logs structured enough to filter by `sourceId`.

4. **Respect politeness and permissions**

   * Enforce 20s minimum.
   * Honor `allowed_to_scrape`.
   * Back off on repeated failures.

5. **Remember the order of importance**

   * WebSocket streaming first.
   * Scheduler stability second.
   * Parsing niceties third.
   * UI/dashboard last.

