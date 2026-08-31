# The Modern App Starter Checklist

*From idea to a shipped, monetized, agent-friendly product on Cloudflare - whether it's a content/data site, a SaaS with real UI, or an API you sell. Written so an AI agent (or a human) can execute it top to bottom. Each phase has exact commands, config, and a check to confirm it worked. Every gotcha listed happened in a real production build. Skip phases you don't need, but read their gotchas anyway.*

**Design principles this version enforces:**

1. **Allowlist, don't denylist.** Public things live in `public/`. Nothing is public by accident.
2. **One source of truth per kind of data.** Relational truth in D1, coordination in Durable Objects, blobs in R2, caches in KV. Never store something in an eventually-consistent store if being wrong for 60 seconds costs you money or trust.
3. **Staging exists from day one.** You never deploy an untested change straight to the domain users visit.
4. **Config is committed; secrets are not.** IDs aren't secrets. Secrets go through `wrangler secret` and nowhere else.
5. **Boring beats clever.** No bundler tricks, no dual-mode files. A second file is free.

---

## Phase 0 - Name and domain

- Search and register in one place: Cloudflare dashboard -> **Domain Registration -> Register Domains**. At-cost pricing, and the zone lands in the same account as everything you're about to build - no DNS setup later.
- Scripted availability check (useful for agents comparing many names): registry RDAP returns 404 for unregistered domains: `curl -so /dev/null -w "%{http_code}" https://rdap.org/domain/NAME.dev`
- Build and ship on `NAME.workers.dev` first. The domain attaches later with zero migration (Phase 6).

## Phase 1 - Scaffold

Pick the shape that matches the product. Both use the same config, deployment, and everything in later phases.

**Shape A - zero-dependency Worker** (content sites, data products, APIs): one `worker.mjs`, template-string HTML, no build step, no npm. Fastest to ship, trivially auditable, and server-rendered by construction - which Phase 7 will thank you for.

**Shape B - framework app** (real interactive UI, auth'd dashboards): `npm create cloudflare@latest` and pick a framework with SSR support (Hono + JSX, React Router, SvelteKit, Astro). Accept the build step; don't accept client-only rendering (see Phase 7).

Either way:

- Repo layout - public things are public *on purpose*:

```
myapp/
  public/          # served as static assets. ONLY things meant to be public.
  src/worker.mjs   # the Worker (or framework src/)
  scripts/cli.mjs  # local tooling: seeding, backfills, one-off jobs
  test/
  wrangler.jsonc   # committed. contains no secrets.
```

- `wrangler.jsonc` skeleton - **commit this file.** Account IDs, KV namespace IDs, and D1 database IDs are identifiers, not secrets; gitignoring them just breaks CI and creates drift. Secrets never go in config at all (Phase 10).

```jsonc
{
  "name": "myapp",
  "main": "src/worker.mjs",
  "account_id": "YOUR_ACCOUNT_ID",
  "compatibility_date": "2026-08-01",

  "assets": {
    "directory": "public",        // allowlist: only public/ is served
    "binding": "ASSETS",
    "run_worker_first": ["/", "/api/*"]
  },

  // staging from day one - same code, separate resources
  "env": {
    "staging": {
      "name": "myapp-staging"
      // staging gets its own KV/D1 ids as later phases add them
    }
  }
}
```

- CLI work (seeding, backfills, scrapes) goes in `scripts/cli.mjs` as a plain Node script. Do **not** merge the CLI into the Worker file with bundler-dodging import tricks - it saves one file and costs you the first wrangler release that changes bundler behavior.
- Deploy both targets: `npx wrangler deploy` (production) and `npx wrangler deploy --env staging`. Check: both workers.dev URLs serve.
- `git init` and push now, before the project grows.

Gotchas: no top-level `await` in the Worker entry (the bundler rejects it). Static assets serve `page.html` at `/page` and 307-redirect `/page.html`, so routes that render an asset should fetch the extensionless name through the ASSETS binding.

## Phase 2 - State: pick the right store

The single most common architecture mistake is one store for everything. Decide per kind of data:


| Data                                                                   | Store               | Why                                                     |
| ---------------------------------------------------------------------- | ------------------- | ------------------------------------------------------- |
| Users, sessions, API keys, entitlements, anything relational           | **D1**              | Strongly consistent reads after writes; SQL; migrations |
| Cached/derived data, feature flags, rendered snapshots                 | **KV**              | Fast global reads; eventual consistency is fine here    |
| Per-entity coordination: rate limits, live counters, websockets, locks | **Durable Objects** | Single-threaded consistency per object                  |
| Files, images, exports, fixtures                                       | **R2**              | Blobs; zero egress fees                                 |
| Background jobs that must not be lost                                  | **Queues**          | Retries, dead-letter queues                             |


- Create what you need now (usually D1 + KV), once per environment:

```sh
npx wrangler d1 create myapp-db
npx wrangler d1 create myapp-db-staging
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create CACHE --env staging
```

```jsonc
{
  "d1_databases": [{ "binding": "DB", "database_name": "myapp-db", "database_id": "PASTE_ID" }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "PASTE_ID" }],
  "triggers": { "crons": ["*/5 * * * *"] }
}
```

- Schema changes go through migrations from the very first table: `npx wrangler d1 migrations create myapp-db init`, then `npx wrangler d1 migrations apply myapp-db --remote`. CI applies staging migrations automatically (Phase 12).
- For tiered schedules (light work often, heavy work sometimes), run one cron and branch on the minute: `const fullRun = new Date(event.scheduledTime).getUTCMinutes() % 15 === 0;`
- Wrap scheduled work in `ctx.waitUntil(...)`.

Gotchas (all real): KV is **eventually consistent** - reads elsewhere can lag a write by up to a minute. That's why nothing whose *revocation* matters (keys, sessions, entitlements) lives in KV; those are D1 rows. A cron mid-run during a deploy finishes on the old code and can overwrite keys you just seeded - make writes idempotent so the next tick self-heals. And D1 is a single region: fine for auth and billing truth, but put hot read paths behind the edge cache (Phase 3) or a KV-rendered snapshot.

## Phase 3 - Caching that is fast AND live (Workers Cache)

- Enable it: `"cache": { "enabled": true }`. Note: once on, **all** requests to the Worker - including static-asset requests that are normally free - bill at the standard Workers request rate.
- Split browser and edge lifetimes. This is the fix for "users need a hard refresh": `cache-control: public, max-age=60, s-maxage=600, stale-while-revalidate=300` (browser 60s, edge 10 min, serve-stale-while-refreshing 5 min).
- Never cache personalized responses. Anything behind a session cookie returns `cache-control: private, no-store`. Cache the anonymous versions of pages and the public API, not the dashboard.
- Tag cacheable responses (`cache-tag: entity-123, entity-list`) and purge from the code that writes new data: `await ctx.cache.purge({ tags: ["entity-123", "entity-list"] })`. Works inside scheduled handlers too.
- Purge **only when the data actually changed** (compare with the previous value). Purging on every quiet tick evicts warm entries for nothing and ruins your hit rate.

Check: `curl -sD - -o /dev/null URL | grep cf-cache-status` shows MISS then HIT; fresh content appears within ~30s of a write; a logged-in page shows `DYNAMIC`/no cache header, never HIT.

## Phase 4 - Auth and sessions (skip for anonymous products)

Rule one: don't invent crypto, and don't put tokens in localStorage.

- **Identity**: OAuth against one provider (GitHub or Google) is ~150 lines of plain `fetch` - authorize redirect, code-for-token exchange, profile fetch, upsert a `users` row in D1. Use a hosted provider (Clerk, WorkOS, Auth0) only when you need orgs/SSO/SCIM; that's a dependency you're buying, so buy it deliberately.
- **Sessions**: 32 random bytes (`crypto.getRandomValues`), stored as a row in D1 (`sessions: id, user_id, expires_at`), delivered as a cookie: `Set-Cookie: sid=...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`. Logout deletes the row - revocation is immediate because it's D1, not KV.
- **CSRF**: `SameSite=Lax` plus an `Origin` header check on every state-changing route. That combination covers the realistic cases without a token dance.
- **Login rate limiting**: a Durable Object keyed by IP + account, or a Cloudflare rate-limiting rule on the auth endpoints. Do this before launch, not after the first credential-stuffing run.
- Salt-hash any password-like value (prefer no passwords at all: OAuth or email magic links). API keys get the same treatment in Phase 10.

Check: cookie flags visible in devtools; a deleted session row 401s the very next request; a `curl` POST with a foreign `Origin` is rejected.

## Phase 5 - Browser Rendering (JS-only pages, screenshots)

- Use the **REST API**, not the puppeteer binding: same product, plain `fetch`, zero npm, identical code locally and deployed. `POST https://api.cloudflare.com/client/v4/accounts/{acct}/browser-rendering/content` with body `{"url": "...", "gotoOptions": {"waitUntil": "load", "timeout": 45000}, "waitForTimeout": 4000}` and `Authorization: Bearer TOKEN` (token permission: Browser Rendering Edit).
- Use `waitUntil: "load"` plus a settle delay. `networkidle0` hangs forever on pages with long-polling analytics.
- Renders are metered minutes. Cache results for hours in KV or R2; never render per request.
- Free trick: the `/screenshot` endpoint pointed at your own homepage at 1200x630 is a live `og:image`. Refresh it daily from the cron.

Gotchas: bot-walled sites block Cloudflare's rendering IPs - including some sites that are themselves behind Cloudflare - so test each target before promising coverage. For local dev, wrangler's OAuth token can call this API.

## Phase 6 - Custom domain, staging domain

- Production:

```jsonc
{
  "routes": [
    { "pattern": "myapp.dev", "custom_domain": true },
    { "pattern": "www.myapp.dev", "custom_domain": true }
  ]
}
```

- Staging stays on `myapp-staging.workers.dev`, or gets `staging.myapp.dev` under `"env": { "staging": { "routes": [...] } }`. Either way it must send `X-Robots-Tag: noindex` and serve a disallow-all `robots.txt` - a staging site outranking production is a real failure mode.

Certificates provision in about a minute; workers.dev keeps working as a fallback. Check: `curl -s -o /dev/null -w "%{http_code}" https://myapp.dev/` returns 200, and staging responds with `X-Robots-Tag: noindex`.

## Phase 7 - SEO and Search Console

- **Server-render every page that should rank.** Googlebot runs JavaScript; most AI crawlers do not. Shape A is server-rendered by construction; Shape B must use its framework's SSR, not client-only rendering. Either way: one plain-HTML page per entity, each with its own title, description, and schema, and real 404s for unknown slugs.
- Head basics: unique `<title>`, meta description, `rel=canonical`, a favicon (SVG works), OG and `twitter:card` tags, `og:image` (Phase 5).
- JSON-LD for your content type: `Dataset` for data products, `Product` with `AggregateOffer` for priced listings, `SoftwareApplication` for SaaS, `FAQPage`, `BreadcrumbList`. Escape `<` inside the script tag.
- Link hub-and-spoke: homepage -> index pages -> detail pages. Keep the homepage clean; a compact link strip plus hub pages beats a wall of links.
- Serve `robots.txt` (welcome AI crawlers by name if that fits your strategy) and a generated `sitemap.xml` from the Worker.
- Google Search Console: verify as a *Domain property* via a DNS TXT record - DNS is already in Cloudflare, so this takes two minutes. Skip Google's OAuth shortcut (it grants standing DNS access). Submit the sitemap. Repeat in Bing Webmaster Tools.

Check: `curl https://myapp.dev/some-entity` returns complete HTML with the entity's title and JSON-LD - no JS execution required.

## Phase 8 - The agent surface (agents are users now)

- Serve `/llms.txt`: what the site is, every data endpoint with field docs, and your terms. Stated terms are a *request*, not enforcement - well-behaved agents follow them surprisingly well, and the misbehaving ones are handled by keys and rate limits (Phase 10). Put attribution requirements here.
- JSON endpoints: `access-control-allow-origin: *`, stable field names, and a `source` + `terms` field inside the payload itself, so attribution survives copying.
- **MCP server** on the same Worker. A stateless streamable-HTTP JSON-RPC handler is about 100 lines with no dependencies: handle `initialize`, `ping`, `tools/list`, `tools/call`; return 202 for notifications (messages without an `id`); add CORS for POST and OPTIONS. Tools are typed views over data you already serve. Document it in llms.txt.
- Bake attribution into the data itself (for example `?ref=` params on URLs you publish) instead of hoping consumers preserve credit.

## Phase 9 - Observability and analytics

You need two different things and they are not the same tool: *what is the app doing right now* (logs) and *what are users doing over time* (analytics).

- **Logs first.** Enable Workers Logs in the dashboard, and use `npx wrangler tail` (add `--env staging`) for live debugging. Log structured lines - `console.log(JSON.stringify({ evt, route, ms, err }))` - so they're greppable later.
- **Workers Analytics Engine** for product analytics (page views, clicks, feature usage): dataset binding, a `/t` beacon endpoint with an event allowlist, a `sendBeacon` client. The one query rule: always `SUM(_sample_interval)`, never `COUNT(*)`.
- Requests served from the edge cache never reach the Worker, so server-side counters undercount. Client beacons are exact.
- Free zone dashboards: **HTTP Traffic** (volume by country) and **AI Crawl Control** - which AI bots (GPTBot, ClaudeBot, PerplexityBot...) are reading you. Check it in week one; bots usually arrive before humans.
- Alerting: webhook to Slack, Discord, or ntfy.sh (ntfy needs no account and pushes to a phone). Page yourself only after something has been broken 24h+; log everything else.

Check: `wrangler tail` shows a structured line for a test request; the beacon row appears in an Analytics Engine query.

## Phase 10 - Secrets, keys, and rate limits

- Every sensitive value: `npx wrangler secret put NAME` (and `--env staging` with staging/test credentials). Never in committed config. New secrets don't require a redeploy.
- Third-party keys: least privilege always. Stripe restricted keys (`rk_`), Google Cloud keys restricted to one API, Cloudflare tokens scoped to one product.
- If you sell your own API, keys are **D1 rows, stored hashed**: `api_keys: key_hash, customer_id, plan, created_at, revoked_at`. Look up by SHA-256 of the presented key. D1 means revocation is immediate - a key deleted by the billing webhook (Phase 11) stops working on the next request, with no eventual-consistency window where a canceled customer still gets service.
- **Per-key rate limiting is part of selling an API, not an optimization.** A Durable Object per key (a counter with a window) or Cloudflare's rate-limiting rules. Return 429 with a `retry-after` header and a link to the upgrade page.
- Make the 401 and 429 bodies sell: link the free tier and signup page.
- Before every push, scan the diff for any secret that passed through the session.

Check: a revoked key 401s on the very next request; a loop of rapid calls hits 429.

## Phase 11 - Monetization (self-serve, no dependencies)

- **Stripe Payment Links**: hosted checkout, so card data never touches your Worker. Create product, price, and link via the API. Set the link's `after_completion.redirect.url` to `https://myapp.dev/key?session_id={CHECKOUT_SESSION_ID}`.
- `/key` route: verify the session with `GET /v1/checkout/sessions/:id` (`payment_status === "paid"`), mint a key **idempotently per session** (a `sessions_minted` table keyed by session id), write the entitlement row to D1, show the key on a bookmarkable page.
- `/stripe-webhook`: verify the `stripe-signature` header with WebCrypto HMAC-SHA256 over `t + "." + body`. On `customer.subscription.deleted` or `invoice.payment_failed`, set `revoked_at` on that customer's keys in D1. Revocation is automatic *and immediate* (Phase 10); the whole lifecycle runs with no human.
- Selling seats/features instead of an API? Same skeleton: the webhook flips an `entitlements` row in D1, and the session middleware (Phase 4) reads it. One billing pipeline serves both shapes.
- Referral links for anything you already link out to: join the programs and bake the links into your data. This is how comparison and content sites actually get paid.

Gotchas: dormant Stripe accounts show "capabilities paused" until a re-verification task is completed - check the dashboard banner before going live. Wire test mode against **staging** first (staging secrets are the test keys), then swap the link and secrets in production. Verify the flow with an *unpaid* checkout session - it exercises the "not confirmed" path without typing card numbers.

## Phase 12 - Tests, CI, and the deploy path

- Anything that parses external content **will break eventually**. Record real responses as gzipped fixtures in R2 or the repo, replay them offline through the real code path (override `globalThis.fetch`), and fail on zero rows, halved rows, or insane values. Redact credentials from fixture cache keys.
- GitHub Actions on every push: syntax/typecheck + fixture replay. Runs in seconds and needs no secrets.
- **The deploy path**: merge to main -> CI applies staging migrations and deploys `--env staging` -> smoke check hits staging's health route -> a tag (or manual approval) promotes the same commit to production. Nothing reaches the production domain without having run on staging.
- Failure design: when an upstream fetch fails, serve the last good data *marked stale* - never silently stale, never silently missing.

## Phase 13 - Launch day

- OG image renders in a link preview; title and description read well.
- `robots.txt`, `sitemap.xml`, `llms.txt`, and the main JSON endpoints all return 200 - on production; staging still says noindex.
- Search Console and Bing verified, sitemaps submitted.
- Analytics beacons confirmed firing, and the alert webhook confirmed *receiving* (send a test event) before the traffic arrives.
- Auth flow, checkout flow, and key revocation each tested end-to-end on production with a real (then refunded) or unpaid session.
- Post where your users are and stay for the first two hours of comments. Answer questions with shareable deep links into the product.
- Watch AI Crawl Control during week one.

---

*Total platform bill at hobby scale: the $5/mo Workers Paid plan plus an at-cost domain - D1, KV, R2, Queues, and Durable Objects all have free allowances inside it. Every phase is independently removable. Shape A needs no framework, no build step, and no npm packages; Shape B buys a framework deliberately and nothing else by accident.*

