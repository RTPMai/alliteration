// lib/concontrol/schema.js — ConControl data schema (v1, Sep 2026).
//
// ConControl tracks an event: who sponsors it, what they owe, what they
// still have to send us, and what we spend putting it on. Flyover Con is the
// first event through it, and the record shape is event-scoped rather than
// Flyover-specific so FOC28 does not mean a second app.
//
// WHY THIS IS NOT A SPREADSHEET. The money half of a sponsor is easy in
// Excel. The part Excel is worst at is the deliverables: a sponsor who has
// paid in full but never sent a logo is not done, and a column of blank cells
// does not tell you whether the blank means "not yet" or "never owed one".
// Every deliverable here is one of three states, and N/A is a real answer a
// person chose, not an empty cell.
//
// TWO THINGS ARE DELIBERATELY NOT STORED:
//   - `paid` as a number. Payments arrive in pieces; the total is derived from
//     the payment list so a half payment can never overwrite the record of the
//     first half.
//   - `outstanding`. Derived, always. A stored balance is a second copy of a
//     fact that drifts the first time somebody edits the committed amount.
//
// ESM. Do NOT convert to module.exports.

export const KEY_PREFIX = "concontrol_data";

export const keys = {
  // One key shape per collection. of("sponsor") keeps the original key names
  // (concontrol_data:sponsor:SP-0001 and concontrol_data:index) so nothing
  // written before the ledger existed has to move.
  of: (kind) => ({
    record: (id) => `${KEY_PREFIX}:${kind}:${id}`,
    index: () => (kind === "sponsor" ? `${KEY_PREFIX}:index` : `${KEY_PREFIX}:${kind}:index`),
    counter: () => (kind === "sponsor" ? `${KEY_PREFIX}:counter` : `${KEY_PREFIX}:${kind}:counter`),
  }),
  sponsor: (id) => `${KEY_PREFIX}:sponsor:${id}`,
  index: () => `${KEY_PREFIX}:index`,
  counter: () => `${KEY_PREFIX}:counter`,
  settings: () => `${KEY_PREFIX}:settings`,
};

/**
 * Where the money goes. Seeded from what the sponsor page says sponsorship
 * pays for: food, video, venue, and the hours the team spends off the
 * production floor. Stored in settings, so this is a starting point rather
 * than a rule.
 */
export const SEED_CATEGORIES = [
  "Food and drink",
  "Video and photo",
  "Venue and setup",
  "Print and signage",
  "Swag and bags",
  "Speaker costs",
  "Software and web",
  "Other",
];

/**
 * The event a record belongs to. Everything is scoped by this, and the app
 * filters on it, so last year's paid sponsors do not sit in this year's
 * outstanding total. Free text on purpose: a new event is typing a new code,
 * not a deploy.
 */
export const DEFAULT_EVENT = "FOC27";

/**
 * Where a sponsor is in the conversation. Money is NOT a stage: a sponsor who
 * has committed and not paid and a sponsor who has committed and paid are at
 * the same point in the relationship, and the ledger already knows which is
 * which. Stages that duplicate the money were the first thing cut.
 */
export const STATUSES = ["inquiry", "talking", "committed", "declined", "lost"];
export const DEFAULT_STATUS = "inquiry";

export const STATUS_LABELS = {
  inquiry: "Inquiry",
  talking: "In conversation",
  committed: "Committed",
  declined: "Declined",
  lost: "Went quiet",
};

/** Statuses that mean this sponsor is not happening. Kept out of every total. */
export const CLOSED_STATUSES = ["declined", "lost"];

/**
 * Tiers are a SETTING, not a constant, because a tier lineup gets rewritten
 * between events and a code deploy is the wrong shape for that. These are the
 * seed values only; whatever is in settings wins. A sponsor keeps the tier
 * NAME it was sold at, so renaming a tier later does not rewrite history.
 */
export const SEED_TIERS = [
  { name: "Presenting", amount: 7000, slots: 1 },
  { name: "Gold", amount: 2500, slots: 3 },
  { name: "Silver", amount: 1000, slots: null },
  { name: "In kind", amount: null, slots: null },
  { name: "Single moment", amount: null, slots: null },
];

/**
 * The individual moments a sponsor can put their name on, outside the three
 * levels. Each one can only be claimed once, which is the whole reason they
 * are a list and not free text: the public page says "ask and we will tell you
 * what is still unclaimed", and that question has to be answerable from here
 * rather than from memory.
 */
export const MOMENTS = [
  { key: "happy-hour", label: "Happy hour" },
  { key: "day-1-lunch", label: "Day 1 lunch" },
  { key: "day-2-lunch", label: "Day 2 lunch" },
  { key: "breakfast", label: "Breakfast" },
  { key: "swag-bags", label: "Swag bags" },
];

export const MOMENT_KEYS = MOMENTS.map((m) => m.key);

export function momentLabel(key) {
  const hit = MOMENTS.find((m) => m.key === key);
  return hit ? hit.label : key;
}

/**
 * The deliverables checklist. Fixed keys, because the whole point is that the
 * same four questions get asked of every sponsor and answered the same way.
 * Per-sponsor free-text extras live in notes, not here: a checklist that
 * varies per row cannot be rolled up, and rolling up is why it exists.
 */
export const DELIVERABLES = [
  { key: "logo", label: "Logo received", hint: "Vector or high-res, for print and web" },
  { key: "swag", label: "Swag item received", hint: "For the attendee bags" },
  { key: "social", label: "Social posted", hint: "Announcement post is live" },
  { key: "session", label: "Session scheduled", hint: "If the tier includes stage time" },
];

export const DELIVERABLE_KEYS = DELIVERABLES.map((d) => d.key);

/**
 * WHAT WE OWE THEM, which is the other half of the checklist and the half that
 * actually costs money when it is missed.
 *
 * The deliverables above are what a sponsor sends us. These are the promises
 * the sponsor page makes back: signage, mentions, social, the attendee list,
 * stage time. A sponsor who never sent a logo is an annoyance. A sponsor who
 * paid seven thousand dollars and never got the welcome address is a refund
 * conversation, and until now the only record of what they were promised was
 * the website.
 *
 * `tiers` is which levels owe each item. An obligation that does not apply to
 * a sponsor's level is not shown and not counted, which is the same rule N/A
 * gives the other checklist, decided from the level instead of by hand.
 *
 * TAKEN OFF THE SPONSOR PAGE, ONE ROW PER BULLET. That page is what a sponsor
 * read before they said yes, so it is the list, and these track it word for
 * word rather than paraphrasing. When the page changes, change this. A row
 * here that the page does not promise is a thing we chase ourselves for; a
 * bullet on the page with no row here is a promise nobody is tracking.
 */
export const OBLIGATIONS = [
  // Every sponsor, every level. The one promise on the page that is not in a
  // level box, and the easiest to forget precisely because it is not: nobody
  // sends a sponsor their registration, and then their team turns up unlisted.
  { key: "access", label: "Their team registered for both days, meals included", tiers: ["Silver", "Gold", "Presenting"] },

  // Silver, word for word off the page. One bullet, one row: the page sells
  // signage, website and agenda as a single promise, and splitting it here
  // would make a sponsor look half-delivered when they are not.
  { key: "signage", label: "Logo on event signage, website and digital agenda", tiers: ["Silver", "Gold", "Presenting"] },
  { key: "remarks", label: "Mention during opening and closing remarks", tiers: ["Silver", "Gold", "Presenting"] },
  { key: "bag", label: "Materials included in attendee swag bags", tiers: ["Silver", "Gold", "Presenting"] },
  { key: "social-group", label: "Group social recognition and event recap inclusion", tiers: ["Silver", "Gold", "Presenting"] },

  // Gold, everything in Silver plus these four.
  { key: "intro", label: "Time to introduce themselves to the full room on day one", tiers: ["Gold", "Presenting"] },
  { key: "session-recognition", label: "Recognition during major sessions and at lunch", tiers: ["Gold", "Presenting"] },
  { key: "social-feature", label: "Dedicated social features before and during the event", tiers: ["Gold", "Presenting"] },
  { key: "attendee-list", label: "Opt-in attendee contact list sent after the event", tiers: ["Gold", "Presenting"] },

  // Presenting, everything in Gold plus these five.
  { key: "branding", label: "Event branded as presented by them across all materials", tiers: ["Presenting"] },
  { key: "welcome", label: "Stage recognition at opening and closing, welcome address offered", tiers: ["Presenting"] },
  { key: "swag-logo", label: "Logo on attendee swag bags and event apparel", tiers: ["Presenting"] },
  { key: "social-all", label: "Featured in all pre-event and post-event social media", tiers: ["Presenting"] },
  { key: "refusal", label: "First right of refusal on the 2028 presenting slot", tiers: ["Presenting"] },
];

export const OBLIGATION_KEYS = OBLIGATIONS.map((o) => o.key);

/** The obligations a given level actually carries. */
export function obligationsFor(tier) {
  const name = str(tier);
  if (!name) return [];
  return OBLIGATIONS.filter((o) => o.tiers.includes(name));
}

/**
 * Three states, and N/A is one of them.
 *
 * A Bronze sponsor never owed a session. Without N/A that row sits open
 * forever, the screen shows four sponsors blocked when one is, and within a
 * month nobody reads the column. "Nobody owes this" is an answer somebody
 * gave, and it is stored as one.
 */
export const DELIVERABLE_STATES = ["open", "done", "na"];
export const DEFAULT_DELIVERABLE_STATE = "open";

/* ------------------------------------------------------------------ *
 * SMALL HELPERS
 * ------------------------------------------------------------------ */

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function pickOne(raw, allowed, fallback) {
  const s = str(raw);
  return allowed.includes(s) ? s : fallback;
}

/**
 * Money in, as a number or null. NEVER zero-on-unparseable: a committed
 * amount somebody fat-fingered must not silently become $0 committed, which
 * reads as a real decision on every total it touches.
 */
export function money(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

/** ISO date (YYYY-MM-DD) or null. Dates are days here, never timestamps. */
export function isoDate(v) {
  const s = str(v);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T12:00:00Z");
  return Number.isNaN(d.getTime()) ? null : s;
}

export function isValidEmail(v) {
  const s = str(v).toLowerCase();
  return !!s && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

/**
 * HOW A SPONSOR PAID, which is not the same question as whether they paid.
 *
 *   cash     a check or a transfer. Money in the bank.
 *   credit   a credit on our account with them. SanMar's $7,000 is this: it
 *            does not arrive, it means we do not spend that much with SanMar.
 *   in-kind  goods or services they provide directly. The video, the swag,
 *            the printing.
 *
 * ALL THREE SATISFY THE SPONSOR. Somebody who gave a $7,000 credit for a
 * $7,000 level has paid in full, owes nothing, and is owed everything the level
 * promises. That is why paidTotal counts all three.
 *
 * ONLY CASH IS CASH. A total that adds a credit to the bank balance is a number
 * you would quote to somebody and be wrong. They are reported apart everywhere
 * a total is shown.
 *
 * ONE HONEST LIMIT, WORTH KNOWING. A $7,000 credit only saves $7,000 if we were
 * going to spend $7,000 with them. Spend $3,000 and the other $4,000 is value
 * that never happens. This records what was agreed, not what got used; the
 * ledger is where the actual spend shows up.
 */
export const PAYMENT_KINDS = ["cash", "credit", "in-kind"];
export const DEFAULT_PAYMENT_KIND = "cash";
export const PAYMENT_KIND_LABELS = {
  cash: "Cash",
  credit: "Account credit",
  "in-kind": "In kind",
};

/* ------------------------------------------------------------------ *
 * DERIVED MONEY — the single reader
 *
 * Same pattern as poHealth() in PromoPro and isOverStipend() in CrewCore: the
 * screen, the route and the tests all call this, so a sponsor's balance is
 * never computed twice in two places and cannot disagree with itself.
 * ------------------------------------------------------------------ */

export function paidTotal(sponsor) {
  const list = sponsor && Array.isArray(sponsor.payments) ? sponsor.payments : [];
  return list.reduce((sum, p) => {
    const amt = money(p && p.amount);
    return sum + (amt || 0);
  }, 0);
}

/**
 * The same total, split by how it arrived.
 *
 * A payment with no kind recorded counts as cash, because every payment written
 * before this existed was a check. Reading it as unknown would turn a year of
 * real money into a question mark.
 */
export function paidByKind(sponsor) {
  const list = sponsor && Array.isArray(sponsor.payments) ? sponsor.payments : [];
  const out = { cash: 0, credit: 0, "in-kind": 0 };
  for (const p of list) {
    const amt = money(p && p.amount);
    if (amt === null) continue;
    const kind = pickOne(p && p.kind, PAYMENT_KINDS, DEFAULT_PAYMENT_KIND);
    out[kind] += amt;
  }
  out.cash = Math.round(out.cash * 100) / 100;
  out.credit = Math.round(out.credit * 100) / 100;
  out["in-kind"] = Math.round(out["in-kind"] * 100) / 100;
  // Everything that is not a check. The number to hold apart from the bank.
  out.value = Math.round((out.credit + out["in-kind"]) * 100) / 100;
  return out;
}

/**
 * The money picture for one sponsor.
 *
 * `committed` null means nobody has agreed a number yet. That is NOT zero, and
 * it is reported as unknown so a rollup cannot quietly count an unpriced
 * sponsor as free. Same rule MarketMachine uses for a missing reach figure.
 */
export function sponsorMoney(sponsor) {
  const committed = money(sponsor && sponsor.committed);
  const invoiced = money(sponsor && sponsor.invoicedAmount);
  const paid = paidTotal(sponsor);
  const kinds = paidByKind(sponsor);
  const known = committed !== null;

  return {
    committed,
    // How it came in. `paid` is all three together, which is what the sponsor
    // has delivered; `cash` is the only one that reached the bank.
    cash: kinds.cash,
    credit: kinds.credit,
    inKind: kinds["in-kind"],
    nonCash: kinds.value,
    committedKnown: known,
    invoiced,
    invoicedAt: isoDate(sponsor && sponsor.invoicedAt),
    paid,
    // Outstanding is only meaningful against a number somebody agreed to.
    outstanding: known ? Math.round((committed - paid) * 100) / 100 : null,
    paidInFull: known && paid >= committed && committed > 0,
    overpaid: known && paid > committed,
    // Committed, never invoiced. The quiet failure this app exists to catch:
    // a sponsor who said yes in March and was never billed.
    awaitingInvoice: known && committed > 0 && invoiced === null && paid === 0,
  };
}

/**
 * Deliverable states for one sponsor, normalised. Reads an absent key as open
 * rather than inventing a done, so a record written before a deliverable
 * existed shows up as work rather than as finished work nobody did.
 */
export function deliverableStates(sponsor) {
  const raw = (sponsor && sponsor.deliverables) || {};
  const out = {};
  for (const key of DELIVERABLE_KEYS) {
    const entry = raw[key];
    const state = pickOne(entry && entry.state, DELIVERABLE_STATES, DEFAULT_DELIVERABLE_STATE);
    out[key] = {
      state,
      at: isoDate(entry && entry.at),
      by: str(entry && entry.by) || null,
      note: str(entry && entry.note) || null,
    };
  }
  return out;
}

/**
 * Obligation states for one sponsor, limited to the ones their level carries.
 *
 * Absent reads as open, same as deliverables: a record written before an
 * obligation existed shows the work as outstanding rather than as work nobody
 * did being quietly marked done.
 */
export function obligationStates(sponsor) {
  const raw = (sponsor && sponsor.obligations) || {};
  const out = {};
  for (const o of obligationsFor(sponsor && sponsor.tier)) {
    const entry = raw[o.key];
    out[o.key] = {
      label: o.label,
      state: pickOne(entry && entry.state, ["open", "done"], "open"),
      at: isoDate(entry && entry.at),
      by: str(entry && entry.by) || null,
    };
  }
  return out;
}

export function obligationProgress(sponsor) {
  const states = obligationStates(sponsor);
  const all = Object.keys(states);
  const done = all.filter((k) => states[k].state === "done").length;
  return { done, open: all.length - done, owed: all.length, complete: all.length > 0 && done === all.length };
}

export function deliverableProgress(sponsor) {
  const states = deliverableStates(sponsor);
  let done = 0;
  let open = 0;
  let na = 0;
  for (const key of DELIVERABLE_KEYS) {
    const s = states[key].state;
    if (s === "done") done += 1;
    else if (s === "na") na += 1;
    else open += 1;
  }
  // The denominator EXCLUDES N/A. "2 of 2" for a Bronze sponsor is the truth;
  // "2 of 4" reads as half finished forever.
  const owed = done + open;
  return { done, open, na, owed, complete: open === 0 };
}

/**
 * One sponsor's health, for the list and the home totals.
 *
 * Returns a level and the reason in words. The reason is the point: a red dot
 * that does not say why sends somebody into the record to work it out, which
 * is the thing this replaced.
 */
export function sponsorHealth(sponsor, today = new Date()) {
  const status = pickOne(sponsor && sponsor.status, STATUSES, DEFAULT_STATUS);
  if (CLOSED_STATUSES.includes(status)) {
    return { level: "closed", why: STATUS_LABELS[status] };
  }

  const m = sponsorMoney(sponsor);
  const p = deliverableProgress(sponsor);

  // Money arrived but the record still says they are thinking about it. Worth
  // saying out loud rather than silently papering over: the status drives the
  // filters and the exports, so a paid sponsor sitting at "inquiry" is missing
  // from the committed list and from the signage sheet.
  if (m.paid > 0 && (status === "inquiry" || status === "talking")) {
    return { level: "attention", why: `Paid ${usdish(m.paid)}, still marked as ${STATUS_LABELS[status].toLowerCase()}` };
  }

  if (status === "committed" && !m.committedKnown) {
    return { level: "attention", why: "Committed with no amount agreed" };
  }
  if (m.awaitingInvoice) {
    return { level: "attention", why: "Committed, never invoiced" };
  }

  if (m.invoicedAt && m.outstanding !== null && m.outstanding > 0) {
    const days = daysBetween(m.invoicedAt, today);
    if (days !== null && days >= 30) {
      return { level: "attention", why: `Invoiced ${days} days ago, unpaid` };
    }
    return { level: "waiting", why: "Invoiced, awaiting payment" };
  }

  if (m.paidInFull && !p.complete) {
    return { level: "waiting", why: `Paid, ${p.open} deliverable${p.open === 1 ? "" : "s"} outstanding` };
  }
  if (m.paidInFull && p.complete) {
    // Their side is finished. Ours might not be, and that is the half that
    // costs money when it is missed.
    const o = obligationProgress(sponsor);
    if (o.owed && !o.complete) {
      return { level: "waiting", why: `Paid, we owe them ${o.open} thing${o.open === 1 ? "" : "s"}` };
    }
    return { level: "done", why: "Paid and complete" };
  }

  if (status === "inquiry" || status === "talking") {
    return { level: "open", why: STATUS_LABELS[status] };
  }
  return { level: "open", why: "In progress" };
}

/** A short dollar figure for a sentence, not a table. */
function usdish(n) {
  return "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function daysBetween(isoFrom, to) {
  const from = isoDate(isoFrom);
  if (!from) return null;
  const a = new Date(from + "T12:00:00Z").getTime();
  const b = to instanceof Date ? to.getTime() : new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86400000);
}

/**
 * Roll a list of sponsors up for the totals strip.
 *
 * MISSING IS NOT ZERO. Sponsors with no committed amount are counted and
 * reported separately rather than folded in as nothing, so a total can never
 * look authoritative while three unpriced sponsors sit behind it.
 */
export function rollup(sponsors, today = new Date()) {
  const live = (sponsors || []).filter(
    (s) => !CLOSED_STATUSES.includes(pickOne(s && s.status, STATUSES, DEFAULT_STATUS))
  );

  let committed = 0;
  let collected = 0;
  let cash = 0;
  let credit = 0;
  let inKind = 0;
  let unpriced = 0;
  let blocked = 0;
  let deliverablesOpen = 0;

  for (const s of live) {
    const m = sponsorMoney(s);
    if (m.committedKnown) committed += m.committed;
    else unpriced += 1;
    collected += m.paid;
    cash += m.cash;
    credit += m.credit;
    inKind += m.inKind;

    const h = sponsorHealth(s, today);
    if (h.level === "attention") blocked += 1;

    deliverablesOpen += deliverableProgress(s).open;
  }

  return {
    sponsorCount: live.length,
    committed: Math.round(committed * 100) / 100,
    // Everything a sponsor has delivered, in any form.
    collected: Math.round(collected * 100) / 100,
    // The three apart, because only the first one is in the bank.
    cash: Math.round(cash * 100) / 100,
    credit: Math.round(credit * 100) / 100,
    inKind: Math.round(inKind * 100) / 100,
    nonCash: Math.round((credit + inKind) * 100) / 100,
    outstanding: Math.round((committed - collected) * 100) / 100,
    unpriced,
    blocked,
    deliverablesOpen,
  };
}

/**
 * One line of a record's trail. Who did what, when, in words.
 *
 * Stored on the record rather than in a side log, because the question is
 * always "what happened to THIS sponsor" and a separate log is a second thing
 * to keep and a second thing to lose.
 */
export function historyEntry(what, who, detail) {
  return {
    at: new Date().toISOString(),
    by: str(who) || null,
    what: str(what),
    detail: str(detail) || null,
  };
}

/**
 * Describe what a patch changed, for the trail. Returns null when nothing
 * worth recording moved: a trail that logs every keystroke is a trail nobody
 * reads.
 */
export function describeChange(before, patch) {
  const bits = [];
  if ("status" in patch && patch.status !== before.status) {
    bits.push(`status ${STATUS_LABELS[before.status] || before.status} to ${STATUS_LABELS[patch.status] || patch.status}`);
  }
  if ("tier" in patch && patch.tier !== before.tier) {
    bits.push(`level ${before.tier || "none"} to ${patch.tier || "none"}`);
  }
  if ("committed" in patch && patch.committed !== before.committed) {
    bits.push(`committed ${before.committed === null ? "unset" : before.committed} to ${patch.committed === null ? "unset" : patch.committed}`);
  }
  if ("payments" in patch) {
    const was = paidTotal(before);
    const now = patch.payments.reduce((sum, p) => sum + (money(p.amount) || 0), 0);
    if (was !== now) bits.push(`paid ${was} to ${now}`);
  }
  if ("invoicedAmount" in patch && patch.invoicedAmount !== before.invoicedAmount) {
    bits.push(`invoiced ${patch.invoicedAmount === null ? "cleared" : patch.invoicedAmount}`);
  }
  if ("moments" in patch) {
    const was = (before.moments || []).join(",");
    const now = patch.moments.join(",");
    if (was !== now) bits.push(`moments ${now || "none"}`);
  }
  return bits.length ? bits.join(", ") : null;
}

/* ------------------------------------------------------------------ *
 * INVENTORY
 *
 * Presenting is 1 available and Gold is 3. Those numbers are printed on the
 * public sponsor page, which means somebody has to know whether they are still
 * true before selling the fourth Gold. Counting them here is the only way that
 * question gets answered from the record rather than from memory.
 * ------------------------------------------------------------------ */

/**
 * Has this sponsor taken their place?
 *
 * MONEY BEATS THE DROPDOWN. It used to be status alone, which meant a sponsor
 * who had paid seven thousand dollars still showed as "in conversation" and
 * their level still showed as available, because nobody had gone back and
 * changed a select. A payment is the strongest possible evidence that somebody
 * is in, and it is evidence the sponsor created rather than something we typed.
 *
 * An agreed amount with nothing paid is NOT enough on its own: that is a number
 * we wrote down, and the status is the right place to say whether they have
 * actually said yes.
 */
export function hasTakenPlace(sponsor) {
  if (!sponsor) return false;
  const status = pickOne(sponsor.status, STATUSES, DEFAULT_STATUS);
  if (CLOSED_STATUSES.includes(status)) return false;
  return status === "committed" || paidTotal(sponsor) > 0;
}

/**
 * Slots per tier: how many are taken, how many are in conversation, how many
 * are left.
 *
 * An inquiry is NOT a slot: holding one of three Gold places for somebody who
 * emailed once is how a sponsor who is ready to pay gets told there is no room.
 * They are counted separately as `pending`, so the pressure is visible without
 * being binding.
 */
export function tierAvailability(sponsors, tiers) {
  const list = Array.isArray(tiers) && tiers.length ? tiers : SEED_TIERS;
  const rows = (sponsors || []).filter((s) => !CLOSED_STATUSES.includes(
    pickOne(s && s.status, STATUSES, DEFAULT_STATUS)
  ));

  return list.map((tier) => {
    const mine = rows.filter((s) => str(s.tier) === tier.name);
    const sold = mine.filter(hasTakenPlace).length;
    const pending = mine.length - sold;
    const slots = Number.isFinite(tier.slots) ? tier.slots : null;
    return {
      name: tier.name,
      amount: money(tier.amount),
      slots,
      sold,
      pending,
      left: slots === null ? null : Math.max(0, slots - sold),
      soldOut: slots !== null && sold >= slots,
      // More committed sponsors than places. Not impossible, just wrong, and
      // silence here would mean finding out at the signage proof.
      oversold: slots !== null && sold > slots,
    };
  });
}

/**
 * Who has claimed each individual moment, or nobody.
 *
 * Reports a conflict rather than picking a winner. Two sponsors both told they
 * have day one lunch is a conversation somebody has to have, and the app
 * quietly showing one of them would hide it until the signage went to print.
 */
export function momentAvailability(sponsors) {
  const rows = (sponsors || []).filter((s) => !CLOSED_STATUSES.includes(
    pickOne(s && s.status, STATUSES, DEFAULT_STATUS)
  ));

  return MOMENTS.map((m) => {
    const holders = rows.filter((s) => Array.isArray(s.moments) && s.moments.includes(m.key));
    const committed = holders.filter(hasTakenPlace);
    return {
      key: m.key,
      label: m.label,
      claimedBy: committed.length ? str(committed[0].company) : null,
      pendingBy: !committed.length && holders.length ? str(holders[0].company) : null,
      open: committed.length === 0,
      conflict: committed.length > 1,
    };
  });
}

/* ------------------------------------------------------------------ *
 * VALIDATION
 * ------------------------------------------------------------------ */

/**
 * Validate a create or patch body. Returns { ok, errors, patch }.
 *
 * Only keys the caller actually sent end up in `patch`, so a PATCH never
 * blanks a field the form did not include. That is the same merge rule
 * MarketMachine uses and the reason an edit screen showing six of twelve
 * fields cannot wipe the other six.
 */
export function validateSponsorPatch(body) {
  const b = body && typeof body === "object" ? body : {};
  const errors = [];
  const patch = {};

  if ("company" in b) {
    const company = str(b.company);
    if (!company) errors.push("Company name cannot be empty");
    else patch.company = company;
  }

  if ("contactName" in b) patch.contactName = str(b.contactName);

  if ("email" in b) {
    const email = str(b.email).toLowerCase();
    if (email && !isValidEmail(email)) errors.push("That email address does not look right");
    else patch.email = email;
  }

  if ("phone" in b) patch.phone = str(b.phone);
  if ("website" in b) patch.website = str(b.website);
  if ("notes" in b) patch.notes = str(b.notes);
  if ("tier" in b) patch.tier = str(b.tier);
  if ("event" in b) patch.event = str(b.event) || DEFAULT_EVENT;

  if ("status" in b) {
    const status = str(b.status);
    if (!STATUSES.includes(status)) errors.push(`Unknown status "${status}"`);
    else patch.status = status;
  }

  if ("committed" in b) {
    if (b.committed === null || b.committed === "") patch.committed = null;
    else {
      const amt = money(b.committed);
      if (amt === null) errors.push("Committed amount is not a number");
      else if (amt < 0) errors.push("Committed amount cannot be negative");
      else patch.committed = amt;
    }
  }

  if ("invoicedAmount" in b) {
    if (b.invoicedAmount === null || b.invoicedAmount === "") patch.invoicedAmount = null;
    else {
      const amt = money(b.invoicedAmount);
      if (amt === null) errors.push("Invoiced amount is not a number");
      else patch.invoicedAmount = amt;
    }
  }

  if ("invoicedAt" in b) {
    if (b.invoicedAt === null || b.invoicedAt === "") patch.invoicedAt = null;
    else {
      const d = isoDate(b.invoicedAt);
      if (!d) errors.push("Invoice date must be YYYY-MM-DD");
      else patch.invoicedAt = d;
    }
  }

  if ("payments" in b) {
    const rows = Array.isArray(b.payments) ? b.payments : null;
    if (!rows) errors.push("Payments must be a list");
    else {
      const clean = [];
      rows.forEach((p, i) => {
        const amt = money(p && p.amount);
        if (amt === null) { errors.push(`Payment ${i + 1} has no amount`); return; }
        if (amt <= 0) { errors.push(`Payment ${i + 1} must be more than zero`); return; }
        const kind = str(p && p.kind);
        if (kind && !PAYMENT_KINDS.includes(kind)) {
          errors.push(`Payment ${i + 1}: "${kind}" is not cash, credit or in kind`);
          return;
        }
        clean.push({
          amount: amt,
          kind: kind || DEFAULT_PAYMENT_KIND,
          date: isoDate(p && p.date),
          method: str(p && p.method) || null,
          note: str(p && p.note) || null,
        });
      });
      patch.payments = clean;
    }
  }

  if ("invoiceNumber" in b) patch.invoiceNumber = str(b.invoiceNumber).slice(0, 60);

  if ("obligations" in b) {
    const raw = b.obligations && typeof b.obligations === "object" ? b.obligations : null;
    if (!raw) errors.push("Obligations must be an object");
    else {
      const clean = {};
      for (const key of Object.keys(raw)) {
        if (!OBLIGATION_KEYS.includes(key)) { errors.push(`Unknown obligation "${key}"`); continue; }
        const entry = raw[key] || {};
        const state = str(entry.state);
        if (state && !["open", "done"].includes(state)) { errors.push(`Unknown state "${state}" for ${key}`); continue; }
        clean[key] = { state: state || "open", at: isoDate(entry.at), by: str(entry.by) || null };
      }
      patch.obligations = clean;
    }
  }

  if ("moments" in b) {
    const rows = Array.isArray(b.moments) ? b.moments : null;
    if (!rows) errors.push("Moments must be a list");
    else {
      const clean = [];
      for (const raw of rows) {
        const key = str(raw);
        if (!MOMENT_KEYS.includes(key)) { errors.push(`Unknown moment "${key}"`); continue; }
        if (!clean.includes(key)) clean.push(key);
      }
      patch.moments = clean;
    }
  }

  if ("deliverables" in b) {
    const raw = b.deliverables && typeof b.deliverables === "object" ? b.deliverables : null;
    if (!raw) errors.push("Deliverables must be an object");
    else {
      const clean = {};
      for (const key of Object.keys(raw)) {
        if (!DELIVERABLE_KEYS.includes(key)) { errors.push(`Unknown deliverable "${key}"`); continue; }
        const entry = raw[key] || {};
        const state = str(entry.state);
        if (state && !DELIVERABLE_STATES.includes(state)) {
          errors.push(`Unknown state "${state}" for ${key}`);
          continue;
        }
        clean[key] = {
          state: state || DEFAULT_DELIVERABLE_STATE,
          at: isoDate(entry.at),
          by: str(entry.by) || null,
          note: str(entry.note) || null,
        };
      }
      patch.deliverables = clean;
    }
  }

  // `history` is deliberately absent from everything above. The trail is
  // appended by the store, never sent by a caller, so nothing on the wire can
  // shorten it.
  return { ok: errors.length === 0, errors, patch };
}

/** A brand new record, before any patch is merged onto it. */
export function newSponsor(id, who) {
  const deliverables = {};
  for (const key of DELIVERABLE_KEYS) {
    deliverables[key] = { state: DEFAULT_DELIVERABLE_STATE, at: null, by: null, note: null };
  }
  return {
    id,
    event: DEFAULT_EVENT,
    company: "",
    contactName: "",
    email: "",
    phone: "",
    website: "",
    tier: "",
    status: DEFAULT_STATUS,
    committed: null,
    invoicedAmount: null,
    invoicedAt: null,
    payments: [],
    moments: [],
    // The invoice itself still lives in QuickBooks. This is just the number,
    // so the two can be tied together without exporting anything.
    invoiceNumber: "",
    deliverables,
    obligations: {},
    history: [],
    notes: "",
    source: "manual",
    createdAt: new Date().toISOString(),
    createdBy: str(who) || null,
    updatedAt: new Date().toISOString(),
  };
}
