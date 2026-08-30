#!/usr/bin/env node
// Pull GPU rental prices from providers directly and write data.json next to
// gpu-prices.html. Zero dependencies; plain fetch(). Runs two ways:
//
//     node scrape.mjs                  # writes data.json
//     node scrape.mjs --dry            # print rows, write nothing
//     node scrape.mjs --only vast,azure
//
//     wrangler deploy                  # Cloudflare Worker: cron scrapes into
//                                      # KV, fetch() serves / and /data.json
//
// Each provider is one function that returns a list of row objects. If one
// fails, the others still run and that provider's rows are carried forward
// from the previous data.json marked "stale": true — a flaky endpoint
// degrades the data instead of dropping it.
//
// EUR-priced providers (OVH, Scaleway, LeaderGPU, Seeweb) are converted to
// USD with the ECB's daily reference rate. A daily price-history index
// (cheapest $/GPU-hr per GPU and pricing type) is kept in history.json
// locally and in KV + /history.json on the Worker.
//
// Client-side-rendered pricing pages (Replicate, Novita) go through
// Cloudflare Browser Rendering's REST API — same product as the Workers
// `browser` binding, but callable with plain fetch() from both local node and
// the Worker, so there is still no npm dependency. Set CF_ACCOUNT_ID and
// CF_API_TOKEN (token permission: Browser Rendering > Edit): env vars
// locally, `wrangler secret put` on the Worker. Without them those three
// providers are skipped with a hint and everything else still runs. Rendered
// pages are re-fetched at most every 6 hours to stay inside the included
// browser-minutes quota; marketing pages don't move faster than that anyway.
//
// Endpoints last verified 2026-08-29. Probed but not included, and why:
// Vultr fronts its pricing page with a bot challenge that blocks datacenter
// IPs — including Cloudflare's own Browser Rendering (verified: the challenge
// never clears), though the page loads fine in a residential browser;
// TensorDock, Prime Intellect, Hyperbolic and SF Compute require API keys;
// GCP loads its pricing tables in lazy iframes even a rendered DOM doesn't
// contain (their billing API needs a key); Paperspace's fleet is now
// DigitalOcean (covered); TensorWave has no public pricing page (404,
// contact-sales only); Fluidstack dropped public pricing when it pivoted to
// gigawatt-scale enterprise deals; Linode's GPU fleet has no cards this
// table tracks; Hot Aisle's prices live in marketing prose too loose to
// parse reliably.

const UA_API = "gpu-prices/0.3 (personal price tracker)";
const UA_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TIMEOUT_MS = 25000;
const RETRIES = 3;

// Canonical names, so RTX_4090 / NVIDIA GeForce RTX 4090 / 4090 collapse to
// one row group. First match wins, so keep specific patterns (H100 NVL) above
// generic ones (H100). Extend as you see what the providers actually return.
const ALIASES = [
  [/h100.*sxm|sxm.*h100|hgx.*h100/, ["H100 SXM", 80, "Hopper"]],
  [/h100.*pcie/,                    ["H100 PCIe", 80, "Hopper"]], // before NVL: "H100 PCIe NVLink" is a PCIe part
  [/h100.*nvl/,                     ["H100 NVL", 94, "Hopper"]],
  [/\bh100\b/,                      ["H100 SXM", 80, "Hopper"]],
  [/gb300/,                         ["GB300", 288, "Blackwell"]],
  [/gb200|grace.?blackwell/,        ["GB200", 186, "Blackwell"]],
  [/gh200|grace.?hopper/,           ["GH200", 96, "Hopper"]],
  [/\bh200\b/,                      ["H200", 141, "Hopper"]],
  [/\bb200\b|hgx.*b200/,            ["B200", 192, "Blackwell"]],
  [/\bb300\b/,                      ["B300", 288, "Blackwell"]],
  [/mi300x/,                        ["MI300X", 192, "CDNA3"]],
  [/mi325x/,                        ["MI325X", 256, "CDNA3"]],
  [/mi350x/,                        ["MI350X", 288, "CDNA4"]],
  [/mi355x/,                        ["MI355X", 288, "CDNA4"]],
  [/a100.*pcie/,                    ["A100 PCIe", 80, "Ampere"]],
  [/\ba100\b/,                      ["A100 SXM", 80, "Ampere"]],
  [/l40s/,                          ["L40S", 48, "Ada"]],
  [/\bl40\b/,                       ["L40", 48, "Ada"]],
  [/\ba40\b/,                       ["A40", 48, "Ampere"]],
  [/6000\s*ada/,                    ["RTX 6000 Ada", 48, "Ada"]],
  [/rtx.?pro.?6000|pro.?6000/,      ["RTX PRO 6000", 96, "Blackwell"]],
  [/a6000/,                         ["RTX A6000", 48, "Ampere"]],
  [/4090/,                          ["RTX 4090", 24, "Ada"]],
  [/5090/,                          ["RTX 5090", 32, "Blackwell"]],
  [/\bl4\b/,                        ["L4", 24, "Ada"]],
  [/\bv100\b/,                      ["V100", 16, "Volta"]],
];

function canon(raw) {
  const s = (raw || "").toLowerCase();
  for (const [pat, out] of ALIASES) if (pat.test(s)) return out;
  return null;
}

// GET/POST with retries. Retries network errors, 429 and 5xx with backoff;
// other 4xx are permanent, so they throw immediately with the response body.
async function fetchRetry(url, { json = null, ua = UA_API, headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  let last;
  for (let i = 0; i < RETRIES; i++) {
    if (i) await new Promise(r => setTimeout(r, 1500 * i));
    try {
      const res = await fetch(url, {
        method: json ? "POST" : "GET",
        headers: { "User-Agent": ua, Accept: "*/*",
                   ...(json && { "Content-Type": "application/json" }), ...headers },
        body: json ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        if (res.status < 500 && res.status !== 429) { err.permanent = true; throw err; }
        last = err;
        continue;
      }
      return await res.text();
    } catch (e) {
      if (e.permanent) throw e;
      last = e;
    }
  }
  throw last;
}
const getJSON = async (url, opts) => JSON.parse(await fetchRetry(url, opts));

// Tag-stripped, entity-decoded, whitespace-collapsed page text, scripts removed.
const pageText = h => h
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&euro;/g, "€").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
  .replace(/\s+/g, " ");

function row(gpuRaw, provider, price, { count = 1, ptype = "on_demand", commit = null,
                                        avail = null, url = null, vram = null } = {}) {
  const c = canon(gpuRaw);
  price = Number(price);
  if (!c || !price) return null;
  const [name, vramGb, arch] = c;
  // A provider's "A100 SXM 40GB" or "PRO 6000 MIG 24GB" must not masquerade as
  // the canonical 80/96GB card: drop rows whose reported VRAM disagrees.
  if (vram && Math.abs(vram - vramGb) / vramGb > 0.25) return null;
  return {
    gpu: name, vram_gb: vramGb, architecture: arch,
    provider, gpu_count: count,
    price_per_hour_usd: Math.round(price * 1e4) / 1e4,
    pricing_type: ptype, commitment_months: commit,
    available: avail, source_url: url,
  };
}

// --------------------------------------------------------------------------
// Providers. Each returns rows (nulls are filtered by the caller).
// --------------------------------------------------------------------------

// Vast.ai marketplace search: POST the query object itself (NOT wrapped in
// {"q": ...} — that 400s) to /api/v0/bundles/. Public, no auth. The endpoint
// returns at most 64 offers per request no matter the limit, and sorting by
// price means cheap cards crowd out everything else — so query per price-band
// group of exact gpu_name values, as Vast spells them. Marketplace listings
// are individual people's machines; the page footer says so.
async function vast() {
  const groups = [
    ["H100 SXM", "H100 PCIE", "H100 NVL"],
    ["H200", "H200 NVL"],
    ["B200"],
    ["A100 SXM4", "A100 PCIE"],
    ["MI300X", "MI325X"],
    ["L40S", "L40", "A40"],
    ["RTX PRO 6000 WS", "RTX PRO 6000 S", "RTX PRO 6000 Max-Q"],
    ["RTX A6000", "RTX 6000Ada"],
    ["RTX 4090", "RTX 5090"],
    ["L4", "Tesla V100"],
  ];
  const results = await Promise.allSettled(groups.map(names =>
    getJSON("https://console.vast.ai/api/v0/bundles/", { json: {
      rentable: { eq: true }, gpu_name: { in: names },
      type: "on-demand", order: [["dph_total", "asc"]], limit: 64,
    } })));
  const offers = results.flatMap(r => r.status === "fulfilled" ? r.value.offers ?? [] : []);
  const failed = results.filter(r => r.status === "rejected");
  if (failed.length && !offers.length) throw failed[0].reason;
  if (failed.length) console.error(`vast: ${failed.length}/${groups.length} queries failed (${failed[0].reason})`);

  return offers.flatMap(o => {
    const n = o.num_gpus || 1;
    const opts = { count: n, vram: (o.gpu_ram || 0) / 1024 || null,
                   avail: !!o.rentable, url: "https://cloud.vast.ai/" };
    return [
      o.dph_total ? row(o.gpu_name, "Vast.ai", o.dph_total / n, opts) : null,
      o.min_bid ? row(o.gpu_name, "Vast.ai", o.min_bid / n, { ...opts, ptype: "spot" }) : null,
    ];
  });
}

// RunPod public GraphQL. Secure cloud is RunPod's own datacenters; community
// cloud is peer capacity, reported as its own provider so they aren't conflated.
async function runpod() {
  const d = await getJSON("https://api.runpod.io/graphql", { json: { query: `{
    gpuTypes { displayName memoryInGb
      secure: lowestPrice(input:{gpuCount:1, secureCloud:true}) { uninterruptablePrice minimumBidPrice stockStatus }
      community: lowestPrice(input:{gpuCount:1, secureCloud:false}) { uninterruptablePrice minimumBidPrice stockStatus } } }` } });
  if (d.errors) throw new Error(`graphql: ${JSON.stringify(d.errors[0])}`);
  return (d.data?.gpuTypes ?? []).flatMap(g =>
    [["secure", "Runpod"], ["community", "Runpod Community"]].flatMap(([tier, label]) =>
      [[g[tier]?.uninterruptablePrice, "on_demand"], [g[tier]?.minimumBidPrice, "spot"]].map(
        ([price, ptype]) => row(g.displayName, label, price,
          { ptype, vram: g.memoryInGb, avail: g[tier]?.stockStatus ? true : null,
            url: "https://runpod.io/pricing" }))));
}

// Lambda's pricing table is server-rendered HTML on lambda.ai/instances
// (lambdalabs.com redirects there). Four <table>s, one per instance size, with
// matching 8x/4x/2x/1x tab buttons; rows are
// Plan | VRAM/GPU | vCPUs | RAM | STORAGE | PRICE/GPU/HR.
async function lambdaLabs() {
  const page = await fetchRetry("https://lambda.ai/instances", { ua: UA_BROWSER });
  const counts = [...page.matchAll(/id="tab-[^"]*"[^>]*>\s*(\d+)\s*x/g)].map(m => +m[1]);
  const tables = page.match(/<table[\s\S]*?<\/table>/g) ?? [];
  if (!tables.length) throw new Error("no pricing tables on lambda.ai/instances (layout changed?)");
  const sizes = counts.length === tables.length ? counts : tables.map(() => 1);

  return tables.flatMap((tbl, i) =>
    [...tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(tr => {
      const cells = [...tr[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)]
        .map(c => pageText(c[1]).trim());
      if (cells.length < 6) return null;
      const price = cells.at(-1).match(/\$\s*([\d.]+)/);
      const vram = cells[1].match(/(\d+)\s*GB/);
      return price && row(cells[0], "Lambda Labs", price[1],
        { count: sizes[i], vram: vram && +vram[1], url: "https://lambda.ai/instances" });
    }));
}

// CoreWeave's pricing page renders spec tables server-side. Row text reads
// "NVIDIA HGX B200 8 180 128 2,048 61.44 $68.80": name, GPU count (sometimes
// with a footnote digit), VRAM, vCPUs, RAM, storage, instance $/hr.
async function coreweave() {
  const t = pageText(await fetchRetry("https://www.coreweave.com/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /(?:NVIDIA|AMD)\s+((?:[A-Z][\w-]*\s+|\d{4}\s+){1,4}?)(\d{1,2})(?:\s*\^?\d)?\s+(\d{2,3})\s+[\d,]+\s+[\d,.]+\s+[\d,.]+\s+\$([\d,]+\.\d{2})/g,
  )].map(m => row(m[1], "CoreWeave", parseFloat(m[4].replace(/,/g, "")) / +m[2],
    { count: +m[2], vram: +m[3], url: "https://www.coreweave.com/pricing" }));
  if (!rows.length) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Nebius prices are a server-rendered table quoted per GPU-hour:
// "NVIDIA HGX H100 16 200 $2.15 $3.85" = name, vCPUs/GPU, RAM/GPU,
// committed price, on-demand price. HGX means full 8-GPU nodes.
async function nebius() {
  const t = pageText(await fetchRetry("https://nebius.com/prices", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /NVIDIA\s+([A-Z][\w ]+?)\s+\d{1,3}\s+\d{2,4}\s+(\$[\d.]+|[–—-]+|Contact us)\s+(\$[\d.]+|[–—-]+|Contact us)/g,
  )].flatMap(m => {
    const count = /HGX/i.test(m[1]) ? 8 : 1;
    const opts = { count, url: "https://nebius.com/prices" };
    const price = s => (s.match(/\$([\d.]+)/) || [])[1];
    return [
      price(m[2]) ? row(m[1], "Nebius", price(m[2]), { ...opts, ptype: "reserved" }) : null,
      price(m[3]) ? row(m[1], "Nebius", price(m[3]), opts) : null,
    ];
  });
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Crusoe's pricing page: "NVIDIA H100 80GB HGX $3.90/GPU-hr Contact sales" =
// name, VRAM, form factor, on-demand $/GPU-hr, reserved (usually contact-only).
// HGX/SXM/OAM parts are sold as 8-GPU nodes.
async function crusoe() {
  const t = pageText(await fetchRetry("https://crusoe.ai/cloud/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    // the name must not swallow neighboring "Contact sales" rows
    /(?:NVIDIA|AMD)\s+((?:(?!NVIDIA|AMD|Contact)[\w ])+?)\s+(\d{2,3})GB\s+(?:(HGX|SXM\d?|PCIe|OAM|NVL\d*)\s+)?\$([\d.]+)\/GPU-hr/g,
  )].map(m => row(`${m[1]} ${m[3] ?? ""}`, "Crusoe", m[4],
    { count: /hgx|sxm|oam/i.test(m[3] ?? "") ? 8 : 1, vram: +m[2], url: "https://crusoe.ai/cloud/pricing" }));
  if (!rows.length) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Salad's pricing table: "RTX 5090 32GB 8GB 4 vCPUs $0.250 $182.50" = GPU,
// VRAM, system RAM, vCPUs, $/hr (lowest priority), $/mo. All Salad capacity is
// interruptible community hardware — the page footer's caveat applies.
async function salad() {
  const t = pageText(await fetchRetry("https://salad.com/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /\b((?:RTX|GTX)\s[\w ]*?)\s+(\d{1,3})GB\s+\d+\s*GB\s+\d+\s+vCPUs\s+\$([\d.]+)/g,
  )].map(m => row(m[1], "Salad Cloud", m[3],
    { vram: +m[2], avail: true, url: "https://salad.com/pricing" }));
  if (!rows.length) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Verda (formerly DataCrunch) has a public instance-types JSON. Prices are per
// instance; gpu.description reads like "2x GB300 SXM6 288GB" (VRAM per GPU).
async function verda() {
  const d = await getJSON("https://api.datacrunch.io/v1/instance-types");
  return d.flatMap(it => {
    const n = it.gpu?.number_of_gpus || 1;
    const desc = it.gpu?.description ?? "";
    const vram = (desc.match(/(\d+)GB/) || [])[1];
    const opts = { count: n, vram: vram && +vram, url: "https://datacrunch.io/" };
    return [
      it.price_per_hour ? row(desc, "Verda", it.price_per_hour / n, opts) : null,
      it.spot_price ? row(desc, "Verda", it.spot_price / n, { ...opts, ptype: "spot" }) : null,
    ];
  });
}

// Azure's retail prices API is public JSON, per SKU per region; we keep the
// cheapest Linux region for each SKU. armSkuName encodes the GPU config —
// the map below decodes it (ND96asr is the 40GB A100; the VRAM guard drops it).
const AZURE_SKUS = [
  [/^Standard_NC(\d+)ads_A100_v4/, m => ["A100 PCIe", +m[1] / 24, 80]],
  [/^Standard_NCC?40ads_H100_v5/,  () => ["H100 NVL", 1, 94]],
  [/^Standard_NC80adis_H100_v5/,   () => ["H100 NVL", 2, 94]],
  [/^Standard_ND96\w*_H100_v5/,    () => ["H100 SXM", 8, 80]],
  [/^Standard_ND96\w*_H200_v5/,    () => ["H200", 8, 141]],
  [/^Standard_ND96\w*_MI300X_v5/,  () => ["MI300X", 8, 192]],
  [/^Standard_ND96asr_A100_v4/,    () => ["A100 SXM", 8, 40]],
  [/^Standard_ND96am\w*_A100_v4/,  () => ["A100 SXM", 8, 80]],
  [/^Standard_ND\d+isrf?_NDR_GB200_v6/, () => ["GB200", 4, 186]],
];

async function azure() {
  const filter = "serviceName eq 'Virtual Machines' and priceType eq 'Consumption' " +
    "and unitOfMeasure eq '1 Hour' and (" +
    ["H100", "H200", "B200", "A100", "MI300", "GB200"]
      .map(g => `contains(armSkuName,'${g}')`).join(" or ") + ")";
  let url = "https://prices.azure.com/api/retail/prices?$filter=" + encodeURIComponent(filter);
  const best = new Map();
  for (let page = 0; url && page < 25; page++) {
    const d = await getJSON(url);
    for (const it of d.Items ?? []) {
      if (it.productName?.includes("Windows") || it.meterName?.includes("Low Priority")) continue;
      const k = `${it.armSkuName}|${it.meterName?.includes("Spot") ? "spot" : "on_demand"}`;
      if (!best.has(k) || it.retailPrice < best.get(k)) best.set(k, it.retailPrice);
    }
    url = d.NextPageLink;
  }
  return [...best].map(([k, price]) => {
    const [sku, ptype] = k.split("|");
    for (const [pat, decode] of AZURE_SKUS) {
      const m = sku.match(pat);
      if (m) {
        const [gpu, count, vram] = decode(m);
        return row(gpu, "Azure", price / count, { count, ptype, vram,
          url: "https://azure.microsoft.com/pricing/details/virtual-machines/linux/" });
      }
    }
    return null;
  });
}

// DigitalOcean GPU Droplets (the old Paperspace fleet). Server-rendered page
// with three sections — "12 Month Reserved Plans", "Spot Plans", "On-Demand
// Plans" — each listing "NVIDIA HGX H200 $3.40 /GPU/hour"-style rows. The
// nearest preceding section header decides the pricing type.
async function digitalocean() {
  const t = pageText(await fetchRetry("https://www.digitalocean.com/pricing/gpu-droplets", { ua: UA_BROWSER }));
  const sections = [...t.matchAll(/(12 Month Reserved|Spot|On-Demand) Plans/g)]
    .map(m => ({ at: m.index, ptype: m[1] === "Spot" ? "spot" : m[1] === "On-Demand" ? "on_demand" : "reserved" }));
  const rows = [...t.matchAll(/((?:NVIDIA|AMD)[\w™\- ]{2,45}?)\s+\$([\d.]+)\s*\/GPU\/hour/g)]
    .map(m => {
      const sec = sections.filter(s => s.at < m.index).at(-1);
      if (!sec) return null;
      return row(m[1], "DigitalOcean", m[2], {
        ptype: sec.ptype, commit: sec.ptype === "reserved" ? 12 : null,
        count: /HGX|Instinct/.test(m[1]) ? 8 : 1,
        url: "https://www.digitalocean.com/pricing/gpu-droplets" });
    });
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// AWS publishes small per-region on-demand JSON maps (the ones its own pricing
// pages read) and a public all-region spot price feed. We read us-east-1
// on-demand plus the cheapest spot region for the P/G GPU families.
const AWS_TYPES = {
  "p4d.24xlarge": ["A100 SXM", 8, 40], "p4de.24xlarge": ["A100 SXM", 8, 80],
  "p5.4xlarge": ["H100 SXM", 1, 80], "p5.48xlarge": ["H100 SXM", 8, 80],
  "p5e.48xlarge": ["H200", 8, 141], "p5en.48xlarge": ["H200", 8, 141],
  "p6-b200.48xlarge": ["B200", 8, 180], "p6-b300.48xlarge": ["B300", 8, 288],
  "g6e.xlarge": ["L40S", 1, 48], "g6e.12xlarge": ["L40S", 4, 48],
  "g6e.24xlarge": ["L40S", 4, 48], "g6e.48xlarge": ["L40S", 8, 48],
};
const AWS_URL = "https://aws.amazon.com/ec2/pricing/on-demand/";

async function aws() {
  const od = await getJSON("https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/" +
    "ec2-ondemand-without-sec-sel/US%20East%20(N.%20Virginia)/Linux/index.json");
  const rows = [];
  for (const inst of Object.values(od.regions?.["US East (N. Virginia)"] ?? {})) {
    const spec = AWS_TYPES[inst["Instance Type"]];
    if (spec) rows.push(row(spec[0], "AWS", inst.price / spec[1],
      { count: spec[1], vram: spec[2], url: AWS_URL }));
  }
  if (!rows.some(Boolean)) throw new Error("parsed zero on-demand rows (format changed?)");
  try { // spot feed is 3MB and best-effort; on-demand alone is still a result
    const spot = await getJSON("https://website.spot.ec2.aws.a2z.com/spot.json");
    const best = new Map();
    for (const region of spot.config?.regions ?? [])
      for (const it of region.instanceTypes ?? [])
        for (const size of it.sizes ?? []) {
          if (!AWS_TYPES[size.size]) continue;
          const usd = parseFloat(size.valueColumns?.find(v => v.name === "linux")?.prices?.USD);
          if (usd > 0 && (!best.has(size.size) || usd < best.get(size.size))) best.set(size.size, usd);
        }
    for (const [type, usd] of best) {
      const [gpu, count, vram] = AWS_TYPES[type];
      rows.push(row(gpu, "AWS", usd / count, { count, vram, ptype: "spot", url: AWS_URL }));
    }
  } catch (e) {
    console.error(`aws: spot feed failed (${e}), on-demand only`);
  }
  return rows;
}

// Oracle's cost-estimator API is public JSON. GPU shapes appear as
// "OCI - Compute - GPU - H200" with a PAY_AS_YOU_GO price per GPU-hour.
const ORACLE_COUNTS = { GB200: 4, L40S: 4, A10: 1 };
async function oracle() {
  const d = await getJSON("https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD");
  return (d.items ?? []).map(it => {
    const name = it.displayName ?? "";
    const m = name.match(/^(?:OCI - )?Compute - GPU - (\w+)$/);
    if (!m) return null;
    const gpu = m[1].replace(/^H100T$/, "H100"); // their H100 SKU is "H100T"
    const price = it.currencyCodeLocalizations?.[0]?.prices
      ?.find(p => p.model === "PAY_AS_YOU_GO")?.value;
    return row(gpu, "Oracle Cloud", price, { count: ORACLE_COUNTS[gpu] ?? 8,
      url: "https://www.oracle.com/cloud/compute/pricing/" });
  });
}

// Together AI's GPU Clusters table: "NVIDIA HGX H100 $5.49 Contact sales" =
// name, on-demand $/GPU-hr, reserved (contact-only). Full HGX nodes.
async function together() {
  const t = pageText(await fetchRetry("https://www.together.ai/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /NVIDIA\s+((?:HGX\s+)?[A-Z]{1,2}\d{3}(?:\s+NVL\d+)?)\s+(\$[\d.]+|Contact us)\s+(\$[\d.]+|Contact sales|Contact us)/g,
  )].flatMap(m => {
    const price = s => (s.match(/\$([\d.]+)/) || [])[1];
    const opts = { count: 8, url: "https://www.together.ai/pricing" };
    return [
      price(m[2]) ? row(m[1], "Together AI", price(m[2]), opts) : null,
      price(m[3]) ? row(m[1], "Together AI", price(m[3]), { ...opts, ptype: "reserved" }) : null,
    ];
  });
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Modal prices serverless GPUs per second ("Nvidia H100 SXM5 $0.001097 / sec");
// multiply out to an hourly rate. Fine-grained autoscaling, so count is 1.
async function modal() {
  const t = pageText(await fetchRetry("https://modal.com/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(/Nvidia\s+([\w ]{2,25}?)\s+\$([\d.]+)\s*\/\s*sec/gi)]
    .map(m => row(m[1], "Modal", parseFloat(m[2]) * 3600,
      { avail: true, url: "https://modal.com/pricing" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Jarvis Labs lists GPU cards as "H100 SXM Hopper · 80 GB $2.69" (name,
// architecture, VRAM, $/hr).
async function jarvis() {
  const t = pageText(await fetchRetry("https://jarvislabs.ai/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /([A-Z][\w ]{1,20}?)\s+(?:Ada|Ampere|Hopper|Blackwell|Volta)\s+·\s+(\d+)\s*GB\s+\$([\d.]+)/g,
  )].map(m => row(m[1], "Jarvis Labs", m[3],
    { vram: +m[2], avail: true, url: "https://jarvislabs.ai/pricing" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Cudo Compute's machine-types API is public JSON with a per-GPU hourly price
// and live free-GPU counts per datacenter.
async function cudo() {
  const d = await getJSON("https://rest.compute.cudo.org/v1/vms/machine-types");
  return (d.machineTypes ?? []).map(mt => {
    const vram = (mt.gpuModel?.match(/(\d+)GB/) || [])[1];
    return row(mt.gpuModel, "Cudo Compute", mt.gpuPriceHr?.value, {
      vram: vram && +vram, avail: (mt.totalGpuFree ?? 0) > 0,
      url: "https://www.cudocompute.com/pricing" });
  });
}

// EUR → USD via the ECB's daily reference rate, cached for 6 hours.
let fxCache = { t: 0, rate: null };
async function eurUsd() {
  if (fxCache.rate && Date.now() - fxCache.t < 6 * 3600e3) return fxCache.rate;
  const xml = await fetchRetry("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
  const m = xml.match(/currency=["']USD["']\s+rate=["']([\d.]+)["']/);
  if (!m) throw new Error("ECB EUR-USD rate not found");
  fxCache = { t: Date.now(), rate: parseFloat(m[1]) };
  return fxCache.rate;
}

// Hyperstack's pricing page is server-rendered (their pricebook API went
// key-only): "NVIDIA H200 SXM 141 22 225 $3.99" = name, VRAM, pCPUs, RAM, $/GPU-hr.
async function hyperstack() {
  const t = pageText(await fetchRetry("https://www.hyperstack.cloud/gpu-pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /NVIDIA\s+((?:(?!NVIDIA)[\w .-])+?)\s+(\d{2,3})\s+\d{1,3}\s+\d{2,4}\s+\$([\d.]+)/g,
  )].map(m => row(m[1].replace(/NVLink/i, "PCIe NVLink"), "Hyperstack", m[3],
    { vram: +m[2], url: "https://www.hyperstack.cloud/gpu-pricing" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// fal's GPU fleet table: "B300 288GB $8.50/h $4.49/h" = GPU, VRAM, list
// price, committed "as low as" price.
async function fal() {
  const t = pageText(await fetchRetry("https://fal.ai/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /([A-Z][\w]{1,12}(?: [A-Z\d][\w]{0,10})?)\s+(\d{2,3})GB\s+\$([\d.]+)\/h\s+\$([\d.]+)\/h/g,
  )].flatMap(m => [
    row(m[1], "fal", m[3], { vram: +m[2], url: "https://fal.ai/pricing" }),
    row(m[1], "fal", m[4], { vram: +m[2], ptype: "reserved", url: "https://fal.ai/pricing" }),
  ]);
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Koyeb's instance table: "RTX-A6000 vRAM 48GB vRAM 48GB $ 0.75 /hour" —
// standard tier hourly rate per GPU.
async function koyeb() {
  const t = pageText(await fetchRetry("https://www.koyeb.com/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /([A-Z][\w-]{1,17}?)\s+vRAM\s+(\d{2,3})GB\s+vRAM\s+\d{2,3}GB\s+\$\s*([\d.]+)\s*\/hour/g,
  )].map(m => row(m[1].replace(/-/g, " "), "Koyeb", m[3],
    { vram: +m[2], url: "https://www.koyeb.com/pricing" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Baseten prices per minute: "H100 80 GiB VRAM $0.10833" → ×60 for hourly.
async function baseten() {
  const t = pageText(await fetchRetry("https://www.baseten.co/pricing/", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(/([A-Z][\w ]{1,16}?)\s+(\d{2,3})\s*GiB\s+VRAM\s+\$([\d.]+)/g)]
    .map(m => row(m[1], "Baseten", parseFloat(m[3]) * 60,
      { vram: +m[2], avail: true, url: "https://www.baseten.co/pricing/" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Civo's GPU tables: "Small 1 x NVIDIA L40S - 48GB ... $1.29 per hour ..." —
// instance total for N GPUs; the first hourly figure is on-demand (the rest
// are commitment tiers).
async function civo() {
  const t = pageText(await fetchRetry("https://www.civo.com/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /(\d)\s*x\s+NVIDIA\s+([\w ]+?)\s*-\s*(\d{2,3})GB[^$]{0,80}\$([\d,.]+)\s*per hour/g,
  )].map(m => row(m[2], "Civo", parseFloat(m[4].replace(/,/g, "")) / +m[1],
    { count: +m[1], vram: +m[3], url: "https://www.civo.com/pricing" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Denvr Dataworks quotes per GPU: "NVIDIA H100 SXM 8 80 GB ... $2.45 / GPU"
// = name, GPU count, VRAM, per-GPU hourly. "Reserved only" rows have no price.
async function denvr() {
  const t = pageText(await fetchRetry("https://www.denvrdata.com/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /NVIDIA\s+([\w ]+?)\s+(\d)\s+(\d{2,3})\s*GB\s+[^$]{0,80}\$([\d.]+)\s*\/\s*GPU/g,
  )].map(m => row(m[1], "Denvr Dataworks", m[4],
    { count: +m[2], vram: +m[3], url: "https://www.denvrdata.com/pricing" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Scaleway's instance products API is public JSON (EUR): servers keyed
// "H100-2-80G" with a gpu count and per-instance hourly_price. The plain
// H100-N-80G shapes are PCIe; H100-SXM-* are SXM.
async function scaleway() {
  const fx = await eurUsd();
  const rows = [];
  for (let page = 1; page <= 3; page++) {
    const d = await getJSON(`https://api.scaleway.com/instance/v1/zones/fr-par-2/products/servers?per_page=100&page=${page}`);
    const servers = Object.entries(d.servers ?? {});
    for (const [name, s] of servers) {
      if (!s.gpu || !s.hourly_price) continue;
      const raw = name.replace(/^H100-SXM/, "H100 SXM").replace(/^H100-/, "H100 PCIe-");
      rows.push(row(raw, "Scaleway", (s.hourly_price * fx) / s.gpu, {
        count: s.gpu, vram: +(name.match(/-(\d+)G$/)?.[1] ?? 0) || null,
        url: "https://www.scaleway.com/en/pricing/gpu/" }));
    }
    if (servers.length < 100) break;
  }
  if (!rows.some(Boolean)) throw new Error("no GPU servers in catalog (format changed?)");
  return rows;
}

// OVH's public order catalog (EUR, prices in 1e-8 units). The AI training /
// notebook addons are per-minute per instance, named "ai-training.h100-1-gpu".
async function ovh() {
  const fx = await eurUsd();
  const d = await getJSON("https://api.ovh.com/1.0/order/catalog/public/cloud?ovhSubsidiary=FR");
  return (d.addons ?? []).map(a => {
    const m = (a.planCode ?? "").match(/^ai-(?:training|notebook)\.(\w+?)-(\d+)-gpu\.minute\.consumption$/);
    if (!m) return null;
    const price = a.pricings?.find(p => p.price > 0)?.price;
    if (!price) return null;
    return row(m[1].replace(/^h100$/, "H100 PCIe"), // OVH's AI-instance H100s are PCIe
      "OVHcloud", ((price / 1e8) * 60 * fx) / +m[2],
      { count: +m[2], url: "https://www.ovhcloud.com/en/public-cloud/prices/" });
  });
}

// LeaderGPU rents dedicated monthly servers (EUR): "NVIDIA H100 SXM Popular
// 8x NVLink 80 GB HBM3 €1,488 €11,900" = name, count, VRAM, per-card monthly,
// total monthly. Reported as a 1-month commitment at monthly/730 per hour.
async function leadergpu() {
  const fx = await eurUsd();
  const t = pageText(await fetchRetry("https://www.leadergpu.com/", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /NVIDIA\s+((?:(?!NVIDIA)[\w ])+?)\s+(?:New|Popular)?\s*(\d)x\s+(?:NVLink\s+)?(\d{2,3})\s*GB\s+\w+(?:\s+ECC)?\s+€([\d,]+)/g,
  )].map(m => row(m[1], "LeaderGPU", (parseFloat(m[4].replace(/,/g, "")) / 730) * fx,
    { count: +m[2], vram: +m[3], ptype: "reserved", commit: 1,
      url: "https://www.leadergpu.com/" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Seeweb quotes per GPU-hour in EUR: "CLOUD GPU NVIDIA H200 1 2 4 8 GPU SXM
// | 141 GB GPU RAM ... Hourly Cost 2.60 €". No VRAM hint — the GPU RAM figure
// is sometimes the multi-GPU total.
async function seeweb() {
  const fx = await eurUsd();
  const t = pageText(await fetchRetry("https://www.seeweb.it/en/products/cloud-server-gpu", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /CLOUD GPU\s+(?:NVIDIA|AMD)\s+([\w ]+?)\s+1 2 4 8 GPU[^€]{0,140}?Hourly Cost\s+([\d.,]+)\s*€/g,
  )].map(m => row(m[1], "Seeweb", parseFloat(m[2].replace(",", ".")) * fx,
    { url: "https://www.seeweb.it/en/products/cloud-server-gpu" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Voltage Park's headline rate lives in the pricing-page FAQ: "You can rent
// one H100 GPU for 1 hour starting at $X.XX". One row, but a notable one.
async function voltagepark() {
  const t = pageText(await fetchRetry("https://www.voltagepark.com/pricing", { ua: UA_BROWSER }));
  const m = t.match(/rent one H100 GPU for 1 hour starting at\s+\$([\d.]+)/i);
  if (!m) throw new Error("H100 rate sentence not found (layout changed?)");
  return [row("H100 SXM", "Voltage Park", m[1],
    { avail: true, url: "https://www.voltagepark.com/pricing" })];
}

// Lium is a Bittensor-based GPU marketplace; its landing page server-renders
// the live pod list: "4 X NVIDIA RTX A6000 DinD ... $1.68 /HOUR" (pod total).
async function lium() {
  const t = pageText(await fetchRetry("https://lium.io/", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(/(\d+)\s*X\s*NVIDIA\s+([\w ]+?)\s+DinD[^$]{0,140}?\$([\d.]+)\s*\/\s*HOUR/gi)]
    .map(m => row(m[2], "Lium.io", parseFloat(m[3]) / +m[1],
      { count: +m[1], avail: true, url: "https://lium.io/" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Thunder Compute: "H100 PCIe VRAM 80 GB vCPUs ... GPU/hr (*) $3.20".
async function thunder() {
  const t = pageText(await fetchRetry("https://www.thundercompute.com/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(/([A-Z][\w ]{1,16}?)\s+VRAM\s+(\d{2,3})\s*GB[^$]{5,160}?GPU\/hr\s*\(\*\)\s*\$([\d.]+)/g)]
    .map(m => row(m[1], "Thunder Compute", m[3],
      { vram: +m[2], avail: true, url: "https://www.thundercompute.com/pricing" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Spheron cards: "H100 Hopper 80 GB ... $2.98 /hr Spot $2.10 /hr" — prices
// bounded per card so one GPU's spot doesn't leak into the next.
async function spheron() {
  const t = pageText(await fetchRetry("https://www.spheron.network/pricing", { ua: UA_BROWSER }));
  const cards = [...t.matchAll(/([A-Z][\w]+(?:\s[A-Z\d][\w]*)?)\s+(?:Blackwell|Hopper|Ampere|Ada|CDNA\w*)\s+(\d{2,3}) GB\b/g)];
  const rows = cards.flatMap((m, i) => {
    const block = t.slice(m.index, cards[i + 1]?.index ?? m.index + 240);
    return [...block.matchAll(/(Spot\s+)?\$([\d.]+)\s*\/hr/g)].map(p =>
      row(m[1], "Spheron", p[2], { vram: +m[2], ptype: p[1] ? "spot" : "on_demand",
        url: "https://www.spheron.network/pricing" }));
  });
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Beam prices serverless GPUs per second: "H100 PCIE 80 GB VRAM 80 GB $0.000986 /sec".
async function beam() {
  const t = pageText(await fetchRetry("https://www.beam.cloud/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(/([A-Z][\w]+(?:\s[A-Z\d][\w]*){0,2}?)\s+(\d{2,3}) GB VRAM\s+\d{2,3} GB\s+\$([\d.]+)\s*\/sec/g)]
    .map(m => row(m[1], "Beam", parseFloat(m[3]) * 3600,
      { vram: +m[2], avail: true, url: "https://www.beam.cloud/pricing" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Massed Compute cards: a GPU name ("B200 SXM6 × 8", "RTX PRO 6000 Blackwell
// (96GB) × 1") followed by "× N <specs> $XX.XX /hr" rows priced per instance.
async function massed() {
  const t = pageText(await fetchRetry("https://massedcompute.com/pricing/", { ua: UA_BROWSER }));
  const names = [...t.matchAll(/((?:RTX|GTX|H\d{3}|B\d{3}|A\d{3}|L4\dS?|GH200|GB\d{3}|MI\d{3}X?)[\w \-]{0,26}?)\s*(?:\((\d{2,3})GB\))?\s*×/g)];
  const rows = [...t.matchAll(/×\s*(\d)\s+[^$×]{0,80}?\$([\d,.]+)\s*\/hr/g)].map(m => {
    const nm = names.filter(n => n.index <= m.index).at(-1);
    if (!nm) return null;
    return row(nm[1], "Massed Compute", parseFloat(m[2].replace(/,/g, "")) / +m[1],
      { count: +m[1], vram: nm[2] ? +nm[2] : null, url: "https://massedcompute.com/pricing/" });
  });
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// GPU.ai routes to partner datacenters with live rates:
// "H100 SXM 80G high availability $1.87 /hr", "8× A100 80G ... $1.05 /hr".
async function gpuai() {
  const t = pageText(await fetchRetry("https://gpu.ai/", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /(?:(\d)×\s*)?([A-Z][\w]+(?:\s[A-Z\d][\w]*)?)\s+(\d{2,3})G\b\s*(high availability|limited availability|available|out of stock)?\s*\$([\d.]+)\s*\/hr/g,
  )].map(m => row(m[2], "GPU.ai", m[5], { count: m[1] ? +m[1] : 1, vram: +m[3],
    avail: m[4] ? !/out of stock/.test(m[4]) : null, url: "https://gpu.ai/" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// Latitude.sh dedicated GPU metal: "Starting At $24/hr $17,520/mo Plan
// g3.h100.small GPU 1 x NVIDIA H100 80GB" — instance totals.
async function latitude() {
  const t = pageText(await fetchRetry("https://www.latitude.sh/pricing", { ua: UA_BROWSER }));
  const rows = [...t.matchAll(
    /\$([\d,]+(?:\.\d+)?)\/hr\s+\$[\d,]+(?:\.\d+)?\/mo\s+Plan\s+[\w.]+\s+GPU\s+(\d+)\s*x\s+NVIDIA\s+([\w ]+?)\s+(\d{2,3})GB/g,
  )].map(m => row(m[3], "Latitude.sh", parseFloat(m[1].replace(/,/g, "")) / +m[2],
    { count: +m[2], vram: +m[4], url: "https://www.latitude.sh/pricing" }));
  if (!rows.some(Boolean)) throw new Error("parsed zero rows (layout changed?)");
  return rows;
}

// --------------------------------------------------------------------------
// Browser-rendered providers, via Cloudflare Browser Rendering (REST).
// --------------------------------------------------------------------------

let RENDER_CREDS = null; // set by scrape() from env
async function renderPage(url) {
  if (!RENDER_CREDS) throw new Error(
    "browser rendering not configured — set CF_ACCOUNT_ID and CF_API_TOKEN");
  const res = await fetchRetry(
    `https://api.cloudflare.com/client/v4/accounts/${RENDER_CREDS.accountId}/browser-rendering/content`,
    // "load" + a settle delay beats networkidle0: analytics long-polls keep
    // some pages from ever going network-idle.
    { json: { url, gotoOptions: { waitUntil: "load", timeout: 45000 }, waitForTimeout: 4000 },
      headers: { Authorization: `Bearer ${RENDER_CREDS.token}` },
      timeoutMs: 75000 });
  const d = JSON.parse(res);
  if (!d.success) throw new Error(`browser rendering: ${JSON.stringify(d.errors ?? d).slice(0, 200)}`);
  return pageText(d.result);
}

// Parsers take rendered page text, so they can be tested without credentials.
export const renderParsers = {
  // "gpu-h100 $ 0.001525 /sec $ 5.49 /hr GPU 1x ..."; multi-GPU sizes in
  // the "Additional hardware" list note "committed spend contracts".
  replicate(t) {
    return [...t.matchAll(/gpu-([a-z0-9]+)(?:-large)?(?:-(\d)x)?\s+\$\s*[\d.]+\s*\/\s*sec\s+\$\s*([\d.]+)\s*\/\s*hr/g)]
      .map(m => {
        const next = t.indexOf("gpu-", m.index + 4); // this entry's text only
        return row(m[1], "Replicate", parseFloat(m[3]) / (+m[2] || 1), {
          count: +m[2] || 1, avail: true,
          ptype: /committed spend/.test(t.slice(m.index, next < 0 ? m.index + 240 : next))
            ? "reserved" : "on_demand",
          url: "https://replicate.com/pricing" });
      });
  },
  // Novita: "H100 SXM 80GB 80 GB VRAM 3.39/hr/GPU 1.70/hr/GPU" (spot is "—"
  // when absent).
  novita(t) {
    return [...t.matchAll(/([A-Z][\w ]{1,14}?)\s+(\d{2,3})GB\s+\d{2,3} GB VRAM\s+([\d.]+)\/hr\/GPU\s+(?:([\d.]+)\/hr\/GPU|—)/g)]
      .flatMap(m => [
        row(m[1], "Novita", m[3], { vram: +m[2], url: "https://novita.ai/gpus" }),
        m[4] ? row(m[1], "Novita", m[4], { vram: +m[2], ptype: "spot", url: "https://novita.ai/gpus" }) : null,
      ]);
  },
};

const replicate = async () => renderParsers.replicate(await renderPage("https://replicate.com/pricing"));
const novita = async () => renderParsers.novita(await renderPage("https://novita.ai/gpus"));

const PROVIDERS = {
  vast:      { names: ["Vast.ai"], fn: vast },
  runpod:    { names: ["Runpod", "Runpod Community"], fn: runpod },
  lambda:    { names: ["Lambda Labs"], fn: lambdaLabs },
  coreweave: { names: ["CoreWeave"], fn: coreweave },
  nebius:    { names: ["Nebius"], fn: nebius },
  crusoe:    { names: ["Crusoe"], fn: crusoe },
  salad:     { names: ["Salad Cloud"], fn: salad },
  verda:     { names: ["Verda"], fn: verda },
  azure:     { names: ["Azure"], fn: azure },
  aws:       { names: ["AWS"], fn: aws },
  oracle:    { names: ["Oracle Cloud"], fn: oracle },
  digitalocean: { names: ["DigitalOcean"], fn: digitalocean },
  together:  { names: ["Together AI"], fn: together },
  modal:     { names: ["Modal"], fn: modal },
  jarvis:    { names: ["Jarvis Labs"], fn: jarvis },
  cudo:      { names: ["Cudo Compute"], fn: cudo },
  voltagepark: { names: ["Voltage Park"], fn: voltagepark },
  hyperstack: { names: ["Hyperstack"], fn: hyperstack },
  fal:       { names: ["fal"], fn: fal },
  koyeb:     { names: ["Koyeb"], fn: koyeb },
  baseten:   { names: ["Baseten"], fn: baseten },
  civo:      { names: ["Civo"], fn: civo },
  denvr:     { names: ["Denvr Dataworks"], fn: denvr },
  scaleway:  { names: ["Scaleway"], fn: scaleway },
  ovh:       { names: ["OVHcloud"], fn: ovh },
  leadergpu: { names: ["LeaderGPU"], fn: leadergpu },
  seeweb:    { names: ["Seeweb"], fn: seeweb },
  lium:      { names: ["Lium.io"], fn: lium },
  thunder:   { names: ["Thunder Compute"], fn: thunder },
  spheron:   { names: ["Spheron"], fn: spheron },
  beam:      { names: ["Beam"], fn: beam },
  massed:    { names: ["Massed Compute"], fn: massed },
  gpuai:     { names: ["GPU.ai"], fn: gpuai },
  latitude:  { names: ["Latitude.sh"], fn: latitude },
  replicate: { names: ["Replicate"], fn: replicate, render: true },
  novita:    { names: ["Novita"], fn: novita, render: true },
};

const RENDER_TTL_MS = 6 * 3600e3; // rendered pages are re-fetched at most this often
const CACHED = Symbol("cached");

// --------------------------------------------------------------------------

// Run the requested providers (all of them by default, concurrently), fall
// back to `prev` (the previous payload) for any that fail, dedupe to the
// cheapest row per (provider, gpu, count, pricing type, commitment).
export async function scrape(prev = {}, only = null, env = {}) {
  const accountId = env.CF_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CF_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN;
  RENDER_CREDS = accountId && token ? { accountId, token } : null;
  const keys = only ?? Object.keys(PROVIDERS);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  const prevRows = {};
  for (const r of prev.data ?? []) (prevRows[r.provider] ??= []).push(r);
  const carry = key => PROVIDERS[key].names.flatMap(n => prevRows[n] ?? []);

  let rows = [];
  const status = {};
  const results = await Promise.allSettled(keys.map(k => {
    const p = PROVIDERS[k];
    const was = prev.providers?.[k];
    if (p.render && was?.ok && was.fetched_at &&
        Date.parse(now) - Date.parse(was.fetched_at) < RENDER_TTL_MS)
      return Promise.resolve(CACHED); // still fresh; save browser minutes
    return p.fn();
  }));
  keys.forEach((key, i) => {
    const r = results[i];
    if (r.status === "fulfilled" && r.value === CACHED) {
      rows = rows.concat(carry(key));
      status[key] = prev.providers[key];
      console.error(`${key}: cached render (fetched ${prev.providers[key].fetched_at})`);
      return;
    }
    const got = r.status === "fulfilled" ? r.value.filter(Boolean) : [];
    if (got.length) {
      rows = rows.concat(got);
      status[key] = { ok: true, rows: got.length, fetched_at: now };
      console.error(`${key}: ${got.length} rows`);
    } else {
      const err = r.status === "rejected" ? String(r.reason) : "fetch succeeded but produced 0 rows";
      const kept = carry(key).map(x => ({ ...x, stale: true }));
      rows = rows.concat(kept);
      status[key] = { ok: false, error: err, rows: kept.length,
                      fetched_at: prev.providers?.[key]?.fetched_at ?? prev.generated_at ?? null };
      console.error(`${key}: failed (${err})${kept.length ? ` — kept ${kept.length} stale rows` : ""}`);
    }
  });
  // Providers excluded by --only keep their previous rows and status as-is.
  for (const key of Object.keys(PROVIDERS)) {
    if (keys.includes(key)) continue;
    const kept = carry(key);
    if (kept.length) {
      rows = rows.concat(kept);
      status[key] = prev.providers?.[key] ??
        { ok: true, rows: kept.length, fetched_at: prev.generated_at ?? null };
    }
  }

  const best = new Map();
  for (const r of rows) {
    const k = [r.provider, r.gpu, r.gpu_count, r.pricing_type, r.commitment_months].join("|");
    if (!best.has(k) || r.price_per_hour_usd < best.get(k).price_per_hour_usd) best.set(k, r);
  }
  rows = [...best.values()].sort((a, b) =>
    a.gpu.localeCompare(b.gpu) || a.price_per_hour_usd - b.price_per_hour_usd);

  return rows.length ? { generated_at: now, providers: status, data: rows } : null;
}

// Daily price-history index: for each UTC day, the cheapest live (non-stale)
// $/GPU-hr per GPU and pricing type across all providers — the day keeps its
// minimum. ~400 days retained. This is what the aggregators' trend charts
// are built on.
export function updateHistory(hist, payload) {
  const day = payload.generated_at.slice(0, 10);
  const entry = hist[day] ?? {};
  for (const r of payload.data) {
    if (r.stale) continue;
    const g = entry[r.gpu] ?? (entry[r.gpu] = {});
    if (g[r.pricing_type] == null || r.price_per_hour_usd < g[r.pricing_type])
      g[r.pricing_type] = r.price_per_hour_usd;
  }
  hist[day] = entry;
  const days = Object.keys(hist).sort();
  for (const d of days.slice(0, Math.max(0, days.length - 400))) delete hist[d];
  return hist;
}

// --------------------------------------------------------------------------
// Cloudflare Worker: cron fills KV, fetch() serves the app and /data.json.
// --------------------------------------------------------------------------

// Parser-rot alerting: when a provider has been failing for 24h+, POST to the
// optional ALERT_WEBHOOK secret (Slack, Discord, and plain-text/ntfy.sh
// payload shapes auto-detected from the URL). Re-alerts at most daily per
// provider; resets when it recovers. Failures always show in the app anyway
// (the header label and dimmed "*" rows), so this is belt-and-braces.
async function alertOnRot(env, payload) {
  if (!env.ALERT_WEBHOOK) return;
  const now = Date.parse(payload.generated_at);
  const state = await env.PRICES.get("alerts", "json").catch(() => null) ?? {};
  let dirty = false;
  for (const k of Object.keys(state))
    if (payload.providers[k]?.ok) { delete state[k]; dirty = true; }
  const due = Object.entries(payload.providers).filter(([k, v]) =>
    !v.ok && (!v.fetched_at || now - Date.parse(v.fetched_at) > 24 * 3600e3) &&
    (!state[k] || now - state[k] > 24 * 3600e3));
  if (due.length) {
    const msg = "GPUTable parser alert — failing for 24h+:\n" + due.map(([k, v]) =>
      `• ${k}: ${(v.error ?? "no rows").slice(0, 120)} (last good: ${v.fetched_at ?? "never"})`).join("\n");
    const slack = env.ALERT_WEBHOOK.includes("hooks.slack.com");
    const discord = env.ALERT_WEBHOOK.includes("discord.com/api/webhooks");
    await fetch(env.ALERT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": slack || discord ? "application/json" : "text/plain" },
      body: slack ? JSON.stringify({ text: msg })
          : discord ? JSON.stringify({ content: msg }) : msg,
    }).catch(() => {});
    for (const [k] of due) state[k] = now;
    dirty = true;
  }
  if (dirty) await env.PRICES.put("alerts", JSON.stringify(state));
}

// Marketplace prices move minute-to-minute; list prices move weekly. The cron
// fires every 5 minutes: quarter-hour ticks run the full sweep, the ticks in
// between refresh only the live marketplaces (scrape() carries the rest
// forward untouched, with their real fetched_at timestamps).
const FAST_TIER = ["vast", "runpod", "lium"];

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const fastOnly = new Date(event.scheduledTime).getUTCMinutes() % 15 !== 0;
      const prev = await env.PRICES.get("data", "json").catch(() => null) ?? {};
      const payload = await scrape(prev, fastOnly ? FAST_TIER : null, env);
      if (payload) {
        await env.PRICES.put("data", JSON.stringify(payload));
        const hist = updateHistory(
          await env.PRICES.get("history", "json").catch(() => null) ?? {}, payload);
        await env.PRICES.put("history", JSON.stringify(hist));
        // Evict the edge-cached JSON so readers see this scrape immediately.
        await ctx.cache?.purge({ tags: ["gputable-data"] }).catch(() => {});
        await alertOnRot(env, payload);
      }
    })());
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    const SITE = "https://gputable.dev";
    const text = (body, type = "text/plain") =>
      new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=3600" } });
    if (url.pathname === "/robots.txt")
      return text(`User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
    if (url.pathname === "/sitemap.xml")
      return text(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE}/</loc><changefreq>hourly</changefreq></url></urlset>\n`, "application/xml");
    if (url.pathname === "/llms.txt")
      return text(`# GPUTable
> Live cloud GPU rental prices — per-GPU hourly rates compared across 35+ providers
> (AWS, Azure, Oracle, CoreWeave, Lambda, Nebius, Crusoe, Vast.ai, RunPod, Modal,
> DigitalOcean, Scaleway, OVHcloud and more), re-scraped from first-party sources —
> marketplaces every 5 minutes, everything every 15.

## Data (no auth, CORS enabled)
- [Current prices](${SITE}/data.json): JSON. \`data\` is a list of rows with fields:
  gpu (canonical model, e.g. "H100 SXM"), vram_gb, architecture, provider,
  gpu_count (instance size the price came from), price_per_hour_usd (per single
  GPU), pricing_type (on_demand | spot | reserved), commitment_months,
  available (true/false/null), source_url, and stale:true when a provider's last
  fetch failed and the row was carried forward. \`providers\` maps each source to
  its fetch status; \`generated_at\` is the scrape time (UTC ISO).
- [Price history](${SITE}/history.json): daily index — for each UTC day, the
  cheapest price_per_hour_usd per GPU and pricing type across all providers.

## Notes
- Prices exclude CPU, storage, egress, and region differences.
- Marketplace/community tiers (Vast.ai, Salad, RunPod Community) are peer
  hardware, not comparable to dedicated capacity.
- Rows are deduplicated to the cheapest offer per (provider, gpu, gpu_count,
  pricing_type, commitment_months).
`);
    if (url.pathname === "/data.json" || url.pathname === "/history.json") {
      const body = await env.PRICES?.get(url.pathname === "/data.json" ? "data" : "history");
      // Long TTL is safe: the cron purges the cache tag on every fresh write.
      if (body) return new Response(body, { headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=600, stale-while-revalidate=300",
        "cache-tag": "gputable-data" } });
      return env.ASSETS.fetch(req); // deployed data.json, until the first cron fills KV
    }
    if (url.pathname === "/") { // assets serve the page extensionless
      const page = await env.ASSETS.fetch(new Request(new URL("/gpu-prices", url), req));
      const h = new Headers(page.headers);
      h.set("cache-control", "public, max-age=60"); // short: no purge on deploys
      return new Response(page.body, { status: page.status, headers: h });
    }
    return env.ASSETS.fetch(req);
  },
};

// --------------------------------------------------------------------------
// Local CLI (skipped when bundled for the Worker).
// --------------------------------------------------------------------------

if (globalThis.process?.release?.name === "node" &&
    process.argv[1]?.endsWith("scrape.mjs")) (async () => {
  const fsModule = "node:fs/promises"; // non-literal so wrangler's bundler skips it
  const fs = await import(fsModule);
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const out = flag("-o") ?? "data.json";
  const only = flag("--only")?.split(",");
  const bad = (only ?? []).filter(k => !PROVIDERS[k]);
  if (bad.length) {
    console.error(`unknown provider(s): ${bad.join(", ")} (have: ${Object.keys(PROVIDERS).join(", ")})`);
    process.exit(2);
  }
  // With no explicit credentials, borrow wrangler's local OAuth session for
  // Browser Rendering — it carries the browser scope, so `node scrape.mjs`
  // gets the rendered providers with zero setup. (If the session has expired,
  // any wrangler command refreshes it; the Worker itself needs real secrets.)
  const cliEnv = { ...process.env };
  if (!cliEnv.CF_API_TOKEN && !cliEnv.CLOUDFLARE_API_TOKEN) {
    try {
      const os = await import("node:" + "os");
      const cfg = await fs.readFile(`${os.homedir()}/.wrangler/config/default.toml`, "utf8");
      const tok = cfg.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
      const acct = cliEnv.CF_ACCOUNT_ID ?? cliEnv.CLOUDFLARE_ACCOUNT_ID ??
        (await fs.readFile("wrangler.toml", "utf8").catch(() => ""))
          .match(/account_id\s*=\s*"([^"]+)"/)?.[1];
      if (tok && acct) Object.assign(cliEnv, { CF_API_TOKEN: tok, CF_ACCOUNT_ID: acct });
    } catch { /* no wrangler session; rendered providers will skip */ }
  }
  const prev = await fs.readFile(out, "utf8").then(JSON.parse).catch(() => ({}));
  const payload = await scrape(prev, only, cliEnv);
  if (!payload) {
    console.error("no rows collected; leaving data.json alone");
    process.exit(1);
  }
  if (args.includes("--dry")) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    await fs.writeFile(out, JSON.stringify(payload, null, 1));
    const histFile = out.endsWith("data.json")
      ? out.slice(0, -"data.json".length) + "history.json" : out + ".history.json";
    const hist = updateHistory(
      await fs.readFile(histFile, "utf8").then(JSON.parse).catch(() => ({})), payload);
    await fs.writeFile(histFile, JSON.stringify(hist));
    console.error(`wrote ${out}: ${payload.data.length} rows (+ ${histFile})`);
  }
})().catch(e => { console.error(e); process.exit(1); });
