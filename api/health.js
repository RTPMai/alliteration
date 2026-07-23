// api/health.js — "why is it broken?" in plain language.
//
// A crashing function returns Vercel's generic 500, which tells you nothing.
// This route is deliberately dependency-free: it imports nothing that could
// itself throw, so it answers even when everything else is failing.
//
// Open /api/health in a browser to see what is and isn't configured.
//
// SAFE TO EXPOSE: reports only whether each variable is SET, never its value.

import fs from "fs";
import path from "path";

// Files the front end needs. A missing one produces a vague "failed to load"
// in the browser, so list them here and report exactly which are absent.
const REQUIRED = [
  "index.html", "login.html",
  "css/tokens.css", "css/shell.css",
  "js/api.js", "js/app-host.js", "js/registry.js", "js/router.js", "js/shell.js",
  "js/giving-engine.js", "js/giving-dial.js", "js/qrcode-loader.js",
  "apps/hub.js", "apps/traveltrack.js", "apps/givinggauge.js", "apps/shopstock.js",
  "vendor/scoring-engine.js", "vendor/gauge.js"
];

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const env = process.env;

  const sessionSecret = !!env.SESSION_SECRET;
  const kvUrl   = !!(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL);
  const kvToken = !!(env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN);

  const missing = [];
  if (!sessionSecret) missing.push("SESSION_SECRET");
  if (!kvUrl)   missing.push("KV_REST_API_URL (or UPSTASH_REDIS_REST_URL)");
  if (!kvToken) missing.push("KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_TOKEN)");

  // Vercel bundles only what a function references, so this sees the repo as
  // deployed. A file listed as missing here is genuinely absent.
  const files = {};
  const absent = [];
  for (const rel of REQUIRED) {
    let there = false;
    try { there = fs.existsSync(path.join(process.cwd(), rel)); } catch (e) { there = false; }
    files[rel] = there;
    if (!there) absent.push(rel);
  }

  const ready = missing.length === 0;

  res.status(200).json({
    ready,
    node: process.version,
    configured: {
      SESSION_SECRET: sessionSecret,
      KV_REST_API_URL: kvUrl,
      KV_REST_API_TOKEN: kvToken,
    },
    missing,
    files: { checked: REQUIRED.length, absent },
    next: ready
      ? "Configuration looks complete. Open /login.html to create the first account."
      : "Add the missing variables in Vercel > Settings > Environment Variables, then redeploy.",
  });
}
