#!/usr/bin/env node
// Fixture-based regression tests for every provider parser.
//
//     node test.mjs --record   # hit the live endpoints, save responses as fixtures
//     node test.mjs            # replay fixtures offline; fail on parser regressions
//
// Record mode needs the real secrets in the environment (GCP_API_KEY,
// PRIME_API_KEY, CF_ACCOUNT_ID + CF_API_TOKEN); replay mode needs nothing and
// never touches the network — a missing fixture is an error, not a fallthrough.
// Fixtures live in test/fixtures/ (gzipped; key/api_key params are redacted
// from the hash so replay with dummy creds finds them). The manifest records
// each provider's row count at record time; replay fails if a provider drops
// below half of that, goes to zero, or produces prices outside sane bounds.

import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrape, PROVIDERS } from "./scrape.mjs";

const RECORD = process.argv.includes("--record");
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "test", "fixtures");
const MANIFEST = path.join(DIR, "manifest.json");
fs.mkdirSync(DIR, { recursive: true });

// Fixture identity: URL + request body, with credential-bearing query params
// redacted so the hash is stable across real and dummy keys.
const sanitize = u => String(u)
  .replace(/([?&](key|api_key|api_token|apiKey)=)[^&]+/g, "$1R")
  .replace(/accounts\/[0-9a-f]{32}/, "accounts/R"); // CF Browser Rendering path
const keyOf = (url, body) =>
  createHash("sha1").update(sanitize(url) + "\n" + (body ?? "")).digest("hex").slice(0, 20);

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const body = typeof opts?.body === "string" ? opts.body : "";
  const file = path.join(DIR, keyOf(url, body) + ".gz");
  if (RECORD) {
    const res = await realFetch(url, opts);
    const text = await res.text();
    fs.writeFileSync(file, gzipSync(JSON.stringify({ status: res.status, body: text })));
    return new Response(text, { status: res.status });
  }
  if (!fs.existsSync(file)) throw new Error(`no fixture for ${sanitize(url)}`);
  const { status, body: b } = JSON.parse(gunzipSync(fs.readFileSync(file)).toString());
  return new Response(b, { status });
};

const env = RECORD ? process.env : {
  GCP_API_KEY: "R", PRIME_API_KEY: "R", CF_ACCOUNT_ID: "R", CF_API_TOKEN: "R",
};

const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : {};
let failures = 0;
const picked = process.argv.slice(2).filter(a => PROVIDERS[a]);
for (const key of picked.length ? picked : Object.keys(PROVIDERS)) {
  let verdict;
  try {
    const payload = await scrape({}, [key], env);
    const st = payload?.providers?.[key];
    const rows = (payload?.data ?? []).filter(r => !r.stale);
    const bad = rows.filter(r => !(r.price_per_hour_usd > 0 && r.price_per_hour_usd < 200));
    if (!st?.ok) verdict = `FAIL (${st?.error ?? "no status"})`;
    else if (bad.length) verdict = `FAIL (${bad.length} rows with insane prices)`;
    else if (RECORD) { manifest[key] = rows.length; verdict = `recorded ${rows.length} rows`; }
    else if (rows.length < Math.max(1, Math.floor((manifest[key] ?? 1) / 2)))
      verdict = `FAIL (${rows.length} rows, expected ~${manifest[key]})`;
    else verdict = `ok (${rows.length} rows)`;
  } catch (e) {
    verdict = `FAIL (${e.message ?? e})`;
  }
  if (verdict.startsWith("FAIL")) failures++;
  console.log(`${key.padEnd(15)} ${verdict}`);
}
if (RECORD) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + "\n");
console.log(RECORD ? `fixtures written to ${DIR}` : failures ? `${failures} FAILURES` : "all parsers pass");
process.exit(failures ? 1 : 0);
