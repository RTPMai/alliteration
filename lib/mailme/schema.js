// lib/mailme/schema.js — MailMe data model (v2).
//
// FRESH build, not a port — MailMe never existed as a standalone app.
//
// v2 adds three things to the original roster-only design:
//   1. TWO CONTACT SOURCES. "client" contacts are the BackBone roster,
//      resolved live and never stored here. "prospect" contacts are imported
//      cold-outreach records that MailMe DOES own, because nothing else in
//      the shell knows about them.
//   2. LISTS. Saved segments, either static (an explicit set of contacts) or
//      dynamic (a rule evaluated fresh each time, so a list like "dormant
//      clients tagged retail" stays current without re-saving).
//   3. CAMPAIGN RESULTS. Opens, clicks, bounces, complaints and unsubscribes,
//      aggregated per campaign and per link.
//
// Everything in this file is PURE — no network, no storage, no session. That
// is deliberate: the matching, sorting, dedupe and aggregation rules are the
// parts where a bug quietly emails the wrong people or reports the wrong
// numbers, so they must be directly testable. Storage lives in store.js.
//
// ESM (`export`). Do NOT convert to module.exports.

export const KEY_PREFIX = "mailme_data";

export const keys = {
  // Overrides on ROSTER contacts: { [customer_id]: ContactOverride }.
  // Most of the roster has no row here and defaults to subscribed.
  contactOverrides: () => `${KEY_PREFIX}:contact_overrides`,
  // Imported PROSPECT contacts: { [prospect_id]: ProspectContact }. Unlike
  // roster contacts these are stored in full, because no other app has them.
  prospects: () => `${KEY_PREFIX}:prospects`,
  prospectCounter: () => `${KEY_PREFIX}:prospect_counter`,
  // Saved lists (segments).
  lists: () => `${KEY_PREFIX}:lists`,
  listCounter: () => `${KEY_PREFIX}:list_counter`,
  campaigns: () => `${KEY_PREFIX}:campaigns`,
  campaignCounter: () => `${KEY_PREFIX}:campaign_counter`,
  // Tracking events, bucketed PER CAMPAIGN. The original single-key design
  // would have grown without bound once sending is real: one send to 2,500
  // contacts can produce 5,000+ open/click rows on its own. Per-campaign keys
  // keep any single read proportional to one campaign.
  campaignEvents: (campaignId) => `${KEY_PREFIX}:events:${campaignId}`,
  // Suppression by raw email address, independent of contact identity. A
  // person who unsubscribes must stay unsubscribed even if they are later
  // re-imported as a "new" prospect under a different id. THIS IS THE
  // COMPLIANCE BACKSTOP: contact records come and go, this does not.
  suppressionList: () => `${KEY_PREFIX}:suppression`,
  // App settings: sending identity, postal address, caps, thresholds. All
  // configurable rather than hardcoded.
  settings: () => `${KEY_PREFIX}:settings`,
  // Per-contact send history, for the frequency cap: { [contactId]: iso }.
  lastEmailed: () => `${KEY_PREFIX}:last_emailed`,
  // Address verification results: { [email]: { status, at } }.
  verification: () => `${KEY_PREFIX}:verification`,
};

// ---- Enumerations -----------------------------------------------------

// Where a contact came from. Drives which sending identity is used, which is
// why it is not merely a tag: cold outreach must not go out over the same
// domain as client mail (see SENDING_IDENTITIES below).
export const CONTACT_SOURCES = ["client", "prospect", "lead", "giving"];

// Where each source's records actually come from. "client" and "lead" and
// "giving" are all READ-ONLY joins onto data another app already owns, so
// MailMe never has to import them and they can never drift. Only "prospect"
// is MailMe's own.
export const SOURCE_ORIGINS = {
  client:   { label: "Client",   origin: "backbone_data",       owned: false, cold: false },
  lead:     { label: "Lead",     origin: "backbone_leads",      owned: false, cold: false },
  giving:   { label: "Giving",   origin: "giving requests",     owned: false, cold: false },
  prospect: { label: "Prospect", origin: "imported",            owned: true,  cold: true },
};

// Which sources are COLD for sending-domain purposes. Leads and giving
// contacts asked to hear from P&M or were already in conversation, so they
// are warm; only imported prospects are genuinely cold.
export const COLD_SOURCES = ["prospect"];

export const SUBSCRIPTION_STATUSES = ["subscribed", "unsubscribed", "bounced", "complained"];

// Statuses that must NEVER receive a send. The suppression check's single
// source of truth — a sending path that does not consult it is a compliance
// bug, not a style choice.
export const SUPPRESSED_STATUSES = ["unsubscribed", "bounced", "complained"];

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "sent", "archived"];

// "reply" is included because for cold outreach it is the ONLY outcome that
// matters. Providers do not report it on the tracking webhook; it arrives via
// inbound parsing or is logged by hand, but the vocabulary carries it so
// reporting does not have to be rebuilt when that lands.
export const EVENT_TYPES = ["delivered", "open", "click", "bounce", "complaint", "unsubscribe", "reply"];

// Result of an address-verification pass. Bought and scraped lists commonly
// run 10-20% undeliverable, and providers throttle a sender at 2% bounce, so
// verifying before a cold send is the difference between a working programme
// and a burned domain.
export const VERIFICATION_STATUSES = ["unverified", "valid", "risky", "invalid"];

export const LIST_KINDS = ["static", "dynamic"];

/**
 * SENDING IDENTITIES — the reason `source` exists as a first-class field.
 *
 * Cold outreach bounces and draws spam complaints at rates a customer list
 * never does, and mailbox providers score reputation per DOMAIN. Sending cold
 * mail from pmapparel.com puts quotes, invoices and order confirmations at
 * risk of landing in customers' spam folders. The two streams therefore use
 * different sending domains, and that separation is structural here rather
 * than a rule someone has to remember.
 *
 * The domains are placeholders until the provider is chosen and DNS is set up.
 * Nothing sends yet, so nothing depends on these values being final.
 */
export const SENDING_IDENTITIES = {
  warm: { key: "warm", label: "Client mail",   domain: "mail.pmapparel.com",     note: "Customers, leads and giving contacts. Shares the primary brand domain's good standing." },
  cold: { key: "cold", label: "Cold outreach", domain: "outreach.pmapparel.com", note: "Imported prospects. Isolated so complaints cannot harm client deliverability." },
};

export function identityForSource(source) {
  return COLD_SOURCES.includes(source) ? SENDING_IDENTITIES.cold : SENDING_IDENTITIES.warm;
}

/**
 * A campaign draws from ONE source. Mixing clients and cold prospects in a
 * single send is refused, because a single send has a single sending domain
 * and one of the two would be sent over the wrong one.
 */
export function campaignSourceConflict(recipients) {
  // Compares the sending IDENTITY, not the raw source. Clients, leads and
  // giving contacts all send from the warm domain, so mixing those is fine.
  // Mixing any of them with cold prospects is not: one group would go out
  // over the wrong domain.
  const identities = new Set((recipients || []).map((r) => identityForSource(r.source).key));
  if (identities.size > 1) {
    return "A campaign cannot mix cold prospects with clients, leads or giving contacts: they send from different domains. Split it into two campaigns.";
  }
  return null;
}

// ---- Email normalization ----------------------------------------------

// Deliberately permissive: this rejects obvious junk (no @, no dot in the
// domain, spaces) without trying to be an RFC validator. Over-strict regexes
// reject real addresses, and the only authoritative test of an address is
// whether it bounces.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function isValidEmail(v) {
  return EMAIL_RE.test(String(v == null ? "" : v).trim());
}

/**
 * The dedupe key for an address. Lowercased and trimmed only.
 *
 * NOTE what this deliberately does NOT do: strip Gmail-style dots or +tags.
 * Those normalizations are correct for Gmail and wrong for most other hosts,
 * and treating alex+shop@acme.com as the same person as alex@acme.com would
 * merge two contacts who may be different mailboxes at a company domain.
 * Over-merging silently loses a contact; under-merging shows a visible
 * duplicate someone can fix. Prefer the visible failure.
 */
export function normalizeEmail(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}

export function emailDomain(v) {
  const e = normalizeEmail(v);
  const at = e.lastIndexOf("@");
  return at === -1 ? "" : e.slice(at + 1);
}

// ---- Field definitions -------------------------------------------------

export const PROSPECT_FIELDS = {
  prospect_id:  { type: "string", required: true,  source: "generated", def: "PR-##### id, MailMe's own." },
  email:        { type: "string", required: true,  source: "import",    def: "Email address. Normalized lowercase; the dedupe key." },
  company_name: { type: "string", required: false, source: "import",    def: "Organization name." },
  contact_name: { type: "string", required: false, source: "import",    def: "Person's name." },
  title:        { type: "string", required: false, source: "import",    def: "Job title. Useful for segmenting by buying role." },
  phone:        { type: "string", required: false, source: "import",    def: "Phone, carried for the AM's follow-up, never mailed." },
  city:         { type: "string", required: false, source: "import",    def: "City." },
  state:        { type: "string", required: false, source: "import",    def: "State." },
  tags:         { type: "array",  required: false, source: "user",      def: "Segment tags." },
  status:       { type: "enum",   required: false, enum: SUBSCRIPTION_STATUSES, source: "user/webhook", def: "Subscribe state. Absent = subscribed." },
  reason:       { type: "string", required: false, source: "user/webhook", def: "Unsubscribe reason or bounce detail." },
  importedAt:   { type: "date",   required: true,  source: "generated", def: "When imported." },
  importedBy:   { type: "string", required: false, source: "session",   def: "Who imported it." },
  importBatch:  { type: "string", required: false, source: "generated", def: "Batch id, so one bad import can be undone as a unit." },
};

export const LIST_FIELDS = {
  id:        { type: "string", required: true,  source: "generated", def: "LS-##### list id." },
  name:      { type: "string", required: true,  source: "user",      def: "What the list is called." },
  kind:      { type: "enum",   required: true,  enum: LIST_KINDS, source: "user", def: "static = a fixed set of contacts; dynamic = a rule evaluated fresh." },
  members:   { type: "array",  required: false, source: "user",      def: "Static lists only: contact ids." },
  rule:      { type: "object", required: false, source: "user",      def: "Dynamic lists only. { source, statuses, tags, tagMatch, search }." },
  createdAt: { type: "date",   required: true,  source: "generated", def: "When created." },
  createdBy: { type: "string", required: false, source: "session",   def: "Who created it." },
  updatedAt: { type: "date",   required: true,  source: "generated", def: "When last edited." },
};

export const CAMPAIGN_FIELDS = {
  id:          { type: "string", required: true,  source: "generated", def: "MM-##### campaign id." },
  subject:     { type: "string", required: true,  source: "user",      def: "Email subject line." },
  preheader:   { type: "string", required: false, source: "user",      def: "Preview text next to the subject." },
  body:        { type: "string", required: true,  source: "user",      def: "Body. Supports {{first_name}} / {{company_name}} merge tags." },
  source:      { type: "enum",   required: true,  enum: CONTACT_SOURCES, source: "user", def: "Which audience, and therefore which sending domain." },
  listId:      { type: "string", required: false, source: "user",      def: "Saved list to send to. Takes precedence over segmentTags." },
  segmentTags: { type: "array",  required: false, source: "user",      def: "Ad-hoc tag filter when no list is chosen." },
  status:      { type: "enum",   required: true,  enum: CAMPAIGN_STATUSES, source: "computed", def: "Lifecycle state. Stays 'draft' until sending is wired." },
  createdAt:   { type: "date",   required: true,  source: "generated", def: "When created." },
  createdBy:   { type: "string", required: false, source: "session",   def: "Who created it." },
  updatedAt:   { type: "date",   required: true,  source: "generated", def: "When last edited." },
  sentAt:      { type: "date",   required: false, source: "computed",  def: "When the send completed. Null until sending exists." },
  stats:       { type: "object", required: false, source: "computed",  def: "Aggregated from events. Never written by a client." },
};

export function emptyStats() {
  return {
    recipients: 0, delivered: 0,
    opens: 0, uniqueOpens: 0,
    clicks: 0, uniqueClicks: 0,
    bounces: 0, complaints: 0, unsubscribes: 0,
    replies: 0,
  };
}

export function newCampaignDraft(partial, session) {
  const now = new Date().toISOString();
  return {
    subject: "",
    preheader: "",
    body: "",
    source: "client",
    listId: null,
    segmentTags: [],
    ...partial,
    status: "draft",
    createdAt: now,
    createdBy: (session && session.username) || undefined,
    updatedAt: now,
    sentAt: null,
    stats: emptyStats(),
  };
}

// ---- Recipient selection ----------------------------------------------

/**
 * Who a campaign would go to.
 *
 * THE suppression check. Lives in this dependency-free module so it can be
 * tested directly — this is the one function where a bug means emailing
 * someone who asked not to be emailed.
 *
 * ORDER IS THE GUARANTEE: suppressed contacts are removed FIRST, before source
 * or tag filtering is considered at all. No segment expression can add them
 * back, because they are gone before segments are evaluated.
 */
export function selectRecipients(contacts, opts) {
  const o = opts || {};
  const list = Array.isArray(contacts) ? contacts : [];

  // 1. Suppression, always first.
  let out = list.filter((c) => c && !SUPPRESSED_STATUSES.includes(c.status));

  // 2. Source. A campaign targets one audience; see campaignSourceConflict.
  if (o.source) out = out.filter((c) => c.source === o.source);

  // 3. Tags.
  const tags = (o.segmentTags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  if (tags.length) {
    const want = new Set(tags);
    const all = o.tagMatch === "all";
    out = out.filter((c) => {
      const has = Array.isArray(c.tags) ? c.tags.map((t) => String(t).trim().toLowerCase()) : [];
      return all ? tags.every((t) => has.includes(t)) : has.some((t) => want.has(t));
    });
  }

  return out;
}

// ---- Lists -------------------------------------------------------------

/**
 * Does a contact belong to a dynamic list's rule?
 *
 * Note that this does NOT apply suppression: a list is a description of an
 * audience, and it is legitimate to have a list whose point is "everyone who
 * unsubscribed". Suppression is applied at SEND time by selectRecipients, not
 * at list-membership time. Keeping the two separate is what lets the Contacts
 * view show a list's true membership while a send from that same list still
 * cannot reach a suppressed address.
 */
export function matchesRule(contact, rule) {
  if (!contact) return false;
  const r = rule || {};

  if (r.source && contact.source !== r.source) return false;

  if (Array.isArray(r.statuses) && r.statuses.length) {
    if (!r.statuses.includes(contact.status || "subscribed")) return false;
  }

  const want = (r.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  if (want.length) {
    const has = Array.isArray(contact.tags)
      ? contact.tags.map((t) => String(t).trim().toLowerCase()) : [];
    const ok = r.tagMatch === "all"
      ? want.every((t) => has.includes(t))
      : want.some((t) => has.includes(t));
    if (!ok) return false;
  }

  if (Array.isArray(r.reorderStates) && r.reorderStates.length) {
    const st = (contact.reorder && contact.reorder.state) || "unknown";
    if (!r.reorderStates.includes(st)) return false;
  }

  if (r.accountManager) {
    const want = String(r.accountManager).trim().toLowerCase();
    if (String(contact.accountManager || "").trim().toLowerCase() !== want) return false;
  }

  if (Array.isArray(r.verification) && r.verification.length) {
    if (!r.verification.includes(contact.verification || "unverified")) return false;
  }

  if (r.search) {
    const q = String(r.search).trim().toLowerCase();
    const hay = [contact.company_name, contact.contact_name, contact.email, contact.title]
      .filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }

  return true;
}

/** Resolve a list to its contacts, whichever kind it is. */
export function resolveList(list, contacts) {
  const all = Array.isArray(contacts) ? contacts : [];
  if (!list) return [];
  if (list.kind === "static") {
    const ids = new Set((list.members || []).map(String));
    return all.filter((c) => ids.has(String(c.id)));
  }
  return all.filter((c) => matchesRule(c, list.rule));
}

// ---- Sorting -----------------------------------------------------------

export const SORT_KEYS = ["company_name", "contact_name", "email", "status", "source", "tags", "updatedAt"];

/**
 * Sort contacts by a column. Stable, null-safe, and case-insensitive on text.
 *
 * Blank values always sort LAST regardless of direction. Reversing the sort on
 * a sparse column (title, city) otherwise fills the top of the screen with
 * empty rows, which looks like broken data.
 */
export function sortContacts(contacts, key, dir) {
  const list = Array.isArray(contacts) ? contacts.slice() : [];
  const sortKey = SORT_KEYS.includes(key) ? key : "company_name";
  const sign = dir === "desc" ? -1 : 1;

  const val = (c) => {
    if (sortKey === "tags") return (c.tags || []).join(", ");
    return c[sortKey];
  };

  return list.sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    const ae = av == null || av === "";
    const be = bv == null || bv === "";
    if (ae && be) return 0;
    if (ae) return 1;   // blanks last, both directions
    if (be) return -1;

    if (sortKey === "updatedAt") {
      return (new Date(av) - new Date(bv)) * sign;
    }
    return String(av).localeCompare(String(bv), undefined, { sensitivity: "base" }) * sign;
  });
}

// ---- Campaign results --------------------------------------------------

/**
 * Aggregate raw events into campaign stats.
 *
 * UNIQUE vs TOTAL matters and is the thing most easily got wrong. One person
 * opening an email four times is 4 opens but 1 unique open. Open RATE must be
 * computed from unique opens over delivered, or a single enthusiastic reader
 * makes a campaign look twice as successful as it was.
 *
 * Events are counted per contact id; an event with no contact still counts
 * toward the total but cannot count toward a unique.
 */
export function aggregateEvents(events, recipientCount) {
  const list = Array.isArray(events) ? events : [];
  const stats = emptyStats();
  stats.recipients = recipientCount || 0;

  const openers = new Set();
  const clickers = new Set();
  const byLink = new Map();

  for (const e of list) {
    if (!e || !e.type) continue;
    const who = e.contactId ? String(e.contactId) : null;

    switch (e.type) {
      case "delivered":  stats.delivered++; break;
      case "open":
        stats.opens++;
        if (who) openers.add(who);
        break;
      case "click": {
        stats.clicks++;
        if (who) clickers.add(who);
        const url = e.linkUrl || "(unknown link)";
        if (!byLink.has(url)) byLink.set(url, { url, clicks: 0, unique: new Set() });
        const row = byLink.get(url);
        row.clicks++;
        if (who) row.unique.add(who);
        break;
      }
      case "reply":       stats.replies++; break;
      case "bounce":      stats.bounces++; break;
      case "complaint":   stats.complaints++; break;
      case "unsubscribe": stats.unsubscribes++; break;
      default: break;
    }
  }

  stats.uniqueOpens = openers.size;
  stats.uniqueClicks = clickers.size;

  const links = [...byLink.values()]
    .map((r) => ({ url: r.url, clicks: r.clicks, uniqueClicks: r.unique.size }))
    .sort((a, b) => b.clicks - a.clicks);

  return { stats, links };
}

/** Rates as percentages, guarded against divide-by-zero. */
export function computeRates(stats) {
  const s = stats || emptyStats();
  const base = s.delivered || 0;
  const pct = (n) => (base ? Math.round((n / base) * 1000) / 10 : 0);
  return {
    deliveredRate: s.recipients ? Math.round((s.delivered / s.recipients) * 1000) / 10 : 0,
    openRate: pct(s.uniqueOpens),
    clickRate: pct(s.uniqueClicks),
    // Click-to-open: of the people who opened, how many clicked. The number
    // that actually says whether the CONTENT worked, as opposed to the
    // subject line.
    clickToOpenRate: s.uniqueOpens ? Math.round((s.uniqueClicks / s.uniqueOpens) * 1000) / 10 : 0,
    bounceRate: s.recipients ? Math.round((s.bounces / s.recipients) * 1000) / 10 : 0,
    complaintRate: s.recipients ? Math.round((s.complaints / s.recipients) * 1000) / 10 : 0,
  };
}

/**
 * Deliverability alarms. Mailbox providers start filtering a sender well
 * before a human would notice anything is wrong, and cold outreach is where
 * this bites first. Thresholds are the widely used industry limits: 2% hard
 * bounce and 0.1% complaint are where providers begin to act.
 */
export function deliverabilityWarnings(stats) {
  const r = computeRates(stats);
  const out = [];
  if (r.bounceRate >= 2) {
    out.push({
      level: "danger",
      text: `Bounce rate ${r.bounceRate}% is at or above the 2% threshold where mailbox providers start throttling. Stop sending to this list and clean it.`,
    });
  }
  if (r.complaintRate >= 0.1) {
    out.push({
      level: "danger",
      text: `Complaint rate ${r.complaintRate}% is at or above 0.1%, the level where providers begin filtering a sender. Review who is being mailed and why.`,
    });
  }
  return out;
}

// ---- Validation --------------------------------------------------------

export function validateCampaignPatch(body) {
  const errors = [];
  const patch = {};
  const b = body || {};

  if (b.subject !== undefined) {
    const s = String(b.subject).trim();
    if (!s) errors.push("subject cannot be empty");
    else patch.subject = s;
  }
  if (b.preheader !== undefined) patch.preheader = String(b.preheader).trim();
  if (b.body !== undefined) {
    const s = String(b.body);
    if (!s.trim()) errors.push("body cannot be empty");
    else patch.body = s;
  }
  if (b.source !== undefined) {
    const s = String(b.source);
    if (!CONTACT_SOURCES.includes(s)) errors.push(`source must be one of: ${CONTACT_SOURCES.join(", ")}`);
    else patch.source = s;
  }
  if (b.listId !== undefined) patch.listId = b.listId ? String(b.listId) : null;
  if (b.segmentTags !== undefined) {
    if (!Array.isArray(b.segmentTags)) errors.push("segmentTags must be an array");
    else patch.segmentTags = b.segmentTags.map((t) => String(t).trim()).filter(Boolean);
  }

  return { ok: errors.length === 0, errors, patch };
}

// Prospect detail fields a person can hand-edit after import or signup —
// e.g. fixing a wrong company name from a CSV or a signup page that only
// ever collected name + email. Deliberately excludes prospect_id, email
// (the dedupe/suppression key — changing it is really "create a different
// prospect", not an edit), tags, status and reason (those have their own
// dedicated paths with their own compliance rules) and the import bookkeeping
// fields.
export const PROSPECT_EDITABLE_FIELDS = [
  "company_name", "contact_name", "title", "phone", "city", "state",
];

const MAX_FIELD_LEN = 200;

/**
 * Validate a hand-edit to a prospect's details. Every field is optional (a
 * PATCH only sends what changed); anything present is trimmed and capped so
 * a stray paste can't blow past a reasonable field length.
 */
export function validateProspectPatch(body) {
  const errors = [];
  const patch = {};
  const b = body || {};

  for (const field of PROSPECT_EDITABLE_FIELDS) {
    if (b[field] === undefined) continue;
    const v = String(b[field] == null ? "" : b[field]).trim();
    if (v.length > MAX_FIELD_LEN) {
      errors.push(`${field} is too long (max ${MAX_FIELD_LEN} characters)`);
      continue;
    }
    patch[field] = v;
  }

  return { ok: errors.length === 0, errors, patch };
}

export function validateListPatch(body) {
  const errors = [];
  const patch = {};
  const b = body || {};

  if (b.name !== undefined) {
    const s = String(b.name).trim();
    if (!s) errors.push("name cannot be empty");
    else patch.name = s;
  }
  if (b.kind !== undefined) {
    const s = String(b.kind);
    if (!LIST_KINDS.includes(s)) errors.push(`kind must be one of: ${LIST_KINDS.join(", ")}`);
    else patch.kind = s;
  }
  if (b.members !== undefined) {
    if (!Array.isArray(b.members)) errors.push("members must be an array");
    else patch.members = [...new Set(b.members.map(String))];
  }
  if (b.rule !== undefined) {
    if (b.rule && typeof b.rule !== "object") errors.push("rule must be an object");
    else {
      const r = b.rule || {};
      patch.rule = {
        source: r.source && CONTACT_SOURCES.includes(String(r.source)) ? String(r.source) : null,
        // Reorder timing, computed per customer against their own cadence.
        reorderStates: Array.isArray(r.reorderStates)
          ? r.reorderStates.filter((x) => ["not-due", "due", "overdue", "lapsed", "unknown"].includes(String(x))).map(String)
          : [],
        accountManager: r.accountManager ? String(r.accountManager).trim() : "",
        verification: Array.isArray(r.verification)
          ? r.verification.filter((x) => VERIFICATION_STATUSES.includes(String(x))).map(String)
          : [],
        statuses: Array.isArray(r.statuses)
          ? r.statuses.filter((s) => SUBSCRIPTION_STATUSES.includes(String(s))).map(String) : [],
        tags: Array.isArray(r.tags) ? r.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [],
        tagMatch: r.tagMatch === "all" ? "all" : "any",
        search: r.search ? String(r.search).trim() : "",
      };
    }
  }

  return { ok: errors.length === 0, errors, patch };
}

/**
 * Settings defaults. Everything a person might reasonably want to change is
 * here rather than hardcoded, per the shop's standing preference.
 *
 * postalAddress is deliberately BLANK: it is a fact about the business that
 * cannot be guessed, and complianceBlockers() refuses to let a send happen
 * until it is filled in.
 */
export function defaultSettings() {
  return {
    companyName: "P&M Apparel",
    fromName: "",
    replyToMode: "account-manager",   // "account-manager" | "fixed"
    replyToFixed: "",
    postalAddress: { line1: "", line2: "", city: "", state: "", postalCode: "" },
    unsubscribeUrl: "",
    policy: {
      minDaysBetweenEmails: 14,
      coldDailyCapStart: 20,
      coldDailyCapMax: 200,
      coldRampDays: 30,
      clientDailyCap: 1000,
      skipOpenQuotes: true,
      skipInvalidVerification: true,
    },
    reorder: {
      dueAt: 1.0, overdueAt: 1.5, lapsedAt: 3.0, minOrders: 3, minGapDays: 7,
    },
    coldStartedAt: null,   // set the first time a cold send happens; drives the ramp
  };
}

export function mergeSettings(stored) {
  const d = defaultSettings();
  const s = stored && typeof stored === "object" ? stored : {};
  return {
    ...d, ...s,
    postalAddress: { ...d.postalAddress, ...(s.postalAddress || {}) },
    policy: { ...d.policy, ...(s.policy || {}) },
    reorder: { ...d.reorder, ...(s.reorder || {}) },
  };
}

/**
 * Unsubscribe tokens.
 *
 * The token must be UNGUESSABLE and must not expose the email address. A raw
 * address in the URL means anyone can unsubscribe anyone by editing it, and
 * a sequential id is only marginally better. This is an HMAC of the contact
 * id under SESSION_SECRET, so a token is verifiable without storing a lookup
 * table and cannot be forged without the secret.
 *
 * Deliberately NOT expiring: CAN-SPAM requires an opt-out to keep working for
 * at least 30 days after sending, and an expired link in an old email is
 * exactly the failure that draws complaints. A permanent token is the safer
 * side to err on, since the only thing it can do is stop mail.
 */
export function unsubscribeToken(contactId, secret) {
  return { contactId: String(contactId), secret: String(secret || "") };
}

export function toBoolLike(v) {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off", ""].includes(s)) return false;
  return undefined;
}
