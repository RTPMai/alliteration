// lib/mailme/import.js — CSV parsing and dedupe for cold-outreach imports.
//
// PURE. No storage, no network. Everything here is directly testable, which
// matters because an import bug is silent: you do not find out that column
// mapping was off by one until 800 people receive an email addressed to their
// own phone number.
//
// The parser is hand-written rather than pulled from npm. package.json
// declares exactly one real dependency (@vercel/blob) and this repo has no
// build step; adding a CSV library for ~80 lines of well-understood parsing
// would cost more than it saves.
//
// ESM. Do NOT convert to module.exports.

import { normalizeEmail, isValidEmail, emailDomain } from "./schema.js";

/**
 * RFC 4180-style CSV parser.
 *
 * Handles quoted fields, escaped quotes (""), embedded commas and newlines
 * inside quotes, and both CRLF and LF line endings. Those are not edge cases:
 * an exported contact list routinely has "Smith, John" and multi-line address
 * fields, and a naive split(",") corrupts every row after the first one.
 */
export function parseCsv(text) {
  const src = String(text == null ? "" : text);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { endField(); i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { endRow(); i++; continue; }
    field += ch; i++;
  }

  // Trailing field/row unless the file ended on a clean newline.
  if (field !== "" || row.length) endRow();

  // Drop rows that are entirely empty (trailing blank lines).
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

// Header aliases. Real exported files use wildly different column names, and
// making someone rename headers by hand before importing is the kind of
// friction that ends with people not using the tool.
const HEADER_ALIASES = {
  email: ["email", "email address", "e-mail", "emailaddress", "work email", "primary email", "contact email"],
  company_name: ["company", "company name", "organization", "organisation", "org", "account", "business", "business name", "employer"],
  contact_name: ["name", "full name", "contact", "contact name", "fullname", "person"],
  first_name: ["first name", "firstname", "first", "given name"],
  last_name: ["last name", "lastname", "last", "surname", "family name"],
  title: ["title", "job title", "jobtitle", "position", "role"],
  phone: ["phone", "phone number", "telephone", "tel", "mobile", "direct"],
  city: ["city", "town"],
  state: ["state", "province", "region", "st"],
};

function canonicalField(header) {
  const h = String(header || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(h)) return canon;
  }
  return null;
}

/** Map a header row to canonical field names. Unrecognized columns are ignored. */
export function mapHeaders(headerRow) {
  const map = {};
  const unmapped = [];
  (headerRow || []).forEach((h, idx) => {
    const canon = canonicalField(h);
    if (canon && map[canon] === undefined) map[canon] = idx;
    else if (!canon && String(h).trim()) unmapped.push(String(h).trim());
  });
  return { map, unmapped };
}

/**
 * Turn CSV text into candidate prospect rows.
 *
 * Returns { rows, headers, unmapped, errors }. Rows that cannot be used are
 * NOT silently dropped: each carries a `problem` so the preview can show
 * exactly what was rejected and why. Silently discarding rows is how an
 * import of 1,000 becomes 640 with nobody noticing.
 */
export function parseProspectCsv(text) {
  const table = parseCsv(text);
  if (!table.length) {
    return { rows: [], headers: [], unmapped: [], errors: ["The file appears to be empty."] };
  }

  const headers = table[0].map((h) => String(h).trim());
  const { map, unmapped } = mapHeaders(headers);
  const errors = [];

  if (map.email === undefined) {
    errors.push(
      "No email column found. Name the column \"Email\" (or Email Address, Work Email) and try again. " +
      "Columns seen: " + headers.filter(Boolean).join(", ")
    );
    return { rows: [], headers, unmapped, errors };
  }

  const cell = (r, key) => (map[key] === undefined ? "" : String(r[map[key]] == null ? "" : r[map[key]]).trim());

  const rows = table.slice(1).map((r, n) => {
    const email = normalizeEmail(cell(r, "email"));

    // Prefer an explicit full name; otherwise assemble from first/last.
    let contact_name = cell(r, "contact_name");
    if (!contact_name) {
      contact_name = [cell(r, "first_name"), cell(r, "last_name")].filter(Boolean).join(" ").trim();
    }

    const row = {
      lineNumber: n + 2,               // +2: 1-indexed, and row 1 is the header
      email,
      company_name: cell(r, "company_name"),
      contact_name,
      title: cell(r, "title"),
      phone: cell(r, "phone"),
      city: cell(r, "city"),
      state: cell(r, "state"),
      problem: null,
    };

    if (!email) row.problem = "No email address";
    else if (!isValidEmail(email)) row.problem = "Not a valid email address";

    return row;
  });

  return { rows, headers, unmapped, errors };
}

// Addresses that should never be cold-mailed. These are role accounts, not
// people: mailing them produces complaints at a much higher rate, and
// abuse@/postmaster@ in particular are the addresses used to REPORT spam.
const ROLE_PREFIXES = [
  "abuse", "postmaster", "noreply", "no-reply", "donotreply", "do-not-reply",
  "spam", "unsubscribe", "bounce", "mailer-daemon",
];

export function isRoleAddress(email) {
  const local = normalizeEmail(email).split("@")[0] || "";
  return ROLE_PREFIXES.some((p) => local === p || local.startsWith(p + "-") || local.startsWith(p + "."));
}

/**
 * Classify parsed rows against what already exists.
 *
 * Four outcomes, and the ORDER of the checks is deliberate:
 *
 *   suppressed  — the address previously unsubscribed, bounced or complained.
 *                 Checked FIRST and never importable. Re-importing a CSV must
 *                 not resurrect someone who opted out; that is the single
 *                 worst failure this tool could have, both legally and for
 *                 the shop's reputation.
 *   existing    — already a client in the BackBone roster. Not importable as
 *                 a prospect: they are a customer, and cold-mailing a current
 *                 client is an embarrassment, not a compliance issue.
 *   duplicate   — already imported as a prospect, or repeated within this
 *                 same file.
 *   invalid     — no/malformed email, or a role address.
 *   new         — importable.
 */
export function classifyRows(rows, ctx) {
  const c = ctx || {};
  const suppressed = new Set((c.suppressedEmails || []).map(normalizeEmail));
  const clients = new Set((c.clientEmails || []).map(normalizeEmail));
  const prospects = new Set((c.prospectEmails || []).map(normalizeEmail));

  const seenInFile = new Set();
  const out = { new: [], duplicate: [], existing: [], suppressed: [], invalid: [] };

  for (const row of rows || []) {
    // Normalize defensively. parseProspectCsv already lowercases, but this
    // function is also reachable with hand-built rows, and comparing a raw
    // address against normalized sets would let "Gone@X.com" past a
    // suppression entry for "gone@x.com". Silently mailing an opted-out
    // person is the worst failure this module could have.
    const r = { ...row, email: normalizeEmail(row.email) };

    if (r.problem) { out.invalid.push(r); continue; }
    if (isRoleAddress(r.email)) {
      r.problem = "Role address (abuse@, noreply@ and similar are never mailed)";
      out.invalid.push(r);
      continue;
    }

    if (suppressed.has(r.email)) {
      r.problem = "Previously unsubscribed, bounced or complained";
      out.suppressed.push(r);
      continue;
    }
    if (clients.has(r.email)) {
      r.problem = "Already a client in the BackBone roster";
      out.existing.push(r);
      continue;
    }
    if (prospects.has(r.email)) {
      r.problem = "Already imported as a prospect";
      out.duplicate.push(r);
      continue;
    }
    if (seenInFile.has(r.email)) {
      r.problem = "Repeated earlier in this same file";
      out.duplicate.push(r);
      continue;
    }

    seenInFile.add(r.email);
    out.new.push(r);
  }

  return out;
}

/**
 * Rows that are not imported but CAN still go on the list the batch is
 * headed for (Sep 29 2026).
 *
 * Ryan imported a 75-row Holiday Store list and got a list of 7: 67 of the
 * rows were already clients, and import only ever created prospects, so the
 * clients were reported and then left off the list he named. The whole point
 * of the batch was the list.
 *
 * So a row that matches someone MailMe already knows (a BackBone client, or a
 * prospect from an earlier import) is added to the list as that existing
 * contact. Nothing is created and nothing about the contact changes. Opted-out
 * and invalid rows stay out, always.
 *
 * `contacts` is [{ id, email }]. Every record with that address is returned,
 * because a person can sit under two companies; the send still mails the
 * mailbox once. Returns { ids, emails } with each address counted once.
 */
export function listAdditions(classified, contacts) {
  const c = classified || {};
  const wanted = new Set();
  (c.existing || []).forEach((r) => wanted.add(normalizeEmail(r.email)));
  (c.duplicate || []).forEach((r) => {
    // Only a match to an EARLIER import. A line repeated inside this same
    // file is already on the list through its first appearance.
    if (/Already imported/.test(r.problem || "")) wanted.add(normalizeEmail(r.email));
  });
  const ids = [];
  const found = new Set();
  (Array.isArray(contacts) ? contacts : []).forEach((ct) => {
    const e = normalizeEmail(ct && ct.email);
    if (e && wanted.has(e) && ct.id != null) { ids.push(String(ct.id)); found.add(e); }
  });
  return { ids: Array.from(new Set(ids)), emails: Array.from(found) };
}

/**
 * Domains contributing the most importable rows. A cold list that is 60% one
 * domain is usually a scrape of a single directory, and is worth a second
 * look before it goes out.
 */
export function domainBreakdown(rows, limit) {
  const counts = new Map();
  for (const r of rows || []) {
    const d = emailDomain(r.email);
    if (!d) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit || 5);
}

/**
 * Find a list by the name someone typed. Case and outer spaces do not count,
 * so "holiday store prospects " finds "Holiday Store Prospects" instead of
 * quietly creating a second list with the same name.
 */
export function findListByName(lists, name) {
  const want = String(name == null ? "" : name).trim().toLowerCase();
  if (!want) return null;
  return (Array.isArray(lists) ? lists : [])
    .find((l) => l && String(l.name || "").trim().toLowerCase() === want) || null;
}

/**
 * What putting `ids` on a list would do (Oct 1 2026).
 *
 * The list step used to run in the browser after the import, against the
 * lists the page had loaded earlier. Ryan's Holiday Store upload showed the
 * preview, said everyone would be "added to your list", and the list still
 * held 7. Doing it here, on the server, in the same request as the import,
 * leaves nothing to go stale between the two.
 *
 *   list            the existing list, or null to create one
 *   ids             contact ids that should end up on it
 *   currentIds      ids the list resolves to right now (rule + exceptions)
 *
 * Returns { action, patch, addingIds, alreadyIds }:
 *   create   a new static list holding exactly `ids`
 *   static   members widened to include `ids`
 *   dynamic  `ids` the rule does not already catch become exceptions, and
 *            any of them that had been removed by hand are let back in:
 *            naming them in an upload is the newer, more explicit request
 */
export function planListAdd(list, ids, currentIds, name) {
  const want = Array.from(new Set((ids || []).map(String)));
  const current = new Set((currentIds || []).map(String));
  const addingIds = want.filter((id) => !current.has(id));
  const alreadyIds = want.filter((id) => current.has(id));

  if (!list) {
    return {
      action: "create",
      patch: { name: String(name || "").trim(), kind: "static", members: want },
      addingIds: want, alreadyIds: [],
    };
  }
  if (list.kind === "static") {
    const members = Array.from(new Set([...(list.members || []).map(String), ...want]));
    return { action: "static", patch: { members }, addingIds, alreadyIds };
  }
  const extraMembers = Array.from(new Set([...(list.extraMembers || []).map(String), ...addingIds]));
  const wanted = new Set(want);
  const excludedMembers = (list.excludedMembers || []).map(String).filter((id) => !wanted.has(id));
  return { action: "dynamic", patch: { extraMembers, excludedMembers }, addingIds, alreadyIds };
}

/** Distinct people behind a set of contact ids. Two records, one mailbox, one person. */
export function peopleCount(ids, contacts) {
  const want = new Set((ids || []).map(String));
  const emails = new Set();
  let unmatched = 0;
  const seen = new Set();
  (Array.isArray(contacts) ? contacts : []).forEach((c) => {
    const id = String(c && c.id);
    if (!want.has(id)) return;
    seen.add(id);
    emails.add(normalizeEmail(c.email));
  });
  want.forEach((id) => { if (!seen.has(id)) unmatched++; });
  return emails.size + unmatched;
}
