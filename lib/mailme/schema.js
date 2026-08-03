// lib/mailme/schema.js — MailMe data model (v1).
//
// FRESH build, not a port — MailMe never existed as a standalone app.
//
// One thing this file deliberately does NOT do: define a separate contact
// store. The contact list is the BackBone roster (see lib/mailme/store.js's
// resolveContacts()). What lives here is only the state BackBone has no
// concept of — subscribe/unsubscribe status, tags/segments, and campaigns —
// keyed by BackBone's customer_id so the two stay joined without a sync step.
//
// ESM (`export`), matching the rest of the repo. Do NOT convert to
// module.exports.

export const KEY_PREFIX = "mailme_data";

// Redis keys — everything MailMe writes lives under its prefix, in the same
// shared Upstash instance BackBone and ErrorEngine already use.
export const keys = {
  // One JSON object: { [customer_id]: ContactOverride }. Overrides are the
  // exception, not the rule — most of the roster has no row here at all and
  // simply defaults to "subscribed" with no tags. At P&M's roster size
  // (~2,500 customers, per the Scorecard) a single key comfortably holds
  // every override that will ever exist; there is no reason to pay a
  // per-contact key's read/write overhead for data this small.
  contactOverrides: () => `${KEY_PREFIX}:contact_overrides`,
  // One JSON array of campaign records. Campaigns are created rarely
  // (weekly/monthly at most), so a single key matches GivingGauge's
  // single-key request list rather than ErrorEngine's per-record + index
  // pattern, which exists there to support thousands of records.
  campaigns: () => `${KEY_PREFIX}:campaigns`,
  // Incrementing id source for campaign ids (MM-00001, ...).
  campaignCounter: () => `${KEY_PREFIX}:campaign_counter`,
  // Tracking events (open/click/bounce/complaint). Provider-agnostic shape;
  // the provider-specific webhook receiver that WRITES here does not exist
  // yet (see api/mailme/webhook.js). Kept as one JSON array for v1; if real
  // sending volume makes this key large, it should move to a time-bucketed
  // key (e.g. one key per campaign) before that becomes a problem, not after.
  events: () => `${KEY_PREFIX}:events`,
};

// ---- Enumerations (single source of truth) ---------------------------------

// A contact's subscribe state. "subscribed" is the IMPLICIT default for any
// BackBone customer with a resolvable email and no override row — it is
// deliberately not writable back as an explicit "subscribed" override,
// so re-subscribing just means deleting the override rather than flipping it.
export const SUBSCRIPTION_STATUSES = ["subscribed", "unsubscribed", "bounced", "complained"];

// Statuses that must NEVER receive a send, regardless of what a campaign's
// segment filter would otherwise include. This list is the suppression
// check's single source of truth — a sending path that doesn't consult it
// is a compliance bug, not a style choice.
export const SUPPRESSED_STATUSES = ["unsubscribed", "bounced", "complained"];

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "sent", "archived"];

// Event types the (future) webhook receiver normalizes provider payloads
// into. "click" carries linkUrl; the rest don't need it.
export const EVENT_TYPES = ["open", "click", "bounce", "complaint", "unsubscribe"];

// ---- Field definitions -------------------------------------------------
// Modeled on ErrorEngine's FIELDS table: type, required, source, def. Kept
// even though there's no form-validator yet (see store.js note on
// validateCampaign) so the eventual real send-composer and this file agree
// on field names from day one.

export const CONTACT_OVERRIDE_FIELDS = {
  status:     { type: "enum",   required: false, enum: SUBSCRIPTION_STATUSES, source: "user/webhook", def: "Subscribe state override. Absent = subscribed." },
  reason:     { type: "string", required: false, source: "user",              def: "Why: unsubscribe reason (compliance) or bounce/complaint detail." },
  tags:       { type: "array",  required: false, source: "user",              def: "Freeform segment tags, e.g. 'vip', 'apparel-only', 'no-response-2026'." },
  updatedAt:  { type: "date",   required: true,  source: "generated",         def: "When this override last changed." },
  updatedBy:  { type: "string", required: false, source: "session",           def: "Username who last changed it. Absent for webhook-driven changes (bounce/complaint)." },
};

export const CAMPAIGN_FIELDS = {
  id:          { type: "string", required: true,  source: "generated", def: "MM-##### campaign id." },
  subject:     { type: "string", required: true,  source: "user",      def: "Email subject line." },
  preheader:   { type: "string", required: false, source: "user",      def: "Preview text shown next to the subject in most inboxes." },
  body:        { type: "string", required: true,  source: "user",      def: "Plain-text body. Supports {{first_name}} / {{company_name}} merge tags." },
  segmentTags: { type: "array",  required: false, source: "user",      def: "Tag filter: recipients are contacts carrying ANY of these tags. Empty = everyone subscribed." },
  status:      { type: "enum",   required: true,  enum: CAMPAIGN_STATUSES, source: "computed", def: "Lifecycle state. Stays 'draft' in v1 — sending is not wired." },
  createdAt:   { type: "date",   required: true,  source: "generated", def: "When the draft was created." },
  createdBy:   { type: "string", required: false, source: "session",   def: "Username who created it." },
  updatedAt:   { type: "date",   required: true,  source: "generated", def: "When last edited." },
  sentAt:      { type: "date",   required: false, source: "computed",  def: "When the send completed. Null until real sending exists." },
  stats:       { type: "object", required: false, source: "computed",  def: "{ recipients, delivered, opens, clicks, bounces, complaints }. Zeroed until real sending exists." },
};

function emptyStats() {
  return { recipients: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0 };
}

/** A fresh campaign draft with every computed field correctly zeroed. */
export function newCampaignDraft(partial, session) {
  const now = new Date().toISOString();
  return {
    subject: "",
    preheader: "",
    body: "",
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

/**
 * Validate a campaign create/edit body. Deliberately narrow for v1 — only
 * the two fields a draft actually needs to be useful (subject, body) are
 * required; everything else has a safe default. Returns { ok, errors, patch }
 * where patch holds only the fields recognized here, so an unrelated stray
 * field on the request body can never leak into a stored record.
 */
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
  if (b.segmentTags !== undefined) {
    if (!Array.isArray(b.segmentTags)) errors.push("segmentTags must be an array");
    else patch.segmentTags = b.segmentTags.map((t) => String(t).trim()).filter(Boolean);
  }

  return { ok: errors.length === 0, errors, patch };
}

/**
 * Who a campaign would go to.
 *
 * THE suppression check. Lives here, in the dependency-free module, so it can
 * be tested directly rather than only inspected as text — this is the one
 * function in MailMe where a bug means emailing someone who asked not to be
 * emailed, which is both a trust problem and a CAN-SPAM problem.
 *
 * ORDER IS THE GUARANTEE: suppressed contacts are removed FIRST, before the
 * tag filter is considered at all. No segment expression can add them back,
 * because they are gone before segments are evaluated.
 *
 * Empty/absent segmentTags means "everyone still mailable", never "everyone".
 */
export function selectRecipients(contacts, segmentTags) {
  const list = Array.isArray(contacts) ? contacts : [];
  const mailable = list.filter((c) => c && !SUPPRESSED_STATUSES.includes(c.status));
  if (!segmentTags || !segmentTags.length) return mailable;
  const want = new Set(segmentTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  if (!want.size) return mailable;
  return mailable.filter((c) => Array.isArray(c.tags) &&
    c.tags.some((t) => want.has(String(t).trim().toLowerCase())));
}

export function toBoolLike(v) {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off", ""].includes(s)) return false;
  return undefined;
}
