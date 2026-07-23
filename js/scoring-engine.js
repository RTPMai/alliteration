/**
 * GivingGauge — Donation & Sponsorship Scoring Engine
 * P&M Apparel
 *
 * Deterministic implementation of the master prompt §5–§7.
 * No LLM reasoning in here. Input = structured request + Apparelytics facts.
 * Output = disqualifiers, per-dimension scores, modifier, total, grade, decision.
 *
 * The LLM's remaining job: parse the form into `request`, resolve fuzzy customer
 * matches into `account`, and write the prose. Not the math.
 *
 * Version 1.0
 */

'use strict';

/* ------------------------------------------------------------------ *
 * CONSTANTS
 * ------------------------------------------------------------------ */

const LEAD_TIME_FLOOR_DAYS = 21;

const HOME_METRO = [
  'ankeny', 'des moines', 'west des moines', 'urbandale', 'johnston',
  'clive', 'altoona', 'bondurant', 'polk city', 'grimes', 'waukee', 'ames'
];

// Polk + contiguous counties — "Regional" tier.
const REGIONAL_COUNTIES = [
  'polk', 'dallas', 'story', 'boone', 'jasper', 'marion', 'warren', 'madison'
];

const DIMENSION_MAX = {
  relationship: 28,
  spend: 18,
  cadence: 9,
  region: 10,
  mission: 18,
  exposure: 12,
  revenueAttach: 5
};

const TOTAL_MAX = 100; // sum of the above

const GRADE_BANDS = [
  { min: 85, grade: 'A', decision: 'Approve' },
  { min: 70, grade: 'B', decision: 'Approve' },
  { min: 55, grade: 'C', decision: 'Approve with Conditions' },
  { min: 40, grade: 'D', decision: 'Decline' },
  { min: 0,  grade: 'F', decision: 'Decline' }
];

/* ------------------------------------------------------------------ *
 * HELPERS
 * ------------------------------------------------------------------ */

function norm(s) {
  return (s == null ? '' : String(s)).trim().toLowerCase();
}

function daysBetween(fromISO, toISO) {
  const MS = 86400000;
  const a = Date.parse(fromISO + 'T00:00:00Z');
  const b = Date.parse(toISO + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / MS);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Days until the event, computed from the request — never trusted to the
 * submitter. Returns null if the date is missing or unparseable.
 */
function computeDaysOut(request, today) {
  if (!request.eventDate) return null;
  return daysBetween(today, request.eventDate);
}

/* ------------------------------------------------------------------ *
 * §5 — HARD DISQUALIFIERS
 * ------------------------------------------------------------------ */

/**
 * Returns an array of triggered disqualifiers. Non-empty = auto-decline,
 * grade F, no further scoring.
 *
 * Note on religious orgs (§5.2): a religious-AFFILIATED school or a church
 * that is already a customer is NOT auto-declined — it is escalated. The
 * engine surfaces `review` entries separately from `disqualifiers` so the
 * owners make that call rather than the model.
 */
function evaluateDisqualifiers(request, account, daysOut) {
  const dq = [];
  const review = [];

  const orgType = norm(request.orgType);

  // 1. Political
  if (request.isPolitical === true || orgType === 'political') {
    dq.push({
      code: 'POLITICAL',
      label: 'Political organization',
      detail: 'Candidate, campaign, PAC, party, or partisan advocacy org.'
    });
  }

  // 2. Religious — with the customer / secular-ask nuance
  if (request.isReligious === true || orgType === 'religious') {
    const isCustomer = !!(account && account.found);
    const secularAsk = request.askIsSecular === true;
    if (isCustomer || secularAsk) {
      review.push({
        code: 'RELIGIOUS_REVIEW',
        label: 'Religious affiliation — owner review',
        detail: isCustomer
          ? 'Religious-affiliated org is a current customer. Do not auto-decline a client. Owners decide.'
          : 'Religious affiliation, but the ask itself is secular in purpose. Owners decide.'
      });
    } else {
      dq.push({
        code: 'RELIGIOUS',
        label: 'Religious organization',
        detail: 'Church, ministry, or faith-based fundraiser; ask is not secular and org is not a customer.'
      });
    }
  }

  // 3. Out of region
  const state = norm(request.state);
  if (state && state !== 'ia' && state !== 'iowa') {
    const meaningful = account && account.found &&
      account.matchConfidence === 'Confirmed' &&
      (account.lifetimeRevenue || 0) >= 10000;
    if (meaningful) {
      review.push({
        code: 'OUT_OF_STATE_CUSTOMER',
        label: 'Out of state — confirmed customer, owner override available',
        detail: 'Outside Iowa but a confirmed account with meaningful spend. Region scores 0; owners may override.'
      });
    } else {
      dq.push({
        code: 'OUT_OF_REGION',
        label: 'Out of region',
        detail: 'Outside Iowa with no confirmed customer relationship.'
      });
    }
  }

  // 4. Monetary-only ask
  if (request.monetaryOnly === true) {
    dq.push({
      code: 'MONETARY',
      label: 'Monetary ask',
      detail: 'Request is for cash and requester will not accept in-kind. P&M does not sponsor monetarily.'
    });
  }

  // 5. Competitor
  if (request.isCompetitor === true) {
    dq.push({
      code: 'COMPETITOR',
      label: 'Competitor',
      detail: 'Decorated-apparel or promo-products business, or would resell donated goods.'
    });
  }

  // 6. Lead time — the hard floor
  if (daysOut === null) {
    review.push({
      code: 'NO_EVENT_DATE',
      label: 'No event date supplied',
      detail: 'Lead time cannot be verified. Treat as a data gap, not a pass.'
    });
  } else if (daysOut < LEAD_TIME_FLOOR_DAYS) {
    dq.push({
      code: 'LEAD_TIME',
      label: `Insufficient lead time — ${daysOut} days out`,
      detail: `Below the ${LEAD_TIME_FLOOR_DAYS}-day floor. Capacity decline regardless of fit. They may reapply next year with more notice.`
    });
  }

  // 7. EIN mismatch
  if (request.einMismatch === true) {
    dq.push({
      code: 'EIN_MISMATCH',
      label: 'EIN mismatch',
      detail: 'Exempt status claimed but the EIN does not correspond to the named org. Credibility failure.'
    });
  }

  return { disqualifiers: dq, review };
}

/* ------------------------------------------------------------------ *
 * §6A — CUSTOMER RELATIONSHIP (28)
 * ------------------------------------------------------------------ */

const TIER_ACTIVE_POINTS = {
  platinum: 28,
  gold: 24,
  silver: 18,
  bronze: 13
};

function scoreRelationship(account) {
  const flags = [];

  if (!account || !account.found) {
    return {
      points: 0,
      max: DIMENSION_MAX.relationship,
      reason: 'Not a customer. No record in Apparelytics.',
      flags
    };
  }

  const tier = norm(account.tier);
  const lifetime = account.lifetimeRevenue || 0;
  const median = account.medianGapDays;
  const since = account.daysSinceLastOrder;

  const dormant = since != null && since >= 548; // 18 months
  const overdue = median != null && since != null && since > 2 * median;

  if (dormant) {
    if (lifetime >= 10000) {
      flags.push({
        code: 'DORMANT_MEANINGFUL',
        severity: 'red',
        label: 'Dormant account with meaningful history',
        detail: `No order in ${since} days on $${lifetime.toLocaleString()} lifetime. ${
          account.owner ? account.owner : 'An account rep'
        } should make contact and open a quote conversation before we commit product.`
      });
      return {
        points: 8,
        max: DIMENSION_MAX.relationship,
        reason: `Dormant (${since} days) but $${lifetime.toLocaleString()} lifetime. Touchpoint required before granting.`,
        flags
      };
    }
    return {
      points: 4,
      max: DIMENSION_MAX.relationship,
      reason: `Dormant (${since} days), limited history ($${lifetime.toLocaleString()} lifetime).`,
      flags
    };
  }

  const base = TIER_ACTIVE_POINTS[tier];

  if (base == null) {
    // Customer on file but no tier assigned — newer or smaller account.
    // Do not infer a tier. Score conservatively.
    flags.push({
      code: 'NO_TIER',
      severity: 'amber',
      label: 'No tier assigned in Apparelytics',
      detail: 'Newer or smaller account. Scored conservatively rather than inferring a tier.'
    });
    return {
      points: overdue ? 0 : 6,
      max: DIMENSION_MAX.relationship,
      reason: 'Customer on file, no tier assigned. Scored conservatively.',
      flags
    };
  }

  if (overdue) {
    flags.push({
      code: 'REENGAGEMENT',
      severity: 'amber',
      label: 'Re-engagement opportunity',
      detail: `${since} days since last order against a ${median}-day median gap. Overdue by ${
        since - median
      } days.`
    });
    return {
      points: clamp(base - 6, 0, DIMENSION_MAX.relationship),
      max: DIMENSION_MAX.relationship,
      reason: `${account.tier}, overdue (${since}d vs ${median}d median). Base less 6.`,
      flags
    };
  }

  return {
    points: base,
    max: DIMENSION_MAX.relationship,
    reason: `${account.tier}, active and on cadence.`,
    flags
  };
}

/* ------------------------------------------------------------------ *
 * §6B — SPEND WEIGHT (18) + YTD modifier
 * ------------------------------------------------------------------ */

function scoreSpend(account) {
  const flags = [];

  if (!account || !account.found) {
    return { points: 0, max: DIMENSION_MAX.spend, reason: 'Not a customer.', flags };
  }

  const lt = account.lifetimeRevenue || 0;
  let base;
  if (lt >= 100000) base = 18;
  else if (lt >= 50000) base = 14;
  else if (lt >= 25000) base = 11;
  else if (lt >= 10000) base = 7;
  else if (lt >= 2500) base = 4;
  else base = 0;

  let mod = 0;
  const parts = [`$${lt.toLocaleString()} lifetime`];

  const ytd = account.ytdRevenue;
  const prior = account.priorYtdRevenue;

  if (account.isFirstYear === true && account.trendingStrong === true) {
    mod = 2;
    parts.push('first year, trending strong (+2)');
  } else if (ytd != null && prior != null && prior > 0) {
    if (ytd > prior) {
      mod = 3;
      parts.push('YTD ahead of prior year (+3)');
    } else if (ytd < prior * 0.6) {
      mod = -3;
      parts.push('YTD down more than 40% (−3)');
      flags.push({
        code: 'SHRINKING_ACCOUNT',
        severity: 'amber',
        label: 'Account is shrinking',
        detail: `YTD $${ytd.toLocaleString()} against $${prior.toLocaleString()} the same period last year. A shrinking account asking for free product is a conversation, not a gift.`
      });
    }
  }

  return {
    points: clamp(base + mod, 0, DIMENSION_MAX.spend),
    max: DIMENSION_MAX.spend,
    reason: parts.join('; ') + '.',
    flags
  };
}

/* ------------------------------------------------------------------ *
 * §6C — CADENCE & ORDER HEALTH (9)
 * ------------------------------------------------------------------ */

function scoreCadence(account) {
  const flags = [];

  if (!account || !account.found || account.orderCount == null || account.orderCount < 2 ||
      account.medianGapDays == null) {
    return {
      points: 0,
      max: DIMENSION_MAX.cadence,
      reason: 'Fewer than 2 orders or no cadence data.',
      flags
    };
  }

  const median = account.medianGapDays;
  const since = account.daysSinceLastOrder;
  const overdue = since != null && since > 2 * median;

  if (overdue) {
    return {
      points: 2,
      max: DIMENSION_MAX.cadence,
      reason: `Overdue: ${since}d since last order against a ${median}d median.`,
      flags
    };
  }

  let pts;
  if (median <= 30) pts = 9;
  else if (median <= 90) pts = 6;
  else if (median <= 180) pts = 4;
  else pts = 2;

  return {
    points: pts,
    max: DIMENSION_MAX.cadence,
    reason: `${median}-day median gap, on schedule.`,
    flags
  };
}

/* ------------------------------------------------------------------ *
 * §6D — REGION (10)
 * ------------------------------------------------------------------ */

function scoreRegion(request) {
  const flags = [];
  const city = norm(request.city);
  const state = norm(request.state);
  const county = norm(request.county);

  if (!city && !state) {
    flags.push({
      code: 'NO_ADDRESS',
      severity: 'red',
      label: 'No address supplied',
      detail: 'Region cannot be scored. Do not infer region from an area code.'
    });
    return { points: 0, max: DIMENSION_MAX.region, reason: 'Address missing — scored 0.', flags, tier: 'Unknown' };
  }

  const inIowa = state === 'ia' || state === 'iowa';

  if (!inIowa) {
    return {
      points: 0,
      max: DIMENSION_MAX.region,
      reason: 'Out of state.',
      flags,
      tier: 'Out of State'
    };
  }

  if (HOME_METRO.includes(city)) {
    return { points: 10, max: DIMENSION_MAX.region, reason: `${request.city} — home metro.`, flags, tier: 'Home' };
  }

  if (county && REGIONAL_COUNTIES.includes(county.replace(/\s+county$/, ''))) {
    return { points: 7, max: DIMENSION_MAX.region, reason: `${request.county} County — central Iowa.`, flags, tier: 'Regional' };
  }

  return { points: 3, max: DIMENSION_MAX.region, reason: `${request.city}, Iowa — statewide.`, flags, tier: 'Statewide' };
}

/* ------------------------------------------------------------------ *
 * §6E — MISSION FIT (18)
 * ------------------------------------------------------------------ */

const MISSION_POINTS = {
  core: 18,       // children, suicide prevention/mental health, foster/adoption
  adjacent: 13,   // school programs, youth sports, local nonprofit, first responders
  civic: 7,       // chamber, festivals, service clubs
  promotional: 2, // a business's marketing event, for-profit raffle
  contrary: 0
};

const MISSION_LABEL = {
  core: 'Directly serves a core priority',
  adjacent: 'Strong community benefit, adjacent',
  civic: 'General civic benefit',
  promotional: 'Weak / purely promotional',
  contrary: 'Contrary to values / reputationally risky'
};

function scoreMission(request) {
  const flags = [];
  const fit = norm(request.missionFit) || 'civic';
  const pts = MISSION_POINTS[fit];

  if (pts == null) {
    return {
      points: MISSION_POINTS.civic,
      max: DIMENSION_MAX.mission,
      reason: 'Mission fit not classified; defaulted to general civic benefit.',
      flags
    };
  }

  if (fit === 'contrary') {
    flags.push({
      code: 'MISSION_RISK',
      severity: 'red',
      label: 'Reputational risk',
      detail: 'Mission runs contrary to P&M values or carries reputational exposure.'
    });
  }

  // Business tax status + weak mission is usually a decline even for a good customer.
  if (norm(request.taxStatus) === 'business' && (fit === 'promotional' || fit === 'civic')) {
    flags.push({
      code: 'BUSINESS_WEAK_MISSION',
      severity: 'amber',
      label: 'For-profit with a weak mission ask',
      detail: 'Tax status is Business and the mission case is thin. Usually a decline even for a good customer.'
    });
  }

  return {
    points: pts,
    max: DIMENSION_MAX.mission,
    reason: MISSION_LABEL[fit] + '.',
    flags
  };
}

/* ------------------------------------------------------------------ *
 * §6F — BRAND EXPOSURE & ROI (12)
 * ------------------------------------------------------------------ */

function scoreExposure(request) {
  const flags = [];
  const logo = request.logoRequired === true;
  let pts = logo ? 6 : 1;
  const parts = [logo ? 'Logo required (6)' : 'No logo required (1)'];

  const att = request.attendance;
  const years = request.yearsActive;

  let reach;
  if (att == null) {
    reach = 1;
    parts.push('attendance not supplied (+1)');
    flags.push({
      code: 'NO_ATTENDANCE',
      severity: 'amber',
      label: 'Attendance figure missing',
      detail: 'Reach scored at the floor rather than assumed.'
    });
  } else if (request.attendanceImplausible === true) {
    reach = 1;
    parts.push('attendance implausible for the event described (+1)');
    flags.push({
      code: 'ATTENDANCE_IMPLAUSIBLE',
      severity: 'amber',
      label: 'Attendance figure looks inflated',
      detail: `Claimed ${att.toLocaleString()} against the event as described.`
    });
  } else if (att >= 1000 && years != null && years >= 5) {
    reach = 4;
    parts.push(`${att.toLocaleString()} attendance, ${years} years running (+4)`);
  } else if (att >= 250 || (years != null && years >= 3)) {
    reach = 3;
    parts.push(`${att.toLocaleString()} attendance / ${years ?? '?'} years (+3)`);
  } else if (att >= 50) {
    reach = 2;
    parts.push(`${att.toLocaleString()} attendance (+2)`);
  } else {
    reach = 1;
    parts.push(`${att.toLocaleString()} attendance or first-year event (+1)`);
  }
  pts += reach;

  if (request.carriesPMMark === true || request.likelyToReorder === true) {
    pts += 2;
    parts.push('goods carry the P&M mark or reorder likely (+2)');
  }

  return {
    points: clamp(pts, 0, DIMENSION_MAX.exposure),
    max: DIMENSION_MAX.exposure,
    reason: parts.join('; ') + '.',
    flags
  };
}

/* ------------------------------------------------------------------ *
 * §6G — REVENUE ATTACH (5)
 * ------------------------------------------------------------------ */

function scoreRevenueAttach(request, account) {
  const flags = [];
  const isCustomer = !!(account && account.found);
  const intent = norm(request.purchaseIntent); // 'specific' | 'vague' | 'no' | '' (blank)

  if (intent === 'specific') {
    if (!isCustomer) {
      flags.push({
        code: 'LEAD_NOT_HANDOUT',
        severity: 'green',
        label: 'This is a lead, not a handout',
        detail: 'Non-customer with concrete purchase intent. Route to a rep for a quote regardless of the donation decision.'
      });
    }
    return { points: 5, max: DIMENSION_MAX.revenueAttach, reason: 'Yes — specific, with quantity or product named.', flags };
  }

  if (intent === 'vague') {
    if (!isCustomer) {
      flags.push({
        code: 'LEAD_NOT_HANDOUT',
        severity: 'green',
        label: 'Possible lead',
        detail: 'Non-customer signalling purchase intent. Worth a rep call regardless of the donation decision.'
      });
    }
    return { points: 3, max: DIMENSION_MAX.revenueAttach, reason: 'Yes — vague, no quantity or product named.', flags };
  }

  if (intent === 'no') {
    if (isCustomer) {
      return { points: 2, max: DIMENSION_MAX.revenueAttach, reason: 'Existing customer, no purchase attached to this event.', flags };
    }
    // Extractive: large ask, no reciprocity, no logo.
    const large = (request.pieceCount || 0) > 75;
    if (large && request.logoRequired !== true) {
      flags.push({
        code: 'EXTRACTIVE',
        severity: 'red',
        label: 'Extractive ask',
        detail: 'Non-customer, large ask, no purchase intent, no logo. Nothing comes back.'
      });
    }
    return { points: 0, max: DIMENSION_MAX.revenueAttach, reason: 'Non-customer, no purchase intent.', flags };
  }

  flags.push({
    code: 'NO_PURCHASE_INTENT_FIELD',
    severity: 'amber',
    label: 'Purchase-intent field blank',
    detail: 'The form asks this. A blank is a genuine omission — scored 0, not assumed favorably.'
  });
  return { points: 0, max: DIMENSION_MAX.revenueAttach, reason: 'Field blank — scored 0, not assumed.', flags };
}

/* ------------------------------------------------------------------ *
 * §6H — ASK REASONABLENESS (modifier, not points)
 * ------------------------------------------------------------------ */

function askModifier(request) {
  const flags = [];
  const n = request.pieceCount;

  if (n == null) {
    flags.push({
      code: 'PIECE_COUNT_BLANK',
      severity: 'amber',
      label: 'Needs clarification — piece count',
      detail: 'No hard number given. Scored at −5 rather than assumed small.'
    });
    return { modifier: -5, reason: 'Piece count blank or open-ended.', flags };
  }

  const multi = request.multipleTypes === true || request.multipleDesigns === true;
  const highTouch = multi && (request.daysOut != null && request.daysOut < 45);

  if (n >= 150 || highTouch) {
    flags.push({
      code: 'LARGE_ASK',
      severity: 'red',
      label: 'Large or high-touch ask',
      detail: `${n} pieces${multi ? ', multiple types or designs' : ''}. This is a production job, not a giveaway.`
    });
    return { modifier: -10, reason: `${n} pieces / high-touch.`, flags };
  }
  if (n >= 76 || multi) {
    return { modifier: -5, reason: `${n} pieces${multi ? ', multiple types or designs' : ''}.`, flags };
  }
  if (n >= 26) {
    return { modifier: -2, reason: `${n} pieces, straightforward decoration.`, flags };
  }
  return { modifier: 0, reason: `${n} pieces, single product type.`, flags };
}

/* ------------------------------------------------------------------ *
 * §3 — SELF-REPORT RECONCILIATION
 * ------------------------------------------------------------------ */

function reconcileSelfReport(request, account) {
  const claim = norm(request.selfReportedCustomer); // 'yes' | 'no' | 'not sure'
  const found = !!(account && account.found);
  const flags = [];

  let verdict;
  if (claim === 'yes' && found) {
    verdict = 'Claimed customer; confirmed in Apparelytics.';
  } else if (claim === 'yes' && !found) {
    verdict = 'Claimed current-customer status; no record found.';
    flags.push({
      code: 'SELF_REPORT_MISMATCH',
      severity: 'red',
      label: 'Claims customer status, no record found',
      detail: 'Either mistaken, ordered under a different entity, or inflating the relationship. Relationship scored 0.'
    });
  } else if (claim === 'no' && found) {
    verdict = 'Said no; Apparelytics shows an active account.';
    flags.push({
      code: 'UNAWARE_CUSTOMER',
      severity: 'green',
      label: 'They do not know they are a customer',
      detail: 'Whoever places the orders is not the person who filled out this form. Sales signal — full relationship credit still applies.'
    });
  } else if (claim === 'not sure' && found) {
    verdict = 'Unsure; Apparelytics confirms an account.';
  } else if (claim === 'not sure' && !found) {
    verdict = 'Unsure; no record found. Honest answer, no penalty for it.';
  } else {
    verdict = found ? 'Account confirmed in Apparelytics.' : 'No record in Apparelytics. This is not a current client.';
  }

  return { claim: request.selfReportedCustomer || null, verified: found, verdict, flags };
}

/* ------------------------------------------------------------------ *
 * §7 — GRADE & DECISION
 * ------------------------------------------------------------------ */

function toGrade(total) {
  for (const band of GRADE_BANDS) {
    if (total >= band.min) return { grade: band.grade, decision: band.decision };
  }
  return { grade: 'F', decision: 'Decline' };
}

/**
 * The gauge colour. Never decorative — it states the verdict.
 * green = A/B, gold = C/D, red = F.
 */
function gaugeColor(grade) {
  if (grade === 'A' || grade === 'B') return 'green';
  if (grade === 'C' || grade === 'D') return 'gold';
  return 'red';
}

/* ------------------------------------------------------------------ *
 * MAIN
 * ------------------------------------------------------------------ */

/**
 * @param {object} request  Parsed form fields.
 * @param {object} account  Apparelytics facts, or {found:false}.
 * @param {object} opts     { today: 'YYYY-MM-DD' }
 */
function evaluate(request, account, opts) {
  const options = opts || {};
  const today = options.today || new Date().toISOString().slice(0, 10);
  const acct = account || { found: false };

  const daysOut = computeDaysOut(request, today);
  const req = Object.assign({}, request, { daysOut });

  const selfReport = reconcileSelfReport(req, acct);
  const { disqualifiers, review } = evaluateDisqualifiers(req, acct, daysOut);

  // Hard disqualifier: stop. Grade F, no scoring.
  if (disqualifiers.length > 0) {
    return {
      engineVersion: '1.0',
      evaluatedOn: today,
      daysOut,
      disqualified: true,
      disqualifiers,
      reviewNotes: review,
      selfReport,
      dimensions: null,
      modifier: null,
      rawTotal: null,
      total: 0,
      grade: 'F',
      decision: 'Decline',
      gaugeColor: 'red',
      flags: [...selfReport.flags, ...disqualifiers.map(d => ({
        code: d.code, severity: 'red', label: d.label, detail: d.detail
      }))]
    };
  }

  const dims = {
    relationship: scoreRelationship(acct),
    spend: scoreSpend(acct),
    cadence: scoreCadence(acct),
    region: scoreRegion(req),
    mission: scoreMission(req),
    exposure: scoreExposure(req),
    revenueAttach: scoreRevenueAttach(req, acct)
  };

  const mod = askModifier(req);

  const rawTotal = Object.values(dims).reduce((sum, d) => sum + d.points, 0);
  const total = clamp(rawTotal + mod.modifier, 0, TOTAL_MAX);

  const { grade, decision } = toGrade(total);

  const flags = [
    ...selfReport.flags,
    ...Object.values(dims).flatMap(d => d.flags || []),
    ...mod.flags
  ];

  return {
    engineVersion: '1.0',
    evaluatedOn: today,
    daysOut,
    disqualified: false,
    disqualifiers: [],
    reviewNotes: review,
    selfReport,
    dimensions: dims,
    modifier: mod,
    rawTotal,
    total,
    grade,
    decision,
    gaugeColor: gaugeColor(grade),
    flags
  };
}

/* ------------------------------------------------------------------ */

const GivingGauge = {
  evaluate,
  computeDaysOut,
  toGrade,
  gaugeColor,
  LEAD_TIME_FLOOR_DAYS,
  DIMENSION_MAX,
  TOTAL_MAX
};

if (typeof module !== 'undefined' && module.exports) module.exports = GivingGauge;
if (typeof window !== 'undefined') window.GivingGauge = GivingGauge;
