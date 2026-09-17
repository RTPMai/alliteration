// PUT IN: lib/reviews/store.js
// lib/reviews/store.js: RaveReviews storage, under the reviews_data: prefix.
//
// WHY REDIS HASHES AND SETS HERE, when most stores in this repo keep a JSON
// array under one key. Three things write to this app at the same moment for
// real: the cron marking orders seen and sending, a person pressing Send now,
// and a person marking a customer as reviewed. A read-modify-write of one big
// JSON blob loses whichever write finished second. HSET / SADD / SREM change
// one entry and leave the rest alone, so nothing has to be careful.
//
// createStore(kv) takes the storage client as an argument so the tests run the
// real store against an in-memory one. The default export talks to Upstash.
//
// lib/ never imports from api/.
//
// ESM. Do NOT convert to module.exports.

import { keys, DEFAULT_SETTINGS } from "./schema.js";

/* ------------------------------------------------------------------ *
 * UPSTASH
 * ------------------------------------------------------------------ */

function upstashConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  return { url: url.replace(/\/+$/, ""), token };
}

async function command(args) {
  const { url, token } = upstashConfig();
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`Storage command ${args[0]} failed (${r.status})`);
  const j = await r.json();
  if (j && j.error) throw new Error(`Storage command ${args[0]} failed: ${j.error}`);
  return j ? j.result : null;
}

function pairsToObject(flat) {
  const out = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  } else if (flat && typeof flat === "object") {
    Object.assign(out, flat);
  }
  return out;
}

export const upstashKv = {
  get: (k) => command(["GET", k]),
  set: (k, v) => command(["SET", k, v]),
  setNx: async (k, v, ttlSec) => (await command(["SET", k, v, "NX", "EX", String(ttlSec)])) === "OK",
  del: (k) => command(["DEL", k]),
  mget: async (ks) => (ks.length ? command(["MGET", ...ks]) : []),
  hset: (k, f, v) => command(["HSET", k, f, v]),
  hdel: (k, f) => command(["HDEL", k, f]),
  hgetall: async (k) => pairsToObject(await command(["HGETALL", k])),
  sadd: (k, m) => command(["SADD", k, m]),
  srem: (k, m) => command(["SREM", k, m]),
  smembers: async (k) => (await command(["SMEMBERS", k])) || [],
  zadd: (k, score, m) => command(["ZADD", k, String(score), m]),
  zrevrange: async (k, start, stop) => (await command(["ZREVRANGE", k, String(start), String(stop)])) || [],
};

/* ------------------------------------------------------------------ *
 * THE STORE
 * ------------------------------------------------------------------ */

function parse(raw) {
  let v = raw;
  for (let i = 0; i < 3 && typeof v === "string"; i++) {
    try { v = JSON.parse(v); } catch (e) { return null; }
  }
  return v && typeof v === "object" ? v : null;
}

export function createStore(kv) {
  const readJsonHash = async (key) => {
    const flat = await kv.hgetall(key);
    const out = {};
    Object.keys(flat || {}).forEach((f) => {
      const v = flat[f];
      const parsed = typeof v === "string" && /^[\[{"]/.test(v) ? parse(v) : null;
      out[f] = parsed != null ? parsed : v;
    });
    return out;
  };

  return {
    async getSettings() {
      const s = parse(await kv.get(keys.settings()));
      return Object.assign({}, DEFAULT_SETTINGS, s || {});
    },
    async saveSettings(settings) {
      await kv.set(keys.settings(), JSON.stringify(settings));
      return settings;
    },

    async getState() {
      return parse(await kv.get(keys.state())) || {};
    },
    /** State is only written by the cron and the Run now button, one at a time. */
    async patchState(patch) {
      const next = Object.assign({}, await this.getState(), patch || {});
      await kv.set(keys.state(), JSON.stringify(next));
      return next;
    },

    async getSeen() { return kv.hgetall(keys.seen()); },
    async markSeen(invoiceId, iso) { await kv.hset(keys.seen(), String(invoiceId), iso); },
    async forgetSeen(invoiceId) { await kv.hdel(keys.seen(), String(invoiceId)); },

    async getReviewed() { return readJsonHash(keys.reviewed()); },
    async setReviewed(email, entry) {
      await kv.hset(keys.reviewed(), email, JSON.stringify(entry || {}));
    },
    async removeReviewed(email) { await kv.hdel(keys.reviewed(), email); },

    async getLastSent() { return kv.hgetall(keys.lastSent()); },
    async setLastSent(email, iso) { await kv.hset(keys.lastSent(), email, iso); },

    async getRecord(id) { return parse(await kv.get(keys.record(id))); },
    async getRecords(ids) {
      if (!ids || !ids.length) return [];
      const raws = await kv.mget(ids.map((id) => keys.record(id)));
      return (raws || []).map(parse).filter(Boolean);
    },
    async saveRecord(rec) {
      await kv.set(keys.record(rec.id), JSON.stringify(rec));
      return rec;
    },
    /** A new record: stored, indexed for the list, and queued. */
    async insertRecord(rec) {
      await this.saveRecord(rec);
      await kv.zadd(keys.index(), new Date(rec.detected_at).getTime(), rec.id);
      if (rec.status === "queued") await kv.sadd(keys.queue(), rec.id);
      return rec;
    },
    async recentIds(limit) { return kv.zrevrange(keys.index(), 0, Math.max(0, (limit || 500) - 1)); },

    async queueIds() { return kv.smembers(keys.queue()); },
    async enqueue(id) { await kv.sadd(keys.queue(), id); },
    async dequeue(id) { await kv.srem(keys.queue(), id); },

    /**
     * One sender at a time per record. The cron and a Send now press landing
     * in the same second would otherwise both see "queued" and both send.
     */
    async lock(id, ttlSec) { return kv.setNx(keys.lock(id), "1", ttlSec || 120); },
    async unlock(id) { await kv.del(keys.lock(id)); },
  };
}

let _default = null;
export function defaultStore() {
  if (!_default) _default = createStore(upstashKv);
  return _default;
}
