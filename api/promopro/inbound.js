// api/promopro/inbound.js — a vendor's reply, landed on the purchase order.
//
// POST, called by Resend Inbound when mail arrives at the capture address.
//
// WHAT IT DOES AND DELIBERATELY DOES NOT DO
// A reply is recorded on the PO, stops the silence clock, and pings the
// account manager. It does NOT advance the stage. "Got it, we'll confirm
// Monday" and "confirmed" are the same shape to a parser, and a PO that
// silently marks itself Confirmed on the strength of an auto-responder is a
// worse failure than one that stays amber: the clock stops and nobody knows
// it stopped. Same rule as the StitchSense matching work, for the same
// reason. A silent wrong match is worse than no match.
//
// So: the reply is captured, the AM is told, and a human clicks the date.
//
// THE FORWARD IS NOT OPTIONAL
// Reply-To on a PO points here once capture is on, which means a vendor
// hitting Reply no longer reaches a person directly. Every captured message
// is therefore forwarded to the account manager as well as logged. If the
// forward fails the message is still on the PO, and the run says so, because
// the failure mode to avoid is a vendor reply that exists nowhere a person
// looks.
//
// MATCHING
// The address is per-PO: po+<poNumber>@<capture domain>. Resend delivers the
// original recipient, so the match is exact and there is no guessing from
// subject lines. Anything that cannot be matched is kept as unmatched and
// forwarded to the fallback address rather than dropped.
//
// AUTH. A shared secret, compared with safeEqual so an unset secret fails
// closed rather than matching undefined.
//
// PREFER THE HEADER. `x-promopro-secret` is how this should be called. The
// query string still works, because that is how the Resend endpoint is
// configured today and vendor replies must not start bouncing the moment
// this deploys, but a secret in a URL is a secret in every access log,
// referrer and screenshot of an address bar. That is exactly how
// MAILME_WEBHOOK_SECRET got out.
//
// WHICH ONE ARRIVED IS RECORDED in Settings (_inboundAuthVia), so after the
// Resend endpoint is changed, one real reply confirms the switch instead of
// somebody assuming it worked. Same reason the artwork callback records its
// outcome: "it is configured" and "it is working" are different claims.
//
// The stronger version is Resend's own Svix signature (svix-id /
// svix-timestamp / svix-signature). It is deliberately NOT implemented here:
// that signature is computed over the RAW request body, and this platform
// hands the handler a body that has already been parsed, so a check written
// here would verify a re-serialized copy and reject perfectly good mail.
// Bouncing real vendor replies is worse than the exposure it would close.
// Same open question as MailMe's webhook, and it needs the raw body solved
// first, not a signature library.
//
// ESM handler.

import { safeEqual } from "../../lib/session.js";
import { listPos, getPo, updatePo, getSettings, saveSettings, getVendors } from "../../lib/promopro/store.js";
import { withSettingDefaults } from "../../lib/promopro/schema.js";
import { resendConfigured, sendOne } from "../../lib/mailme/resend-client.js";
import { resolveAccountManagers, effectiveAccountManagerIds } from "../../lib/promopro/account-managers.js";
import { listEmployees } from "../../lib/crewcore/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

/**
 * The PO number out of a capture address. `po+26-66601@in.pmapparel.com`
 * gives "26-66601". Exported for the tests: this is the one piece of string
 * handling in the file and it is where a silent mismatch would come from.
 */
export function poNumberFromAddress(address) {
  const m = /\+([^@]+)@/.exec(String(address || ""));
  return m ? m[1].trim() : "";
}

/**
 * The purchase order a reply belongs to.
 *
 * CASE-INSENSITIVE, both sides, and trimmed. The local part of an address is
 * case-insensitive in practice: mail servers, autoresponders and mail clients
 * all rewrite it, and a reply arriving as PO+26-66608-9@ used to fall into
 * the unmatched pile. From the outside that is indistinguishable from a
 * vendor who never replied, which is the exact failure this feature exists to
 * end. Same fix as the domain casing in send.js, same reason.
 *
 * Exported and pure, because a silent mismatch here is the whole risk.
 */
export function matchPo(pos, poNumber) {
  const wanted = String(poNumber || "").trim().toLowerCase();
  if (!wanted) return null;
  const list = Array.isArray(pos) ? pos : [];
  return list.find((p) => String((p && p.poNumber) || "").trim().toLowerCase() === wanted) || null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.PROMOPRO_INBOUND_SECRET;
  // Header first. Both are accepted, but the one that arrived is recorded,
  // and only the header is a secret that stays out of logs.
  const fromHeader = req.headers && req.headers["x-promopro-secret"];
  const fromQuery = req.query && req.query.secret;
  const provided = fromHeader || fromQuery;
  if (!secret || !safeEqual(provided, secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const authVia = fromHeader ? "header" : "query string";

  try {
    const storedSettings = await getSettings();
    const settings = withSettingDefaults(storedSettings);

    // A heartbeat, before anything that can throw and before the capture
    // gate. Without it there is no way to tell "Resend never called us" from
    // "Resend called and capture was switched off", and those have different
    // fixes. It also records which way the secret arrived, which is how the
    // move off the query string gets confirmed.
    try {
      await saveSettings({
        _inboundLastAt: new Date().toISOString(),
        _inboundAuthVia: authVia,
        // Whether Resend signed this call. Recorded, not enforced: it is the
        // prerequisite for ever replacing the shared secret with signature
        // verification, and one real message answers it for good. Enforcing
        // it needs the raw body first, see the note at the top of this file.
        _inboundSigned: Boolean(req.headers && req.headers["svix-signature"]),
      });
    } catch (e) { /* a missing heartbeat must never cost a vendor reply */ }

    // Off until somebody turns it on in Settings, so deploying this route
    // changes nothing until the DNS is actually in place.
    if (settings.captureReplies !== true) {
      return res.status(200).json({ ok: true, ignored: "reply capture is switched off in Settings" });
    }

    const body = parseBody(req);
    const data = body.data || body;

    const to = []
      .concat(data.to || [])
      .concat(data.cc || [])
      .map((x) => (typeof x === "string" ? x : (x && x.address) || ""))
      .filter(Boolean);

    const from = typeof data.from === "string" ? data.from : ((data.from && data.from.address) || "");
    const subject = String(data.subject || "").slice(0, 300);
    const text = String(data.text || data.html || "").slice(0, 20000);

    const poNumber = to.map(poNumberFromAddress).find(Boolean) || "";

    const pos = await listPos();
    const po = matchPo(pos, poNumber);

    if (!po) {
      // Unmatched mail is forwarded, never dropped. A reply nobody can find
      // is the failure this whole feature exists to prevent.
      await forward(settings, settings.replyFallbackTo || settings.replyTo || settings.fromAddress, {
        subject: `[unmatched vendor reply] ${subject}`,
        text: `This reply could not be matched to a purchase order.\n\nFrom: ${from}\nTo: ${to.join(", ")}\n\n${text}`,
      });
      return res.status(200).json({ ok: true, matched: false, poNumber });
    }

    const at = new Date().toISOString();
    const replies = Array.isArray(po.replies) ? po.replies.slice() : [];
    replies.push({ at, from, subject, text: text.slice(0, 5000) });

    const history = Array.isArray(po.history) ? po.history.slice() : [];
    history.push({ at, by: "vendor", what: `replied: ${subject || "(no subject)"}` });

    await updatePo(po.id, {
      replies,
      history,
      // Stops the silence clock without touching a stage date. poHealth()
      // reads this, so the colour goes back to normal while the pipeline
      // still shows the order sitting where it actually sits.
      lastVendorReplyAt: at,
    });

    // Tell the person whose order it is, with the message itself, so they do
    // not have to open the app to find out what the vendor said.
    const employees = await listEmployees().catch(() => []);
    const ams = resolveAccountManagers(effectiveAccountManagerIds(storedSettings, employees), employees);
    const am = ams.find((a) => a.id === po.accountManager) || null;
    const vendors = await getVendors();
    const vendor = vendors.find((v) => v.id === po.vendorId) || null;

    const forwarded = await forward(settings, (am && am.email) || settings.replyFallbackTo || settings.fromAddress, {
      subject: `Re ${po.poNumber}: ${subject}`,
      text:
        `${(vendor && vendor.name) || "The vendor"} replied about purchase order ${po.poNumber}.\n\n` +
        `This has been logged on the order. The stage has NOT been changed: open the order and set the date ` +
        `if this reply means it is confirmed, shipped or anything else.\n\n` +
        `From: ${from}\n\n${text}`,
      replyTo: from,
    });

    return res.status(200).json({ ok: true, matched: true, poNumber: po.poNumber, forwarded });
  } catch (e) {
    console.error("promopro/inbound route error:", e);
    // 200 on purpose for anything we cannot handle cleanly: Resend retries a
    // failure, and a retry loop on a message that will never parse is worse
    // than one logged error.
    return res.status(200).json({ ok: false, error: e.message });
  }
}

async function forward(settings, to, message) {
  if (!to || !resendConfigured()) return false;
  const from = settings.fromAddress || process.env.PROMOPRO_FROM || "";
  if (!from) return false;
  try {
    await sendOne({
      from: `${settings.brandName || "PromoPro"} <${from}>`,
      to: [to],
      subject: message.subject,
      text: message.text,
      reply_to: message.replyTo || from,
    });
    return true;
  } catch (e) {
    console.error("[promopro] could not forward a vendor reply:", e && e.message);
    return false;
  }
}
