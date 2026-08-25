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
import { resendConfigured, sendOne, domainStatusChecked } from "../../lib/mailme/resend-client.js";
import { blacklistWarning } from "../../lib/promopro/vendor-stats.js";
import { artUrlFor, linkDays } from "../../lib/promopro/art-token.js";
import { buildAttachments } from "../../lib/promopro/attachments.js";
import { reconcileArt } from "../../lib/promopro/art-reconcile.js";
import { listEmployees } from "../../lib/crewcore/store.js";
import { resolveAccountManagers, effectiveAccountManagerIds } from "../../lib/promopro/account-managers.js";

/**
 * The per-PO capture address, or "" when capture is off. Per-PO rather than
 * one shared inbox so a reply matches exactly, instead of being guessed at
 * from a subject line somebody edited.
 */
function captureAddress(po, settings) {
  if (!settings || settings.captureReplies !== true) return "";
  const domain = String(settings.captureDomain || "").trim().replace(/^@+/, "");
  if (!domain || !po.poNumber) return "";
  return `po+${po.poNumber}@${domain}`;
}

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
    const settingsForGate = await getSettings();
    if (!(await canEditSession(sess, settingsForGate))) {
      return res.status(403).json({ error: "Read-only access" });
    }
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

    // The sending domain must show verified in Resend RIGHT NOW, the same
    // live check MailMe makes before every send. A domain that was verified
    // when Settings was filled in can fall out of verification when a DNS
    // record is edited months later, and the failure that produces is a
    // vendor who never receives the PO while the app says it sent one.
    //
    // Checked only when there is a from-address to check, so a missing
    // address reports as one problem rather than two.
    if (looksLikeEmail(fromAddress)) {
      // Domain names are case-insensitive, and Resend stores them lower
      // cased. Comparing what somebody typed, capitals and all, against that
      // list reported a perfectly verified domain as missing.
      const domain = fromAddress.split("@")[1].trim().toLowerCase();
      const check = await domainStatusChecked(domain);

      if (!check.reachable) {
        // COULD NOT CHECK is not the same as NOT VERIFIED, and must not be
        // treated as it. Blocking a purchase order because Resend had a bad
        // minute, with a message saying the domain is unverified, sends
        // somebody off to debug DNS that was never broken. Let it through:
        // if the domain really is unverified, Resend refuses the send itself
        // and the real error comes back.
        console.warn("[promopro] could not verify the sending domain:", check.reason);
      } else if (!check.found) {
        problems.push(`${domain} has not been added to Resend, so this would not be delivered`);
      } else if (check.status !== "verified") {
        problems.push(
          `${domain} shows as "${check.status}" in Resend rather than verified, so this would not be delivered`
        );
      }
    }

    // Sending to a blacklisted vendor takes the same explicit yes that
    // raising the PO did. Asked again here rather than trusting the answer
    // given at creation, because a vendor can be blacklisted AFTER an order
    // was raised, and that is exactly the case worth catching.
    if (vendor && vendor.blacklisted === true && body.confirmBlacklist !== true) {
      return res.status(409).json({
        error: blacklistWarning(vendor),
        blacklisted: true,
        vendorId: vendor.id,
        vendorName: vendor.name,
        reason: vendor.blacklistReason || "",
      });
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
    // Signed, expiring links, minted per send. Re-sending an order issues
    // fresh ones rather than reusing whatever was in the last email, so a
    // resend after an expiry just works.
    const base = (process.env.PROMOPRO_PUBLIC_URL || `https://${req.headers.host || ""}`).replace(/\/+$/, "");
    // WHAT ARTWORK EXISTS IS ASKED OF STORAGE, NOT OF THE RECORD.
    //
    // A file uploaded seconds ago may not have been written to the order
    // yet. Reading the order would then send a vendor a purchase order with
    // the artwork missing, which is the one thing this must not do. Listing
    // the order's own folder answers the question directly.
    const reconciled = await reconcileArt(po.id, po);

    // Repair the record while we are here, so the screen agrees with the
    // email. A failure to save must not stop the send: the attachment list
    // is already correct either way.
    if (reconciled.added.length) {
      try {
        await updatePo(po.id, { art: reconciled.art });
      } catch (e) {
        console.error("[promopro] could not save reconciled artwork:", e && e.message);
      }
    }

    // Artwork rides IN the message. Anything too big for one email, or that
    // storage could not hand back, falls through to a signed link rather
    // than being dropped, and the email says which is which.
    const built = await buildAttachments(reconciled.art);

    const artUrls = {};
    built.linked.forEach((a) => {
      if (a && a.id) artUrls[a.id] = base + artUrlFor(po, a, settings);
    });

    const days = linkDays(settings);
    // Absolute, always. A relative src in an email resolves against the mail
    // client's own domain and shows a broken image in every inbox.
    const logoUrl = settings.logoUrl
      ? (/^https:\/\//.test(settings.logoUrl) ? settings.logoUrl : base + settings.logoUrl)
      : "";

    const opts = {
      brand,
      sender: sender || {},
      logoUrl,
      artUrls,
      attached: built.attachments.map((a) => a.filename),
      artReasons: built.reasons,
      artExpiryNote: Object.keys(artUrls).length
        ? `Links work for ${days} days; reply for a fresh one after that.`
        : "",
    };

    const subject = (isTest ? "[TEST] " : "") +
      `Purchase Order ${po.poNumber} from ${brand.name}`;

    const message = {
      from: `${brand.name} <${fromAddress}>`,
      to,
      subject,
      ...(built.attachments.length ? { attachments: built.attachments } : {}),
      html: renderEmailHtml(po, vendor, opts),
      text: renderEmailText(po, vendor, opts),
      // A vendor hitting Reply must reach a person, not a no-reply address.
      // This is the one thing the QuickBooks version got wrong: replies went
      // to quickbooks@notification.intuit.com.
      // When reply capture is on, a vendor's Reply goes to a per-PO address
      // that logs the message on the order and forwards it to the account
      // manager. Off, it goes straight to the person, exactly as before.
      // Never to a no-reply address: that is what the QuickBooks version got
      // wrong.
      reply_to: captureAddress(po, settings) || settings.replyTo || (sender && sender.email) || fromAddress,
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
