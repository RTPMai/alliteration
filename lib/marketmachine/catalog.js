// PUT IN: lib/marketmachine/catalog.js
//
// lib/marketmachine/catalog.js — the campaign types and their ordered steps.
//
// SOURCE. Everything in this file comes from Jacob's handoff package
// (PM_MarketMachine_Canonical_Handoff.pdf, sections 4 through 18, and the
// tools companion). Where the handoff names an owner, a timing or a limit, it
// is copied here. Where it does not, the step has no suggested date and a
// neutral owner ("Campaign owner"), rather than a date or a person somebody
// made up. The individual campaign master documents are more detailed and
// have not arrived yet; when they do, this file is where their steps land.
//
// VERSIONED. A campaign copies its steps out of this file when it is created
// and records CATALOG_VERSION. Editing a type here changes NEW campaigns
// only. A campaign already running keeps the checklist it was started with,
// which is the handoff's version rule: completed work reopens exactly as it
// was done.
//
// Ryan's decisions that shape this file (Sept 2026):
//   - prelaunch review is approved by Ryan OR Megan, either one is enough
//   - Ryan keeps social posting, tracked links, public comments, ad spend
//     approval, Christmas gifting and Parade Day, as the handoff assigns them
//   - Printavo invoices stay a manual step: people create them and paste the
//     link, because Alliteration reads Printavo and cannot write to it
//   - TravelTrack has no mileage, permanently, so the trade show travel step
//     says travel and lodging only
//
// Pure data plus a few readers, no imports beyond dates.js: the browser
// imports this file directly to draw the checklist.
//
// ESM. Do NOT convert to module.exports.

export const CATALOG_VERSION = 1;

/**
 * The six stages every campaign page is laid out in, in order (handoff
 * diagram 3, Ryan approved Sept 2026). Descriptions are the diagram's own.
 */
export const STAGES = [
  { key: "create", label: "Create", doing: "Setting up",
    about: "Choose the campaign type. Enter the name, owner, audience, and controlling date." },
  { key: "plan", label: "Plan", doing: "Planning",
    about: "Confirm the purpose, target, recipients, budget, CTA, tools, and assets." },
  { key: "build", label: "Build", doing: "Building",
    about: "Do the ordered work: email copy, Art, physical items, links, files, and records." },
  { key: "prelaunch", label: "Prelaunch review", doing: "In prelaunch review",
    about: "Check audience, approvals, assets, links, invoices, dates, and readiness." },
  { key: "launch", label: "Launch or event", doing: "Launching",
    about: "Send, publish, deliver, perform, or attend. Record it when it happens." },
  { key: "track", label: "Track and review", doing: "Tracking results",
    about: "Capture responses, costs, orders, revenue, follow-up, and the post-launch review." },
];

export const STAGE_KEYS = STAGES.map((s) => s.key);
export const stageMeta = (key) => STAGES.find((s) => s.key === key) || null;

/** The four families the new-campaign menu falls back to (diagram 8). */
export const FAMILIES = [
  { key: "digital", label: "Digital and feedback" },
  { key: "relationship", label: "Relationship and fulfillment" },
  { key: "gifting", label: "Gifting and community" },
  { key: "live", label: "Live and event" },
];

// Shared owner labels. Plain words, the handoff's own.
const AM = "Account Manager";
const OWNER = "Campaign owner";
const APPROVER = "Ryan or Megan";

// Shared default timings, handoff section 4.
const WORKING_START = { bd: -10 };
const ART_DUE = { bd: -5 };
const PRELAUNCH = { bd: -2 };
const LAUNCH_DAY = { days: 0 };
const POST_REVIEW = { days: 14 };
const RESULTS_WINDOW = { days: 60 };

/**
 * One step. `after` names steps that must be finished (or marked not
 * applicable) before this one can be marked done. `na` means the handoff
 * allows skipping it; a step without it cannot be marked Not applicable.
 */
function step(key, stage, label, owner, timing, opts) {
  const o = opts || {};
  return {
    key, stage, label, owner,
    timing: timing || null,
    help: o.help || "",
    approval: !!o.approval,
    after: Array.isArray(o.after) ? o.after.slice() : [],
    na: !!o.na,
  };
}

const prelaunchReview = (timing, extra) => {
  const x = extra || {};
  return step(
    "prelaunch_review", "prelaunch",
    x.label || "Prelaunch review: audience, approvals, assets, links, invoices, dates, readiness",
    APPROVER, timing === undefined ? PRELAUNCH : timing,
    { approval: true, after: x.after,
      help: "Ryan or Megan signs off here. Launch steps stay locked until this is done." });
};

const postLaunchReview = (owner, timing) => step(
  "post_review", "track",
  "Post-launch review: results, issues, decisions, next steps",
  owner || OWNER, timing === undefined ? POST_REVIEW : timing);

const AFTER_REVIEW = { after: ["prelaunch_review"] };

/* ----------------------------------------------------------------------- *
 * THE THIRTEEN CAMPAIGN TYPES
 * ----------------------------------------------------------------------- */

export const CAMPAIGN_TYPES = [
  /* ---- digital and feedback ---- */
  {
    key: "digital_platform", label: "Digital Platform", family: "digital",
    controlLabel: "Launch date",
    summary: "Social posts, paid ads, and linked email across the platforms Jacob and the Account Manager choose.",
    steps: [
      step("dp_audience", "create", "Choose the audience, platforms, and schedule", "Jacob and " + AM, WORKING_START,
        { help: "Platforms: Facebook, Instagram, TikTok, YouTube, LinkedIn, Email, Paid ad, Other. Only selected platforms get Art." }),
      step("dp_paid_proposal", "plan", "Propose paid ad spend", "Jacob and " + AM, WORKING_START, { na: true }),
      step("dp_paid_approval", "plan", "Approve paid ad spend", "Ryan and Megan", null,
        { approval: true, na: true, after: ["dp_paid_proposal"] }),
      step("dp_art", "build", "Art creates the assets for each selected platform", "Art", ART_DUE,
        { help: "Each asset needs a size, due date, and Art number." }),
      step("dp_art_approval", "build", "Approve the art", "Megan", null, { approval: true, after: ["dp_art"] }),
      step("dp_email_copy", "build", "Write the email copy", AM, ART_DUE, { na: true }),
      step("dp_links", "build", "Create and test tracked links", "Ryan", null,
        { na: true, help: "Mark Not applicable when the campaign has no link." }),
      step("dp_setup", "build", "Set up posts and scheduling on each platform", "Ryan", null),
      prelaunchReview(),
      step("dp_launch", "launch", "Post, publish, or launch the ad", "Ryan", LAUNCH_DAY, AFTER_REVIEW),
      step("dp_monitor", "launch", "Monitor comments and platform issues", "Ryan", LAUNCH_DAY,
        { ...AFTER_REVIEW, help: "Sales questions go to the Account Manager. Urgent, negative, or sensitive responses go to Ryan and Megan before posting." }),
      step("dp_platform_results", "track", "Record reach, views, engagement, and clicks", "Ryan", POST_REVIEW),
      step("dp_sales_results", "track", "Record responses, leads, orders, and revenue", AM, POST_REVIEW),
      postLaunchReview(),
      step("dp_final_results", "track", "Final results at the end of the results window", OWNER, RESULTS_WINDOW),
    ],
  },
  {
    key: "poll", label: "Poll Sending", family: "digital",
    controlLabel: "Poll send date",
    summary: "A targeted poll. Ask first, then send the poll only to people who said yes.",
    steps: [
      step("poll_audience", "create", "Attach the proposed audience list", "Jacob and " + AM, WORKING_START),
      step("poll_small_group", "plan", "Decide whether to start with the smaller controlled group", "Jacob and " + AM, null, { na: true }),
      step("poll_prepoll_copy", "build", "Write the pre-poll email asking who wants to take part", AM, null),
      step("poll_prepoll_send", "build", "Send the pre-poll email", AM, null, { after: ["poll_prepoll_copy"] }),
      step("poll_optin_confirm", "build", "Confirm the opt-in group: confirmed yes responses only", AM, null,
        { after: ["poll_prepoll_send"], help: "A pre-poll nonresponse is not consent. Nonresponders and people who declined are left out." }),
      step("poll_copy", "build", "Write the poll email", AM, null),
      prelaunchReview(PRELAUNCH, { after: ["poll_optin_confirm"] }),
      step("poll_send", "launch", "Send the poll to the opt-in group only", AM, LAUNCH_DAY,
        { after: ["prelaunch_review", "poll_optin_confirm"] }),
      step("poll_reminder", "launch", "Send the reminder", AM, null, { after: ["poll_send"], na: true }),
      step("poll_results", "track", "Review results internally", "Jacob and " + AM, null,
        { help: "Never share ordinary poll results with participants." }),
      postLaunchReview(),
    ],
  },
  {
    key: "picks", label: "Picks with Personality", family: "digital",
    controlLabel: "Send date",
    summary: "Each Account Manager's spring or fall favorites from the new SanMar or S&S line.",
    steps: [
      step("picks_trigger", "create", "Record the season, year, and vendor (SanMar or S&S)", OWNER, null,
        { help: "Runs spring and fall, when the vendor rep shows the new garment line." }),
      step("picks_audience", "plan", "Choose the audience", AM, WORKING_START),
      step("picks_select", "build", "Pick at least five favorites", AM, null,
        { help: "Each pick: main image, product name, style number, MSRP, personal reason, color swatches, total colors, and direct vendor link." }),
      step("picks_copy", "build", "Write the intro and email copy", AM, null),
      step("picks_build", "build", "Build and test the email in MailMe", AM, null,
        { after: ["picks_select", "picks_copy"], help: "No send with fewer than five picks, a broken vendor link, or a placeholder tracking link." }),
      prelaunchReview(),
      step("picks_send", "launch", "Send through MailMe", AM, LAUNCH_DAY, AFTER_REVIEW),
      step("picks_report", "track", "Report clicks by product, Account Manager, vendor, season, and placement", OWNER, POST_REVIEW,
        { help: "Unique click rate is the main number. Opens are directional only." }),
      postLaunchReview(),
    ],
  },

  /* ---- relationship and fulfillment ---- */
  {
    key: "referral", label: "Referral", family: "relationship",
    controlLabel: "Year ends (November 30)",
    summary: "Reactive intake and thank-you. Not a broadcast ask, and no standing incentive during the year.",
    steps: [
      step("ref_setup", "create", "Open this year's referral tracking", OWNER, null),
      step("ref_intake", "launch", "Log each referral with the referred person's original wording", AM, null,
        { help: "BackBone will try to match the referrer and referred party automatically in a later phase." }),
      step("ref_validate", "launch", "Confirm or correct the referrer and referred party", AM, null,
        { help: "A referral only counts after the Account Manager confirms it. The same referred person counts once." }),
      step("ref_thanks", "launch", "Thank the referrer and record how and when", AM, null),
      step("ref_revenue", "track", "Track first orders and revenue through November 30", AM, { fixed: "11-30" }),
      step("ref_rank", "track", "Rank confirmed referrals and name P&M's Premier Promoter", OWNER, { fixed: "11-30" },
        { help: "The count is distinct confirmed referred people. Revenue is reported separately. Never share rankings with participants." }),
      step("ref_tie", "track", "If tied: start the Promoter Prize-fight and its connected Digital Platform campaign", OWNER, null,
        { na: true, help: "Timed about one week after Spotify Wrapped." }),
    ],
  },
  {
    key: "sampling", label: "Sampling", family: "relationship",
    controlLabel: "Launch date",
    summary: "Physical samples to approved prospects or clients when handling the product helps the sale.",
    steps: [
      step("samp_recipients", "create", "Approve the exact recipient list", OWNER, { days: -12 },
        { help: "Remove unsubscribed contacts and prevent duplicate outreach." }),
      step("samp_plan", "plan", "Set the CTA, success target, products, quantity, per-recipient cost, and budget", OWNER, { days: -7 },
        { help: "Standard timing is 16 to 24 days: planning 3-5, production 5-7, launch 1-2, follow-up 7-10." }),
      step("samp_dormant", "plan", "Send clients with no order in 6 months to the Account Manager to decide", AM, { days: -7 },
        { na: true, help: "Surface them. Do not auto-enroll." }),
      step("samp_assets", "build", "Marketing Asset Request: inserts, product context, AM info, promo code, follow-up email", "Art", ART_DUE),
      step("samp_invoice", "build", "Create the Printavo invoice and paste the link", OWNER, null),
      step("samp_production", "build", "Decoration, packaging, labels, and freight ready", OWNER, { days: -1 }),
      prelaunchReview(),
      step("samp_send", "launch", "Send samples: carrier or hand delivery, tracking number, send date", OWNER, LAUNCH_DAY, AFTER_REVIEW),
      step("samp_delivered", "launch", "Record the delivery date and package evidence", OWNER, { days: 2 }, { after: ["samp_send"] }),
      step("samp_followup", "track", "Contact recipients 5 to 7 days after confirmed delivery", AM, { days: 9 },
        { after: ["samp_delivered"], help: "Follow up within one business day of any response." }),
      postLaunchReview(),
      step("samp_results", "track", "Weekly results for 3 months", OWNER, { days: 90 }),
    ],
  },
  {
    key: "postal", label: "Postal", family: "relationship",
    controlLabel: "Postal delivered to client",
    summary: "Mail to exact recipients. Stands alone or connects under another campaign.",
    steps: [
      step("post_recipients", "create", "Attach exact recipients and addresses", OWNER, WORKING_START),
      step("post_plan", "plan", "Set quantity, packaging, and postage", OWNER, null),
      step("post_addresses", "build", "Review and fix bad or uncertain addresses", OWNER, null,
        { help: "Resolve every bad or uncertain address before release." }),
      step("post_art", "build", "Art creates the mail piece and CTA", "Art", ART_DUE),
      step("post_invoice", "build", "Create the Printavo invoice and paste the link", OWNER, null, { na: true }),
      prelaunchReview(),
      step("post_ship", "launch", "Ship the mailing and record the ship date", OWNER, null, AFTER_REVIEW),
      step("post_delivered", "launch", "Confirm Postal delivered to client", OWNER, LAUNCH_DAY, { after: ["post_ship"] }),
      step("post_results", "track", "Track CTA interactions, orders, revenue, returned pieces, and disposition", OWNER, RESULTS_WINDOW),
      postLaunchReview(),
    ],
  },

  /* ---- gifting and community ---- */
  {
    key: "in_order_gifting", label: "In-Order Gifting", family: "gifting",
    controlLabel: "Theme starts",
    summary: "A small gift inserted into bulk orders over $1,000 during a planned theme.",
    steps: [
      step("iog_theme", "create", "Choose the promoted theme", "Jacob, Ryan, and Megan", null,
        { help: "Start two months before clients need the promoted items in hand." }),
      step("iog_gift", "plan", "Choose the gift and whether it carries a CTA", "Jacob, Ryan, and Megan", null,
        { help: "Generally under $10. A small gift may have no purchase prompt." }),
      step("iog_insert_art", "build", "Art creates the CTA insert", "Art", ART_DUE, { na: true }),
      prelaunchReview(),
      step("iog_insert", "launch", "Insert the gift in each eligible order and record it here", "Production employee", LAUNCH_DAY,
        { ...AFTER_REVIEW, help: "Eligible means the flat invoice total is over $1,000. Record it at the moment the order is finished." }),
      step("iog_results", "track", "Record CTA interactions, later purchases, and influenced revenue", AM, RESULTS_WINDOW),
      postLaunchReview(),
    ],
  },
  {
    key: "on_us", label: "This One Is On Us", family: "gifting",
    controlLabel: "Ship or handoff date",
    summary: "An Account Manager's individual gift to one client, decorated with their logo.",
    steps: [
      step("onus_decision", "create", "Choose the gift and recipient and record why", AM, null),
      step("onus_source", "plan", "Pick the item from stock or a finished floor sample", AM, null,
        { help: "No dollar threshold." }),
      step("onus_invoice", "build", "Create the Printavo invoice and paste the link", AM, null,
        { help: "Anything P&M produces needs a Printavo invoice." }),
      step("onus_decorate", "build", "Decorate with the client's logo", "Production", null, { after: ["onus_invoice"] }),
      prelaunchReview(null),
      step("onus_deliver", "launch", "Ship it, or hold it for the Account Manager's next in-person visit", AM, LAUNCH_DAY,
        { ...AFTER_REVIEW, help: "Record the delivery method, date, and notes." }),
      postLaunchReview(),
    ],
  },
  {
    key: "christmas", label: "Christmas Gifting", family: "gifting",
    controlLabel: "Delivered to clients by",
    summary: "Ryan and Megan's yearly client gifts, delivered by October 31.",
    steps: [
      step("xmas_choose", "plan", "Choose the gifting items and budget", "Ryan and Megan", { fixed: "09-30" }),
      step("xmas_recipients", "plan", "Approve the recipient plan", "Ryan and Megan", { fixed: "09-30" }, { approval: true }),
      step("xmas_order", "build", "Order and receive the gifts", OWNER, { fixed: "10-14" }, { after: ["xmas_choose"] }),
      step("xmas_verify", "build", "Verify the gifts", OWNER, { fixed: "10-14" }, { after: ["xmas_order"] }),
      step("xmas_cards", "build", "Create the info cards with price and minimums", "Ryan and Megan", { fixed: "10-14" },
        { help: "The Account Manager does not confirm price, minimums, or card details." }),
      step("xmas_prepare", "build", "Prepare distribution", OWNER, { fixed: "10-14" }),
      prelaunchReview(null),
      step("xmas_deliver", "launch", "Ship or deliver the gifts and record completion", OWNER, { fixed: "10-31" }, AFTER_REVIEW),
      step("xmas_report", "track", "Record spend, recipients, deliveries, interactions, orders, and influenced revenue", OWNER, null,
        { help: "No required follow-up task after delivery." }),
    ],
  },
  {
    key: "parade", label: "Parade Day", family: "gifting",
    controlLabel: "Parade date",
    summary: "The Ankeny parade, or the parade picked for the year: a float and about 2,000 shirts.",
    steps: [
      step("par_choose", "create", "Choose the parade for the year", "Margo, Ryan, and Megan", null),
      step("par_plan", "plan", "Plan the float and the shirt count", "Margo, Ryan, and Megan", null,
        { help: "Roughly 2,000 shirts for random distribution." }),
      step("par_vendor", "plan", "Request SanMar marketing dollars or supplier special pricing", "Margo", null, { na: true }),
      step("par_stock", "plan", "Check the stockroom first, then order what is missing", OWNER, null),
      step("par_shopping", "build", "Shop for float materials and send the upcoming-event nudge", OWNER, { days: -60 },
        { help: "One month before construction starts." }),
      step("par_invoice", "build", "Create the Printavo invoice for the shirts and paste the link", OWNER, null),
      step("par_cta", "build", "Art creates the tracked CTA sticker or flyer", "Art", ART_DUE),
      step("par_build", "build", "Build the float, with tasks assigned to named people", OWNER, { days: -1 },
        { help: "Construction takes about one month." }),
      step("par_packout", "build", "Roll the CTA sticker or flyer into each shirt", OWNER, { days: -1 }, { after: ["par_cta"] }),
      prelaunchReview(),
      step("par_event", "launch", "Parade day: hand out the shirts", OWNER, LAUNCH_DAY, AFTER_REVIEW),
      step("par_count", "track", "One final physical count and what happens to the leftovers", OWNER, null, { after: ["par_event"] }),
      step("par_results", "track", "Track CTA scans and button clicks", OWNER, RESULTS_WINDOW),
      postLaunchReview(),
    ],
  },

  /* ---- live and event ---- */
  {
    key: "live_screen_printing", label: "Live Screen Printing", family: "live",
    controlLabel: "Event date",
    summary: "The proven live-print operation, turned into a guided checklist without changing how it is done.",
    steps: [
      step("lsp_intake", "create", "Event intake: space, power, access, setup, hours, teardown, contacts", AM, null),
      step("lsp_payment", "create", "Choose the payment model: end-user paid or client paid", AM, null),
      step("lsp_pricing", "plan", "Confirm pricing and collect the deposit", AM, null,
        { help: "$125 per hour, 30 minutes setup and 30 minutes teardown, 3 production hour minimum. Record any approved prorated exception." }),
      step("lsp_staffing", "plan", "Assign staffing", OWNER, null),
      step("lsp_store", "plan", "Decide on an optional fundraising store", AM, null,
        { na: true, help: "Stays open up to 48 hours after the event. Allow 10 business days for post-event production." }),
      step("lsp_designs", "build", "Final designs due", AM, { days: -7 }, { help: "Up to four one-color designs." }),
      step("lsp_invoice", "build", "Create the Printavo invoice and paste the link", AM, null,
        { help: "End-user paid follows the Top example. Client paid follows the Century 21 example." }),
      step("lsp_pack", "build", "Pack the Dry Box, Wet Box, Other, and numbered garment boxes", "Assigned staff", { days: -1 }),
      prelaunchReview(),
      step("lsp_event", "launch", "Run the event", "Assigned staff", LAUNCH_DAY, AFTER_REVIEW),
      step("lsp_return", "track", "Count items back into the building: variance and disposition", "Assigned staff", null, { after: ["lsp_event"] }),
      step("lsp_reconcile", "track", "Reconcile the invoice", AM, null,
        { after: ["lsp_return"], help: "End-user paid: taken minus NOT PRINTED minus MISPRINT equals sold, with exact negative rows. Client paid: bill everything and finish leftovers for the organizer." }),
      postLaunchReview(),
    ],
  },
  {
    key: "live_customization", label: "Live Customization", family: "live",
    controlLabel: "Event date",
    summary: "Live transfers and heat patches at an event. Shares the live-event base with Live Screen Printing.",
    steps: [
      step("lc_intake", "create", "Event intake: space, power, access, setup, hours, teardown, contacts", AM, null),
      step("lc_payment", "create", "Choose the payment model: end-user paid or client paid", AM, null),
      step("lc_method", "plan", "Choose the method and products", AM, null,
        { help: "Digital transfer, heat patch, or both. Shirts, hats, or both." }),
      step("lc_pricing", "plan", "Confirm current pricing", AM, null,
        { help: "The current Account Manager confirms. Do not reuse an old 2025 price." }),
      step("lc_power", "plan", "Confirm power: regular press 15A, hat press 10A", "Assigned staff", null,
        { help: "Use a separate outlet when combined with live printing." }),
      step("lc_patches", "build", "Patch designs final and ordered", AM, { days: -21 },
        { na: true, help: "Maximum three patch designs." }),
      step("lc_transfers", "build", "Transfer designs final", AM, { days: -7 },
        { na: true, help: "Maximum five transfer designs. Standard placements: left chest, half front, full front, full back." }),
      step("lc_invoice", "build", "Create the Printavo invoice and paste the link", AM, null),
      step("lc_pack", "build", "Pack equipment, transfers and patches, checkout and signage, numbered boxes", "Assigned staff", { days: -1 }),
      prelaunchReview(),
      step("lc_event", "launch", "Run the event", "Assigned staff", LAUNCH_DAY, AFTER_REVIEW),
      step("lc_exceptions", "launch", "Record in-the-moment exceptions: product, design, placement, decorator", "Decorator", LAUNCH_DAY,
        { ...AFTER_REVIEW, na: true, help: "The decorator can approve on the spot. No separate approval." }),
      step("lc_return", "track", "Count items back in, using NOT CUSTOMIZED and DAMAGED DURING APPLICATION", "Assigned staff", null, { after: ["lc_event"] }),
      step("lc_reconcile", "track", "Reconcile the invoice", AM, null,
        { after: ["lc_return"], help: "End-user paid: take NOT CUSTOMIZED out of sales and paste the Printavo shop-completion record. Client paid: keep items on the invoice, finish them in the shop, deliver to the organizer." }),
      postLaunchReview(),
    ],
  },
  {
    key: "trade_show", label: "External Trade Show", family: "live",
    controlLabel: "Event date",
    parent: true,
    connects: ["postal", "digital_platform", "live_screen_printing", "live_customization", "sampling"],
    summary: "A Marketing Event that holds shared event work and connects full campaigns underneath it.",
    steps: [
      // Pre-event, handoff section 16. Due dates use the later end of each
      // window, so "12-10 weeks" is due 10 weeks out.
      step("ts_identity", "create", "Enter event identity, dates, location, deadlines, and participation options", "Jacob", { days: -70 }),
      step("ts_participation", "create", "Choose exhibitor, attendee, hybrid, or do not attend", "Jacob, Megan, and Ryan", { days: -70 }),
      step("ts_budget", "plan", "Approve the total budget and any later increases", "Amanda, Jacob, Megan, and Ryan", { days: -70 }, { approval: true }),
      step("ts_staff", "plan", "Assign attending staff: dates, shifts, arrival, departure, dress, travel, responsibilities", "Jacob", { days: -70 }),
      step("ts_registration", "plan", "Complete registration and record confirmation, deadlines, and included benefits", "Jacob", { days: -70 }),
      step("ts_travel", "plan", "Arrange travel, lodging, and itinerary in TravelTrack", "Ryan and Amanda", { days: -56 }),
      step("ts_targets", "plan", "Choose target companies, contacts, priority meetings, and owners", "Jacob and attending AMs", { days: -56 }),
      step("ts_connected", "plan", "Add each connected campaign with its own owner and dates", "Jacob and campaign owners", { days: -56 },
        { na: true }),
      step("ts_invoices", "build", "Create Printavo invoices for every physical item and paste the links", "Campaign owners", { days: -42 },
        { help: "Every physical item, regardless of who produces it." }),
      step("ts_materials", "build", "Complete Art, production, magazine ad, handouts, giveaways, signage, and shipping", "Assigned owners", { days: -14 }),
      step("ts_test", "build", "Test BackBone business-card scan, CTA links, QR codes, and connected tools", "Jacob or assigned tester", { days: -14 }),
      prelaunchReview({ days: -7 }, {
        label: "Prelaunch review: final packing, staff briefing, and contingency check",
      }),
      // Event day, section 17.
      step("ts_daily_confirm", "launch", "Each day: confirm staff, times, roles, meetings, materials, dress, transportation", "Jacob or assigned lead", LAUNCH_DAY, AFTER_REVIEW),
      step("ts_open", "launch", "Before open: prepare the booth and test QR, buttons, CTA, BackBone, and connected campaigns", "Attending staff", LAUNCH_DAY, AFTER_REVIEW),
      step("ts_start_count", "launch", "Before open: record starting quantity and Printavo links for physical material", "Assigned staff", LAUNCH_DAY, AFTER_REVIEW),
      step("ts_meetings", "launch", "At each meeting: attendees, company, discussion, requests, promises, next step", "Meeting owner", LAUNCH_DAY, AFTER_REVIEW),
      step("ts_cards", "launch", "Photograph each business card into BackBone right away, with conversation notes", "Attending staff", LAUNCH_DAY,
        { ...AFTER_REVIEW, help: "Keep the original card image, who captured it, the time, and the follow-up promise together." }),
      step("ts_handouts", "launch", "When handing out items: item, quantity, invoice, CTA insert", "Assigned staff", LAUNCH_DAY,
        { ...AFTER_REVIEW, help: "Random recipients can stay unnamed." }),
      step("ts_expenses", "launch", "Capture each expense: receipt, amount, purpose, employee, payment status", "Employee incurring expense", LAUNCH_DAY, AFTER_REVIEW),
      step("ts_sessions", "launch", "During sessions: learning, competitors, needs, findings, next action", "Attending staff", LAUNCH_DAY, { ...AFTER_REVIEW, na: true }),
      step("ts_daily_review", "launch", "Each day before leaving: review scans, notes, meetings, CTA activity, expenses, next-day priorities", "Jacob or assigned lead", LAUNCH_DAY, AFTER_REVIEW),
      step("ts_final_count", "launch", "End of event: one final material count, pack, return, flag leftovers", "Assigned staff", LAUNCH_DAY,
        { ...AFTER_REVIEW, help: "No daily count. Only the starting quantity and this one final count." }),
      // Post-event, section 18.
      step("ts_disposition", "track", "Record inventory, Postal, disposal, or other disposition for leftovers", "Assigned staff", { days: 1 }, { after: ["ts_final_count"] }),
      step("ts_scans", "track", "Validate BackBone scans, fix incomplete records, resolve duplicates", "Jacob", { days: 2 }),
      step("ts_assign", "track", "Assign each confirmed contact to an Account Manager", "Jacob", { days: 2 }, { after: ["ts_scans"] }),
      step("ts_return", "track", "Return materials and attach files, receipts, shipping, and expense records", "Assigned staff", { bd: 2 }),
      step("ts_leftovers", "track", "Decide leftover use; create a Postal campaign if exact recipients will get items", "Jacob or campaign owner", { bd: 2 }, { na: true }),
      step("ts_followup", "track", "Send personalized follow-up, sooner when a promise requires it", "Assigned Account Manager", { bd: 3 }, { after: ["ts_assign"] }),
      step("ts_promises", "track", "Fulfill promises through the right connected campaign", "Campaign owner", { bd: 3 }, { na: true }),
      step("ts_reconcile", "track", "Reconcile budget, expenses, Printavo, TravelTrack, and connected campaign costs", "Assigned owners", { bd: 5 }),
      postLaunchReview("Jacob, Megan, and Ryan"),
      step("ts_60", "track", "Track opportunities, quotes, orders, revenue, and Account Manager influence", AM, RESULTS_WINDOW),
      step("ts_decision", "track", "Review final results and record the attend-again decision", "Jacob, Megan, and Ryan", RESULTS_WINDOW,
        { approval: true, help: "Attend again, attend differently, or do not attend, with a dated reason." }),
    ],
  },
];

export const TYPE_KEYS = CAMPAIGN_TYPES.map((t) => t.key);
export const typeMeta = (key) => CAMPAIGN_TYPES.find((t) => t.key === key) || null;
export const isParentType = (key) => !!(typeMeta(key) || {}).parent;

/** Types a parent of this type may hold as connected campaigns. */
export function connectableTypes(parentKey) {
  const meta = typeMeta(parentKey);
  return meta && Array.isArray(meta.connects) ? meta.connects.slice() : [];
}

/**
 * A fresh copy of a type's steps for a new campaign.
 *
 * A deep copy, so a later edit to a running campaign's checklist can never
 * reach back into the catalog and change what the next campaign starts with.
 */
export function starterSteps(typeKey) {
  const meta = typeMeta(typeKey);
  if (!meta) return [];
  return meta.steps.map((s) => ({
    key: s.key,
    stage: s.stage,
    label: s.label,
    owner: s.owner,
    timing: s.timing ? { ...s.timing } : null,
    help: s.help || "",
    approval: !!s.approval,
    after: (s.after || []).slice(),
    na: !!s.na,
  }));
}

/**
 * Campaign types for the new-campaign menu: most used first, Ryan's call
 * (Sept 2026).
 *
 * Ties, including the day-one case where nothing has been created yet, keep
 * the catalog order, which is Jacob's four families. So the menu is never in
 * a random order, and it drifts toward how P&M actually works as campaigns
 * are made.
 *
 * A parent-only view is not assumed: connected campaigns count as uses of
 * their own type, because a Postal campaign under a trade show is still a
 * Postal campaign somebody set up.
 */
export function typesByUse(campaigns) {
  const counts = {};
  (Array.isArray(campaigns) ? campaigns : []).forEach((c) => {
    if (c && c.type) counts[c.type] = (counts[c.type] || 0) + 1;
  });
  return CAMPAIGN_TYPES
    .map((t, i) => ({ key: t.key, label: t.label, family: t.family, uses: counts[t.key] || 0, order: i }))
    .sort((a, b) => (b.uses - a.uses) || (a.order - b.order));
}
