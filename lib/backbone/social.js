// PUT IN: lib/backbone/social.js
// lib/backbone/social.js: a client's web and social links.
//
// Sep 30 2026. Ryan asked for social links on client records: Facebook,
// Instagram and TikTok, alongside the Website and LinkedIn fields that were
// already there.
//
// People type these every which way: a full address, an address with no
// https://, or just a handle like "@pmapparel". This turns any of those into
// a real link the screen can open, one way, so the record page and the tests
// agree.
//
// It also refuses anything that is not a web address. A client record is
// typed by hand and then drawn as a link, so "javascript:..." typed into the
// Facebook box must never become something clickable.

export const SOCIAL_FIELDS = [
  { key: "website_url",           label: "Website",   host: null },
  { key: "linkedin_company_page", label: "LinkedIn",  host: "linkedin.com",  handleBase: "https://www.linkedin.com/company/" },
  { key: "facebook_url",          label: "Facebook",  host: "facebook.com",  handleBase: "https://www.facebook.com/" },
  { key: "instagram_url",         label: "Instagram", host: "instagram.com", handleBase: "https://www.instagram.com/" },
  { key: "tiktok_url",            label: "TikTok",    host: "tiktok.com",    handleBase: "https://www.tiktok.com/@" },
];

// Placeholder values the old enrichment scraper and people both leave behind.
const EMPTY_WORDS = /^(not found|n\/a|na|none|null|-+|\?)$/i;

// A bare handle: letters, numbers, dots, underscores, dashes. No spaces,
// no slashes, no scheme.
const HANDLE = /^@?[A-Za-z0-9._-]{1,100}$/;

function fieldFor(key) {
  return SOCIAL_FIELDS.find((f) => f.key === key) || null;
}

/**
 * Turn whatever was typed into a safe https link, or null.
 *
 *   socialUrl("instagram_url", "@pmapparel")  -> "https://www.instagram.com/pmapparel"
 *   socialUrl("facebook_url", "facebook.com/pmapparel") -> "https://facebook.com/pmapparel"
 *   socialUrl("tiktok_url", "pmapparel") -> "https://www.tiktok.com/@pmapparel"
 *   socialUrl("facebook_url", "javascript:alert(1)") -> null
 */
export function socialUrl(key, raw) {
  const f = fieldFor(key);
  if (!f) return null;
  let v = String(raw == null ? "" : raw).trim();
  if (!v || EMPTY_WORDS.test(v)) return null;

  // A handle on a platform field: "@pm.apparel", "pmapparel", or a dotted
  // name that is not the platform's own address ("pm.apparel" is an
  // Instagram handle, "instagram.com/pm" is a link). A website has no
  // handle form.
  if (f.handleBase && HANDLE.test(v) &&
      (v.startsWith("@") || v.toLowerCase().indexOf(f.host) === -1)) {
    return f.handleBase + v.replace(/^@/, "");
  }

  // Anything with a scheme must be http or https. Everything else with a
  // colon before the first slash (javascript:, data:, mailto:) is refused.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s !== "http" && s !== "https") return null;
  } else {
    if (v.startsWith("//")) v = v.slice(2);
    v = "https://" + v;
  }

  let u;
  try { u = new URL(v); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || u.hostname.indexOf(".") === -1) return null;
  if (/[\s"'<>]/.test(u.href)) return null;
  // The Facebook box has to point at Facebook. Anything else would show a
  // stranger's site under the Facebook label.
  if (f.host) {
    const h = u.hostname.toLowerCase();
    if (h !== f.host && !h.endsWith("." + f.host)) return null;
  }
  return u.href;
}

/** What to show on the button: the handle or the address without its scheme. */
export function socialLabel(key, url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    const f = fieldFor(key);
    if (f && f.host && path && path !== "/") {
      const last = path.split("/").filter(Boolean).pop() || "";
      return last.startsWith("@") ? last : "@" + last;
    }
    return (u.hostname.replace(/^www\./, "") + path);
  } catch (e) {
    return "";
  }
}

/**
 * Every link a client has, in display order, skipping the empty ones.
 * `enr` is the client's BackBone enrichment record.
 */
export function clientLinks(enr) {
  const out = [];
  SOCIAL_FIELDS.forEach((f) => {
    const url = socialUrl(f.key, enr && enr[f.key]);
    if (url) out.push({ key: f.key, label: f.label, url, text: socialLabel(f.key, url) });
  });
  return out;
}
