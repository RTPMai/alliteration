// PUT IN: lib/mailme/templates/seasonal.js
// lib/mailme/templates/seasonal.js: the seasonal announcement email.
//
// Built from the sales director's 2026 Holiday Stores email (Sep 25 2026).
// Hers was one tall picture with four buttons under it. This keeps her
// copy and her buttons, but as real text, because:
//   - Outlook blocks pictures until someone clicks "download pictures", so a
//     picture-only email opens as a blank box for most corporate readers.
//   - Spam filters score an email that is all picture as likely spam.
//   - On a phone a 700px picture of text shrinks to fine print.
//
// WHAT IS DIFFERENT FROM HERS, on purpose:
//   - ONE contact button per reader: "Email Hannah" for Hannah's clients,
//     "Email Alexis" for Alexis's. Hers had three fixed buttons, so a client
//     of anyone else got buttons for somebody who is not their rep. The
//     address follows the same first-name rule MailMe's reply-to already
//     uses (firstname@<reply-to domain in Settings>), and only the first
//     names listed in the form ever get a button, so a placeholder owner
//     like "House Account" can never produce an "Email House" button.
//     A reader with no listed rep gets her inquiry-form button instead.
//   - The timelines are text cards, readable with pictures off. The full
//     calendar can still go in as a picture under them.
//   - The footer carries the postal address and unsubscribe link, which the
//     law requires in a marketing email.
//   - Sep 29 2026: restyled to the P&M Branding Guidelines. Black and white
//     over the brand texture, logo and texture strip up top, Arial Black
//     headers in lower case ending in a period, square black and white
//     buttons. Her teal, serif headline and colored chips are gone.
//
// **double stars** around words make them bold, the way her copy bolds
// dates. Nothing else in typed text becomes markup.
//
// TOKEN-EXEMPT: email HTML, see shared.js.
//
// ESM. Do NOT convert to module.exports.

import {
  esc, plain, prose, httpsUrl, tagLink, addressLine, unsubscribeHref, preheaderHtml,
  BRAND, brandHead, assetUrl, textureBg,
} from "./shared.js";

export const KEY = "seasonal";
export const LABEL = "Seasonal announcement";
export const DESCRIPTION = "A season's dates and timelines, with a button to email each reader's own account manager.";

export const MAX_TIMELINES = 3;
export const MAX_STEPS = 6;
export const MAX_SECTIONS = 8;
export const MAX_PEOPLE = 12;

export const INQUIRY_FORM_URL = "https://forms.monday.com/forms/e8ecf816d4b9d2a116e0b777548f79f3?r=use1";

// Black and white, per the P&M Branding Guidelines (see BRAND in shared.js).
// Her email was teal; the brand is not. Timelines are told apart the way
// the guidelines show the logo: FILLED (black chips) for the first,
// OUTLINED (white chips, black ring) for the second, grey for a third.
const C = {
  ink: BRAND.black, paper: BRAND.white, muted: BRAND.grey, soft: BRAND.soft, rule: BRAND.rule,
};
const CHIP_STYLES = [
  { bg: BRAND.black, fg: BRAND.white, ring: BRAND.black },
  { bg: BRAND.white, fg: BRAND.black, ring: BRAND.black },
  { bg: BRAND.grey, fg: BRAND.white, ring: BRAND.grey },
];

export function blankTimeline() {
  return { label: "", title: "", steps: [blankStep()] };
}
export function blankStep() {
  return { name: "", dates: "" };
}
export function blankSection() {
  return { heading: "", text: "" };
}

export function defaults() {
  return {
    eyebrow: "2026 | Great gear. A little less holiday chaos.",
    headline: "P&M Apparel Holiday Stores",
    intro: "The holidays are coming. The lights are tangled. Someone has already scheduled three parties on the same night. And somewhere, someone is saying, \"We still have plenty of time to order gifts.\" Let's get your gear started before that person becomes you.\n\n" +
      "At P&M Apparel, we're here to make your **custom online store or bulk order** one of the easy things on your holiday list. Whether you're planning corporate gifts, a team celebration, or something special for your crew, our 2026 calendar walks you from store setup to gear in hand.",
    timelines: [
      {
        label: "Ideal timeline",
        title: "Delivered by December 4",
        steps: [
          { name: "Store setup", dates: "Oct 8 - 21" },
          { name: "Store live", dates: "Oct 22 - Nov 4" },
          { name: "Production", dates: "Nov 5 - 25" },
          { name: "Shipping & delivery", dates: "Nov 30 - Dec 4" },
        ],
      },
      {
        label: "Latest we can start",
        title: "Get your gear by December 16",
        steps: [
          { name: "Store setup", dates: "Oct 20 - Nov 2" },
          { name: "Store live", dates: "Nov 3 - 16" },
          { name: "Production", dates: "Nov 17 - Dec 9" },
          { name: "Shipping & delivery", dates: "Dec 10 - 16" },
        ],
      },
    ],
    sections: [
      {
        heading: "Plan Ahead for Early December Delivery",
        text: "Give future-you an early holiday gift: one less thing to panic about. Our ideal timeline starts **October 8**, with shipping and delivery scheduled for **November 30-December 4**. That gives us time for product selection, designs, and store prep, and gives you time to find the missing tree stand.",
      },
      {
        heading: "Latest We Can Start: Get Your Gear by 12/16",
        text: "More of a \"how is it October already?\" planner? We get it. Reach out **no later than October 20** to begin your store setup and stay on track for delivery by **December 16**. Our production elves are talented, but they still need the days on the calendar.",
      },
      {
        heading: "Here's What to Expect",
        text: "**1. Store setup:** 2 weeks for product selection, design, and preparation.\n" +
          "**2. Store live:** 2 full weeks for customers to shop, including weekends.\n" +
          "**3. Production after your store closes:** 12-15 business days.\n" +
          "**4. Shipping and delivery:** 5 business days.\n\n" +
          "Our calendar allows the full 15 business days for production. We're closed on weekends and **November 26-27**, so those days are excluded from setup, production, and delivery timelines. Your online store remains open for shopping throughout its two-week live window.",
      },
      {
        heading: "Hosting a Corporate Holiday Party?",
        text: "If your party or event is in November or early December, a **bulk order** may be a better fit. Tell us your event date so we can help plan your corporate gifts, employee gear, or team essentials. You handle the head count and the great office thermostat debate. We'll help with the apparel.",
      },
      {
        heading: "Don't wait. Get started today.",
        text: "Let's get your team into gear they'll love before your to-do list starts requiring its own to-do list. We're ready when you are. Preferably before the wrapping-paper panic.",
      },
    ],
    calendar: { image: "", alt: "", url: "" },
    contactHeadline: "Let's start your project",
    people: ["Abby", "Alexis", "Hannah", "Jacob"],
    amText: "{name} is your account manager. Click below to email them.",
    mailSubject: "Let's start my holiday project",
    formPrompt: "Not sure who to contact? Start here:",
    formLabel: "Start a project",
    formUrl: INQUIRY_FORM_URL,
    signoff: "Warm wishes and untangled lights,\n**The P&M Apparel Team**",
  };
}

function lineList(v, max, each) {
  const raw = Array.isArray(v) ? v : String(v || "").split(/[\n,]+/);
  return raw.map((x) => plain(x, each)).filter(Boolean).slice(0, max);
}

export function normalize(input) {
  const d = input && typeof input === "object" ? input : {};
  const base = defaults();
  const has = (k) => d[k] !== undefined && d[k] !== null;
  const pick = (k, max) => plain(has(k) ? d[k] : base[k], max);
  const text = (k, max) => prose(has(k) ? d[k] : base[k], max);

  const timelines = (Array.isArray(d.timelines) ? d.timelines : base.timelines).slice(0, MAX_TIMELINES).map((tl) => {
    const q = tl && typeof tl === "object" ? tl : {};
    return {
      label: plain(q.label, 40),
      title: plain(q.title, 80),
      steps: (Array.isArray(q.steps) ? q.steps : []).slice(0, MAX_STEPS).map((s) => {
        const r = s && typeof s === "object" ? s : {};
        return { name: plain(r.name, 40), dates: plain(r.dates, 40) };
      }),
    };
  });

  const sections = (Array.isArray(d.sections) ? d.sections : base.sections).slice(0, MAX_SECTIONS).map((s) => {
    const q = s && typeof s === "object" ? s : {};
    return { heading: plain(q.heading, 100), text: prose(q.text, 1500) };
  });

  const cal = d.calendar && typeof d.calendar === "object" ? d.calendar : base.calendar;

  return {
    eyebrow: pick("eyebrow", 80),
    headline: pick("headline", 80),
    intro: text("intro", 1500),
    timelines,
    sections,
    calendar: { image: plain(cal.image, 600), alt: plain(cal.alt, 300), url: plain(cal.url, 600) },
    contactHeadline: pick("contactHeadline", 60),
    people: lineList(has("people") ? d.people : base.people, MAX_PEOPLE, 30),
    amText: pick("amText", 140),
    mailSubject: pick("mailSubject", 100),
    formPrompt: pick("formPrompt", 100),
    formLabel: pick("formLabel", 40),
    formUrl: pick("formUrl", 600),
    signoff: text("signoff", 200),
  };
}

export function problems(data) {
  const d = normalize(data);
  const out = [];
  if (!d.headline) out.push("Add a headline.");
  if (!d.intro) out.push("Add an intro.");
  d.timelines.forEach((tl, i) => {
    const n = `Timeline ${i + 1}`;
    if (!tl.title) out.push(`${n} needs a title (like "Delivered by December 4").`);
    if (!tl.steps.length) out.push(`${n} needs at least one step.`);
    tl.steps.forEach((s, j) => {
      if (!s.name || !s.dates) out.push(`${n}, step ${j + 1} needs both a name and its dates.`);
    });
  });
  d.sections.forEach((s, i) => {
    if (!s.text) out.push(`Section ${i + 1}${s.heading ? ` ("${s.heading}")` : ""} has no text.`);
  });
  if (d.calendar.image && !httpsUrl(d.calendar.image)) out.push("The calendar picture link has to be https.");
  if (d.calendar.image && !d.calendar.alt) out.push("The calendar picture needs a description, for people whose email hides pictures.");
  if (d.calendar.url && !httpsUrl(d.calendar.url)) out.push("The calendar's click-through link has to be https.");
  if (!d.formLabel) out.push("The inquiry form button needs a label.");
  if (!httpsUrl(d.formUrl)) out.push("The inquiry form button needs an https link. It is the only button people without an account manager get.");
  d.people.forEach((p) => {
    if (!isFirstName(p)) out.push(`"${p}" in the account manager list is not a first name.`);
  });
  return out;
}

/* ---- the one contact button ------------------------------------------- */

/** A list entry that can label a button: letters, maybe an apostrophe or hyphen. */
function isFirstName(p) {
  return /^[a-z][a-z'-]*[a-z]$/i.test(plain(p).split(/[\s,]+/)[0] || "");
}

function firstNameKey(s) {
  return String(s || "").trim().split(/[\s,]+/)[0].toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * The reader's own account manager, or null.
 *
 * `accountManager` is what BackBone has for the contact ("Hannah Posey").
 * Only names on the form's list get a button, so an owner like "TBD" or
 * "House Account" falls back to the inquiry form instead of producing a
 * button for nobody. The address is the same firstname@domain MailMe's
 * reply-to derives (resolveReplyTo in lib/mailme/schema.js), so replying
 * and clicking reach the same person.
 */
export function accountManagerFor(accountManager, people, domain) {
  const key = firstNameKey(accountManager);
  const dom = String(domain || "").trim().toLowerCase();
  if (key.length < 2 || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) return null;
  const match = (Array.isArray(people) ? people : []).find((p) => isFirstName(p) && firstNameKey(p) === key);
  if (!match) return null;
  const name = plain(match).split(/\s+/)[0];
  return { name, email: `${key}@${dom}` };
}

function mailto(email, subject) {
  // encodeURIComponent leaves ' alone; her links spelled it %27, and some
  // mail apps cut a subject short at a bare apostrophe.
  const enc = encodeURIComponent(subject || "").replace(/'/g, "%27");
  return `mailto:${email}${enc ? `?subject=${enc}` : ""}`;
}

/* ---- rendering -------------------------------------------------------- */

/** Escaped text, **bold** made bold, line breaks kept. Personalized first. */
function rich(s, color) {
  return esc(s)
    .replace(/\*\*([^*\n]+?)\*\*/g, `<strong style="color:${color || C.ink};">$1</strong>`)
    .replace(/\n/g, "<br>");
}

/** For the plain-text part: the stars come off. */
function unstar(s) {
  return String(s || "").replace(/\*\*([^*\n]+?)\*\*/g, "$1");
}

const FONT = BRAND.body;
const HEAD = BRAND.head;

function rule() {
  return `<tr><td class="mobile-pad" style="padding:0 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;line-height:1px;font-size:0;border-top:1px solid ${C.rule};">&nbsp;</td></tr></table></td></tr>`;
}

/**
 * A square button, Arial Black, lower case, a period on the end, the way the
 * guidelines set calls to action. `dark` is black on white paper; otherwise
 * it is white on a black band.
 */
function button(href, label, dark) {
  const bg = dark ? C.ink : C.paper;
  const fg = dark ? C.paper : C.ink;
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center"><tr><td align="center" bgcolor="${bg}" style="mso-padding-alt:15px 24px;"><a href="${esc(href)}" style="display:inline-block;padding:15px 24px;font-family:${HEAD};font-size:15px;line-height:20px;font-weight:900;color:${fg};text-decoration:none;border:2px solid ${bg};">${esc(brandHead(label))}</a></td></tr></table>`;
}

function timelineHtml(tl, i) {
  const chip = CHIP_STYLES[i % CHIP_STYLES.length];
  const rows = tl.steps.map((s, j) => `<tr><td width="36" valign="middle" style="padding:7px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" bgcolor="${chip.bg}" style="width:24px;height:24px;border:2px solid ${chip.ring};font-family:${HEAD};font-size:13px;line-height:24px;font-weight:900;color:${chip.fg};">${j + 1}</td></tr></table></td><td valign="middle" style="padding:7px 8px 7px 4px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:bold;color:${C.ink};">${esc(s.name || "Step")}</td><td valign="middle" align="right" style="padding:7px 0;font-family:${FONT};font-size:15px;line-height:20px;color:${C.muted};white-space:nowrap;">${esc(s.dates || "Dates")}</td></tr>`).join("");
  const strip = tl.label
    ? `<tr><td bgcolor="${C.ink}" style="background:${C.ink};padding:11px 18px;font-family:${HEAD};font-size:14px;line-height:18px;font-weight:900;letter-spacing:.5px;color:${C.paper};">${esc(brandHead(tl.label))}</td></tr>`
    : "";
  return `<tr><td class="mobile-pad" style="padding:0 48px 18px 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.paper}" style="width:100%;background:${C.paper};border:3px solid ${C.ink};">${strip}<tr><td style="padding:18px 20px 14px 20px;"><p style="margin:0 0 8px 0;font-family:${HEAD};font-size:21px;line-height:26px;font-weight:900;color:${C.ink};">${esc(brandHead(tl.title || "Timeline"))}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">${rows}</table></td></tr></table></td></tr>`;
}

export function renderHtml(data, ctx) {
  const d = normalize(data);
  const c = { ...ctx, t: ctx.t || ((s) => s) };
  const settings = c.settings || {};
  const am = accountManagerFor(c.accountManager, d.people, settings.replyToDomain);
  const form = httpsUrl(d.formUrl) || INQUIRY_FORM_URL;
  const formHref = tagLink(form, { campaignId: c.campaignId, content: "form" });
  const addr = addressLine(settings);
  const unsub = unsubscribeHref(settings, c.unsubToken);
  const tex = textureBg(c.assetBase);
  const pattern = esc(tex.url);

  const para = (s) => `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:16px;line-height:25px;color:${C.ink};">${rich(c.t(s))}</p>`;
  const paragraphs = (s) => String(s || "").split(/\n{2,}/).filter((x) => x.trim()).map(para).join("");

  const sections = d.sections.map((s) => `${rule()}<tr><td class="mobile-pad" style="padding:26px 48px 10px 48px;">${s.heading ? `<h2 style="margin:0 0 12px 0;font-family:${HEAD};font-size:22px;line-height:27px;font-weight:900;color:${C.ink};">${esc(brandHead(c.t(s.heading)))}</h2>` : ""}${paragraphs(s.text)}</td></tr>`).join("");

  const calImg = httpsUrl(d.calendar.image);
  const calHref = calImg ? tagLink(httpsUrl(d.calendar.url) || calImg, { campaignId: c.campaignId, content: "calendar" }) : "";
  const calendar = calImg
    ? `${rule()}<tr><td class="mobile-pad" style="padding:26px 48px 8px 48px;"><a href="${esc(calHref)}" style="text-decoration:none;"><img src="${esc(calImg)}" width="538" alt="${esc(d.calendar.alt)}" style="display:block;width:100%;max-width:538px;height:auto;border:0;background:${BRAND.wash};"></a><p style="margin:8px 0 16px 0;font-family:${FONT};font-size:13px;line-height:18px;color:${C.muted};text-align:center;">Tap the calendar to see it full size.</p></td></tr>`
    : "";

  const amBlock = am
    ? `<tr><td align="center" class="mobile-pad" style="padding:0 40px 16px 40px;font-family:${FONT};font-size:16px;line-height:24px;color:${C.paper};">${esc(c.t(d.amText).replace(/\{\s*name\s*\}/gi, am.name))}</td></tr><tr><td align="center" style="padding:0 16px 26px 16px;">${button(mailto(am.email, c.t(d.mailSubject)), `Email ${am.name}`, false)}</td></tr>`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(brandHead(d.headline))}</title><style>html,body{margin:0!important;padding:0!important;width:100%!important}table,td{border-collapse:collapse!important}img{-ms-interpolation-mode:bicubic}a{color:inherit}@media only screen and (max-width:660px){.email-shell{width:100%!important}.mobile-pad{padding-left:22px!important;padding-right:22px!important}.hero-title{font-size:38px!important;line-height:40px!important}}</style></head><body background="${pattern}" style="margin:0;padding:0;${tex.css}"><!--[if gte mso 9]><v:background xmlns:v="urn:schemas-microsoft-com:vml" fill="t"><v:fill type="tile" src="${pattern}" color="${C.ink}"/></v:background><![endif]-->${preheaderHtml(c.preheader || unstar(d.intro))}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" background="${pattern}" style="width:100%;${tex.css}"><tr><td align="center" style="padding:24px 0;"><!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]--><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.paper}" class="email-shell" style="width:640px;max-width:640px;background:${C.paper};">`
    + `<tr><td><img src="${esc(assetUrl("pm-texture-strip.jpg", c.assetBase))}" width="640" alt="" style="display:block;width:100%;max-width:640px;height:auto;border:0;"></td></tr>`
    + `<tr><td class="mobile-pad" bgcolor="${C.ink}" style="background:${C.ink};padding:30px 48px 38px 48px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="88" valign="middle"><a href="https://www.pmapparel.com/" style="text-decoration:none;"><img src="${esc(assetUrl("pm-circle-logo-white.png", c.assetBase))}" width="76" height="76" alt="P&amp;M Apparel" style="display:block;width:76px;height:76px;border:0;"></a></td><td align="right" valign="middle" style="font-family:${FONT};font-size:12px;line-height:18px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:${C.paper};">${d.eyebrow ? esc(c.t(d.eyebrow)) : ""}</td></tr></table><h1 class="hero-title" style="margin:28px 0 0 0;font-family:${HEAD};font-size:48px;line-height:50px;font-weight:900;letter-spacing:-1.5px;color:${C.paper};">${esc(brandHead(c.t(d.headline)))}</h1></td></tr>`
    + `<tr><td class="mobile-pad" style="padding:34px 48px 12px 48px;">${paragraphs(d.intro)}</td></tr>`
    + d.timelines.map(timelineHtml).join("")
    + sections
    + calendar
    + `<tr><td bgcolor="${C.ink}" style="background:${C.ink};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`
    + `<tr><td align="center" class="mobile-pad" style="padding:34px 40px 14px 40px;font-family:${HEAD};font-size:26px;line-height:31px;font-weight:900;color:${C.paper};">${esc(brandHead(c.t(d.contactHeadline || "Let's start your project")))}</td></tr>`
    + amBlock
    + `<tr><td align="center" class="mobile-pad" style="padding:0 40px 16px 40px;font-family:${FONT};font-size:16px;line-height:24px;color:${C.paper};">${esc(c.t(d.formPrompt))}</td></tr><tr><td align="center" style="padding:0 16px 36px 16px;">${button(formHref, d.formLabel || "Start a project", false)}</td></tr>`
    + `</table></td></tr>`
    + (d.signoff ? `<tr><td class="mobile-pad" style="padding:30px 48px 34px 48px;"><p style="margin:0;font-family:${FONT};font-size:16px;line-height:25px;color:${C.ink};">${rich(c.t(d.signoff))}</p></td></tr>` : "")
    + `<tr><td class="mobile-pad" bgcolor="${C.ink}" style="background:${C.ink};padding:28px 48px 30px 48px;"><div style="font-family:${HEAD};font-size:22px;line-height:27px;font-weight:900;color:${C.paper};">good people. great gear.</div><div style="padding-top:10px;font-family:${FONT};font-size:12px;line-height:19px;color:${C.soft};"><strong style="color:${C.paper};">P&amp;M Apparel</strong>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="https://www.pmapparel.com/" style="color:${C.soft};text-decoration:underline;">pmapparel.com</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="tel:+15159847740" style="color:${C.soft};text-decoration:none;">515.984.7740</a>${addr ? `<br>${esc(addr)}` : ""}${unsub ? `<br><a href="${esc(unsub)}" style="color:${C.paper};text-decoration:underline;">unsubscribe</a>` : ""}</div></td></tr>`
    + `</table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
}

export function renderText(data, ctx) {
  const d = normalize(data);
  const t = ctx.t || ((s) => s);
  const settings = ctx.settings || {};
  const am = accountManagerFor(ctx.accountManager, d.people, settings.replyToDomain);
  const lines = [unstar(t(d.headline)), d.eyebrow ? unstar(t(d.eyebrow)) : "", "", unstar(t(d.intro)), ""];
  d.timelines.forEach((tl) => {
    lines.push([tl.label, tl.title].filter(Boolean).join(": "));
    tl.steps.forEach((s, j) => lines.push(`${j + 1}. ${s.name}: ${s.dates}`));
    lines.push("");
  });
  d.sections.forEach((s) => {
    if (s.heading) lines.push(unstar(t(s.heading)).toUpperCase());
    lines.push(unstar(t(s.text)), "");
  });
  const cal = httpsUrl(d.calendar.image);
  if (cal) lines.push(`See the full calendar: ${tagLink(httpsUrl(d.calendar.url) || cal, { campaignId: ctx.campaignId, content: "calendar" })}`, "");
  lines.push(unstar(t(d.contactHeadline)));
  if (am) lines.push(`${unstar(t(d.amText)).replace(/\{\s*name\s*\}/gi, am.name)} ${am.email}`);
  lines.push(`${unstar(t(d.formPrompt))} ${tagLink(httpsUrl(d.formUrl) || INQUIRY_FORM_URL, { campaignId: ctx.campaignId, content: "form" })}`, "");
  if (d.signoff) lines.push(unstar(t(d.signoff)), "");
  lines.push("P&M Apparel | 515.984.7740 | pmapparel.com");
  return lines.join("\n");
}
