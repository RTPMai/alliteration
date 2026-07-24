// api/leads-data.js — read the leads list.
//
// Returns { leads: [...] }. An empty array here must only ever mean the list is
// genuinely empty: the front end treats any failure as "keep what is on screen"
// rather than emptying it, after a bug where a failed request silently produced
// zero leads and twenty real ones vanished with no error.

import { requireAuth } from "../lib/session.js";
import { KEYS, readKey, isConfigured } from "../lib/backbone-store.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  if (!isConfigured()) {
    return res.status(503).json({ error: "Storage is not configured." });
  }

  try {
    const data = await readKey(KEYS.leads);
    if (!data || !Array.isArray(data.leads)) {
      return res.status(200).json({ leads: [] });
    }
    return res.status(200).json(data);
  } catch (e) {
    console.error("leads-data error:", e);
    return res.status(500).json({ error: e.message });
  }
}
