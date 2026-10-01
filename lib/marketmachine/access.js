// PUT IN: lib/marketmachine/access.js
//
// lib/marketmachine/access.js — who gets the whole of MarketMachine.
//
// Sept 2026. Two people need everything: Ryan, and Jacob, who wrote the
// campaign masters and reviews the work against them. Ryan has the Admin flag
// already. Jacob should not: the Admin flag is platform-wide and would hand
// him pay, reviews and the accounts screen along with it.
//
// So full MarketMachine is its own grant, ticked per account in Settings:
// tick the Campaigns screen for somebody and they get the whole app, the same
// as an Admin does inside MarketMachine and nowhere else.
//
// WHY CAMPAIGNS IS THE SWITCH rather than a separate checkbox: the campaign
// page is where the whole app lives. Somebody who can open a campaign can see
// its budget, its connections, its numbers and its history, so pretending
// Campaigns is a smaller grant than "the whole app" would be a lie the screens
// could not keep.
//
// MY TASKS IS THE DEFAULT. An account with MarketMachine ticked and nothing
// narrowed gets My tasks only. That is deliberate and is the opposite of how
// the other apps behave: everywhere else, no narrowing means every screen.
// CrewCore learned this the hard way in August, when an office account was
// handed the whole team's roster by a role that simply had the app ticked.
//
// Pure, and importable from the browser: js/registry.js and apps/settings.js
// read the same rule the server enforces.
//
// ESM. Do NOT convert to module.exports.

/**
 * The view that carries the whole app with it.
 *
 * SETTINGS SINCE OCT 1 2026 (was Campaigns). Campaigns became part of every
 * Account Manager's default screens, so Settings, Accounts shows it ticked for
 * all of them, and saving any of those accounts would have stored the tick and
 * made that person a full Admin. Settings is the screen only an Admin of the
 * app ever had, so ticking it is an unmistakable "full access". Jacob's
 * account already has it ticked.
 */
export const FULL_ACCESS_VIEW = "settings";

/**
 * What an ordinary grant gets. Was My tasks alone until Oct 1 2026, when
 * email moved into MarketMachine and Ryan opened campaigns to the Account
 * Managers: they read every campaign and change their own, never the money
 * (lib/marketmachine/member.js). Settings stays Admin only. The Email screen
 * comes with the MailMe grant (permsFor in lib/users.js).
 */
export const SELF_SERVE_VIEWS = ["tasks", "campaigns", "calendar"];

/**
 * The MarketMachine views recorded on an account, whatever shape the caller
 * has the account in: a resolved access object, a raw user record, or a
 * perms.tabs list of "marketmachine:<view>" strings.
 */
export function grantedViews(source) {
  const s = source || {};
  if (Array.isArray(s.tabs)) {
    return s.tabs.filter((t) => typeof t === "string" && t.startsWith("marketmachine:"))
      .map((t) => t.slice("marketmachine:".length));
  }
  const access = s.access || s;
  const views = (access && access.views && access.views.marketmachine) || [];
  return Array.isArray(views) ? views.slice() : [];
}

/**
 * Does this person get the whole app? The platform Admin flag, or the
 * Campaigns grant on their account. Nothing else, ever: a role checkbox could
 * not do it before roles were removed and no new one should be able to.
 *
 * PASS THE STORED ACCOUNT, NOT perms (Oct 1 2026). Since Campaigns became
 * part of everybody's default screens, perms.tabs carries
 * "marketmachine:campaigns" for every Account Manager, and reading it here
 * would make all of them Admins. Only the ticks stored on the account count,
 * so a tabs-shaped argument is answered from the Admin flag alone.
 */
export function isMarketMachineAdmin(source) {
  const s = source || {};
  if (s.superuser === true) return true;
  if (Array.isArray(s.tabs)) return false;
  return grantedViews(s).includes(FULL_ACCESS_VIEW);
}
