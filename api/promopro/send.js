// api/promopro/send.js — email a purchase order to its vendor.
//
// POST { poId, test: true|false }
//
// Sends through Resend, which MailMe already uses, so this is not a new
// dependency or a new domain to verify. `test: true` sends only to the
// signed-in person's account manager address so a PO can be checked before a
// vendor ever sees it.
//
// WHAT IS CHECKED IMMEDIATELY BEFORE DISPATCH, EVERY TIME
// A PO can sit as a draft for a week. Nothing about it is trusted as still
// true at send time, the same rule MailMe follows:
//   - the vendor still exists and still has an address
//   - the PO has at least one line and a total that is not zero by accident
//   - the from-address is configured
// A send that half works is worse than one that refuses: the vendor may
// already be producing.
//
// REPLIES
// Reply-To is set to the shop's PO inbox with the PO number in the subject,
// so a vendor hitting Reply reaches a person today. Automatic reply capture,
// where a confirmation moves the PO to Confirmed on its own, needs an inbound
// email service and is not wired yet. See the deploy notes.

import { requireAuth } from "../../lib/session.js";
import { canEditSession } from "../../lib/promopro/access.js";
import { getPo, updatePo, getVendors, getSettings } from "../../lib/promopro/store.js";
import { withSettingDefaults, ccListFor, poTotal, looksLikeEmail } from "../../lib/promopro/schema.js";
import { renderEmailHtml, renderEmailText } from "../../lib/promopro/document.js";
import { resendConfigured, sendOne } from "../../lib/mailme/resend-client.js";
import { listEmployees } from "../../lib/crewcore/store.js";
import { resolveAccountManagers, effectiveAccountManagerIds } from "../../lib/promopro/account-managers.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    if (!(await canEditSession(sess))) return res.status(403).json({ error: "Read-only access" });
    if (!resendConfigured()) {
      return res.status(400).json({ error: "Email is not configured. RESEND_API_KEY is missing." });
    }

    const body = parseBody(req);
    const poId = String(body.poId || "");
    if (!poId) return res.status(400).json({ error: "poId is required" });

    const po = await getPo(poId);
    if (!po) return res.status(404).json({ error: "Purchase order not found" });

    const [vendors, storedSettings, employees] = await Promise.all([
      getVendors(),
      getSettings(),
      listEmployees().catch(() => []),
    ]);

    const settings = withSettingDefaults(storedSettings);
    settings.accountManagers = resolveAccountManagers(
      effectiveAccountManagerIds(storedSettings, employees),
      employees
    );

    const vendor = vendors.find((v) => v.id === po.vendorId) || null;

    // --- pre-send checks, every time ---
    const problems = [];
    if (!vendor) problems.push("the vendor on this PO no longer exists");
    else if (!looksLikeEmail(vendor.email)) problems.push("that vendor has no order email set");
    if (!Array.isArray(po.lines) || !po.lines.length) problems.push("the PO has no lines");
    if (!poTotal(po)) problems.push("the PO totals zero, so the costs are probably not filled in");
    const fromAddress = settings.fromAddress || process.env.PROMOPRO_FROM || "";
    if (!looksLikeEmail(fromAddress)) {
      problems.push("no from-address is set in Settings");
    }
    if (problems.length) return res.status(400).json({ error: problems.join("; "), problems });

    const sender = settings.accountManagers.find((a) => a.id === po.accountManager) || null;
    const isTest = body.test === true;

    // A test goes to the account manager only. Nobody outside the shop sees a
    // PO that is being checked.
    const to = isTest
      ? [sender && sender.email].filter(Boolean)
      : [vendor.email];
    if (!to.length) {
      return res.status(400).json({ error: "No address to send the test to. The account manager on this PO has no email." });
    }

    const cc = isTest ? [] : ccListFor(po, vendor, settings);
    const brand = {
      name: settings.brandName || "P&M Apparel",
      address: settings.defaultShipTo || "",
      phone: settings.brandPhone || "",
    };
    const opts = { brand, sender: sender || {} };

    const subject = (isTest ? "[TEST] " : "") +
      `Purchase Order ${po.poNumber} from ${brand.name}`;

    const message = {
      from: `${brand.name} <${fromAddress}>`,
      to,
      subject,
      html: renderEmailHtml(po, vendor, opts),
      text: renderEmailText(po, vendor, opts),
      // A vendor hitting Reply must reach a person, not a no-reply address.
      // This is the one thing the QuickBooks version got wrong: replies went
      // to quickbooks@notification.intuit.com.
      reply_to: settings.replyTo || (sender && sender.email) || fromAddress,
    };
    if (cc.length) message.cc = cc;

    const result = await sendOne(message);

    if (isTest) {
      // Touches no dates and no history: a test is not a send.
      return res.status(200).json({ ok: true, test: true, to, messageId: result && result.id });
    }

    const now = new Date().toISOString();
    const history = Array.isArray(po.history) ? po.history.slice() : [];
    history.push({
      at: now,
      by: String(sess.username || "").toLowerCase(),
      what: `emailed to ${vendor.email}`,
    });

    // Sending IS submitting. Setting the date here rather than asking someone
    // to also tick a box means the pipeline cannot disagree with what
    // actually left the building.
    const patch = {
      history,
      lastSentAt: now,
      sentTo: vendor.email,
      sendCount: (Number(po.sendCount) || 0) + 1,
    };
    if (!po.submittedAt) patch.submittedAt = now.slice(0, 10);

    const saved = await updatePo(poId, patch);
    return res.status(200).json({ ok: true, po: saved, to, cc, messageId: result && result.id });
  } catch (e) {
    console.error("promopro/send route error:", e);
    return res.status(500).json({ error: e.message || "Could not send." });
  }
}
