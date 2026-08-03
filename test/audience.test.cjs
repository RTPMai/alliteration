/**
 * MailMe audience, eligibility and compliance tests.
 *
 * Real function calls, with time INJECTED rather than read from the clock, so
 * "this customer is 100 days overdue" is a test that still passes next year.
 *
 * These cover the decisions that put a real email in front of a real person:
 * whether someone is genuinely due to reorder, whether they may be emailed at
 * all right now, and whether the message would be legal to send.
 */

const t = require('./harness.cjs');

import('../lib/mailme/audience.js').then((a) => {

  /* ---- reorder timing -------------------------------------------------- */

  const NOW = '2026-08-03T12:00:00.000Z';
  const cust = (over) => ({
    invoice_count: 10, median_gap_days: 30, last_invoice_date: '2026-07-01', ...over,
  });

  t.test('reorder state scales to each customer own cadence', () => {
    // A fixed "90 days" rule is wrong for nearly everyone. A school ordering
    // twice a year is not late at day 90; a contractor ordering fortnightly is.
    const fast = a.reorderStatus(cust({ median_gap_days: 14, last_invoice_date: '2026-07-01' }), { now: NOW });
    const slow = a.reorderStatus(cust({ median_gap_days: 180, last_invoice_date: '2026-07-01' }), { now: NOW });
    t.equal(fast.state, 'overdue', '33 days against a 14-day rhythm is overdue');
    t.equal(slow.state, 'not-due', 'the same 33 days against a 180-day rhythm is fine');
  });

  t.test('reorder thresholds land on the right bands', () => {
    const at = (days) => {
      const d = new Date(NOW); d.setUTCDate(d.getUTCDate() - days);
      return a.reorderStatus(cust({ median_gap_days: 30, last_invoice_date: d.toISOString() }), { now: NOW }).state;
    };
    t.equal(at(10), 'not-due', 'well inside the gap');
    t.equal(at(31), 'due', 'just past the gap');
    t.equal(at(50), 'overdue', 'half again past the gap');
    t.equal(at(100), 'lapsed', 'three times the gap is lost, not late');
  });

  t.test('a customer with too little history is unknown, never due', () => {
    // Two orders is not a pattern, and calling it "overdue" would put a nudge
    // in front of someone on the basis of noise.
    const r = a.reorderStatus(cust({ invoice_count: 2, last_invoice_date: '2020-01-01' }), { now: NOW });
    t.equal(r.state, 'unknown', 'too few orders must not produce a due state');
    t.equal(r.confident, false, 'and must be flagged unconfident');
  });

  t.test('an implausibly short median gap is not treated as a daily buyer', () => {
    // The real roster has accounts with median_gap_days under 1, which reflects
    // several invoices raised against one job rather than daily ordering.
    // Emailing them as overdue every afternoon would be embarrassing.
    const r = a.reorderStatus(cust({ median_gap_days: 0.0015 }), { now: NOW });
    t.equal(r.state, 'unknown', 'sub-day medians must not drive nudges');
  });

  t.test('a customer who never ordered is unknown, not lapsed', () => {
    const r = a.reorderStatus({ invoice_count: 0, last_invoice_date: null }, { now: NOW });
    t.equal(r.state, 'unknown', 'no order history means nothing to be late for');
  });

  /* ---- revenue trend --------------------------------------------------- */

  t.test('year-over-year prorates the prior year rather than comparing partials to totals', () => {
    // Comparing a partial year against a full one shows every account falling
    // each January. Prorating is what makes the comparison mean anything.
    const c = { revenue_by_year: { 2026: 30000, 2025: 60000 } };
    // Early August is ~59% through the year, so prior-year prorated is ~35k.
    const trend = a.revenueTrend(c, NOW);
    t.equal(trend.direction, 'flat', 'on pace should read flat, not down');
    const down = a.revenueTrend({ revenue_by_year: { 2026: 5000, 2025: 60000 } }, NOW);
    t.equal(down.direction, 'down', 'a genuine fall should still be caught');
  });

  /* ---- send eligibility ------------------------------------------------ */

  t.test('the frequency cap stops repeat emails across lists', () => {
    // Nothing else prevents one person receiving three campaigns in a week
    // because they happen to match three lists.
    const recent = { id: 'x', lastEmailedAt: '2026-08-01T00:00:00.000Z' };
    const old = { id: 'y', lastEmailedAt: '2026-06-01T00:00:00.000Z' };
    t.equal(a.sendEligibility(recent, { now: NOW }).ok, false, '2 days ago is inside a 14-day cap');
    t.equal(a.sendEligibility(old, { now: NOW }).ok, true, '2 months ago is fine');
  });

  t.test('accounts with an open quote are held back', () => {
    // Cold-blasting a prospect an AM is mid-deal with can cost the deal.
    const r = a.sendEligibility({ id: 'x', hasOpenQuote: true }, { now: NOW });
    t.equal(r.ok, false, 'an open quote should hold the contact back');
    t.assert(/quote/i.test(r.reason), 'the reason should say why');
  });

  t.test('addresses that failed verification are held back', () => {
    const r = a.sendEligibility({ id: 'x', verification: 'invalid' }, { now: NOW });
    t.equal(r.ok, false, 'invalid addresses must not be sent to');
  });

  t.test('held contacts are reported, never silently dropped', () => {
    const { send, held } = a.applyEligibility([
      { id: 'a' },
      { id: 'b', hasOpenQuote: true },
    ], { now: NOW });
    t.equal(send.length, 1, 'one sendable');
    t.equal(held.length, 1, 'one held');
    t.assert(held[0].heldReason, 'a held contact must carry its reason');
  });

  t.test('every eligibility rule can be turned off', () => {
    // Configurable over hardcoded: a person may legitimately want to override
    // any of these for one campaign.
    const policy = { skipOpenQuotes: false, skipInvalidVerification: false, minDaysBetweenEmails: 0 };
    const c = { id: 'x', hasOpenQuote: true, verification: 'invalid', lastEmailedAt: NOW };
    t.equal(a.sendEligibility(c, { now: NOW, policy }).ok, true,
      'with every rule disabled the contact should pass');
  });

  /* ---- cold ramp ------------------------------------------------------- */

  t.test('the cold daily cap ramps and then holds', () => {
    // Zero to hundreds of cold emails a day on a new domain is itself a spam
    // signal, so the cap climbs.
    const p = { coldDailyCapStart: 20, coldDailyCapMax: 200, coldRampDays: 30 };
    t.equal(a.coldDailyCap(0, p), 20, 'day one starts low');
    t.equal(a.coldDailyCap(15, p), 110, 'halfway is halfway');
    t.equal(a.coldDailyCap(30, p), 200, 'the ramp ends at the maximum');
    t.equal(a.coldDailyCap(999, p), 200, 'and never exceeds it');
  });

  /* ---- compliance ------------------------------------------------------ */

  t.test('a missing postal address blocks sending', () => {
    // The single most commonly missed CAN-SPAM requirement.
    const blockers = a.complianceBlockers({ fromName: 'P&M', unsubscribeUrl: 'https://x/u' });
    t.assert(blockers.some((b) => b.field === 'postalAddress'),
      'a missing postal address must be a hard blocker');
  });

  t.test('a missing unsubscribe link blocks sending', () => {
    const blockers = a.complianceBlockers({
      fromName: 'P&M',
      postalAddress: { line1: '1 Main', city: 'Ankeny', state: 'IA', postalCode: '50021' },
    });
    t.assert(blockers.some((b) => b.field === 'unsubscribeUrl'), 'opt-out is mandatory');
  });

  t.test('a fully configured sender has no blockers', () => {
    const ok = {
      fromName: 'P&M Apparel', unsubscribeUrl: 'https://x/unsubscribe.html',
      postalAddress: { line1: '1 Main St', city: 'Ankeny', state: 'IA', postalCode: '50021' },
    };
    t.equal(a.complianceBlockers(ok).length, 0, 'nothing should block a complete setup');
  });

  t.test('the footer carries the postal address and an opt-out link', () => {
    const footer = a.complianceFooter({
      companyName: 'P&M Apparel', unsubscribeUrl: 'https://x/unsubscribe.html',
      postalAddress: { line1: '1 Main St', city: 'Ankeny', state: 'IA', postalCode: '50021' },
    }, { unsubToken: 'abc' });
    t.assert(/Ankeny/.test(footer), 'the address must appear');
    t.assert(/unsubscribe\.html\?t=abc/.test(footer), 'the opt-out link must be personalized');
  });

  /* ---- reporting honesty ----------------------------------------------- */

  t.test('replies outrank clicks, and clicks outrank opens', () => {
    // For cold outreach a reply is the only outcome that means anything, and
    // opens are inflated by image pre-fetching that no human triggered.
    t.equal(a.primaryMetric({ replies: 3, uniqueClicks: 9, uniqueOpens: 90 }).key, 'replies',
      'replies should lead when present');
    t.equal(a.primaryMetric({ uniqueClicks: 9, uniqueOpens: 90 }).key, 'clicks',
      'clicks should lead over opens');
  });

  t.test('the open-rate caveat warns against segmenting on opens', () => {
    t.assert(/Apple Mail Privacy/i.test(a.OPEN_RATE_CAVEAT), 'the cause should be named');
    t.assert(/opened but did not click/i.test(a.OPEN_RATE_CAVEAT),
      'the caveat must warn against that specific segment');
  });

  process.exit(t.report());
}).catch((e) => {
  console.log('  FAIL could not import audience module: ' + e.message);
  process.exit(1);
});
