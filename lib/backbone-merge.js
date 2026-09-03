// lib/backbone-merge.js — one customer that BackBone holds as several rows.
//
// THE PROBLEM. BackBone keys everything on Printavo's customer id. When a
// customer is merged in real life, or in Printavo after the fact, the old ids
// stay in the roster and that company's revenue, order count and scoring split
// across two or three rows. Every screen then under-reports them: the roster
// shows three small clients, the scorecard bands them wrong, GivingGauge scores
// a donation against a third of their real spend, and the AM panel counts them
// as three accounts.
//
// THE FIX IS APPLIED WHEN THE ROSTER IS READ, NOT WHEN IT IS SYNCED.
//
// That choice is the whole design. A fold at read time means:
//
//   - The sync is never touched. Reconcile can keep rebuilding the roster from
//     Printavo's full history exactly as it does today.
//   - A merge survives every future sync for free, because nothing about the
//     merge lives in the synced data.
//   - Everything downstream picks it up without knowing this file exists:
//     api/data.js feeds the roster, the dashboard and the scorecard;
//     api/customer-match.js feeds GivingGauge; ErrorEngine and Notifications
//     read the same key.
//   - It is reversible. Unmerging deletes a record and the next read shows the
//     original rows again, untouched, because they were never edited.
//
// If Printavo later merges the records itself, the old ids stop appearing in
// the roster and a group whose members are all gone simply folds nothing. It
// self-heals rather than needing to be cleaned up.
//
// THE NAME IS PICKED BY A HUMAN. Not the longest, not the highest revenue, not
// the most recent. Which of "KBS", "CRS" and "Kitchen Bath Solutions" the team
// says out loud is not something this file can work out, and getting it wrong
// renames a client on every screen at once.
//
// NOTHING IS EVER MERGED AUTOMATICALLY. suggestDuplicates() proposes; a person
// confirms. A silent wrong merge welds two real customers into one and there is
// no visible symptom, which is worse than leaving two rows alone.
//
// ESM. No imports from api/.

/* ------------------------------------------------------------------ *
 * NAME NORMALISING
 * ------------------------------------------------------------------ */

// Dropped before comparing. "Smith & Sons, Inc." and "Smith and Sons LLC" are
// the same company wearing different paperwork.
const NOISE_WORDS = new Set([
  "inc", "incorporated", "llc", "l l c", "llp", "ltd", "limited", "co",
  "corp", "corporation", "company", "the", "and", "of", "a",
]);

// Free mailbox providers. Two customers sharing gmail.com means nothing; two
// sharing kitchenbath.com means a great deal.
const FREE_MAIL = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "msn.com",
  "icloud.com", "me.com", "live.com", "comcast.net", "mac.com", "att.net",
  "mchsi.com", "protonmail.com", "mail.com", "ymail.com",
]);

const str = (v) => String(v == null ? "" : v).trim();

/** Lowercase, strip punctuation and paperwork words, collapse spaces. */
export function normaliseName(name) {
  const base = str(name)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!base) return "";
  const tokens = base.split(" ").filter((w) => w && !NOISE_WORDS.has(w));
  // Everything was a noise word ("The Company"). Keep the original rather than
  // returning nothing, or every such row would look identical to every other.
  return (tokens.length ? tokens : base.split(" ")).join(" ");
}

export function nameTokens(name) {
  const n = normaliseName(name);
  return n ? n.split(" ") : [];
}

/**
 * The initials of a multi-word name. "Kitchen Bath Solutions" -> "kbs".
 *
 * This is the signal that catches the case this was built for. Nothing else
 * connects "KBS" to "Kitchen Bath Solutions": they share no tokens, no
 * substring and no edit distance worth the name.
 */
export function acronymOf(name) {
  const tokens = nameTokens(name);
  if (tokens.length < 2) return "";
  return tokens.map((w) => w[0]).join("");
}

/** A name that is itself probably an acronym: short, one word, no vowels to speak of. */
function looksLikeAcronym(name) {
  const tokens = nameTokens(name);
  if (tokens.length !== 1) return false;
  const w = tokens[0];
  return w.length >= 2 && w.length <= 6;
}

function emailDomain(email) {
  const m = str(email).toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  return m ? m[1] : "";
}

/** Every email address on a roster row, from contacts and the primary contact. */
function emailsOf(row) {
  const out = [];
  const push = (c) => {
    if (!c) return;
    const e = str(c.email || c.address || "").toLowerCase();
    if (e.indexOf("@") > 0) out.push(e);
  };
  push(row.primary_contact);
  (Array.isArray(row.contacts) ? row.contacts : []).forEach(push);
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ *
 * FOLDING
 * ------------------------------------------------------------------ */

const num = (v) => {
  const n = Number(v);
  return isFinite(n) ? n : 0;
};

/** Add every year bucket of b onto a copy of a. */
function addBuckets(a, b) {
  const out = { ...(a || {}) };
  Object.keys(b || {}).forEach((y) => {
    out[y] = num(out[y]) + num(b[y]);
  });
  return out;
}

/** Union of two contact lists, deduped on email then on lowercased name. */
function unionContacts(a, b) {
  const seen = new Set();
  const out = [];
  [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].forEach((c) => {
    if (!c) return;
    const key = str(c.email).toLowerCase() || str(c.name).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(c);
  });
  return out;
}

/** Category mixes added together by name, biggest first. */
function addCategories(a, b) {
  const totals = {};
  [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].forEach((c) => {
    if (!c) return;
    const name = str(c.name || c.category);
    if (!name) return;
    totals[name] = num(totals[name]) + num(c.count == null ? 1 : c.count);
  });
  return Object.keys(totals)
    .map((name) => ({ name, count: totals[name] }))
    .sort((x, y) => y.count - x.count);
}

/**
 * One row out of several. `name` is the human's pick and always wins.
 *
 * MEDIAN GAP IS THE ONE FIGURE THAT CANNOT BE ADDED UP. It is the median
 * number of days between orders, and medians do not combine: three records
 * that are really one customer ordered more often than any one of them shows.
 * The smallest of the group is the closest honest answer and is directionally
 * right, so that is what is taken, and `median_gap_estimated` is set so the
 * screen can say the cadence is approximate rather than presenting a computed
 * figure as if it were measured.
 */
export function mergeCustomerRows(primary, others, name) {
  const members = Array.isArray(others) ? others.filter(Boolean) : [];
  const out = { ...primary };

  out.company_name = str(name) || str(primary.company_name);

  members.forEach((m) => {
    out.invoice_count = num(out.invoice_count) + num(m.invoice_count);
    out.total_revenue = num(out.total_revenue) + num(m.total_revenue);
    out.revenue_by_year = addBuckets(out.revenue_by_year, m.revenue_by_year);
    out.invoices_by_year = addBuckets(out.invoices_by_year, m.invoices_by_year);
    out.contacts = unionContacts(out.contacts, m.contacts);
    out.top_categories = addCategories(out.top_categories, m.top_categories);

    // The most recent order anywhere in the group. A customer who ordered from
    // one of these records last week is not dormant.
    if (m.last_invoice_date && (!out.last_invoice_date || m.last_invoice_date > out.last_invoice_date)) {
      out.last_invoice_date = m.last_invoice_date;
    }
    // Never blank something the primary has; fill what it is missing.
    if (!out.zip && m.zip) out.zip = m.zip;
    if (!out.primary_contact && m.primary_contact) out.primary_contact = m.primary_contact;
  });

  const gaps = [primary, ...members]
    .map((r) => (r && r.median_gap_days != null ? num(r.median_gap_days) : null))
    .filter((v) => v != null && v > 0);
  if (gaps.length) {
    // Flagged whenever anything was merged in, not only when the number moved.
    // The group placed more orders than any one record shows, so the true gap
    // is smaller than this whichever record it came from.
    if (members.length) out.median_gap_estimated = true;
    out.median_gap_days = Math.min(...gaps);
  }

  // What went into this row, so a screen can say so and a person can undo it
  // knowing exactly what they are undoing.
  out.merged = true;
  out.merged_from = members.map((m) => ({
    customer_id: String(m.customer_id),
    company_name: str(m.company_name),
    total_revenue: num(m.total_revenue),
    invoice_count: num(m.invoice_count),
  }));

  return out;
}

/**
 * Where a customer id ends up after merging.
 *
 * An id stored on some OTHER record months ago (a donation request's matched
 * account, an error record's customer) still points at whichever Printavo
 * record it matched at the time. If that record has since been absorbed, the
 * folded roster no longer contains it, and a lookup by that id quietly finds
 * nothing. This turns the old id into the one that is really there.
 *
 * Returns the id unchanged when nothing has been merged, which is the normal
 * case and costs nothing.
 */
export function resolveCustomerId(id, groups) {
  const index = memberIndex(groups);
  const g = index[String(id)];
  return g ? String(g.primaryId) : String(id);
}

/**
 * absorbedOrPrimaryId -> { primaryId, name }, covering BOTH the members and
 * the primary of every group.
 *
 * The primary is in there on purpose. A record matched directly to the primary
 * carries that record's own Printavo name, not the name a human chose for the
 * merged client, and the two would disagree on screen.
 */
export function mergeNameMap(groups) {
  const out = {};
  (Array.isArray(groups) ? groups : []).forEach((g) => {
    if (!g || !g.primaryId) return;
    const entry = { primaryId: String(g.primaryId), name: str(g.name) };
    out[String(g.primaryId)] = entry;
    (g.memberIds || []).forEach((id) => { out[String(id)] = entry; });
  });
  return out;
}

/**
 * Work out, for a list of ids somebody asked about, which record actually
 * holds their data now and what it should be called.
 *
 * A real function rather than three lines inside the route, so the tests can
 * call it: the failure it guards against is a lookup that quietly returns
 * nothing, which no error message would ever announce.
 *
 * `asked` is kept on every entry because the answer has to be handed back
 * under the id the CALLER used. Returning it under the resolved id means the
 * caller looks up the id it sent, finds nothing, and keeps its stale copy.
 */
export function resolveAskedIds(asked, groups) {
  const map = mergeNameMap(groups);
  return (Array.isArray(asked) ? asked : []).map((raw) => {
    const id = String(raw);
    const m = map[id];
    return {
      asked: id,
      target: m ? String(m.primaryId) : id,
      name: m ? str(m.name) : "",
      merged: !!m,
    };
  });
}

/** childId -> group, for every member that is not the primary. */
export function memberIndex(groups) {
  const index = {};
  (Array.isArray(groups) ? groups : []).forEach((g) => {
    if (!g || !g.primaryId) return;
    (g.memberIds || []).forEach((id) => {
      if (String(id) === String(g.primaryId)) return;
      index[String(id)] = g;
    });
  });
  return index;
}

/**
 * Apply every merge group to a roster payload.
 *
 * Returns a NEW payload. The stored data is never rewritten, which is what
 * makes an unmerge a delete rather than a repair.
 *
 * A group whose primary is missing from the roster is skipped entirely rather
 * than promoting a member to primary: the human picked that record, and
 * silently substituting another one would move the name and the enrichment to
 * a row nobody chose.
 */
export function foldRoster(data, groups) {
  const synced = Array.isArray(data && data.synced) ? data.synced : [];
  const enrichment = (data && data.enrichment) || {};
  const list = Array.isArray(groups) ? groups.filter((g) => g && g.primaryId) : [];

  if (!list.length) return { synced, enrichment, foldedGroups: 0 };

  const byId = {};
  synced.forEach((r) => { byId[String(r.customer_id)] = r; });

  const absorbed = new Set();
  const replacements = {};
  let foldedGroups = 0;

  list.forEach((g) => {
    const primaryId = String(g.primaryId);
    const primary = byId[primaryId];
    if (!primary) return;

    const members = (g.memberIds || [])
      .map(String)
      .filter((id) => id !== primaryId)
      .map((id) => byId[id])
      .filter(Boolean);

    // Every member already gone, most likely because Printavo merged them for
    // real. Nothing to fold, and the group is harmless where it sits.
    if (!members.length) return;

    replacements[primaryId] = mergeCustomerRows(primary, members, g.name);
    replacements[primaryId].merge_id = g.id || null;
    members.forEach((m) => absorbed.add(String(m.customer_id)));
    foldedGroups++;
  });

  if (!foldedGroups) return { synced, enrichment, foldedGroups: 0 };

  const foldedSynced = synced
    .filter((r) => !absorbed.has(String(r.customer_id)))
    .map((r) => replacements[String(r.customer_id)] || r);

  // Enrichment is keyed by customer_id: account manager, industry, notes. The
  // primary's answers win field by field, and a blank on the primary is filled
  // from a member rather than lost. An absorbed row's own entry is dropped, or
  // the payload would still carry a record for a customer that no longer
  // appears in the list.
  const foldedEnrichment = {};
  Object.keys(enrichment).forEach((k) => {
    if (!absorbed.has(String(k))) foldedEnrichment[k] = enrichment[k];
  });

  list.forEach((g) => {
    const primaryId = String(g.primaryId);
    if (!replacements[primaryId]) return;
    const merged = { ...(enrichment[primaryId] || {}) };
    (g.memberIds || []).map(String).forEach((id) => {
      if (id === primaryId) return;
      const from = enrichment[id];
      if (!from) return;
      Object.keys(from).forEach((field) => {
        const have = merged[field];
        if (have === undefined || have === null || have === "") merged[field] = from[field];
      });
    });
    if (Object.keys(merged).length) foldedEnrichment[primaryId] = merged;
  });

  return { synced: foldedSynced, enrichment: foldedEnrichment, foldedGroups };
}

/* ------------------------------------------------------------------ *
 * SUGGESTIONS
 *
 * Comparing every row with every other row is 2,500 squared. So candidates are
 * blocked first: rows only get compared when they already share something
 * cheap to index on (a normalised name, an acronym, a first word, an email
 * domain, a ZIP). Everything else is never a pair, which is correct as well as
 * fast, because two companies with nothing in common are not duplicates.
 * ------------------------------------------------------------------ */

const CONFIDENCE = (score) => (score >= 80 ? "high" : score >= 62 ? "medium" : "low");

/** How much two token sets overlap, 0 to 1. */
function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = a.filter((w) => setB.has(w)).length;
  return shared / Math.max(a.length, b.length);
}

/**
 * Score one candidate pair. Returns { score, reasons } or null.
 *
 * The reasons are the point. A suggestion that just says "85%" is not
 * confirmable: the person clicking yes needs to see WHAT matched, because the
 * failure mode being guarded against is two genuinely different companies with
 * similar names.
 */
export function scorePair(a, b) {
  const reasons = [];
  let score = 0;

  const na = normaliseName(a.company_name);
  const nb = normaliseName(b.company_name);
  if (!na || !nb) return null;

  if (na === nb) {
    score = 96;
    reasons.push("Same name once punctuation and Inc/LLC are ignored");
  }

  // The acronym case: KBS and Kitchen Bath Solutions.
  const acroA = acronymOf(a.company_name);
  const acroB = acronymOf(b.company_name);
  if (score < 84) {
    if (acroB && looksLikeAcronym(a.company_name) && na.replace(/ /g, "") === acroB) {
      score = Math.max(score, 84);
      reasons.push('"' + str(a.company_name) + '" is the initials of "' + str(b.company_name) + '"');
    } else if (acroA && looksLikeAcronym(b.company_name) && nb.replace(/ /g, "") === acroA) {
      score = Math.max(score, 84);
      reasons.push('"' + str(b.company_name) + '" is the initials of "' + str(a.company_name) + '"');
    }
  }

  // One name is the start of the other: "Saydel Schools" and "Saydel Community
  // School District". Needs a real prefix, not one shared short word.
  const ta = nameTokens(a.company_name);
  const tb = nameTokens(b.company_name);
  if (score < 70 && na !== nb) {
    const shorter = ta.length <= tb.length ? ta : tb;
    const longer = ta.length <= tb.length ? tb : ta;
    const isPrefix = shorter.length >= 2 && shorter.every((w, i) => longer[i] === w);
    if (isPrefix) {
      score = Math.max(score, 70);
      reasons.push("One name is the beginning of the other");
    }
  }

  // SAME WORDS, DIFFERENT ORDER. "Ankeny Kiwanis Club" and "Kiwanis Club
  // Ankeny" are one organisation, and nothing else here would connect them.
  const shareRatio = overlap(ta, tb);
  const sharedCount = ta.filter((w) => tb.indexOf(w) >= 0).length;
  const sameWords = ta.length === tb.length && sharedCount === ta.length && ta.length >= 2;
  if (score < 78 && sameWords && na !== nb) {
    score = Math.max(score, 78);
    reasons.push("The same words in a different order");
  }

  // PARTIAL OVERLAP IS NOT EVIDENCE ON ITS OWN. "School District 1" and
  // "School District 2" share two words out of three and are deliberately
  // different districts. The first real scan of the roster is what made this
  // clear: on a roster full of schools, mostly-matching names would fill the
  // list with pairs that are different by design and bury the true duplicates
  // underneath them. It corroborates another signal and nothing more.
  const partialOverlap = !sameWords && shareRatio >= 0.6 && sharedCount >= 2;

  // Contact evidence. Strong on its own, and it is what separates a real pair
  // from two unrelated companies that happen to be called something similar.
  const emailsA = emailsOf(a);
  const emailsB = emailsOf(b);
  const sameEmail = emailsA.find((e) => emailsB.indexOf(e) >= 0);
  if (sameEmail) {
    score = Math.max(score, 88);
    reasons.push("The same contact email is on both: " + sameEmail);
  } else {
    const domainsB = new Set(emailsB.map(emailDomain).filter((d) => d && !FREE_MAIL.has(d)));
    const sharedDomain = emailsA.map(emailDomain).find((d) => d && domainsB.has(d));
    if (sharedDomain) {
      score = score >= 62 ? Math.min(99, score + 8) : 66;
      reasons.push("Contacts share the email domain " + sharedDomain);
    }
  }

  if (score > 0 && partialOverlap) {
    score = Math.min(99, score + 4);
    reasons.push("Most of the words in the two names are the same");
  }

  if (score > 0 && a.zip && b.zip && str(a.zip) === str(b.zip)) {
    score = Math.min(99, score + 4);
    reasons.push("Same ZIP code");
  }

  if (score < 45 || !reasons.length) return null;
  return { score: Math.round(score), reasons };
}

/**
 * Candidate duplicate pairs across the roster, best first.
 *
 * Rows already merged together, and rows already absorbed into some other
 * group, are left out: a suggestion you have already acted on is noise.
 */
export function suggestDuplicates(synced, opts) {
  const rows = (Array.isArray(synced) ? synced : []).filter(
    (r) => r && r.customer_id != null && str(r.company_name) && str(r.company_name) !== "Unknown"
  );
  const options = opts || {};
  const groups = Array.isArray(options.groups) ? options.groups : [];
  const limit = options.limit || 60;

  // Ids that are already spoken for, and pairs already decided together.
  const absorbed = new Set(Object.keys(memberIndex(groups)));
  const dismissed = new Set(
    (Array.isArray(options.dismissed) ? options.dismissed : []).map((p) => pairKey(p[0], p[1]))
  );
  const together = new Set();
  groups.forEach((g) => {
    const ids = [String(g.primaryId), ...(g.memberIds || []).map(String)];
    ids.forEach((x) => ids.forEach((y) => { if (x !== y) together.add(pairKey(x, y)); }));
  });

  const live = rows.filter((r) => !absorbed.has(String(r.customer_id)));

  // ---- blocking -------------------------------------------------------
  //
  // Bucket sizes differ by how much the key actually means. An exact
  // normalised name, a company email domain or a set of initials is a narrow,
  // high-precision key and can hold plenty. A first word is not: "t:school"
  // would swallow half the roster, and comparing every school with every other
  // school is the quadratic scan the blocking exists to avoid.
  const CAPS = { n: 200, d: 200, a: 200, t: 25 };

  const blocks = new Map();
  const seenInBlock = new Map();

  const addTo = (key, row) => {
    if (!key) return;
    if (!blocks.has(key)) {
      blocks.set(key, []);
      seenInBlock.set(key, new Set());
    }
    const bucket = blocks.get(key);
    const already = seenInBlock.get(key);
    const id = String(row.customer_id);

    // A ROW MUST NEVER LAND IN THE SAME BUCKET TWICE. A customer with two
    // contacts at the same company domain used to be added once per contact,
    // and the pair loop then compared that row with itself: same name, same
    // revenue, same email, same ZIP, scored as a near-certain duplicate. Every
    // suggestion at the top of the first real scan was a record paired with
    // itself.
    if (already.has(id)) return;
    if (bucket.length >= (CAPS[key[0]] || 25)) return;
    already.add(id);
    bucket.push(row);
  };

  live.forEach((row) => {
    const n = normaliseName(row.company_name);
    if (!n) return;
    addTo("n:" + n, row);
    const tokens = nameTokens(row.company_name);
    if (tokens[0]) addTo("t:" + tokens[0], row);
    // Both directions of the acronym trick, so "KBS" and "Kitchen Bath
    // Solutions" land in the same bucket without either knowing about the
    // other.
    const acro = acronymOf(row.company_name);
    if (acro) addTo("a:" + acro, row);
    if (looksLikeAcronym(row.company_name)) addTo("a:" + n.replace(/ /g, ""), row);
    // Domains deduped: a row with three contacts at foth.com is one row in the
    // foth.com bucket.
    const domains = new Set();
    emailsOf(row).forEach((e) => {
      const d = emailDomain(e);
      if (d && !FREE_MAIL.has(d)) domains.add(d);
    });
    domains.forEach((d) => addTo("d:" + d, row));
  });

  // ---- score the candidates -------------------------------------------
  const seen = new Set();
  const out = [];

  blocks.forEach((bucket) => {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        // Belt and braces alongside the bucket dedupe above. A record is never
        // its own duplicate, and a self-pair scores as a certainty, so it would
        // sit at the top of the list and bury the real ones.
        if (String(a.customer_id) === String(b.customer_id)) continue;
        const key = pairKey(a.customer_id, b.customer_id);
        if (seen.has(key) || together.has(key) || dismissed.has(key)) continue;
        seen.add(key);
        const scored = scorePair(a, b);
        if (!scored) continue;
        out.push({
          key,
          score: scored.score,
          confidence: CONFIDENCE(scored.score),
          reasons: scored.reasons,
          // ZIP and a contact come along because the person checking this
          // against Printavo needs something to check WITH. A name and a
          // number are not enough to tell two real companies apart.
          rows: [a, b].map((r) => ({
            customer_id: String(r.customer_id),
            company_name: str(r.company_name),
            total_revenue: num(r.total_revenue),
            invoice_count: num(r.invoice_count),
            last_invoice_date: r.last_invoice_date || null,
            zip: str(r.zip),
            contact: emailsOf(r)[0] || "",
          })),
        });
      }
    }
  });

  out.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    const rx = x.rows[0].total_revenue + x.rows[1].total_revenue;
    const ry = y.rows[0].total_revenue + y.rows[1].total_revenue;
    return ry - rx;
  });

  return out.slice(0, limit);
}

/** Order-independent key for a pair of ids. */
export function pairKey(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? x + "|" + y : y + "|" + x;
}

/* ------------------------------------------------------------------ *
 * VALIDATION
 * ------------------------------------------------------------------ */

/**
 * Check a proposed merge against the roster it claims to be about.
 *
 * Refuses rather than repairs. A merge changes what every screen shows for a
 * customer, so a request that does not make sense is a bug somewhere and
 * guessing at what was meant would hide it.
 */
export function validateGroup(body, rows, existingGroups) {
  const errors = [];
  const b = body && typeof body === "object" ? body : {};
  const roster = Array.isArray(rows) ? rows : [];
  const groups = Array.isArray(existingGroups) ? existingGroups : [];

  const primaryId = str(b.primaryId);
  const memberIds = [...new Set((Array.isArray(b.memberIds) ? b.memberIds : []).map(str).filter(Boolean))]
    .filter((id) => id !== primaryId);

  if (!primaryId) errors.push("Pick which record the others merge into");
  if (!memberIds.length) errors.push("Pick at least one other record to merge in");

  const byId = {};
  roster.forEach((r) => { byId[String(r.customer_id)] = r; });

  if (primaryId && !byId[primaryId]) errors.push("The record being merged into is not in the roster");
  memberIds.forEach((id) => {
    if (!byId[id]) errors.push("Customer " + id + " is not in the roster");
  });

  // Already spoken for. Merging a record into two different customers would
  // double-count its revenue, and which fold ran first would decide the answer.
  const taken = memberIndex(groups);
  [primaryId, ...memberIds].forEach((id) => {
    if (id && taken[id] && taken[id].id !== str(b.id)) {
      errors.push(
        (byId[id] ? byId[id].company_name : id) + " is already merged into another client"
      );
    }
  });

  // The name defaults to the primary's rather than being demanded, but a name
  // that matches none of the records is allowed on purpose: the company may go
  // by something none of the Printavo records spell correctly.
  const name = str(b.name) || (byId[primaryId] ? str(byId[primaryId].company_name) : "");
  if (!name) errors.push("A merged client needs a name");

  if (errors.length) return { ok: false, errors, group: null };

  return {
    ok: true,
    errors: [],
    group: {
      primaryId,
      memberIds,
      name: name.slice(0, 120),
      note: str(b.note).slice(0, 500),
    },
  };
}

/* ------------------------------------------------------------------ *
 * WRITING BACK
 *
 * THE SHARP EDGE OF FOLDING AT READ TIME. The browser is handed a roster that
 * has already been folded, and BackBone writes the whole roster back in a
 * couple of places (promoting a lead to the roster, resetting to seed). Without
 * a guard, one of those writes would:
 *
 *   1. DELETE every absorbed customer, permanently, because they are simply
 *      not in the array the browser holds; and
 *   2. Store the FOLDED primary, whose revenue is already the sum of the
 *      group, which the next read would then fold again and double.
 *
 * Neither has a visible symptom on the day it happens. So the write path
 * un-folds rather than trusting the caller to have been careful: the absorbed
 * rows are put back from storage, and any row that arrives carrying the folded
 * marker is replaced with the stored original for that id.
 *
 * The rule is one line: STORAGE HOLDS THE ORIGINAL ROWS, ALWAYS. The fold
 * exists only between the database and the screen.
 * ------------------------------------------------------------------ */

/** Fields the fold adds. Never persisted, whoever sends them. */
const FOLD_MARKERS = ["merged", "merged_from", "merge_id", "median_gap_estimated"];

function stripFoldMarkers(row) {
  const out = { ...row };
  FOLD_MARKERS.forEach((f) => { delete out[f]; });
  return out;
}

/**
 * Reconcile an incoming write against what merges are hiding.
 *
 * @param existing  the stored payload, unfolded
 * @param incoming  { synced?, enrichment? } as sent by the caller
 * @param groups    the merge groups
 * @returns { synced?, enrichment?, restored: { rows, enrichments, unfolded } }
 *
 * Only the keys the caller actually sent come back, so api/save.js keeps its
 * partial-write behaviour: sending enrichment alone must not touch synced.
 */
export function restoreAbsorbed(existing, incoming, groups) {
  const prev = existing || {};
  const sent = incoming || {};
  const index = memberIndex(groups);
  const absorbed = new Set(Object.keys(index));
  const primaries = new Set(
    (Array.isArray(groups) ? groups : []).filter((g) => g && g.primaryId).map((g) => String(g.primaryId))
  );

  const out = {};
  const restored = { rows: 0, enrichments: 0, unfolded: 0 };

  if (sent.synced !== undefined) {
    const prevById = {};
    (Array.isArray(prev.synced) ? prev.synced : []).forEach((r) => {
      prevById[String(r.customer_id)] = r;
    });

    const rows = (Array.isArray(sent.synced) ? sent.synced : []).map((r) => {
      const id = String(r && r.customer_id);
      // A folded primary. Take the stored original rather than the summed copy
      // the screen was holding, or the totals compound on every save.
      if (r && (r.merged === true || primaries.has(id)) && prevById[id]) {
        restored.unfolded++;
        return prevById[id];
      }
      return stripFoldMarkers(r || {});
    });

    const present = new Set(rows.map((r) => String(r.customer_id)));
    Object.keys(prevById).forEach((id) => {
      if (absorbed.has(id) && !present.has(id)) {
        rows.push(prevById[id]);
        restored.rows++;
      }
    });

    out.synced = rows;
  }

  if (sent.enrichment !== undefined) {
    const prevEnr = prev.enrichment || {};
    const next = { ...(sent.enrichment || {}) };
    Object.keys(prevEnr).forEach((id) => {
      if (absorbed.has(String(id)) && next[id] === undefined) {
        next[id] = prevEnr[id];
        restored.enrichments++;
      }
    });
    out.enrichment = next;
  }

  return { ...out, restored };
}

/* ------------------------------------------------------------------ *
 * THE CHECKING SHEET
 *
 * The scan is a question, not a finding, and the person best placed to answer
 * it is whoever deals with that customer. This is the list as a spreadsheet
 * they can open next to Printavo: both records side by side, the evidence
 * spelled out, and empty columns to write the answer in.
 *
 * IT ENDS IN BLANK COLUMNS ON PURPOSE. A sheet that only presents findings
 * gets read and forgotten. One with somewhere to write comes back.
 * ------------------------------------------------------------------ */

export const SUGGESTION_COLUMNS = [
  "Pair", "Confidence", "Why we think so",
  "A: Printavo ID", "A: Name", "A: Revenue", "A: Invoices", "A: Last invoice", "A: ZIP", "A: Contact",
  "B: Printavo ID", "B: Name", "B: Revenue", "B: Invoices", "B: Last invoice", "B: ZIP", "B: Contact",
  "Same company? (yes/no)", "If yes, which name should we use?", "Checked by", "Notes",
];

function csvCell(v) {
  const s = String(v == null ? "" : v);
  // A leading =, +, - or @ runs as a formula when Excel opens the file, and
  // company names come from Printavo rather than from us.
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

const money = (n) => (Math.round(num(n) * 100) / 100).toFixed(2);

export function buildSuggestionsCsv(suggestions) {
  const rows = Array.isArray(suggestions) ? suggestions : [];
  // The header goes through csvCell too. One of these columns has a comma in
  // it, and an unquoted header splits into two columns while every data row
  // stays the right width, which is a sheet that opens misaligned.
  const lines = [SUGGESTION_COLUMNS.map(csvCell).join(",")];

  rows.forEach((sg, i) => {
    const a = (sg && sg.rows && sg.rows[0]) || {};
    const b = (sg && sg.rows && sg.rows[1]) || {};
    lines.push([
      i + 1,
      sg.confidence || "",
      // Every reason on one line, semicolon separated. A cell full of newlines
      // reads badly in a spreadsheet and pastes worse.
      (sg.reasons || []).join("; "),
      a.customer_id || "", a.company_name || "", money(a.total_revenue), a.invoice_count == null ? "" : a.invoice_count,
      a.last_invoice_date || "", a.zip || "", a.contact || "",
      b.customer_id || "", b.company_name || "", money(b.total_revenue), b.invoice_count == null ? "" : b.invoice_count,
      b.last_invoice_date || "", b.zip || "", b.contact || "",
      "", "", "", "",
    ].map(csvCell).join(","));
  });

  return lines.join("\r\n") + "\r\n";
}
