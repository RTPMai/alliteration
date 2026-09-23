// PUT IN: lib/crewcore/pto-email.js
// lib/crewcore/pto-email.js: email the employee when their time off is
// decided.
//
// Sep 21 2026, Ryan: "need to email them." The bell notification only reaches
// somebody when they next open Alliteration, and plenty of the shop does not
// open it daily. So every decision that changes somebody's time off also goes
// to the email on their CrewCore roster record:
//
//   approved, denied, cancelled by an approver, and time off an approver
//   logged for them (a phoned-in sick day).
//
// Not sent when the person cancels their own request: they already know.
//
// WHERE IT GOES. Their PERSONAL email if the roster has one, otherwise their
// work email (Sep 23 2026). The supervisor copy goes to the supervisor's WORK
// email. The reply-to is the approver's work email. No email on file means no
// email, and the request records why ("no email on their roster record") so
// the screen can say so instead of everyone assuming it went out.
//
// FROM. The time off from-address in Settings (defaults to
// Ryan@pmapparel.com, same as the review requests; pmapparel.com is the
// domain verified in Resend). Replies go to whoever made the decision when
// their roster record has an email, otherwise to the from-address.
//
// FAILS SOFT, ALWAYS. The decision is saved before this runs. An email that
// cannot be sent is recorded on the request, never thrown: losing an approval
// because Resend had a bad minute would be the wrong trade.
//
// The reason the employee gave is not in the email. It is theirs, they wrote
// it. The approver's note on a denial IS, because that is written to them.
//
// ESM. Do NOT convert to module.exports.

import { requestSummary, usesPto } from "./pto.js";
import { timeOffEmailOf } from "./schema.js";

export const DEFAULT_TIMEOFF_FROM = "Ryan@pmapparel.com";

export function looksLikeEmail(s) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(s || "").trim());
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function longDay(d) {
  const [y, m, day] = String(d || "").split("-").map(Number);
  if (!y) return String(d || "");
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

function hrs(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return `${v} ${v === 1 ? "hour" : "hours"}`;
}

/** The dates, in words. "Friday, October 2, 2026", or "... through ...". */
export function whenText(r) {
  if (!r) return "";
  if (r.start_date === r.end_date) return longDay(r.start_date);
  return `${longDay(r.start_date)} through ${longDay(r.end_date)}`;
}

const HEADLINES = {
  approved: "Your time off is approved",
  denied: "Your time off request was denied",
  cancelled: "Your time off was cancelled",
  logged: "Time off was logged for you",
  changed: "Your time off was changed",
};

/**
 * Subject, plain text and HTML for one decision. Pure: no network, so the
 * wording is tested directly.
 *
 * @param {object} o
 * @param {object} o.request     the saved request
 * @param {string} o.event       approved | denied | cancelled | logged
 * @param {string} o.firstName   the employee's first name, for the greeting
 * @param {string} o.byName      who decided
 * @param {string} o.note        the approver's note, if any
 * @param {object} o.balance     their balance row for that year, if known
 */
export function buildDecisionEmail(o) {
  const r = o.request || {};
  const event = HEADLINES[o.event] ? o.event : "approved";
  const headline = HEADLINES[event];
  const when = whenText(r);
  const kind = r.type && r.type !== "all_days" ? requestSummary(r) : "";
  const lines = [];

  lines.push(`Hi ${o.firstName || "there"},`);
  lines.push("");
  if (event === "approved") lines.push(`${o.byName || "An approver"} approved your time off.`);
  if (event === "denied") lines.push(`${o.byName || "An approver"} denied your time off request.`);
  if (event === "cancelled") lines.push(`${o.byName || "An approver"} cancelled your time off. The hours are back on your balance.`);
  if (event === "logged") lines.push(`${o.byName || "An approver"} logged time off for you.`);
  if (event === "changed") lines.push(`${o.byName || "An approver"} changed your time off. Here is what it says now.`);
  lines.push("");
  lines.push(`When: ${when}`);
  if (kind) lines.push(`What: ${kind}`);
  lines.push(usesPto(r) ? `PTO: ${hrs(r.hours)}` : `Not using PTO: ${hrs(r.hours)} unpaid`);
  if (o.note) {
    lines.push("");
    lines.push(`Note from ${o.byName || "the approver"}: ${o.note}`);
  }
  const b = o.balance;
  if (b && (event === "approved" || event === "logged" || event === "cancelled" || event === "changed")) {
    lines.push("");
    lines.push(`You have ${hrs(b.balance)} of PTO left for ${b.year}.`);
  }
  lines.push("");
  if (o.ccName) lines.push(`${o.ccName} is copied on this.`);
  lines.push("See all your time off in CrewCore, under Time Off.");
  lines.push("");
  lines.push("P&M Apparel");

  const text = lines.join("\n");

  // TOKEN-EXEMPT: email HTML. A mail client cannot read CSS variables from
  // css/tokens.css, so the few colours here are written out, the same
  // exemption PromoPro's vendor document and the review request use.
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px 28px">
  <h1 style="font-size:20px;margin:0 0 16px">${esc(headline)}</h1>
  ${lines.slice(0, -2).filter((l) => l !== "").map((l) => `<p style="font-size:15px;line-height:1.5;margin:0 0 10px">${esc(l)}</p>`).join("\n  ")}
  <p style="font-size:13px;color:#78716c;margin:18px 0 0">P&amp;M Apparel</p>
</div></body></html>`;

  return { subject: `${headline}: ${when}`, text, html };
}

/**
 * Send it. `send` is injectable so tests never touch the network; it
 * defaults to the MailMe Resend client, which is the one already configured.
 *
 * Returns { sent, why, id } and never throws.
 */
export async function sendDecisionEmail(o, deps = {}) {
  // Personal address first (Sep 23 2026): this is their time off, not work.
  const to = timeOffEmailOf(o.employee);
  if (!looksLikeEmail(to)) return { sent: false, why: "no email on their roster record" };
  const from = String(o.from || DEFAULT_TIMEOFF_FROM).trim();
  if (!looksLikeEmail(from)) return { sent: false, why: "no from-address set in CrewCore Settings" };

  let send = deps.send;
  if (!send) {
    const client = await import("../mailme/resend-client.js");
    if (!client.resendConfigured()) return { sent: false, why: "email is not set up (RESEND_API_KEY)" };
    send = client.sendOne;
  }

  // A supervisor who is also the person off, or has no address, is not copied.
  const cc = (Array.isArray(o.cc) ? o.cc : []).map((x) => String(x || "").trim())
    .filter((x) => looksLikeEmail(x) && x.toLowerCase() !== to.toLowerCase());

  const first = String((o.employee && o.employee.name) || "").trim().split(/\s+/)[0] || "";
  const msg = buildDecisionEmail({ ...o, firstName: first, ccName: cc.length ? o.ccName : "" });
  const replyTo = looksLikeEmail(o.replyTo) ? o.replyTo : from;
  try {
    const res = await send({
      from: `P&M Apparel <${from}>`,
      to: [to],
      cc: cc.length ? cc : undefined,
      reply_to: replyTo,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      tags: [{ name: "app", value: "crewcore_timeoff" }],
    });
    return { sent: true, id: (res && (res.id || (res.data && res.data.id))) || null, to, cc };
  } catch (e) {
    console.error("[crewcore/timeoff] email failed, the decision was still saved:", e.message);
    return { sent: false, why: e.message || "the email could not be sent" };
  }
}
