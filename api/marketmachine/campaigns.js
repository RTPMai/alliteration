// PUT IN: api/marketmachine/campaigns.js
//
// api/marketmachine/campaigns.js — campaigns, their checklists, their events.
//
// GET                 -> Admin: every campaign with where it stands.
//                        Anyone else signed in: names and ids only (MailMe's
//                        "part of a campaign" picker).
// GET    ?id=         -> one campaign: checklist, dates, parent, connected
//                        campaigns, emails attached in MailMe
// POST                -> create (with parentId for a connected campaign)
// PATCH  ?id=         -> header edit: name, Account Manager, audience, date,
//                        participation, budget, notes, status
// PATCH  ?id=&step=   -> one step: done, date completed, not applicable,
//                        due date, blocker, notes, links
// DELETE ?id=         -> delete a campaign
// DELETE ?legacy=all  -> delete the old pre-rebuild sample campaigns
//
// ADMIN ONLY FOR NOW (Ryan, Sept 2026). Checked here on every request, not
// just hidden in the rail, and checked as `superuser === true` on the account
// record. Nothing on an access record can open it, so ticking MarketMachine on
// somebody's account does not hand them the campaigns.
//
// The single exception is the bare list read, reduced to names and ids,
// because MailMe asks for it whenever an email is composed. Refusing it would
// make MailMe say "MarketMachine is not answering" to everybody who sends
// email, which is untrue and would train people to ignore the message.
//
// All the rules (what can be marked done, when a campaign can close, what a
// connected campaign inherits) live in lib/marketmachine/campaign.js, so this
// file only decides who is asking.

import { requireAuth } from "../../lib/session.js";
import { getUser } from "../../lib/users.js";
import { progress, headerDates, childSummary, isMine, pickerShape } from "../../lib/marketmachine/campaign.js";
import {
  listCampaigns, getCampaign, createCampaign, updateHeader, updateStep, deleteCampaign,
  childrenOf, legacyCount, clearLegacy, linkedEmails, accountManagers,
} from "../../lib/marketmachine/store.js";
import { todayCentral } from "../../lib/marketmachine/dates.js";

const ADMIN_ONLY = "MarketMachine is admin only for now.";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function accountFor(sess) {
  const user = sess && sess.username ? await getUser(sess.username) : null;
  return {
    user,
    admin: !!(user && user.superuser === true),
    session: { username: sess.username, name: (user && user.name) || sess.name || sess.username },
  };
}

function refuse(res, out) {
  const status = out.notFound ? 404 : 400;
  return res.status(status).json({ error: (out.errors || []).join(" ") || "Request refused" });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const q = req.query || {};
  const id = q.id ? String(q.id) : null;

  try {
    const { user, admin, session } = await accountFor(sess);
    const today = todayCentral();

    if (req.method === "GET" && !id && !admin) {
      const all = await listCampaigns();
      return res.status(200).json({ campaigns: pickerShape(all), limited: true, message: ADMIN_ONLY });
    }

    if (!admin) return res.status(403).json({ error: ADMIN_ONLY });

    if (req.method === "GET") {
      const all = await listCampaigns();
      const people = await accountManagers(user ? { username: user.username, name: user.name } : null);
      const myId = people.me ? people.me.id : null;

      if (id) {
        const campaign = all.find((c) => c.id === id) || await getCampaign(id);
        if (!campaign) return res.status(404).json({ error: "Campaign not found" });
        const parent = campaign.parentId ? all.find((c) => c.id === campaign.parentId) || null : null;
        return res.status(200).json({
          campaign,
          progress: progress(campaign, today),
          dates: headerDates(campaign),
          parent: parent ? childSummary(parent, today) : null,
          children: childrenOf(id, all).map((c) => childSummary(c, today)),
          emails: await linkedEmails(id),
          accountManagers: people.options,
          today,
        });
      }

      const campaigns = all.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        parentId: c.parentId || null,
        status: c.status,
        accountManagerId: c.accountManagerId || null,
        accountManagerName: c.accountManagerName || null,
        audienceKind: c.audienceKind,
        audience: c.audience,
        controlDate: c.controlDate || null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        mine: isMine(c, sess.username, myId),
        childCount: childrenOf(c.id, all).length,
        progress: progress(c, today),
        dates: headerDates(c),
      }));
      return res.status(200).json({
        campaigns,
        accountManagers: people.options,
        accountManagersUnavailable: people.unavailable,
        me: people.me,
        legacyCount: await legacyCount(),
        canEdit: true,
        canDelete: true,
        today,
      });
    }

    if (req.method === "POST") {
      const out = await createCampaign(parseBody(req), session);
      if (!out.ok) return refuse(res, out);
      return res.status(201).json({ ok: true, campaign: out.campaign });
    }

    if (req.method === "PATCH") {
      if (!id) return res.status(400).json({ error: "Missing campaign id" });
      const body = parseBody(req);
      const out = q.step
        ? await updateStep(id, String(q.step), body, session, today)
        : await updateHeader(id, body, session);
      if (!out.ok) return refuse(res, out);
      return res.status(200).json({ ok: true, campaign: out.campaign, progress: progress(out.campaign, today) });
    }

    if (req.method === "DELETE") {
      if (q.legacy === "all") {
        const removed = await clearLegacy();
        return res.status(200).json({ ok: true, removed });
      }
      if (!id) return res.status(400).json({ error: "Missing campaign id" });
      const out = await deleteCampaign(id);
      if (!out.ok) return refuse(res, out);
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("marketmachine campaigns route error:", e);
    return res.status(500).json({ error: e.message || "Campaign request failed" });
  }
}
