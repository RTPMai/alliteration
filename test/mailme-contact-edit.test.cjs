// test/mailme-contact-edit.test.cjs
/**
 * Locks the "edit contact details" feature: fixing a wrong company name,
 * contact name, title, phone, city, or state on ANY contact, regardless of
 * source.
 *
 * The critical property is not "who can be edited" (that's now everyone) but
 * WHERE the edit lands:
 *   - prospect            -> MailMe's own record (updateProspect).
 *   - client / lead / giving -> MailMe's own overrides map, layered on top
 *     of what BackBone/GivingGauge resolved. The owning app's real record is
 *     NEVER written — see the "mailme never writes the backbone_data key"
 *     and storage-prefix tests in mailme.test.cjs for the enforcement of
 *     that at the storage layer. This file locks the API/UI side: that a
 *     correction is accepted for every source, and that it's applied as an
 *     overlay rather than blocked or silently dropped.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const schemaSrc = read('lib/mailme/schema.js');
const contactsSrc = read('api/mailme/contacts.js');
const storeSrc = read('lib/mailme/store.js');
const appSrc = read('apps/mailme.js');

/* ---- schema: what's editable ---- */

t.test('CONTACT_DETAIL_FIELDS excludes the dedupe key, tags/status, and import bookkeeping', () => {
  t.assert(/export const CONTACT_DETAIL_FIELDS/.test(schemaSrc), 'CONTACT_DETAIL_FIELDS is missing');
  const block = schemaSrc.slice(
    schemaSrc.indexOf('export const CONTACT_DETAIL_FIELDS'),
    schemaSrc.indexOf(';', schemaSrc.indexOf('export const CONTACT_DETAIL_FIELDS'))
  );
  ['company_name', 'contact_name', 'title', 'phone', 'city', 'state'].forEach((f) => {
    t.assert(block.includes(`"${f}"`), `CONTACT_DETAIL_FIELDS is missing ${f}`);
  });
  ['email', 'tags', 'status', 'reason', 'prospect_id', 'importedAt', 'importBatch'].forEach((f) => {
    t.assert(!block.includes(`"${f}"`), `CONTACT_DETAIL_FIELDS must not include ${f} — it has its own path`);
  });
});

t.test('validateContactDetailPatch trims and length-caps whatever fields are present', () => {
  t.assert(/export function validateContactDetailPatch/.test(schemaSrc), 'validateContactDetailPatch is missing');
  const fn = schemaSrc.slice(schemaSrc.indexOf('export function validateContactDetailPatch'));
  const body = fn.slice(0, fn.indexOf('\nexport function', 1));
  t.assert(/\.trim\(\)/.test(body), 'validateContactDetailPatch must trim field values');
  t.assert(/MAX_FIELD_LEN/.test(body), 'validateContactDetailPatch must cap field length');
});

/* ---- API route: no source restriction any more ---- */

t.test('the contacts route accepts detail edits for any source, not just prospects', () => {
  t.assert(/hasFieldEdits/.test(contactsSrc), 'contacts.js is missing the field-edit path');
  const patchBlock = contactsSrc.slice(
    contactsSrc.indexOf('if (req.method === "PATCH")'),
    contactsSrc.indexOf('if (req.method === "DELETE")')
  );
  t.assert(!/startsWith\("prospect:"\)/.test(patchBlock),
    'the PATCH block should no longer gate field edits on the id being a prospect — client/lead/giving are allowed now');
  t.assert(/CONTACT_DETAIL_FIELDS/.test(contactsSrc) && /validateContactDetailPatch/.test(contactsSrc),
    'contacts.js must validate field edits through CONTACT_DETAIL_FIELDS/validateContactDetailPatch');
});

t.test('detail edits route through the SAME setContactStatus call as status/tags, not a separate path', () => {
  t.assert(/await setContactStatus\(id, patch, sess\)/.test(contactsSrc),
    'contacts.js should merge detail fields into one patch object and make one setContactStatus call');
  t.assert(!/updateProspect/.test(contactsSrc),
    'contacts.js should no longer call updateProspect directly — that branching now lives in setContactStatus');
});

/* ---- store: where each source's edit actually lands ---- */

t.test('setContactStatus writes prospect detail edits to the prospect record itself', () => {
  const fn = storeSrc.slice(storeSrc.indexOf('export async function setContactStatus'));
  const body = fn.slice(0, fn.indexOf('\n// ---- Lists'));
  t.assert(/source === "prospect"/.test(body) && /updateProspect\(localId, prospectPatch\)/.test(body),
    'a prospect edit must still go to updateProspect against its own record');
});

t.test('setContactStatus writes client/lead/giving detail edits to MailMe\'s own overrides map, never to the source app', () => {
  const fn = storeSrc.slice(storeSrc.indexOf('export async function setContactStatus'));
  const body = fn.slice(0, fn.indexOf('\n// ---- Lists'));
  t.assert(/getContactOverrides\(\)/.test(body) && /writeKey\(keys\.contactOverrides\(\), all\)/.test(body),
    'client/lead/giving edits must be written into MailMe\'s own contactOverrides map');
  t.assert(!/writeKey\(["']backbone_data["']/.test(storeSrc) && !/writeKey\(["']backbone_leads["']/.test(storeSrc),
    'MailMe must never write back to backbone_data or backbone_leads, regardless of this feature');
});

t.test('resolveContacts applies a saved override on top of the resolved base value for client/lead/giving', () => {
  // Each source's push into `contacts` should prefer its override object's
  // field over the raw resolved value, e.g. `ov.company_name || c.company_name`.
  ['ov.company_name || c.company_name', 'lov.company_name || l.company_name', 'gov.company_name || req.orgName']
    .forEach((snippet) => {
      t.assert(storeSrc.includes(snippet), `resolveContacts is missing the override precedence: ${snippet}`);
    });
});

/* ---- front end ---- */

t.test('the shared contact editor opens for every source now, not just prospects', () => {
  t.assert(/function openContactEditor/.test(appSrc), 'openContactEditor() is missing');
  const fn = appSrc.slice(appSrc.indexOf('function openContactEditor'));
  const body = fn.slice(0, fn.indexOf('\n    function closeContactEditor'));
  t.assert(!/ct\.source !== ['"]prospect['"]/.test(body),
    'openContactEditor must no longer refuse non-prospect contacts');
});

t.test('the editor explains that a non-prospect edit is a MailMe-local overlay, not a change to the source app', () => {
  t.assert(/does not change/.test(appSrc) && /original record/.test(appSrc),
    'the editor should tell the user a client/lead/giving edit only affects what MailMe shows, ' +
    'not the record BackBone/GivingGauge actually owns');
});

t.test('Edit appears on every row, in both Contacts and the list members panel', () => {
  t.assert(/data-editct="\$\{esc\(ct\.id\)\}">Edit</.test(appSrc),
    'the Contacts table Edit button should render unconditionally, not gated on source');
  t.assert(/data-editmember="\$\{esc\(m\.id\)\}">Edit</.test(appSrc),
    'the list members panel Edit button should render unconditionally, not gated on source');
});

t.test('Delete stays prospect-only (deleting a client/lead/giving contact makes no sense here)', () => {
  t.assert(/ct\.source === ['"]prospect['"][\s\S]{0,120}data-del/.test(appSrc),
    'Delete must still be gated to prospects only — client/lead/giving contacts cannot be deleted from MailMe');
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

process.exit(t.report());
