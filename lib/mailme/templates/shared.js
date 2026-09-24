// PUT IN: lib/mailme/templates/shared.js
// lib/mailme/templates/shared.js: helpers every designed MailMe template uses.
//
// TOKEN-EXEMPT: everything under lib/mailme/templates/ is email HTML. A mail
// client cannot read CSS variables from tokens.css, so colors are written as
// hex on the tags, the same exemption lib/crewcore/pto-email.js declares.
//
// ESM. Do NOT convert to module.exports.

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Trimmed, single-spaced text. Everything typed into a form passes through this. */
export function plain(s, max) {
  const out = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return max ? out.slice(0, max) : out;
}

/** Multi-line text (an intro, a reason) with its line breaks kept. */
export function prose(s, max) {
  const out = String(s == null ? "" : s).replace(/\r\n?/g, "\n")
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  return max ? out.slice(0, max) : out;
}

/** Escaped prose with line breaks as <br>. */
export function proseHtml(s) {
  return esc(s).replace(/\n/g, "<br>");
}

/** An https URL, or "" when it is not one. */
export function httpsUrl(raw) {
  let v = plain(raw);
  if (!v) return "";
  if (/^www\./i.test(v)) v = "https://" + v;
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/i.test(v)) return "";
  if (/["'<>\s]/.test(v)) return "";
  return v;
}

/**
 * THE CLICK TAG. Every link a template writes goes through here.
 *
 * The sales director's version sent each click through a tracking server of
 * its own. MailMe does not need one: Resend already wraps every link, and
 * the webhook records each click against the recipient with the link it went
 * to (api/mailme/webhook.js). So the only thing the link has to carry is
 * WHICH product and WHICH spot on the card, and it carries that in
 * utm_content, which is what the field is for. Reports reads it back out
 * (clickSpotFromUrl in lib/mailme/schema.js).
 *
 *   utm_content = "pick-03-photo" | "pick-03-button" | "pick-03-colors"
 *                 "hero" | "closing" | "footer"
 *
 * utm_source / medium / campaign are added only when the link does not
 * already carry its own, so a supplier link with its own tagging keeps it.
 */
export function tagLink(url, { campaignId, content }) {
  if (!url) return "";
  let u;
  try { u = new URL(url); } catch (e) { return url; }
  if (!u.searchParams.has("utm_source")) u.searchParams.set("utm_source", "mailme");
  if (!u.searchParams.has("utm_medium")) u.searchParams.set("utm_medium", "email");
  if (campaignId && !u.searchParams.has("utm_campaign")) u.searchParams.set("utm_campaign", String(campaignId));
  if (content) u.searchParams.set("utm_content", content);
  return u.toString();
}

export function slotLabel(n) {
  return String(n).padStart(2, "0");
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
export function numberWord(n) {
  return WORDS[n] || String(n);
}

/**
 * Where the fixed brand art (logo, texture, pattern) lives: assets/email/ in
 * this repo, served from the same site as the unsubscribe page. Absolute in
 * a real email, because a mail client has no page to resolve a relative
 * path against. Relative in the composer preview, which is on that site.
 */
export function assetUrl(file, base) {
  const b = String(base || "").replace(/\/+$/, "");
  return `${b}/assets/email/${file}`;
}

/** The site an unsubscribe URL lives on, e.g. https://alliteration.pmapparel.com */
export function assetBaseFromSettings(settings) {
  try {
    const u = new URL(String((settings && settings.unsubscribeUrl) || ""));
    return u.origin;
  } catch (e) {
    return "";
  }
}

/** One line of the postal address, or "". CAN-SPAM needs it in every email. */
export function addressLine(settings) {
  const a = (settings && settings.postalAddress) || {};
  return [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(", "), a.postalCode]
    .filter((x) => String(x || "").trim()).join(", ");
}

/** The per-recipient unsubscribe link, or "" when none is configured. */
export function unsubscribeHref(settings, unsubToken) {
  const base = String((settings && settings.unsubscribeUrl) || "").replace(/\/+$/, "");
  if (!base) return "";
  return unsubToken ? `${base}?t=${unsubToken}` : base;
}

/** The hidden preview line inboxes show next to the subject. */
export function preheaderHtml(text) {
  const t = plain(text);
  if (!t) return "";
  // The run of zero-width joiners stops Gmail padding the preview with the
  // first words of the body after a short preheader.
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;font-size:1px;line-height:1px">${esc(t)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`;
}

/** Parse a money amount typed as "$7.01", "7", "1,250.5". NaN when it is not one. */
export function parseMoney(raw) {
  const s = String(raw == null ? "" : raw).replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

/**
 * The promo-products rounding rule: UP to the next whole dollar, shown as .00.
 * $7.01 is $8.00, $7.00 stays $7.00. Never below the source price.
 */
export function ceilDollars(raw) {
  const n = parseMoney(raw);
  if (!Number.isFinite(n)) return null;
  const whole = Math.floor(n);
  const up = n - whole > 1e-9 ? whole + 1 : whole;
  return `$${up.toLocaleString("en-US")}.00`;
}
