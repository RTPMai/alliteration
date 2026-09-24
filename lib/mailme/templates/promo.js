// PUT IN: lib/mailme/templates/promo.js
// lib/mailme/templates/promo.js: P&M promotional-products email.
//
// The sales director's canonical system for promo-product blasts (Aug 2026),
// first used for the dental campaign. One product per white card over the
// P&M print-shop pattern, black header and footer. The markup is hers, kept
// as close to line-for-line as the data allows.
//
// HER RULES, and where each one is enforced. These are the point of building
// it in rather than pasting HTML: a pasted email cannot check itself.
//   - Price rounds UP to the next whole dollar, shown as .00. $7.01 is $8.00,
//     and a price is never shown below the source. -> ceilDollars (shared.js)
//   - Setup charge shown as currency ending .00.       -> ceilDollars
//   - The first quantity is labelled "minimum order".   -> markup
//   - No more than four colors; "+ add'l" after the fourth, or when the
//     product has more than were typed.                 -> colorsText
//   - The disclaimer, exactly, once.                    -> DISCLAIMER
//   - No item numbers anywhere.                         -> no field for one,
//     and problems() refuses a name that looks like it carries one.
//   - Nothing inferred: a product with a missing price, setup, minimum or
//     color is a problem, not a guess.                  -> problems()
//
// What changed from her file: clicks are tagged for MailMe's reporting
// (tagLink) instead of a redirect server, and the footer gains the postal
// address and unsubscribe link, which the law requires in a marketing email
// and her platform export left for the sending platform to add.
//
// TOKEN-EXEMPT: email HTML, see shared.js.
//
// ESM. Do NOT convert to module.exports.

import {
  esc, plain, prose, proseHtml, httpsUrl, tagLink, slotLabel,
  assetUrl, addressLine, unsubscribeHref, preheaderHtml, parseMoney, ceilDollars,
} from "./shared.js";

export const KEY = "promo";
export const LABEL = "Promo products";
export const DESCRIPTION = "Promotional products, one per card, with minimum, price, setup and colors.";

export const DISCLAIMER = "*Setup charge shown is for printing one color only. Prices shown at the listed minimum order.";
export const CATALOG_URL = "https://www.promoplace.com/pmapparel";
export const MAX_PRODUCTS = 12;
export const MAX_COLORS_SHOWN = 4;

export function blankProduct() {
  return { name: "", colors: [], moreColors: false, minimum: "", price: "", setup: "", url: "", image: "", alt: "" };
}

export function defaults() {
  return {
    eyebrow: "promo product picks",
    headline: "promotional products people will actually use.",
    intro: "A useful short list, ready for your logo.",
    ctaLabel: "search promo products",
    ctaUrl: CATALOG_URL,
    closingHeadline: "not seeing the right thing?",
    closingText: "This is only the short list. Search the full catalog or ask us to narrow it down.",
    products: [blankProduct(), blankProduct(), blankProduct()],
  };
}

function colorList(v) {
  const raw = Array.isArray(v) ? v : String(v || "").split(/[\n,]+/);
  return raw.map((c) => plain(c, 40)).filter(Boolean).slice(0, 30);
}

export function normalize(input) {
  const d = input && typeof input === "object" ? input : {};
  const base = defaults();
  const pick = (k, max) => plain(d[k] != null ? d[k] : base[k], max);
  const products = (Array.isArray(d.products) ? d.products : base.products).slice(0, MAX_PRODUCTS).map((p) => {
    const q = p && typeof p === "object" ? p : {};
    const colors = colorList(q.colors);
    return {
      name: plain(q.name, 120),
      colors,
      moreColors: q.moreColors === true || colors.length > MAX_COLORS_SHOWN,
      minimum: plain(q.minimum, 12),
      price: plain(q.price, 20),
      setup: plain(q.setup, 20),
      url: plain(q.url, 600),
      image: plain(q.image, 600),
      alt: plain(q.alt, 160),
    };
  });
  return {
    eyebrow: pick("eyebrow", 60),
    headline: pick("headline", 120),
    intro: prose(d.intro != null ? d.intro : base.intro, 400),
    ctaLabel: pick("ctaLabel", 40),
    ctaUrl: pick("ctaUrl", 600),
    closingHeadline: pick("closingHeadline", 80),
    closingText: prose(d.closingText != null ? d.closingText : base.closingText, 400),
    products,
  };
}

/** "Yellow, Green, Pink" or "Blue, Orange, Green, Pink + add'l". */
export function colorsText(p) {
  const shown = p.colors.slice(0, MAX_COLORS_SHOWN).join(", ");
  const more = p.moreColors || p.colors.length > MAX_COLORS_SHOWN;
  return `${shown}${more ? `${shown ? " " : ""}+ add'l` : ""}`;
}

// An item number in a product name: "#12345", "Item 4471", "No. 88".
const ITEM_NUMBER_RE = /(#\s*\d)|\bitem\s*(no\.?|number|#)?\s*\d|\bno\.\s*\d/i;

export function problems(data) {
  const d = normalize(data);
  const out = [];
  if (!d.headline) out.push("Add a headline.");
  if (!httpsUrl(d.ctaUrl)) out.push("The catalog button needs an https link.");
  if (!d.products.length) out.push("Add at least one product.");
  d.products.forEach((p, i) => {
    const n = `Product ${slotLabel(i + 1)}`;
    if (!p.name) out.push(`${n} needs a name.`);
    else if (ITEM_NUMBER_RE.test(p.name)) out.push(`${n}'s name looks like it has an item number in it. Item numbers never go in these emails.`);
    if (!/^\d[\d,]*$/.test(p.minimum)) out.push(`${n} needs the minimum order (the first quantity on the sheet).`);
    if (!Number.isFinite(parseMoney(p.price))) out.push(`${n} needs the price under that first quantity.`);
    if (!Number.isFinite(parseMoney(p.setup))) out.push(`${n} needs the setup charge.`);
    if (!p.colors.length) out.push(`${n} needs its colors.`);
    if (p.url && !httpsUrl(p.url)) out.push(`${n}'s link has to be https.`);
    if (!httpsUrl(p.image)) out.push(`${n} needs a mockup photo.`);
    if (!p.alt) out.push(`${n} needs a photo description.`);
  });
  return out;
}

function label(text) {
  return `<p style="margin:0 0 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:14px;font-weight:bold;letter-spacing:1px;color:#77736d;text-transform:uppercase;">${text}</p>`;
}

function productHtml(p, i, d, ctx) {
  const slot = slotLabel(i + 1);
  const dest = httpsUrl(p.url) || httpsUrl(d.ctaUrl) || CATALOG_URL;
  const href = tagLink(dest, { campaignId: ctx.campaignId, content: `pick-${slot}-photo` });
  const img = httpsUrl(p.image) || assetUrl("product-placeholder.png", ctx.assetBase);
  const price = ceilDollars(p.price) || "$0.00";
  const setup = ceilDollars(p.setup) || "$0.00";
  const name = plain(p.name) || "Product name";
  const title = /[.!?]$/.test(name) ? name : `${name}.`;
  return `<tr><td style="padding:0 24px 24px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff;border-collapse:collapse;"><tr><td style="padding:18px 18px 0 18px;background:#ffffff;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tr><td style="padding:0;background:#f2f0ec;"><a href="${esc(href)}" style="text-decoration:none;"><img src="${esc(img)}" width="568" alt="${esc(p.alt || name)}" style="display:block;width:100%;max-width:568px;height:auto;border:0;outline:none;text-decoration:none;"></a></td></tr></table></td></tr><tr><td style="padding:22px 24px 26px 24px;"><p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;font-weight:bold;letter-spacing:1.6px;color:#6c6964;text-transform:uppercase;">pick ${slot}</p><h2 style="margin:0 0 16px 0;font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:27px;line-height:31px;font-weight:900;color:#111111;text-transform:lowercase;">${esc(title)}</h2><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;"><tr><td width="50%" valign="top" style="padding:13px 12px 13px 0;border-top:1px solid #d9d6d0;">${label("minimum order")}<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:17px;line-height:22px;font-weight:bold;color:#111111;">${esc(p.minimum || "0")}</p></td><td width="50%" valign="top" style="padding:13px 0 13px 12px;border-top:1px solid #d9d6d0;">${label("price")}<p style="margin:0;font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:23px;line-height:27px;font-weight:900;color:#111111;">${esc(price)}</p></td></tr><tr><td width="50%" valign="top" style="padding:13px 12px 13px 0;border-top:1px solid #d9d6d0;">${label("setup charge*")}<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:17px;line-height:22px;font-weight:bold;color:#111111;">${esc(setup)}</p></td><td width="50%" valign="top" style="padding:13px 0 13px 12px;border-top:1px solid #d9d6d0;">${label("colors")}<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#111111;">${esc(colorsText(p) || "Colors")}</p></td></tr></table></td></tr></table></td></tr>`;
}

export function renderHtml(data, ctx) {
  const d = normalize(data);
  const c = { ...ctx, t: ctx.t || ((s) => s) };
  const pattern = esc(assetUrl("pm-print-pattern-taupe.png", c.assetBase));
  const cta = httpsUrl(d.ctaUrl) || CATALOG_URL;
  const hero = tagLink(cta, { campaignId: c.campaignId, content: "hero" });
  const closing = tagLink(cta, { campaignId: c.campaignId, content: "closing" });
  const addr = addressLine(c.settings);
  const unsub = unsubscribeHref(c.settings, c.unsubToken);
  const bg = `background-color:#e7e4de;background-image:url('${pattern}');background-repeat:repeat;background-position:top center;`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(d.headline)}</title><style>html,body{margin:0!important;padding:0!important;width:100%!important}table,td{border-collapse:collapse!important}img{-ms-interpolation-mode:bicubic}a{color:inherit}@media only screen and (max-width:660px){.email-shell{width:100%!important}.mobile-pad{padding-left:22px!important;padding-right:22px!important}.hero-title{font-size:38px!important;line-height:41px!important}.contact-cell{text-align:left!important;padding-top:16px!important}}</style></head><body background="${pattern}" style="margin:0;padding:0;${bg}"><!--[if gte mso 9]><v:background xmlns:v="urn:schemas-microsoft-com:vml" fill="t"><v:fill type="tile" src="${pattern}" color="#e7e4de"/></v:background><![endif]-->${preheaderHtml(c.preheader || d.intro)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" background="${pattern}" style="width:100%;${bg}"><tr><td align="center" style="padding:0;"><!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]--><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" background="${pattern}" class="email-shell" style="width:640px;max-width:640px;${bg}"><tr><td style="padding:0;background:#111111;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr><td class="mobile-pad" style="padding:28px 34px 16px 34px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle" style="width:96px;"><a href="https://www.pmapparel.com/" style="text-decoration:none;"><img src="${esc(assetUrl("pm-circle-logo-white.png", c.assetBase))}" width="82" alt="P&amp;M Apparel" style="display:block;width:82px;height:82px;border:0;"></a></td><td valign="middle" align="right" class="contact-cell" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:19px;color:#ffffff;text-align:right;"><a href="tel:+15159847740" style="color:#ffffff;text-decoration:none;">515.984.7740</a><br><a href="mailto:info@pmapparel.com" style="color:#ffffff;text-decoration:none;">info@pmapparel.com</a></td></tr></table></td></tr><tr><td class="mobile-pad" style="padding:16px 34px 38px 34px;">${d.eyebrow ? `<p style="margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;font-weight:bold;letter-spacing:1.8px;color:#bcb8b1;text-transform:uppercase;">${esc(d.eyebrow)}</p>` : ""}<h1 class="hero-title" style="margin:0 0 18px 0;font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:50px;line-height:51px;font-weight:900;letter-spacing:-1.5px;color:#ffffff;text-transform:lowercase;">${esc(c.t(d.headline))}</h1>${d.intro ? `<p style="margin:0 0 28px 0;font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:27px;color:#ffffff;">${proseHtml(c.t(d.intro))}</p>` : ""}<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#ffffff;"><a href="${esc(hero)}" style="display:inline-block;padding:15px 23px;font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:14px;line-height:18px;font-weight:900;letter-spacing:.4px;color:#111111;text-decoration:none;text-transform:lowercase;">${esc(d.ctaLabel || "search promo products")}</a></td></tr></table></td></tr></table></td></tr><tr><td style="height:24px;line-height:24px;font-size:0;">&nbsp;</td></tr>${d.products.map((p, i) => productHtml(p, i, d, c)).join("")}<tr><td style="padding:8px 24px 24px 24px;"><p style="margin:0;padding:12px 16px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#595650;">${esc(DISCLAIMER)}</p></td></tr><tr><td style="padding:0 24px 24px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#111111;"><tr><td class="mobile-pad" style="padding:34px 32px;"><h2 style="margin:0 0 12px 0;font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:31px;line-height:34px;font-weight:900;color:#ffffff;text-transform:lowercase;">${esc(d.closingHeadline)}</h2><p style="margin:0 0 23px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#ffffff;">${proseHtml(c.t(d.closingText))}</p><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#ffffff;"><a href="${esc(closing)}" style="display:inline-block;padding:15px 23px;font-family:'Arial Black',Arial,Helvetica,sans-serif;font-size:14px;line-height:18px;font-weight:900;color:#111111;text-decoration:none;text-transform:lowercase;">${esc(d.ctaLabel || "search promo products")}</a></td></tr></table></td></tr></table></td></tr><tr><td align="center" style="padding:18px 24px 22px 24px;background:#111111;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:19px;color:#ffffff;"><strong>P&amp;M Apparel</strong><br>Good People. Great Gear.<br><a href="https://www.pmapparel.com/" style="color:#ffffff;text-decoration:underline;">pmapparel.com</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="mailto:info@pmapparel.com" style="color:#ffffff;text-decoration:underline;">info@pmapparel.com</a>${addr ? `<br><span style="color:#bcb8b1;">${esc(addr)}</span>` : ""}${unsub ? `<br><a href="${esc(unsub)}" style="color:#bcb8b1;text-decoration:underline;">unsubscribe</a>` : ""}</td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
}

export function renderText(data, ctx) {
  const d = normalize(data);
  const t = ctx.t || ((s) => s);
  const cta = httpsUrl(d.ctaUrl) || CATALOG_URL;
  const lines = [t(d.headline), "", t(d.intro), ""];
  d.products.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.name}`);
    lines.push(`Minimum order: ${p.minimum}`);
    lines.push(`Price: ${ceilDollars(p.price) || ""}`);
    lines.push(`Setup charge*: ${ceilDollars(p.setup) || ""}`);
    lines.push(`Colors: ${colorsText(p)}`);
    lines.push(tagLink(httpsUrl(p.url) || cta, { campaignId: ctx.campaignId, content: `pick-${slotLabel(i + 1)}-text` }));
    lines.push("");
  });
  lines.push(DISCLAIMER, "", `${d.ctaLabel || "search promo products"}: ${tagLink(cta, { campaignId: ctx.campaignId, content: "closing" })}`,
    "", "P&M Apparel | 515.984.7740 | info@pmapparel.com");
  return lines.join("\n");
}
