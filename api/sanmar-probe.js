// api/sanmar-probe.js — TEMPORARY DIAGNOSTIC ROUTE. Delete once the SanMar
// importer is built and verified.
//
// Same purpose as the Printavo schema probe: before writing an importer, look
// at what the vendor actually sends back rather than at what their PDF says
// they send back. This route makes ONE read-only SOAP call to SanMar's
// standard product information service and returns the answer.
//
// It writes nothing. No KV, no blob, no state. Calling it twice is the same
// as calling it once.
//
// SUPERUSER ONLY. This route carries SanMar credentials on behalf of the
// caller, and SanMar's integration agreement is internal-use-only, so it is
// gated on the account flag rather than on a role checkbox. Same isBuilder()
// shape as api/sitework.js.
//
// USE
//   /api/sanmar-probe?style=PC61                 every colour and size
//   /api/sanmar-probe?style=PC61&color=White     one colour
//   /api/sanmar-probe?style=DT6105&raw=1         include the raw XML
//
// DT6105 is the style worth looking at first: it is the one that showed two
// different prices on the Fall 2025 sheet, because SanMar prices some colour
// groups differently. If the per-colour rows here carry different casePrice
// values, the colour-group question the samples importer currently has to ask
// answers itself.
//
// ENV
//   SANMAR_CUSTOMER_NUMBER   SanMar account number
//   SANMAR_WS_USER           sanmar.com username (NOT the FTP user)
//   SANMAR_WS_PASSWORD       sanmar.com password
//
// The FTP credentials are a different pair and will not authenticate here.
// SanMar's own guide says so in red: the sanmar.com login works for the APIs,
// the customer number and FTP password work for the file server.

import { requireAuth } from "../lib/session.js";
import { getUser } from "../lib/users.js";

const ENDPOINT =
  "https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort";

const MAX_RAW = 40000; // enough to read the shape, not enough to flood a screen

async function isBuilder(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  return !!(user && user.superuser === true);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildEnvelope({ style, color, size, customerNumber, user, password }) {
  const arg0 = [
    "<style>" + xmlEscape(style) + "</style>",
    color ? "<color>" + xmlEscape(color) + "</color>" : "",
    size ? "<size>" + xmlEscape(size) + "</size>" : "",
  ].filter(Boolean).join("");

  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' xmlns:impl="http://impl.webservice.integration.sanmar.com/">' +
    "<soapenv:Header/><soapenv:Body>" +
    "<impl:getProductInfoByStyleColorSize>" +
    "<arg0>" + arg0 + "</arg0>" +
    "<arg1>" +
    "<sanMarCustomerNumber>" + xmlEscape(customerNumber) + "</sanMarCustomerNumber>" +
    "<sanMarUserName>" + xmlEscape(user) + "</sanMarUserName>" +
    "<sanMarUserPassword>" + xmlEscape(password) + "</sanMarUserPassword>" +
    "</arg1>" +
    "</impl:getProductInfoByStyleColorSize>" +
    "</soapenv:Body></soapenv:Envelope>";
}

// Deliberately not a real XML parser. This is a probe: it reads the response
// well enough to show what came back, and the raw XML is one query parameter
// away when it does not. The importer will not reuse this.
//
// AUG 31 FIX: the first version chunked on <productBasicInfo> and so read only
// a third of each item. SanMar returns THREE sibling blocks per item, and the
// pricing and the images are in the other two:
//
//   <listResponse>
//     <productBasicInfo>  style, colour, size, keys, status
//     <productImageInfo>  every image URL
//     <productPriceInfo>  casePrice, piecePrice, priceCode, MAP, sale dates
//   </listResponse>
//
// The tag matcher was also too loose: "size" would match <sizeIndex> and
// "color" would match <colorSquareImage>, because it allowed any characters
// after the tag name. It now requires a "<tag>" or a "<tag attr=...>", which
// is the difference between reading a field and reading the field next to it.

/** One envelope-level field, e.g. errorOccured. Tight tag boundary: "size"
 *  must not match <sizeIndex>. */
export function tagText(chunk, tag) {
  const m = chunk.match(new RegExp(
    "<(?:\\w+:)?" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?" + tag + ">"));
  return m ? m[1].trim() : "";
}

function decode(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&") // last, so &amp;lt; does not become <
    .replace(/\s+/g, " ")
    .trim();
}

/** Every leaf element in a chunk, as { tag: value }. A leaf is an element with
 *  no child elements, which is every field SanMar returns. */
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

/** One entry per product returned. Chunks on <listResponse>, which wraps all
 *  three blocks for a single style/colour/size. Falls back to the basic block
 *  alone if the response is shaped differently than documented, so a surprise
 *  shows up as thin rows rather than as zero rows. */
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

export function summarise(xml) {
  const rows = splitRows(xml).map(leafFields);

  // What fields actually came back, and on how many rows. This is the part
  // that tells us what an importer can rely on: a field present on 12 of 558
  // rows is not a field to build on.
  const fieldCounts = {};
  rows.forEach((r) => {
    Object.keys(r).forEach((k) => { fieldCounts[k] = (fieldCounts[k] || 0) + 1; });
  });

  const colors = [];
  const sizes = [];
  const sizeIndexBySize = {};
  rows.forEach((r) => {
    const c = r.color || r.catalogColor || "";
    if (c && !colors.includes(c)) colors.push(c);
    if (r.size && !sizes.includes(r.size)) sizes.push(r.size);
    if (r.size && r.sizeIndex) {
      sizeIndexBySize[r.size] = sizeIndexBySize[r.size] || [];
      if (!sizeIndexBySize[r.size].includes(r.sizeIndex)) {
        sizeIndexBySize[r.size].push(r.sizeIndex);
      }
    }
  });

  // The question the probe exists to answer: within one size, do two colours
  // ever carry different case prices? If yes, the colour decides the price and
  // the importer never has to ask which price group a style is in.
  const bySize = {};
  rows.forEach((r) => {
    if (!r.size || !r.casePrice) return;
    bySize[r.size] = bySize[r.size] || {};
    (bySize[r.size][r.casePrice] = bySize[r.size][r.casePrice] || []).push(
      r.color || r.catalogColor || "?");
  });
  const sizesWithSplitPricing = {};
  Object.keys(bySize).forEach((sz) => {
    const prices = Object.keys(bySize[sz]);
    if (prices.length > 1) {
      sizesWithSplitPricing[sz] = {};
      prices.forEach((p) => {
        sizesWithSplitPricing[sz][p] = {
          colors: bySize[sz][p].length,
          example: bySize[sz][p].slice(0, 4),
        };
      });
    }
  });

  // Price by size at one colour, which is the shape the samples sheet needs:
  // 2XL and up are separate rows at their own price.
  const firstColor = rows.length ? (rows[0].color || rows[0].catalogColor) : null;
  const priceLadder = {};
  rows.forEach((r) => {
    if ((r.color || r.catalogColor) !== firstColor || !r.size) return;
    priceLadder[r.size] = {
      casePrice: r.casePrice || null,
      piecePrice: r.piecePrice || null,
      priceCode: r.priceCode || null,
      priceText: r.priceText || null,
    };
  });

  // Any price actually on sale right now. A sample priced off a temporary sale
  // would come back cheaper than the sheet SanMar is expecting.
  const onSale = rows.filter((r) => r.saleStartDate || r.caseSalePrice).length;

  return {
    rowCount: rows.length,
    fieldsSeen: Object.keys(fieldCounts).sort().map((k) => k + ":" + fieldCounts[k]),
    colorCount: colors.length,
    colors: colors.slice(0, 80),
    sizes,
    sizeIndexBySize,
    priceLadderAt: firstColor,
    priceLadder,
    sizesWithSplitPricing,
    rowsWithSalePricing: onSale,
    // Whether the split-pricing answer means anything at all. Without a price
    // on the rows, an empty result is silence, not a clean bill of health.
    pricingPresent: rows.some((r) => !!r.casePrice),
    firstRow: rows[0] || null,
  };
}

export default async function handler(req, res) {
  const sess = requireAuth(req, res);
  if (!sess) return;
  if (!(await isBuilder(sess))) {
    return res.status(403).json({ error: "Admin only" });
  }

  const customerNumber = process.env.SANMAR_CUSTOMER_NUMBER || "";
  const user = process.env.SANMAR_WS_USER || "";
  const password = process.env.SANMAR_WS_PASSWORD || "";

  const missing = [];
  if (!customerNumber) missing.push("SANMAR_CUSTOMER_NUMBER");
  if (!user) missing.push("SANMAR_WS_USER");
  if (!password) missing.push("SANMAR_WS_PASSWORD");
  if (missing.length) {
    return res.status(200).json({
      ok: false,
      configured: false,
      missing,
      note: "Set these in Vercel, redeploy, then call this again. SANMAR_WS_USER is the sanmar.com login, not the FTP user.",
    });
  }

  const q = req.query || {};
  const style = String(q.style || "PC61").trim();
  const color = String(q.color || "").trim();
  const size = String(q.size || "").trim();
  const wantRaw = String(q.raw || "") === "1";

  const started = Date.now();
  let status = 0;
  let xml = "";
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
      body: buildEnvelope({ style, color, size, customerNumber, user, password }),
    });
    status = r.status;
    xml = await r.text();
  } catch (e) {
    return res.status(200).json({
      ok: false,
      configured: true,
      style,
      reached: false,
      // The message, not the error object: an error object from fetch can
      // carry the request in it, and the request carries the password.
      error: String(e && e.message ? e.message : e),
      ms: Date.now() - started,
    });
  }

  const errorOccured = tagText(xml, "errorOccured") || tagText(xml, "errorOccurred");
  const message = tagText(xml, "message");
  const fault = /<(?:\w+:)?Fault[\s>]/.test(xml);

  const body = {
    ok: status === 200 && errorOccured !== "true" && !fault,
    configured: true,
    reached: true,
    httpStatus: status,
    ms: Date.now() - started,
    query: { style, color: color || null, size: size || null },
    errorOccured: errorOccured || null,
    message: message || null,
    soapFault: fault,
    bytes: xml.length,
    summary: summarise(xml),
  };

  if (wantRaw) {
    body.raw = xml.slice(0, MAX_RAW);
    body.rawTruncated = xml.length > MAX_RAW;
  }

  return res.status(200).json(body);
}
