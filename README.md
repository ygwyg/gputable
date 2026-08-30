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

## Deploy

Copy `wrangler.example.jsonc` to `wrangler.jsonc`, fill in your Cloudflare IDs, then:

```sh
npx wrangler kv namespace create PRICES   # paste the id into your config
npx wrangler deploy
```

The cron scrapes into KV every 5 minutes (marketplaces) / 15 minutes (everything); the Worker serves the page and the data with tag-purged edge caching.

## Data

Free JSON, no key, CORS enabled:

- [`/data.json`](https://gputable.dev/data.json) — current prices, per single GPU per hour
- [`/history.json`](https://gputable.dev/history.json) — daily cheapest per GPU and pricing type
- [`/llms.txt`](https://gputable.dev/llms.txt) — field documentation

Providers that can't be included (bot-walls, key-gated APIs, no public prices) are documented at the top of `scrape.mjs`.
