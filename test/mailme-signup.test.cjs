// test/mailme-signup.test.cjs
/**
 * Locks the public, no-login MailMe signup endpoint (api/mailme/signup.js)
 * and its store helper (lib/mailme/store.js: publicListSignup). This is a
 * public write path with no session, so the properties worth locking are:
 *   - it truly requires no auth (no requireAuth/requireMailMe call)
 *   - it is rate limited per IP, same as the other public intake routes
 *   - the target list is an ALLOWLIST, not free text from the request body
 *   - it never duplicates a contact it already knows about, it tags instead
 *   - the standalone public page exists, is outside the shell, and posts the
 *     shape the handler expects
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const handlerSrc = read('api/mailme/signup.js');
const storeSrc = read('lib/mailme/store.js');

/* ---- the route is genuinely public ---- */

t.test('signup.js exists and never calls requireAuth or requireMailMe', () => {
  t.assert(exists('api/mailme/signup.js'), 'api/mailme/signup.js is missing');
  t.assert(!/requireAuth|requireMailMe/.test(handlerSrc),
    'signup.js must stay public, no-login, like giving-intake.js and scan-status.js');
});

t.test('signup.js only accepts POST (plus OPTIONS)', () => {
  t.assert(/req\.method !== ["']POST["']/.test(handlerSrc), 'signup.js must reject non-POST methods');
});

/* ---- rate limiting, same shape as the other public intake routes ---- */

t.test('signup.js rate limits by IP', () => {
  t.assert(/isRateLimited/.test(handlerSrc), 'signup.js is missing IP rate limiting');
  t.assert(/clientIp/.test(handlerSrc), 'signup.js should key its rate limit off the request IP');
});

/* ---- CORS: an explicit origin allowlist, never a wildcard ---- */

t.test('CORS reflects only an allowlisted origin, never a wildcard', () => {
  t.assert(/ALLOWED_ORIGINS/.test(handlerSrc), 'signup.js is missing an origin allowlist');
  t.assert(!/Access-Control-Allow-Origin["'],\s*["']\*["']/.test(handlerSrc),
    'signup.js must never set Access-Control-Allow-Origin to "*" — that would let ANY site on the ' +
    'internet call this endpoint from a user\'s browser, not just FOC/P&M\'s own sites');
  t.assert(/ALLOWED_ORIGINS\.includes\(origin\)/.test(handlerSrc),
    'the Origin header must be checked against the allowlist before being reflected back');
});

t.test('the real FOC and P&M domains are on the CORS allowlist', () => {
  ['flyovercon.ink', 'pmapparel.com'].forEach((domain) => {
    t.assert(handlerSrc.includes(domain), `CORS allowlist is missing ${domain}`);
  });
});

/* ---- allowlist, not free text ---- */

t.test('the target list comes from an allowlist, not raw request input', () => {
  t.assert(/ALLOWED_SIGNUPS/.test(handlerSrc), 'signup.js must gate `list` through an allowlist');
  t.assert(/flyover-con/.test(handlerSrc), 'the flyover-con entry is missing from the allowlist');
  // The handler must look the key up in the map and reject unknown keys,
  // not just read body.list straight into storage.
  t.assert(/ALLOWED_SIGNUPS\[listKey\]/.test(handlerSrc) || /ALLOWED_SIGNUPS\s*\[/.test(handlerSrc),
    'signup.js must look the requested list up in ALLOWED_SIGNUPS rather than trusting it directly');
  t.assert(/if \(!target\)/.test(handlerSrc), 'signup.js must reject a `list` value not in the allowlist');
});

/* ---- validation ---- */

t.test('signup.js validates name and email before writing anything', () => {
  t.assert(/isValidEmail/.test(handlerSrc), 'signup.js must validate the email format');
  t.assert(/isRoleAddress/.test(handlerSrc), 'signup.js must reject role addresses (abuse@, noreply@, etc)');
  t.assert(/if \(!name\)/.test(handlerSrc), 'signup.js must require a name');
});

/* ---- store helper: tag existing contacts, never duplicate ---- */

t.test('publicListSignup exists and is exported from lib/mailme/store.js', () => {
  t.assert(/export async function publicListSignup/.test(storeSrc),
    'lib/mailme/store.js is missing publicListSignup');
});

t.test('publicListSignup checks for an existing contact before creating a prospect', () => {
  const fn = storeSrc.slice(storeSrc.indexOf('export async function publicListSignup'));
  const body = fn.slice(0, fn.indexOf('\nexport async function', 1));
  t.assert(/resolveContacts/.test(body), 'publicListSignup must look up existing contacts first');
  t.assert(/existing/.test(body) && /addProspects/.test(body),
    'publicListSignup must only call addProspects when no existing contact was found');
  t.assert(/setContactStatus/.test(body),
    'publicListSignup must tag an existing contact via setContactStatus rather than duplicate it');
});

t.test('publicListSignup creates the target list lazily and reuses it on later signups', () => {
  const fn = storeSrc.slice(storeSrc.indexOf('export async function publicListSignup'));
  const body = fn.slice(0, fn.indexOf('\nexport async function', 1));
  t.assert(/listLists/.test(body), 'publicListSignup must check for an existing list by name first');
  t.assert(/createList/.test(body), 'publicListSignup must create the list on the first signup');
  t.assert(/kind:\s*["']dynamic["']/.test(body),
    'the auto-created list should be dynamic/tag-matched so later signups need no extra write');
});

/* ---- company + attended-before: both optional, both safe ---- */

t.test('signup.js accepts optional company and attended fields', () => {
  t.assert(/body\.company/.test(handlerSrc), 'signup.js must read company from the request body');
  t.assert(/body\.attended/.test(handlerSrc), 'signup.js must read attended from the request body');
  // Neither is in the required-field checks (only name/email are).
  const requiredChecks = handlerSrc.slice(handlerSrc.indexOf('if (!name)'), handlerSrc.indexOf('try {'));
  t.assert(!/company/.test(requiredChecks) && !/attended/.test(requiredChecks),
    'company and attended must stay optional — not required alongside name/email');
});

t.test('an unrecognized or missing "attended" value is treated as no answer, not an error', () => {
  const idx = handlerSrc.indexOf('attendedRaw');
  const body = handlerSrc.slice(idx, handlerSrc.indexOf('if (!name)'));
  t.assert(/attendedRaw === ["']yes["'] \? true/.test(body) && /attendedRaw === ["']no["'] \? false/.test(body),
    'attended must map "yes"/"no" to true/false and anything else to null, never throw');
});

t.test('publicListSignup never overwrites an existing contact\'s real company name', () => {
  const fn = storeSrc.slice(storeSrc.indexOf('export async function publicListSignup'));
  const body = fn.slice(0, fn.indexOf('\nexport async function', 1));
  t.assert(/cleanCompany && !existing\.company_name/.test(body),
    'a public form must only fill in company_name when the existing contact has none on file — ' +
    'never overwrite a real value with whatever a stranger typed');
});

t.test('an attendance answer becomes its own tag alongside the event tag', () => {
  const fn = storeSrc.slice(storeSrc.indexOf('export async function publicListSignup'));
  const body = fn.slice(0, fn.indexOf('\nexport async function', 1));
  t.assert(/returning attendee/.test(body) && /first-time attendee/.test(body),
    'publicListSignup must tag "returning attendee" or "first-time attendee" based on the answer');
});

/* ---- the public page itself ---- */

if (exists('flyover-con-signup.html')) {
  const pageHtml = read('flyover-con-signup.html');

  t.test('flyover-con-signup.html posts name/email/company/attended/list to /api/mailme/signup', () => {
    t.assert(/\/api\/mailme\/signup/.test(pageHtml), 'the page must POST to /api/mailme/signup');
    t.assert(/list:\s*['"]flyover-con['"]/.test(pageHtml), 'the page must send list: "flyover-con"');
    t.assert(/name:\s*name/.test(pageHtml) && /email:\s*email/.test(pageHtml),
      'the page must send both name and email in the POST body');
    t.assert(/company:\s*company/.test(pageHtml), 'the page must send the company field');
    t.assert(/attended:\s*attendedVal/.test(pageHtml), 'the page must send the attended-before answer');
  });

  t.test('company and attended-before are optional on the page, not required inputs', () => {
    const companyField = pageHtml.slice(pageHtml.indexOf('id="company"') - 60, pageHtml.indexOf('id="company"') + 120);
    t.assert(!/required/.test(companyField), 'the Company input must not be marked required');
    t.assert(/optional/i.test(pageHtml), 'the page should visibly label these fields as optional');
  });

  t.test('flyover-con-signup.html is standalone, not wired into the shell', () => {
    t.assert(!/js\/shell\.js/.test(pageHtml), 'this page must stay outside the shell, like unsubscribe.html');
    t.assert(!/js\/registry\.js/.test(pageHtml), 'this page must stay outside the shell, like unsubscribe.html');
  });

  t.test('the page matches Flyover Con branding: FOC logo asset and its gold accent color', () => {
    t.assert(/foc-peach\.vercel\.app\/assets\/img\/logo/.test(pageHtml),
      'the page should use the real FOC logo asset, not a placeholder');
    t.assert(/#F5A623/i.test(pageHtml), 'the page should use FOC\'s actual gold/amber accent color');
  });
}

/* ---- js/api.js knows about the route for documentation/consistency ---- */

t.test('js/api.js lists mmSignup alongside the other MailMe endpoints', () => {
  const apiSrc = read('js/api.js');
  t.assert(/mmSignup:\s*['"]\/api\/mailme\/signup['"]/.test(apiSrc),
    'js/api.js should list the signup endpoint next to mmUnsubscribe for consistency');
});

process.exit(t.report());
