// api/concontrol/export.js — CSV out.
//
// GET ?what=sponsors|ledger|sessions|speakers|signage
//
// Four exports plus one that is not a table dump: "signage" is the list of who
// goes on the banner, which is the one export somebody actually asks for by
// name and the one most likely to be assembled wrong by hand at 11pm.
//
// GATED ON can_export, the permission that already exists and, until now,
// nothing used. Sponsors and the ledger carry money; the export is the version
// of a record that leaves the building, so it gets its own switch rather than
// riding on read access.

import { requireAuth } from "../../lib/session.js";
import { permsFor } from "../../lib/users.js";
import {
  sponsorMoney, deliverableStates, obligationStates, momentLabel, PAYMENT_KIND_LABELS,
  STATUS_LABELS, DEFAULT_EVENT,
} from "../../lib/concontrol/schema.js";
import { ENTRY_STATE_LABELS } from "../../lib/concontrol/ledger.js";
import { SESSION_STATUS_LABELS, SPEAKER_STATUS_LABELS, TRACKS } from "../../lib/concontrol/program.js";
import {
  listSponsors, listEntries, listSessions, listSpeakers, getSettings,
} from "../../lib/concontrol/store.js";

/**
 * One CSV cell. Quotes everything rather than deciding per value: a company
 * called "Smith, Jones & Co" is common and a comma that slips through shifts
 * every column after it, silently, in a file somebody opens in Excel and
 * believes.
 */
function cell(v) {
  if (v === null || v === undefined) return '""';
  return '"' + String(v).replace(/"/g, '""').replace(/\r?\n/g, " ") + '"';
}

function toCsv(headers, rows) {
  const out = [headers.map(cell).join(",")];
  for (const r of rows) out.push(r.map(cell).join(","));
  // Leading BOM so Excel opens it as UTF-8 rather than mangling an accented
  // speaker name into nonsense.
  return "\uFEFF" + out.join("\r\n") + "\r\n";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const perms = await permsFor(sess.username);
    const superuser = !!(perms && perms.superuser === true);
    if (!superuser && perms && perms.can_export === false) {
      return res.status(403).json({ error: "Your account cannot export from ConControl." });
    }

    const settings = await getSettings();
    const q = req.query || {};
    const event = (q.event && String(q.event)) || settings.event || DEFAULT_EVENT;
    const what = String(q.what || "sponsors");

    let headers = [];
    let rows = [];
    let name = what;

    if (what === "sponsors") {
      const sponsors = await listSponsors(event);
      headers = ["Id", "Company", "Contact", "Email", "Phone", "Level", "Status",
        "Committed", "Invoiced", "Invoice number", "Paid", "Cash", "Credit",
        "In kind", "Outstanding", "Moments", "They owe us", "We owe them", "Notes"];
      rows = sponsors.map((s) => {
        const m = sponsorMoney(s);
        const d = deliverableStates(s);
        const o = obligationStates(s);
        const theirs = Object.keys(d).filter((k) => d[k].state === "open").length;
        const ours = Object.keys(o).filter((k) => o[k].state === "open").length;
        return [
          s.id, s.company, s.contactName, s.email, s.phone, s.tier,
          STATUS_LABELS[s.status] || s.status,
          m.committed, m.invoiced, s.invoiceNumber,
          m.paid, m.cash, m.credit, m.inKind, m.outstanding,
          (s.moments || []).map(momentLabel).join("; "),
          theirs, ours, s.notes,
        ];
      });
    } else if (what === "signage") {
      // Committed sponsors only, in level order, which is the order a banner
      // is laid out in. A sponsor still in conversation on a printed banner is
      // the expensive mistake this export exists to prevent.
      const order = (settings.tiers || []).map((t) => t.name);
      const sponsors = (await listSponsors(event))
        .filter((s) => s.status === "committed")
        .sort((a, b) => {
          const d = order.indexOf(a.tier) - order.indexOf(b.tier);
          return d !== 0 ? d : String(a.company).localeCompare(String(b.company));
        });
      headers = ["Level", "Company", "Logo received", "How they paid", "Website", "Moments"];
      rows = sponsors.map((s) => {
        const d = deliverableStates(s);
        const m = sponsorMoney(s);
        const how = [
          m.cash ? "cash" : "",
          m.credit ? "credit" : "",
          m.inKind ? "in kind" : "",
        ].filter(Boolean).join(" + ") || "nothing yet";
        return [
          s.tier, s.company,
          d.logo.state === "done" ? "yes" : "NO",
          how,
          s.website,
          (s.moments || []).map(momentLabel).join("; "),
        ];
      });
    } else if (what === "ledger") {
      const entries = await listEntries(event);
      headers = ["Id", "Date", "Kind", "State", "Category", "Description", "Vendor", "Invoice", "Amount", "Notes"];
      rows = entries.map((e) => [
        e.id, e.date, e.kind, ENTRY_STATE_LABELS[e.state] || e.state,
        e.category, e.description, e.vendor, e.invoiceNumber, e.amount, e.notes,
      ]);
    } else if (what === "sessions") {
      const sessions = await listSessions(event);
      const speakers = await listSpeakers(event);
      const byId = new Map(speakers.map((s) => [s.id, s]));
      headers = ["Id", "Day", "Start", "Minutes", "Track", "Format", "Title", "Speakers", "Status", "Equipment"];
      rows = sessions.map((s) => [
        s.id, s.day, s.start, s.minutes,
        (TRACKS.find((t) => t.key === s.track) || {}).label || s.track,
        s.format, s.title,
        (s.speakerIds || []).map((id) => (byId.get(id) || {}).name).filter(Boolean).join("; "),
        SESSION_STATUS_LABELS[s.status] || s.status, s.equipment,
      ]);
    } else if (what === "speakers") {
      const speakers = await listSpeakers(event);
      headers = ["Id", "Name", "Company", "Email", "Phone", "Status", "Topic", "Travel needed", "Notes"];
      rows = speakers.map((s) => [
        s.id, s.name, s.company, s.email, s.phone,
        SPEAKER_STATUS_LABELS[s.status] || s.status, s.topic,
        s.travelNeeded ? "yes" : "no", s.notes,
      ]);
    } else {
      return res.status(400).json({ error: `Nothing to export called "${what}"` });
    }

    const filename = `${event}-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(toCsv(headers, rows));
  } catch (e) {
    console.error("concontrol export route error:", e);
    return res.status(500).json({ error: e.message || "Export failed" });
  }
}
