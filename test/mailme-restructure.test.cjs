/**
 * MailMe restructure tests (Aug 2026).
 *
 * These pin the four things the rewrite was FOR, so a later change cannot
 * quietly undo them:
 *
 *   1. Sending happens on the campaign, not on a screen called Results.
 *   2. There is exactly ONE control deciding who gets an email.
 *   3. The composer is a page, and it shows a live preview.
 *   4. Four tabs, and Import is not one of them.
 *
 * The preview renderer is exercised for real against the SENDER's own
 * formatter, because that is the one place a second implementation was
 * deliberately allowed and drift there is invisible until someone sends
 * something that does not look like what they wrote.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const src = read('apps/mailme.js');

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* ---- 1. sending moved off the results screen -------------------------- */

t.test('the Send button lives on the campaign, not on the reports screen', () => {
  // THE headline fix. Sending used to mean: save a draft, close the modal,
  // find the row, open a panel called Results, then send from there.
  const bar = src.slice(src.indexOf('<div class="mm-sendbar">'));
  const block = bar.slice(0, bar.indexOf('</div>\n        <div id="mmComposeMsg">'));
  t.assert(/id="mmSendCampaign"/.test(block),
    'the Send button must be in the campaign send bar');

  const reports = src.slice(src.indexOf('async function showReport'));
  const rbody = reports.slice(0, reports.length);
  t.assert(!/mmSendCampaign/.test(rbody),
    'the reports screen must not carry a Send button any more');
  t.assert(!/action: 'send'/.test(rbody) && !/action: "send"/.test(rbody),
    'the reports screen must not be able to trigger a send at all');
});

t.test('reports only shows campaigns that actually went out', () => {
  // An empty stats table for a draft was noise that made the real ones
  // harder to read, and it is what made Results look like a place you go
  // BEFORE sending rather than after.
  t.assert(/function reportableCampaigns/.test(src), 'reportableCampaigns() is missing');
  const fn = src.slice(src.indexOf('function reportableCampaigns'));
  const body = fn.slice(0, fn.indexOf('\n    function renderReports'));
  t.assert(/'sent'/.test(body) && /'sending'/.test(body),
    'sent and in-flight campaigns are the reportable ones');
  t.assert(!/'draft'/.test(body), 'a draft has nothing to report and must not appear');
});

t.test('the send button starts disabled and is only enabled by the server verdict', () => {
  // canSend/sendBlockers are computed fresh server-side on every load. A
  // draft can sit for weeks, so a cached "ready" from when it was written is
  // exactly the thing not to trust: a domain can stop being verified in
  // between.
  t.assert(/id="mmSendCampaign" disabled/.test(src),
    'the Send button must render disabled and be enabled deliberately');
  const fn = src.slice(src.indexOf('function renderReadyBlock'));
  const body = fn.slice(0, fn.indexOf('\n    function renderPreview'));
  t.assert(/detail\.sendBlockers/.test(body),
    'readiness must come from the server-computed sendBlockers');
  t.assert(/btn\.disabled = false/.test(body),
    'the button is only ever enabled after the blocker checks pass');
  t.assert(/blockers\.length/.test(body) && /return/.test(body),
    'any blocker must stop before the button is enabled');
});

t.test('a send saves first, so the last edit is what goes out', () => {
  const fn = src.slice(src.indexOf('async function triggerSend'));
  const body = fn.slice(0, fn.indexOf('\n    async function deleteCampaign'));
  t.assert(/saveCampaign\(\{ silent: true \}\)/.test(body),
    'triggerSend must save before dispatch, or an unsaved edit is silently dropped');
  t.assert(/window\.confirm/.test(body), 'a real send must be confirmed');
  t.assert(/cannot be taken back/.test(body),
    'the confirmation should say the thing that makes it different from Save');
});

/* ---- 2. one audience control ------------------------------------------ */

t.test('there is ONE control deciding who gets the email', () => {
  // Was three: an Audience dropdown, a Send-to-list dropdown, and a
  // free-text Tags box, with a hidden precedence rule ("tags are ignored
  // when a list is chosen"). Three controls for one question.
  t.assert(/id="mmAudience"/.test(src), 'the single audience picker is missing');
  t.assert(!/id="mmSource"/.test(src), 'the separate source dropdown should be gone');
  t.assert(!/id="mmList"\b/.test(src), 'the separate list dropdown should be gone');
  t.assert(!/id="mmSegment"/.test(src), 'the free-text tags box should be gone');
});

t.test('the one picker offers both standing audiences and saved lists', () => {
  t.assert(/const QUICK_AUDIENCES/.test(src), 'QUICK_AUDIENCES is missing');
  const block = src.slice(src.indexOf('const QUICK_AUDIENCES'), src.indexOf('export default'));
  ['client', 'lead', 'giving', 'prospect', 'all'].forEach((s) => {
    t.assert(new RegExp("source: '" + s + "'").test(block),
      'the picker is missing the ' + s + ' audience');
  });
  const fn = src.slice(src.indexOf('function renderComposer'));
  t.assert(/state\.lists\.map/.test(fn.slice(0, 6000)),
    'saved lists must appear in the same picker, not a second one');
});

t.test('choosing an audience retires any legacy tag targeting', () => {
  // Old drafts may still carry segmentTags. Leaving them set alongside a new
  // audience would be two rules fighting over one campaign, which is the
  // precedence bug this rewrite removed.
  const fn = src.slice(src.indexOf("const aud = $('#mmAudience')"));
  const body = fn.slice(0, fn.indexOf("const ident = $('#mmIdentity')"));
  t.assert(/d\.segmentTags = \[\]/.test(body),
    'picking an audience must clear legacy tags rather than leaving both active');
  t.assert(/d\.listId = null/.test(body),
    'picking a standing audience must clear any previously chosen list');
});

t.test('a legacy tag-targeted draft says so instead of silently disagreeing', () => {
  // Its recipient count comes from the tags, not the audience label, so
  // showing the label alone would be a number that does not match the words
  // next to it.
  t.assert(/still uses tags/.test(src),
    'a draft still using tags must explain itself in the composer');
  const fn = src.slice(src.indexOf('function audienceLabel'));
  const body = fn.slice(0, fn.indexOf('\n    function renderCampaignList'));
  t.assert(/segmentTags/.test(body),
    'the campaign list row must reflect tag targeting too, not just the composer');
});

t.test('the sending brand is chosen FOR the audience, not left to warn afterwards', () => {
  // Cold traffic on the domain that also carries quotes and invoices is the
  // one mistake here that damages something you cannot repair quickly.
  t.assert(/function defaultIdentityFor/.test(src), 'defaultIdentityFor() is missing');
  const fn = src.slice(src.indexOf('function defaultIdentityFor'));
  const body = fn.slice(0, fn.indexOf('\n    function stepState'));
  t.assert(/audienceIsCold\(d\)/.test(body),
    'the default brand must depend on whether the audience is cold');
  t.assert(/i\.cold/.test(body), 'a cold audience must prefer a cold-marked brand');

  const aud = src.slice(src.indexOf("const aud = $('#mmAudience')"));
  t.assert(/d\.identityKey = defaultIdentityFor\(d\)/.test(aud.slice(0, 1200)),
    'changing the audience must re-pick the safe brand');
});

/* ---- 3. the composer is a page with a live preview -------------------- */

t.test('the composer is a pane, and the campaign list hides behind it', () => {
  t.assert(/id="mmComposeView"/.test(src), 'the workspace pane is missing');
  t.assert(/id="mmCampaignListPane"/.test(src), 'the list pane is missing');
  const fn = src.slice(src.indexOf('function renderComposer'));
  const body = fn.slice(0, fn.indexOf('\n    // Everything standing between'));
  t.assert(/listPane\.hidden = true/.test(body) && /pane\.hidden = false/.test(body),
    'opening a campaign must swap the list for the workspace');
  t.assert(/listPane\.hidden = false/.test(body),
    'closing it must bring the list back, or Back is a dead end');
});

t.test('every step reports its own readiness, including "not answered yet"', () => {
  // Three states, not two. A pending server answer must not show a warning
  // marker that resolves itself a moment later.
  t.assert(/function stepMark/.test(src), 'stepMark() is missing');
  const fn = src.slice(src.indexOf('function stepMark'));
  const body = fn.slice(0, fn.indexOf('\n    function stepHtml'));
  t.assert(/done === null/.test(body),
    'a not-yet-known step must render differently from a failing one');
});

t.test('typing updates the preview without a round trip', () => {
  const fn = src.slice(src.indexOf('function wireComposer'));
  const body = fn.slice(0, fn.indexOf('\n    function paintAudienceHints'));
  t.assert(/'input'/.test(body), 'the editor fields must repaint on input');
  t.assert(/renderPreview\(\)/.test(body), 'input must drive the preview');
  t.assert(!/await api\./.test(body.slice(body.indexOf("'#mmBody'"))),
    'the preview must not fetch on every keystroke');
});

t.test('the preview renders against a real recipient, not a placeholder', () => {
  // A merge tag that reads fine as "{{first_name}}" and then goes out blank
  // is the failure this prevents.
  const fn = src.slice(src.indexOf('function renderPreview'));
  const body = fn.slice(0, fn.indexOf('\n    /* ---------------- composer wiring'));
  t.assert(/state\.contacts\.find/.test(body),
    'the preview should personalize against an actual contact');
  t.assert(/SUPPRESSED\.includes/.test(body),
    'and not against someone who could never receive it');
});

t.test('formatting is inserted at the cursor rather than explained in a hint', () => {
  t.assert(/function insertToken/.test(src), 'insertToken() is missing');
  const fn = src.slice(src.indexOf('function insertToken'));
  const body = fn.slice(0, fn.indexOf('\n    /* ---------------- campaign actions'));
  ['bold', 'link', 'bullet', 'first', 'company'].forEach((k) => {
    t.assert(new RegExp('\\b' + k + ':').test(body), 'insertToken is missing ' + k);
  });
  t.assert(/setSelectionRange/.test(body),
    'the cursor must land on the text you are meant to replace, not after it');
});

/* ---- 4. four tabs, import is a button --------------------------------- */

t.test('Import is a button on Audience, not a permanent tab', () => {
  t.assert(/id="mmImportBtn"/.test(src), 'the Import button is missing');
  t.assert(!/id="mmImportView"/.test(src), 'the Import tab should be gone');
  t.assert(/openImport/.test(src), 'import must open on demand');
  t.assert(/'import'\)/.test(src), 'import should render in the shared modal');
});

t.test('settings is split into tabs rather than one form of four subjects', () => {
  t.assert(/const SETTINGS_TABS/.test(src), 'SETTINGS_TABS is missing');
  ['brands', 'compliance', 'limits'].forEach((k) => {
    t.assert(new RegExp("\\['" + k + "'").test(src), 'settings is missing the ' + k + ' tab');
  });
});

t.test('switching a settings tab does not eat what was typed on another', () => {
  // The classic tabbed-form bug: a save that sends only the visible fields
  // blanks the rest, or a tab switch discards them.
  t.assert(/function collectSettingsInto/.test(src), 'collectSettingsInto() is missing');
  const fn = src.slice(src.indexOf('function collectSettingsInto'));
  const body = fn.slice(0, fn.indexOf('\n    async function saveSettings'));
  t.assert(/if \(\$\('#setCompany'\)\)/.test(body) && /if \(\$\('#setFreq'\)\)/.test(body),
    'each block must only be collected when its fields are actually on screen');

  const tabs = src.slice(src.indexOf('function renderSettingsTabs'));
  t.assert(/collectSettingsInto\(state\.settings\)/.test(tabs.slice(0, 1200)),
    'a tab switch must capture the current fields before repainting');
});

t.test('reorder timing is gone from MailMe settings and says where it went', () => {
  t.assert(!/id="setDue"/.test(src) && !/id="setLapsed"/.test(src),
    'the reorder timing fields should no longer be editable here');
  t.assert(/BackBone/.test(src) && /Reorder timing/.test(src),
    'MailMe should point at where the setting actually lives now');
});

/* ---- Aug 19: audience rework --------------------------------------------
 *
 * Chips out, dropdowns in; multi-select in; two columns out; manual add in;
 * imports land in a list. Each of these replaced something that only worked
 * at small scale, so the tests say what broke rather than just what exists.
 */

t.test('filtering is three dropdowns, not three rows of chips', () => {
  t.assert(/function renderPickers/.test(src), 'renderPickers() is missing');
  t.assert(!/mm-listrail/.test(src), 'the list chip rail should be gone');
  const defs = src.slice(src.indexOf('function pickerOptions'), src.indexOf('function renderPickers'));
  ['list', 'source', 'status'].forEach((k) => {
    t.assert(new RegExp('\\b' + k + ': \\{').test(defs), 'the ' + k + ' picker is missing');
  });
});

t.test('the picker only shows a search box when there is enough to search', () => {
  // A filter box over four options is furniture. Over thirty lists it is the
  // only way to find anything.
  t.assert(/const SEARCH_THRESHOLD/.test(src), 'SEARCH_THRESHOLD is missing');
  const fn = src.slice(src.indexOf('function togglePicker'));
  const body = fn.slice(0, fn.indexOf('async function choosePicker'));
  t.assert(/d\.options\.length > SEARCH_THRESHOLD/.test(body),
    'the search box must be conditional on the option count');
  t.assert(/data-pfilter/.test(body), 'the filter input is missing');
});

t.test('only one picker popup can be open at a time', () => {
  const fn = src.slice(src.indexOf('function togglePicker'));
  const body = fn.slice(0, fn.indexOf('async function choosePicker'));
  t.assert(/closePicker\(\)/.test(body), 'opening a picker must close whatever else was open');
  t.assert(/setTimeout\(\(\) => document\.addEventListener/.test(body),
    'the outside-click handler must be deferred, or the opening click closes it again');
});

t.test('selection survives a re-render', () => {
  // Reading checkboxes off the DOM means a sort, a closed modal or a refresh
  // silently drops what someone picked, and the next bulk action is wrong in
  // a way nobody can see.
  t.assert(/selected: new Set\(\)/.test(src), 'selection must live on state as a Set of ids');
  const fn = src.slice(src.indexOf('function selectedContacts'));
  const body = fn.slice(0, fn.indexOf('function renderBulkBar'));
  t.assert(/state\.selected\.forEach/.test(body),
    'the selection must be resolved from state, not from checked inputs');
});

t.test('the select-all box is tri-state, so it cannot lie about a partial pick', () => {
  // A plain checked/unchecked box on a partial selection makes someone click
  // it expecting to add the rest and instead clear everything.
  const fn = src.slice(src.indexOf('function paintSelectAll'));
  const body = fn.slice(0, fn.indexOf('function selectedContacts'));
  t.assert(/indeterminate/.test(body), 'a partial selection must render as indeterminate');
  t.assert(/picked === rows\.length/.test(body),
    'checked must mean every visible row, not merely some');
});

t.test('a stale selection cannot outlive the rows it pointed at', () => {
  const fn = src.slice(src.indexOf('async function refreshAudience'));
  const body = fn.slice(0, fn.indexOf('/* ---------------- contact detail editor'));
  t.assert(/state\.selected\.delete/.test(body),
    'ids that no longer resolve must be dropped, or a bulk action hits ghosts');
});

t.test('bulk work is sequential, not a hundred parallel writes', () => {
  // Parallel PATCHes against the same KV keys is how you get last-write-wins
  // clobbering, and a progress count is only honest if the calls are serial.
  const fn = src.slice(src.indexOf('async function runBulk'));
  const body = fn.slice(0, fn.indexOf('async function bulkAddToList'));
  t.assert(/for \(const item of items\)/.test(body), 'bulk work must run one at a time');
  t.assert(/await fn\(item\)/.test(body), 'and await each one');
  t.assert(/failures/.test(body), 'partial failure must be reported, not swallowed');
});

t.test('bulk remove reloads once, not once per contact', () => {
  const fn = src.slice(src.indexOf('async function removeListMember'));
  const body = fn.slice(0, fn.indexOf('async function addListMemberByEmail'));
  t.assert(/quiet/.test(body), 'removeListMember must support a quiet mode for bulk runs');
  t.assert(/if \(quiet\) throw e/.test(body),
    'in quiet mode the error must reach the bulk runner rather than being swallowed');
});

t.test('adding people to a new list makes a STATIC one', () => {
  // A rule would be a guess at why these particular people were picked, and
  // would then pull in strangers who happened to match it.
  const fn = src.slice(src.indexOf('async function bulkAddToList'));
  const body = fn.slice(0, fn.indexOf('async function bulkRemoveFromList'));
  t.assert(/kind: 'static'/.test(body), 'a hand-picked list must be static');
  t.assert(/usesTagMechanism\(existing\)/.test(body),
    'adding to an existing tag-based list must still go through its tags');
  t.assert(/excludedMembers/.test(body),
    'adding to a rule-based list must clear any prior exclusion, or the two cancel out');
});

t.test('contacts can be added by hand, and only ever as a prospect', () => {
  // Letting MailMe mint a client would put a customer record somewhere the
  // rest of the shell cannot see it.
  t.assert(/function openAddContact/.test(src), 'openAddContact() is missing');
  t.assert(/id="mmAddContactBtn"/.test(src), 'the Add contact button is missing');
  const fn = src.slice(src.indexOf('async function saveNewContact'));
  const body = fn.slice(0, fn.indexOf('/* ---------------- import'));
  t.assert(/api\.post\(ENDPOINTS\.mmContacts/.test(body),
    'a manual add must go through the contacts endpoint, which creates prospects');
  t.assert(/res\.created/.test(body),
    'an address that already exists must be reported as reused, not duplicated');
});

t.test('the create route accepts the fields the add form collects', () => {
  // Otherwise adding someone by hand and then reopening them to fill in a
  // phone number is two steps for one job.
  const api = read('api/mailme/contacts.js');
  const post = api.slice(api.indexOf('if (req.method === "POST")'), api.indexOf('if (req.method === "PATCH")'));
  ['title', 'phone', 'city', 'state'].forEach((f) => {
    t.assert(new RegExp('body\\.' + f).test(post),
      'POST /contacts drops ' + f + ', so the add form would silently lose it');
  });
});

t.test('an import can land straight in a list, and warns when it will not', () => {
  // Without this an imported batch dissolves into the roster and there is no
  // way to find those people again as a group.
  t.assert(/id="mmImportList"/.test(src), 'the import list field is missing');
  t.assert(/function listForBatch/.test(src), 'listForBatch() is missing');
  const fn = src.slice(src.indexOf('async function commitImport'));
  const body = fn.slice(0, fn.indexOf('async function listForBatch'));
  t.assert(/without putting them in a list/.test(body),
    'importing with no list must ask first, since it is the harder thing to undo');

  const lf = src.slice(src.indexOf('async function listForBatch'));
  const lbody = lf.slice(0, lf.indexOf('function rejectTable'));
  t.assert(/importBatch === batchId/.test(lbody),
    'the list must be built from the batch the server stamped, not a client guess');
  t.assert(/extraMembers/.test(lbody),
    'importing into a rule-based list must record exceptions rather than doing nothing');
});

t.test('a failed list creation does not hide a successful import', () => {
  // The contacts are in either way. Reporting the whole thing as failed would
  // send someone off to re-import people who are already there.
  const fn = src.slice(src.indexOf('async function commitImport'));
  const body = fn.slice(0, fn.indexOf('async function listForBatch'));
  t.assert(/could not be created/.test(body),
    'a list failure must be reported separately from the import result');
});

/* ---- the deliberate second implementation ----------------------------- */

(async () => {
  // The preview formatter is a copy of the sender's. It is allowed to exist
  // because a round trip per keystroke is not a preview, but a copy that
  // drifts is worse than no preview: it shows one thing and sends another.
  // So it is checked against the real sender output rather than eyeballed.
  const send = await import('../lib/mailme/send.js');

  const contact = { contact_name: 'Dave Ellis', company_name: 'Acme Signs' };

  t.test('merge tags resolve exactly as the sender resolves them', () => {
    // The preview's personalizer is evaluated out of the app source and run
    // against the same inputs as the sender's, rather than pattern-matched.
    const escSrc = src.slice(src.indexOf('function esc(s)'), src.indexOf('function fmtDate'));
    const pvSrc = src.slice(src.indexOf('function previewPersonalize'), src.indexOf('export default'));
    // eslint-disable-next-line no-new-func
    const previewPersonalize = new Function(escSrc + pvSrc + '; return previewPersonalize;')();

    const cases = [
      ['Hi {{first_name}},', contact],
      ['For {{company_name}} this year', contact],
      ['Hi {{ first_name }} at {{company_name}}', contact],
      // Whoever has no name must fall back identically, or the preview reads
      // fine and the real email says "Hi ,".
      ['Hi {{first_name}}', { company_name: 'X' }],
      // And no company must not print the word "undefined" in either.
      ['For {{company_name}}', { contact_name: 'Sam' }],
    ];
    cases.forEach(([text, who]) => {
      t.equal(previewPersonalize(text, who), send.personalize(text, who),
        'preview and sender disagree on: ' + JSON.stringify(text));
    });
  });

  t.test('the preview and the sender agree on bold, links, bullets and bare URLs', () => {
    // buildHtml wraps the body in a container and a footer, so the check is
    // that the sender's output CONTAINS what the preview produced for the
    // same input, not that the two strings are identical.
    const settings = { companyName: 'P&M', postalAddress: {}, unsubscribeUrl: '' };
    const samples = [
      'Order by **Sept 12** to be safe.',
      'See [our catalog](https://example.com/catalog) for details.',
      'Visit www.example.com today.',
      'Full link https://example.com/page here.',
      '- first item\n- second item',
      'A line\nwith a break',
    ];

    // Pull the preview renderer out of the app source. It is module-scoped
    // and not exported (the app is a browser ES module with a default export
    // only), so it is evaluated here rather than imported.
    const start = src.indexOf('function escapeAttr(s)');
    const end = src.indexOf('export default');
    const previewSrc = src.slice(start, end);
    const escSrc = src.slice(src.indexOf('function esc(s)'), src.indexOf('function fmtDate'));
    // eslint-disable-next-line no-new-func
    const makePreview = new Function(escSrc + previewSrc + '; return previewBody;');
    const previewBody = makePreview();

    samples.forEach((input) => {
      const sent = send.buildHtml({ body: input }, contact, settings, 'tok');
      const shown = previewBody(input);
      // Strip the sender's inline style attributes: the preview themes its
      // own links through tokens.css, which is a deliberate difference and
      // not drift in the formatting rules.
      const norm = (s) => s.replace(/ style="[^"]*"/g, '').replace(/\s+/g, ' ').trim();
      t.assert(norm(sent).includes(norm(shown)),
        'preview and sender disagree on: ' + JSON.stringify(input) +
        '\n  sender:  ' + norm(sent) +
        '\n  preview: ' + norm(shown));
    });
  });

  t.test('the preview escapes HTML the same way the sender does', () => {
    const settings = { companyName: 'P&M', postalAddress: {}, unsubscribeUrl: '' };
    const nasty = 'Look <script>alert(1)</script> & "quotes"';
    const sent = send.buildHtml({ body: nasty }, contact, settings, 'tok');
    t.assert(!/<script>/.test(sent), 'the sender must escape script tags');

    const start = src.indexOf('function escapeAttr(s)');
    const end = src.indexOf('export default');
    const escSrc = src.slice(src.indexOf('function esc(s)'), src.indexOf('function fmtDate'));
    // eslint-disable-next-line no-new-func
    const previewBody = new Function(escSrc + src.slice(start, end) + '; return previewBody;')();
    t.assert(!/<script>/.test(previewBody(nasty)),
      'the preview must escape script tags too, or it renders what the email will not');
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
