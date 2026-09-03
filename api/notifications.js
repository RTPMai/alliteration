// api/notifications.js — shell-level notifications / to-do list.
//
// Every signed-in user can create a notification and assign it to anyone
// else (or themselves) — this is a team hand-off tool, not something gated
// by role, unlike the apps in APPS. The assignee, the creator, or an
// admin/superuser can change status, reassign, or edit one, so people can't
// rewrite something they have no part in. The creator can always fix a
// notification they made a mistake on (they're a "party" to it by
// definition), and that fix is logged, not silent.
//
// Deleting is a step further: it's still restricted to the same
// assignee/creator/admin set, but each role also carries a
// can_delete_notifications flag (Settings > Roles, opt-out, default true)
// that an admin can turn off for a role entirely. Admins/superusers always
// bypass that flag — see callerCanDelete() below.
//
// Every notification carries an append-only `history` array: created,
// reassigned, completed ("who clicked it off"), reopened, edited (with the
// actual before/after values, not just which fields changed), or a plain
// comment. This exists because Ryan described how Printavo's Tasks get used
// in practice — a question gets asked by reassigning the task, the answer
// comes back the same way — and wanted that back-and-forth visible on the
// notification itself, not just the current assignee. A PATCH's optional
// `message` field is never stored on its own; it is folded into whichever
// history entry the patch produces.
//
// GET    -> list all notifications, newest first. Query filters (all
//           optional, ANDed): ?assignedTo=, ?createdBy=, ?appId= (matches if
//           the notification's appIds array contains it), ?type= (same,
//           against types), ?status=. ?people=1 instead returns
//           { username, name } pairs for the assignee picker — open to any
//           signed-in user, unlike GET /api/users which is admin-only.
// POST   -> create, assigned to someone (defaults to the caller if
//           assignedTo is omitted).
// PATCH  -> edit, reassign, mark done/reopen, or comment (?id= or body.id).
//           Common cases: { status: "done" }, { assignedTo: "hannah",
//           message: "can you confirm the ship date?" }.
// DELETE -> ?id=.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import { getUser, getRole, listUsers } from "../lib/users.js";
import { validateNew, validatePatch, GENERAL_APP } from "../lib/notifications/schema.js";
import {
  listNotifications, saveNotification, nextNotificationId,
  getNotification, updateNotification, deleteNotification,
  listNotificationSummaries, countSummaries, canCountFromIndex,
} from "../lib/notifications/store.js";
import { KEYS, readKey, readRoster, isConfigured as backboneConfigured } from "../lib/backbone-store.js";
import { listEmployees } from "../lib/crewcore/store.js";

// Who reports to the caller, for the "My team" tab (Ryan's ask, Aug 25 2026).
//
// The org chart lives in CrewCore (employee.reports_to holds a manager's
// employee id) rather than being re-entered here, so there is one answer to
// "who works for whom" and it is edited in the HR app where that belongs.
//
// This exposes no new data. A team-visibility notification is already
// readable by every signed-in user; the tab is a lens over what the person
// can already see, so the only thing resolved here is WHOSE items to gather,
// not whether they may be read. Private items are filtered out by hidden()
// in the handler regardless, and nothing from the employee record beyond a
// username and a display name ever leaves this function — no rate, no notes.
//
// Three outcomes:
//   reports -> the caller has direct reports recorded; that is the team.
//   all     -> no reports recorded, but the caller's role already sees all
//              data (admin/superuser). The whole shop is their team, which
//              is what a small business means by it anyway.
//   none    -> neither. The tab does not appear.
async function resolveTeam(sess, me, isAdmin) {
  let employees = [];
  try {
    employees = await listEmployees();
  } catch (e) {
    // CrewCore not reachable is not a reason to break Notifications. Fall
    // back to the role answer rather than 500ing a screen that works.
    employees = [];
  }

  const mine = employees.find((e) => String(e.username || "").toLowerCase() === me) || null;
  const reports = mine
    ? employees.filter((e) =>
        e.reports_to && String(e.reports_to) === String(mine.id) &&
        e.username && e.status !== "terminated")
    : [];

  if (reports.length) {
    return {
      scope: "reports",
      team: reports.map((e) => ({
        username: String(e.username).toLowerCase(),
        name: e.name || e.username,
      })),
    };
  }

  if (isAdmin) {
    const users = await listUsers();
    return {
      scope: "all",
      team: users
        .filter((u) => String(u.username).toLowerCase() !== me)
        .map((u) => ({ username: String(u.username).toLowerCase(), name: u.name })),
    };
  }

  return { scope: "none", team: [] };
}

// Backs the "link to a record" picker on manual notifications (Ryan's ask,
// Aug 2026): search BackBone's own data by company name and hand back just
// enough to label a chip {id, label, sublabel} — never the full record, this
// is a picker not a data export. Read-only, capped at 20 results.
//
// "client" gets the same "own" scoping api/data.js applies to the roster: an
// AM scoped to their own accounts must not be able to search up (or link to)
// accounts outside that scope just because the picker is a different screen.
// Leads and inquiries have no such scoping anywhere else in the app (every
// signed-in user already sees the full pipeline and the full inbox), so the
// search here matches that existing behavior rather than inventing a new
// restriction.
async function searchLinkable(type, q, sess) {
  if (!backboneConfigured()) return [];
  const needle = String(q || "").trim().toLowerCase();

  if (type === "lead") {
    const data = await readKey(KEYS.leads);
    const leads = data && Array.isArray(data.leads) ? data.leads : [];
    return leads
      .filter((l) => !needle || String(l.company_name || "").toLowerCase().includes(needle))
      .sort((a, b) => String(a.company_name || "").localeCompare(String(b.company_name || "")))
      .slice(0, 20)
      .map((l) => ({ id: l.lead_id, label: l.company_name || l.lead_id, sublabel: l.status || "" }));
  }

  if (type === "inquiry") {
    const data = await readKey(KEYS.intake);
    const subs = data && Array.isArray(data.submissions) ? data.submissions : [];
    return subs
      .filter((s) => {
        const name = (s.company && s.company.name) || "";
        return !needle || name.toLowerCase().includes(needle);
      })
      .sort((a, b) => {
        const an = (a.company && a.company.name) || "";
        const bn = (b.company && b.company.name) || "";
        return an.localeCompare(bn);
      })
      .slice(0, 20)
      .map((s) => ({ id: s.id, label: (s.company && s.company.name) || "New inquiry", sublabel: s.status || "" }));
  }

  if (type === "client") {
    const data = await readRoster();
    let synced = data && Array.isArray(data.synced) ? data.synced : [];

    const user = sess.username ? await getUser(sess.username) : null;
    const role = await getRole(user ? user.role : sess.role);
    const scope = (role && role.data_scope) || "all";
    if (scope === "own") {
      const amName = (user && (user.am_name || user.name)) || "";
      const mine = String(amName).trim().toLowerCase();
      const enrichment = (data && data.enrichment) || {};
      synced = mine
        ? synced.filter((c) => {
            const enr = enrichment[c.customer_id] || {};
            return String(enr.account_manager || "").trim().toLowerCase() === mine;
          })
        : [];
    }

    return synced
      .filter((c) => !needle || String(c.company_name || "").toLowerCase().includes(needle))
      .sort((a, b) => String(a.company_name || "").localeCompare(String(b.company_name || "")))
      .slice(0, 20)
      .map((c) => ({ id: c.customer_id, label: c.company_name || c.customer_id, sublabel: "" }));
  }

  return [];
}

// The app-id allowlist lives server-side rather than importing js/registry.js
// (browser code), so it is kept in sync by hand. Covers the nine apps plus
// "general" for anything not tied to one app. See test/notifications.test.cjs,
// which asserts this list against js/registry.js's real app ids.
const APP_IDS = [
  "backbone", "shopstock", "errorengine", "givinggauge", "traveltrack",
  "crewcore", "mailme", "teletally", "websitewidget",
  // Added when each app landed. This list is hand-synced, so an app missing
  // from it cannot be tagged on a hand-off even though it exists in the rail:
  // promopro and stitchsense were both in that state.
  "promopro", "stitchsense", "marketmachine",
  GENERAL_APP,
];

async function callerIsAdmin(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const role = await getRole(user ? user.role : sess.role);
  return (role && role.data_scope === "all") || (user && user.superuser === true);
}

// Opt-out flag (default true): a role can turn OFF the ability for its
// people to delete a notification they created or were assigned, without
// touching the "who can act on this at all" isParty check above. Admins
// always bypass this (see callerIsAdmin above) so there is no way to lock
// an admin out of cleanup by mis-configuring a role.
async function callerCanDelete(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const role = await getRole(user ? user.role : sess.role);
  return !role || role.can_delete_notifications !== false;
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function nameFor(username, cache) {
  if (!username) return "";
  if (cache.has(username)) return cache.get(username);
  const u = await getUser(username);
  const name = u ? u.name : username;
  cache.set(username, name);
  return name;
}

// One log entry per meaningful change. history is append-only and returned
// as part of the record, so the front end can render "what changed, when,
// by whom" without a separate endpoint. Modeled loosely on BackBone's leads
// status-history trail (same idea: never delete, just keep appending).
function historyEntry(action, by, byName, extra) {
  return { at: new Date().toISOString(), by, byName, action, ...extra };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const me = String(sess.username || "").toLowerCase();

  // A private notification is invisible to everyone except its creator,
  // admins included. Admin is a permission over shared team work, not a
  // licence to read someone's personal scratch list, so this check sits
  // ahead of every admin override below rather than beside it.
  const hidden = (n) => n && n.visibility === "private" && n.createdBy !== me;

  try {
    if (req.method === "GET") {
      // Assignee picker data. Any signed-in user needs this (not just admins,
      // who are the only ones with GET /api/users) so everyone can pick who
      // a notification goes to. Username + display name only — no role, no
      // superuser flag, nothing api/users.js already gates behind admin.
      if (req.query && req.query.people === "1") {
        const users = await listUsers();
        return res.status(200).json({
          people: users.map((u) => ({ username: u.username, name: u.name })),
        });
      }

      // Team membership for the "My team" tab. Same access level as the
      // people picker above: any signed-in user may ask, and the answer for
      // most of them is an empty team, which is how the tab knows to hide
      // itself rather than the front end guessing from a role name.
      if (req.query && req.query.team === "1") {
        const { scope, team } = await resolveTeam(sess, me, await callerIsAdmin(sess));
        return res.status(200).json({ scope, team });
      }

      // Link picker data for the create/edit form. ?linkSearch=lead|inquiry|client
      // with an optional ?q= filter. Open to any signed-in user, same as the
      // people picker above — the "own" scope check for clients happens
      // inside searchLinkable(), not here.
      if (req.query && req.query.linkSearch) {
        const type = String(req.query.linkSearch);
        if (!["lead", "inquiry", "client"].includes(type)) {
          return res.status(400).json({ error: "linkSearch must be lead, inquiry, or client" });
        }
        const results = await searchLinkable(type, req.query.q, sess);
        return res.status(200).json({ results });
      }

      const id = req.query && req.query.id;
      if (id) {
        const rec = await getNotification(id);
        if (!rec || hidden(rec)) return res.status(404).json({ error: "Notification not found" });
        return res.status(200).json({ notification: rec });
      }

      const q = req.query || {};

      // COUNT-ONLY MODE. This is what the header bell asks for, once a
      // minute per open tab, and it used to come through the full list
      // path below: one Upstash command per notification in the system,
      // every poll, growing forever. The index now carries assignedTo,
      // createdBy, status and visibility, so the same question is one
      // command regardless of how many notifications exist.
      //
      // It falls back to the full path for a filter the index cannot
      // answer (an app tag, a type tag). Returning a wrong number quickly
      // would be worse than returning the right one slowly, and this is
      // deliberately a fallback rather than a 400 so a future caller
      // cannot break by asking a fair question.
      if (q.count === "1" || q.count === "true") {
        const filters = {
          assignedTo: q.assignedTo, createdBy: q.createdBy,
          status: q.status, visibility: q.visibility,
        };
        const extra = { appId: q.appId, type: q.type };
        if (canCountFromIndex({ ...filters, ...extra })) {
          const summaries = await listNotificationSummaries();
          return res.status(200).json({ count: countSummaries(summaries, filters, me) });
        }
      }

      let list = (await listNotifications()).filter((n) => !hidden(n));
      if (q.assignedTo) list = list.filter((n) => n.assignedTo === String(q.assignedTo).toLowerCase());
      if (q.createdBy) list = list.filter((n) => n.createdBy === String(q.createdBy).toLowerCase());
      if (q.appId) list = list.filter((n) => Array.isArray(n.appIds) && n.appIds.includes(q.appId));
      if (q.type) list = list.filter((n) => Array.isArray(n.types) && n.types.includes(q.type));
      if (q.status) list = list.filter((n) => n.status === q.status);
      if (q.visibility) list = list.filter((n) => (n.visibility || "team") === q.visibility);

      return res.status(200).json({ notifications: list });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const users = await listUsers();
      const usernames = users.map((u) => u.username.toLowerCase());

      if (!body.assignedTo) body.assignedTo = me;

      const { ok, errors, record } = validateNew(body, APP_IDS, usernames);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      // Enforced server-side, not just hidden in the form: a private item
      // nobody else can read must not sit in another person's inbox.
      if (record.visibility === "private") record.assignedTo = me;

      const nameCache = new Map();
      const myName = sess.name || me;
      const full = {
        ...record,
        id: await nextNotificationId(),
        status: "open",
        createdBy: me,
        createdByName: myName,
        assignedToName: await nameFor(record.assignedTo, nameCache),
        createdAt: new Date().toISOString(),
        doneAt: null,
        doneBy: null,
        doneByName: null,
        history: [historyEntry("created", me, myName, {
          to: record.assignedTo, toName: await nameFor(record.assignedTo, nameCache),
        })],
      };

      await saveNotification(full);
      return res.status(201).json({ ok: true, notification: full });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing notification id" });

      const existing = await getNotification(id);
      if (!existing || hidden(existing)) return res.status(404).json({ error: "Notification not found" });

      const isParty = existing.assignedTo === me || existing.createdBy === me;
      if (!isParty && !(await callerIsAdmin(sess))) {
        return res.status(403).json({ error: "Only the assignee, the creator, or an admin can change this" });
      }

      const users = await listUsers();
      const usernames = users.map((u) => u.username.toLowerCase());
      const { ok, errors, patch } = validatePatch(body, APP_IDS, usernames);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      // message is ephemeral — folded into a history entry below, never
      // stored as its own field on the record.
      const message = patch.message;
      delete patch.message;

      // Turning an item private pulls it back to its creator. Handing a
      // private item to someone else would make it invisible to both of you.
      const willBePrivate = (patch.visibility || existing.visibility) === "private";
      if (willBePrivate) patch.assignedTo = existing.createdBy;

      if (!Object.keys(patch).length && !message) {
        return res.status(400).json({ error: "No editable fields in patch" });
      }

      const myName = sess.name || me;
      const nameCache = new Map();
      const entries = [];

      // Reassignment. Logged with both names so the trail reads clearly even
      // after someone's account is later renamed or removed. This is the
      // Printavo-Tasks pattern Ryan described: ask a question by reassigning
      // with a message, the answer comes back the same way, and both hops
      // stay visible here rather than only the current assignee showing.
      if (patch.assignedTo && patch.assignedTo !== existing.assignedTo) {
        patch.assignedToName = await nameFor(patch.assignedTo, nameCache);
        entries.push(historyEntry("reassigned", me, myName, {
          from: existing.assignedTo, fromName: existing.assignedToName,
          to: patch.assignedTo, toName: patch.assignedToName,
          message: message || undefined,
        }));
      }

      // Status. "Who clicked the notification off" — completedBy is a top
      // level field for quick display, AND a history entry, so the trail
      // doesn't require walking history just to answer "who closed this."
      if (patch.status === "done" && existing.status !== "done") {
        patch.doneAt = new Date().toISOString();
        patch.doneBy = me;
        patch.doneByName = myName;
        entries.push(historyEntry("completed", me, myName, { message: message || undefined }));
      }
      if (patch.status === "open" && existing.status === "done") {
        patch.doneAt = null;
        patch.doneBy = null;
        patch.doneByName = null;
        entries.push(historyEntry("reopened", me, myName, { message: message || undefined }));
      }

      // Any other edit (title, types, appIds, dueDate) that ISN'T covered by
      // the two cases above still gets one summary entry, so nothing changes
      // silently — this is what lets a creator who made a mistake fix it and
      // have the fix itself be visible, not just the current state. Skipped
      // when a reassignment/status entry already exists this call, since
      // that entry's own message covers the "why." Each entry keeps the
      // actual before/after values (not just field names) so the trail
      // answers "what did it used to say," not only "something changed."
      const editedFields = ["title", "types", "appIds", "dueDate", "link"].filter((f) => patch[f] !== undefined);
      if (editedFields.length && !entries.length) {
        const changes = editedFields.map((f) => ({ field: f, from: existing[f], to: patch[f] }));
        entries.push(historyEntry("edited", me, myName, { fields: editedFields, changes, message: message || undefined }));
      }

      if (!entries.length && message) {
        // A message with no other field change — a plain comment on the
        // notification, same "ask a question" pattern without reassigning.
        entries.push(historyEntry("comment", me, myName, { message }));
      }

      if (entries.length) patch.history = [...(existing.history || []), ...entries];

      const record = await updateNotification(id, patch);
      return res.status(200).json({ ok: true, notification: record });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing notification id" });

      const existing = await getNotification(id);
      if (!existing || hidden(existing)) return res.status(404).json({ error: "Notification not found" });

      const isParty = existing.assignedTo === me || existing.createdBy === me;
      const admin = await callerIsAdmin(sess);
      if (!admin) {
        if (!isParty) {
          return res.status(403).json({ error: "Only the assignee, the creator, or an admin can delete this" });
        }
        if (!(await callerCanDelete(sess))) {
          return res.status(403).json({ error: "Your role does not allow deleting notifications. Ask an admin." });
        }
      }

      const removed = await deleteNotification(id);
      return res.status(200).json({ ok: true, deleted: removed ? id : null });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("notifications route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
