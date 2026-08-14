// api/crewcore/clock.js — PUBLIC BY DESIGN. No-login time clock for CrewCore.
//
// Serves clock.html, the shop-floor kiosk. Nobody signs into the shell to
// punch: most of production does not have an Alliteration account, and the
// system this replaced never asked for one either.
//
// This is a DELIBERATELY NARROW surface, the same way api/scan-status.js is:
//
//   GET  ?roster=1   -> [{ id, name, department }] and nothing else. No pay
//                       rate, no phone, no email, no start date, no review
//                       history. Active employees with the clock switched on
//                       and a passcode set, so the list is exactly the people
//                       who can actually punch.
//   POST action=status -> requires the passcode. Says whether that ONE person
//                       is on the clock and since when.
//   POST action=in|out -> requires the passcode. Opens or closes a shift.
//
// There is no read of anyone else's hours, no write to any other field, and
// no way to reach the rest of CrewCore from here. Everything on the back
// side goes through api/crewcore/timecards.js, which requires a session.
//
// TRADE-OFF, ON THE RECORD. The roster names are readable by anyone who
// loads the page. That is the cost of a dropdown people can use with gloves
// on, and it is the same call Ryan already made for the QR scan endpoint.
// If that ever needs tightening, set a kiosk token in CrewCore Settings:
// the page then requires ?k=<token> and the name list goes with it. The
// passcode is the real gate either way.
//
// BUDDY PUNCHING is not solved here, and no software gate on a shared
// tablet solves it. Weak passcodes are refused (see validatePin), every
// punch records its source, and the back side shows who punched when. That
// is the honest limit of a kiosk.
//
// ESM handler.

import { isRateLimited, resetKey } from "../../lib/rate-limit.js";
import { verifyPassword } from "../../lib/users.js";
import { listEmployees, getEmployee, getSettings } from "../../lib/crewcore/store.js";
import { localParts, SHOP_TIMEZONE } from "../../lib/crewcore/timeclock.js";
import { clockIn, clockOut, getOpenShift } from "../../lib/crewcore/timeclock-store.js";

// Generous on purpose. A shift change puts a dozen people through this in
// two minutes, and a whole shop punching out at once should never trip it.
const ROSTER_MAX_PER_IP = 400;
const PUNCH_MAX_PER_IP = 300;
const IP_WINDOW_SECONDS = 60 * 60;

// The one that actually matters: wrong passcodes against a single employee.
// Five wrong tries in fifteen minutes locks that NAME out, not the kiosk, so
// one person guessing at Margo's code cannot stop anyone else from punching.
const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_SECONDS = 15 * 60;

function clientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

/** Friendly wall-clock string for the confirmation screen: "7:02 AM". */
function friendlyTime(iso, tz) {
  const lp = localParts(iso, tz);
  if (!lp) return "";
  let h = lp.hour;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(lp.minute).padStart(2, "0")} ${ampm}`;
}

function tokenOk(settings, req) {
  const want = String(settings.clock_kiosk_token || "").trim();
  if (!want) return true;
  const got = String((req.query && (req.query.k || req.query.token)) || "").trim();
  return got === want;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const ip = clientIp(req);

  try {
    const settings = await getSettings();

    if (settings.clock_enabled === false) {
      return res.status(503).json({ error: "The time clock is switched off. See a manager." });
    }
    if (!tokenOk(settings, req)) {
      return res.status(403).json({ error: "This kiosk link is not valid. See a manager." });
    }

    const tz = SHOP_TIMEZONE;
    const weekStartDay = Number(settings.week_start_day) || 0;

    /* ---- the name list ---------------------------------------------- */

    if (req.method === "GET") {
      if (await isRateLimited(`clock:roster:${ip}`, ROSTER_MAX_PER_IP, IP_WINDOW_SECONDS)) {
        return res.status(429).json({ error: "Too many requests. Try again shortly." });
      }
      const all = await listEmployees();
      const roster = all
        .filter((e) => e.status === "active" && e.clock_enabled !== false && e.clock_pin_hash)
        .map((e) => ({ id: e.id, name: e.name, department: e.department || "" }));
      return res.status(200).json({ roster, count: roster.length });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    /* ---- punching ---------------------------------------------------- */

    if (await isRateLimited(`clock:punch:${ip}`, PUNCH_MAX_PER_IP, IP_WINDOW_SECONDS)) {
      return res.status(429).json({ error: "Too many requests. Try again shortly." });
    }

    const body = parseBody(req);
    const employeeId = String(body.employee_id || "").trim();
    const pin = String(body.pin || "").trim();
    const action = String(body.action || "").trim();

    if (!employeeId || !pin) {
      return res.status(400).json({ error: "Pick your name and enter your passcode." });
    }
    if (!["in", "out", "status"].includes(action)) {
      return res.status(400).json({ error: "Unknown action" });
    }

    const attemptKey = `clock:pin:${employeeId}`;
    if (await isRateLimited(attemptKey, PIN_MAX_ATTEMPTS, PIN_WINDOW_SECONDS)) {
      return res.status(429).json({
        error: "Too many wrong passcodes for this name. Wait 15 minutes or see a manager.",
      });
    }

    const emp = await getEmployee(employeeId);

    // One generic message whether the name is unknown, switched off, or the
    // passcode is wrong. Splitting them would turn the kiosk into a way to
    // confirm which codes are close.
    const deny = () => res.status(401).json({ error: "That passcode doesn't match. Try again." });

    if (!emp || emp.status !== "active" || emp.clock_enabled === false || !emp.clock_pin_hash) {
      return deny();
    }
    const good = await verifyPassword(pin, emp.clock_pin_hash);
    if (!good) return deny();

    // Right code. Clear the counter so a couple of fat-fingered tries before
    // the correct one do not count against them later in the window.
    await resetKey(attemptKey);

    const openBefore = await getOpenShift(employeeId);

    if (action === "status") {
      return res.status(200).json({
        ok: true,
        name: emp.name,
        clocked_in: !!openBefore,
        since: openBefore ? friendlyTime(openBefore.in_at, tz) : null,
      });
    }

    const at = new Date().toISOString();

    if (action === "in") {
      const result = await clockIn(employeeId, { at, weekStartDay, timezone: tz, source: "kiosk" });
      if (!result.ok && result.reason === "already_in") {
        return res.status(409).json({
          error: `You're already clocked in since ${friendlyTime(result.shift.in_at, tz)}. Tap Clock Out instead.`,
          clocked_in: true,
          since: friendlyTime(result.shift.in_at, tz),
        });
      }
      return res.status(200).json({
        ok: true,
        action: "in",
        name: emp.name,
        at: friendlyTime(result.shift.in_at, tz),
        // Surfaced so the person sees that yesterday's forgotten punch was
        // noticed, rather than finding out on a short paycheck.
        note: result.closed_stale
          ? "Heads up: you never clocked out last time. A manager will fix that shift."
          : null,
      });
    }

    // action === "out"
    const result = await clockOut(employeeId, { at });
    if (!result.ok) {
      return res.status(409).json({
        error: "You're not clocked in right now. Tap Clock In instead.",
        clocked_in: false,
      });
    }

    const ms = new Date(result.shift.out_at).getTime() - new Date(result.shift.in_at).getTime();
    const hrs = Math.floor(ms / 3600000);
    const mins = Math.round((ms % 3600000) / 60000);

    return res.status(200).json({
      ok: true,
      action: "out",
      name: emp.name,
      at: friendlyTime(result.shift.out_at, tz),
      worked: `${hrs}h ${mins}m`,
    });
  } catch (e) {
    console.error("[clock]", e);
    return res.status(500).json({ error: "Something went wrong. Try again, or see a manager." });
  }
}
