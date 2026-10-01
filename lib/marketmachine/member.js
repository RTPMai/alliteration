// PUT IN: lib/marketmachine/member.js
//
// lib/marketmachine/member.js — what an Account Manager can do in
// MarketMachine (Oct 1 2026).
//
// Email moved into MarketMachine, so the people who send email need the
// campaign pages, not just My tasks. Ryan's call: ACCOUNT MANAGERS READ EVERY
// CAMPAIGN AND CHANGE ONLY THEIR OWN. Nobody but an Admin sees money.
//
// Three tiers, decided on the server every request:
//   admin   the platform Admin flag, or Campaigns ticked on the account
//           (isMarketMachineAdmin in access.js, unchanged: Jacob keeps it).
//   member  MarketMachine on the account, nothing more. This file.
//   other   signed in, no MarketMachine: names and ids only, as before.
//
// "Their own" is the same rule My tasks already used (isMine in campaign.js):
// listed as an Account Manager on it, or the person who created it.
//
// Pure, no storage. ESM. Do NOT convert to module.exports.

/** Has MarketMachine on the account at all (perms from permsFor). */
export function isMember(perms) {
  if (!perms) return false;
  if (perms.superuser === true) return true;
  const tabs = Array.isArray(perms.tabs) ? perms.tabs : [];
  return tabs.includes("marketmachine");
}

// Money on a campaign record. A budget, and the calculator's inputs and the
// scorecard, which are built from it.
const MONEY_FIELDS = ["budget", "calc", "scorecard"];

/** A campaign as a member may read it: everything but the money. */
export function withoutMoney(campaign) {
  if (!campaign || typeof campaign !== "object") return campaign;
  const out = { ...campaign };
  MONEY_FIELDS.forEach((k) => { delete out[k]; });
  return out;
}

/**
 * Connections as a member may read them. Trip spend is campaign money too, so
 * the dollar figures go and the trips themselves (who, where, when) stay.
 */
export function connectionsWithoutMoney(conn) {
  if (!conn || typeof conn !== "object") return conn;
  const out = { ...conn };
  if (out.travel && typeof out.travel === "object") {
    const t = { ...out.travel };
    ["total", "pending", "approved", "reimbursed"].forEach((k) => { delete t[k]; });
    if (Array.isArray(t.trips)) {
      t.trips = t.trips.map((trip) => {
        const x = { ...trip };
        ["total", "pending", "approved", "reimbursed", "expenses"].forEach((k) => { delete x[k]; });
        return x;
      });
    }
    t.moneyHidden = true;
    out.travel = t;
  }
  return out;
}

const NOT_YOURS = "You can change campaigns you are on. Ask one of its Account Managers or an Admin.";

/**
 * May a member make this write? Returns { ok: true, body } with anything they
 * may not set removed, or { ok: false, status, error }.
 *
 *   method, q      the request
 *   body           the parsed body
 *   campaign       the stored campaign (null for a create)
 *   mine           isMine(campaign, ...) for this person
 *   me             { id, name }: their CrewCore employee record, or null
 */
export function memberWrite({ method, q, body, campaign, mine, me }) {
  const employeeId = me && me.id ? String(me.id) : null;
  const query = q || {};
  const b = body && typeof body === "object" ? { ...body } : {};

  if (method === "DELETE") return { ok: false, status: 403, error: "Only an Admin can delete a campaign." };

  if (method === "POST" && !query.art) {
    if (query.demo) return { ok: false, status: 403, error: "Only an Admin can load the demo campaigns." };
    // A member's new campaign always has them on it, so it is theirs to run.
    // Without an employee record there is nobody to put on it.
    if (!employeeId) {
      return { ok: false, status: 403, error: "Your account is not set up as an Account Manager yet, so a campaign cannot be put in your name. Ask an Admin to link your account to your CrewCore record." };
    }
    delete b.budget;
    // Stored as { id, name } pairs, the shape the AM picker sends.
    const ams = (Array.isArray(b.accountManagers) ? b.accountManagers : [])
      .filter((a) => a && typeof a === "object");
    if (!ams.some((a) => a.id != null && String(a.id) === employeeId)) {
      ams.unshift({ id: employeeId, name: (me && me.name) || "" });
    }
    b.accountManagers = ams;
    delete b.accountManagerId;
    delete b.accountManagerName;
    return { ok: true, body: b };
  }

  if (!campaign) return { ok: false, status: 404, error: "Campaign not found" };
  if (!mine) return { ok: false, status: 403, error: NOT_YOURS };

  if (method === "POST" && query.art) return { ok: true, body: b };

  if (method === "PATCH") {
    if (query.calc || query.scorecard) {
      return { ok: false, status: 403, error: "Only an Admin can change a campaign's numbers." };
    }
    if (query.step) {
      const step = (campaign.steps || []).find((s) => s.key === String(query.step));
      if (step && step.approval) {
        return { ok: false, status: 403, error: "That is an approval. Ryan or Megan signs off on it." };
      }
      return { ok: true, body: b };
    }
    if (query.connect) return { ok: true, body: b };
    // Header edits: everything but the budget, which is dropped rather than
    // refused so the rest of an edit still saves.
    delete b.budget;
    return { ok: true, body: b };
  }

  return { ok: false, status: 405, error: "Method not allowed" };
}
