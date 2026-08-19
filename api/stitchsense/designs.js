// api/stitchsense/designs.js — the design library: real designs with their
// TRUE stitch count read out of the DST file.
//
// This is the question bank for the guessing game and the reference set the
// resize path quotes from. Every record here is ground truth, never an
// estimate, which is why import is gated and why validateDesign() rejects
// anything with an implausible count instead of storing it and hoping.
//
// FOLDER FORM, NOT A FLAT api/stitchsense.js. Vercel treats a file and a
// same-named folder as a route conflict once the .js is stripped, so once a
// second route was needed the folder was the only option. Same lesson as
// WebsiteWidget and PromoPro.
//
// GET                     -> the index (summaries, no thumbnails)
// GET ?id=SD-000123       -> one full record, thumbnail included
// GET ?random=1           -> one full record chosen at random, for the game
// POST { designs: [...] } -> bulk import, admin only
// PATCH ?id=              -> edit a record, admin only
// DELETE ?id=             -> remove one, admin only
// DELETE ?all=1           -> wipe the library, admin only
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from '../../lib/session.js';
import { getUser, getRole } from '../../lib/users.js';
import { validateDesign } from '../../lib/stitchsense/schema.js';
import {
  listDesigns, getDesign, saveDesigns, updateDesign, deleteDesign,
  clearDesigns, nextDesignId
} from '../../lib/stitchsense/store.js';

// Importing and deleting reshape what everybody else sees, so both stay with
// admin-scope roles. Reading is open to anyone who can open the app: a design
// thumbnail and its stitch count are not sensitive, and the whole point of the
// game is that production staff can play it.
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

// One import request carries at most this many designs. The browser importer
// chunks a five thousand file archive into batches of this size, which keeps
// each request comfortably inside the serverless time limit and means a
// dropped connection costs one batch rather than the whole run.
const MAX_BATCH = 100;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const q = req.query || {};

  try {
    if (req.method === 'GET') {
      if (q.id) {
        const rec = await getDesign(String(q.id));
        if (!rec) return res.status(404).json({ error: 'Design not found' });
        return res.status(200).json({ design: rec });
      }

      if (q.random) {
        const index = await listDesigns();
        // Only designs with a thumbnail can be shown, because the game asks
        // somebody to look at a picture. Filtering here rather than in the app
        // means the app never has to handle "I got a design I cannot draw".
        const showable = index.filter((d) => d.hasThumb);
        if (!showable.length) {
          return res.status(200).json({ design: null, reason: 'no designs with thumbnails imported yet' });
        }

        // Skip anything the caller has already been shown this session. The
        // client sends the ids; the server does not track it, because a game
        // that remembers across devices is a feature nobody asked for and a
        // KV write per round nobody needs.
        const seen = String(q.seen || '').split(',').filter(Boolean);
        let pool = showable.filter((d) => !seen.includes(d.id));
        if (!pool.length) pool = showable;   // seen them all, start over

        const pick = pool[Math.floor(Math.random() * pool.length)];
        const full = await getDesign(pick.id);
        // REDACTED ON PURPOSE. The player gets the picture and the finished
        // size, and nothing that gives the answer away. Sending the full
        // record and trusting the UI not to display it would put the true
        // count in the network tab, one keypress from anybody who wanted to
        // top the leaderboard. coveredSqIn and fill go too: together with the
        // published model they reconstruct the answer to within a few percent.
        return res.status(200).json({
          design: {
            id: full.id,
            name: full.name,
            thumb: full.thumb,
            w: full.w,
            h: full.h,
            colors: full.colors
          },
          remaining: pool.length
        });
      }

      const index = await listDesigns();
      return res.status(200).json({ designs: index, total: index.length });
    }

    if (req.method === 'POST') {
      if (!(await callerIsAdmin(sess))) {
        return res.status(403).json({ error: 'Importing designs is admin only' });
      }

      const body = parseBody(req);
      const incoming = Array.isArray(body.designs) ? body.designs : [];
      if (!incoming.length) return res.status(400).json({ error: 'designs array is required' });
      if (incoming.length > MAX_BATCH) {
        return res.status(400).json({ error: `at most ${MAX_BATCH} designs per request` });
      }

      const records = [];
      const rejected = [];
      for (const raw of incoming) {
        const { ok, errors, record } = validateDesign(raw);
        if (!ok) {
          // Named, not counted. "17 rows failed" from an import of thousands
          // is unactionable; the filename plus the reason is fixable.
          rejected.push({ name: (raw && raw.name) || '(unnamed)', errors });
          continue;
        }
        record.id = await nextDesignId();
        record.createdAt = new Date().toISOString();
        record.createdBy = String(sess.username || '').toLowerCase();
        records.push(record);
      }

      const result = records.length ? await saveDesigns(records) : { saved: 0 };
      return res.status(200).json({ saved: result.saved || 0, total: result.total, rejected });
    }

    if (req.method === 'PATCH') {
      if (!(await callerIsAdmin(sess))) {
        return res.status(403).json({ error: 'Editing designs is admin only' });
      }
      const id = String(q.id || parseBody(req).id || '');
      if (!id) return res.status(400).json({ error: 'id is required' });

      const body = parseBody(req);
      const patch = {};
      if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 160);
      if (typeof body.character === 'string') patch.character = body.character.trim().slice(0, 40);
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' });

      const updated = await updateDesign(id, patch);
      if (!updated) return res.status(404).json({ error: 'Design not found' });
      return res.status(200).json({ design: updated });
    }

    if (req.method === 'DELETE') {
      if (!(await callerIsAdmin(sess))) {
        return res.status(403).json({ error: 'Deleting designs is admin only' });
      }
      if (q.all) {
        const out = await clearDesigns();
        return res.status(200).json(out);
      }
      const id = String(q.id || '');
      if (!id) return res.status(400).json({ error: 'id is required' });
      const out = await deleteDesign(id);
      return res.status(200).json(out);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}
