// PUT IN: test/help-standing.test.cjs
/**
 * Help bubble: a question asked from inside an app is about that app
 * (Sep 29 2026).
 *
 * Ryan asked "what do I put in the click through link?" from MailMe's
 * composer and was answered from the BackBone doc ("I can only see
 * information about BackBone"). About the fourth question in a row it could
 * not answer. Two causes, both fixed and both checked here with real calls:
 *   1. retrieval let a stray word in another app's doc outrank the app the
 *      person was standing in
 *   2. the docs described what each app is for, not what goes in each box
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

Promise.all([
  import(path.join(ROOT, 'lib/help/content.js')),
  import(path.join(ROOT, 'lib/help/retrieve.js')),
  import(path.join(ROOT, 'lib/help/store.js')),
  import(path.join(ROOT, 'js/registry.js')),
]).then(([content, retrieve, store, reg]) => {
  const { DOCS } = content;
  const { pickDocs } = retrieve;
  const top = (q, app, view) => (pickDocs(DOCS, q, { currentApp: app, currentView: view })[0] || { doc: {} }).doc;

  t.test('Ryan\'s question from the MailMe composer is answered from MailMe', () => {
    const d = top('what do I put in the click through link?', 'mailme', 'campaigns');
    t.equal(d.app, 'mailme');
    t.assert(/click-through link/i.test(d.body) && /opens the picture full size/i.test(d.body),
      'the MailMe doc does not actually answer it');
  });

  t.test('a vague question from inside an app gets that app first, even if another doc scored', () => {
    const hits = pickDocs(DOCS, 'what goes in this box', { currentApp: 'mailme', currentView: 'campaigns' });
    t.assert(hits.length && hits[0].doc.app === 'mailme', 'another app came first');
  });

  t.test('a question that names another app still goes to that app', () => {
    t.equal(top('how does StitchSense estimate a PNG', 'mailme', 'campaigns').app, 'stitchsense');
    t.equal(top('how are stitch counts estimated', 'givinggauge').app, 'stitchsense');
  });

  t.test('the screen guide for the screen you are on comes before the overview', () => {
    const hits = pickDocs(DOCS, 'what is the preheader', { currentApp: 'mailme', currentView: 'campaigns' });
    t.assert(/composer/i.test(hits[0].doc.title), 'got ' + hits[0].doc.title);
  });

  t.test('the MarketMachine questions from the Holiday test run find answers', () => {
    const cases = [
      ['how do I add more than one account manager', /tick everyone/i],
      ['where do I upload the art', /Upload art/],
      ['what happens with a printavo link in files and links', /connected to the campaign automatically/i],
      ['where do I pick the platforms', /Platforms and art/],
    ];
    cases.forEach(([q, re]) => {
      const hits = pickDocs(DOCS, q, { currentApp: 'marketmachine', currentView: 'campaigns' });
      t.assert(hits.some((h) => re.test(h.doc.body.replace(/\s+/g, ' '))), 'no doc answers: ' + q);
    });
  });

  t.test('the import question from Audience finds the list answer', () => {
    const hits = pickDocs(DOCS, 'why did only 7 of my 75 go into the list', { currentApp: 'mailme', currentView: 'audience' });
    t.assert(hits.some((h) => /added to the list as the\s+contact they already are/i.test(h.doc.body)), 'import doc not found');
  });

  t.test('a generic word in another app\'s doc title does not pull the answer away', () => {
    [['how do I schedule this campaign', 'mailme', 'campaigns'],
     ['what goes in this field', 'backbone', '']].forEach(([q, app, view]) => {
      const hits = pickDocs(DOCS, q, { currentApp: app, currentView: view });
      if (hits.length) t.equal(hits[0].doc.app, app, q + ' from ' + app);
    });
  });

  t.test('from inside an app, a question matching nothing still gets "not documented"', () => {
    t.equal(pickDocs(DOCS, 'zzzz qqqq', { currentApp: 'mailme', currentView: 'campaigns' }).length, 0);
  });

  t.test('outside any app, nothing is forced', () => {
    t.equal(pickDocs(DOCS, 'zzzz qqqq').length, 0);
  });

  t.test('every screen guide points at views its app really has', () => {
    const all = [...reg.APPS, ...reg.SHELL_APPS, ...reg.SITE_APPS];
    DOCS.filter((d) => Array.isArray(d.views)).forEach((d) => {
      const app = all.find((a) => a.id === d.app);
      t.assert(app, 'guide for unknown app ' + d.app);
      d.views.forEach((v) => t.assert(app.views.some(([k]) => k === v), d.title + ' names a view that does not exist: ' + v));
    });
  });

  t.test('an answer built only from other apps is flagged in the gap log', () => {
    const rows = [
      { question: 'a', answered: true, offApp: false },
      { question: 'b', answered: true, offApp: true },
      { question: 'c', answered: false },
    ];
    t.equal(store.unanswered(rows).map((r) => r.question).join(','), 'b,c');
  });

  process.exit(t.report());
}).catch((e) => { console.error(e); process.exit(1); });
