// lib/kv.js — storage for the shell.
//
// One thin wrapper over Upstash Redis so nothing else in lib/ or api/ has to
// know how storage works. Swap the backend here and everything above keeps
// working.
//
// All shell data lives under the "alliteration:" prefix, keeping it clearly
// separate from the per-app data the five apps already store.
//
// ESM. Do NOT convert to module.exports — mixing module systems is what caused
// "setSessionCookie is not a function" in BackBone.

const PREFIX = "alliteration:";

function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Storage is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN " +
      "(or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) in your Vercel environment."
    );
  }
  return { url: url.replace(/\/+$/, ""), token };
}

export const keys = {
  users: () => PREFIX + "users",
  roles: () => PREFIX + "roles",
};

/**
 * Read a JSON value. Returns null when the key is absent.
 *
 * Upstash returns the stored string; we parse it here so callers always get
 * real objects. A value that fails to parse is treated as absent rather than
 * thrown, so one corrupt key cannot take down login.
 */
export async function getRaw(key) {
  const { url, token } = config();

  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (!res.ok) throw new Error(`Storage read failed (${res.status}) for ${key}`);

  const body = await res.json();
  if (body.result == null) return null;

  try {
    return typeof body.result === "string" ? JSON.parse(body.result) : body.result;
  } catch (e) {
    console.error(`[kv] ${key} is not valid JSON; treating as empty`);
    return null;
  }
}

/** Write a JSON value. */
export async function setRaw(key, value) {
  const { url, token } = config();

  const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });

  if (!res.ok) throw new Error(`Storage write failed (${res.status}) for ${key}`);
  return value;
}

/** True when storage is configured. Lets callers show a clear setup message. */
export function isConfigured() {
  try { config(); return true; } catch (e) { return false; }
}
