// lib/help/access.js — the app ids the help bot knows about, server-side.
//
// Server code must not import js/registry.js, which is browser code, so this
// list is hand-synced with it. Same arrangement as APP_IDS in
// api/notifications.js, and the same hazard: api/notifications.js's list went
// stale twice (promopro and stitchsense were both missing after they shipped)
// and nothing noticed, because a hand-synced list has no way to complain.
//
// The difference here is that test/help.test.cjs imports BOTH this file and
// the registry and compares them as data, so a new app that never gets added
// here turns the suite red instead of quietly becoming a subject the help bot
// refuses to discuss.
//
// Includes the two shell screens (notifications, settings) and the Site Work
// screen, because people ask about those as readily as about the apps.
//
// ESM. Do NOT convert to module.exports.

export const APP_ACCESS_IDS = [
  "backbone", "shopstock", "errorengine", "givinggauge", "traveltrack",
  "promopro", "crewcore", "mailme", "marketmachine", "teletally",
  "websitewidget", "stitchsense",
  "notifications", "settings", "stickies",
];
