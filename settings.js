// api/promopro/settings.js — shop-wide PromoPro settings.
//
// Holds three things:
//   chaseAfterDays      how many days of vendor silence before a PO goes amber
//   alwaysCc            addresses copied on every purchase order email
//   accountManagerIds   WHICH CrewCore employees can own a purchase order
//
// Only ids are stored. Names and addresses come from the CrewCore roster on
// every read, so they cannot drift: change an address in CrewCore and PromoPro
// follows. A second hand-typed list of the same people would go stale silently,
// and a stale address means a PO owner who is never actually copied.
//
// The candidate roster (everyone who COULD be picked) is returned to admins
// only, since that is the Settings screen. Everyone else gets just the chosen
// account managers, which the new-PO form needs to render its picker. Only id,
// name and email ever leave here: CrewCore's admin gating is about pay and
// review notes, none of which this route touches.
//
// GET is open to anyone who can open the app: the new-PO form needs the
// account manager list to render its (required) picker, so gating the read
// would make the app unusable for the people who use it most.
//
// Writes are admin/superuser only. These settings decide who gets copied on
// outgoing mail to an outside party, which is not a personal preference.

import { requireAuth } from "../../lib/session.js";
import { isAdminSession } from "../../lib/promopro/access.js";
import { validateSettings, withSettingDefaults } from "../../lib/promopro/schema.js";
import { getSettings, saveSettings } from "../../lib/promopro/store.js";
import { listEmployees } from "../../lib/crewcore/store.js";
import { resolveAccountManagers, candidatesFrom, effectiveAccountManagerIds } from "../../lib/promopro/account-managers.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const isAdmin = await isAdminSession(sess);

    // A CrewCore outage must not take the whole app down: PromoPro can run
    // with an empty account-manager list and say so, which is far better
    // than a screen that will not load at all.
    async function roster() {
      try {
        return await listEmployees();
      } catch (e) {
        console.error("promopro/settings could not read the CrewCore roster:", e);
        return null;
      }
    }

    async function shape(stored) {
      const settings = withSettingDefaults(stored);
      const employees = await roster();

      if (employees === null) {
        settings.accountManagers = [];
        settings.rosterUnavailable = true;
        if (isAdmin) settings.candidates = [];
        return settings;
      }

      // First run: nobody has chosen yet, so offer Sales rather than an
      // empty picker that blocks every purchase order until somebody visits
      // Settings. Not written to storage, so an admin who deliberately
      // clears the list gets an empty list, not Sales back again.
      // Same helper the purchase-order route uses, so what this screen
      // offers and what a submission accepts can never drift apart.
      const ids = effectiveAccountManagerIds(settings, employees);

      settings.accountManagerIds = ids;
      settings.accountManagers = resolveAccountManagers(ids, employees);
      settings.usingDefaults = !withSettingDefaults(stored).accountManagerIds.length;

      const candidates = candidatesFrom(employees);
      if (isAdmin) settings.candidates = candidates;

      // The role names the edit-roles picker offers. Sent only to admins,
      // since it is the shell's role list and nobody else can change it here
      // anyway. Read live rather than stored, so a role added in shell
      // Settings shows up without a deploy.
      if (isAdmin) {
        try {
          const { getRoles } = await import("../../lib/users.js");
          const roles = await getRoles();
          settings.roleChoices = Object.values(roles || {})
            .map((r) => ({ name: String(r.name || "").toLowerCase(), label: r.label || r.name }))
            .filter((r) => r.name);
        } catch (e) {
          console.error("promopro/settings could not read the role list:", e && e.message);
          settings.roleChoices = [];
        }
      }

      // Counts, always, admin or not. An empty picker has several very
      // different causes (nobody on the roster, everybody inactive, nobody
      // with an email, or the caller not being treated as an admin) and they
      // want completely different fixes. Reporting the shape of what was read
      // means the screen can say which one it is instead of guessing. No
      // personal data here, just numbers.
      settings.rosterCounts = {
        total: employees.length,
        active: candidates.length,
        withEmail: candidates.filter((c) => c.selectable).length,
        adminView: isAdmin,
      };
      return settings;
    }

    if (req.method === "GET") {
      return res.status(200).json({ settings: await shape(await getSettings()) });
    }

    if (!isAdmin) return res.status(403).json({ error: "Admin access required" });

    if (req.method === "PATCH" || req.method === "POST") {
      const body = parseBody(req);
      // The stored settings go in too: a patch has to be judged on what the
      // settings will BE afterwards. Switching reply capture on in a request
      // that says nothing about the capture domain used to be accepted with
      // the domain still empty, and the result of that is invisible.
      const check = validateSettings(body, await getSettings());
      if (!check.ok) return res.status(400).json({ error: check.errors.join("; "), errors: check.errors });
      const saved = await shape(await saveSettings(check.patch));
      return res.status(200).json({ ok: true, settings: saved });
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("promopro/settings route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
