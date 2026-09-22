// PUT IN: lib/promopro/nudge.js
// lib/promopro/nudge.js — the automatic "have you got this?" email to the
// vendor when a purchase order has gone out and nothing has come back.
//
// THE GAP THIS CLOSES
// lib/promopro/chase.js already tells US that a vendor has gone quiet: it
// raises a notification on the account manager's list and an optional morning
// digest. Both are inward facing. The vendor, who is the only person who can
// actually end the silence, still hears nothing until somebody in the shop
// gets round to writing to them, and on a busy week nobody does. A PO sitting
// unconfirmed for nine days usually means one email nobody sent, not a
// supplier who refused.
//
// SO THIS IS THE OUTWARD HALF, and it is deliberately a separate file, a
// separate route and a separate switch from chase.js. One writes to our own
// team, one writes to other companies. They fail differently, they need
// different guards, and mixing them would mean a bug in the digest could put
// mail in a vendor's inbox.
//
// WHAT IT WILL NOT DO
//   - nudge a vendor who has replied since the send. A reply is not a
//     confirmation (nothing advances a stage automatically, see inbound.js)
//     but emailing "I have not heard from you" to somebody who wrote back
//     yesterday is worse than saying nothing at all. Those orders are held
//     and reported, not silently skipped.
//   - nudge forever. Two goes by default, then it stops and leaves the order
//     to the notification list and a human. A reminder that arrives every
//     morning is one the vendor filters.
//   - nudge on a Saturday, or count a weekend as waiting. A PO sent Thursday
//     is not two working days old on Saturday.
//   - nudge a blacklisted vendor, an outsourced job with no PO, or an order
//     older than the backstop below.
//   - nudge on the strength of a recomputed CC list. It goes to the people
//     who were actually on the original email, read back off the order.
//
// ESM. Do NOT convert to module.exports.

import {
  currentStage, isOutsourced, looksLikeEmail, ccListFor, repliedSinceSend,
  lastChasedAt, productSummary, daysBetween, captureState,
} from "./schema.js";

export const DEFAULT_NUDGE_AFTER_DAYS = 2;
export const DEFAULT_NUDGE_MAX_ROUNDS = 2;

// THE BACKSTOP, and the reason it exists. The day this is switched on, every
// order already sitting in Submitted becomes eligible at once, including ones
// that went out months ago and were settled by phone without anybody ticking
// Confirmed. Without a cut-off, flipping one switch in Settings would send a
// pile of "you never confirmed this" emails about orders that are long done.
export const DEFAULT_NUDGE_MAX_AGE_DAYS = 30;

/** Read the nudge settings, with every default applied. Never throws. */
export function nudgeSettings(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const num = (v, dflt, min) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= (min === undefined ? 1 : min) ? Math.round(n) : dflt;
  };
  return {
    // OFF until somebody turns it on. Nothing that emails another company
    // starts itself on deploy day.
    enabled: s.nudgeVendors === true,
    afterDays: num(s.nudgeAfterDays, DEFAULT_NUDGE_AFTER_DAYS),
    maxRounds: num(s.nudgeMaxRounds, DEFAULT_NUDGE_MAX_ROUNDS),
    maxAgeDays: num(s.nudgeMaxAgeDays, DEFAULT_NUDGE_MAX_AGE_DAYS),
    // Who it comes from. Ryan's decision: the owner's address, because the
    // same words carry differently over the owner's name than over an orders
    // mailbox. Falls back to the PO from-address so this can never send from
    // nothing.
    fromAddress: String(s.nudgeFromAddress || s.fromAddress || "").trim(),
    fromName: String(s.nudgeFromName || "").trim(),
  };
}

/**
 * Working days between two YYYY-MM-DD dates, counting the days AFTER `a` up
 * to and including `b`. Sat and Sun are not waiting.
 *
 * Bank holidays are not handled and deliberately so: a holiday list is a
 * thing somebody has to maintain, an out-of-date one makes this wrong in the
 * confusing direction, and the cost of being a day eager once or twice a year
 * is one polite email.
 */
export function businessDaysBetween(a, b) {
  if (!a || !b) return null;
  const start = new Date(`${String(a).slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${String(b).slice(0, 10)}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  if (end <= start) return 0;
  let days = 0;
  const cur = new Date(start.getTime());
  while (cur < end) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

/** Nudges sent since the CURRENT send. A re-send starts the count again. */
export function nudgeRoundSoFar(po) {
  const list = Array.isArray(po && po.nudges) ? po.nudges : [];
  const sent = po && po.lastSentAt ? String(po.lastSentAt) : "";
  return list.filter((n) => n && n.at && (!sent || String(n.at) > sent)).length;
}

/** When this order was last nudged by the app, or "". */
export function lastNudgeAt(po) {
  const list = Array.isArray(po && po.nudges) ? po.nudges : [];
  return list.reduce((acc, n) => (n && n.at && String(n.at) > acc ? String(n.at) : acc), "");
}

/**
 * Everyone who was on the original email.
 *
 * Read off the ORDER first (what actually went out), and only rebuilt from
 * settings when the order predates that being recorded. The two can genuinely
 * differ: the always-CC list or the account manager may have changed since,
 * and a follow-up that reaches a different set of people than the PO did is
 * confusing to everybody copied on either.
 */
export function nudgeRecipients(po, vendor, settings) {
  const clean = (list) => {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((raw) => {
      const v = String(raw || "").trim();
      if (!v || !looksLikeEmail(v)) return;
      const key = v.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(v);
    });
    return out;
  };

  const to = clean([po && po.sentTo ? po.sentTo : (vendor && vendor.email)]);
  const recorded = Array.isArray(po && po.sentCc) ? po.sentCc : null;
  const cc = clean(recorded || ccListFor(po, vendor, settings));

  // Nobody is CC'd twice by being in both fields.
  const toKeys = new Set(to.map((e) => e.toLowerCase()));
  return { to, cc: cc.filter((e) => !toKeys.has(e.toLowerCase())) };
}

/**
 * Should this one order be nudged right now?
 *
 * Returns { send, reason, round, to, cc } where `reason` explains a NO in
 * words. Pure: no reads, no writes, no clock of its own, so the whole rule is
 * testable and the dry run can show exactly what it would do.
 */
export function nudgePlan(po, vendor, settings, today) {
  const n = nudgeSettings(settings);
  const now = today || new Date().toISOString().slice(0, 10);
  const no = (reason) => ({ send: false, reason, round: 0, to: [], cc: [] });

  if (!n.enabled) return no("vendor reminders are switched off");
  if (!looksLikeEmail(n.fromAddress)) return no("no from-address is set for reminders");
  if (!po) return no("no order");
  if (isOutsourced(po)) return no("outsourced work, no purchase order was ever emailed");

  const stage = currentStage(po);
  // Submitted and nothing further. Anything past it has been answered one way
  // or another, and confirmedAt is exactly the thing being waited on.
  if (stage !== "submitted") return no(`nothing is outstanding: the order is at ${stage}`);
  if (po.confirmedAt) return no("already confirmed");

  if (!vendor) return no("the vendor on this order no longer exists");
  if (vendor.blacklisted === true) {
    // Sending to a blacklisted vendor takes an explicit yes from a person
    // every time, which a cron cannot give.
    return no("that vendor is blacklisted, so nothing is sent automatically");
  }

  const sentAt = po.lastSentAt ? String(po.lastSentAt).slice(0, 10) : "";
  if (!sentAt) return no("this order has not been emailed yet");

  const age = daysBetween(sentAt, now);
  if (age !== null && age > n.maxAgeDays) {
    return no(`the order was sent ${age} days ago, past the ${n.maxAgeDays} day cut-off`);
  }

  if (repliedSinceSend(po)) return no("the vendor has replied since we sent it");

  const round = nudgeRoundSoFar(po);
  if (round >= n.maxRounds) {
    return no(`already reminded ${round} time${round === 1 ? "" : "s"}, which is the limit`);
  }

  // A person who rang them on Tuesday has chased this order. Sending an
  // automatic "I have not heard from you" the next morning makes the shop
  // look like it is not talking to itself. lastChasedAt() covers both a
  // logged follow-up and a manual re-send.
  const chased = lastChasedAt(po);
  const nudged = lastNudgeAt(po);
  // The LATEST of the three, never an older one. A follow-up logged before a
  // re-send is history; counting from it would make the order eligible
  // sooner than the day it was last emailed, which is the wrong direction to
  // be wrong in when the output is mail to another company.
  const lastTouch = [String(chased || ""), String(nudged || "")]
    .filter((d) => d && d.slice(0, 10) >= sentAt)
    .sort()
    .pop();
  const since = lastTouch ? String(lastTouch).slice(0, 10) : sentAt;

  const waited = businessDaysBetween(since, now);
  if (waited === null) return no("could not read the dates on this order");
  if (waited < n.afterDays) {
    const what = lastTouch && lastTouch > sentAt ? "since it was last chased" : "since it went out";
    return no(`only ${waited} working day${waited === 1 ? "" : "s"} ${what}`);
  }

  const { to, cc } = nudgeRecipients(po, vendor, settings);
  if (!to.length) return no("there is no address on the order to write to");

  return { send: true, reason: "", round: round + 1, to, cc, waited };
}

/**
 * Every order to nudge this morning, plus the ones held back and why.
 *
 * `held` is not debug output. "Nothing went out today" and "four went out"
 * look the same from the outside, and the held list is what makes the run
 * readable when somebody asks why a particular vendor was not written to.
 * Only orders that are genuinely waiting on the vendor are reported as held;
 * an order at Received is not being withheld from anything.
 */
export function nudgeList(pos, vendors, settings, today) {
  const byId = new Map((Array.isArray(vendors) ? vendors : []).map((v) => [v.id, v]));
  const due = [];
  const held = [];

  (Array.isArray(pos) ? pos : []).forEach((po) => {
    const vendor = byId.get(po && po.vendorId) || null;
    const plan = nudgePlan(po, vendor, settings, today);
    const row = {
      poId: po && po.id,
      poNumber: (po && po.poNumber) || "draft",
      vendorName: vendor ? vendor.name : "unknown vendor",
      round: plan.round,
      to: plan.to,
      cc: plan.cc,
      reason: plan.reason,
    };
    if (plan.send) {
      due.push(row);
    } else if (currentStage(po) === "submitted" && !isOutsourced(po)) {
      held.push(row);
    }
  });

  due.sort((a, b) => String(a.poNumber).localeCompare(String(b.poNumber)));
  return { due, held };
}

/** The subject line. Round 2 says so rather than looking like a duplicate. */
export function nudgeSubject(po, settings, round) {
  const brand = (settings && settings.brandName) || "P&M Apparel";
  const number = (po && po.poNumber) || "";
  const lead = Number(round) > 1 ? "Second follow-up" : "Following up";
  return `${lead}: Purchase Order ${number} from ${brand}`;
}

/**
 * The message. Plain text on purpose: it is from a person, about one order,
 * and a laid-out HTML document would read as another automated notice rather
 * than as somebody asking a question.
 *
 * It never threatens anything. An automatic email cannot judge whether
 * pulling an order is the right answer, and one that says so on day four
 * would be doing it in the owner's name.
 */
export function nudgeText(po, vendor, settings, round, today) {
  const n = nudgeSettings(settings);
  const brand = (settings && settings.brandName) || "P&M Apparel";
  const signature = n.fromName || brand;
  const number = (po && po.poNumber) || "";
  const sentAt = po && po.lastSentAt ? String(po.lastSentAt).slice(0, 10) : "";
  const waited = businessDaysBetween(sentAt, today || new Date().toISOString().slice(0, 10));
  const product = productSummary(po);
  const due = (po && po.neededBy) || (po && po.printavo && po.printavo.dueDate) || "";

  const lines = [];
  lines.push(`Hi ${(vendor && vendor.name) || "there"},`);
  lines.push("");

  if (Number(round) > 1) {
    lines.push(
      `I wrote a few days ago about purchase order ${number}, which we sent on ${sentAt}, ` +
      "and I still have not seen a confirmation come back."
    );
  } else {
    lines.push(
      `We sent purchase order ${number} over on ${sentAt}` +
      (waited ? ` (${waited} working day${waited === 1 ? "" : "s"} ago)` : "") +
      " and I have not seen a confirmation come back yet."
    );
  }
  lines.push("");

  if (product.text) lines.push(`Order: ${product.text}`);
  if (due) lines.push(`Needed by: ${due}`);
  if (product.text || due) lines.push("");

  lines.push(
    "Can you confirm you have it and when it is due to ship? If anything on the order needs " +
    "sorting out, or it has already been confirmed and the message did not reach us, just reply " +
    "to this email and it will come straight back to us."
  );
  lines.push("");
  lines.push("Thanks,");
  lines.push(signature);
  lines.push(brand);
  if (settings && settings.brandPhone) lines.push(String(settings.brandPhone));

  return lines.join("\n");
}

/**
 * The whole message object handed to Resend.
 *
 * Reply-To is the per-PO capture address when capture is on, exactly as the
 * original send does. It matters more here than anywhere: the entire point is
 * to get the vendor to answer, and an answer that lands in one person's inbox
 * instead of on the order leaves the pipeline still showing silence. When
 * capture is off it goes to a person, never to the from-address only and
 * never to a no-reply.
 */
export function nudgeMessage(po, vendor, settings, round, today) {
  const n = nudgeSettings(settings);
  const brand = (settings && settings.brandName) || "P&M Apparel";
  const { to, cc } = nudgeRecipients(po, vendor, settings);
  const capture = captureState(po, settings);

  const msg = {
    from: `${n.fromName || brand} <${n.fromAddress}>`,
    to,
    subject: nudgeSubject(po, settings, round),
    text: nudgeText(po, vendor, settings, round, today),
    reply_to: capture.address || n.fromAddress,
  };
  if (cc.length) msg.cc = cc;
  return msg;
}

/** The history line a sent nudge leaves on the order. */
export function nudgeHistoryEntry(round, to, cc, at) {
  const who = [...(to || []), ...(cc || [])].join(", ");
  return {
    at: at || new Date().toISOString(),
    by: "promopro",
    kind: "nudge",
    what: `automatic reminder ${Number(round) || 1} sent to ${who}`,
  };
}
