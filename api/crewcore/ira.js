// PUT IN: api/crewcore/ira.js
// api/crewcore/ira.js: SIMPLE IRA sign-up (Sep 30 2026, Ryan's call:
// "Election + packet status").
//
// WHO SEES WHAT
//   An employee:       their own IRA choice, the plan info and the packet
//                      link. Nobody else's anything. An employee_id in the
//                      query that is not their own is refused, not ignored,
//                      so a guessed id gets a clear no.
//   A CrewCore admin:  anybody's choice and history, and the sign-up sheet
//                      (every current employee, with counts).
//
// WHO DOES WHAT
//   An employee:       enroll or decline for themselves, and change it.
//   A CrewCore admin:  set or change anybody's choice, and mark a packet
//                      returned or not returned. Marking the packet is admin
//                      only; nobody can mark their own through here or
//                      through the generic employee update (validateEmployee
//                      never copies `ira`).
//
// NOTHING SENSITIVE IS STORED: no Social Security number, date of birth,
// bank or beneficiary details. Those stay on the paper packet. See
// lib/crewcore/ira.js.
//
// A new or changed choice raises a notification for the PTO approvers (Ryan
// and Megan, the same list time off uses). The amount never goes in it:
// notifications are visible to everyone signed in.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser } from "../../lib/users.js";
import { isCrewCoreAdmin } from "../../lib/crewcore/schema.js";
import { listEmployees, getEmployee, getEmployeeByUsername, updateEmployee, getSettings } from "../../lib/crewcore/store.js";
import { getPolicyDoc } from "../../lib/crewcore/pto-store.js";
import { notifyTimeoff } from "../../lib/crewcore/pto-request.js";
import {
  validateIraElection, applyElection, markPacket, electionChanged, iraSummary, iraPlanInfo,
  iraNoticeText, DEFAULT_IRA_PACKET_URL, DEFAULT_IRA_MATCH_PERCENT,
} from "../../lib/crewcore/ira.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function plan() {
  let s = {};
  try { s = await getSettings(); } catch (e) { s = {}; }
  const match = s.ira_match_percent != null ? Number(s.ira_match_percent) : DEFAULT_IRA_MATCH_PERCENT;
  return {
    packet_url: s.ira_packet_url || DEFAULT_IRA_PACKET_URL,
    match_percent: match,
    info: iraPlanInfo(match),
  };
}

/** What one person's IRA answer carries. Name and id only off the record. */
function personOut(emp) {
  return { employee_id: emp.id, name: emp.name, ira: emp.ira || null };
}

/**
 * Tell the approvers. Fails soft: the choice is already saved. The person
 * who made the change is not told about their own change.
 */
async function announce(emp, ira, { by, changed }) {
  let doc;
  try { doc = await getPolicyDoc(); } catch (e) { return []; }
  const { title, detail } = iraNoticeText(emp.name, ira, { changed });
  const ids = [];
  for (const a of doc.approvers || []) {
    if (a === by) continue;
    const acct = await getEmployeeByUsername(a).catch(() => null);
    const id = await notifyTimeoff({ to: a, toName: acct ? acct.name : a, title, detail, request: null, fromName: "CrewCore IRA" });
    if (id) ids.push(id);
  }
  return ids;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const user = sess.username ? await getUser(sess.username) : null;
    const isAdmin = isCrewCoreAdmin({ superuser: user && user.superuser, roleName: user ? user.role : sess.role });
    const own = await getEmployeeByUsername(sess.username);
    const by = String(sess.username || "").toLowerCase();
    const q = req.query || {};

    if (req.method === "GET") {
      // The sign-up sheet: admin only.
      if (q.sheet === "1") {
        if (!isAdmin) return res.status(403).json({ error: "Admin access required" });
        const summary = iraSummary(await listEmployees());
        return res.status(200).json({ ...summary, plan: await plan() });
      }

      const wanted = q.employee_id ? String(q.employee_id) : null;
      if (wanted && !(own && own.id === wanted)) {
        if (!isAdmin) return res.status(403).json({ error: "You can only see your own IRA choice" });
        const emp = await getEmployee(wanted);
        if (!emp) return res.status(404).json({ error: "Employee not found" });
        return res.status(200).json({ linked: true, ...personOut(emp), plan: await plan(), is_admin: true });
      }

      if (!own) return res.status(200).json({ linked: false, ira: null, plan: await plan(), is_admin: isAdmin });
      return res.status(200).json({ linked: true, ...personOut(own), plan: await plan(), is_admin: isAdmin });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const action = String(body.action || "elect");
      const targetId = body.employee_id ? String(body.employee_id) : (own ? own.id : null);
      const self = !!(own && targetId === own.id);

      if (action === "packet") {
        if (!isAdmin) return res.status(403).json({ error: "Only an admin can mark a packet returned" });
        if (!targetId) return res.status(400).json({ error: "Missing employee_id" });
        const emp = await getEmployee(targetId);
        if (!emp) return res.status(404).json({ error: "Employee not found" });
        const ira = markPacket(emp, body.returned === true, { by });
        await updateEmployee(emp.id, { ira });
        return res.status(200).json({ ok: true, employee_id: emp.id, name: emp.name, ira });
      }

      if (action !== "elect") return res.status(400).json({ error: "Unknown action" });

      if (!targetId) {
        return res.status(404).json({ error: "Your login isn't linked to an employee record yet. Ask an admin to add it in CrewCore's Roster." });
      }
      if (!self && !isAdmin) return res.status(403).json({ error: "You can only make your own IRA choice" });

      const emp = self ? own : await getEmployee(targetId);
      if (!emp) return res.status(404).json({ error: "Employee not found" });

      const v = validateIraElection(body);
      if (!v.ok) return res.status(400).json({ error: v.errors.join(" "), details: v.errors });

      const before = emp.ira || null;
      if (before && !electionChanged(before, v.value)) {
        return res.status(200).json({ ok: true, unchanged: true, employee_id: emp.id, name: emp.name, ira: before });
      }
      const ira = applyElection(emp, v.value, { by });
      await updateEmployee(emp.id, { ira });
      const notice_ids = await announce(emp, ira, { by, changed: !!(before && before.status) });
      return res.status(200).json({ ok: true, employee_id: emp.id, name: emp.name, ira, notified: notice_ids.length });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("crewcore/ira route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
