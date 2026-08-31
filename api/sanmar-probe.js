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

// Fields worth pulling out of each row. Everything else SanMar returns
// (keywords, the full description) is bulk we would never store, so the
// summary drops it rather than making the response unreadable.
const FIELDS = [
  "style", "color", "catalogColor", "size", "sizeIndex",
  "inventoryKey", "uniqueKey", "caseSize",
  "piecePrice", "casePrice", "pieceSalePrice", "caseSalePrice",
  "priceCode", "priceText", "mapPrice", "productStatus", "brandName",
  "saleStartDate", "saleEndDate",
  "colorProductImage", "colorSquareImage", "frontModel", "productImage",
];

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

// Deliberately not a real XML parser. This is a probe: it reads a flat
// response well enough to show what came back, and the raw XML is one query
// parameter away when it does not. The importer will not reuse this.
export function tagText(chunk, tag) {
  const m = chunk.match(new RegExp("<(?:\\w+:)?" + tag + "[^>]*>([\\s\\S]*?)</(?:\\w+:)?" + tag + ">"));
  return m ? m[1].trim() : "";
}

export function splitRows(xml) {
  const out = [];
  const re = /<productBasicInfo[^>]*>([\s\S]*?)<\/productBasicInfo>/g;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

export function summarise(xml) {
  const rows = splitRows(xml).map((chunk) => {
    const row = {};
    FIELDS.forEach((f) => {
      const v = tagText(chunk, f);
      if (v) row[f] = v;
    });
    return row;
  });

  const colors = [];
  const sizes = [];
  const priceByColor = {};
  rows.forEach((r) => {
    const c = r.color || r.catalogColor || "";
    const s = r.size || "";
    if (c && !colors.includes(c)) colors.push(c);
    if (s && !sizes.includes(s)) sizes.push(s);
    if (c && r.casePrice) {
      const key = c + " / " + (s || "?");
      priceByColor[key] = r.casePrice;
    }
  });

  // The whole point of the probe: do two colours of the same size ever carry
  // different case prices? If yes, the colour itself decides the price and the
  // importer never has to ask which price group a style is in.
  const bySize = {};
  rows.forEach((r) => {
    if (!r.size || !r.casePrice) return;
    bySize[r.size] = bySize[r.size] || {};
    bySize[r.size][r.casePrice] = (bySize[r.size][r.casePrice] || 0) + 1;
  });
  const sizesWithSplitPricing = Object.keys(bySize)
    .filter((s) => Object.keys(bySize[s]).length > 1);

  return {
    rowCount: rows.length,
    colorCount: colors.length,
    colors: colors.slice(0, 60),
    sizes,
    sizesWithSplitPricing,
    priceSpotCheck: priceByColor,
    firstRow: rows[0] || null,
    lastRow: rows.length > 1 ? rows[rows.length - 1] : null,
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
