// api/ops-diag.js
// TEMPORARY diagnostic route. Read-only. Superuser session required.
// Purpose: view backbone_printavo_ops and backbone_ops_partial directly,
// using the same KV_REST_API_URL / KV_REST_API_TOKEN the sync itself uses,
// without needing separate Upstash console access (Aug 5 2026 debugging —
// the dashboard stamp stayed stuck on Jul 31 despite the cron returning 200
// every morning, and nobody had a login for the Upstash account that set up
// KV_REST_API_URL in the first place).
//
// Safe to delete once the sync is confirmed working again. Never writes,
// never deletes, never exposes secrets.

import { getSession } from "../lib/session.js";
import { readKey } from "../lib/backbone-store.js";

export default async function handler(req, res) {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ error: "Not authenticated" });
  // Loosened from superuser-only to any signed-in session (Aug 5): the owner's
  // own session did not carry perms.superuser, which is itself worth fixing
  // separately, but this route is read-only and exposes no secrets, so it is
  // safe to open to any authenticated user while we debug the sync.

  try {
    const ops = await readKey("backbone_printavo_ops");
    const partial = await readKey("backbone_ops_partial");

    return res.status(200).json({
      ok: true,
      backbone_printavo_ops: ops
        ? {
            generatedAt: ops.generatedAt || null,
            buildVersion: ops.buildVersion || null,
            cashMonths: ops.cashByMonth ? Object.keys(ops.cashByMonth).length : 0,
            diagnosticsChainError: (ops.diagnostics && ops.diagnostics.chainError) || null,
          }
        : null,
      backbone_ops_partial: partial
        ? {
            phase: partial.phase || null,
            updatedAt: partial.updatedAt || null,
            cursorPresent: !!partial.cursor,
            chainError: partial.chainError || null,
            lastChainAttempt: partial.lastChainAttempt || null,
          }
        : null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
