// PUT IN: lib/backbone/referral-store.js
// lib/backbone/referral-store.js: storage for BackBone referrals.
//
// One key, backbone_referrals, holding { referrals: [...], seq }. A shop's
// referrals number in the dozens a year, so one list is plenty, and one list
// is what the ranking needs to read anyway. The server issues ids, never the
// browser, so two people logging at once cannot hand out the same number.
//
// Reads never throw: a storage blip shows an empty list with an error on the
// route, not a crashed screen. Writes do throw, so a failed save can never be
// reported as a success.
//
// ESM. Do NOT convert to module.exports.

import { getRaw, setRaw } from "../kv.js";

export const REFERRALS_KEY = "backbone_referrals";

function shape(raw) {
  const list = raw && Array.isArray(raw.referrals) ? raw.referrals : (Array.isArray(raw) ? raw : []);
  const seq = raw && Number.isInteger(raw.seq) ? raw.seq : 0;
  return { referrals: list.filter((r) => r && r.id), seq };
}

export async function readReferrals() {
  return shape(await getRaw(REFERRALS_KEY));
}

export async function writeReferrals(doc) {
  const out = { referrals: doc.referrals, seq: doc.seq, savedAt: new Date().toISOString() };
  await setRaw(REFERRALS_KEY, out);
  return out;
}

/** Next id, REF-0001 style, from the stored counter and the ids already used. */
export function nextReferralId(doc) {
  let n = doc.seq || 0;
  (doc.referrals || []).forEach((r) => {
    const m = /^REF-(\d+)$/.exec(String(r.id));
    if (m) n = Math.max(n, Number(m[1]));
  });
  n += 1;
  return { id: "REF-" + String(n).padStart(4, "0"), seq: n };
}
