//
// THIS IS THE POINT OF THE APP.
//
// The model was fitted on 5,904 archive DSTs, which means it was fitted on
// coverage measured from finished digitised files. An AM quoting a job is
// working from a customer PNG instead, which is a messier input, and NOTHING
// in the archive measures how much messier. Every estimate logged here, paired
// with the count the design actually came in at, is one data point about the
// step the archive skips entirely.
//
// A hundred of these are worth more than another five thousand archive files.
//
// GET                 -> every estimate, newest first
// GET ?withActual=1   -> only the ones that have been closed out
// POST                -> log an estimate an AM just produced
// PATCH ?id=          -> record what it actually came in at
// DELETE ?id=         -> admin only
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from '../../lib/session.js';
import { getUser, getRole } from '../../lib/users.js';
import { validateEstimate, validateActual } from '../../lib/stitchsense/schema.js';
import {
  listEstimates, getEstimate, saveEstimate, deleteEstimate, nextEstimateId
} from '../../lib/stitchsense/store.js';

async function callerIsAdmin(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const role = await getRole(user ? user.role : sess.role);
  return (role && role.data_scope === 'all') || (user && user.superuser === true);
}

function parseBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === 'object' ? b : {};
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const q = req.query || {};

  try {
    if (req.method === 'GET') {
      if (q.id) {
        const rec = await getEstimate(String(q.id));
        if (!rec) return res.status(404).json({ error: 'Estimate not found' });
        return res.status(200).json({ estimate: rec });
      }

      let list = await listEstimates();
      if (q.withActual) list = list.filter((e) => e.actualStitches != null);
      list = list.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return res.status(200).json({ estimates: list, total: list.length });
    }

    if (req.method === 'POST') {
      const { ok, errors, record } = validateEstimate(parseBody(req));
      if (!ok) return res.status(400).json({ error: errors.join('; '), errors });

      record.id = await nextEstimateId();
      record.createdAt = new Date().toISOString();
      record.createdBy = String(sess.username || '').toLowerCase();

      await saveEstimate(record);
      return res.status(200).json({ estimate: record });
    }

    if (req.method === 'PATCH') {
      const id = String(q.id || parseBody(req).id || '');
      if (!id) return res.status(400).json({ error: 'id is required' });

      const existing = await getEstimate(id);
      if (!existing) return res.status(404).json({ error: 'Estimate not found' });

      const { ok, errors, actualStitches } = validateActual(parseBody(req));
      if (!ok) return res.status(400).json({ error: errors.join('; '), errors });

      // Anyone signed in can close out an estimate, not just whoever made it:
      // the person who knows the finished stitch count is usually the
      // digitiser, not the AM who quoted it. Who did it is stamped so the
      // trail is still there.
      const updated = {
        ...existing,
        actualStitches,
        actualAt: new Date().toISOString(),
        actualBy: String(sess.username || '').toLowerCase()
      };
      await saveEstimate(updated);
      return res.status(200).json({ estimate: updated });
    }

    if (req.method === 'DELETE') {
      if (!(await callerIsAdmin(sess))) {
        return res.status(403).json({ error: 'Deleting estimates is admin only' });
      }
      const id = String(q.id || '');
      if (!id) return res.status(400).json({ error: 'id is required' });
      const out = await deleteEstimate(id);
      return res.status(200).json(out);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}
