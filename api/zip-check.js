// api/zip-check.js — verifies a US ZIP code actually maps to the city/state
// an inquiry claims, for the Inbox's "double check for obvious errors"
// sanity check (Ryan's ask, Aug 2026: a submission listed "Polk City IA
// 50014" — that ZIP is actually Ames, not Polk City).
//
// SESSION-GATED, not public. Unlike api/intake.js and api/intake-upload.js,
// this is only ever called from inside the signed-in BackBone Inbox, never
// from the public form — there's no reason for an anonymous caller to hit a
// ZIP lookup, and gating it avoids handing anyone a free proxy to an
// external API.
//
// POST { zips: ["50014", "50226", ...] } -> { results: { "50014": {...} } }
//
// Backed by zippopotam.us (no API key, no rate-limit key required for this
// volume). Each result:
//   { valid: true,  city: "Ames", state: "IA" }   — real ZIP, here's the place
//   { valid: false }                               — not a real US ZIP
//   { valid: null }                                — lookup failed (network/
//                                                     upstream), status unknown
//
// Results are cached in KV under zipcache:<zip> with no expiry — real ZIP-to
// -city mappings essentially never change, so there's no reason to
// re-fetch once we know. This also means the very first inquiry to mention
// a given ZIP pays the external round trip; every one after is instant.

import { requireAuth } from "../lib/session.js";
import { kvGet, kvSet, isConfigured } from "../lib/backbone-store.js";

const MAX_ZIPS_PER_CALL = 40; // an inquiry realistically mentions a handful; this is a generous ceiling, not a real limit

function cacheKey(zip) { return "zipcache:" + zip; }

async function lookupOne(zip) {
  const cached = await kvGet(cacheKey(zip)).catch(() => null);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through and re-fetch */ }
  }

  let result;
  try {
    const r = await fetch("https://api.zippopotam.us/us/" + encodeURIComponent(zip));
    if (r.status === 404) {
      result = { valid: false };
    } else if (!r.ok) {
      result = { valid: null }; // upstream hiccup — don't cache, try again next time
      return result;
    } else {
      const data = await r.json();
      const place = data && Array.isArray(data.places) && data.places[0];
      if (!place) {
        result = { valid: null };
        return result;
      }
      result = {
        valid: true,
        city: place["place name"] || "",
        state: place["state abbreviation"] || "",
      };
    }
  } catch (e) {
    result = { valid: null }; // network error — don't cache, try again next time
    return result;
  }

  await kvSet(cacheKey(zip), JSON.stringify(result)).catch(() => {}); // cache is best-effort, never block the response on it
  return result;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isConfigured()) {
    return res.status(503).json({ error: "Storage is not configured." });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== "object") body = {};

  const zips = Array.from(new Set(
    (Array.isArray(body.zips) ? body.zips : [])
      .map((z) => String(z || "").trim())
      .filter((z) => /^\d{5}$/.test(z))
  )).slice(0, MAX_ZIPS_PER_CALL);

  if (!zips.length) {
    return res.status(200).json({ results: {} });
  }

  try {
    const entries = await Promise.all(zips.map(async (z) => [z, await lookupOne(z)]));
    const results = {};
    entries.forEach(([z, r]) => { results[z] = r; });
    return res.status(200).json({ results });
  } catch (e) {
    console.error("zip-check error:", e);
    return res.status(500).json({ error: "Lookup failed" });
  }
}
