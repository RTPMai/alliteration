// lib/giving-classify.js — suggest the answers the form cannot ask.
//
// WHY THIS IS CAREFUL. Two of these five fields are hard disqualifiers:
// isPolitical is always an automatic decline, and isReligious is one unless
// the org is a customer or the ask is secular. A keyword guess that gets
// either wrong would decline a real request, and nobody would know why.
//
// "Lutheran Services in Iowa" is the case that proves it. The name carries an
// obvious religious keyword, but the organisation is a human-services agency
// and the ask was about veterans. A classifier that auto-set isReligious on a
// name match would have declined it silently.
//
// SO THE RULE IS ASYMMETRIC:
//
//   - A "no" on the disqualifier fields is applied automatically. Saying a
//     youth disc golf club is not a political campaign is safe, and it is the
//     answer for the overwhelming majority of requests.
//   - A "yes" is NEVER applied automatically. When the text suggests one, the
//     field is left unanswered and the suspicion is surfaced as a note for a
//     human, with the word that triggered it.
//   - missionFit and orgType are applied, because the worst case there is a
//     points difference on a request a human is already reading, not a
//     decline. orgType never auto-fills 'religious' or 'political', because
//     the engine reads those two values as disqualifiers in their own right.
//
// Every suggestion records the evidence in `why`, so the app can show what it
// keyed on rather than presenting a guess as a fact.

const norm = (s) => String(s == null ? "" : s).toLowerCase();

/** All the free text on a request, joined for keyword scanning. */
function corpus(r) {
  return [
    r.orgName, r.eventName, r.eventType, r.description,
    r.merchUse, r.rationale, r.additional
  ].map(norm).filter(Boolean).join(" ");
}

/** First keyword present in the text, or null. Word-boundary matched. */
function firstHit(text, words) {
  for (const w of words) {
    const re = new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (re.test(text)) return w;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * SIGNALS
 * ------------------------------------------------------------------ */

// Deliberately narrow. These only ever RAISE a question for a human.
const POLITICAL_WORDS = [
  "campaign", "for congress", "for senate", "for governor", "for mayor",
  "committee to elect", "re-elect", "reelect", "political action committee",
  "pac", "caucus", "republican", "democrat", "democratic party", "gop",
  "candidate", "ballot measure", "voter guide", "partisan"
];

const RELIGIOUS_WORDS = [
  "church", "ministry", "ministries", "parish", "diocese", "synagogue",
  "mosque", "temple", "congregation", "gospel", "worship", "faith-based",
  "vacation bible school", "youth group", "missions trip", "chapel"
];

// Weaker: a denominational word in a NAME often belongs to a school or a
// human-services agency rather than a congregation. Never a disqualifier
// on its own; it only produces a note.
const DENOMINATIONAL_WORDS = [
  "christian", "catholic", "lutheran", "methodist", "baptist", "presbyterian",
  "episcopal", "evangelical", "jewish", "islamic", "adventist"
];

const CORE_WORDS = [
  "children", "children's", "child", "kids", "youth mental health",
  "suicide", "crisis line", "mental health", "counseling", "therapy",
  "foster", "adoption", "orphan", "nicu", "children's hospital",
  "pediatric", "childhood cancer", "bereavement", "grief", "abuse",
  "domestic violence", "shelter", "food pantry", "hunger", "homeless",
  "childhood literacy", "raising readers", "early literacy"
];

const ADJACENT_WORDS = [
  "school", "elementary", "middle school", "high school", "district",
  "academy", "pta", "pto", "booster", "scholarship", "band", "choir",
  "robotics", "ffa", "4-h", "youth sports", "little league", "soccer",
  "baseball", "softball", "basketball", "wrestling", "volleyball",
  "cross country", "track", "disc golf", "pickleball", "swim",
  "fire department", "firefighter", "police", "first responder",
  "ems", "paramedic", "veteran", "veterans", "nonprofit", "non-profit",
  "501c3", "501(c)(3)", "animal rescue", "humane", "literacy", "library",
  "reading", "readers", "books", "tutoring", "mentoring", "after school"
];

const CIVIC_WORDS = [
  "chamber of commerce", "rotary", "lions club", "kiwanis", "optimist",
  "festival", "parade", "county fair", "main street", "service club",
  "community celebration", "pageant", "homecoming"
];

const PROMOTIONAL_WORDS = [
  "grand opening", "customer appreciation", "brand awareness",
  "marketing event", "product launch", "raffle prize", "giveaway",
  "promotional"
];

const ORG_SIGNALS = [
  ["school", ["school", "elementary", "middle school", "high school",
              "district", "academy", "csd", "university", "college", "pta", "pto"]],
  ["youth", ["youth", "little league", "booster", "4-h", "ffa", "scouts",
             "disc golf", "pickleball", "soccer club", "baseball club",
             "softball", "junior", "teen"]],
  ["civic", ["chamber of commerce", "rotary", "lions club", "kiwanis",
             "optimist", "festival", "main street", "county fair", "pageant"]],
  ["nonprofit", ["nonprofit", "non-profit", "501c3", "501(c)(3)", "foundation",
                 "charity", "charitable", "alliance", "society", "coalition",
                 "services", "outreach", "rescue", "humane"]],
  ["business", ["llc", "inc", "incorporated", "corp", "co.", "company"]]
];

/* ------------------------------------------------------------------ *
 * CLASSIFY
 * ------------------------------------------------------------------ */

/**
 * Propose values for the five classify fields.
 *
 * Returns { values, why, review }:
 *   values  fields safe to apply automatically
 *   why     per-field evidence, for display
 *   review  questions raised that a human must answer
 *
 * A field a human has already answered is never included; the caller merges
 * `values` only into empty fields.
 */
export function classify(request) {
  const r = request || {};
  const text = corpus(r);
  const name = norm(r.orgName);

  const values = {};
  const why = {};
  const review = [];

  if (!text.trim()) return { values, why, review };

  /* ---- political: auto-NO only ---- */
  const polHit = firstHit(text, POLITICAL_WORDS);
  if (polHit) {
    review.push({
      field: "isPolitical",
      why: 'Text mentions "' + polHit + '". A political org is an automatic ' +
           'decline, so this needs a human answer.'
    });
  } else {
    values.isPolitical = false;
    why.isPolitical = "No campaign, party or candidate language found.";
  }

  /* ---- religious: auto-NO only ---- */
  const relHit = firstHit(text, RELIGIOUS_WORDS);
  const denomHit = firstHit(name, DENOMINATIONAL_WORDS);
  if (relHit) {
    review.push({
      field: "isReligious",
      why: 'Text mentions "' + relHit + '". Not an automatic decline for a ' +
           'customer or a secular ask, so a human decides.'
    });
  } else if (denomHit) {
    review.push({
      field: "isReligious",
      why: 'The name contains "' + denomHit + '", which often belongs to a ' +
           'school or a human-services agency rather than a congregation. ' +
           'Confirm before this counts against the request.'
    });
  } else {
    values.isReligious = false;
    why.isReligious = "No congregation, ministry or worship language found.";
  }

  /* ---- organisation type ---- */
  //
  // Skipped entirely while a religious or political question is open, because
  // the right answer might be exactly the value this function is forbidden to
  // apply. "First Baptist Church" running a "Vacation Bible School" matched
  // the word "school" and was labelled a school; leaving orgType for the human
  // who is already being asked about the religious question is the fix.
  const questionOpen = review.some(
    (x) => x.field === "isReligious" || x.field === "isPolitical"
  );

  if (!questionOpen) {
    for (const [type, words] of ORG_SIGNALS) {
      const hit = firstHit(text, words);
      if (hit) {
        values.orgType = type;
        why.orgType = 'Matched "' + hit + '".';
        break;
      }
    }
  }

  /* ---- mission fit ---- */
  const coreHit = firstHit(text, CORE_WORDS);
  const adjHit = firstHit(text, ADJACENT_WORDS);
  const civicHit = firstHit(text, CIVIC_WORDS);
  const promoHit = firstHit(text, PROMOTIONAL_WORDS);

  if (coreHit) {
    values.missionFit = "core";
    why.missionFit = 'Matched "' + coreHit + '", a stated core priority.';
  } else if (adjHit) {
    values.missionFit = "adjacent";
    why.missionFit = 'Matched "' + adjHit + '", strong community benefit.';
  } else if (civicHit) {
    values.missionFit = "civic";
    why.missionFit = 'Matched "' + civicHit + '", general civic benefit.';
  } else if (promoHit && norm(r.taxStatus) === "business") {
    values.missionFit = "promotional";
    why.missionFit = 'Matched "' + promoHit + '" on a for-profit request.';
  }

  // 'contrary' is never suggested. It scores zero and carries a reputational
  // flag, which is a judgment no keyword should be making.

  return { values, why, review };
}

/**
 * Apply suggestions to a request without touching anything already answered.
 * Returns the list of fields actually filled.
 */
export function applyClassification(row) {
  if (!row || !row.request) return [];

  const { values, why, review } = classify(row.request);
  const filled = [];
  const isEmpty = (v) => v === null || v === undefined || v === "";

  Object.keys(values).forEach((k) => {
    if (isEmpty(row.request[k])) {
      row.request[k] = values[k];
      filled.push(k);
    }
  });

  if (filled.length) {
    // Recorded so the app can label these as suggestions rather than showing
    // them as though a person had answered.
    row.autoClassified = filled;
    row.classifyWhy = Object.fromEntries(
      filled.map((f) => [f, why[f]]).filter(([, v]) => v)
    );
  }

  // Questions the text raised but a keyword must not answer.
  if (review.length) {
    row.needsReview = (row.needsReview || []).filter(
      (n) => !review.some((x) => x.field === n.field)
    );
    review.forEach((x) => {
      if (isEmpty(row.request[x.field])) row.needsReview.push(x);
    });
  }

  return filled;
}
