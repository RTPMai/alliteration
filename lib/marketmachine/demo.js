// PUT IN: lib/marketmachine/demo.js
//
// lib/marketmachine/demo.js — example campaigns, for showing the app to
// somebody before real work goes in it.
//
// Sept 2026, so Jacob can look the build over against his masters without
// anybody typing a campaign first.
//
// THREE RULES, because the last set of sample campaigns took three drops to
// get rid of:
//   1. Every example is marked `demo: true` on the record, and its name starts
//      with EXAMPLE so it is obvious on any screen and in anybody's task list.
//   2. Removing them deletes exactly the records carrying that flag. Nothing
//      matches on the name, because a real campaign somebody names "Example
//      mailer" is not ours to delete.
//   3. They are built through the same rules as a real campaign: the same
//      checklist from the catalog, the same locks, the same date maths. An
//      example that skipped the rules would show Jacob something the app
//      cannot actually do.
//
// Nothing here touches TravelTrack, BackBone, MailMe or Printavo. Examples
// never invent a trip, a lead, an email or an invoice in another app.
//
// Pure: it returns records, the store writes them.
//
// ESM. Do NOT convert to module.exports.

import { buildCampaign } from "./campaign.js";
import { addDays, todayCentral } from "./dates.js";

export const DEMO_PREFIX = "EXAMPLE";

/** Mark a set of steps done, in order, as if the work had really happened. */
function complete(campaign, keys, day) {
  keys.forEach((key, i) => {
    const step = campaign.steps.find((s) => s.key === key);
    if (!step) return;
    step.done = true;
    step.doneAt = addDays(day, -(keys.length - i) * 3);
    step.doneBy = "Example data";
    if (step.approval) step.approvedBy = "Example data";
  });
}

function skip(campaign, keys) {
  keys.forEach((key) => {
    const step = campaign.steps.find((s) => s.key === key);
    if (step && step.na) step.notApplicable = true;
  });
}

function note(campaign, key, text) {
  const step = campaign.steps.find((s) => s.key === key);
  if (step) step.notes = text;
}

function blocker(campaign, key, text) {
  const step = campaign.steps.find((s) => s.key === key);
  if (step) step.blocked = text;
}

function numbers(campaign, values, source) {
  const inputs = {};
  Object.entries(values).forEach(([key, value]) => {
    inputs[key] = { value, source: source || "Example data", by: "Example data", at: new Date().toISOString() };
  });
  campaign.calc = { inputs };
}

function scorecard(campaign, rows) {
  const card = {};
  Object.entries(rows).forEach(([key, row]) => {
    card[key] = { ...row, by: "Example data", at: new Date().toISOString() };
  });
  campaign.scorecard = card;
}

/**
 * Five examples, chosen to show the whole shape of the app in one sitting:
 * an event with campaigns underneath it, a campaign mid-build, one with a
 * blocker, one finished with its numbers filled in, and one carrying a
 * warning.
 *
 * `session` is whoever pressed the button, so the history reads truthfully:
 * they did load these.
 */
export function demoCampaigns(session, today) {
  const day = today || todayCentral();
  const make = (body, parent) => {
    const record = buildCampaign({ ...body, name: `${DEMO_PREFIX}: ${body.name}` }, session, parent);
    record.demo = true;
    // Nothing has an id until the store writes it, so a connected example
    // points at its parent by name and the store swaps in the real id.
    if (parent) record.parentId = parent.name;
    record.history = [{ at: new Date().toISOString(), by: (session && (session.name || session.username)) || null,
      what: "Loaded as an example campaign" }];
    return record;
  };

  // 1. A trade show four weeks out, planning done, materials in progress.
  const show = make({
    type: "trade_show",
    name: "ISS Long Beach 2027",
    controlDate: addDays(day, 28),
    audienceKind: "public",
    audience: "Decorators and shop owners at the show",
    participation: "exhibitor",
    budget: 14500,
    notes: "Example campaign. Delete it from Settings when you are finished looking.",
  });
  complete(show, ["ts_identity", "ts_participation", "ts_budget", "ts_staff", "ts_registration", "ts_travel"], day);
  note(show, "ts_targets", "Example: eight target companies picked, meetings requested with four.");
  blocker(show, "ts_invoices", "Booth signage quote still coming back from the vendor");
  skip(show, ["ts_connected"]);
  numbers(show, { qualifiedContactsEstimate: 60, conversionRate: 15, averageOrderValue: 1850,
    averageGrossProfit: 640, strategicPlanned: 12, strategicCompleted: 4 }, "Example: last year's show");
  scorecard(show, {});

  // 2. A Postal campaign under it, from the leftover material.
  const postal = make({
    type: "postal",
    name: "Long Beach leftovers mailer",
    controlDate: addDays(day, 49),
    audience: "Show contacts who asked for samples",
  }, show);
  complete(postal, ["post_recipients"], day);
  note(postal, "post_addresses", "Example: two addresses came off the scans incomplete and need checking.");

  // 3. A Digital Platform campaign under it, further along.
  const social = make({
    type: "digital_platform",
    name: "Long Beach booth build-up posts",
    controlDate: addDays(day, 21),
    audienceKind: "public",
    audience: "Decorators following P&M on Instagram and LinkedIn",
  }, show);
  complete(social, ["dp_audience", "dp_art", "dp_art_approval"], day);
  skip(social, ["dp_paid_proposal", "dp_paid_approval", "dp_email_copy"]);
  numbers(social, { dp_engagements: 310, dp_reach: 7400, dp_clicks: 96, dp_impressions: 11200 }, "Example: platform reports");

  // 4. A Try On Day carrying the under-25 warning, so the warning can be seen.
  const tryOn = make({
    type: "try_on_day",
    name: "Heartland Co-op staff store",
    controlDate: addDays(day, 35),
    audience: "Heartland Co-op office staff",
  });
  complete(tryOn, ["tod_qualify", "tod_format"], day);
  note(tryOn, "tod_qualify", "Example: client expects around 20 people, which is under the minimum.");
  numbers(tryOn, { tod_expected: 20, tod_invited: 34 }, "Example: client contact");

  // 5. A finished Picks with Personality, so the numbers and scorecard are
  //    filled in rather than a page of "needs this".
  const picks = make({
    type: "picks",
    name: "Spring picks, SanMar",
    controlDate: addDays(day, -30),
    audience: "Client list, spring 2027",
  });
  picks.steps.forEach((s, i) => {
    s.done = true;
    s.doneAt = addDays(day, -45 + i * 2);
    s.doneBy = "Example data";
    if (s.approval) s.approvedBy = "Example data";
  });
  numbers(picks, { picks_sent: 480, picks_bounces: 14, picks_clickers: 61, picks_audience: 466, picks_orders: 7,
    qualifiedContactsEstimate: 466, conversionRate: 1.5, averageOrderValue: 910, averageGrossProfit: 300 },
    "Example: MailMe send report");
  scorecard(picks, {
    picks_per_account_manager: { target: "5", actual: "6", range: "Spring 2027", source: "Example data", notes: "One AM added a sixth pick." },
    sent_delivered_bounces: { target: "480", actual: "466 delivered", range: "Spring 2027", source: "Example: MailMe", notes: "14 bounced, all old addresses." },
    unique_clicks_unique_click_rate: { target: "10%", actual: "13.1%", range: "Spring 2027", source: "Example: MailMe", notes: "Opens not counted, directional only." },
  });

  return [show, postal, social, tryOn, picks];
}
