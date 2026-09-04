// PUT IN: lib/backbone/archive-store.js
// lib/backbone/archive-store.js — storage for the archive reason list and for
// client archives.
//
// TWO KEYS, DELIBERATELY SEPARATE.
//   backbone_archive_reasons  the editable list of reasons (a setting)
//   backbone_archived_clients the per-client stamps (data)
// They change at completely different rates and by completely different people:
// the list is edited once a quarter by an admin, the stamps every week by
// whoever is tidying the roster. Keeping them in one blob would mean a routine
// archive rewrites the settings, and a settings save could clobber archives
// made while the screen was open.
//
// LEAD archives are NOT here. A lead's stamp lives on the lead itself in
// backbone_leads, because leads are ours end to end. Clients need the separate
// record because the roster is rebuilt from Printavo and a flag written onto a
// synced row does not survive the next reconcile.
//
// ESM. Do NOT convert to module.exports.

import { getRaw, setRaw } from "../kv.js";
import { normalizeReasons, DEFAULT_ARCHIVE_REASONS, readClientArchiveMap } from "./archive.js";

const REASONS_KEY = "backbone_archive_reasons";
const CLIENTS_KEY = "backbone_archived_clients";

/**
 * The live reason list. Never throws and never returns empty: a storage blip
 * falls back to the seeded defaults, because a screen offering no reasons is
 * indistinguishable from a broken screen and would block archiving entirely.
 */
export async function getArchiveReasons() {
  try {
    const raw = await getRaw(REASONS_KEY);
    if (!raw) return DEFAULT_ARCHIVE_REASONS.slice();
    const list = Array.isArray(raw) ? raw : raw.reasons;
    return normalizeReasons(list);
  } catch (e) {
    console.error("[archive-store] reason list unreadable, using defaults:", e && e.message);
    return DEFAULT_ARCHIVE_REASONS.slice();
  }
}

/** Save the reason list. Cleaned first, so storage never holds blanks or dupes. */
export async function saveArchiveReasons(list) {
  const reasons = normalizeReasons(list);
  await setRaw(REASONS_KEY, { reasons, savedAt: new Date().toISOString() });
  return reasons;
}

/** Every client archive stamp, keyed by customer id. Never throws. */
export async function getClientArchives() {
  try {
    return readClientArchiveMap(await getRaw(CLIENTS_KEY));
  } catch (e) {
    console.error("[archive-store] client archives unreadable:", e && e.message);
    return {};
  }
}

/**
 * Write one client's stamp, or remove it when `stamp` is null.
 *
 * READ, MERGE, WRITE rather than replace-the-whole-map, so two people archiving
 * two different customers in the same minute do not erase each other. This is
 * not airtight against a true simultaneous write, and it does not need to be:
 * the loser of that race loses one archive that is visibly still on the roster,
 * not the other ninety.
 */
export async function setClientArchive(customerId, stamp) {
  const id = String(customerId == null ? "" : customerId).trim();
  if (!id) throw new Error("A customer id is required.");
  const map = await getClientArchives();
  if (stamp) map[id] = stamp;
  else delete map[id];
  await setRaw(CLIENTS_KEY, { clients: map, savedAt: new Date().toISOString() });
  return map;
}
