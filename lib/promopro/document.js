// PUT IN: lib/promopro/document.js
// lib/promopro/document.js — the purchase order as a document.
//
// ONE renderer for both the printed page and the emailed copy. They are the
// same document and must not drift: a vendor who prints the attachment and a
// vendor who reads the email have to be looking at identical numbers. Two
// templates would disagree eventually, and nobody would notice until a
// supplier invoiced against the wrong one.
//
// Plain HTML with inline styles, no external CSS. Email clients strip
// stylesheets, and a print window has nothing to link to. This is the one
// place in the repo where hex colours are unavoidable, hence TOKEN-EXEMPT.
//
// ESM. Do NOT convert to module.exports.

import { poTotal, lineTotal, docLabels } from "./schema.js";

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function money(n) {
  return "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* TOKEN-EXEMPT: an email client cannot resolve a CSS variable, and a print
   window has no stylesheet. These have to be literal. */
const INK = "#1A1A1A";
const MUTED = "#6B6B6B";
const LINE = "#DDDDDD";
const ACCENT = "#E31E2D";

/**
 * Artwork rows, with the link the VENDOR should use.
 *
 * The caller passes `opts.artUrls`, a map of file id to absolute signed URL,
 * because minting a signed link needs the secret and the settings and this
 * file is a renderer, not a route. A file with no entry in that map falls
 * back to nothing rather than to the raw blob URL: emailing the unsigned URL
 * is exactly the leak the signed links exist to close, so a missing link is
 * the safe failure.
 */
function artLinks(po, o) {
  const map = (o && o.artUrls) || {};
  return (Array.isArray(po.art) ? po.art : [])
    .map((a) => ({ ...a, link: map[a.id] || "" }))
    .filter((a) => a.link);
}

/**
 * The document body. `opts.brand` carries the shop's own details so they are
 * not hardcoded here: a PO from Flyover Con should not say P&M Apparel.
 */
export function renderPoHtml(po, vendor, opts) {
  const o = opts || {};
  const brand = o.brand || {};
  const lines = Array.isArray(po.lines) ? po.lines : [];
  const art = artLinks(po, o);
  // Filenames of anything riding in the message itself. The list is named in
  // the body as well as being attached, because an attachment stripped by a
  // vendor's mail filter is otherwise invisible to both sides.
  const attached = Array.isArray(o.attached) ? o.attached : [];

  const row = (l) =>
    `<tr>
      <td style="padding:8px 6px;border-bottom:1px solid ${LINE};vertical-align:top">${esc(l.itemNumber || "")}</td>
      <td style="padding:8px 6px;border-bottom:1px solid ${LINE};vertical-align:top">
        ${esc(l.description)}
        ${l.imprint ? `<div style="color:${MUTED};font-size:12px;margin-top:2px">${esc(l.imprint)}</div>` : ""}
      </td>
      <td style="padding:8px 6px;border-bottom:1px solid ${LINE};vertical-align:top">${esc(l.detail || "")}</td>
      <td style="padding:8px 6px;border-bottom:1px solid ${LINE};text-align:right;vertical-align:top">${esc(l.qty)}</td>
      <td style="padding:8px 6px;border-bottom:1px solid ${LINE};text-align:right;vertical-align:top">${money(l.unitCost)}</td>
      <td style="padding:8px 6px;border-bottom:1px solid ${LINE};text-align:right;vertical-align:top">${money(lineTotal(l))}</td>
    </tr>`;

  // THE LOGO, AND WHY IT IS BUILT LIKE THIS
  //
  // A hosted PNG, not an SVG and not an embedded data URI. Gmail strips SVG
  // outright and most clients drop data URIs, so either would show a broken
  // image to the one audience that matters here, which is a supplier's
  // Outlook. A PNG on our own domain is the only shape that renders
  // everywhere.
  //
  // width and height are set as HTML ATTRIBUTES as well as in the style,
  // because Outlook ignores CSS sizing on images and would otherwise draw it
  // at its full 400 pixels across the top of the order.
  //
  // The alt text is the brand name, so a client with images turned off shows
  // "P&M Apparel" where the mark would have been rather than a broken icon.
  // The name is also still printed underneath it: the PO must read correctly
  // with every image blocked, which is the default in plenty of corporate
  // inboxes.

  // WHOSE JOB THIS IS, printed under the PO number.
  //
  // The vendor is the one reading this, and they are frequently shipping
  // direct or labelling cartons, so "which customer is this for" is a real
  // question the document should answer rather than one that costs a phone
  // call. It is the COMPANY, never the buyer's personal name: customerName is
  // kept as a fallback only for orders raised before the two were separated.
  //
  // Blank on a manual order with no Printavo link, deliberately. An empty line
  // is better than the words "Manual order" printed at a vendor.
  const forCompany = (po.printavo && (po.printavo.companyName || po.printavo.customerName)) || "";

  const logo = o.logoUrl
    ? `<img src="${esc(o.logoUrl)}" alt="${esc(brand.name || "P&M Apparel")}" ` +
      `width="92" height="92" style="display:block;width:92px;height:92px;border:0;margin-bottom:10px">`
    : "";

  return `<div style="font-family:Helvetica,Arial,sans-serif;color:${INK};font-size:14px;line-height:1.45;max-width:720px">

  <table width="100%" style="border-collapse:collapse;margin-bottom:18px">
    <tr>
      <td style="vertical-align:top">
        ${logo}
        <div style="font-size:20px;font-weight:bold">${esc(brand.name || "P&M Apparel")}</div>
        <div style="color:${MUTED};font-size:12px">${esc(brand.address || "")}</div>
        <div style="color:${MUTED};font-size:12px">${esc(brand.phone || "")}</div>
      </td>
      <td style="vertical-align:top;text-align:right">
        <div style="font-size:12px;color:${MUTED};letter-spacing:.05em">${esc(docLabels(po).title)}</div>
        <div style="font-size:22px;font-weight:bold;color:${ACCENT}">${esc(po.poNumber || "")}</div>
        ${forCompany ? `<div style="font-size:13px;font-weight:bold;margin-top:2px">${esc(forCompany)}</div>` : ""}
        <div style="color:${MUTED};font-size:12px">${esc(String(po.createdAt || "").slice(0, 10))}</div>
      </td>
    </tr>
  </table>

  <table width="100%" style="border-collapse:collapse;margin-bottom:16px;font-size:13px">
    <tr>
      <td style="vertical-align:top;width:50%;padding-right:12px">
        <div style="color:${MUTED};font-size:11px;letter-spacing:.05em">VENDOR</div>
        <div style="font-weight:bold">${esc(vendor && vendor.name ? vendor.name : "")}</div>
        <div style="color:${MUTED}">${esc(vendor && vendor.email ? vendor.email : "")}</div>
        ${vendor && vendor.terms ? `<div style="color:${MUTED}">Terms: ${esc(vendor.terms)}</div>` : ""}
      </td>
      <td style="vertical-align:top;width:50%">
        <div style="color:${MUTED};font-size:11px;letter-spacing:.05em">SHIP TO</div>
        <div>${esc(po.shipTo || "")}</div>
        ${po.shippingInstructions ? `<div style="color:${MUTED};margin-top:4px">${esc(po.shippingInstructions)}</div>` : ""}
      </td>
    </tr>
  </table>

  ${po.neededBy ? `<div style="margin-bottom:12px;font-size:13px"><strong>Needed by:</strong> ${esc(po.neededBy)}</div>` : ""}

  <table width="100%" style="border-collapse:collapse;font-size:13px">
    <thead>
      <tr>
        <th style="text-align:left;padding:6px;border-bottom:2px solid ${INK};font-size:11px;letter-spacing:.04em">ITEM #</th>
        <th style="text-align:left;padding:6px;border-bottom:2px solid ${INK};font-size:11px;letter-spacing:.04em">DESCRIPTION</th>
        <th style="text-align:left;padding:6px;border-bottom:2px solid ${INK};font-size:11px;letter-spacing:.04em">DETAIL</th>
        <th style="text-align:right;padding:6px;border-bottom:2px solid ${INK};font-size:11px;letter-spacing:.04em">QTY</th>
        <th style="text-align:right;padding:6px;border-bottom:2px solid ${INK};font-size:11px;letter-spacing:.04em">COST</th>
        <th style="text-align:right;padding:6px;border-bottom:2px solid ${INK};font-size:11px;letter-spacing:.04em">TOTAL</th>
      </tr>
    </thead>
    <tbody>${lines.map(row).join("")}</tbody>
    <tfoot>
      <tr>
        <td colspan="5" style="padding:10px 6px;text-align:right;font-weight:bold">Total</td>
        <td style="padding:10px 6px;text-align:right;font-weight:bold">${money(poTotal(po))}</td>
      </tr>
    </tfoot>
  </table>

  ${po.notes ? `<div style="margin-top:16px;font-size:13px"><strong>Notes</strong><div style="color:${MUTED}">${esc(po.notes)}</div></div>` : ""}

  ${(attached.length || art.length) ? `
  <div style="margin-top:18px;font-size:13px">
    <strong>Artwork</strong>
    ${attached.length ? `
    <div style="color:${MUTED};font-size:12px">${
      attached.length === 1 ? "Attached to this email:" : `${attached.length} files attached to this email:`
    }</div>
    <ul style="margin:6px 0 0 18px;padding:0">
      ${attached.map((f) => `<li style="margin-bottom:3px">${esc(f)}</li>`).join("")}
    </ul>` : ""}
    ${art.length ? `
    <div style="color:${MUTED};font-size:12px;margin-top:${attached.length ? "8px" : "0"}">${
      attached.length
        ? "Too large to attach, so these are links instead."
        : "Open these links to download. No sign-in needed."
    }${o.artExpiryNote ? ` ${esc(o.artExpiryNote)}` : ""}</div>
    <ul style="margin:6px 0 0 18px;padding:0">
      ${art.map((a) => `<li style="margin-bottom:3px"><a href="${esc(a.link)}" style="color:${ACCENT}">${esc(a.filename)}</a>${
        // Why this one is a link when others are attached. A vendor who
        // cannot find a file will not go looking for the reason.
        o.artReasons && o.artReasons[a.id] ? `<span style="color:${MUTED};font-size:12px"> (${esc(o.artReasons[a.id])})</span>` : ""
      }</li>`).join("")}
    </ul>` : ""}
  </div>` : ""}

</div>`;
}

/**
 * A standalone page for printing. The browser's print dialog turns this into
 * a PDF, which is why there is no PDF library in this repo: it would be a
 * second dependency to do a job the browser already does, and it would then
 * need its own layout kept in step with this one.
 */
export function renderPrintPage(po, vendor, opts) {
  const o = opts || {};

  // THE QR CODE IS FOR US, NOT THE VENDOR.
  //
  // A printed PO travels round the shop. Whoever is holding it wants to know
  // whether the vendor confirmed, what they said, or what is still
  // outstanding, and the alternative to a scan is signing in, finding
  // PromoPro and searching a list for the number already in their hand. It
  // points at the order inside the app, behind the same login as everything
  // else, so a sheet left on a bench gives nothing away.
  //
  // The SVG is passed IN rather than generated here, because this file
  // renders the emailed copy as well and must not drag a QR dependency into
  // every send.
  const qr = o.qrSvg
    ? `<div style="margin-top:26px;font-family:Helvetica,Arial,sans-serif;text-align:right">
  <div style="display:inline-block;text-align:center">
    <div style="width:100px;height:100px;margin:0 auto">${o.qrSvg}</div>
    <div style="font-size:10px;color:#6b7280;margin-top:4px">Scan to open ${esc(po.poNumber || "this order")}</div>
  </div>
</div>`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>${esc(po.poNumber || docLabels(po).title)}</title>
<style>
  @page { margin: 18mm; }
  body { margin: 0; padding: 24px; }
  @media print { body { padding: 0; } .noprint { display: none; } }
</style>
</head><body>
<div class="noprint" style="margin-bottom:16px;font-family:Helvetica,Arial,sans-serif">
  <button onclick="window.print()" style="background:${ACCENT};color:#fff;border:0;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:bold;cursor:pointer">Print or save as PDF</button>
</div>
${renderPoHtml(po, vendor, opts)}
${qr}
</body></html>`;
}

/**
 * The covering note, mirroring what QuickBooks has been sending so vendors
 * see something familiar rather than a new format arriving out of nowhere.
 */
export function renderEmailHtml(po, vendor, opts) {
  const o = opts || {};
  const sender = o.sender || {};
  const art = Array.isArray(po.art) ? po.art : [];

  return `<div style="font-family:Helvetica,Arial,sans-serif;color:${INK};font-size:14px;line-height:1.5">
  <p>To: ${esc((vendor && vendor.name) || "")}</p>
  <p>Hello!<br>Please find our purchase order below.</p>
  ${art.length
    ? `<p>The artwork is linked at the bottom of the order.</p>`
    : ""}
  <p>Please confirm order receipt and let us know if anything further is needed.</p>
  <p>Thank you!</p>
  <p>
    ${esc(sender.name || "")}<br>
    ${esc(o.brand && o.brand.name ? o.brand.name : "P&M Apparel")}<br>
    ${sender.email ? `<a href="mailto:${esc(sender.email)}" style="color:${ACCENT}">${esc(sender.email)}</a><br>` : ""}
    ${esc((o.brand && o.brand.phone) || "")}
  </p>
  <hr style="border:0;border-top:1px solid ${LINE};margin:20px 0">
  ${renderPoHtml(po, vendor, opts)}
</div>`;
}

/** Plain-text fallback. Some vendor systems strip HTML entirely. */
export function renderEmailText(po, vendor, opts) {
  const o = opts || {};
  const lines = Array.isArray(po.lines) ? po.lines : [];
  const art = artLinks(po, o);
  const out = [];

  out.push(`To: ${(vendor && vendor.name) || ""}`);
  out.push("");
  out.push("Hello!");
  out.push("Please find our purchase order below.");
  out.push("");
  out.push("Please confirm order receipt and let us know if anything further is needed.");
  out.push("");
  out.push("Thank you!");
  out.push("");
  out.push(`${(o.sender && o.sender.name) || ""}`);
  out.push(`${(o.brand && o.brand.name) || "P&M Apparel"}`);
  if (o.sender && o.sender.email) out.push(o.sender.email);
  out.push("");
  out.push("------------------------ Purchase Order Summary ------------------------");
  out.push(`${docLabels(po).numberLabel} : ${po.poNumber || ""}`);
  // Same line as the printed copy. Plenty of vendors read the text part, and
  // a summary that answers a different set of questions than the page is how
  // the two drift.
  const forText = (po.printavo && (po.printavo.companyName || po.printavo.customerName)) || "";
  if (forText) out.push(`For: ${forText}`);
  out.push(`Purchase Order Date: ${String(po.createdAt || "").slice(0, 10)}`);
  if (po.neededBy) out.push(`Needed by: ${po.neededBy}`);
  out.push("");
  lines.forEach((l) => {
    out.push(`${l.itemNumber ? l.itemNumber + "  " : ""}${l.description}`);
    if (l.imprint) out.push(`  ${l.imprint}`);
    out.push(`  ${l.qty} x ${money(l.unitCost)} = ${money(lineTotal(l))}`);
  });
  out.push("");
  out.push(`Total: ${money(poTotal(po))}`);
  out.push("");
  out.push(`Ship to: ${po.shipTo || ""}`);
  if (po.shippingInstructions) out.push(po.shippingInstructions);
  const attachedText = Array.isArray(o.attached) ? o.attached : [];
  if (attachedText.length) {
    out.push("");
    out.push("Artwork attached to this email:");
    attachedText.forEach((f) => out.push(`  ${f}`));
  }
  if (art.length) {
    out.push("");
    out.push(attachedText.length ? "Artwork too large to attach, links instead:" : "Artwork:");
    art.forEach((a) => out.push(`  ${a.filename}  ${a.link}`));
  }
  out.push("------------------------------------------------------------------------");

  return out.join("\n");
}
