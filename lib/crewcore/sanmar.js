// lib/crewcore/sanmar.js — SanMar product data and sample pricing.
//
// Everything here is pure except fetchStyle(), which makes the one network
// call. That split is deliberate: the arithmetic puts dollar figures on a
// document that goes to a vendor and on somebody's apparel stipend, so it has
// to be testable without a live SanMar account.
//
// Replaces the Master Pricelist upload. The old importer needed a CSV of
// 8,419 rows, worked MSRP down through a discount code, and still had to ask
// which colour group a style was in for about one style in seven. The web
// service returns the case price per colour and size directly, so the colour
// answers the price question by itself.
//
// WHAT THE FEED IS AND IS NOT
// It says what a style costs, what colours it comes in and what sizes those
// colours run. It does not say which styles are in this season's sample
// offer. That list comes off the back of SanMar's order form and always will,
// which is why a drop still starts with two pastes.
//
// ESM. Do NOT convert to module.exports.

const ENDPOINT =
  "https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort";

// ---- Tiers ----------------------------------------------------------------
//
// SanMar's New Arrivals sample offer runs twice a year at two discounts. The
// brand decides which. Matching is on a normalised brand name because the
// feed writes "Port & Co" where the order form writes "Port & Company", and
// an unrecognised brand must never be guessed into the cheaper tier.

export const TIER_50 = 50;
export const TIER_25 = 25;

const BRANDS_50 = [
  "port authority", "sport tek", "mercer mettle", "district", "port co",
  "cornerstone",
];

const BRANDS_25 = [
  "brooks brothers", "carhartt", "champion", "flexfit", "miir", "new era",
  "nike", "ogio", "the north face", "tommy bahama", "travismathew",
  "stanley stella",
];

/** Lowercase, strip punctuation and collapse spaces. "Port & Co." and
 *  "Port and Company" both land on something comparable. */
export function normBrand(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/\band\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bcompany\b/g, "co")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Which tier a brand sits in, or null when we do not recognise it.
 *
 * Null rather than a default on purpose. Defaulting an unknown brand to 50%
 * would quietly halve a price nobody checked, and the person picking would
 * have no way to know. An unrecognised brand is reported and the style is
 * imported at whatever tier its paste said, which is the human's answer.
 */
export function tierForBrand(brand) {
  const n = normBrand(brand);
  if (!n) return null;
  const hit = (list) => list.some((b) => n === b || n.startsWith(b + " ") || n.includes(b));
  if (hit(BRANDS_50)) return TIER_50;
  if (hit(BRANDS_25)) return TIER_25;
  return null;
}

// ---- The style lists ------------------------------------------------------

/**
 * Style numbers out of a pasted list. Handles the two shapes that actually
 * get pasted: a full line off the order form ("F180 Port Authority Therma-Tek
 * Fleece Jacket") and a bare style number.
 *
 * A style number is the first token, and SanMar's run from three characters
 * ("A4") to eight or more ("NF0A8JEV", "CT106432"), letters and digits mixed.
 * Duplicates collapse, because the same style appearing twice on a paste is a
 * transcription slip, not two products.
 */
export function parseStyleList(text, tier) {
  const seen = new Set();
  const out = [];
  String(text || "").split(/[\r\n]+/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const token = trimmed.split(/[\s,|\t]+/)[0].replace(/[^A-Za-z0-9-]/g, "");
    if (!token || token.length < 2 || !/[0-9]/.test(token)) return;
    const style = token.toUpperCase();
    if (seen.has(style)) return;
    seen.add(style);
    out.push({ style, tier: Number(tier), label: trimmed });
  });
  return out;
}

// ---- Sizes ----------------------------------------------------------------
//
// The feed is not consistent with itself. PC61 says "2XL", DT6105 says "XXL"
// for the same garment size. Anything that string-matches a size across two
// styles has to normalise first or it will treat them as different sizes and
// sort them into the wrong place on an order sheet.

const SIZE_ALIASES = {
  XXS: "2XS", XXXS: "3XS",
  XXL: "2XL", XXXL: "3XL", XXXXL: "4XL", XXXXXL: "5XL", XXXXXXL: "6XL",
};

const SIZE_ORDER = [
  "3XS", "2XS", "XS", "S", "M", "L", "XL",
  "2XL", "3XL", "4XL", "5XL", "6XL", "7XL",
];

export function normSize(size) {
  const raw = String(size || "").trim().toUpperCase().replace(/\s+/g, "");
  return SIZE_ALIASES[raw] || raw;
}

/** Sort key. Unknown sizes (waist/inseam, "OSFA") sort after the known ladder
 *  in their own alphabetical order rather than being dropped. */
export function sizeRank(size) {
  const i = SIZE_ORDER.indexOf(normSize(size));
  return i === -1 ? SIZE_ORDER.length : i;
}

export function sortSizes(sizes) {
  return [...sizes].sort((a, b) => {
    const d = sizeRank(a) - sizeRank(b);
    return d !== 0 ? d : String(a).localeCompare(String(b));
  });
}

// ---- Pricing --------------------------------------------------------------

/**
 * The sample price: the discount off SanMar's case price.
 *
 * Case price is what we pay, so a 50% sample is half of our cost, not half of
 * MSRP. The feed also carries the same price code the pricelist did ("A/P"),
 * and case price divided by that code reproduces MSRP, which is how this was
 * checked against the pricelist rather than assumed.
 *
 * Done in whole cents. Half of $11.37 is $5.685, and floating point will
 * happily make that 5.684999999999999 or 5.685000000000001 depending on the
 * route it took. Integer cents give the same answer every time, and the
 * remainder is DROPPED, not rounded: $5.68, matching what SanMar invoices.
 *
 * REGULAR PRICE ONLY. A style on sale during the picking window would price
 * the drop off a discount that expires before the order ships. Ryan's call,
 * Aug 2026. saleCasePrice is carried on the row for display, never for maths.
 */
export function samplePrice(casePrice, tierPct) {
  const price = Number(casePrice);
  const pct = Number(tierPct);
  if (!Number.isFinite(price) || price <= 0) return null;
  // A tier of zero is refused rather than treated as "no discount". A missing
  // tier reaching here means something upstream lost it, and passing the full
  // case price through as the sample price would look like a working number.
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
  const cents = Math.round(price * 100);
  return Math.floor((cents * (100 - pct)) / 100) / 100;
}

/** MSRP implied by the price code, used only to cross-check the feed against
 *  the pricelist we already validated. "A/P" and "A" both mean 50% off. */
const CODE_DISCOUNT = { A: 50, P: 50, B: 45, Q: 45, C: 40, R: 40, D: 35, S: 35, E: 30, T: 30 };

export function impliedMsrp(casePrice, priceCode) {
  const price = Number(casePrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const halves = String(priceCode || "").toUpperCase().split("/").filter(Boolean);
  if (!halves.length) return null;
  const pcts = halves.map((h) => CODE_DISCOUNT[h]);
  // Both halves of the code must agree. They always have; if they ever stop,
  // that is a fact worth surfacing rather than picking one and moving on.
  if (pcts.some((p) => p === undefined)) return null;
  if (pcts.some((p) => p !== pcts[0])) return null;
  return Math.round((price / ((100 - pcts[0]) / 100)) * 100) / 100;
}

// ---- Reading the response -------------------------------------------------

function decode(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every leaf element in a chunk as { tag: value }. Tight tag boundaries: a
 *  loose matcher reads <sizeIndex> when asked for <size>, and reading the
 *  field beside the one you asked for is worse than reading nothing. */
export function leafFields(chunk) {
  const out = {};
  const re = /<(\w+)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(chunk)) !== null) {
    const v = decode(m[2]);
    if (v && out[m[1]] === undefined) out[m[1]] = v;
  }
  return out;
}

/**
 * One entry per product. SanMar returns three sibling blocks per item inside
 * a <listResponse>: basic info, images and pricing. Chunking on the basic
 * block alone silently drops every price and every image.
 */
export function splitRows(xml) {
  const out = [];
  let re = /<listResponse[^>]*>([\s\S]*?)<\/listResponse>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  if (out.length) return out;
  re = /<productBasicInfo[^>]*>([\s\S]*?)<\/productBasicInfo>/g;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

export function envelopeField(xml, tag) {
  const m = String(xml).match(new RegExp(
    "<(?:\\w+:)?" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?" + tag + ">"));
  return m ? decode(m[1]) : "";
}

/**
 * Build one style's catalog entry from a raw response.
 *
 * Grouped by colour, with a size run under each, because that is the order a
 * person picks in: they choose the shirt, then the colour, then their size.
 *
 * THE INVENTORY KEY AND SIZE INDEX ARE CARRIED VERBATIM, never derived. The
 * feed uses two different indexing schemes, sometimes inside one style: PC61
 * returns size S as both index 2 and index 1 depending on the row, and
 * DT6105 returns 1 for every size. A purchase order is keyed on the
 * inventoryKey and sizeIndex pair, so anything that computes an index from a
 * size name would order the wrong garment and look right doing it.
 */
export function buildStyle(xml, { style, tier }) {
  const rows = splitRows(xml).map(leafFields).filter((r) => r.style || r.color);
  if (!rows.length) return null;

  const first = rows[0];
  const colors = new Map();
  let onSale = false;

  rows.forEach((r) => {
    const name = r.color || r.catalogColor;
    if (!name || !r.size) return;
    if (r.caseSalePrice || r.saleStartDate) onSale = true;

    if (!colors.has(name)) {
      colors.set(name, {
        name,
        code: r.catalogColor || "",        // what an order has to carry
        swatch: r.colorSquareImage || "",
        image: r.colorProductImage || r.frontModel || "",
        sizes: [],
      });
    }
    const c = colors.get(name);
    const size = normSize(r.size);
    if (c.sizes.some((s) => s.size === size)) return; // duplicate row, keep the first
    const casePrice = Number(r.casePrice);
    c.sizes.push({
      size,
      raw_size: r.size,                    // what the feed calls it, for the export
      size_index: r.sizeIndex || "",
      inventory_key: r.inventoryKey || "",
      unique_key: r.uniqueKey || "",
      case_size: r.caseSize || "",
      case_price: Number.isFinite(casePrice) ? casePrice : null,
      sale_case_price: r.caseSalePrice ? Number(r.caseSalePrice) : null,
      price: samplePrice(casePrice, tier),
      price_code: r.priceCode || "",
    });
  });

  const colorList = [...colors.values()];
  colorList.forEach((c) => { c.sizes = c.sizes.sort((a, b) => sizeRank(a.size) - sizeRank(b.size)); });

  const prices = colorList.flatMap((c) => c.sizes.map((s) => s.price)).filter((p) => p != null);
  const sizes = sortSizes([...new Set(colorList.flatMap((c) => c.sizes.map((s) => s.size)))]);

  return {
    style: String(style).toUpperCase(),
    tier: Number(tier),
    brand: first.brandName || "",
    title: first.productTitle || "",
    category: first.category || "",
    image: first.productImage || first.frontModel || "",
    spec_sheet: first.specSheet || "",
    status: first.productStatus || "",
    price_code: first.priceCode || "",
    implied_msrp: impliedMsrp(first.casePrice, first.priceCode),
    on_sale: onSale,
    colors: colorList,
    // Summary fields, copied onto the drop's index so the catalog list can
    // render without loading every style's colours.
    summary: {
      style: String(style).toUpperCase(),
      tier: Number(tier),
      brand: first.brandName || "",
      title: first.productTitle || "",
      image: first.productImage || first.frontModel || "",
      color_count: colorList.length,
      sizes,
      from_price: prices.length ? Math.min(...prices) : null,
      to_price: prices.length ? Math.max(...prices) : null,
      // Two colours of one size at different prices. PC61 does this: White
      // and Natural are cheaper than the other 60 colours at every size. The
      // catalog does not have to resolve it, because each colour carries its
      // own price, but the screen says "from" rather than a flat figure.
      split_pricing: prices.length ? Math.min(...prices) !== Math.max(...prices) : false,
      on_sale: onSale,
    },
  };
}

// ---- The one network call -------------------------------------------------

export function buildEnvelope({ style, customerNumber, user, password }) {
  const esc = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' xmlns:impl="http://impl.webservice.integration.sanmar.com/">' +
    "<soapenv:Header/><soapenv:Body>" +
    "<impl:getProductInfoByStyleColorSize><arg0>" +
    "<style>" + esc(style) + "</style>" +
    "</arg0><arg1>" +
    "<sanMarCustomerNumber>" + esc(customerNumber) + "</sanMarCustomerNumber>" +
    "<sanMarUserName>" + esc(user) + "</sanMarUserName>" +
    "<sanMarUserPassword>" + esc(password) + "</sanMarUserPassword>" +
    "</arg1></impl:getProductInfoByStyleColorSize>" +
    "</soapenv:Body></soapenv:Envelope>";
}

export function credentials(env = process.env) {
  return {
    customerNumber: env.SANMAR_CUSTOMER_NUMBER || "",
    user: env.SANMAR_WS_USER || "",
    password: env.SANMAR_WS_PASSWORD || "",
  };
}

export function missingCredentials(creds) {
  const missing = [];
  if (!creds.customerNumber) missing.push("SANMAR_CUSTOMER_NUMBER");
  if (!creds.user) missing.push("SANMAR_WS_USER");
  if (!creds.password) missing.push("SANMAR_WS_PASSWORD");
  return missing;
}

/**
 * Fetch and build one style. Never throws: an import of 138 styles must not
 * lose 137 of them because one was retired. A failure comes back as
 * { ok:false, error } and the importer records it against that style.
 *
 * The error MESSAGE is returned, never the error object, because a fetch
 * error can carry the request and the request carries the password.
 */
export async function fetchStyle(style, { tier, creds, fetchImpl = fetch, timeoutMs = 20000 }) {
  const missing = missingCredentials(creds);
  if (missing.length) return { ok: false, style, error: "Missing " + missing.join(", ") };

  let xml = "";
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
      body: buildEnvelope({ style, ...creds }),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!r.ok) return { ok: false, style, error: "SanMar answered " + r.status };
    xml = await r.text();
  } catch (e) {
    return { ok: false, style, error: String(e && e.message ? e.message : e) };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (envelopeField(xml, "errorOccured") === "true" || /<(?:\w+:)?Fault[\s>]/.test(xml)) {
    return { ok: false, style, error: envelopeField(xml, "message") || "SanMar returned an error" };
  }

  const built = buildStyle(xml, { style, tier });
  if (!built) return { ok: false, style, error: "No products came back for this style" };
  return { ok: true, style, record: built };
}
