// lib/short-code.js — cryptographically-secure short codes for hosted links.
//
// Used by api/brief.js and api/inquiry-brief.js to generate the /api/b?c=
// short link that stands in for the long, download-forcing Blob URL. These
// codes are the ONLY thing standing between a stranger and a lead's or
// inquiry's contact details, so they need to come from a real random source.
//
// crypto.randomInt is Node's CSPRNG (backed by the OS's secure random
// generator), unlike Math.random() which is a fast, NOT cryptographically
// secure PRNG never meant to gate access to anything.
//
// ALPHABET is exactly 32 characters (a power of two) on purpose: it lets
// randomInt(0, 32) map to a character with zero modulo bias, and it drops
// the visually ambiguous 0/1/l/o pairs so a code read aloud or off a screen
// doesn't get mistyped.

import crypto from "crypto";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // 32 chars, no 0/1/l/o

export function randomShortCode(length = 8) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return out;
}
