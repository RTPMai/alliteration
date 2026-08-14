// lib/promopro/account-managers.js — who can own a purchase order.
//
// REPLACES a typed-in list, Aug 14 2026. The first cut had you enter each
// account manager's name and address by hand, on the reasoning that shell
// accounts carry no email. That was true and still the wrong answer: CrewCore
// already holds the roster, with an email on every record, and a second list
// of the same people is a list that goes stale. Somebody changes their
// address in CrewCore, PromoPro keeps CC'ing the old one, and nothing tells
// you.
//
// So PromoPro stores only WHICH employees can own a PO, by id. Name and email
// are resolved from CrewCore at read time, every time. Change it there, it
// changes here.
//
// This is a lib-to-lib read, which is allowed. lib/ never importing from api/
// is the rule, and that is respected.
//
// PRIVACY NOTE: only id, name and email ever leave this file. CrewCore is
// admin-gated because it holds pay and review notes, and none of that is
// touched here. A colleague's work address is not in the same category as
// their hourly rate.
//
// ESM. Do NOT convert to module.exports.

import { looksLikeEmail } from "./schema.js";

// Who is offered by default when nobody has been chosen yet. Sales is where
// account managers live on the CrewCore org chart. It is a starting point,
// not a rule: production and office people own promo orders too, so the
// Settings screen can add anyone active.
export const DEFAULT_DEPARTMENTS = ["Sales"];

function fullName(e) {
  if (!e) return "";
  if (e.name) return String(e.name).trim();
  const parts = [e.first_name, e.last_name].filter(Boolean).map((p) => String(p).trim());
  return parts.join(" ").trim();
}

/**
 * Everyone on the roster who COULD be made an account manager, with a flag
 * for whether they are usable. Someone with no email in CrewCore is listed
 * but not selectable, because picking them would mean a PO whose owner is
 * silently never copied. Better to show why they are greyed out than to hide
 * them and have somebody hunt for a name that should be there.
 */
export function candidatesFrom(employees) {
  const list = Array.isArray(employees) ? employees : [];
  return list
    .filter((e) => e && (e.status === undefined || e.status === "active"))
    .map((e) => {
      const name = fullName(e);
      const email = String(e.email || "").trim();
      return {
        id: String(e.id || ""),
        name,
        email,
        department: e.department || "",
        title: e.title || "",
        selectable: !!(name && looksLikeEmail(email)),
        reason: !name ? "no name on the CrewCore record"
          : (!email ? "no email in CrewCore"
            : (!looksLikeEmail(email) ? "the email in CrewCore does not look valid" : "")),
      };
    })
    .filter((c) => c.id)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The actual account manager list PromoPro uses: the chosen ids, resolved
 * against the roster, in roster order.
 *
 * An id that no longer resolves (employee deleted, or email removed) is
 * dropped rather than returned half-formed. A PO already pointing at that
 * person keeps its stored id, so history is not rewritten; it just shows as
 * unresolved on screen, which is the honest thing to show.
 */
export function resolveAccountManagers(selectedIds, employees) {
  const ids = Array.isArray(selectedIds) ? selectedIds.map(String) : [];
  if (!ids.length) return [];
  const byId = new Map(candidatesFrom(employees).map((c) => [c.id, c]));
  return ids
    .map((id) => byId.get(String(id)))
    .filter((c) => c && c.selectable)
    .map((c) => ({ id: c.id, name: c.name, email: c.email }));
}

/**
 * First-run default: if nobody has been chosen yet, offer the Sales
 * department rather than an empty picker that blocks every purchase order
 * until somebody visits Settings.
 */
export function defaultSelection(employees) {
  return candidatesFrom(employees)
    .filter((c) => c.selectable && DEFAULT_DEPARTMENTS.includes(c.department))
    .map((c) => c.id);
}
