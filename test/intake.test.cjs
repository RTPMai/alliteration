// test/intake.test.cjs
/**
 * Locks the Aug 2026 intake.html <-> api/intake.js schema fix.
 *
 * Before this fix, api/intake.js flattened the POST body into flat
 * clean(body.company, ...) strings, but intake.html (the public wizard) and
 * the Inbox reader in apps/backbone/main.js both already agreed on a nested
 * shape: { submission: { entry, company, contact, project, vision,
 * internal } }, each a nested object (s.company.name, s.contact.email,
 * s.project.details, etc). Every real submission was silently rejected with
 * "A company or a contact is required" until this fix. These tests keep the
 * three files from drifting apart again.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const apiIntake = read('api/intake.js');
const mainJs = read('apps/backbone/main.js');
const intakeHtml = fs.existsSync(path.join(ROOT, 'intake.html'))
  ? read('intake.html')
  : null;

/* ---- the handler must read the nested submission shape ---- */

t.test('the public POST path reads body.submission, not flat body fields', () => {
  t.assert(/body\.submission/.test(apiIntake),
    'api/intake.js no longer reads body.submission — the flat-string regression may be back');
  // Check actual code, not the comment describing the old bug: the old bug
  // looked like `company: clean(body.company, 200)` as an object property.
  t.assert(!/company:\s*clean\(body\.company/.test(apiIntake),
    'api/intake.js is back to flattening body.company into a string; the Inbox expects an object');
});

t.test('stored entry keeps company/contact/project/vision as nested objects', () => {
  t.assert(/company:\s*company/.test(apiIntake), 'stored entry.company must stay a nested object');
  t.assert(/contact:\s*contact/.test(apiIntake), 'stored entry.contact must stay a nested object');
  t.assert(/project:\s*sanitize\(submission\.project/.test(apiIntake),
    'stored entry.project must come from submission.project, not a flattened string');
  t.assert(/vision:\s*sanitize\(submission\.vision/.test(apiIntake),
    'stored entry.vision must come from submission.vision, not a flattened string');
});

t.test('validation checks nested company.name / contact fields, not flat strings', () => {
  t.assert(/company\.name.*contact\.name.*contact\.email.*contact\.phone/s.test(apiIntake) ||
    /clean\(company\.name\)/.test(apiIntake),
    'validation must check company.name / contact fields on the nested objects');
});

t.test('a hostile POST cannot blow up KV value size (sanitize caps strings/arrays/depth)', () => {
  t.assert(/function sanitize/.test(apiIntake), 'the sanitize() size/depth guard is missing');
  t.assert(/MAX_STRING/.test(apiIntake) && /MAX_ARRAY/.test(apiIntake) && /MAX_DEPTH/.test(apiIntake),
    'sanitize() lost one of its caps (string length, array length, or nesting depth)');
});

/* ---- cross-check against what the Inbox actually reads ---- */

t.test('Inbox reads the same nested fields this handler now stores', () => {
  // apps/backbone/main.js renderInbox / renderInquiryBody read s.company.name,
  // s.contact.name, s.entry.existing_client, s.project.details, s.vision.*.
  // If these disappear from main.js the Inbox itself changed shape and this
  // handler (and intake.html) need to follow.
  t.assert(/s\.company\s*&&\s*s\.company\.name/.test(mainJs), 'Inbox no longer reads s.company.name');
  t.assert(/s\.entry\s*\?\s*s\.entry\.existing_client/.test(mainJs), 'Inbox no longer reads s.entry.existing_client');
  t.assert(/p\.details \|\| \{\}/.test(mainJs), 'Inbox no longer reads s.project.details');
});

/* ---- if intake.html is present in the repo, check it still matches ---- */

if (intakeHtml) {
  t.test('intake.html posts the { submission: form } wrapper this handler expects', () => {
    t.assert(/JSON\.stringify\(\{\s*submission:\s*form\s*\}\)/.test(intakeHtml),
      'intake.html no longer wraps its POST body in { submission: form }');
  });

  t.test('intake.html gate values match the Inbox GATE_LABELS keys', () => {
    // intake.html's onclick strings are inside a JS string literal, so the
    // inner quotes are backslash-escaped on disk (pickGate(\'yes\')).
    ['yes', 'yes_new', 'not_sure', 'no', 'manual'].forEach((g) => {
      const re = new RegExp("\\\\?'" + g + "\\\\?'");
      t.assert(re.test(intakeHtml), 'intake.html is missing gate value ' + g);
      t.assert(mainJs.includes(g + ':'), 'main.js GATE_LABELS is missing ' + g);
    });
  });

  t.test('intake.html project type keys match PROJECT_TYPE_LABELS keys', () => {
    ['live_activation', 'just_a_few', 'csg', 'bulk_promo', 'bulk_merch', 'online_store'].forEach((k) => {
      t.assert(intakeHtml.includes('key: "' + k + '"'), 'intake.html is missing project type ' + k);
      t.assert(mainJs.includes(k + ':'), 'main.js PROJECT_TYPE_LABELS is missing ' + k);
    });
  });
} else {
  t.test('intake.html exists in the repo root (public entry point)', () => {
    t.assert(false, 'intake.html is not in the repo yet — the API accepts the right shape but there is no public page to send it');
  });
}

/* ---- art file upload (drag & drop on the vision board step) ---- */

const uploadApi = fs.existsSync(path.join(ROOT, 'api/intake-upload.js'))
  ? read('api/intake-upload.js')
  : null;

if (uploadApi) {
  t.test('the art upload endpoint is public — no getSession/requireAuth gate', () => {
    // Check actual calls, not the file's own explanatory comment about why
    // there's no auth (which mentions requireAuth by name).
    t.assert(!/requireAuth\(req|getSession\(req/.test(uploadApi),
      'api/intake-upload.js gained an auth check — a prospect dropping a file on the public form is never signed in');
  });

  t.test('the art upload endpoint caps file size', () => {
    t.assert(/MAX_BYTES/.test(uploadApi), 'the size cap constant is missing');
    t.assert(/bytes > MAX_BYTES/.test(uploadApi), 'the size cap is defined but never actually checked against the decoded upload');
  });

  t.test('the art upload endpoint validates file type against an allowlist', () => {
    t.assert(/ALLOWED_TYPES/.test(uploadApi), 'the type allowlist is missing');
    t.assert(/application\/pdf/.test(uploadApi) && /image\/(jpeg|png)/.test(uploadApi),
      'the allowlist should cover at least PDF and common image types (art references are usually one or the other)');
  });

  t.test("uploaded files are stored under a distinct intake/ prefix, not mixed into another app's Blob keys", () => {
    t.assert(/intake\/art\//.test(uploadApi),
      'upload keys should live under intake/art/ so they are easy to find/clean up separately from TravelTrack receipts etc');
  });

  t.test('intake.html wires the dropzone to /api/intake-upload', () => {
    t.assert(intakeHtml && /\/api\/intake-upload/.test(intakeHtml),
      'intake.html does not call /api/intake-upload — the dropzone has nothing to upload to');
    t.assert(intakeHtml && /addEventListener\(.drop./.test(intakeHtml),
      'intake.html is missing a drop event listener — drag & drop is not actually wired up');
    t.assert(intakeHtml && /readAsDataURL/.test(intakeHtml),
      'intake.html should read dropped files as a data URL, matching the data-URL shape api/intake-upload.js expects');
  });

  t.test('submission blocks while an upload is still in flight', () => {
    t.assert(intakeHtml && /status === .uploading./.test(intakeHtml),
      'saveVision() should refuse to submit while a file is mid-upload, or a slow upload could get silently dropped from the submission');
  });

  t.test('vision.art_files carries through into the stored entry (nested, not flattened)', () => {
    t.assert(/art_files/.test(apiIntake) || /vision:\s*sanitize\(submission\.vision/.test(apiIntake),
      'api/intake.js must preserve vision.art_files — either explicitly or because it stores submission.vision as a whole nested object');
  });

  t.test('the Inbox renders uploaded art as real links, not escaped plain text', () => {
    const idx = mainJs.indexOf('artFiles');
    t.assert(idx !== -1, 'main.js no longer reads vis.art_files (artFiles variable missing)');
    t.assert(/<a href=/.test(mainJs.slice(idx, idx + 600)),
      'main.js should render vis.art_files as clickable <a> links near where it reads them, not run them through the plain-text kvRows() helper');
  });
} else {
  t.test('api/intake-upload.js exists (art drag & drop endpoint)', () => {
    t.assert(false, 'api/intake-upload.js is missing — the vision board drag & drop has nothing to upload to');
  });
}

process.exit(t.report());
