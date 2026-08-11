// test/backbone.test.cjs
/**
 * BackBone contract tests.
 *
 * Locks the Jul 25-27 dashboard and metric work: the cash-collected series,
 * the staleness stamp, the cron, and the masonry/pin layout. Each of these
 * shipped because a silent failure mode cost real time (July read $31k while
 * the month was past $190k); these keep the fixes from regressing quietly.
 *
 * Rebuilt Jul 29, 2026: the original was lost to a wrong-file upload.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const main = read('apps/backbone/main.js');
const template = read('apps/backbone/template.js');
const styles = read('apps/backbone/styles.js');
const sync = read('api/printavo-sync.js');
const vercel = JSON.parse(read('vercel.json'));

/* ---- cash collected ----------------------------------------------------- */

t.test('ops sync writes cashByMonth', () => {
  t.assert(sync.includes('cashByMonth'), 'api/printavo-sync.js no longer produces cashByMonth');
});

t.test('cash phase excludes non-payment transaction types', () => {
  ['Refund', 'Return', 'Void', 'Dispute'].forEach((kind) => {
    t.assert(sync.includes(kind),
      'the cash phase no longer screens out ' + kind + ' transactions');
  });
});

t.test('dashboard prefers salesByMonth (invoice date) with cashByMonth as fallback', () => {
  t.assert(/salesByMonth[\s\S]{0,300}cashByMonth/.test(main),
    'main.js should pick salesByMonth (invoice-date basis) when present and fall back to cashByMonth — Ryan\'s Aug 5 call: the Sales Goal card tracks by invoice date, so a January invoice paid in August still counts toward January');
});

t.test('roster revenue is attributed to invoice date, not payment date', () => {
  // total_revenue / revenue_by_year (the "Total roster revenue" / "[Year]
  // revenue" KPIs) are built by foldInvoice, keyed on bucketYear (the
  // reconcile's invoice-date year window) or the invoice's own createdAt —
  // never on a payment/transaction date. Locking this in since Ryan's Aug 5
  // ask assumes it and it would be an easy regression to introduce by
  // accident while touching the sales-goal series nearby.
  t.assert(/const year = bucketYear \|\| \(d \? d\.slice\(0, 4\) : null\)/.test(sync),
    'revenue_by_year must be keyed by invoice date (bucketYear / createdAt), not a payment date');
  t.assert(!/paidAt|paymentDate|transactionDate/.test(
    sync.slice(sync.indexOf('function foldInvoice'), sync.indexOf('function foldInvoice') + 2000)),
    'foldInvoice should not reference a payment/transaction date field');
});

/* ---- staleness stamp ---------------------------------------------------- */

t.test('the ops data stamp exists and turns amber past 48 hours', () => {
  t.assert(main.includes('Data through'), 'the "Data through" stamp is gone');
  t.assert(/ageHours\s*<=\s*48/.test(main),
    'the 48 hour staleness threshold is gone; a dead cron would go unnoticed again');
  t.assert(/Stale[\s\S]{0,200}var\(--amber\)|var\(--amber\)[\s\S]{0,200}Stale/.test(main),
    'the stale state should render in amber');
});

/* ---- cron --------------------------------------------------------------- */

t.test('vercel.json carries the ops cron, ticking repeatedly to cover self-chain removal', () => {
  // Aug 6, 2026: continueOps() stopped self-fetching (it reliably tripped
  // Vercel's own INFINITE_LOOP_DETECTED / HTTP 508 well before CHAIN_MAX).
  // Ops mode now relies on this cron ticking every 10 minutes for a ~2 hour
  // window after the original 6 AM slot to resume backbone_ops_partial,
  // since each tick is an external, non-recursive invocation.
  const crons = vercel.crons || [];
  const ops = crons.find((c) => String(c.path).includes('printavo-sync') &&
    String(c.path).includes('mode=ops'));
  t.assert(ops, 'the ops cron is missing from vercel.json');
  t.equal(ops.schedule, '*/10 11-12 * * *',
    'ops cron schedule changed; expected a repeating window starting at 11:00 UTC (6 AM Central) since continueOps() no longer self-chains');
});

/* ---- incremental roster refresh ------------------------------------------ */
// New Printavo customers only reach the roster via mode=incremental (or a
// manual Reconcile). Added Aug 5 so a new client shows up automatically
// instead of waiting on someone to click Reconcile in Settings.

t.test('vercel.json carries a daily incremental cron ahead of the ops cron', () => {
  const crons = vercel.crons || [];
  const inc = crons.find((c) => String(c.path).includes('printavo-sync') &&
    String(c.path).includes('mode=incremental'));
  const ops = crons.find((c) => String(c.path).includes('printavo-sync') &&
    String(c.path).includes('mode=ops'));
  t.assert(inc, 'the daily incremental cron is missing from vercel.json');
  t.assert(ops, 'the ops cron is missing from vercel.json');
  // Compare minute-of-day of each schedule's FIRST tick so "incremental runs
  // before ops" holds regardless of the exact schedule chosen. Handles plain
  // "M H" entries as well as step/range fields (e.g. "*/10 11-12") since the
  // ops cron moved to a repeating window on Aug 6.
  function firstValue(field) {
    const first = String(field).split(',')[0];
    const base = first.includes('/') ? first.split('/')[0] : first;
    if (base === '*') return 0;
    if (base.includes('-')) return parseInt(base.split('-')[0], 10);
    return parseInt(base, 10);
  }
  function minuteOfDay(schedule) {
    const parts = String(schedule).trim().split(/\s+/);
    return firstValue(parts[1]) * 60 + firstValue(parts[0]);
  }
  t.assert(minuteOfDay(inc.schedule) < minuteOfDay(ops.schedule),
    'the incremental cron should run before the ops cron\'s first tick so a new client is on the roster before the dashboard slice refreshes');
});

t.test('incremental mode self-chains on a partial run, carrying its cursor', () => {
  t.assert(sync.includes('continueIncremental'),
    'incremental no longer self-chains; a big backlog could stop mid-run and wait for tomorrow');
  t.assert(/continueIncremental\(cursor\)/.test(sync),
    'continueIncremental must be called with the resume cursor — incremental does not persist a partial to KV between calls like ops does');
});

t.test('the ops and incremental chains share one continueChain implementation', () => {
  t.assert(/function continueChain\(targetMode,\s*extraQS\)/.test(sync),
    'continueOps and continueIncremental should share the same JSON/cache-verified chain logic, not duplicate it');
});

t.test('the sync accepts Vercel cron auth and fails closed', () => {
  t.assert(sync.includes('CRON_SECRET'), 'CRON_SECRET handling is gone from the sync');
  t.assert(sync.includes('safeEqual'),
    'the sync must compare secrets with safeEqual (set-before-compare, constant time)');
});

/* ---- masonry and pin layout --------------------------------------------- */

t.test('DASH_ROW in main.js matches grid-auto-rows in styles.js', () => {
  const row = main.match(/DASH_ROW\s*=\s*(\d+)/);
  t.assert(row, 'DASH_ROW constant is missing from main.js');
  const css = styles.match(/data-masonry="1"\]\s*\{\s*grid-auto-rows\s*:\s*(\d+)px/);
  t.assert(css, 'grid-auto-rows for the masonry grid is missing from styles.js');
  t.equal(row[1], css[1],
    'DASH_ROW and grid-auto-rows disagree; masonry spans will missize every card');
});

t.test('masonry is gated on the data-masonry attribute', () => {
  t.assert(main.includes('data-masonry') || main.includes('dataset.masonry'),
    'masonry must be opt-in via data-masonry so a JS failure degrades to plain rows');
});

t.test('the page width cap stayed removed', () => {
  t.assert(!/\.dash\s*\{[^}]*max-width\s*:\s*1440px/.test(styles),
    'the 1440px cap on .dash came back');
});

t.test('full width pin persists in the layout blob', () => {
  t.assert(/l\.full/.test(main), 'the width pin (l.full) is gone from layout persistence');
});

/* ---- rail badge --------------------------------------------------------- */

t.test('the inbox count goes through ctx.setBadge, not a dead DOM id', () => {
  t.assert(!main.includes('$id("inboxNavBadge")'),
    'updateInboxBadge is back to looking up #inboxNavBadge, which no template declares');
  t.assert(/ctx\.setBadge/.test(main),
    'the inbox new-count should reach the rail via ctx.setBadge');
});

/* ---- ops chaining (Jul 31 fix) ------------------------------------------ */
/* The daily cron did ONE ~4-minute chunk per DAY, so a multi-chunk ops pull
 * never finished and the dashboard stamp froze at Jul 27. The fix makes a
 * cron-initiated run fire its own next chunk. These lock the three legs of
 * that fix: the chain fires on every partial, it cannot loop forever, and a
 * days-old partial restarts fresh instead of resuming a dead cursor. */

t.test('every ops partial return fires the self-continue chain', () => {
  const partials = (sync.match(/status: "partial", phase/g) || []).length;
  const chains = (sync.match(/await continueOps\(\)/g) || []).length;
  t.assert(partials >= 3, 'expected the three ops phase partial returns');
  t.assert(chains >= partials - 2, // incremental/reconcile partials do not chain
    'an ops partial return no longer calls continueOps(); the cron will freeze again');
  t.assert(/chainDepth\s*\+\s*1/.test(sync),
    'the chained call must increment the depth counter');
});

t.test('the ops chain has a hard depth cap', () => {
  t.assert(/CHAIN_MAX/.test(sync) && /chainDepth\s*<\s*CHAIN_MAX/.test(sync),
    'continueOps can loop forever without a CHAIN_MAX guard');
});

t.test('continueOps no longer self-fetches (Aug 6 508 fix)', () => {
  t.assert(/async function continueOps\(\)\s*\{\s*return\s*\{/.test(sync),
    'continueOps should return a static no-op result instead of calling continueChain and self-fetching, which trips Vercel\'s INFINITE_LOOP_DETECTED');
  t.assert(!/async function continueOps\(\)\s*\{\s*return continueChain/.test(sync),
    'continueOps is calling continueChain again; this is the pattern that produced the Aug 6 HTTP 508 outage');
});

t.test('ops mode skips redundant work once a run has already finished today', () => {
  t.assert(/already-done-today/.test(sync),
    'the same-day short-circuit is missing; repeated cron ticks after completion would redo the full Printavo pull every 10 minutes');
  t.assert(/fresh.{0,20}America\/Chicago|America\/Chicago[\s\S]{0,400}already-done-today|already-done-today[\s\S]{0,400}America\/Chicago/.test(sync),
    'the same-day check should compare Central-time calendar dates');
});

t.test('ops partial saves are stamped and stale partials restart fresh', () => {
  t.assert(!/kvSet\("backbone_ops_partial",\s*acc\)/.test(sync),
    'a partial save bypasses saveOpsPartial and will carry no freshness stamp');
  t.assert(/OPS_RESUME_WINDOW_MS/.test(sync),
    'the ops partial no longer has a freshness window; day-old cursors will be resumed');
});

/* ---- Inbox: city/state/ZIP sanity check (Ryan's ask, Aug 2026) --------- */
// "Polk City IA 50014" was submitted — that ZIP is actually Ames, not Polk
// City. The intake form has no dedicated address field, so this scans every
// free-text field on an inquiry for anything address-shaped and verifies the
// ZIP against a real ZIP database.

const zipCheckApi = fs.existsSync(path.join(ROOT, 'api/zip-check.js'))
  ? read('api/zip-check.js')
  : null;

if (zipCheckApi) {
  t.test('the ZIP check endpoint is session-gated, not public', () => {
    t.assert(/requireAuth\(req/.test(zipCheckApi),
      'api/zip-check.js should require a session — unlike the public intake endpoints, there is no reason for an anonymous caller to get a free ZIP-lookup proxy');
  });

  t.test('ZIP lookups are cached in KV so repeat inquiries do not re-hit the external API', () => {
    t.assert(/zipcache:/.test(zipCheckApi), 'the KV cache key prefix is missing');
    t.assert(/kvGet\(cacheKey/.test(zipCheckApi) && /kvSet\(cacheKey/.test(zipCheckApi),
      'lookupOne() should check the cache before fetching and populate it after — otherwise every inquiry re-hits the external API for the same ZIP');
  });

  t.test('a failed upstream lookup is never cached as a false negative', () => {
    // valid:null (unknown/failed) must not get written to KV, or a transient
    // outage would permanently "poison" that ZIP as unverifiable.
    const failBlock = zipCheckApi.slice(zipCheckApi.indexOf('valid: null'), zipCheckApi.indexOf('valid: null') + 400);
    t.assert(!/kvSet\(cacheKey/.test(failBlock),
      'a valid:null (failed lookup) result path must return before reaching kvSet, or a transient failure gets cached permanently');
  });

  t.test('main.js scans free-text fields (not a dedicated address field, since none exists) for city/state/ZIP claims', () => {
    t.assert(/function findAddressClaims/.test(main), 'findAddressClaims() is missing from main.js');
    t.assert(/function inquiryFieldsRaw/.test(main),
      'inquiryFieldsRaw() is missing — address scanning should reuse the same free-text sources as bot screening (inquiryFieldsRaw), not duplicate the field list');
  });

  t.test('city comparison tolerates over-captured filler words without false-flagging correct addresses', () => {
    t.assert(/function citiesMatch/.test(main), 'citiesMatch() is missing');
    t.assert(/endsWith/.test(main.slice(main.indexOf('function citiesMatch'), main.indexOf('function citiesMatch') + 500)),
      'citiesMatch() should tolerate a captured city like "are in Des Moines" matching the real "Des Moines" — a strict equality check would falsely flag correct addresses embedded in ordinary prose');
  });

  t.test('the address check is advisory only — a failed/offline lookup never shows a false alarm', () => {
    const idx = main.indexOf('async function verifyAddressClaims');
    const block = main.slice(idx, idx + 1500);
    t.assert(/box\.remove\(\)/.test(block),
      'verifyAddressClaims() should remove its placeholder rather than show anything when a ZIP could not be verified');
  });

  t.test('a stale/late lookup response cannot land on the wrong (already-navigated-away-from) inquiry', () => {
    const idx = main.indexOf('async function verifyAddressClaims');
    const block = main.slice(idx, idx + 800);
    t.assert(/activeInquiryId !== s\.id/.test(block),
      'verifyAddressClaims() must bail out if the AM has already opened a different inquiry by the time the ZIP lookup resolves');
  });

  t.test('the Inbox list shows a chip for a mismatched address without re-checking per row', () => {
    t.assert(/function addressChip/.test(main), 'addressChip() is missing from the list-row renderer');
    t.assert(/addressCheckCache/.test(main.slice(main.indexOf('function addressChip'), main.indexOf('function addressChip') + 400)),
      'addressChip() should read from the shared addressCheckCache rather than triggering its own network call per row');
  });

  t.test('js/api.js exposes the ZIP check endpoint and routes it live (not mock)', () => {
    const apiJs = read('js/api.js');
    t.assert(/bbZipCheck:\s*'\/api\/zip-check'/.test(apiJs), 'ENDPOINTS.bbZipCheck is missing from js/api.js');
    t.assert(/'\/api\/zip-check'/.test(apiJs.slice(apiJs.indexOf('LIVE_PREFIXES'), apiJs.indexOf('LIVE_PREFIXES') + 2000)),
      '/api/zip-check must be listed in LIVE_PREFIXES or MOCK mode will silently fake every ZIP lookup');
  });
} else {
  t.test('api/zip-check.js exists (Inbox address sanity check)', () => {
    t.assert(false, 'api/zip-check.js is missing — the Inbox address check has nothing to verify a ZIP against');
  });
}

/* ---- Inbox: sendable brief link, matching the Lead Brief (Ryan's ask) --- */
// Leads have a hosted brief link that goes in the AM handoff email; the
// Inbox had nothing equivalent. This mirrors that same short-link pattern.

const inquiryBriefApi = fs.existsSync(path.join(ROOT, 'api/inquiry-brief.js'))
  ? read('api/inquiry-brief.js')
  : null;

if (inquiryBriefApi) {
  t.test('the inquiry brief endpoint is session-gated, like the Lead Brief', () => {
    t.assert(/requireAuth\(req/.test(inquiryBriefApi),
      'api/inquiry-brief.js should require a session, same as api/brief.js');
  });

  t.test('the inquiry brief reuses the Lead Brief\'s short-link namespace, not a new one', () => {
    t.assert(/backbone_brief:/.test(inquiryBriefApi),
      'api/inquiry-brief.js must write to the same backbone_brief: KV prefix api/b.js already reads — a different prefix would need api/b.js changes too, or the short link would 404');
  });

  t.test('the inquiry brief uploads to the same public Blob store as the Lead Brief', () => {
    t.assert(/access:\s*"public"/.test(inquiryBriefApi),
      'the brief must be uploaded with public access or the emailed link will fail for an AM who is not signed into BackBone');
  });

  t.test('the inquiry brief surfaces uploaded art files and Inbox warnings, not just the Lead Brief\'s fields', () => {
    t.assert(/art_files/.test(inquiryBriefApi), 'the brief should show uploaded art files (from api/intake-upload.js) as links');
    t.assert(/warnings/.test(inquiryBriefApi), 'the brief should have a section for warnings passed in from the Inbox (bot signals, address mismatch)');
  });

  t.test('main.js can generate and cache an inquiry brief URL, mirroring generateBrief() for Leads', () => {
    t.assert(/function generateInquiryBrief/.test(main), 'generateInquiryBrief() is missing from main.js');
    t.assert(/inquiryBriefUrls\[s\.id\]/.test(main),
      'generateInquiryBrief() should cache by inquiry id so re-opening the same inquiry does not regenerate/re-upload a brief');
  });

  t.test('the Email to AM button requires picking an AM first, same as the unassigned-lead pattern', () => {
    const idx = main.indexOf('async function emailInquiryToAM');
    const block = main.slice(idx, idx + 600);
    t.assert(/if \(!am\)/.test(block), 'emailInquiryToAM() should refuse to send with no AM selected, rather than mailto: to a blank address');
  });

  t.test('the brief mailto pulls the warnings already known to the Inbox, without a fresh network round trip', () => {
    t.assert(/function inquiryWarnings/.test(main), 'inquiryWarnings() is missing');
    const idx = main.indexOf('function inquiryWarnings');
    const block = main.slice(idx, idx + 500);
    t.assert(/addressCheckCache/.test(block),
      'inquiryWarnings() should read from the already-populated addressCheckCache, not trigger a new ZIP lookup just to build an email');
  });

  t.test('js/api.js exposes the inquiry brief endpoint and routes it live (not mock)', () => {
    const apiJs = read('js/api.js');
    t.assert(/bbInquiryBrief:\s*'\/api\/inquiry-brief'/.test(apiJs), 'ENDPOINTS.bbInquiryBrief is missing from js/api.js');
    t.assert(/'\/api\/inquiry-brief'/.test(apiJs.slice(apiJs.indexOf('LIVE_PREFIXES'), apiJs.indexOf('LIVE_PREFIXES') + 2000)),
      '/api/inquiry-brief must be listed in LIVE_PREFIXES or MOCK mode will silently fake it');
  });
} else {
  t.test('api/inquiry-brief.js exists (Inbox brief link, mirroring the Lead Brief)', () => {
    t.assert(false, 'api/inquiry-brief.js is missing — the Inbox has no equivalent of the Lead Brief link yet');
  });
}

/* ---- Auto-notification on lead/inquiry assignment (Ryan's ask) --------- */
// Assigning a lead or inquiry to an AM (emailing them the handoff) should
// also populate a shell Notification, so it's not just an email they might
// not see right away.

t.test('a username helper exists for turning an AM display name into a real account username', () => {
  t.assert(/function amUsername/.test(main), 'amUsername() is missing from main.js');
});

t.test('lead handoff creates a notification for the AM, best-effort and non-blocking', () => {
  t.assert(/function createLeadNotifications/.test(main), 'createLeadNotifications() is missing from main.js');
  const idx = main.indexOf('async function createLeadNotifications');
  const block = main.slice(idx, idx + 900);
  t.assert(/ENDPOINTS\.notifications/.test(block), 'createLeadNotifications() should POST to ENDPOINTS.notifications');
  t.assert(/types:\s*\["handoff"\]/.test(block), 'lead notifications should carry the "handoff" type tag');
  t.assert(/appIds:\s*\["backbone"\]/.test(block), 'lead notifications should be tagged to the backbone app');
  t.assert(/catch/.test(block),
    'createLeadNotifications() must catch its own failures — a notification hiccup should never interrupt a handoff email that already sent');
});

t.test('createLeadNotifications is called from both lead handoff paths (single-AM and multi-AM modal)', () => {
  const calls = (main.match(/createLeadNotifications\(/g) || []).length;
  // 1 for the definition itself is not a match (different signature: "function createLeadNotifications"),
  // so every match here is a real call site. Expect at least the two known paths.
  t.assert(calls >= 2, 'createLeadNotifications() should be called from both the single-AM auto-send path and the multi-AM handoff modal\'s Open Draft button — found ' + calls + ' call site(s)');
});

t.test('changing a lead\'s Account Manager on its own edit form also notifies the new AM', () => {
  // Ryan's ask, Aug 2026: the Account Manager dropdown on a lead's own edit
  // form (handleSaveLeadIntake, Save changes) was a silent path around the
  // handoff notification — reassigning a lead there never told anyone.
  t.assert(/async function handleSaveLeadIntake/.test(main), 'handleSaveLeadIntake() is missing from main.js');
  const idx = main.indexOf('async function handleSaveLeadIntake');
  const block = main.slice(idx, idx + 2000);
  t.assert(/const previousAM/.test(block),
    'handleSaveLeadIntake() should capture the AM before the save so it can tell whether it actually changed');
  t.assert(/createLeadNotifications\(\[lead\],\s*newAM/.test(block),
    'handleSaveLeadIntake() should call createLeadNotifications() for the newly-assigned AM');
  t.assert(/newAM\s*&&\s*newAM\s*!==\s*previousAM/.test(block),
    'the notification should only fire when the AM actually changed, not on every save of the form');
});

t.test('createLeadNotifications takes an optional title verb, so a reassignment reads differently than a new lead', () => {
  const idx = main.indexOf('async function createLeadNotifications');
  const block = main.slice(idx, idx + 700);
  t.assert(/function createLeadNotifications\(leads,\s*am,\s*titleVerb\)/.test(block),
    'createLeadNotifications() should accept a titleVerb parameter');
  t.assert(/titleVerb\s*\|\|\s*["']New lead["']/.test(block),
    'omitting titleVerb should keep the original "New lead: ..." wording for the handoff paths');
  t.assert(/"Lead assigned to you"/.test(main),
    'the Account Manager edit-form path should use a reassignment-specific title, not "New lead"');
});

t.test('inquiry email-to-AM creates a notification for that AM too', () => {
  t.assert(/function createInquiryNotification/.test(main), 'createInquiryNotification() is missing from main.js');
  const idx = main.indexOf('async function createInquiryNotification');
  const block = main.slice(idx, idx + 700);
  t.assert(/ENDPOINTS\.notifications/.test(block), 'createInquiryNotification() should POST to ENDPOINTS.notifications');
  t.assert(/catch/.test(block), 'createInquiryNotification() must catch its own failures, same as the lead version');
});

t.test('routing an inquiry (assignInquiryToAM) creates the notification independent of any email', () => {
  // Ryan's ask, Aug 9, 2026: not every inquiry gets emailed, so the
  // notification must not be a side effect of sending mail — assigning an
  // AM has to notify them on its own.
  t.assert(/async function assignInquiryToAM/.test(main), 'assignInquiryToAM() is missing from main.js');
  const idx = main.indexOf('async function assignInquiryToAM');
  const block = main.slice(idx, idx + 700);
  t.assert(/createInquiryNotification\(s, am\)/.test(block),
    'assignInquiryToAM() should call createInquiryNotification() directly — no email should be required to notify an AM');
  t.assert(!/generateInquiryBrief|openMailto/.test(block),
    'assignInquiryToAM() should not generate a brief or open a mailto — that is emailInquiryToAM()\'s job, kept separate on purpose');
});

t.test('emailing only notifies as a safety net for an inquiry that was not already assigned', () => {
  const idx = main.indexOf('async function emailInquiryToAM');
  const block = main.slice(idx, idx + 1600);
  t.assert(/alreadyAssigned/.test(block),
    'emailInquiryToAM() should track whether the AM was already assigned, so emailing an already-routed inquiry does not fire a duplicate notification');
  t.assert(/if \(!alreadyAssigned\) createInquiryNotification/.test(block),
    'emailInquiryToAM() should only call createInquiryNotification() when the inquiry was not already assigned to this AM');
});

t.test('no AM means no notification (an unrouted lead group has nothing to assign)', () => {
  const idx = main.indexOf('async function createLeadNotifications');
  const block = main.slice(idx, idx + 400);
  t.assert(/if \(!username/.test(block),
    'createLeadNotifications() should bail out quietly when there is no real AM username (e.g. the "Unassigned" group), not try to notify a blank assignee');
});

t.test('inquiry brief errors use err.message, never err.body.error directly', () => {
  // js/api.js's errorText() already handles the case where the server's error
  // payload is an object (Vercel platform errors come back as
  // { error: { code, message } }, not a string). Reading err.body.error
  // directly bypasses that safety net and can hand an object straight into a
  // template string — which is exactly how this showed up as the useless
  // "[object Object]" in an alert instead of the real failure reason.
  const idx = main.indexOf('async function generateInquiryBrief');
  const block = main.slice(idx, main.indexOf('}', main.indexOf('catch', idx)) + 1);
  t.assert(!/err\.body\.error/.test(block),
    'generateInquiryBrief() reads err.body.error directly again — this can be a non-string object and will render as "[object Object]"');
  t.assert(/err\.message/.test(block),
    'generateInquiryBrief() should fall back to err.message, which js/api.js already guarantees is a safe string');
});

/* ---- Routing an inquiry persists the AM, not just an email fire-and-forget --- */
// Ryan's ask (Aug 9, 2026): routing an inquiry needs to SAVE the account
// manager (survive a reload), not just fire an email that's forgotten.

t.test('emailInquiryToAM saves assignedAM/assignedAMAt on the inquiry and persists it', () => {
  const idx = main.indexOf('async function emailInquiryToAM');
  const block = main.slice(idx, idx + 1500);
  t.assert(/s\.assignedAM\s*=\s*am/.test(block), 'emailInquiryToAM() should set s.assignedAM = am');
  t.assert(/s\.assignedAMAt\s*=/.test(block), 'emailInquiryToAM() should stamp when the assignment happened');
  t.assert(/saveInbox\(\)/.test(block), 'the assignment must be persisted via saveInbox(), or it disappears on reload');
});

t.test('the AM picker remembers the saved assignment when the inquiry is reopened', () => {
  const idx = main.indexOf('Route this inquiry');
  const block = main.slice(idx, idx + 1300);
  t.assert(/s\.assignedAM === a/.test(block),
    'the AM <select> should pre-select s.assignedAM so re-opening a routed inquiry shows who it went to, not a blank picker');
});

t.test('the Inbox list shows an assigned-AM chip without needing to open the inquiry', () => {
  const idx = main.indexOf('const assignedChip');
  t.assert(idx !== -1, 'assignedChip is missing from the list-row renderer');
  const block = main.slice(idx, idx + 300);
  t.assert(/s\.assignedAM/.test(block), 'assignedChip should read s.assignedAM');
});

t.test('routing still creates the notification (save + notify happen together)', () => {
  const idx = main.indexOf('async function emailInquiryToAM');
  const block = main.slice(idx, idx + 1500);
  t.assert(/createInquiryNotification\(s, am\)/.test(block),
    'emailInquiryToAM() should still call createInquiryNotification — saving the AM should not have replaced notifying them');
});

/* ---- Inquiry detail view IS the brief card, not a separate plain list --- */
// Ryan's ask (Aug 9, 2026): the card that pops up when you click an inquiry
// should be the brief, matching the emailed one visually, not a plain
// field-by-field list next to it.

t.test('inquiryBriefHtml exists and is what renderInquiryBody actually renders', () => {
  t.assert(/function inquiryBriefHtml/.test(main), 'inquiryBriefHtml() is missing from main.js');
  const idx = main.indexOf('function renderInquiryBody');
  const block = main.slice(idx, idx + 700);
  t.assert(/inquiryBriefHtml\(s,/.test(block),
    'renderInquiryBody() should call inquiryBriefHtml() as its primary content, not build a separate plain field list');
  t.assert(/class="brief-sheet"/.test(block),
    'the inquiry detail view should wrap its content in .brief-sheet, the same token-based card system the AM/Dormant briefs already use');
});

t.test('the in-app brief card reuses the shell\'s token-based .brief-sheet classes, not hardcoded colors', () => {
  const idx = main.indexOf('function inquiryBriefHtml');
  const block = main.slice(idx, idx + 4000);
  t.assert(!/#[0-9A-Fa-f]{3,6}/.test(block),
    'inquiryBriefHtml() has a hardcoded hex color — it must use the existing .brief-sheet classes/CSS vars from styles.js instead, or it will fail the tokens-only color rule');
});

t.test('styles.js has the row/label classes inquiryBriefHtml() depends on', () => {
  t.assert(/\.brief-sheet \.row\{/.test(styles), '.brief-sheet .row is missing from styles.js');
  t.assert(/\.brief-sheet \.row-l\{/.test(styles), '.brief-sheet .row-l is missing from styles.js');
  t.assert(/\.brief-sheet \.row-v\{/.test(styles), '.brief-sheet .row-v is missing from styles.js');
  t.assert(/\.brief-sheet \.gate-pill\{/.test(styles), '.brief-sheet .gate-pill is missing from styles.js');
  t.assert(/\.brief-sheet \.sec-l\{/.test(styles), '.brief-sheet .sec-l is missing from styles.js');
});

t.test('bot screening warnings feed the brief card\'s own warning section instead of a duplicate box', () => {
  const idx = main.indexOf('function renderInquiryBody');
  const block = main.slice(idx, idx + 700);
  t.assert(/inquiryBriefHtml\(s, bot\.hits\)/.test(block),
    'renderInquiryBody() should pass bot.hits into inquiryBriefHtml() so there is one warnings section, not a separate qual-section box duplicating it');
});

t.test('the address mismatch check still gets its own async-updated placeholder inside the brief card', () => {
  const idx = main.indexOf('function renderInquiryBody');
  const block = main.slice(idx, idx + 1200);
  t.assert(/id="addrCheckBox"/.test(block),
    'the addrCheckBox placeholder is missing — verifyAddressClaims() has nothing to update asynchronously');
});

/* ---- contract clients (Aug 11, 2026) -------------------------------------
 * A visible tag for printing-only relationships that aren't a revenue focus.
 * Ryan's explicit call: this is a DISPLAY tag only. It must never change
 * scoring or tier math — a contract client still scores normally, it's just
 * marked wherever the company name shows up (Roster + Scorecard tables).
 */

t.test('contract_client is a real enrichment field, editable as a checkbox', () => {
  t.assert(/key:\s*"contract_client"/.test(main), 'contract_client is missing from ENRICHMENT_FIELDS');
  const idx = main.indexOf('key: "contract_client"');
  const line = main.slice(idx, idx + 200);
  t.assert(/type:\s*"checkbox"/.test(line), 'contract_client should render as a checkbox, not a text field or dropdown');
});

t.test('the enrichment form reads/writes checkboxes by .checked, not .value', () => {
  t.assert(/input\.checked = enrichment\[f\.key\] === true \|\| enrichment\[f\.key\] === "true"/.test(main),
    'openDetail() should set checkbox .checked from the stored value');
  t.assert(/el\.type === "checkbox" \? \(el\.checked \? "true" : ""\) : el\.value/.test(main),
    'handleSaveEnrichment() should read checkbox state via .checked, not .value (a checkbox\'s .value is always "on")');
});

t.test('isContractClient() and the badge are display-only — no scoring involvement', () => {
  t.assert(/function isContractClient\(customerId\)/.test(main), 'isContractClient() helper is missing');
  t.assert(/function contractBadgeHtml\(\)/.test(main), 'contractBadgeHtml() helper is missing');
  // The scoring functions (computeScorecard, the star-band helpers, SCORECARD_WEIGHTS) must not
  // reference contract_client anywhere — the flag is not allowed to touch the composite.
  const scoreFnIdx = main.indexOf('function computeScorecard');
  const scoreFnEnd = main.indexOf('\n  const TIER_COLORS', scoreFnIdx);
  const scoreBlock = main.slice(scoreFnIdx, scoreFnEnd > scoreFnIdx ? scoreFnEnd : scoreFnIdx + 4000);
  t.assert(!/contract_client/.test(scoreBlock), 'computeScorecard() must not reference contract_client — the tag is display-only, scoring is unaffected');
});

t.test('the contract badge is shown on both the Roster and Scorecard company cells', () => {
  t.assert(/company-cell">' \+ r\.company_name \+ \(isContractClient\(r\.customer_id\) \? contractBadgeHtml\(\) : ''\)/.test(main),
    'Roster company cell should show the contract badge when isContractClient() is true');
  t.assert(/sc-company company-cell[\s\S]{0,150}r\.company_name \+ \(isContractClient\(r\.customer_id\) \? contractBadgeHtml\(\) : ''\)/.test(main),
    'Scorecard company cell should show the contract badge when isContractClient() is true');
});

t.test('Scorecard has a "Hide contract clients" filter that only affects the visible rows, not the tier KPI counts', () => {
  t.assert(/id="scoreHideContract"/.test(template), 'scoreHideContract checkbox is missing from the Scorecard toolbar markup');
  t.assert(/scoreHideContract = e\.target\.checked/.test(main), 'the scoreHideContract checkbox is not wired up');
  const fnIdx = main.indexOf('function renderScorecard');
  const fnEnd = main.indexOf('\n  // ---- Dashboard', fnIdx);
  const block = main.slice(fnIdx, fnEnd > fnIdx ? fnEnd : fnIdx + 5000);
  t.assert(/tierCounts\[s\.tier\]\+\+/.test(block), 'sanity: tier KPI counts should iterate the full scored list');
  const tierCountsIdx = block.indexOf('scored.forEach');
  const hideFilterIdx = block.indexOf('scoreHideContract');
  t.assert(tierCountsIdx !== -1 && hideFilterIdx !== -1 && tierCountsIdx < hideFilterIdx,
    'the tier KPI count must be computed from the full `scored` list BEFORE the hide-contract filter runs, so hiding contract clients from the table never changes the KPI numbers above it');
});

process.exit(t.report());
