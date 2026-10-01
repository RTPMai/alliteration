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
// PATCH  ?id=&connect=1 -> connect or disconnect a TravelTrack trip, a
//                        BackBone lead, or a Printavo invoice number
// PATCH  ?id=&calc=1  -> set or clear one typed calculation input
// PATCH  ?id=&scorecard=1 -> set or clear one results scorecard row
// GET    ?mine=tasks  -> ANY signed-in person: the open steps that are theirs,
//                        one line each with a short why. Nothing else.
// GET    ?options=connections -> the trips and leads to pick from
// GET    ?id=&printavo=1      -> current Printavo status of this campaign's
//                        invoices (on demand; Printavo is slow)
// POST   ?id=&art=1   -> attach art to one platform: { platform, dataUrl,
//                        name } uploads a file (3 MB max), { platform, link,
//                        name } records a link. Remove with PATCH removeArt.
// DELETE ?id=         -> delete a campaign
// DELETE ?legacy=all  -> delete the old pre-rebuild sample campaigns
// POST   ?demo=load   -> load the example campaigns, for showing the app
// DELETE ?demo=all    -> remove them again, and only them
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
import { getUser, permsFor } from "../../lib/users.js";
import { isMember, withoutMoney, connectionsWithoutMoney, memberWrite } from "../../lib/marketmachine/member.js";
import { progress, headerDates, childSummary, isMine, pickerShape, amsOf, artRefusal } from "../../lib/marketmachine/campaign.js";
import {
  listCampaigns, getCampaign, createCampaign, updateHeader, updateStep, deleteCampaign,
  childrenOf, legacyCount, clearLegacy, accountManagers,
  linkConnection, connectionOptions, connectionDetail, invoiceStatuses, setCalcInput, setScorecardRow,
  loadDemo, removeDemo, demoCount, addCampaignArt,
} from "../../lib/marketmachine/store.js";
import { parseArtUpload, artPath, artPutOptions, checkArtLink } from "../../lib/marketmachine/art.js";
import { computeCalculations, advisories, scorecardRows } from "../../lib/marketmachine/calculations.js";
import { isParentType } from "../../lib/marketmachine/catalog.js";
import { linksOf, scopeOf } from "../../lib/marketmachine/connections.js";
import { myTasks, canTickStep } from "../../lib/marketmachine/tasks.js";
import { isMarketMachineAdmin } from "../../lib/marketmachine/access.js";
import { todayCentral } from "../../lib/marketmachine/dates.js";

const ADMIN_ONLY = "MarketMachine is admin only for now.";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function accountFor(sess) {
  const user = sess && sess.username ? await getUser(sess.username) : null;
  const perms = sess && sess.username ? await permsFor(sess.username) : null;
  return {
    user,
    // Account Managers: read every campaign, change their own, no money.
    // See lib/marketmachine/member.js. Admins are members too; `admin` wins.
    member: isMember(perms),
    // The platform Admin flag, or the Campaigns grant on this account. See
    // lib/marketmachine/access.js: it is the one definition, and the rail
    // reads it too.
    admin: isMarketMachineAdmin(user),
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
    const { user, admin, member, session } = await accountFor(sess);
    const today = todayCentral();

    // My tasks: open to anyone signed in, because the point of it is that the
    // people doing the work never have to open the full campaign screen. It
    // carries their own steps and nothing else: no other person's work, no
    // budget, no connections, no history.
    if (q.mine === "tasks") {
      const people = await accountManagers(user ? { username: user.username, name: user.name } : null);
      const person = {
        username: sess.username,
        name: (user && user.name) || sess.username,
        employeeId: people.me ? people.me.id : null,
        admin,
      };
      const open = (await listCampaigns()).filter((c) => c.status === "open");
      // `full` tells the screen whether to offer "Open the campaign". The
      // campaign read below still checks for itself; this only saves a
      // person a button that would answer "admin only".
      return res.status(200).json({ tasks: myTasks(open, person, today), today, me: person.name, full: admin || member });
    }

    if (req.method === "GET" && !id && !admin && !member) {
      const all = await listCampaigns();
      return res.status(200).json({ campaigns: pickerShape(all), limited: true, message: ADMIN_ONLY });
    }

    // The one write anybody may make: ticking a step that is theirs, from My
    // tasks. Checked against the campaign record, never against what the
    // screen claims, and only for done, the date it was done, and notes.
    if (!admin && req.method === "PATCH" && q.step && q.mine) {
      const campaign = id ? await getCampaign(id) : null;
      if (!campaign) return res.status(404).json({ error: "Campaign not found" });
      const step = (campaign.steps || []).find((s) => s.key === String(q.step));
      if (!step) return res.status(404).json({ error: "That step is not on this campaign" });
      const people = await accountManagers(user ? { username: user.username, name: user.name } : null);
      const person = { username: sess.username, name: (user && user.name) || sess.username, employeeId: people.me ? people.me.id : null, admin: false };
      if (!canTickStep(campaign, step, person)) {
        return res.status(403).json({ error: "That step belongs to somebody else." });
      }
      const body = parseBody(req);
      const out = await updateStep(id, String(q.step), {
        done: body.done, doneAt: body.doneAt, notes: body.notes,
      }, session, today);
      if (!out.ok) return refuse(res, out);
      return res.status(200).json({ ok: true });
    }

    if (!admin && !member) return res.status(403).json({ error: ADMIN_ONLY });

    // A member's write: allowed on their own campaigns, never on money,
    // approvals or deletes. The body that goes on is the cleaned one.
    let body = null;
    if (!admin && req.method !== "GET") {
      const people = await accountManagers(user ? { username: user.username, name: user.name } : null);
      const campaign = id ? await getCampaign(id) : null;
      const verdict = memberWrite({
        method: req.method, q, body: parseBody(req), campaign,
        mine: campaign ? isMine(campaign, sess.username, people.me ? people.me.id : null) : false,
        me: people.me,
      });
      if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });
      body = verdict.body;
    }
    const bodyOf = () => body || parseBody(req);

    if (req.method === "GET") {
      const all = await listCampaigns();
      const people = await accountManagers(user ? { username: user.username, name: user.name } : null);
      const myId = people.me ? people.me.id : null;

      if (q.options === "connections") {
        return res.status(200).json(await connectionOptions());
      }

      if (id) {
        const campaign = all.find((c) => c.id === id) || await getCampaign(id);
        if (!campaign) return res.status(404).json({ error: "Campaign not found" });
        if (q.printavo) {
          const numbers = scopeOf(campaign, all).flatMap((c) => linksOf(c).invoices.map((e) => e.ref));
          return res.status(200).json({ statuses: await invoiceStatuses(numbers) });
        }
        const parent = campaign.parentId ? all.find((c) => c.id === campaign.parentId) || null : null;
        const connections = await connectionDetail(campaign, all);
        if (!admin) {
          // A member reads everything but the money, and is told whether
          // this one is theirs to change so the page can say so up front.
          return res.status(200).json({
            campaign: withoutMoney(campaign),
            progress: progress(campaign, today),
            dates: headerDates(campaign),
            parent: parent ? childSummary(parent, today) : null,
            children: childrenOf(id, all).map((c) => childSummary(c, today)),
            connections: connectionsWithoutMoney(connections),
            calculations: [],
            advisories: advisories(campaign),
            scorecard: [],
            accountManagers: people.options,
            access: { admin: false, canEdit: isMine(campaign, sess.username, myId) },
            today,
          });
        }
        return res.status(200).json({
          access: { admin: true, canEdit: true },
          campaign,
          progress: progress(campaign, today),
          dates: headerDates(campaign),
          parent: parent ? childSummary(parent, today) : null,
          children: childrenOf(id, all).map((c) => childSummary(c, today)),
          connections,
          calculations: computeCalculations(campaign, connections, { strategic: isParentType(campaign.type) }),
          advisories: advisories(campaign),
          scorecard: scorecardRows(campaign),
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
        accountManagers: amsOf(c),
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
        legacyCount: admin ? await legacyCount() : 0,
        demoCount: admin ? await demoCount() : 0,
        canEdit: true,
        canDelete: admin,
        admin,
        today,
      });
    }

    if (req.method === "POST" && q.art) {
      if (!id) return res.status(400).json({ error: "Missing campaign id" });
      const body = bodyOf();
      const platform = String(body.platform || "");
      const target = await getCampaign(id);
      if (!target) return res.status(404).json({ error: "Campaign not found" });
      const refusal = artRefusal(target, platform);
      if (refusal) return res.status(400).json({ error: refusal });
      let file;
      if (body.link) {
        const chk = checkArtLink(body.link);
        if (!chk.ok) return res.status(400).json({ error: chk.error });
        file = { url: chk.url, name: body.name || chk.url, link: true };
      } else {
        const parsed = parseArtUpload(body.dataUrl);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        const { put } = await import("@vercel/blob");
        const { randomBytes } = await import("crypto");
        const pathname = artPath(id, platform, body.name, parsed.mediaType, randomBytes(12).toString("hex"));
        const blob = await put(pathname, Buffer.from(parsed.base64, "base64"),
          artPutOptions(parsed.mediaType, process.env.BLOB_READ_WRITE_TOKEN));
        file = { url: blob.url, name: body.name || "Art file", bytes: parsed.bytes };
      }
      const out = await addCampaignArt(id, platform, file, session);
      if (!out.ok) return refuse(res, out);
      return res.status(200).json({ ok: true, campaign: out.campaign, progress: progress(out.campaign, today) });
    }

    if (req.method === "POST") {
      if (q.demo === "load") {
        const out = await loadDemo(session, today);
        return res.status(201).json({ ok: true, ...out });
      }
      const out = await createCampaign(bodyOf(), session);
      if (!out.ok) return refuse(res, out);
      return res.status(201).json({ ok: true, campaign: out.campaign });
    }

    if (req.method === "PATCH") {
      if (!id) return res.status(400).json({ error: "Missing campaign id" });
      const body = bodyOf();
      const out = q.scorecard
        ? await setScorecardRow(id, body, session)
        : q.calc
        ? await setCalcInput(id, body, session)
        : q.connect
        ? await linkConnection(id, body, session)
        : q.step
          ? await updateStep(id, String(q.step), body, session, today)
          : await updateHeader(id, body, session);
      if (!out.ok) return refuse(res, out);
      return res.status(200).json({ ok: true, campaign: out.campaign, progress: progress(out.campaign, today), printavo: out.printavo || null });
    }

    if (req.method === "DELETE") {
      if (q.demo === "all") {
        return res.status(200).json({ ok: true, ...(await removeDemo()) });
      }
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
