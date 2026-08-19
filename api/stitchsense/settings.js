// api/stitchsense/settings.js — StitchSense calibration settings.
//
// TWO NUMBERS, AND THEY EXIST FOR A REAL REASON.
//
// The model constants were fitted against coverage as measured by Ryan's
// archive-scanner.html. This app measures coverage with its own code. If the
// two rasterisers disagree about how wide a thread is, every estimate is
// wrong by a fixed factor even though the model is right, and nothing on
// screen would look broken.
//
//   dstCoverageScale    multiplies coverage measured from a DST file
//   imageCoverageScale  multiplies coverage measured from a customer image
//
// dstCoverageScale is measurable TODAY: the Library import view can compare
// its own numbers against the covered column of stitch-archive.csv and print
// the ratio. Set it once and it is settled.
//
// imageCoverageScale is NOT measurable from the archive at all, because the
// archive has no customer artwork in it. The only way to find it is the
// estimate-versus-actual log filling up with real jobs. It starts at 1.0 and
// stays there until there is evidence, which is honest rather than a guess
// dressed up as a default.
//
// GET   -> current settings
// PATCH -> update, admin only (these change every estimate everyone makes)
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from '../../lib/session.js';
import { getUser, getRole } from '../../lib/users.js';
import { KEY_PREFIX } from '../../lib/stitchsense/schema.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const SETTINGS_KEY = `${KEY_PREFIX}:settings`;

const DEFAULTS = {
  dstCoverageScale: 1,
  imageCoverageScale: 1,
  // Thread width in millimetres, used when rasterising a stitch path to
  // measure covered area. 0.4 mm is a standard 40-weight embroidery thread
  // laid flat. Exposed rather than hardcoded because it is the single knob
  // that moves every DST coverage number.
  threadWidthMm: 0.4
};

function clampScale(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // A calibration factor outside this range means something is wrong with the
  // measurement, not that the factor should be 12. Refusing to store it is
  // how a fat-fingered entry stops being a silent shop-wide miscalculation.
  return Math.min(5, Math.max(0.2, n));
}

async function readSettings() {
  if (!KV_URL || !KV_TOKEN) return { ...DEFAULTS, configured: false };
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(SETTINGS_KEY)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return { ...DEFAULTS, configured: true };
  const j = await r.json();
  let data = j.result;
  let attempts = 0;
  while (typeof data === 'string' && attempts < 3) {
    try { data = JSON.parse(data); } catch (e) { break; }
    attempts++;
  }
  return { ...DEFAULTS, ...(data && typeof data === 'object' ? data : {}), configured: true };
}

async function writeSettings(next) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(SETTINGS_KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(next)
  });
  if (!r.ok) throw new Error(`Redis SET failed: ${r.status}`);
  return next;
}

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

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ settings: await readSettings() });
    }

    if (req.method === 'PATCH') {
      if (!(await callerIsAdmin(sess))) {
        return res.status(403).json({ error: 'Calibration settings are admin only' });
      }
      const body = parseBody(req);
      const current = await readSettings();
      const next = {
        dstCoverageScale: body.dstCoverageScale === undefined
          ? current.dstCoverageScale
          : clampScale(body.dstCoverageScale, current.dstCoverageScale),
        imageCoverageScale: body.imageCoverageScale === undefined
          ? current.imageCoverageScale
          : clampScale(body.imageCoverageScale, current.imageCoverageScale),
        threadWidthMm: body.threadWidthMm === undefined
          ? current.threadWidthMm
          : Math.min(2, Math.max(0.1, Number(body.threadWidthMm) || current.threadWidthMm)),
        updatedAt: new Date().toISOString(),
        updatedBy: String(sess.username || '').toLowerCase()
      };
      await writeSettings(next);
      return res.status(200).json({ settings: { ...DEFAULTS, ...next, configured: true } });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}
