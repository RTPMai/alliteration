// PUT IN: test/inquiries.test.cjs
/**
 * Inquiry pipeline tests.
 *
 * These replace the status-ladder half of test/leads.test.cjs, which proved
 * things by running regular expressions over apps/backbone/main.js. That style
 * can only show that letters appear in a file. Every check below imports
 * lib/backbone/inquiries.js and calls the same function the screen calls, so a
 * change that breaks the behaviour turns the suite red even if the source
 * still reads plausibly.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const load = () => import(path.join(ROOT, 'lib/backbone/inquiries.js'));

// .cjs has no top-level await, so the whole file runs inside one async wrapper,
// the same shape test/crewcore-docs.test.cjs uses.

const DAY = 86400000;
const NOW = Date.parse('2026-09-04T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const ahead = (days) => new Date(NOW + days * DAY).toISOString();

(async () => {

/* ---- the ladder --------------------------------------------------------- */

await t.test('the ladder is the inbound sequence and carries no cold-call stages', async () => {
  const { INQUIRY_STATUSES } = await load();
  t.equal(INQUIRY_STATUSES.join(' > '),
    'New > Assigned > Responded > Quoted > Reach Back Out > Won > Lost',
    'ladder changed');
  for (const gone of ['Researching', 'Qualified', 'Contacted 1st', 'Contacted 2nd', 'Death Call', 'AM Notified']) {
    t.assert(INQUIRY_STATUSES.indexOf(gone) === -1, gone + ' is an outbound stage and must not be on the ladder');
  }
});

await t.test('Quoted exists, because a price being out is its own stage', async () => {
  const { INQUIRY_STATUSES, ACTIVE_STATUSES } = await load();
  t.assert(INQUIRY_STATUSES.indexOf('Quoted') !== -1, 'Quoted missing from the ladder');
  t.assert(ACTIVE_STATUSES.indexOf('Quoted') !== -1, 'a live quote is active work');
});

await t.test('parked is not active work', async () => {
  const { ACTIVE_STATUSES, isActive } = await load();
  t.assert(ACTIVE_STATUSES.indexOf('Reach Back Out') === -1,
    'Reach Back Out is parked on purpose and must not inflate the active count');
  t.assert(isActive({ status: 'Assigned' }), 'Assigned is active');
  t.assert(!isActive({ status: 'New' }), 'nobody owns a New inquiry yet');
  t.assert(!isActive({ status: 'Won' }), 'Won is finished');
});

/* ---- legacy records ----------------------------------------------------- */

await t.test('every retired stage maps to a stage that exists', async () => {
  const { normalizeInquiryStatus, INQUIRY_STATUSES } = await load();
  const retired = ['Dead', 'Researching', 'Qualified', 'Contacted',
    'Contacted 1st', 'Contacted 2nd', 'Death Call', 'AM Notified'];
  for (const old of retired) {
    const mapped = normalizeInquiryStatus(old);
    t.assert(INQUIRY_STATUSES.indexOf(mapped) !== -1,
      old + ' mapped to "' + mapped + '", which is not a real stage');
  }
});

await t.test('the cold stages collapse down, never forward into Quoted', async () => {
  const { normalizeInquiryStatus } = await load();
  t.equal(normalizeInquiryStatus('Contacted 1st'), 'Responded', 'first call');
  t.equal(normalizeInquiryStatus('Contacted 2nd'), 'Responded', 'second call');
  t.equal(normalizeInquiryStatus('Death Call'), 'Responded',
    'Death Call looks furthest along but no price was ever sent, so it cannot become Quoted');
  t.equal(normalizeInquiryStatus('AM Notified'), 'Assigned', 'an AM owning it is Assigned');
  t.equal(normalizeInquiryStatus('Dead'), 'Lost', 'the old exit bucket');
});

await t.test('the two decide-whether-to-bother stages go back to New', async () => {
  const { normalizeInquiryStatus } = await load();
  t.equal(normalizeInquiryStatus('Researching'), 'New');
  t.equal(normalizeInquiryStatus('Qualified'), 'New');
});

await t.test('a blank or unrecognized status surfaces as New rather than hiding', async () => {
  const { normalizeInquiryStatus } = await load();
  t.equal(normalizeInquiryStatus(''), 'New');
  t.equal(normalizeInquiryStatus(undefined), 'New');
  t.equal(normalizeInquiryStatus('Marinating'), 'New',
    'an unknown stage must land somewhere the filters actually list');
});

await t.test('a current status is returned untouched', async () => {
  const { normalizeInquiryStatus, INQUIRY_STATUSES } = await load();
  for (const s of INQUIRY_STATUSES) t.equal(normalizeInquiryStatus(s), s, s + ' was rewritten');
});

/* ---- the status trail --------------------------------------------------- */

await t.test('a status change is stamped onto the record', async () => {
  const { setInquiryStatus } = await load();
  const rec = { status: 'New' };
  setInquiryStatus(rec, 'Assigned', NOW);
  t.equal(rec.status, 'Assigned');
  t.equal(rec.status_history.length, 1, 'the change must leave a trail');
  t.equal(rec.status_history[0].status, 'Assigned');
  t.equal(rec.status_history[0].at, new Date(NOW).toISOString());
});

await t.test('setting the status it already has writes nothing', async () => {
  const { setInquiryStatus } = await load();
  const rec = { status: 'Quoted', status_history: [{ status: 'Quoted', at: ago(3) }] };
  setInquiryStatus(rec, 'Quoted', NOW);
  t.equal(rec.status_history.length, 1,
    'a no-op save must not reset the clock on a stage the record never left');
});

await t.test('a legacy status set through the trail is normalized first', async () => {
  const { setInquiryStatus } = await load();
  const rec = { status: 'New' };
  setInquiryStatus(rec, 'Death Call', NOW);
  t.equal(rec.status, 'Responded', 'a retired name must never be written back to storage');
});

/* ---- staleness ---------------------------------------------------------- */

await t.test('an unanswered assignment flags in two days', async () => {
  const { isStalled, STAGE_STALE_DAYS } = await load();
  t.equal(STAGE_STALE_DAYS.Assigned, 2,
    'somebody asked us for something and has not been answered; this is the tight one');
  const rec = { status: 'Assigned', status_history: [{ status: 'Assigned', at: ago(3) }] };
  t.assert(isStalled(rec, NOW), 'three days unanswered must flag');
  const fresh = { status: 'Assigned', status_history: [{ status: 'Assigned', at: ago(1) }] };
  t.assert(!isStalled(fresh, NOW), 'one day is not stale');
});

await t.test('a live quote gets the longest rope, because the clock is the customer\'s', async () => {
  const { isStalled, STAGE_STALE_DAYS } = await load();
  t.assert(STAGE_STALE_DAYS.Quoted > STAGE_STALE_DAYS.Assigned,
    'waiting on a customer to decide is not the same as leaving them unanswered');
  const rec = { status: 'Quoted', status_history: [{ status: 'Quoted', at: ago(6) }] };
  t.assert(!isStalled(rec, NOW), 'six days on a quote is normal');
  const old = { status: 'Quoted', status_history: [{ status: 'Quoted', at: ago(12) }] };
  t.assert(isStalled(old, NOW), 'twelve days is a quote nobody chased');
});

await t.test('stages with no clock never flag', async () => {
  const { isStalled } = await load();
  for (const s of ['New', 'Won', 'Lost', 'Reach Back Out']) {
    const rec = { status: s, status_history: [{ status: s, at: ago(400) }] };
    t.assert(!isStalled(rec, NOW), s + ' has no stage clock and must not flag');
  }
});

await t.test('a record older than the trail still reports its real age', async () => {
  const { daysInStage } = await load();
  t.equal(daysInStage({ status: 'Assigned', created_at: ago(9) }, NOW), 9,
    'pre-trail records must fall back to created_at, not report nothing');
});

await t.test('the trail beats created_at when both are there', async () => {
  const { daysInStage } = await load();
  const rec = { created_at: ago(90), status_history: [{ status: 'Quoted', at: ago(4) }] };
  t.equal(daysInStage(rec, NOW), 4, 'age in stage is not age of record');
});

await t.test('an unparseable date reports nothing rather than a made-up number', async () => {
  const { daysInStage, isStalled } = await load();
  t.equal(daysInStage({ created_at: 'sometime last spring' }, NOW), null);
  t.assert(!isStalled({ status: 'Assigned', created_at: 'nonsense' }, NOW),
    'a bad date must not manufacture a flag');
});

/* ---- reach back out ----------------------------------------------------- */

await t.test('a parked inquiry with no date is due now, so it cannot hide', async () => {
  const { reachBackDue } = await load();
  t.assert(reachBackDue({ status: 'Reach Back Out' }, NOW), 'no date means due');
  t.assert(reachBackDue({ status: 'Reach Back Out', reach_back_at: 'garbage' }, NOW),
    'an unreadable date must not become a hiding place either');
});

await t.test('a parked inquiry comes due on its date and not before', async () => {
  const { reachBackDue } = await load();
  t.assert(!reachBackDue({ status: 'Reach Back Out', reach_back_at: ahead(10) }, NOW), 'not yet');
  t.assert(reachBackDue({ status: 'Reach Back Out', reach_back_at: ago(1) }, NOW), 'due');
});

await t.test('only parked inquiries are ever due', async () => {
  const { reachBackDue } = await load();
  t.assert(!reachBackDue({ status: 'Quoted', reach_back_at: ago(30) }, NOW),
    'a stray date on another stage must not make it due');
});

/* ---- the funnel --------------------------------------------------------- */

await t.test('the funnel draws every stage and rolls nothing up', async () => {
  const { FUNNEL_STAGES, INQUIRY_STATUSES } = await load();
  t.equal(FUNNEL_STAGES.length, INQUIRY_STATUSES.length,
    'a stage the funnel cannot draw is a stage nobody can filter to');
  for (const s of FUNNEL_STAGES) {
    t.assert(INQUIRY_STATUSES.indexOf(s.name) !== -1, s.name + ' is not a real stage');
    t.assert(!s.statuses, s.name + ' is a rollup; the roll-up special case was removed with the cold stages');
  }
});

await t.test('funnel colors are tokens, never hex', async () => {
  const { FUNNEL_STAGES } = await load();
  for (const s of FUNNEL_STAGES) {
    t.assert(/^var\(--[a-z-]+\)$/.test(s.color), s.name + ' must use a token, not "' + s.color + '"');
  }
});

/* ---- what they asked for ------------------------------------------------ */

await t.test('an ongoing store outranks four hats for a golf outing', async () => {
  const { askScore } = await load();
  const store = askScore({ project: { type: 'online_store', store_kind: 'state_store' } }, NOW);
  const few = askScore({ project: { type: 'just_a_few' } }, NOW);
  t.assert(store.pct > few.pct,
    'this comparison is the whole reason the ask is scored at all: ' + store.pct + ' vs ' + few.pct);
});

await t.test('a pop-up store scores below a standing one', async () => {
  const { askScore } = await load();
  const standing = askScore({ project: { type: 'online_store', store_kind: 'catalog' } }, NOW);
  const popup = askScore({ project: { type: 'online_store', store_kind: 'pop_up' } }, NOW);
  t.assert(standing.pct > popup.pct, 'one that reorders forever is worth more than one that runs once');
});

await t.test('missing is not zero: blanks leave the denominator, they do not score low', async () => {
  const { askScore } = await load();
  const bare = askScore({ project: { type: 'bulk_merch' } }, NOW);
  t.equal(bare.scored.length, 2, 'only the two things the project type answers');
  t.equal(bare.unknown.length, 3, 'the rest must be reported unknown, not scored');
  t.equal(bare.max, 10, 'the denominator counts answered dimensions only');
  const full = askScore({
    entry: { existing_client: 'no' },
    project: { type: 'bulk_merch', in_hands_date: ahead(30), details: { audience_size: '40' } },
  }, NOW);
  t.assert(full.max > bare.max, 'answering more questions must widen the denominator');
});

await t.test('a customer who typed almost nothing is not ranked as the worst prospect', async () => {
  const { askScore } = await load();
  const terse = askScore({ project: { type: 'online_store', store_kind: 'state_store' } }, NOW);
  t.assert(terse.pct >= 90,
    'a big ask stated briefly must still score as a big ask, got ' + terse.pct);
});

await t.test('an empty submission scores null, which is not the same as zero', async () => {
  const { askScore } = await load();
  const empty = askScore({}, NOW);
  t.equal(empty.pct, null, 'nothing answerable must report null');
  t.equal(empty.max, 0);
  const none = askScore(null, NOW);
  t.equal(none.pct, null, 'a missing submission must not throw');
});

await t.test('quantity moves the score and reads a written-out number', async () => {
  const { askScore } = await load();
  const big = askScore({ project: { type: 'bulk_merch', details: { audience_size: '1,200 employees' } } }, NOW);
  const small = askScore({ project: { type: 'bulk_merch', details: { audience_size: '12' } } }, NOW);
  t.assert(big.pct > small.pct, 'twelve hundred shirts is not twelve shirts');
});

await t.test('a comfortable lead time beats a rush', async () => {
  const { askScore } = await load();
  const roomy = askScore({ project: { type: 'bulk_promo', in_hands_date: ahead(30) } }, NOW);
  const rush = askScore({ project: { type: 'bulk_promo', in_hands_date: ahead(4) } }, NOW);
  t.assert(roomy.pct > rush.pct, 'a rush costs the floor more and rarely repeats');
});

await t.test('a date in the past is treated as no date, not as maximum urgency', async () => {
  const { askScore } = await load();
  const past = askScore({ project: { type: 'bulk_promo', in_hands_date: ago(200) } }, NOW);
  const none = askScore({ project: { type: 'bulk_promo' } }, NOW);
  t.equal(past.max, none.max, 'a mistyped year must drop out, not score');
});

await t.test('an existing client asking for something new scores highest on relationship', async () => {
  const { askScore } = await load();
  const known = askScore({ entry: { existing_client: 'yes_new' }, project: { type: 'bulk_merch' } }, NOW);
  const stranger = askScore({ entry: { existing_client: 'no' }, project: { type: 'bulk_merch' } }, NOW);
  t.assert(known.pct > stranger.pct, 'the cheapest revenue in the building');
});

/* ---- the combined score ------------------------------------------------- */

await t.test('the two schema versions of the research score both convert to a percentage', async () => {
  const { fitPct } = await load();
  t.equal(fitPct({ qualification_scoring: { total_score: 25 } }), 50, 'v1 runs to 50');
  t.equal(fitPct({ schema_version: '2.0', qualification_scoring: { total_score: 25 } }), 25, 'v2 runs to 100');
  t.equal(fitPct(null), null, 'never researched');
  t.equal(fitPct({ qualification_scoring: {} }), null, 'a scoring block with no total is not a zero');
});

await t.test('either half alone is still an answer', async () => {
  const { combinedScore } = await load();
  const askOnly = combinedScore(null, { project: { type: 'online_store', store_kind: 'catalog' } }, NOW);
  t.equal(askOnly.basis, 'ask');
  t.assert(askOnly.pct != null, 'an unresearched inquiry still deserves a number off what they told us');

  const fitOnly = combinedScore({ qualification_scoring: { total_score: 40 } }, {}, NOW);
  t.equal(fitOnly.basis, 'fit');
  t.equal(fitOnly.pct, 80, 'a researched company who typed nothing still deserves its research number');
});

await t.test('with both halves the blend is even and reported as such', async () => {
  const { combinedScore, FIT_WEIGHT } = await load();
  t.equal(FIT_WEIGHT, 0.5, 'the weight is a judgment, kept in one named place');
  const r = combinedScore(
    { qualification_scoring: { total_score: 50 } },
    { project: { type: 'just_a_few' } },
    NOW);
  t.equal(r.basis, 'both');
  t.equal(r.fit, 100);
  t.equal(r.pct, Math.round(100 * 0.5 + r.ask * 0.5), 'the blend must be the stated one');
  t.assert(r.pct < 100, 'a perfect company asking for four hats is not a perfect inquiry');
});

await t.test('a record with neither half scores null and never draws as zero', async () => {
  const { combinedScore, inquiryPriority } = await load();
  const r = combinedScore(null, {}, NOW);
  t.equal(r.pct, null);
  t.equal(r.basis, 'none');
  t.equal(inquiryPriority(null), 'Unscored', 'unscored must read as unscored, not as Low');
});

await t.test('priority bands read as triage words, not as account tiers', async () => {
  const { inquiryPriority } = await load();
  t.equal(inquiryPriority(90), 'Hot');
  t.equal(inquiryPriority(60), 'Strong');
  t.equal(inquiryPriority(40), 'Standard');
  t.equal(inquiryPriority(10), 'Low');
});

/* ---- the summary handed to the research agent ---------------------------- */

await t.test('the ask summary describes what the scorer actually saw', async () => {
  const { askSummary } = await load();
  const text = askSummary({
    project: {
      type: 'bulk_merch', name: 'Staff polos', in_hands_date: '2026-10-04',
      details: { audience_size: '30' },
    },
  }, { bulk_merch: 'Bulk Merch' });
  t.assert(text.indexOf('Bulk Merch') !== -1, 'the project type must be named in words');
  t.assert(text.indexOf('30') !== -1, 'the quantity the volume score read must appear');
  t.assert(text.indexOf('2026-10-04') !== -1, 'the date the lead-time score read must appear');
});

await t.test('nothing asked for produces an empty summary, not a fabricated one', async () => {
  const { askSummary } = await load();
  t.equal(askSummary({}, {}), '', 'the route substitutes its own wording for this');
  t.equal(askSummary(null, {}), '');
});

/* ---- adoption ----------------------------------------------------------- */

const SUB = {
  id: 'sub_1',
  submitted_at: ago(2),
  entry: { existing_client: 'no', source: { channel: 'Google', detail: 'searched screen printing' } },
  company: { name: 'Prairie Trail Dental', industry: 'Healthcare' },
  contact: { name: 'Dana Reyes Ortiz', email: 'dana@ptdental.com', phone: '515-555-0134', url: 'https://ptdental.com' },
  project: {
    name: 'Staff polos', type: 'bulk_merch', in_hands_date: ahead(30),
    description: 'Embroidered polos for the whole office.',
    details: { audience_size: '30', csg_waiver_accepted: true },
  },
};

await t.test('adoption carries the contact, the company and the project across', async () => {
  const { inquiryFromSubmission } = await load();
  const rec = inquiryFromSubmission(SUB, { now: NOW, id: 'lead_x' });
  t.equal(rec.company_name, 'Prairie Trail Dental');
  t.equal(rec.contact_email, 'dana@ptdental.com');
  t.equal(rec.industry, 'Healthcare');
  t.equal(rec.from_inquiry_id, 'sub_1', 'the record must point back at the submission it came from');
  t.equal(rec.status, 'New');
});

await t.test('the contact name is split, because the roster stores first and last', async () => {
  const { inquiryFromSubmission } = await load();
  const rec = inquiryFromSubmission(SUB, { now: NOW });
  t.equal(rec.contact_first_name, 'Dana');
  t.equal(rec.contact_last_name, 'Reyes Ortiz', 'a two-word surname must not lose its second word');
});

await t.test('the whole submission rides along rather than being flattened into notes', async () => {
  const { inquiryFromSubmission, askScore } = await load();
  const rec = inquiryFromSubmission(SUB, { now: NOW });
  t.assert(rec.intake_submission, 'the submission must survive adoption');
  const fromRecord = askScore(rec.intake_submission, NOW);
  const fromSource = askScore(SUB, NOW);
  t.equal(fromRecord.pct, fromSource.pct,
    'the ask must still be scoreable from the record, or the score freezes at adoption time');
});

await t.test('adoption keeps the submitted date, not the date somebody clicked', async () => {
  const { inquiryFromSubmission } = await load();
  const rec = inquiryFromSubmission(SUB, { now: NOW });
  t.equal(rec.created_at, SUB.submitted_at,
    'an inquiry that sat unread for a week is a week old, and the stale clocks depend on it');
});

await t.test('an existing client is sourced as account expansion, a stranger as the form', async () => {
  const { inquiryFromSubmission } = await load();
  t.equal(inquiryFromSubmission(SUB, { now: NOW }).source_type, 'Website form');
  const known = Object.assign({}, SUB, { entry: { existing_client: 'yes_new' } });
  t.equal(inquiryFromSubmission(known, { now: NOW }).source_type, 'Existing account expansion');
  const manual = Object.assign({}, SUB, { entry: { existing_client: 'manual' } });
  t.equal(inquiryFromSubmission(manual, { now: NOW }).source_type, 'Inbound quote request');
});

await t.test('no adopted record is ever stamped as outbound prospecting', async () => {
  const { inquiryFromSubmission } = await load();
  for (const gate of ['no', 'yes', 'yes_new', 'not_sure', 'manual', undefined]) {
    const rec = inquiryFromSubmission(Object.assign({}, SUB, { entry: { existing_client: gate } }), { now: NOW });
    t.assert(rec.source_type !== 'Outbound prospecting',
      'the outbound source was retired with the cold pipeline');
    t.assert(rec.source_type, 'every record needs a source, gate ' + String(gate));
  }
});

await t.test('the legal waiver checkbox stays out of the handoff notes', async () => {
  const { inquiryFromSubmission } = await load();
  const rec = inquiryFromSubmission(SUB, { now: NOW });
  t.assert(rec.inquiry_notes.indexOf('waiver') === -1,
    'a signed waiver is not context an account manager reads');
  t.assert(rec.inquiry_notes.indexOf('audience size: 30') !== -1, 'real detail must carry across');
  t.assert(rec.inquiry_notes.indexOf('Heard about us: Google, searched screen printing') !== -1,
    'attribution must survive the handoff');
});

await t.test('the summary reads an adopted record as happily as a raw submission', async () => {
  const { askSummary, inquiryFromSubmission } = await load();
  const rec = inquiryFromSubmission(SUB, { now: NOW });
  t.equal(askSummary(rec, {}), askSummary(SUB, {}),
    'a filed inquiry and the submission it came from must describe the same ask');
});

await t.test('an AM assigned before filing survives into the record', async () => {
  const { inquiryFromSubmission } = await load();
  const assigned = Object.assign({}, SUB, { assignedAM: 'Alexis Davis', assignedAMAt: ago(1) });
  const rec = inquiryFromSubmission(assigned, { now: NOW });
  t.equal(rec.account_manager, 'Alexis Davis',
    'losing this sends the row back to being routed by industry as though nobody had chosen');
  t.equal(rec.assigned_at, assigned.assignedAMAt);
});

await t.test('an unassigned submission carries no account manager', async () => {
  const { inquiryFromSubmission } = await load();
  const rec = inquiryFromSubmission(SUB, { now: NOW });
  t.equal(rec.account_manager, '', 'an empty string, so industry routing still applies');
  t.equal(rec.assigned_at, null);
});

await t.test('an all-but-empty submission still adopts without throwing', async () => {
  const { inquiryFromSubmission } = await load();
  const rec = inquiryFromSubmission({ id: 'sub_2' }, { now: NOW });
  t.equal(rec.company_name, '(from inquiry)', 'a nameless submission still needs a handle');
  t.equal(rec.status, 'New');
  t.assert(Array.isArray(rec.status_history), 'the trail must start empty, not undefined');
});

const code = t.report();
process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL inquiries tests could not run: ' + ((e && e.stack) || e));
  process.exit(1);
});
