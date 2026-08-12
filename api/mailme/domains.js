// api/mailme/domains.js — Resend sending-domain verification status.
//
// GET -> { warm: {name, status, region} | null, cold: {...} | null }
//
// Read-only status check, nothing configurable here. Exists so Ryan can see
// whether mail.pmapparel.com / outreach.pmapparel.com have finished
// verifying in Resend from inside MailMe Settings, instead of checking the
// Resend dashboard by hand every time DNS propagation is on his mind.
//
// Degrades quietly (all nulls) if RESEND_API_KEY isn't set yet or the
// Resend API call fails; this is a convenience status check, not something
// a send depends on. lib/mailme/send.js does its own live check right before
// dispatch regardless of what this route last reported.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { requireMailMe } from "../../lib/mailme/access.js";
import { domainStatus, resendConfigured } from "../../lib/mailme/resend-client.js";
import { SENDING_IDENTITIES } from "../../lib/mailme/schema.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;
  if (!(await requireMailMe(sess, res))) return;

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const configured = resendConfigured();
    if (!configured) {
      return res.status(200).json({
        configured: false,
        warm: null,
        cold: null,
      });
    }

    const [warm, cold] = await Promise.all([
      domainStatus(SENDING_IDENTITIES.warm.domain),
      domainStatus(SENDING_IDENTITIES.cold.domain),
    ]);

    return res.status(200).json({ configured: true, warm, cold });
  } catch (e) {
    console.error("mailme domains route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
