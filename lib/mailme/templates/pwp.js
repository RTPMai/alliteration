// PUT IN: lib/mailme/templates/pwp.js
// lib/mailme/templates/pwp.js: "picks with personality."
//
// The sales director's seasonal sales-team email (Aug 2026): a team member's
// five favorite styles from S&S Activewear or SanMar, sent four times a year
// (spring and fall, one per vendor). Her builder produced the HTML by hand
// and sent clicks through a tracking server of its own. Here the SAME design
// is rendered by MailMe from a form, and clicks are tagged for MailMe's own
// reporting instead (see tagLink in shared.js).
//
// The markup below is hers, kept as close to line-for-line as the data allows,
// because the design is approved and locked. What changed and why:
//   - Click tracking: utm_content on the real link, not a redirect server.
//   - No open pixel: Resend already records opens.
//   - The footer's address and unsubscribe link are filled from MailMe
//     Settings and the recipient's own unsubscribe token.
//
// Her rules, enforced by problems() below:
//   - MSRP exactly as the supplier gives it (only a "$" is added if missing).
//   - Colors are never invented: a pick needs at least one, typed in.
//   - Every link is https.
//
// TOKEN-EXEMPT: email HTML, see shared.js.
//
// ESM. Do NOT convert to module.exports.

import {
  esc, plain, prose, proseHtml, httpsUrl, tagLink, slotLabel, numberWord,
  assetUrl, addressLine, unsubscribeHref, preheaderHtml, parseMoney,
} from "./shared.js";

export const KEY = "pwp";
export const LABEL = "Picks with personality";
export const DESCRIPTION = "A team member's five favorite styles from S&S or SanMar. Spring and fall.";

export const VENDORS = {
  ss: { name: "S&S Activewear", home: "https://www.ssactivewear.com/" },
  sanmar: { name: "SanMar", home: "https://www.sanmar.com/" },
};
export const SEASONS = ["spring", "fall"];
export const MAX_PICKS = 8;
export const DEFAULT_PICKS = 5;
export const MAX_SWATCHES = 10;

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function blankPick() {
  return { name: "", style: "", msrp: "", reason: "", url: "", image: "", alt: "", colors: [], colorCount: "" };
}

export function defaults() {
  const now = new Date();
  return {
    season: now.getMonth() >= 6 ? "fall" : "spring",
    year: String(now.getFullYear()),
    vendor: "ss",
    teamMember: "",
    intro: "Five styles I keep coming back to for real client needs, comfortable teams, and gear people will actually wear.",
    picks: Array.from({ length: DEFAULT_PICKS }, blankPick),
  };
}

function normalizeColor(c) {
  if (typeof c === "string") {
    const [name, hex] = c.split("|").map((v) => String(v || "").trim());
    return { name: plain(name, 40), hex: HEX_RE.test(hex || "") ? hex.toLowerCase() : "" };
  }
  const o = c || {};
  const hex = String(o.hex || "").trim();
  return { name: plain(o.name, 40), hex: HEX_RE.test(hex) ? hex.toLowerCase() : "" };
}

/**
 * Clean whatever the browser sent into the stored shape. Never throws and
 * never refuses: an unfinished draft must still save. What is missing is
 * reported by problems(), which is what stops a send.
 */
export function normalize(input) {
  const d = input && typeof input === "object" ? input : {};
  const base = defaults();
  const picks = (Array.isArray(d.picks) ? d.picks : base.picks).slice(0, MAX_PICKS).map((p) => {
    const q = p && typeof p === "object" ? p : {};
    const colors = (Array.isArray(q.colors) ? q.colors : [])
      .map(normalizeColor).filter((c) => c.name).slice(0, MAX_SWATCHES);
    const count = parseInt(q.colorCount, 10);
    return {
      name: plain(q.name, 120),
      style: plain(q.style, 40),
      msrp: plain(q.msrp, 20),
      reason: prose(q.reason, 400),
      url: plain(q.url, 600),
      image: plain(q.image, 600),
      alt: plain(q.alt, 160),
      colors,
      colorCount: Number.isFinite(count) && count > 0 ? String(Math.min(count, 999)) : "",
    };
  });
  return {
    season: SEASONS.includes(d.season) ? d.season : base.season,
    year: /^\d{4}$/.test(String(d.year || "").trim()) ? String(d.year).trim() : base.year,
    vendor: VENDORS[d.vendor] ? d.vendor : base.vendor,
    teamMember: plain(d.teamMember, 60),
    intro: prose(d.intro != null ? d.intro : base.intro, 600),
    picks,
  };
}

/** Plain-English list of what stands between this email and a send. */
export function problems(data) {
  const d = normalize(data);
  const out = [];
  if (!d.teamMember) out.push("Add the team member whose picks these are.");
  if (!d.picks.length) out.push("Add at least one pick.");
  d.picks.forEach((p, i) => {
    const n = `Pick ${slotLabel(i + 1)}`;
    if (!p.name) out.push(`${n} needs a product name.`);
    if (!p.style) out.push(`${n} needs the supplier style number.`);
    if (!Number.isFinite(parseMoney(p.msrp))) out.push(`${n} needs the MSRP, exactly as the supplier lists it.`);
    if (!p.reason) out.push(`${n} needs a reason ("why i like it").`);
    if (!httpsUrl(p.url)) out.push(`${n} needs a link to the product on ${VENDORS[d.vendor].name} (https).`);
    if (!httpsUrl(p.image)) out.push(`${n} needs a product photo.`);
    if (!p.colors.length) out.push(`${n} needs at least one color.`);
    p.colors.filter((c) => !c.hex).forEach((c) => out.push(`${n}: pick the swatch color for ${c.name}.`));
  });
  return out;
}

function msrpText(raw) {
  const v = plain(raw);
  if (!v) return "$00.00";
  return v.startsWith("$") ? v : `$${v}`;
}

function titleText(name, i) {
  const v = plain(name) || `product ${i + 1} name`;
  return /[.!?]$/.test(v) ? v : `${v}.`;
}

function swatchesHtml(p, href) {
  const visible = p.colors.length ? p.colors : [{ name: "Color", hex: "#cccccc" }];
  const total = Math.max(parseInt(p.colorCount, 10) || visible.length, visible.length);
  const circles = visible.map((c) => `<td align="center" style="padding:0 7px 7px 0;"><span title="${esc(c.name)}" style="display:block;width:25px;height:25px;border-radius:50%;background:${esc(c.hex || "#cccccc")};border:1px solid #777;">&nbsp;</span></td>`).join("");
  const extra = total > visible.length ? ` + ${total - visible.length} more` : "";
  return {
    total,
    html: `<a href="${esc(href)}" target="_blank" style="color:#111;text-decoration:none;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${circles}</tr></table><div style="font:400 12px/18px Arial,Helvetica,sans-serif;color:#555;">${esc(visible.map((c) => c.name).join(", "))}${esc(extra)}</div></a>`,
  };
}

function pickHtml(p, i, d, ctx) {
  const slot = slotLabel(i + 1);
  const vendor = VENDORS[d.vendor];
  const url = httpsUrl(p.url) || vendor.home;
  const link = (spot) => tagLink(url, { campaignId: ctx.campaignId, content: `pick-${slot}-${spot}` });
  const img = httpsUrl(p.image) || assetUrl("product-placeholder.png", ctx.assetBase);
  const alt = p.alt || p.name || `Pick ${slot}`;
  const sw = swatchesHtml(p, link("colors"));
  const t = ctx.t;
  return `<tr><td class="pad" style="padding:22px 40px 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:3px solid #111111;"><tr><td style="background:#111;padding:12px 18px;font:900 14px/18px Arial Black,Arial,sans-serif;color:#fff;letter-spacing:1px;text-transform:lowercase;">pick ${slot}.</td><td align="right" style="background:#111;padding:12px 18px;font:700 14px/18px Arial,sans-serif;color:#fff;">MSRP ${esc(msrpText(p.msrp))}</td></tr><tr><td colspan="2"><a href="${esc(link("photo"))}" target="_blank"><img class="product-image" src="${esc(img)}" width="554" alt="${esc(alt)}" style="width:100%;max-width:554px;height:auto;background:#f4f4f4;"></a></td></tr><tr><td colspan="2" style="padding:24px 22px 22px;"><div class="pick-title" style="font:900 32px/35px Arial Black,Arial,sans-serif;letter-spacing:-.5px;text-transform:lowercase;">${esc(titleText(p.name, i))}</div><div style="padding-top:7px;font:700 13px/18px Arial,sans-serif;color:#555;letter-spacing:.7px;text-transform:uppercase;">${esc(vendor.name)} · STYLE ${esc(p.style || "STYLE")}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-top:1px solid #d6d6d6;border-bottom:1px solid #d6d6d6;"><tr><td class="reason-label" width="126" valign="top" style="padding:18px 14px 18px 0;font:900 13px/18px Arial Black,Arial,sans-serif;text-transform:lowercase;">why i like it.</td><td class="reason-copy" valign="top" style="padding:18px 0;font:400 15px/23px Arial,sans-serif;color:#333;">${proseHtml(t(p.reason || "Add one short, specific reason this style works for you or your clients."))}</td></tr></table><div style="padding-top:18px;font:900 13px/18px Arial Black,Arial,sans-serif;text-transform:lowercase;">available in ${sw.total} color${sw.total === 1 ? "" : "s"}.</div><div style="padding-top:10px;">${sw.html}</div><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;"><tr><td bgcolor="#111111"><a href="${esc(link("button"))}" target="_blank" style="display:inline-block;padding:14px 22px;font:900 14px/18px Arial Black,Arial,sans-serif;color:#fff;text-decoration:none;text-transform:lowercase;">view this style.</a></td></tr></table></td></tr></table></td></tr>`;
}

export function defaultPreheader(data) {
  const d = normalize(data);
  const n = d.picks.length;
  return `${n === 1 ? "One" : numberWord(n).replace(/^./, (c) => c.toUpperCase())} ${VENDORS[d.vendor].name} style${n === 1 ? "" : "s"} worth a closer look, picked by ${d.teamMember || "our team"}.`;
}

/**
 * ctx: { campaignId, preheader, settings, unsubToken, assetBase, t }
 * `t` personalizes a piece of typed text ({{first_name}} and friends). It
 * runs BEFORE escaping, so a name can never inject markup.
 */
export function renderHtml(data, ctx) {
  const d = normalize(data);
  const c = { ...ctx, t: ctx.t || ((s) => s) };
  const vendor = VENDORS[d.vendor];
  const n = d.picks.length;
  const team = d.teamMember || "Team Member";
  const addr = addressLine(c.settings);
  const unsub = unsubscribeHref(c.settings, c.unsubToken);
  const browse = tagLink(vendor.home, { campaignId: c.campaignId, content: "footer" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><style>html,body{margin:0!important;padding:0!important;width:100%!important}table{border-collapse:collapse!important;border-spacing:0!important}img{border:0;display:block;line-height:100%;outline:none}@media screen and (max-width:680px){.shell{width:100%!important}.pad{padding-left:22px!important;padding-right:22px!important}.hero-title{font-size:43px!important;line-height:44px!important}.pick-title{font-size:27px!important;line-height:30px!important}.product-image{width:100%!important;height:auto!important}.reason-label,.reason-copy{display:block!important;width:100%!important}.reason-label{padding-bottom:8px!important}}</style><title>picks with personality.</title></head><body style="margin:0;padding:0;background:#e8e8e8;font-family:Arial,Helvetica,sans-serif;color:#111">${preheaderHtml(c.preheader || defaultPreheader(d))}<center style="width:100%;background:#e8e8e8"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 0"><table role="presentation" class="shell" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:#fff"><tr><td><img src="${esc(assetUrl("pm-texture-strip.jpg", c.assetBase))}" width="640" alt="" style="width:100%;max-width:640px;height:auto"></td></tr><tr><td class="pad" style="background:#211d1e;padding:30px 40px 36px"><table role="presentation" width="100%"><tr><td width="86"><img src="${esc(assetUrl("pm-circle-logo.png", c.assetBase))}" width="76" height="76" alt="P&amp;M Apparel"></td><td align="right" style="font:700 12px/18px Arial,sans-serif;color:#fff;letter-spacing:1.5px;text-transform:uppercase">${esc(d.season)} ${esc(d.year)}<br>${esc(vendor.name)}</td></tr></table><div class="hero-title" style="padding-top:28px;font:900 56px/56px Arial Black,Arial,sans-serif;letter-spacing:-2px;color:#fff;text-transform:lowercase">picks with<br>personality.</div><div style="padding-top:18px;font:700 15px/22px Arial,sans-serif;color:#fff">${esc(numberWord(n))} style${n === 1 ? "" : "s"} picked by ${esc(team)}.</div></td></tr><tr><td class="pad" style="padding:34px 40px 20px"><div style="font:900 22px/27px Arial Black,Arial,sans-serif;text-transform:lowercase">here's what i'd recommend.</div><div style="padding-top:10px;font:400 16px/25px Arial,sans-serif;color:#333">${proseHtml(c.t(d.intro))}</div></td></tr>${d.picks.map((p, i) => pickHtml(p, i, d, c)).join("")}<tr><td class="pad" style="padding:28px 40px 40px"><table role="presentation"><tr><td bgcolor="#111111"><a href="${esc(browse)}" target="_blank" style="display:inline-block;padding:15px 22px;font:900 14px/18px Arial Black,Arial,sans-serif;color:#fff;text-decoration:none;text-transform:lowercase">browse ${esc(vendor.name)}.</a></td></tr></table></td></tr><tr><td class="pad" style="background:#211d1e;padding:30px 40px;color:#fff"><div style="font:900 22px/27px Arial Black,Arial,sans-serif;text-transform:lowercase">good people. great gear.</div><div style="padding-top:10px;font:400 12px/19px Arial,sans-serif;color:#d8d8d8">P&amp;M Apparel${addr ? ` · ${esc(addr)}` : ""}</div>${unsub ? `<div style="padding-top:8px;font:400 12px/19px Arial,sans-serif"><a href="${esc(unsub)}" style="color:#fff;text-decoration:underline">unsubscribe</a></div>` : ""}</td></tr></table></td></tr></table></center></body></html>`;
}

export function renderText(data, ctx) {
  const d = normalize(data);
  const t = ctx.t || ((s) => s);
  const vendor = VENDORS[d.vendor];
  const n = d.picks.length;
  const lines = [
    "picks with personality.",
    "",
    `${numberWord(n).replace(/^./, (c) => c.toUpperCase())} ${vendor.name} style${n === 1 ? "" : "s"} picked by ${d.teamMember || "our team"}.`,
    "",
    t(d.intro),
    "",
  ];
  d.picks.forEach((p, i) => {
    const slot = slotLabel(i + 1);
    lines.push(`${i + 1}. ${p.name} | STYLE ${p.style} | MSRP ${msrpText(p.msrp)}`);
    if (p.reason) lines.push(t(p.reason));
    if (p.colors.length) lines.push(`Colors: ${p.colors.map((c) => c.name).join(", ")}`);
    lines.push(tagLink(httpsUrl(p.url) || vendor.home, { campaignId: ctx.campaignId, content: `pick-${slot}-text` }));
    lines.push("");
  });
  lines.push(`browse ${vendor.name}: ${tagLink(vendor.home, { campaignId: ctx.campaignId, content: "footer" })}`);
  return lines.join("\n");
}
