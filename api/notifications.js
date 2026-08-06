// PUT IN: api/notifications.js (new)
// (this banner line is for verification only, delete it after checking the path)

// api/notifications.js — shell-level notifications / to-do list.
//
// Every signed-in user can create a notification and assign it to anyone
// else (or themselves) — this is a team hand-off tool, not something gated
// by role, unlike the apps in APPS. Only the assignee, the creator, or an
// admin/superuser can change status, edit, or delete one, so people can't
// close out or rewrite something they have no part in.
//
// GET    -> list all notifications, newest first. Query filters (all
//           optional, ANDed): ?assignedTo=, ?createdBy=, ?appId= (matches if
//           the notification's appIds array contains it), ?type= (same,
//           against types), ?status=. ?people=1 instead returns
//           { username, name } pairs for the assignee picker — open to any
//           signed-in user, unlike GET /api/users which is admin-only.
// POST   -> create, assigned to someone (defaults to the caller if
//           assignedTo is omitted).
// PATCH  -> edit one (?id= or body.id). Common case: { status: "done" }.
// DELETE -> ?id=.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import { getUser, getRole, listUsers } from "../lib/users.js";
import { validateNew, validatePatch, GENERAL_APP } from "../lib/notifications/schema.js";
import {
  listNotifications, saveNotification, nextNotificationId,
  getNotification, updateNotification, deleteNotification,
} from "../lib/notifications/store.js";

// The app-id allowlist lives server-side rather than importing js/registry.js
// (browser code), so it is kept in sync by hand. Covers the nine apps plus
// "general" for anything not tied to one app. See test/notifications.test.cjs,
// which asserts this list against js/registry.js's real app ids.
const APP_IDS = [
  "backbone", "shopstock", "errorengine", "givinggauge", "traveltrack",
  "crewcore", "mailme", "teletally", "websitewidget", GENERAL_APP,
];

async function callerIsAdmin(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const role = await getRole(user ? user.role : sess.role);
  return (role && role.data_scope === "all") || (user && user.superuser === true);
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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const me = String(sess.username || "").toLowerCase();

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

      const id = req.query && req.query.id;
      if (id) {
        const rec = await getNotification(id);
        if (!rec) return res.status(404).json({ error: "Notification not found" });
        return res.status(200).json({ notification: rec });
      }

      let list = await listNotifications();
      const q = req.query || {};
      if (q.assignedTo) list = list.filter((n) => n.assignedTo === String(q.assignedTo).toLowerCase());
      if (q.createdBy) list = list.filter((n) => n.createdBy === String(q.createdBy).toLowerCase());
      if (q.appId) list = list.filter((n) => Array.isArray(n.appIds) && n.appIds.includes(q.appId));
      if (q.type) list = list.filter((n) => Array.isArray(n.types) && n.types.includes(q.type));
      if (q.status) list = list.filter((n) => n.status === q.status);

      return res.status(200).json({ notifications: list });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const users = await listUsers();
      const usernames = users.map((u) => u.username.toLowerCase());

      if (!body.assignedTo) body.assignedTo = me;

      const { ok, errors, record } = validateNew(body, APP_IDS, usernames);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      const nameCache = new Map();
      const full = {
        ...record,
        id: await nextNotificationId(),
        status: "open",
        createdBy: me,
        createdByName: sess.name || me,
        assignedToName: await nameFor(record.assignedTo, nameCache),
        createdAt: new Date().toISOString(),
        doneAt: null,
      };

      await saveNotification(full);
      return res.status(201).json({ ok: true, notification: full });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing notification id" });

      const existing = await getNotification(id);
      if (!existing) return res.status(404).json({ error: "Notification not found" });

      const isParty = existing.assignedTo === me || existing.createdBy === me;
      if (!isParty && !(await callerIsAdmin(sess))) {
        return res.status(403).json({ error: "Only the assignee, the creator, or an admin can change this" });
      }

      const users = await listUsers();
      const usernames = users.map((u) => u.username.toLowerCase());
      const { ok, errors, patch } = validatePatch(body, APP_IDS, usernames);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
      if (!Object.keys(patch).length) return res.status(400).json({ error: "No editable fields in patch" });

      if (patch.status === "done" && existing.status !== "done") patch.doneAt = new Date().toISOString();
      if (patch.status === "open") patch.doneAt = null;

      if (patch.assignedTo) {
        const nameCache = new Map();
        patch.assignedToName = await nameFor(patch.assignedTo, nameCache);
      }

      const record = await updateNotification(id, patch);
      return res.status(200).json({ ok: true, notification: record });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing notification id" });

      const existing = await getNotification(id);
      if (!existing) return res.status(404).json({ error: "Notification not found" });

      const isParty = existing.assignedTo === me || existing.createdBy === me;
      if (!isParty && !(await callerIsAdmin(sess))) {
        return res.status(403).json({ error: "Only the assignee, the creator, or an admin can delete this" });
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
