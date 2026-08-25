// lib/promopro/blob-token.js — find the Blob read-write token, whatever
// Vercel decided to call it.
//
// WHY THIS EXISTS
// The SDK reads `BLOB_READ_WRITE_TOKEN` from the environment and fails if it
// is absent. That is the name Vercel uses when a store is connected with the
// default prefix. Connect a store under its own name, as `backbone-briefs`
// was, and the variable is `BACKBONE_BRIEFS_READ_WRITE_TOKEN` instead. The
// store is connected, the token is present, and the SDK still cannot see it,
// which is exactly the state this codebase was in on Aug 25 2026.
//
// So: look for the standard name first, then for any variable following
// Vercel's own `<PREFIX>_READ_WRITE_TOKEN` convention. Nothing is guessed
// about the value, only about the name, and the token is passed to the SDK
// explicitly rather than left to be discovered.
//
// Deliberately NOT a rename in Vercel. Adding a second copy of a credential
// under a different name means two things to rotate and one that gets
// forgotten.
//
// ESM. Do NOT convert to module.exports.

const STANDARD = "BLOB_READ_WRITE_TOKEN";
const CONVENTION = /^[A-Z0-9_]+_READ_WRITE_TOKEN$/;

/** The token itself, or null. Never logged, never returned to a browser. */
export function blobToken() {
  const std = process.env[STANDARD];
  if (typeof std === "string" && std.length > 0) return std;

  for (const name of Object.keys(process.env)) {
    if (name === STANDARD || !CONVENTION.test(name)) continue;
    const v = process.env[name];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Which variable the token came from, for diagnostics. The NAME only: a
 * readiness check that prints a credential is worse than the fault it was
 * built to explain.
 */
export function blobTokenSource() {
  const std = process.env[STANDARD];
  if (typeof std === "string" && std.length > 0) return STANDARD;

  for (const name of Object.keys(process.env)) {
    if (name === STANDARD || !CONVENTION.test(name)) continue;
    const v = process.env[name];
    if (typeof v === "string" && v.length > 0) return name;
  }
  return null;
}

/** Every blob-ish variable name present, so a diagnostic can say what IS there. */
export function blobTokenCandidates() {
  return Object.keys(process.env)
    .filter((n) => CONVENTION.test(n) || /BLOB/.test(n))
    .sort();
}

/* ------------------------------------------------------------------ *
 * WHICH STORE ARTWORK LIVES IN
 *
 * Public and private are a property of the STORE, not of a file. A store
 * created public refuses a private write outright:
 *
 *   "Cannot use private access on a public store."
 *
 * The existing `backbone-briefs` store is public, and has to stay that way:
 * the emailed briefs in BackBone are plain public URLs and making the store
 * private would break every link already sent.
 *
 * So artwork needs its own private store, and the code needs to be told
 * which one. Set PROMOPRO_BLOB_STORE_ID, or connect the store with a prefix
 * and the convention below finds it. Falls back to the default store, which
 * fails loudly rather than silently writing artwork somewhere public.
 * ------------------------------------------------------------------ */

const STORE_CONVENTION = /^[A-Z0-9_]+_BLOB_STORE_ID$/;

export function artStoreId() {
  const explicit = process.env.PROMOPRO_BLOB_STORE_ID;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;

  // Any prefixed store id other than the default one.
  for (const name of Object.keys(process.env)) {
    if (!STORE_CONVENTION.test(name)) continue;
    const v = process.env[name];
    if (typeof v === "string" && v.length > 0) return v;
  }

  const fallback = process.env.BLOB_STORE_ID;
  return typeof fallback === "string" && fallback.length > 0 ? fallback : null;
}

/** Which variable the store id came from, for diagnostics. Name only. */
export function artStoreSource() {
  if (process.env.PROMOPRO_BLOB_STORE_ID) return "PROMOPRO_BLOB_STORE_ID";
  for (const name of Object.keys(process.env)) {
    if (STORE_CONVENTION.test(name) && process.env[name]) return name;
  }
  return process.env.BLOB_STORE_ID ? "BLOB_STORE_ID" : null;
}

/**
 * The options every artwork blob call should carry: the store, and a
 * read-write token only when one exists. Passing `token: undefined` stops
 * the SDK falling back to its OIDC path, so it is spread in conditionally.
 */
export function artBlobOptions() {
  const token = blobToken();
  const storeId = artStoreId();
  return {
    ...(token ? { token } : {}),
    ...(storeId ? { storeId } : {}),
  };
}
