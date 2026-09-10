// PUT IN: lib/user-grants.js (REPLACES the current one)
//
// lib/user-grants.js — access belongs to a person.
//
// ROLES ARE GONE (Sep 2026, Ryan's call). They were a grouping that stopped
// grouping: showing one person one extra thing meant inventing a role for
// them, so the Roles screen filled up with roles named after people. At
// sixteen accounts the grouping cost more than it saved.
//
// Every account now carries its own complete answer. There is no role to fall
// back to, no inheritance, nothing to keep in step. What is on somebody's
// account IS their access.
//
// TWO THINGS ARE STILL NOT A CHECKBOX, and must never become one:
//
//   1. ADMIN. The per-account Admin flag (`superuser`) is the only way to be
//      an administrator. It is not in this file, it is not in the access
//      record, and nothing here can set it. That is what keeps Settings
//      reachable if an access record is ever wrong.
//   2. THE CREWCORE CEILING. permsFor() caps anyone who is not an Admin at
//      CrewCore's self-serve views, AFTER resolving everything below. So
//      ticking CrewCore on an account never yields Roster or CrewCore
//      Settings. That trap cost a real incident in August and it is not
//      getting a second door.
//
// PURE, and it must stay that way: no imports at all. lib/users.js imports
// this, and apps/settings.js imports it straight into the browser.
//
// ESM. Do NOT convert to module.exports.

/**
 * The switches an account carries, and how each reads when nothing is stored.
 *
 * "optout" is true unless the record says false (can_edit).
 * "optin"  is false unless the record says true (manage_lists).
 *
 * The distinction still matters with roles gone: a record written before a
 * flag existed must not silently gain the thing that flag controls.
 */
export const GRANT_FLAGS = [
  { key: "can_edit", label: "Can edit", mode: "optout" },
  { key: "can_export", label: "Can export", mode: "optout" },
  { key: "can_delete_notifications", label: "Can delete notifications", mode: "optout" },
  { key: "manage_lists", label: "Manage ErrorEngine lists", mode: "optin" },
  { key: "can_decide_giving", label: "Can approve donations", mode: "optin" },
];

const FLAG_KEYS = GRANT_FLAGS.map((f) => f.key);

/** Everything an access record may hold. */
export const ACCESS_KEYS = ["apps", "views", "data_scope"].concat(FLAG_KEYS);

/**
 * A brand new account starts with nothing. Not BackBone, not read-only
 * anything.
 *
 * Deliberate: with no role to inherit, a default would be a guess at what
 * somebody should see, applied silently at the moment nobody is looking. An
 * account that signs in to an empty rail is a visible problem you fix in ten
 * seconds. An account quietly holding access nobody chose is the other kind.
 */
export function emptyAccess() {
  return { apps: [], views: {}, data_scope: "all" };
}

function cleanList(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((a) => String(a || "").trim())
    .filter((a) => {
      if (!a || seen.has(a)) return false;
      seen.add(a);
      return true;
    });
}

/**
 * Clean an access record arriving from a browser or out of storage.
 *
 * Unknown keys are dropped rather than stored: a typo'd key would sit there
 * looking like a setting and do nothing forever.
 *
 * `views` maps an app id to the views that app is narrowed to. An app absent
 * from the map, or present with an empty list, means every view. That is the
 * right default because the alternative, an app you granted showing no
 * screens, reads as broken rather than restricted.
 */
export function normalizeAccess(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return emptyAccess();
  const out = emptyAccess();

  // App-level only. A "<app>:<view>" entry here would land on the tab list
  // and skip every ceiling, because the ceilings filter the per-view list and
  // this is not it. Scoping goes in `views`.
  out.apps = cleanList(input.apps).filter((a) => a.indexOf(":") === -1);

  out.views = {};
  if (input.views && typeof input.views === "object" && !Array.isArray(input.views)) {
    Object.keys(input.views).forEach((appId) => {
      const app = String(appId || "").trim();
      if (!app || app.indexOf(":") !== -1) return;
      // A narrowing on an app this person cannot open is dead weight, and it
      // would come back to life if the app were ever re-ticked. Dropped.
      if (out.apps.indexOf(app) === -1) return;
      const views = cleanList(input.views[appId]).map((v) =>
        v.indexOf(":") === -1 ? v : v.slice(v.indexOf(":") + 1)
      );
      if (views.length) out.views[app] = views;
    });
  }

  out.data_scope = input.data_scope === "own" ? "own" : "all";

  FLAG_KEYS.forEach((key) => {
    if (input[key] === true || input[key] === false) out[key] = input[key];
  });

  return out;
}

function flagValue(mode, value) {
  if (value === true || value === false) return value;
  return mode === "optout";
}

/**
 * Fill in every flag so callers never have to remember which way a missing
 * value reads. Returns a complete object, safe to hand to a screen.
 */
export function resolveAccess(record) {
  const a = normalizeAccess(record);
  const out = { apps: a.apps.slice(), views: a.views, data_scope: a.data_scope };
  GRANT_FLAGS.forEach(({ key, mode }) => { out[key] = flagValue(mode, a[key]); });
  return out;
}

/**
 * The tab list the shell reads: app ids for app-level access, plus
 * "<app>:<view>" entries for any app that has been narrowed.
 *
 * allowedViews() treats an app id with no scoped entries as every view, so an
 * unnarrowed app needs nothing beyond its id.
 */
export function tabsFor(access) {
  const a = resolveAccess(access);
  const out = a.apps.slice();
  Object.keys(a.views || {}).forEach((appId) => {
    (a.views[appId] || []).forEach((view) => { out.push(appId + ":" + view); });
  });
  return out;
}

/**
 * Shaped like the old role object.
 *
 * A dozen routes ask their questions of something role-shaped
 * (lib/giving-access.js and friends). Handing them the resolved access means
 * none of them had to learn that roles are gone, and none of them can
 * disagree with permsFor about the answer.
 */
export function asRole(access) {
  const a = resolveAccess(access);
  return {
    name: "account",
    label: "Account access",
    apps: a.apps,
    data_scope: a.data_scope,
    can_edit: a.can_edit,
    can_export: a.can_export,
    manage_lists: a.manage_lists,
    can_delete_notifications: a.can_delete_notifications,
    can_decide_giving: a.can_decide_giving,
  };
}

/**
 * Turn an old role into an access record, for the one-time migration.
 *
 * The old roles carried scoped "<app>:<view>" entries in `tabs`; they become
 * the `views` map, so the employee role's Stitch Guess narrowing survives
 * rather than quietly widening to the whole app on migration day.
 *
 * `existingGrants` is the per-account override shipped earlier in September.
 * It beat the role before this migration, so it still does.
 */
export function accessFromRole(role, existingGrants) {
  const r = role && typeof role === "object" ? role : {};
  const draft = {
    apps: Array.isArray(r.apps) ? r.apps.slice() : [],
    data_scope: r.data_scope === "own" ? "own" : "all",
    views: {},
  };
  FLAG_KEYS.forEach((key) => {
    if (r[key] === true || r[key] === false) draft[key] = r[key];
  });

  (Array.isArray(r.tabs) ? r.tabs : []).forEach((entry) => {
    const raw = String(entry || "");
    const at = raw.indexOf(":");
    if (at === -1) return;
    const app = raw.slice(0, at);
    const view = raw.slice(at + 1);
    if (!app || !view) return;
    if (!draft.views[app]) draft.views[app] = [];
    draft.views[app].push(view);
  });

  const g = existingGrants && typeof existingGrants === "object" ? existingGrants : {};
  if (Array.isArray(g.apps)) {
    draft.apps = g.apps.slice();
    Object.keys(draft.views).forEach((app) => {
      if (draft.apps.indexOf(app) === -1) delete draft.views[app];
    });
  }
  if (g.data_scope === "own" || g.data_scope === "all") draft.data_scope = g.data_scope;
  FLAG_KEYS.forEach((key) => {
    if (g[key] === true || g[key] === false) draft[key] = g[key];
  });

  return normalizeAccess(draft);
}

/**
 * A short human list of what an account can open, for the Accounts table.
 */
export function accessSummary(access, appNameFor) {
  const a = resolveAccess(access);
  const name = typeof appNameFor === "function" ? appNameFor : (id) => id;
  if (!a.apps.length) return [];
  return a.apps.map((id) => {
    const views = a.views[id];
    return name(id) + (views && views.length ? " (" + views.length + " views)" : "");
  });
}
