// api/crewcore/samples.js — SanMar sample drops.
//
// GET    ?resource=drops                     every drop (any CrewCore user)
//        ?resource=drop&id=                  one drop with its catalog summaries
//        ?resource=style&drop_id=&style=     one style's colours and sizes
//        ?resource=picks&drop_id=            own picks + stipend balance;
//                                            admins get everyone's
//        ?resource=export&drop_id=           the CSV for SanMar (admin)
// POST   ?resource=drops                     create a drop (admin)
//        ?resource=import&drop_id=           queue a catalog import (admin)
//        ?resource=import-step&drop_id=      fetch the next few styles (admin)
//        ?resource=picks                     make a pick
// PATCH  ?resource=drops&id=                 rename, re-date, open/close (admin)
//        ?resource=picks&id=                 mark received (admin)
// DELETE ?resource=drops&id=  ?resource=picks&id=
//
// WHO CAN DO WHAT
// Anyone with CrewCore reads the catalog and manages their OWN picks. Admins
// (the account Admin flag or the protected admin role, via isCrewCoreAdmin)
// create drops, import catalogs, pick on somebody's behalf, mark received and
// export. That is the same split the rest of CrewCore uses.
//
// PRICING IS NEVER TAKEN FROM THE REQUEST. A pick names a style, a colour and
// a size; every figure is looked up server side from what SanMar returned.
// The browser cannot put its own number on a vendor sheet or on a stipend.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser } from "../../lib/users.js";
import { isCrewCoreAdmin, stipendBalance, spendsFor } from "../../lib/crewcore/schema.js";
import {
  getEmployeeByUsername, listEmployees,
  listStipendSpends, saveStipendSpend, deleteStipendSpend, getStipendSpend,
} from "../../lib/crewcore/store.js";
import {
  validateDrop, pickingClosed, resolvePick, spendForPick, buildExport, totalsByEmployee,
} from "../../lib/crewcore/samples.js";
import {
  listDrops, getDrop, saveDrop, updateDrop, deleteDrop,
  getStyle, saveStyle,
  listPicks, getPick, savePick, deletePick,
} from "../../lib/crewcore/samples-store.js";
import { parseStyleList, fetchStyle, credentials, missingCredentials } from "../../lib/crewcore/sanmar.js";

// How many styles one import-step fetches. PC61 is the worst case seen: two
// megabytes and about four seconds. Four keeps a step inside Vercel's window
// with room to spare, and progress is saved after every single style, so a
// timeout costs one style rather than the batch.
const CHUNK = 4;
const PAUSE_MS = 250;

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function scope(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const isAdmin = isCrewCoreAdmin({
    superuser: user && user.superuser,
    roleName: user ? user.role : sess.role,
  });
  const employee = await getEmployeeByUsername(sess.username);
  return { isAdmin, employee, employeeId: employee ? employee.id : null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const q = req.query || {};
  const resource = String(q.resource || "drops");
  const me = await scope(sess);

  const adminOnly = () => {
    if (me.isAdmin) return false;
    res.status(403).json({ error: "Admin only" });
    return true;
  };

  try {
    if (req.method === "GET") return await onGet(req, res, q, resource, me);
    if (req.method === "POST") return await onPost(req, res, q, resource, me, adminOnly);
    if (req.method === "PATCH") return await onPatch(req, res, q, resource, me, adminOnly);
    if (req.method === "DELETE") return await onDelete(req, res, q, resource, me, adminOnly);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}

// ---- GET ------------------------------------------------------------------

async function onGet(req, res, q, resource, me) {
  if (resource === "drops") {
    const drops = await listDrops();
    return res.status(200).json({
      drops: drops.map((d) => ({
        id: d.id, name: d.name, due_date: d.due_date, notes: d.notes,
        status: d.status, created_at: d.created_at,
        catalog_count: (d.catalog || []).length,
        import: importProgress(d),
      })),
      is_admin: me.isAdmin,
      // A person with no employee record cannot pick, and saying so plainly
      // beats a button that fails. Alexis hit exactly this on the handbook.
      can_pick: !!me.employeeId,
    });
  }

  if (resource === "drop") {
    const drop = await getDrop(String(q.id || ""));
    if (!drop) return res.status(404).json({ error: "No such drop" });
    return res.status(200).json({
      drop: {
        id: drop.id, name: drop.name, due_date: drop.due_date, notes: drop.notes,
        status: drop.status, created_at: drop.created_at,
      },
      catalog: drop.catalog || [],
      import: importProgress(drop),
      is_admin: me.isAdmin,
    });
  }

  if (resource === "style") {
    const record = await getStyle(String(q.drop_id || ""), String(q.style || ""));
    if (!record) return res.status(404).json({ error: "That style is not in this drop" });
    return res.status(200).json({ style: record });
  }

  if (resource === "picks") {
    const dropId = String(q.drop_id || "");
    const wanted = me.isAdmin ? (q.employee_id ? String(q.employee_id) : null) : me.employeeId;
    if (!me.isAdmin && !me.employeeId) {
      return res.status(200).json({ picks: [], balance: null, no_employee_record: true });
    }
    const picks = await listPicks({ dropId, employeeId: wanted });
    // The screen needs to know which employee record this login is so an
    // admin can tell their own picks from the team's. It never guesses from a
    // name.
    const body = { picks, is_admin: me.isAdmin, me_employee_id: me.employeeId };

    if (me.isAdmin) {
      const employees = await listEmployees();
      const nameFor = mapNames(employees);
      const totals = totalsByEmployee(picks);
      body.people = [...totals.entries()].map(([id, v]) => ({
        employee_id: id, name: nameFor(id), count: v.count, total: v.total,
      })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      body.employees = employees.map((e) => ({ id: e.id, name: displayName(e) }));
    }

    // The balance is what somebody needs while they are choosing, because the
    // stipend is drawn at pick time.
    const forId = wanted || me.employeeId;
    if (forId) {
      const emp = forId === me.employeeId
        ? me.employee
        : (await listEmployees()).find((e) => e && e.id === forId);
      const spends = await listStipendSpends();
      const year = new Date().getFullYear();
      // An employee with no allotment keyed in yet is not "over" whatever
      // they pick: isOverStipend treats a zero allotment as no line to cross.
      body.balance = stipendBalance(
        emp ? emp.apparel_stipend : 0,
        spendsFor(spends, forId, year),
        year,
      );
    }
    return res.status(200).json(body);
  }

  if (resource === "export") {
    if (!me.isAdmin) return res.status(403).json({ error: "Admin only" });
    const dropId = String(q.drop_id || "");
    const drop = await getDrop(dropId);
    if (!drop) return res.status(404).json({ error: "No such drop" });
    const picks = await listPicks({ dropId });
    const nameFor = mapNames(await listEmployees());
    const out = buildExport(picks, nameFor);
    const file = `${slug(drop.name)}-samples.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
    return res.status(200).send(out.csv);
  }

  return res.status(400).json({ error: "Unknown resource" });
}

// ---- POST -----------------------------------------------------------------

async function onPost(req, res, q, resource, me, adminOnly) {
  const body = parseBody(req);

  if (resource === "drops") {
    if (adminOnly()) return;
    const v = validateDrop(body);
    if (!v.ok) return res.status(400).json({ error: v.errors.join("; ") });
    const drop = await saveDrop({ ...v.record, catalog: [], import: null });
    return res.status(200).json({ drop });
  }

  if (resource === "import") {
    if (adminOnly()) return;
    const drop = await getDrop(String(q.drop_id || ""));
    if (!drop) return res.status(404).json({ error: "No such drop" });

    const missing = missingCredentials(credentials());
    if (missing.length) {
      return res.status(200).json({
        error: `SanMar is not configured yet. Missing ${missing.join(", ")} in the environment.`,
      });
    }

    const styles = [
      ...parseStyleList(body.fifty, 50),
      ...parseStyleList(body.twentyfive, 25),
    ];
    // A style pasted into both tiers is a mistake worth naming rather than
    // resolving by whichever list was read second.
    const seen = new Map();
    const conflicts = [];
    styles.forEach((s) => {
      if (seen.has(s.style) && seen.get(s.style) !== s.tier) conflicts.push(s.style);
      seen.set(s.style, s.tier);
    });
    if (conflicts.length) {
      return res.status(400).json({
        error: `These styles are in both lists, so I cannot tell which discount applies: ${conflicts.join(", ")}`,
      });
    }
    if (!seen.size) return res.status(400).json({ error: "No style numbers found in either list." });

    const pending = [...seen.entries()].map(([style, tier]) => ({ style, tier }));
    await updateDrop(drop.id, {
      catalog: [],
      import: {
        pending, total: pending.length, done: 0, errors: [],
        started_at: new Date().toISOString(), finished_at: null,
      },
    });
    return res.status(200).json({ queued: pending.length });
  }

  if (resource === "import-step") {
    if (adminOnly()) return;
    let drop = await getDrop(String(q.drop_id || ""));
    if (!drop) return res.status(404).json({ error: "No such drop" });
    const job = drop.import;
    if (!job || !job.pending || !job.pending.length) {
      return res.status(200).json({ done: true, progress: importProgress(drop) });
    }

    const creds = credentials();
    const catalog = [...(drop.catalog || [])];
    const batch = job.pending.slice(0, CHUNK);

    for (let i = 0; i < batch.length; i += 1) {
      const { style, tier } = batch[i];
      const out = await fetchStyle(style, { tier, creds });
      if (out.ok) {
        await saveStyle(drop.id, out.record);
        catalog.push(out.record.summary);
      } else {
        job.errors.push({ style, error: out.error });
      }
      job.pending = job.pending.filter((p) => p.style !== style);
      job.done += 1;
      // Saved after EVERY style, not after the batch. A step that dies half
      // way costs one style, and the next step picks up where it stopped.
      drop = await updateDrop(drop.id, { catalog, import: job });
      if (i < batch.length - 1) await sleep(PAUSE_MS);
    }

    if (!job.pending.length) {
      job.finished_at = new Date().toISOString();
      drop = await updateDrop(drop.id, { import: job });
    }

    return res.status(200).json({
      done: !job.pending.length,
      progress: importProgress(drop),
    });
  }

  if (resource === "picks") {
    const dropId = String(body.drop_id || "");
    const drop = await getDrop(dropId);
    const closed = pickingClosed(drop);
    if (closed) return res.status(400).json({ error: closed });

    // Picking for somebody else is an admin action. Everyone else picks for
    // themselves whatever the body says.
    let employeeId = me.employeeId;
    if (body.employee_id && String(body.employee_id) !== me.employeeId) {
      if (!me.isAdmin) return res.status(403).json({ error: "You can only pick for yourself." });
      employeeId = String(body.employee_id);
    }
    if (!employeeId) {
      return res.status(400).json({
        error: "Your login is not linked to an employee record yet, so a pick has nowhere to go. Ask Ryan to link it.",
      });
    }

    const styleRecord = await getStyle(dropId, String(body.style || ""));
    const r = resolvePick(body, styleRecord);
    if (!r.ok) return res.status(400).json({ error: r.errors.join("; ") });

    const pick = await savePick({
      ...r.record,
      drop_id: dropId,
      employee_id: employeeId,
      received: false,
      received_at: null,
      created_by: me.employee ? me.employee.id : null,
      spend_id: null,
    });

    // The stipend entry is written straight away, because a pick is when the
    // money is spoken for. If this write fails the pick is rolled back rather
    // than left as a garment nobody paid for.
    try {
      const spendInput = spendForPick(pick, drop);
      const spend = await saveStipendSpend({ ...spendInput, sample_pick_id: pick.id });
      const linked = await savePick({ ...pick, spend_id: spend.id });
      return res.status(200).json({ pick: linked, spend });
    } catch (e) {
      await deletePick(pick.id);
      return res.status(500).json({
        error: "The pick was not saved because its stipend entry could not be written: " +
          String(e && e.message ? e.message : e),
      });
    }
  }

  return res.status(400).json({ error: "Unknown resource" });
}

// ---- PATCH ----------------------------------------------------------------

async function onPatch(req, res, q, resource, me, adminOnly) {
  const body = parseBody(req);

  if (resource === "drops") {
    if (adminOnly()) return;
    const v = validateDrop(body, { partial: true });
    if (!v.ok) return res.status(400).json({ error: v.errors.join("; ") });
    const drop = await updateDrop(String(q.id || ""), v.record);
    if (!drop) return res.status(404).json({ error: "No such drop" });
    return res.status(200).json({ drop });
  }

  if (resource === "picks") {
    if (adminOnly()) return;
    const pick = await getPick(String(q.id || ""));
    if (!pick) return res.status(404).json({ error: "No such pick" });
    const received = body.received === true || body.received === "true";
    const saved = await savePick({
      ...pick,
      received,
      received_at: received ? new Date().toISOString() : null,
    });
    return res.status(200).json({ pick: saved });
  }

  return res.status(400).json({ error: "Unknown resource" });
}

// ---- DELETE ---------------------------------------------------------------

async function onDelete(req, res, q, resource, me, adminOnly) {
  if (resource === "drops") {
    if (adminOnly()) return;
    const ok = await deleteDrop(String(q.id || ""));
    if (!ok) return res.status(404).json({ error: "No such drop" });
    return res.status(200).json({ deleted: true });
  }

  if (resource === "picks") {
    const pick = await getPick(String(q.id || ""));
    if (!pick) return res.status(404).json({ error: "No such pick" });
    // Own picks can be withdrawn while the drop is open; anyone else's is an
    // admin action.
    if (pick.employee_id !== me.employeeId && !me.isAdmin) {
      return res.status(403).json({ error: "That is not your pick." });
    }
    if (!me.isAdmin) {
      const closed = pickingClosed(await getDrop(pick.drop_id));
      if (closed) return res.status(400).json({ error: closed });
    }

    // The stipend entry goes with it. A withdrawn pick that leaves its charge
    // behind quietly eats somebody's allotment for a shirt they never got.
    if (pick.spend_id && await getStipendSpend(pick.spend_id)) {
      await deleteStipendSpend(pick.spend_id);
    }
    await deletePick(pick.id);
    return res.status(200).json({ deleted: true, spend_removed: !!pick.spend_id });
  }

  return res.status(400).json({ error: "Unknown resource" });
}

// ---- helpers --------------------------------------------------------------

function importProgress(drop) {
  const job = drop && drop.import;
  if (!job) return null;
  return {
    total: job.total,
    done: job.done,
    remaining: (job.pending || []).length,
    errors: job.errors || [],
    running: (job.pending || []).length > 0,
    started_at: job.started_at,
    finished_at: job.finished_at,
  };
}

function displayName(e) {
  return String(e && e.name ? e.name : "").trim() || (e ? e.id : "");
}

function mapNames(employees) {
  const byId = new Map(employees.map((e) => [e.id, displayName(e)]));
  return (id) => byId.get(id) || "";
}

function slug(s) {
  return String(s || "drop").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
