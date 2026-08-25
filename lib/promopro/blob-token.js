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
