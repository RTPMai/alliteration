// api/marketmachine/samples.js — load or clear the five sample campaigns.
//
//   GET  ?action=status  -> how many samples are in there right now
//   GET  ?action=load    -> create them
//   GET  ?action=clear   -> delete every sample campaign and its rows
//   POST { action }      -> same three, for anything calling it properly
//
// GET IS ALLOWED TO WRITE HERE, WHICH IS NOT NORMAL. It is deliberate and
// narrow: the point of this route is that one person can paste a URL into a
// browser tab while signed in and see the app fill up. Building a Settings
// button instead would mean editing apps/marketmachine.js, which is a large
// shared file, for a job that gets done once. The cost of the shortcut is
// that a GET changes data, so it is fenced three ways: superuser only, the
// action has to be named explicitly (a bare GET reports and changes nothing),
// and load refuses to run twice.
//
// SUPERUSER ONLY, checked here rather than hidden behind a link. Sample data
// lands in the same totals as real spend, so the ability to create it belongs
// with the people who own the platform, not with anyone who can edit a
// campaign.
//
// LOAD IS NOT IDEMPOTENT, SO IT REFUSES TO REPEAT. Campaign ids are
// max-plus-one, so a second load would not overwrite the first, it would
// produce ten campaigns with five names. Refusing beats a duplicate set that
// somebody then has to unpick by hand.
//
// A folder route, like the rest of api/marketmachine/.

import { requireAuth } from "../../lib/session.js";
import { getUser } from "../../lib/users.js";
import { setRaw } from "../../lib/kv.js";
import {
  getAllCampaigns, createCampaign, updateCampaign, deleteCampaign, createEntry, mmKeys,
} from "../../lib/marketmachine/store.js";
import {
  isSample, sampleCampaignPatches, sampleEntriesFor, SAMPLE_CAMPAIGNS,
} from "../../lib/marketmachine/samples.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function isBuilder(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  return !!(user && user.superuser === true);
}

async function currentSamples() {
  const all = await getAllCampaigns();
  return Object.values(all).filter(isSample);
}

async function load(sess) {
  const existing = await currentSamples();
  if (existing.length) {
    return {
      status: 409,
      body: {
        error: `There are already ${existing.length} sample campaigns in here. ` +
               `Clear them first if you want a fresh set.`,
        existing: existing.map((c) => ({ id: c.id, name: c.name })),
      },
    };
  }

  const created = [];
  let rows = 0;
  for (const { key, patch } of sampleCampaignPatches()) {
    const campaign = await createCampaign(patch, sess);
    // Stamped after create because newCampaign() keeps only declared fields.
    // This is what the clear action matches on; the SAMPLE: name prefix is
    // the part a human reads.
    await updateCampaign(campaign.id, { sample: true });
    for (const row of sampleEntriesFor(key, campaign.id)) {
      const saved = await createEntry(row, sess);
      if (saved) rows += 1;
    }
    created.push({ id: campaign.id, name: campaign.name });
  }

  return {
    status: 201,
    body: {
      ok: true,
      created: created.length,
      rows,
      campaigns: created,
      next: "Open MarketMachine. Campaigns lists all five; Data Entry holds the rows.",
    },
  };
}

async function clear() {
  const existing = await currentSamples();
  for (const c of existing) {
    // Rows live under their own per-campaign key, which deleteCampaign does
    // not touch. Emptying it first means a later campaign that happens to
    // reuse the id cannot inherit somebody else's numbers.
    try { await setRaw(mmKeys.entries(c.id), []); } catch (e) { /* nothing to clear */ }
    await deleteCampaign(c.id);
  }
  return {
    status: 200,
    body: { ok: true, removed: existing.length,
            campaigns: existing.map((c) => ({ id: c.id, name: c.name })) },
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  if (!(await isBuilder(sess))) {
    return res.status(403).json({ error: "Sample data is superuser only." });
  }

  const action = String(
    (req.query && req.query.action) || parseBody(req).action || "status"
  ).toLowerCase();

  try {
    if (action === "status") {
      const existing = await currentSamples();
      return res.status(200).json({
        loaded: existing.length,
        available: SAMPLE_CAMPAIGNS.length,
        campaigns: existing.map((c) => ({ id: c.id, name: c.name })),
        actions: { load: "?action=load", clear: "?action=clear" },
      });
    }
    if (action === "load") {
      const out = await load(sess);
      return res.status(out.status).json(out.body);
    }
    if (action === "clear") {
      const out = await clear();
      return res.status(out.status).json(out.body);
    }
    return res.status(400).json({ error: "action must be status, load or clear" });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}
