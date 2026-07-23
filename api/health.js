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
// NOTE: index.html and login.html are deliberately NOT listed. Vercel serves
// them as static pages and does not bundle them with a function, so checking
// for them here always reports them absent even when they are fine. Only files
// that ARE bundled (via includeFiles in vercel.json) can be checked this way.
const REQUIRED = [
  "css/tokens.css", "css/shell.css",
  "js/api.js", "js/app-host.js", "js/registry.js", "js/router.js", "js/shell.js",
  "js/giving-engine.js", "js/giving-dial.js", "js/qrcode-loader.js",
  "apps/hub.js", "apps/traveltrack.js", "apps/givinggauge.js", "apps/shopstock.js",
  "apps/settings.js",
  // BackBone lives in a FOLDER, not one file. All three parts must be present:
  // index.js imports the other two, so a missing sibling takes the whole app
  // down with a message that only says the module failed to load.
  "apps/backbone/index.js", "apps/backbone/styles.js", "apps/backbone/template.js",
  "lib/giving.js",
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

  // Version markers. A file can be PRESENT but stale — an older copy that
  // predates a feature the rest of the code now depends on. That produces
  // errors which look like a missing file and are not, so check for the marker
  // rather than just the path.
  const markers = [
    { file: "js/app-host.js", needle: "meta.entry",
      why: "app-host is an older copy without folder-app support; apps/backbone/ cannot load" },
    { file: "js/registry.js", needle: "backbone/index.js",
      why: "registry is an older copy that still points backbone at a single file" },
    { file: "js/api.js", needle: "LIVE_PREFIXES",
      why: "api.js is an older copy without per-endpoint mocking" }
  ];

  const stale = [];
  for (const m of markers) {
    try {
      const full = path.join(process.cwd(), m.file);
      if (fs.existsSync(full) && !fs.readFileSync(full, "utf8").includes(m.needle)) {
        stale.push({ file: m.file, why: m.why });
      }
    } catch (e) { /* absent files are already reported above */ }
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
    files: { checked: REQUIRED.length, absent, stale },
    next: ready
      ? "Configuration looks complete. Open /login.html to create the first account."
      : "Add the missing variables in Vercel > Settings > Environment Variables, then redeploy.",
  });
}
