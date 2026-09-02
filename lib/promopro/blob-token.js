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

// WHAT VERCEL ACTUALLY NAMES THESE.
//
// Connecting a store with a custom prefix produces `<PREFIX>_STORE_ID`, not
// `<PREFIX>_BLOB_STORE_ID`. Only the DEFAULT connection is called
// `BLOB_STORE_ID`. Checked against a real store created on Aug 25 2026,
// which came out as `PROMOPRO_STORE_ID`.
//
// So: accept anything ending in _STORE_ID, prefer the names PromoPro would
// have been given, and treat the default BLOB_STORE_ID as the last resort
// because that is the shared PUBLIC store and artwork must not land there.
const STORE_CONVENTION = /^[A-Z0-9_]+_STORE_ID$/;
const PREFERRED = ["PROMOPRO_STORE_ID", "PROMOPRO_BLOB_STORE_ID"];

function readEnv(name) {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Both functions below walk the same order, so they can never disagree. */
function resolveStore() {
  for (const name of PREFERRED) {
    if (readEnv(name)) return { name, value: readEnv(name) };
  }

  // Any other prefixed store, but never the shared default.
  for (const name of Object.keys(process.env)) {
    if (name === "BLOB_STORE_ID" || !STORE_CONVENTION.test(name)) continue;
    if (readEnv(name)) return { name, value: readEnv(name) };
  }

  if (readEnv("BLOB_STORE_ID")) return { name: "BLOB_STORE_ID", value: readEnv("BLOB_STORE_ID") };
  return { name: null, value: null };
}

export function artStoreId() {
  return resolveStore().value;
}

/** Which variable the store id came from, for diagnostics. Name only. */
export function artStoreSource() {
  return resolveStore().name;
}

/* ------------------------------------------------------------------ *
 * THE KEY THAT VERIFIES THE CALLBACK
 *
 * Live on Aug 25 2026: once artwork moved to its own store, the completion
 * callback was signed by THAT store and verified against the DEFAULT store's
 * public key. The upload succeeded, the callback arrived, the signature was
 * refused, and the order ended up with no artwork on it. Nothing anybody
 * could see reported an error.
 *
 * The key and the store have to come from the same connection or the check
 * is meaningless, so this walks the store resolution and swaps the suffix
 * rather than reading a key name of its own. Vercel names them in pairs:
 * PROMOPRO_STORE_ID sits next to PROMOPRO_WEBHOOK_PUBLIC_KEY, the default
 * pair is BLOB_STORE_ID and BLOB_WEBHOOK_PUBLIC_KEY.
 *
 * A store whose own key is missing answers null. Falling back to another
 * store's key would verify nothing and fail invisibly, which is the exact
 * shape of the incident above.
 * ------------------------------------------------------------------ */
export function artWebhookKey() {
  const source = artStoreSource();
  if (!source) return null;
  return readEnv(source.replace(/_STORE_ID$/, "_WEBHOOK_PUBLIC_KEY"));
}

/** Which variable the key came from, or null. Name only, never the value. */
export function artWebhookKeySource() {
  const source = artStoreSource();
  if (!source) return null;
  const name = source.replace(/_STORE_ID$/, "_WEBHOOK_PUBLIC_KEY");
  return readEnv(name) ? name : null;
}

/**
 * True when artwork would land in the shared PUBLIC store, which refuses
 * private files. Worth saying out loud in the readiness check rather than
 * leaving somebody to read an error from storage.
 */
export function usingSharedStore() {
  return artStoreSource() === "BLOB_STORE_ID";
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
