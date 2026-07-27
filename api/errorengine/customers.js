// api/errorengine/customers.js — read-only customer list from backbone_data,
// for the ErrorEngine intake dropdown.
//
// PORTED from the standalone repo's api/customers.js. Changes for alliteration:
//   - ROUTE MOVED to /api/errorengine/customers (ENDPOINTS.eeCustomers) so a
//     future BackBone /api/customers can't silently steal it.
//   - AUTH IS SHELL-LEVEL: shared lib/session.js. Note the ../../ import depth —
//     this file sits one folder down.
//   - Library imports point at lib/errorengine/.
//
// This is the ErrorEngine <-> BackBone connection in one route: it reads the shared
// backbone_data key and returns { customer_id, name } pairs. ErrorEngine never writes
// backbone_data — this endpoint is GET-only and touches nothing.

import { requireAuth } from "../../lib/session.js";
import { listBackboneCustomers, getBackboneData } from "../../lib/errorengine/store.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const { lastSynced } = await getBackboneData();
    const customers = await listBackboneCustomers();
    return res.status(200).json({ customers, lastSynced, source: "backbone_data (read-only)" });
  } catch (e) {
    console.error("errorengine customers error:", e);
    return res.status(500).json({ error: e.message });
  }
}
