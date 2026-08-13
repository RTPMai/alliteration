/**
 * MailMe contract tests.
 *
 * Two categories here, and the second is the important one.
 *
 * CONTRACT: the same checks every other app gets — module shape, seam usage,
 * root-scoped DOM lookups, tokens block.
 *
 * SAFETY: MailMe holds the customer email list and the suppression ledger,
 * and it is one provider API key away from being able to mail 2,500 real
 * customers. These tests lock down the properties that keep that safe:
 *
 *   - suppression is enforced BEFORE segment filtering, so no ordering of
 *     filters can produce a recipient who unsubscribed
 *   - bounce/complaint states cannot be set or cleared by hand
 *   - a plain PATCH/POST can never change a campaign's status; the ONLY path
 *     that can send is the dedicated send action, gated on the same MailMe
 *     edit access as building a draft, and it re-checks compliance, domain
 *     verification and suppression itself right before dispatch
 *   - the API routes gate on MailMe access server-side, not just in the rail
 *
 * If a future change makes one of these fail, that is the test working.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// Strip comments so a rule's prose explanation can't satisfy its own test.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* ---- Contract ---------------------------------------------------------- */

t.test('mailme is built and follows the app contract', () => {
  t.assert(exists('apps/mailme.js'), 'apps/mailme.js is missing');
  const src = read('apps/mailme.js');
  ['export default', "id: 'mailme'", 'mount', 'showView', 'styles', 'template']
    .forEach((k) => t.assert(src.includes(k), 'mailme.js is missing ' + k));
});

t.test('mailme registry entry is no longer a stub', () => {
  const src = read('js/registry.js');
  const entry = src.slice(src.indexOf("id: 'mailme'"));
  const block = entry.slice(0, entry.indexOf('},'));
  t.assert(/stub:\s*false/.test(block), 'mailme should be un-stubbed now that it is built');
});

t.test('mailme declares its three views', () => {
  const src = read('js/registry.js');
  const entry = src.slice(src.indexOf("id: 'mailme'"));
  const block = entry.slice(0, entry.indexOf('},'));
  ['dashboard', 'contacts', 'campaigns'].forEach((v) => {
    t.assert(block.includes("'" + v + "'"), 'mailme registry is missing the ' + v + ' view');
  });
});

t.test('mailme fetches through the seam', () => {
  const src = stripComments(read('apps/mailme.js'));
  t.assert(!src.match(/\bfetch\s*\(/), 'mailme.js must not call fetch() directly');
  t.assert(src.includes("from '../js/api.js'"), 'mailme.js should import ENDPOINTS from the seam');
});

t.test('mailme scopes DOM lookups to its root', () => {
  const src = stripComments(read('apps/mailme.js'));
  t.assert(!src.includes('document.getElementById'),
    'mailme.js should use ctx.root, not document.getElementById (other apps are mounted too)');
  t.assert(!src.includes('document.querySelector'),
    'mailme.js should scope querySelector to ctx.root');
});

t.test('mailme endpoints are wired and marked live', () => {
  const src = read('js/api.js');
  t.assert(/mmContacts:\s*'\/api\/mailme\/contacts'/.test(src),
    'ENDPOINTS.mmContacts is missing');
  t.assert(/mmCampaigns:\s*'\/api\/mailme\/campaigns'/.test(src),
    'ENDPOINTS.mmCampaigns is missing');
  t.assert(src.includes("'/api/mailme/'"),
    "'/api/mailme/' must be in LIVE_PREFIXES or the app runs on mock data in production");
});

t.test('the seam exposes a patch helper', () => {
  // MailMe's contact updates are PATCHes. Without this export the app would
  // fall back to the wrong verb and every status change would 405.
  const src = read('js/api.js');
  t.assert(/export const patch\s*=/.test(src), 'js/api.js must export patch()');
  t.assert(/request, get, post, put, patch, del/.test(src),
    'patch() must also be on the default export');
});

/* ---- Safety ------------------------------------------------------------ */

t.test('mailme API routes require auth AND app-level access', () => {
  ['contacts', 'campaigns'].forEach((name) => {
    const src = read('api/mailme/' + name + '.js');
    t.assert(src.includes('requireAuth'),
      'api/mailme/' + name + '.js must call requireAuth');
    t.assert(src.includes('requireMailMe'),
      'api/mailme/' + name + '.js must gate on MailMe access server-side, ' +
      'not rely on the rail hiding the app');
  });
});

/* selectRecipients is the one function where a bug means emailing someone who
   asked not to be. It is exercised for real, not pattern-matched. schema.js is
   ESM and this harness is CJS, so it is loaded via dynamic import below and
   the assertions run inside runSelectRecipientsTests(). */

function makeContacts() {
  return [
    { customer_id: '1', email: 'a@x.com', status: 'subscribed',   tags: ['vip'] },
    { customer_id: '2', email: 'b@x.com', status: 'subscribed',   tags: [] },
    { customer_id: '3', email: 'c@x.com', status: 'unsubscribed', tags: ['vip'] },
    { customer_id: '4', email: 'd@x.com', status: 'bounced',      tags: ['vip'] },
    { customer_id: '5', email: 'e@x.com', status: 'complained',   tags: ['vip'] },
    { customer_id: '6', email: 'f@x.com', status: 'subscribed',   tags: ['VIP  '] }
  ];
}

function runSelectRecipientsTests(selectRecipients) {
  const ids = (rows) => rows.map((r) => r.customer_id).sort().join(',');

  t.test('an empty segment means everyone MAILABLE, not everyone', () => {
    const out = selectRecipients(makeContacts(), { segmentTags: [] });
    t.equal(ids(out), '1,2,6', 'suppressed contacts must never be included');
  });

  t.test('a segment never resurrects a suppressed contact', () => {
    // Contacts 3, 4 and 5 all carry the "vip" tag AND are suppressed. A tag
    // filter applied before suppression would return them; this is the exact
    // regression the ordering exists to prevent.
    const out = selectRecipients(makeContacts(), { segmentTags: ['vip'] });
    t.equal(ids(out), '1,6', 'unsubscribed/bounced/complained must stay excluded');
  });

  t.test('tag matching is case and whitespace insensitive', () => {
    // Contact 6 carries "VIP  ". Without normalizing, segmenting on "vip"
    // would silently drop them from a send they belong in.
    const out = selectRecipients(makeContacts(), { segmentTags: ['VIP'] });
    t.equal(ids(out), '1,6', 'tags should match regardless of case/padding');
  });

  t.test('a segment of only blank tags falls back to everyone mailable', () => {
    const out = selectRecipients(makeContacts(), { segmentTags: ['', '   '] });
    t.equal(ids(out), '1,2,6', 'blank tags must not produce an empty send list');
  });

  t.test('selectRecipients tolerates junk input without throwing', () => {
    t.equal(selectRecipients(null, { segmentTags: ['vip'] }).length, 0, 'null contacts should yield none');
    t.equal(selectRecipients(undefined).length, 0, 'undefined contacts should yield none');
  });
}

t.test('every suppressed status is excluded from recipients', () => {
  // Guards against someone adding a status to SUBSCRIPTION_STATUSES that
  // means "do not mail" but forgetting to add it to SUPPRESSED_STATUSES.
  const schema = read('lib/mailme/schema.js');
  const suppressed = schema.slice(schema.indexOf('export const SUPPRESSED_STATUSES'));
  const line = suppressed.slice(0, suppressed.indexOf(';'));
  ['unsubscribed', 'bounced', 'complained'].forEach((s) => {
    t.assert(line.includes(s), 'SUPPRESSED_STATUSES is missing ' + s);
  });
});

t.test('bounce and complaint states cannot be set by hand', () => {
  // These are facts from the provider. A human setting them would corrupt
  // deliverability reporting; a human clearing them would resume mailing an
  // address that hard bounced.
  const src = read('api/mailme/contacts.js');
  t.assert(src.includes('"bounced"') || src.includes("'bounced'"),
    'contacts route must reject hand-set bounce states');
  t.assert(/s === "bounced" \|\| s === "complained"/.test(src),
    'contacts route must explicitly refuse bounced/complained from a client');
});

t.test('a plain PATCH/POST can never change a campaign to a non-draft status', () => {
  const src = stripComments(read('api/mailme/campaigns.js'));
  // Both write paths must consult the refusal, not just one.
  const guards = src.match(/refuseSend\(body\)/g) || [];
  t.assert(guards.length >= 2,
    'POST and PATCH must each call the status-change refusal guard');
});

t.test('sending only happens through the dedicated send action, gated on MailMe edit access', () => {
  const src = stripComments(read('api/mailme/campaigns.js'));
  t.assert(/action.*===\s*["']send["']/.test(src),
    'campaigns route must gate real sending behind an explicit action=send trigger');
  t.assert(/canEditMailMe\(sess\)/.test(src),
    'the whole POST/PATCH/send section must sit behind the same edit-access check as building a draft');
  t.assert(/sendCampaign\(/.test(src),
    'the send action must call the real send orchestration in lib/mailme/send.js');
});

t.test('scheduling is a separate action, and only a draft can be scheduled', () => {
  const src = stripComments(read('api/mailme/campaigns.js'));
  t.assert(/action === "schedule"/.test(src),
    'campaigns route must expose an explicit schedule action');
  t.assert(/campaign\.status !== "draft"/.test(src),
    'only a draft should be schedulable; anything else must be refused');
  t.assert(/getTime\(\) <= Date\.now\(\)/.test(src),
    'a scheduled time in the past must be rejected rather than firing immediately');
  t.assert(/action === "unschedule"/.test(src),
    'a scheduled campaign must be reversible back to a draft');
});

t.test('a test send never touches suppression, the queue, or campaign status', () => {
  const src = stripComments(read('lib/mailme/send.js'));
  const fn = src.slice(src.indexOf('export async function sendTestEmail'));
  t.assert(!/applyCampaignPatch\(/.test(fn),
    'sendTestEmail must never write campaign status or send state');
  t.assert(!/recordSends\(/.test(fn),
    'a test send must not count against the frequency cap for real contacts');
  t.assert(!/getSuppression\(/.test(fn),
    'a test send goes to one chosen address and does not consult the suppression list');
  t.assert(/sendOne\(/.test(fn),
    'sendTestEmail should use the single-send path, not the batch path');
});

t.test('the scheduled-send cron is authenticated and fails closed', () => {
  const src = stripComments(read('api/mailme/cron-send.js'));
  t.assert(/process\.env\.CRON_SECRET/.test(src), 'cron-send must read CRON_SECRET');
  t.assert(/safeEqual\(/.test(src), 'the secret must be compared with safeEqual, not ===');
  t.assert(/!!cronSecret &&/.test(src),
    'an unset CRON_SECRET must deny everything rather than allowing it');
  t.assert(/sendCampaign\(/.test(src),
    'the cron must go through the same sendCampaign path, so it gets the same pre-send checks');
});

t.test('the scheduled-send cron is registered in vercel.json', () => {
  const cfg = JSON.parse(read('vercel.json'));
  const crons = cfg.crons || [];
  t.assert(crons.some((c) => String(c.path).startsWith('/api/mailme/cron-send')),
    'vercel.json must declare the mailme cron-send job or scheduled campaigns will never fire');
});

t.test('a failed send is retryable: failures requeue and do not count as sent', () => {
  // Regression: a rejected batch was still added to sentIds and recorded
  // against the frequency cap, and the campaign flipped to "sent" with
  // nothing delivered, leaving no Send button and no way to retry.
  const src = stripComments(read('lib/mailme/send.js'));
  t.assert(/failedContacts/.test(src) && /sentContacts/.test(src),
    'successes and failures must be tracked separately');
  t.assert(/recordSends\(sentContacts/.test(src),
    'only successfully sent contacts may count against the frequency cap');
  t.assert(/failedContacts\.map\(\(c\) => c\.id\)\.concat\(remainingIds\)/.test(src),
    'failed contacts must go back on the queue for a retry');
  t.assert(/const done = stillQueued\.length === 0/.test(src),
    'a campaign must not be marked sent while anything is still queued');
});

t.test('a permanently failing campaign stops being auto-retried', () => {
  const send = stripComments(read('lib/mailme/send.js'));
  t.assert(/MAX_CONSECUTIVE_FAILED_RUNS/.test(send),
    'there must be a ceiling on consecutive failed runs');
  t.assert(/results\.sent === 0 && results\.failed > 0/.test(send),
    'a failed run is one that sent nothing and failed something');
  const cron = stripComments(read('api/mailme/cron-send.js'));
  t.assert(/failedRuns \|\| 0\) < MAX_CONSECUTIVE_FAILED_RUNS/.test(cron),
    'the cron must skip campaigns that have hit the failure ceiling');
});

t.test('any success clears the failure counter, so a transient outage self-heals', () => {
  const src = stripComments(read('lib/mailme/send.js'));
  t.assert(/\? priorFailedRuns \+ 1 : 0/.test(src),
    'a run with any successful send must reset the counter to zero');
});

t.test('campaign results open in a modal, not inline in the list', () => {
  const src = read('apps/mailme.js');
  t.assert(/mm-modal-back/.test(src), 'a modal backdrop must exist');
  t.assert(!/id="mmResults"/.test(src),
    'the old inline results container must be gone');
  t.assert(/this\._closeModal/.test(src),
    'unmount must be able to tear down the modal Escape listener');
});

t.test('the modal clears the shell header and carries its style scope', () => {
  // The shell header is z-index 200. A modal below that renders UNDERNEATH
  // it, which is what clipped the first version's title bar.
  const src = stripComments(read('apps/mailme.js'));
  const shell = read('css/shell.css');
  const headerZ = Math.max(...(shell.match(/z-index:\s*(\d+)/g) || [])
    .map((m) => Number(m.replace(/\D/g, ''))));
  const modalZ = Number((src.match(/\.mm-modal-back\{[^}]*z-index:(\d+)/) || [])[1]);
  t.assert(modalZ > headerZ,
    `modal z-index (${modalZ}) must exceed everything in shell.css (${headerZ})`);

  // Attached to body to escape .view's transform animation, which would
  // otherwise become the containing block for position:fixed. App CSS is
  // scoped to [data-app-root], so the carrier must restore that scope.
  t.assert(/document\.body\.appendChild\(carrier\)/.test(src),
    'the modal must attach to body, not the app root');
  t.assert(/carrier\.dataset\.appRoot = 'mailme'/.test(src),
    'the carrier must carry the app-root scope or every .mm- rule stops matching');
});

t.test('a body-attached modal is cleaned up on view change and unmount', () => {
  // It lives outside the app root, so nothing removes it automatically.
  const src = stripComments(read('apps/mailme.js'));
  const showView = src.slice(src.indexOf('showView(view)'));
  t.assert(/this\._closeModal\(\)/.test(showView.slice(0, 600)),
    'showView must close the modal, or it strands over the next view');
  t.assert(/document\.body\.style\.overflow = ''/.test(src),
    'closing must restore body scrolling');
});

t.test('send orchestration re-verifies compliance, domain readiness and suppression before dispatch', () => {
  const src = stripComments(read('lib/mailme/send.js'));
  t.assert(/complianceBlockers\(/.test(src), 'sendReadiness must reuse the CAN-SPAM blockers');
  t.assert(/domainStatus\(/.test(src), 'send.js must check live Resend domain verification, not a cached flag');
  t.assert(/getSuppression\(/.test(src) && /suppression\[/.test(src),
    'send.js must re-check suppression immediately before dispatch, not just at queue-build time');
  t.assert(/campaignSourceConflict\(/.test(src),
    'send.js must refuse to send a campaign that mixes warm and cold recipients');
});

t.test('the Resend API key is an env var, never a Settings field a client could read back', () => {
  const src = stripComments(read('lib/mailme/resend-client.js'));
  t.assert(/process\.env\.RESEND_API_KEY/.test(src), 'resend-client.js must read the key from env');
  const settingsSrc = stripComments(read('api/mailme/settings.js'));
  t.assert(!/RESEND_API_KEY/.test(settingsSrc), 'the settings route must never accept or echo the API key');
});

t.test('contacts cannot be created in MailMe', () => {
  // The contact list IS the BackBone roster. A POST here would invent a
  // person BackBone has never heard of and silently break the join.
  const src = stripComments(read('api/mailme/contacts.js'));
  t.assert(!/req\.method === "POST"/.test(src),
    'api/mailme/contacts.js must not accept POST: contacts come from the roster');
  t.assert(/"GET, PATCH, DELETE"/.test(src),
    'contacts route should allow GET, PATCH and DELETE (prospect removal) but never POST');
});

t.test('mailme never writes the backbone_data key', () => {
  const store = read('lib/mailme/store.js');
  // Reading it is the whole point; writing it would corrupt BackBone's roster.
  const writes = store.match(/\["SET",\s*"backbone_data"/g) || [];
  t.equal(writes.length, 0, 'MailMe must treat backbone_data as read-only');
  // Writes funnel through writeKey(key, value); every CALLER must pass a
  // keys.* helper, so no raw key string can reach storage.
  // `await writeKey(` excludes the helper's own definition line.
  const writeCalls = store.match(/await writeKey\(\s*([^,]+),/g) || [];
  t.assert(writeCalls.length > 0, 'expected writeKey() callers in the store');
  writeCalls.forEach((c) => {
    t.assert(c.includes('keys.'),
      'every MailMe write must pass a keys.* helper (found: ' + c + ')');
  });
});

t.test('mailme storage stays under its own key prefix', () => {
  const schema = read('lib/mailme/schema.js');
  t.assert(/KEY_PREFIX = "mailme_data"/.test(schema),
    'MailMe must namespace its keys under mailme_data');
});

/* schema.js is an ES module and this harness is CommonJS, so the functional
   tests run after a dynamic import. Everything above is synchronous and has
   already registered by the time this resolves. */

/* ---- v2: import, lists, sorting, results ------------------------------- */

t.test('import and lists routes require auth AND app-level access', () => {
  ['import', 'lists', 'contacts', 'campaigns'].forEach((name) => {
    const src = read('api/mailme/' + name + '.js');
    t.assert(src.includes('requireAuth'), 'api/mailme/' + name + '.js must call requireAuth');
    t.assert(src.includes('requireMailMe'),
      'api/mailme/' + name + '.js must gate on MailMe access server-side');
  });
});

t.test('the webhook fails closed when its secret is unset', () => {
  // The one unauthenticated-by-cookie route. An unset secret must DENY, not
  // allow: `undefined === undefined` would otherwise let anyone forge
  // unsubscribes and fake open counts.
  const src = read('api/mailme/webhook.js');
  t.assert(/if \(!expected\) return false/.test(src),
    'webhook must deny when MAILME_WEBHOOK_SECRET is unset');
  t.assert(src.includes('safeEqual'),
    'webhook must compare the secret with safeEqual, not ===');
});

t.test('the webhook suppresses on unsubscribe, bounce and complaint', () => {
  const src = stripComments(read('api/mailme/webhook.js'));
  ['unsubscribe', 'bounce', 'complaint'].forEach((type) => {
    t.assert(src.includes("'" + type + "'") || src.includes('"' + type + '"'),
      'webhook must act on ' + type + ' events');
  });
  t.assert(src.includes('suppressEmail'),
    'webhook must write the suppression list, not just store the event');
});

t.test('import is a dry run unless explicitly committed', () => {
  const src = stripComments(read('api/mailme/import.js'));
  t.assert(/if \(!body\.commit\)/.test(src),
    'import must preview by default and write only when commit is set');
});

t.test('suppression survives deleting and re-importing a prospect', () => {
  // The compliance backstop. Contact records come and go; an opt-out must
  // not. Keyed by email in its own store, so a deleted-and-re-imported
  // prospect stays suppressed.
  const store = read('lib/mailme/store.js');
  t.assert(/suppressionList: \(\)/.test(read('lib/mailme/schema.js')),
    'a dedicated email-keyed suppression key must exist');
  t.assert(store.includes('suppressEmail'), 'store must expose suppressEmail');
  const contacts = read('api/mailme/contacts.js');
  t.assert(!/unsuppress/.test(contacts.split('DELETE')[1] || ''),
    'deleting a prospect must NOT clear their suppression entry');
});

t.test('bounced and complained addresses cannot be hand-resubscribed', () => {
  const store = stripComments(read('lib/mailme/store.js'));
  const fn = store.slice(store.indexOf('export async function unsuppressEmail'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  t.assert(/bounced/.test(body) && /complained/.test(body),
    'unsuppressEmail must refuse to clear provider-set states');
});

/* ---- v2.1: view refresh -------------------------------------------------- */

t.test('every view refetches its data on entry', () => {
  // mount() runs once; showView() runs on every visit. If the view renders
  // only repaint what mount() loaded, numbers rot: tag a contact, come back
  // to Lists, and a dynamic list still shows its old count.
  const src = read('apps/mailme.js');
  t.assert(/const VIEW_LOADERS = \{/.test(src),
    'each view must declare which loaders it needs on entry');
  ['dashboard', 'contacts', 'lists', 'import', 'campaigns'].forEach((v) => {
    t.assert(new RegExp(v + ':\\s*\\[').test(src),
      'VIEW_LOADERS is missing an entry for ' + v);
  });
  const renders = src.slice(src.indexOf('this._renders = {'));
  const block = renders.slice(0, renders.indexOf('};'));
  ['dashboard', 'contacts', 'lists', 'import', 'campaigns'].forEach((v) => {
    t.assert(block.includes("refreshView('" + v + "')"),
      v + ' must refresh on entry, not just repaint stale state');
  });
});

t.test('the campaigns view reloads lists, so a new list appears in the composer', () => {
  // A list saved on the Lists screen that is missing from the campaign
  // dropdown reads as a failed save.
  const src = read('apps/mailme.js');
  const loaders = src.slice(src.indexOf('const VIEW_LOADERS'));
  const campaigns = loaders.slice(loaders.indexOf('campaigns:'), loaders.indexOf('};'));
  t.assert(campaigns.includes('loadLists'),
    'entering Campaigns must reload lists for the composer dropdown');
  const lists = loaders.slice(loaders.indexOf('lists:'), loaders.indexOf('import:'));
  t.assert(lists.includes('loadContacts'),
    'list member counts depend on contacts, so Lists must reload them too');
});

t.test('a refresh never clobbers an open editor', () => {
  // Re-rendering an editor rebuilds its inputs from state, wiping anything
  // half-typed. A background refresh must leave it alone.
  const src = read('apps/mailme.js');
  t.assert(/if \(!state\.editingList\) renderListEditor\(\)/.test(src),
    'the list editor must not be re-rendered while it is open');
  t.assert(/if \(!state\.editingCampaign\) renderComposer\(\)/.test(src),
    'the composer must not be re-rendered while it is open');
});

t.test('a failed refresh keeps the previous numbers rather than blanking', () => {
  const src = stripComments(read('apps/mailme.js'));
  const fn = src.slice(src.indexOf('async function refreshView'));
  const body = fn.slice(0, fn.indexOf('\n    }\n'));
  t.assert(body.includes('catch'), 'refreshView must catch fetch failures');
  t.assert(body.includes('finally'),
    'the refreshing flag must clear in a finally, or a failure locks the button forever');
});

t.test('the stamp ticker is torn down on unmount', () => {
  // A stray interval would keep firing against a detached root forever.
  const src = read('apps/mailme.js');
  t.assert(src.includes('clearInterval(this._stampTimer)'),
    'unmount must clear the stamp interval');
});

t.test('freshness is visible, not assumed', () => {
  // Same reasoning as BackBone's "Data through" stamp: a number with no
  // freshness indicator gets trusted long after it stopped being true.
  const src = read('apps/mailme.js');
  t.assert(src.includes('data-mm-stamp'), 'views must show a freshness stamp');
  t.assert(src.includes('data-mm-refresh'), 'views must offer a manual refresh');
});

/* ---- v3: sources, compliance, unsubscribe -------------------------------- */

t.test('the unsubscribe endpoint is public by design and token-verified', () => {
  // An opt-out behind a login is not an opt-out. It must be reachable without
  // a session, but every request must still carry a signed token. The token
  // make/read logic itself lives in lib/mailme/unsub-token.js (a pure lib
  // module the send path also uses to embed tokens), and this route
  // re-exports it, so the safety properties are checked there.
  const src = read('api/mailme/unsubscribe.js');
  t.assert(src.includes('PUBLIC BY DESIGN'),
    'the public opt-out must document why it has no session check');
  t.assert(/makeToken.*readToken/.test(src) || /readToken.*makeToken/.test(src),
    'the route must use the shared token make/read functions');

  const tokenSrc = read('lib/mailme/unsub-token.js');
  t.assert(tokenSrc.includes('safeEqual'), 'tokens must be compared with safeEqual, not ===');
  t.assert(/createHmac/.test(tokenSrc), 'tokens must be HMAC-signed, not guessable ids');
  t.assert(/if \(!s\) throw new Error\("SESSION_SECRET is not set"\)/.test(tokenSrc),
    'a missing secret must fail closed rather than accept unverified tokens');
});

t.test('the unsubscribe URL never carries an email address', () => {
  // A raw address in the link lets anyone unsubscribe anyone by editing it,
  // and turns an intercepted link into an address disclosure.
  const src = stripComments(read('api/mailme/unsubscribe.js'));
  const describe = src.slice(src.indexOf('function describe'));
  const body = describe.slice(0, describe.indexOf('\n}'));
  t.assert(!/email/.test(body),
    'the public page payload must not echo the contact email back');
});

t.test('a public unsubscribe page exists outside the shell', () => {
  // Loading the whole shell for a logged-out stranger would bounce them to a
  // login screen, which is a broken opt-out.
  t.assert(exists('unsubscribe.html'), 'unsubscribe.html must exist at the root');
  const html = read('unsubscribe.html');
  t.assert(!/js\/shell\.js|js\/registry\.js/.test(html),
    'the public page must not load the shell');
  t.assert(/reason/i.test(html), 'the page should capture an unsubscribe reason');
});

t.test('all four contact sources are wired', () => {
  const schema = read('lib/mailme/schema.js');
  ['client', 'prospect', 'lead', 'giving'].forEach((src) => {
    t.assert(new RegExp('"' + src + '"').test(schema), 'CONTACT_SOURCES is missing ' + src);
  });
  const store = read('lib/mailme/store.js');
  t.assert(store.includes('backbone_leads'), 'leads must be read from BackBone');
  t.assert(store.includes('getGivingRequests'), 'giving requests must be read');
});

t.test('leads and giving contacts are read-only joins, never written back', () => {
  // They belong to other apps. MailMe stores their tags in its own overrides
  // map rather than mutating another app's data.
  const store = read('lib/mailme/store.js');
  const writes = store.match(/\["SET",\s*"backbone_leads"/g) || [];
  t.equal(writes.length, 0, 'MailMe must never write backbone_leads');
});

t.test('a contact appearing in two sources is not duplicated', () => {
  // A lead that became a customer would otherwise be counted twice and could
  // receive the same campaign twice.
  const store = stripComments(read('lib/mailme/store.js'));
  t.assert(/seen\.has\(key\)/.test(store),
    'cross-source dedupe by email must exist');
});

t.test('settings are configurable, and the postal address ships blank', () => {
  // It is a fact about the business that cannot be guessed, and a wrong
  // default would be worse than an empty one.
  const schema = read('lib/mailme/schema.js');
  const fn = schema.slice(schema.indexOf('export function defaultSettings'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  t.assert(/line1: ""/.test(body), 'postal address must default to blank');
  ['minDaysBetweenEmails', 'coldDailyCapStart', 'dueAt', 'skipOpenQuotes']
    .forEach((k) => t.assert(body.includes(k), 'settings should expose ' + k));
});

t.test('campaigns surface compliance blockers and the send plan', () => {
  const src = read('api/mailme/campaigns.js');
  t.assert(src.includes('complianceBlockers'),
    'a campaign must report what would make it illegal to send');
  t.assert(src.includes('sendPlan'),
    'a campaign must report how long the send would take under the daily cap');
  t.assert(src.includes('applyEligibility'),
    'the frequency cap and open-quote rules must apply to campaign recipients');
});

t.test('mixing cold prospects with warm contacts is refused', () => {
  const schema = stripComments(read('lib/mailme/schema.js'));
  const fn = schema.slice(schema.indexOf('export function campaignSourceConflict'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  t.assert(body.includes('COLD_SOURCES'),
    'the conflict check must compare cold vs warm, not raw source');
});

/* ---- v3.1: regressions from the first live run --------------------------- */

t.test('giving requests are read through GivingGauge own reader', () => {
  // The first build guessed a key name ("givinggauge_requests") that does not
  // exist, so Giving silently showed zero. Requests actually live under
  // alliteration:giving:index plus one key per request.
  // stripComments so the note explaining this fix does not fail its own test.
  const store = stripComments(read('lib/mailme/store.js'));
  t.assert(!/kvGet\(\s*"givinggauge_requests"/.test(store),
    'the guessed giving key must not be read');
  t.assert(/from "\.\.\/giving\.js"/.test(store),
    'giving requests must be read via lib/giving.js listRequests, not a re-derived key');
});

t.test('placeholder text is never treated as a lead email address', () => {
  // The qualification agent must emit a value for every field, so a missing
  // email arrives as "not found" / "N/A" / "unknown". Without filtering,
  // MailMe would create contacts whose address is literally "not found".
  const store = read('lib/mailme/store.js');
  t.assert(/CONTACT_PLACEHOLDER_RE/.test(store),
    'lead emails must be screened for placeholder text');
  t.assert(/cleanLeadEmail/.test(store),
    'a lead email cleaner must exist');
});

t.test('a lead contact keeps one person intact', () => {
  // Merging the first name found with a different person's email invents
  // someone who does not exist. BackBone learned this the hard way.
  const store = stripComments(read('lib/mailme/store.js'));
  const fn = store.slice(store.indexOf('function leadContact'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  t.assert(/for \(const c of contacts\)/.test(body),
    'the name and title must come from whoever owns the email');
});

t.test('API errors render readable text, never [object Object]', () => {
  // Vercel platform errors arrive as { error: { code, message } }. Pushing
  // that object into Error#message produced "[object Object]", which hid a
  // real deploy fault behind a shrug.
  const src = read('js/api.js');
  t.assert(/function errorText/.test(src),
    'js/api.js must normalize error payload shapes');
  t.assert(/errorText\(payload\)/.test(src),
    'the request path must use errorText, not payload.error directly');
});

t.test('every contact source gets a count, derived not hand-listed', () => {
  // The first version listed client and prospect by hand, so Leads and Giving
  // showed 0 in the filter tabs while their rows loaded fine underneath: a
  // count that disagreed with its own table. Deriving from CONTACT_SOURCES
  // means adding a source cannot silently miss its counter.
  const src = read('api/mailme/contacts.js');
  t.assert(/CONTACT_SOURCES\.map\(/.test(src),
    'per-source counts must be derived from CONTACT_SOURCES');
  const counts = src.slice(src.indexOf('counts: {'), src.indexOf('tags:'));
  t.assert(!/client:\s*resolved\.clientCount/.test(counts),
    'counts must not be hand-listed per source');
});





import('../lib/mailme/schema.js')
  .then((mod) => {
    t.test('schema exports selectRecipients', () => {
      t.assert(typeof mod.selectRecipients === 'function',
        'lib/mailme/schema.js must export selectRecipients');
    });
    if (typeof mod.selectRecipients === 'function') {
      runSelectRecipientsTests(mod.selectRecipients);
    }
    process.exit(t.report());
  })
  .catch((e) => {
    console.log('  FAIL could not import lib/mailme/schema.js: ' + e.message);
    process.exit(1);
  });
