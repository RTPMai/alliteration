// PUT IN: lib/crewcore/accounts.js
// lib/crewcore/accounts.js: roster people and their Alliteration logins.
//
// Sep 21 2026, Ryan: flag anyone on the roster without an email or a login,
// and when somebody is added to the roster, make them a login if they do not
// have one. Every employee a user is the direction this has been heading
// since Sep 10; this is the roster side of it.
//
// What a new login gets:
//   username   their first name, lowercased, the way the shop already names
//              accounts (ryan, jacob, amanda). Taken? first name plus last
//              initial, then first plus last name, then a number.
//   password   a temporary one, shown to the admin ONCE on screen. There is
//              no self-serve password screen yet, so the admin hands it over,
//              and resets it in Settings > Accounts if it is lost. It is never
//              stored in plain text and never emailed.
//   access     CrewCore only. The CrewCore ceiling in lib/users.js keeps a
//              non-admin to the self-serve views (their dashboard, time off,
//              stipend, reviews, handbook), so this cannot hand out the roster.
//
// Pure functions only; the route does the writing.
//
// ESM. Do NOT convert to module.exports.

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

function clean(s) {
  return String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A free username for a person, from their name. `taken` is every username
 * already in use (accounts AND roster links), any case.
 */
export function suggestUsername(fullName, taken) {
  const used = new Set(Array.from(taken || []).map((u) => String(u || "").toLowerCase()));
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  const first = clean(parts[0]);
  const last = clean(parts.length > 1 ? parts[parts.length - 1] : "");
  const tries = [];
  if (first) tries.push(first);
  if (first && last) tries.push(first + last[0], first + last, first + "." + last);
  const pad = (u) => (u.length >= 3 ? u : (u + "000").slice(0, 3));
  for (const t of tries) {
    const u = pad(t).slice(0, 32);
    if (USERNAME_RE.test(u) && !used.has(u)) return u;
  }
  const base = pad(first + last || "employee").slice(0, 28);
  for (let n = 2; n < 1000; n++) {
    const u = base + n;
    if (!used.has(u)) return u;
  }
  return null;
}

const WORDS = [
  "shirt", "hoodie", "ink", "thread", "press", "needle", "cotton", "denim",
  "squeegee", "screen", "stitch", "hoop", "fleece", "jersey", "canvas", "polo",
];

/**
 * A temporary password somebody can read off a screen and type: two shop
 * words and four digits, "Hoodie-Stitch-4821". Well over the 8 character
 * minimum. `rand` is injectable for tests; the server passes crypto.
 */
export function tempPassword(rand) {
  const r = rand || ((n) => Math.floor(Math.random() * n));
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  const a = WORDS[r(WORDS.length)];
  let b = WORDS[r(WORDS.length)];
  if (b === a) b = WORDS[(WORDS.indexOf(a) + 1) % WORDS.length];
  const digits = String(r(10000)).padStart(4, "0");
  return `${cap(a)}-${cap(b)}-${digits}`;
}

/**
 * What is missing for one roster person. `logins` is the set of usernames
 * that really exist as accounts. A username typed on the roster that no
 * account matches counts as no login: it links to nothing.
 */
export function rosterGaps(employee, logins) {
  const e = employee || {};
  const set = logins instanceof Set ? logins : new Set(Array.from(logins || []).map((u) => String(u).toLowerCase()));
  const email = String(e.email || "").trim();
  const u = String(e.username || "").trim().toLowerCase();
  return {
    no_email: !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email),
    no_login: !u || !set.has(u),
  };
}
