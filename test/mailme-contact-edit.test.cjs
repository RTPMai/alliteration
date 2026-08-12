// test/mailme-contact-edit.test.cjs
/**
 * Locks the "edit contact details" feature: fixing a prospect's company
 * name, contact name, title, phone, city, or state after import or a public
 * signup. Deliberately PROSPECT-ONLY: client contacts are resolved live from
 * the BackBone roster, lead contacts from BackBone's pipeline, and giving
 * contacts from GivingGauge. None of those are MailMe's to edit — a
 * hand-edit here would look like it worked and then silently disappear (or
 * worse, silently diverge) the next time the owning app's data changed.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const schemaSrc = read('lib/mailme/schema.js');
const contactsSrc = read('api/mailme/contacts.js');
const appSrc = read('apps/mailme.js');

/* ---- schema: what's editable ---- */

t.test('PROSPECT_EDITABLE_FIELDS excludes the dedupe key, tags/status, and import bookkeeping', () => {
  t.assert(/export const PROSPECT_EDITABLE_FIELDS/.test(schemaSrc), 'PROSPECT_EDITABLE_FIELDS is missing');
  const block = schemaSrc.slice(
    schemaSrc.indexOf('export const PROSPECT_EDITABLE_FIELDS'),
    schemaSrc.indexOf(';', schemaSrc.indexOf('export const PROSPECT_EDITABLE_FIELDS'))
  );
  ['company_name', 'contact_name', 'title', 'phone', 'city', 'state'].forEach((f) => {
    t.assert(block.includes(`"${f}"`), `PROSPECT_EDITABLE_FIELDS is missing ${f}`);
  });
  ['email', 'tags', 'status', 'reason', 'prospect_id', 'importedAt', 'importBatch'].forEach((f) => {
    t.assert(!block.includes(`"${f}"`), `PROSPECT_EDITABLE_FIELDS must not include ${f} — it has its own path`);
  });
});

t.test('validateProspectPatch trims and length-caps whatever fields are present', () => {
  t.assert(/export function validateProspectPatch/.test(schemaSrc), 'validateProspectPatch is missing');
  const fn = schemaSrc.slice(schemaSrc.indexOf('export function validateProspectPatch'));
  const body = fn.slice(0, fn.indexOf('\nexport function', 1));
  t.assert(/\.trim\(\)/.test(body), 'validateProspectPatch must trim field values');
  t.assert(/MAX_FIELD_LEN/.test(body), 'validateProspectPatch must cap field length');
});

/* ---- API route ---- */

t.test('the contacts route only allows detail edits on prospect ids', () => {
  t.assert(/hasFieldEdits/.test(contactsSrc), 'contacts.js is missing the field-edit path');
  t.assert(/startsWith\("prospect:"\)/.test(contactsSrc),
    'contacts.js must check the id is a prospect before applying field edits');
  t.assert(/come from BackBone or GivingGauge/.test(contactsSrc),
    'a client/lead/giving edit attempt should explain where to actually fix it');
});

t.test('a field-only PATCH does not fall through to "Nothing to update"', () => {
  const idx = contactsSrc.indexOf('hasFieldEdits');
  const body = contactsSrc.slice(idx, contactsSrc.indexOf('const result = await setContactStatus'));
  t.assert(/if \(hasFieldEdits\) return res\.status\(200\)/.test(body),
    'a request with only company_name/etc changed must succeed, not report nothing to update');
});

t.test('field edits are validated and written via updateProspect, not setContactStatus', () => {
  t.assert(/updateProspect/.test(contactsSrc), 'contacts.js must import and call updateProspect for field edits');
  t.assert(/validateProspectPatch\(body\)/.test(contactsSrc),
    'contacts.js must run field edits through validateProspectPatch');
});

/* ---- front end ---- */

t.test('the shared contact editor only opens for prospect-sourced contacts', () => {
  t.assert(/function openContactEditor/.test(appSrc), 'openContactEditor() is missing');
  const fn = appSrc.slice(appSrc.indexOf('function openContactEditor'));
  const body = fn.slice(0, fn.indexOf('\n    function closeContactEditor'));
  t.assert(/ct\.source !== ['"]prospect['"]/.test(body),
    'openContactEditor must refuse to open for non-prospect contacts');
});

t.test('Edit only appears on prospect rows, in both Contacts and the list members panel', () => {
  t.assert(/data-editct/.test(appSrc), 'Contacts table is missing the per-row Edit trigger');
  t.assert(/data-editmember/.test(appSrc), 'the list members panel is missing the per-row Edit trigger');
  // Both triggers must be gated on source === 'prospect' in their template.
  const editctBlock = appSrc.slice(appSrc.lastIndexOf("ct.source === 'prospect'", appSrc.indexOf('data-editct')));
  t.assert(editctBlock.indexOf('data-editct') - editctBlock.indexOf("ct.source === 'prospect'") < 400,
    'the Contacts table Edit button should be inside the prospect-only branch');
  t.assert(/m\.source === ['"]prospect['"][\s\S]{0,150}data-editmember/.test(appSrc),
    'the list panel Edit button should be gated on the member being a prospect');
});

t.test('saving the editor sends company_name/contact_name/title/phone/city/state to the seam', () => {
  t.assert(/async function saveContactEditor/.test(appSrc), 'saveContactEditor() is missing');
  const fn = appSrc.slice(appSrc.indexOf('async function saveContactEditor'));
  const body = fn.slice(0, fn.indexOf('\n    /* ---------------- lists') > -1
    ? fn.indexOf('\n    /* ---------------- lists')
    : fn.length);
  ['company_name', 'contact_name', 'title', 'phone', 'city', 'state'].forEach((f) => {
    t.assert(body.includes(f), `saveContactEditor is missing ${f}`);
  });
  t.assert(/api\.patch\(ENDPOINTS\.mmContacts/.test(body), 'saveContactEditor must PATCH through ENDPOINTS.mmContacts');
});

t.test('saving refreshes contacts, lists, and a currently-open list members panel', () => {
  const fn = appSrc.slice(appSrc.indexOf('async function saveContactEditor'));
  const body = fn.slice(0, fn.indexOf('async function', fn.indexOf('async function') + 1));
  t.assert(/loadContacts\(\)/.test(body), 'saveContactEditor must reload contacts');
  t.assert(/state\.viewingListId/.test(body),
    'saveContactEditor must refresh the open list members panel if one is showing, so an edited ' +
    'company name updates there too without a manual reopen');
});
