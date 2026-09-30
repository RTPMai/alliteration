// PUT IN: lib/contact-format.js
// lib/contact-format.js — one set of rules for a person's name, phone and
// email, shared by the public inquiry form (intake.html), the route that
// stores it (api/intake.js), and the code that turns it into a lead
// (lib/backbone/inquiries.js).
//
// Why one file: the form checks as someone types, the server checks again
// because the form is public and anyone can post to the route directly, and
// the lead builder reads what both agreed on. Three copies of "what is a
// valid phone" drift the first time one of them is edited.
//
// Pure functions, no imports. The browser loads this file as-is.

// ---- phone -----------------------------------------------------------------
//
// Every phone number comes out in one shape: (515) 555-0123, with an optional
// " x123" extension. People type 515.555.0123, 5155550123, +1 515 555 0123,
// (515)555-0123. All of those are the same number and should read the same
// way on the lead, in Printavo and on a call sheet.
//
// US/Canada numbers only, since that is who calls the shop. Anything that is
// not ten digits (after dropping a leading country code 1) is not accepted,
// because a nine-digit number cannot be dialled and a guess would be wrong.

export function formatPhone(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return { ok: true, value: "" };

  // Split off an extension first so its digits are not read as the number.
  // Accepts "x12", "ext 12", "ext. 12", "extension 12", "#12".
  let main = s;
  let ext = "";
  const m = s.match(/^(.*?)(?:\s*(?:x|ext\.?|extension|#)\s*(\d{1,6}))\s*$/i);
  if (m && /\d/.test(m[1])) { main = m[1]; ext = m[2]; }

  if (/[a-wyz]/i.test(main)) {
    return { ok: false, value: s, error: "Phone numbers can only contain digits." };
  }

  let digits = main.replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") digits = digits.slice(1);
  if (digits.length !== 10) {
    return { ok: false, value: s, error: "Enter a 10-digit phone number, area code first." };
  }
  // North American numbers never start an area code or exchange with 0 or 1.
  if (digits[0] === "0" || digits[0] === "1" || digits[3] === "0" || digits[3] === "1") {
    return { ok: false, value: s, error: "That doesn't look like a real phone number. Check the area code." };
  }

  const value = "(" + digits.slice(0, 3) + ") " + digits.slice(3, 6) + "-" + digits.slice(6) + (ext ? " x" + ext : "");
  return { ok: true, value };
}

// ---- email -----------------------------------------------------------------
//
// Deliberately practical rather than the full RFC. It catches what people
// actually get wrong: "Test $", a missing @, a missing dot in the domain,
// spaces, a trailing dot, two @s. It does not try to prove the mailbox exists.

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export function checkEmail(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return { ok: true, value: "" };
  if (s.length > 254 || !EMAIL_RE.test(s)) {
    return { ok: false, value: s, error: "Enter a full email address, like name@company.com." };
  }
  const local = s.split("@")[0];
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return { ok: false, value: s, error: "Enter a full email address, like name@company.com." };
  }
  return { ok: true, value: s.toLowerCase() };
}

// ---- names -----------------------------------------------------------------
//
// First and last are asked for separately now. The single name field made the
// lead builder guess: "Mary Ann Smith" split as Mary / Ann Smith. Submissions
// from before the split still only carry `name`, so splitName() stays as the
// fallback for those, and nothing else.

export function cleanNamePart(raw) {
  return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
}

// A name has to contain a letter. "Test $" passes, so it is not a proof of a
// real name, but "$", "123" and "." are caught.
export function checkNamePart(raw) {
  const s = cleanNamePart(raw);
  if (!s) return { ok: false, value: "", error: "required" };
  if (!/\p{L}/u.test(s)) return { ok: false, value: s, error: "Names need at least one letter." };
  return { ok: true, value: s };
}

export function splitName(full) {
  const parts = cleanNamePart(full).split(" ").filter(Boolean);
  return { first: parts[0] || "", last: parts.length > 1 ? parts.slice(1).join(" ") : "" };
}

// The contact's first/last, whichever way the submission recorded them.
export function contactNameParts(c) {
  c = c || {};
  const first = cleanNamePart(c.first_name);
  const last = cleanNamePart(c.last_name);
  if (first || last) return { first, last };
  return splitName(c.name);
}
