// lib/promopro/attachments.js — artwork as real email attachments.
//
// WHY ATTACH RATHER THAN LINK
// A vendor wants the file in the message, the way it arrived from
// QuickBooks for years. A link is one more click, it can be blocked by their
// mail filter, and a supplier who saves the email loses the artwork the day
// the link expires.
//
// WHAT IS GIVEN UP, SAID PLAINLY
// An attachment cannot be taken back. The signed links were revocable and
// expiring on purpose. Once a file is in a vendor's inbox it is there
// permanently, exactly as it was under the old process. That is Ryan's
// call, made deliberately, and it is why the file also STAYS in storage:
// the record on the purchase order is unaffected, and the links still work
// for anything too big to attach.
//
// THE SIZE PROBLEM, WHICH IS REAL
// Resend accepts a message of about 40 MB, and email attachments are base64
// encoded, which inflates a file by a third. So 20 MB of artwork becomes
// roughly 27 MB on the wire. One 20 MB file fits. Two do not.
//
// So there is a per-file limit AND a whole-message budget. Files are
// attached until the budget is used up, and anything that does not fit falls
// back to a signed link rather than being dropped. The email says which is
// which, because a vendor who cannot find the artwork will not go looking
// for a reason.
//
// ESM. Do NOT convert to module.exports.

import { artBlobOptions } from "./blob-token.js";

// One file may be this big. Matches the upload limit, so anything that can
// be attached to a purchase order can be attached to its email.
export const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

// And all attachments together may be this big BEFORE encoding. 25 MB raw is
// about 34 MB encoded, which leaves headroom under Resend's ceiling for the
// message itself.
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * Decide what gets attached and what gets a link, without reading anything.
 * Pure, so the rule is testable on its own.
 *
 * Returns { attach, link, reasons } where reasons explains each exclusion.
 */
export function planAttachments(art, opts) {
  const files = Array.isArray(art) ? art : [];
  const perFile = (opts && opts.maxFile) || MAX_ATTACH_BYTES;
  const budget = (opts && opts.maxTotal) || MAX_TOTAL_BYTES;

  const attach = [];
  const link = [];
  const reasons = {};
  let used = 0;

  // Smallest first. With a fixed budget this attaches the greatest number of
  // files, and it means one enormous file cannot push three small ones out.
  const ordered = files.slice().sort((a, b) => (Number(a.bytes) || 0) - (Number(b.bytes) || 0));

  ordered.forEach((f) => {
    const size = Number(f.bytes) || 0;

    if (size > perFile) {
      link.push(f);
      reasons[f.id] = `too large to attach (${mb(size)} MB), sent as a link`;
      return;
    }
    if (used + size > budget) {
      link.push(f);
      reasons[f.id] = "the message was already full, sent as a link";
      return;
    }
    attach.push(f);
    used += size;
  });

  return { attach, link, reasons, bytes: used };
}

function mb(n) {
  return (n / 1048576).toFixed(1);
}

/**
 * Pull the chosen files out of storage and encode them for Resend.
 *
 * A file that cannot be read is NOT a reason to abandon the send: the
 * purchase order still needs to reach the vendor. It moves to the link list
 * instead, with the reason recorded, so the email is honest about what
 * happened rather than silently short an attachment.
 */
export async function buildAttachments(art, opts) {
  const plan = planAttachments(art, opts);
  const attachments = [];
  const linked = plan.link.slice();
  const reasons = { ...plan.reasons };

  const { get } = await import("@vercel/blob");

  for (const f of plan.attach) {
    try {
      const result = await get(f.pathname || f.url, { ...artBlobOptions(), access: "private" });
      if (!result || !result.stream) throw new Error("storage returned nothing");
      const buf = Buffer.from(await new Response(result.stream).arrayBuffer());
      attachments.push({
        filename: f.filename || "artwork",
        content: buf.toString("base64"),
        content_type: f.contentType || "application/octet-stream",
      });
    } catch (e) {
      console.error("[promopro] could not attach", f.filename, e && e.message);
      linked.push(f);
      reasons[f.id] = "could not be attached, sent as a link";
    }
  }

  return { attachments, linked, reasons, attachedCount: attachments.length };
}
