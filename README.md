# GPUTable

Live cloud GPU rental prices across 35+ providers — **https://gputable.dev**

Two files, no dependencies, no build step:

- **`scrape.mjs`** — the scraper and the Cloudflare Worker in one file. Pulls per-GPU hourly prices from first-party sources (public APIs, server-rendered pages, and two browser-rendered pages via Cloudflare Browser Rendering), normalizes GPU names, converts EUR with ECB rates, and carries a provider's last good rows forward (marked stale) if its fetch breaks.
- **`gpu-prices.html`** — the table. Sort, filter, search, 7-day price deltas, URL-shareable filters, auto-refresh every 5 minutes.

## Run

```sh
node scrape.mjs                    # writes data.json + history.json
node scrape.mjs --dry --only vast  # debug one provider
```

## Test

```sh
node test.mjs            # replay recorded fixtures offline; fails on parser regressions
node test.mjs --record   # refresh fixtures from the live endpoints (needs the API-key env vars)
```

Every provider's real response is committed as a gzipped fixture, so CI catches
a broken parser without touching the network.

## Deploy

Copy `wrangler.example.jsonc` to `wrangler.jsonc`, fill in your Cloudflare IDs, then:

```sh
npx wrangler kv namespace create PRICES   # paste the id into your config
npx wrangler deploy
```

The cron scrapes into KV every 5 minutes (marketplaces) / 15 minutes (everything); the Worker serves the page and the data with tag-purged edge caching.

## Pages

The table itself is client-rendered, so the Worker also serves a plain-HTML layer
built from the same KV data — one page per GPU ([`/gpu/h100-sxm`](https://gputable.dev/gpu/h100-sxm))
and per provider ([`/provider/runpod`](https://gputable.dev/provider/runpod)), plus
[`/gpu/`](https://gputable.dev/gpu/) and [`/provider/`](https://gputable.dev/provider/)
indexes. They give crawlers and answer engines something to read, and they work
without JavaScript. Provider comparisons are like-for-like: same GPU, same pricing
model, and same capacity tier, so a dedicated instance is never scored against a
peer-marketplace spot listing. All of it is generated from the live rows — nothing
to update when a GPU or provider comes or goes — and `/sitemap.xml` enumerates it.

## Data

Free JSON, no key, CORS enabled — attribution required (link gputable.dev,
keep `source_url` params intact):

- [`/data.json`](https://gputable.dev/data.json) — current prices, per single GPU per hour, updated every 15 min
- [`/history.json`](https://gputable.dev/history.json) — daily cheapest per GPU and pricing type
- [`/llms.txt`](https://gputable.dev/llms.txt) — field documentation and terms

Real-time keyed API (`/v1/data`, `/v1/history`) serves every scrape including
the 5-minute marketplace ticks — open an issue for a key.

Providers that can't be included (bot-walls, key-gated APIs, no public prices) are documented at the top of `scrape.mjs`.
