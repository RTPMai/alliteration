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
// AUTH. A shared secret in the query string, compared with safeEqual so an
// unset secret fails closed rather than matching undefined.
//
// ESM handler.

import { safeEqual } from "../../lib/session.js";
import { listPos, getPo, updatePo, getSettings, getVendors } from "../../lib/promopro/store.js";
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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.PROMOPRO_INBOUND_SECRET;
  const provided = (req.query && req.query.secret) || req.headers["x-promopro-secret"];
  if (!secret || !safeEqual(provided, secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const storedSettings = await getSettings();
    const settings = withSettingDefaults(storedSettings);

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
    const po = poNumber ? pos.find((p) => String(p.poNumber) === poNumber) : null;

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
