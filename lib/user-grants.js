// PUT IN: lib/user-grants.js
//
// lib/user-grants.js — the role is a starting point, the account can differ.
//
// WHY THIS EXISTS
// Until Sept 2026 a person's access was entirely their role. Giving one
// person one extra thing meant inventing a role for them, so the Roles screen
// filled up with roles named after people ("Alexis") that described a person
// rather than a job. That is not a naming problem, it is the model being one
// level short.
//
// So an account may now carry its own grants, and they win over the role's.
// The role stays as the sensible default and the thing you change when a
// whole job changes: ticking a new app onto Account Manager still reaches
// four people at once.
//
// ABSENT MEANS INHERIT, NOT DENY.
// Only keys actually PRESENT on the account override. An account with no
// grants object behaves exactly as it did before this file existed, which is
// what makes this safe to deploy against sixteen live accounts. `false` is a
// real answer and overrides; undefined is not an answer at all.
//
// CEILINGS ARE NOT NEGOTIABLE HERE.
// This file resolves what somebody ASKED for. It does not decide what they
// are allowed to be handed. permsFor() applies the CrewCore self-serve
// ceiling and the time-clock strip AFTER calling resolve(), so a per-account
// grant can never become a new way to hand somebody CrewCore's Roster. Being
// a CrewCore admin is still the Admin flag or the protected admin role, and
// no checkbox anywhere can do it. That is the CrewCore trap and it is not
// getting a second door.
//
// PURE, and it must stay that way: no imports at all. lib/users.js imports
// this, and apps/settings.js imports it straight into the browser.
//
// ESM. Do NOT convert to module.exports.

/**
 * The switches an account may override, and how each one reads when nobody
 * has said anything.
 *
 * "optout" means true unless somebody explicitly says false (can_edit).
 * "optin"  means false unless somebody explicitly says true (manage_lists).
 *
 * The distinction is not cosmetic: it is what stops a role stored before a
 * flag existed from silently gaining the thing that flag controls.
 */
export const GRANT_FLAGS = [
  { key: "can_edit", label: "Can edit", mode: "optout" },
  { key: "can_export", label: "Can export", mode: "optout" },
  { key: "can_delete_notifications", label: "Can delete notifications", mode: "optout" },
  { key: "manage_lists", label: "Manage ErrorEngine lists", mode: "optin" },
  { key: "can_decide_giving", label: "Can approve donations", mode: "optin" },
];

const FLAG_KEYS = GRANT_FLAGS.map((f) => f.key);

/** Every field an account may carry an answer for. */
export const GRANT_KEYS = ["apps", "data_scope"].concat(FLAG_KEYS);

/**
 * Clean a grants object arriving from a browser.
 *
 * Unknown keys are dropped rather than stored: a typo'd key would sit in
 * storage looking like a setting and do nothing forever. Anything not
 * mentioned stays absent, which is how "inherit" is spelled.
 *
 * Returns null when nothing survives, so an account that has been reset to
 * its role stores no grants object at all rather than an empty one.
 */
export function normalizeGrants(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out = {};

  if (Array.isArray(input.apps)) {
    const seen = new Set();
    out.apps = input.apps
      .map((a) => String(a || "").trim())
      .filter((a) => {
        if (!a || seen.has(a)) return false;
        seen.add(a);
        return true;
      });
  }

  if (input.data_scope === "own" || input.data_scope === "all") {
    out.data_scope = input.data_scope;
  }

  FLAG_KEYS.forEach((key) => {
    if (input[key] === true || input[key] === false) out[key] = input[key];
  });

  return Object.keys(out).length ? out : null;
}

/** Has anybody actually set anything on this account? */
export function hasOverrides(grants) {
  return !!(normalizeGrants(grants) && Object.keys(normalizeGrants(grants)).length);
}

function flagValue(mode, value) {
  if (value === true || value === false) return value;
  return mode === "optout";
}

/**
 * Work out what this person actually gets.
 *
 * Returns { apps, data_scope, <each flag>, sources }.
 *
 * `sources` says where each answer came from, "account" or "role", and it is
 * the whole reason this returns a report rather than just values. "Why can
 * she see that" needs one place to look, and a screen that shows the answer
 * without showing where it came from is how you end up with a role per
 * person all over again.
 */
export function resolveGrants(role, grants) {
  const r = role && typeof role === "object" ? role : {};
  const g = normalizeGrants(grants) || {};
  const sources = {};

  const roleApps = Array.isArray(r.apps) ? r.apps.slice() : [];
  const apps = Array.isArray(g.apps) ? g.apps.slice() : roleApps;
  sources.apps = Array.isArray(g.apps) ? "account" : "role";

  const data_scope = g.data_scope || r.data_scope || "all";
  sources.data_scope = g.data_scope ? "account" : "role";

  const out = { apps, data_scope, sources };
  GRANT_FLAGS.forEach(({ key, mode }) => {
    const fromAccount = g[key] === true || g[key] === false;
    out[key] = fromAccount ? g[key] : flagValue(mode, r[key]);
    sources[key] = fromAccount ? "account" : "role";
  });

  return out;
}

/**
 * The resolved answer shaped like a role object.
 *
 * lib/giving-access.js asks its questions of a role. Handing it the resolved
 * values means the three GivingGauge answers follow a per-account override
 * for free, and that file keeps its promise of importing nothing and knowing
 * nothing about accounts.
 */
export function asRole(resolved, role) {
  const base = role && typeof role === "object" ? role : {};
  const out = { ...base };
  out.apps = resolved.apps;
  out.data_scope = resolved.data_scope;
  GRANT_FLAGS.forEach(({ key }) => { out[key] = resolved[key]; });
  return out;
}

/**
 * A short human list of what differs from the role, for the Accounts screen.
 * Empty array means this account is exactly its role.
 */
export function overrideSummary(resolved) {
  if (!resolved || !resolved.sources) return [];
  const out = [];
  if (resolved.sources.apps === "account") out.push("apps");
  if (resolved.sources.data_scope === "account") {
    out.push(resolved.data_scope === "own" ? "own accounts only" : "all accounts");
  }
  GRANT_FLAGS.forEach(({ key, label }) => {
    if (resolved.sources[key] !== "account") return;
    out.push((resolved[key] ? "" : "no ") + label.toLowerCase());
  });
  return out;
}
