// lib/concontrol/intake.js — is this public POST coming from our own site?
//
// WHY THIS EXISTS. The event site does not submit from the browser. Its own
// serverless function at flyovercon.ink/api/sponsor takes the form, writes the
// Google Sheet, and forwards to us server to server. Which means EVERY
// submission arrives from one Vercel egress address, and the per-IP rate limit
// that protects a public endpoint would cap the whole event at ten sponsor
// inquiries an hour rather than capping one abuser.
//
// So a caller that can prove it is the site gets a much higher ceiling. It is
// NOT a login and it does not unlock anything: an authorised call can still
// only create an inquiry, still cannot set money, status or deliverables, and
// is still counted. The secret buys a bigger bucket, nothing else.
//
// FAILS CLOSED ON A MISSING SECRET. safeEqual confirms the env var is actually
// set before comparing, because `undefined !== undefined` is the trap that has
// bitten this repo before: without the check, a deploy that forgot the variable
// would treat every caller on earth as the site.
//
// ESM. Do NOT convert to module.exports.

import { safeEqual } from "../session.js";

export function isOwnSite(req) {
  const expected = process.env.CONCONTROL_INTAKE_SECRET;
  if (!expected) return false;
  const sent = (req && req.headers && req.headers["x-intake-secret"]) || "";
  if (!sent) return false;
  return safeEqual(sent, expected);
}

/**
 * The rate limit for this caller. A browser gets the tight public number; our
 * own site gets a ceiling high enough that a real day never touches it and a
 * runaway loop still does.
 */
export function intakeLimit(req) {
  return isOwnSite(req)
    ? { key: "site", max: 300, windowSeconds: 60 * 60 }
    : { key: null, max: 10, windowSeconds: 60 * 60 };
}
