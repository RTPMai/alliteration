// PUT IN: test/marketmachine-email-embed.test.cjs
/**
 * MarketMachine: email written inside the campaign (Oct 1 2026).
 *
 * The sales director's ask: email is a tool used in a campaign, not its own
 * app, and who gets it is picked right there. The campaign page now mounts
 * MailMe's real composer (one composer, every safety check) into an Email
 * section. Clicked through in a real browser before shipping; these checks
 * hold the pieces that make it safe.
 */
const path = require('path');
const fs = require('fs');
const t = require('./harness.cjs');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  /* ---- the embed helper, called for real against a stand-in page ---- */
  const removed = [];
  global.document = {
    createElement: () => ({ dataset: {}, className: '', innerHTML: '', classList: { add() {} }, remove() { removed.push(this); } }),
    getElementById: () => null,
    head: { appendChild() {} },
  };
  const host = await import(path.join(ROOT, 'js/app-host.js'));

  await t.test('the embedded copy is placeable at once and carries the app\'s style scope', async () => {
    const e = host.mountEmbedded('no-such-app-for-test', { embed: { campaignId: 'MK-1' } });
    t.equal(e.root.dataset.appRoot, 'no-such-app-for-test', 'scoped styles key on this attribute');
    t.assert(/app-embed/.test(e.root.className), 'marked so the host app can fence its own handlers off it');
    let failed = false;
    try { await e.ready; } catch (err) { failed = true; }
    t.assert(failed, 'a missing app reports a load failure instead of hanging');
    e.destroy();
    t.equal(removed.length, 1, 'destroy takes it off the page');
    t.equal(host.isMounted('no-such-app-for-test'), false, 'never registered as a routed app');
  });

  await t.test('styles scoped to MailMe reach a copy mounted inside MarketMachine', () => {
    t.equal(host.scopeCss('.mm-step{color:red}', '[data-app-root="mailme"]'), '[data-app-root="mailme"] .mm-step{color:red}');
  });

  await t.test('each embedded copy gets its own `this`, so the real MailMe is untouched', () => {
    const src = read('js/app-host.js');
    const fn = src.slice(src.indexOf('export function mountEmbedded'), src.indexOf('export function showView'));
    t.assert(/Object\.create\(app\)/.test(fn), 'must not mount the shared module object twice');
    t.assert(!/mounted\.set/.test(fn), 'must not enter the router\'s table');
  });

  /* ---- MailMe in embedded mode ---- */
  const mm = read('apps/mailme.js');

  await t.test('embedded MailMe shows only this campaign\'s emails and files new ones under it', () => {
    t.assert(/all\.filter\(\(c\) => c\.marketingCampaignId === embed\.campaignId\)/.test(mm), 'list is filtered to the campaign');
    t.assert(/marketingCampaignId: embed \? embed\.campaignId : null/.test(mm), 'a new email belongs to the campaign');
    t.assert(/\$\{embed \? '' : stepHtml\('Part of a campaign'/.test(mm), 'the campaign step is implied, not asked');
  });

  await t.test('who gets it can be uploaded from the email itself, and the email then goes to that list', () => {
    t.assert(/id="mmWhoUpload"/.test(mm), 'upload button in step 1');
    const ci = mm.slice(mm.indexOf('async function commitImport'), mm.indexOf('function rejectTable'));
    t.assert(/forSend && d\.list/.test(ci) && /sendToList\(d\.list\.id/.test(ci), 'the open email is pointed at the uploaded list');
    const stl = mm.slice(mm.indexOf('async function sendToList'), mm.indexOf('const TOP_CHOICES'));
    t.assert(/ed\.listId = listId/.test(stl) && /saveCampaign\(\{ silent: true \}\)/.test(stl), 'and saved');
    t.assert(/state\.importForSend = false/.test(mm), 'closing the upload clears the hand-off');
  });

  await t.test('without an embed, MailMe behaves as before', () => {
    t.assert(/const embed = ctx\.embed && ctx\.embed\.campaignId \? ctx\.embed : null/.test(mm));
  });

  /* ---- the campaign page ---- */
  const mk = read('apps/marketmachine/index.js');
  const det = read('apps/marketmachine/detail.js');

  await t.test('MarketMachine\'s page-wide clicks never act on the email composer', () => {
    // MailMe's rows carry data-open="MM-00001"; MarketMachine reads data-open
    // as a campaign id. Without the fence, opening an email opened nothing.
    t.assert(/closest\('\.app-embed'\)/.test(mk), 'handlers ignore events from inside the embed');
    t.assert(/root\.addEventListener\('click', onClickOwn\)/.test(mk));
    t.assert(/data-open="\$\{esc\(c\.id\)\}"/.test(mm), 'the collision this guards against still exists in MailMe');
  });

  await t.test('the composer survives repaints and is dropped when leaving the campaign', () => {
    t.assert(/slot\.appendChild\(emailEmbed\.root\)/.test(mk), 'moved, not re-mounted, so typing survives');
    t.assert(/if \(which !== 'detail'\) dropEmailEmbed\(\)/.test(mk));
    t.assert(/emailEmbed\.campaignId !== c\.id/.test(mk), 'another campaign gets its own');
  });

  await t.test('the Email section shows when Email is a platform, emails exist, or someone asks', () => {
    t.assert(/platformsOf\(c\)\.includes\('email'\) \|\| \(em\.count \|\| 0\) > 0 \|\| state\.emailOpen/.test(det));
    t.assert(/Writing and sending email needs MailMe access/.test(det), 'no access says so instead of failing');
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
