// lib/promopro/qr.js — the QR code on a printed purchase order.
//
// WHAT IT IS FOR
// A printed PO travels round the shop. Whoever is holding the paper wants to
// know whether the vendor confirmed, what they said, or what is still
// outstanding. Without this the answer is: sign in, find PromoPro, and search
// a list for the number already in your hand. Same idea as ShopStock's shelf
// labels, and it uses the same deep-link shape the shell already routes:
//
//   https://<host>/#/promopro/orders/<poId>
//
// It carries the ID, not the contents. Anyone scanning it still has to sign
// in, so a sheet left on a bench gives nothing away.
//
// WHY A LIBRARY
// A QR encoder is Reed-Solomon error correction, mask evaluation and a
// version table. Hand-rolling one produces something that scans on the phone
// you tested with and fails on the one in the shop, and the failure is
// invisible until somebody is standing at a press. `qrcode` is pure
// JavaScript with no native build step, which is what makes it safe on
// Vercel.
//
// SERVER SIDE ONLY. The SVG is generated when the print page is built and
// inlined into it, so the printed sheet needs no network and no third party
// ever sees a PO number.
//
// ESM. Do NOT convert to module.exports.

/**
 * The staff deep link for one purchase order.
 *
 * `base` is the deployment the request arrived on, never a guess: a printed
 * code pointing at the wrong host is a code nobody can use.
 */
export function poDeepLink(base, poId) {
  const root = String(base || "").replace(/\/+$/, "");
  return `${root}/#/promopro/orders/${encodeURIComponent(String(poId || ""))}`;
}

/**
 * A QR code for that link, as an inline SVG string.
 *
 * Returns "" rather than throwing. A print page that fails to render because
 * a QR library had a bad moment is a worse outcome than a printed PO with no
 * square on it, and the page is the thing somebody actually needs.
 *
 * Error correction level M: about 15% of the code can be damaged and still
 * read, which is the level that survives a shop. Higher levels make the code
 * denser for no benefit at this size.
 */
export async function poQrSvg(base, poId) {
  const url = poDeepLink(base, poId);
  if (!poId) return "";
  try {
    const QRCode = (await import("qrcode")).default;
    return await QRCode.toString(url, {
      type: "svg",
      margin: 0,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch (e) {
    console.error("[promopro] could not build the QR code for", poId, e && e.message);
    return "";
  }
}
