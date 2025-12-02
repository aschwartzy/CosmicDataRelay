# CosmicDataRelay Configuration Guide

This guide explains how YAML configs in `sources/` are validated, scheduled, and parsed. Use [`sources/example-source.yaml`](sources/example-source.yaml) as a starting template.

## Validation lifecycle
- YAML files under `sources/` (including subfolders) are loaded at startup and validated with Zod. Missing required fields or invalid selectors stop the process with an explicit error message, preventing the server from starting with a bad config.
- `effectiveIntervalMs` is computed as `max(20_000, schedule.intervalMs)` so the 20s floor is always enforced.
- `enabled` is derived from `allowedToScrape && enabled` to prevent crawling when permission is not explicitly granted.

## Required fields
- `id` (string): Stable identifier; also stored in the database.
- `name` (string): Display name for APIs.
- `url` (string): Page to visit.
- `allowedToScrape` (boolean): Must be `true` to enable crawling.
- `enabled` (boolean): Toggles scheduling (subject to `allowedToScrape`).
- `browser` (object): Headless flag, optional `userAgent`, `viewport`, and `timeouts` (`navigationMs`, `actionMs`). Defaults keep headless Chromium at 1280x720 with 30s/10s timeouts.
- `schedule` (object):
  - `intervalMs`: Desired crawl interval (capped by the 20s minimum).
  - `jitterMs`: Optional random +/- jitter to de-sync crawls.
  - `backoffMultiplier`: Exponential factor applied on failures.
  - `maxBackoffMs`: Maximum backoff delay.
  - `failureLimit`: Consecutive failures before a 24h pause.
- `selectors` (map): Keys are logical field names; each value provides `css` or `xpath` (plus optional `attribute`).
- `parse` (array, optional): Rules that transform raw selector output before validation; see below.
- `outputSchema` (map): Final validated payload shape; values can be `string`, `int`, `float`, `number`, `boolean`, `datetime`, or `json`.

## Selector examples
```yaml
selectors:
  title:
    css: 'h1'
  price:
    css: '.price'
    attribute: 'data-price'
  updatedAt:
    xpath: '//time[@id="last-updated"]'
```
- Use `css` for standard selectors or `xpath` when the DOM structure requires it.
- `attribute` reads an attribute instead of text (e.g., `data-price`).

## Parse rules
Parse rules run in order, letting you normalize or remap values before validation.
```yaml
parse:
  - field: price
    type: float
    unit: '$'
  - field: updatedAt
    type: datetime
    regex: '(.*) UTC'
  - field: title
    targetField: heading
    type: string
```
- `field`: Name from `selectors`.
- `targetField` (optional): Write the parsed value to a different key.
- `type`: Casts to `string`, `int`, `float`, `number`, or `datetime`.
- `regex`: If provided, the first capture group or match is used.
- `unit`: Removes matching substrings (e.g., currency symbols) before casting.

## Output schema
`outputSchema` must declare every field you expect to emit after parsing. Values missing after parsing default to `null` but must satisfy the declared type when present.
```yaml
outputSchema:
  heading: string
  price: float
  updatedAt: datetime
```

## Scheduler behavior and backoff
- Each run schedules the next attempt at `effectiveIntervalMs + jitter`.
- Backoff multiplies the interval by `backoffMultiplier` per consecutive failure up to `maxBackoffMs`.
- After `failureLimit` consecutive failures, the source is paused for 24 hours before retrying.
- A minute-level cleanup deletes data older than 4 hours to honor the retention window.

## Adding a source: step-by-step
1. Duplicate [`sources/example-source.yaml`](sources/example-source.yaml) and set `id`, `name`, `url`, `description`.
2. Flip `allowedToScrape` to `true` and `enabled` to `true` once you have permission to crawl.
3. Define `selectors` for every field you need, choosing `css` or `xpath` and `attribute` when reading attributes.
4. Add `parse` rules to strip units, apply regex captures, remap fields (`targetField`), and cast to the right types.
5. Declare the final `outputSchema` keys and types that clients will receive.
6. Restart the service. Startup validation will reject bad configs; once accepted, configs are persisted to the DB and scheduled according to the `schedule` block with backoff and jitter.
