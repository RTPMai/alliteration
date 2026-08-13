// lib/websitewidget/sites-store.js — the list of sites WebsiteWidget tracks.
//
// A site is { id, label, domain, propertyId, createdAt }. Property ids are
// not secret (they identify a GA4 property, not a credential), so unlike
// the service account's client_email/private_key, they live in KV and are
// editable from the app's Settings view without touching Vercel or waiting
// on a redeploy. Same reasoning as every other app's Settings screen in
// this repo: configurable values belong in Settings, not env vars.
//
// LEGACY MIGRATION: the first version of WebsiteWidget only supported one
// site, configured via a GA4_PROPERTY_ID env var. If that env var is still
// set and no sites have been saved to KV yet, seed the list with it once so
// an existing PMApparel.com setup is not silently lost when this ships.
// After that first seed, KV is the source of truth and the env var is
// ignored even if it is still set.

const KEY = "websitewidget_data:sites";

function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Storage is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN " +
      "in your Vercel environment."
    );
  }
  return { url: url.replace(/\/+$/, ""), token };
}

async function readRaw() {
  const { url, token } = config();
  const res = await fetch(`${url}/get/${encodeURIComponent(KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`Storage read failed (${res.status}) for ${KEY}`);
  const body = await res.json();
  if (body.result == null) return null;
  try {
    return typeof body.result === "string" ? JSON.parse(body.result) : body.result;
  } catch (e) {
    return null; // corrupt value treated as absent, same convention as lib/kv.js
  }
}

async function writeRaw(sites) {
  const { url, token } = config();
  const res = await fetch(`${url}/set/${encodeURIComponent(KEY)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(sites)
  });
  if (!res.ok) throw new Error(`Storage write failed (${res.status}) for ${KEY}`);
  return sites;
}

function slugify(label) {
  const base = String(label || "site")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "site";
  return base;
}

function uniqueId(label, existing) {
  const base = slugify(label);
  if (!existing.some((s) => s.id === base)) return base;
  let n = 2;
  while (existing.some((s) => s.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Every configured site. Runs the one-time legacy-env-var seed if KV is
 * empty and GA4_PROPERTY_ID is still set from before sites existed.
 */
export async function getSites() {
  let sites = await readRaw();
  if (sites === null) {
    const legacyPropertyId = process.env.GA4_PROPERTY_ID;
    if (legacyPropertyId) {
      sites = [{
        id: "pmapparel",
        label: "PMApparel.com",
        domain: "pmapparel.com",
        propertyId: legacyPropertyId,
        createdAt: new Date().toISOString()
      }];
      await writeRaw(sites);
    } else {
      sites = [];
    }
  }
  return sites;
}

export async function getSite(id) {
  const sites = await getSites();
  return sites.find((s) => s.id === id) || null;
}

export async function addSite({ label, domain, propertyId }) {
  if (!label || !String(label).trim()) throw new Error("Site label is required");
  if (!propertyId || !String(propertyId).trim()) throw new Error("GA4 property id is required");
  const sites = await getSites();
  const site = {
    id: uniqueId(label, sites),
    label: String(label).trim(),
    domain: domain ? String(domain).trim() : "",
    propertyId: String(propertyId).trim(),
    createdAt: new Date().toISOString()
  };
  const next = [...sites, site];
  await writeRaw(next);
  return site;
}

export async function updateSite(id, patch) {
  const sites = await getSites();
  const idx = sites.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`No site with id ${id}`);
  const updated = { ...sites[idx] };
  if (patch.label !== undefined && String(patch.label).trim()) updated.label = String(patch.label).trim();
  if (patch.domain !== undefined) updated.domain = String(patch.domain).trim();
  if (patch.propertyId !== undefined && String(patch.propertyId).trim()) updated.propertyId = String(patch.propertyId).trim();
  sites[idx] = updated;
  await writeRaw(sites);
  return updated;
}

export async function deleteSite(id) {
  const sites = await getSites();
  const next = sites.filter((s) => s.id !== id);
  await writeRaw(next);
  return next;
}
