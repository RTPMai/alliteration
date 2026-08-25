/**
 * Help bot tests (Ryan's ask, Aug 25 2026).
 *
 * Two jobs here.
 *
 * ONE, the retrieval is real function calls: given a question, which
 * documents come back and in what order. Keyword scoring was chosen over
 * embeddings partly BECAUSE it can be tested this way. A similarity score
 * cannot be asserted; this can.
 *
 * TWO, and more important long term, these are DRIFT GUARDS. The failure
 * mode for a help bot is not a bad answer today, it is a confident answer
 * next spring explaining a calculation that changed in the autumn. This
 * project's recurring failure is exactly that: written notes falling behind
 * the repo. So the suite asserts that every app in the registry has a doc,
 * that every registered view is named in its app's doc, and that the
 * server-side app list matches the registry. Adding a view without
 * documenting it turns the suite red the same day instead of producing a
 * wrong answer six months later.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

Promise.all([
  import(path.join(ROOT, 'lib/help/content.js')),
  import(path.join(ROOT, 'lib/help/retrieve.js')),
  import(path.join(ROOT, 'lib/help/access.js')),
  import(path.join(ROOT, 'lib/help/store.js')),
  import(path.join(ROOT, 'js/registry.js')),
]).then(([content, retrieve, access, store, reg]) => {
  const { DOCS, DOCUMENTED_APPS } = content;
  const { tokenize, scoreDoc, pickDocs, buildPrompt, MIN_SCORE, MAX_DOCS } = retrieve;
  const { APP_ACCESS_IDS } = access;
  const { unanswered } = store;
  const { APPS, SHELL_APPS, SITE_APPS } = reg;

  const ALL = [...APPS, ...SHELL_APPS, ...SITE_APPS];
  const docFor = (id) => DOCS.find((d) => d.app === id);

  /* ---- coverage: the drift guards ---------------------------------------- */

  t.test('every app in the registry has a help doc', () => {
    ALL.forEach((a) => {
      t.assert(docFor(a.id), 'no help doc for ' + a.id + '. A new app the bot refuses to discuss.');
    });
  });

  t.test('every registered view is named in its app\'s doc', () => {
    ALL.forEach((a) => {
      // A stub's registered view is a placeholder holding the rail entry,
      // not a screen anybody can use. Coverage applies again the moment the
      // app stops being a stub.
      if (a.stub) return;
      const doc = docFor(a.id);
      if (!doc) return; // the test above already reported it
      // Collapse whitespace: a label split across two source lines by
      // wrapping is still named in the doc.
      const body = doc.body.toLowerCase().replace(/\s+/g, ' ');
      a.views.forEach(([, label]) => {
        t.assert(body.includes(String(label).toLowerCase()),
          a.id + ' doc never mentions its "' + label + '" screen');
      });
    });
  });

  t.test('a stub app\'s doc says it is not built rather than describing it', () => {
    ALL.filter((a) => a.stub).forEach((a) => {
      const doc = docFor(a.id);
      t.assert(doc, 'no doc for stub ' + a.id);
      t.assert(/not built|planned|nothing to use/i.test(doc.body),
        a.id + ' is a stub but its doc reads as though it works');
    });
  });

  t.test('no help doc points at an app that does not exist', () => {
    const ids = ALL.map((a) => a.id);
    DOCUMENTED_APPS.forEach((id) => {
      t.assert(ids.includes(id), 'help doc for unknown app: ' + id);
    });
  });

  t.test('the server-side app list matches the registry', () => {
    // api/ must not import js/registry.js (browser code), so this list is
    // hand-synced. api/notifications.js's equivalent went stale twice.
    ALL.forEach((a) => {
      t.assert(APP_ACCESS_IDS.includes(a.id), a.id + ' is missing from APP_ACCESS_IDS');
    });
    APP_ACCESS_IDS.forEach((id) => {
      t.assert(ALL.some((a) => a.id === id), 'APP_ACCESS_IDS names an app that is gone: ' + id);
    });
  });

  t.test('there is a platform-wide doc with no app of its own', () => {
    const general = DOCS.filter((d) => !d.app);
    t.equal(general.length, 1, 'expected exactly one general doc');
    t.assert(/one login|single sign-in|one website/i.test(general[0].body),
      'the platform doc should explain the single sign-in, the first thing anyone asks');
  });

  t.test('every doc carries the fields retrieval needs', () => {
    DOCS.forEach((d) => {
      t.assert(d.title && d.title.length > 2, 'doc missing a title: ' + d.app);
      t.assert(Array.isArray(d.keywords) && d.keywords.length >= 3,
        'doc needs keywords for people who do not know the app name: ' + d.app);
      t.assert(d.body && d.body.length > 200, 'doc body too thin to answer from: ' + d.app);
    });
  });

  t.test('no doc uses an em dash', () => {
    // Standing rule, and these strings are read out to Ryan's team verbatim.
    DOCS.forEach((d) => {
      t.assert(!d.body.includes('\u2014'), 'em dash in the ' + (d.app || 'platform') + ' doc');
    });
  });

  /* ---- tokenizing --------------------------------------------------------- */

  t.test('tokenize drops the words that carry no signal', () => {
    const words = tokenize('How does the sales goal work?');
    t.equal(words.includes('how'), false, '"how" appears in nearly every question');
    t.equal(words.includes('the'), false);
    t.equal(words.includes('work'), false);
    t.equal(words.includes('sales'), true);
    t.equal(words.includes('goal'), true);
  });

  t.test('tokenize survives punctuation and empty input', () => {
    t.equal(tokenize('what\'s the "sales goal", exactly?').includes('sales'), true);
    t.equal(tokenize('').length, 0);
    t.equal(tokenize(null).length, 0);
  });

  /* ---- scoring ------------------------------------------------------------ */

  t.test('a question naming an app scores that app\'s doc highest', () => {
    const hits = pickDocs(DOCS, 'how does PromoPro track vendors');
    t.assert(hits.length > 0, 'expected at least one match');
    t.equal(hits[0].doc.app, 'promopro');
  });

  t.test('a question that never names an app still finds it by subject', () => {
    const hits = pickDocs(DOCS, 'how are stitch counts estimated for embroidery quoting');
    t.equal(hits[0].doc.app, 'stitchsense');
  });

  t.test('the words people actually use reach the right app', () => {
    const cases = [
      ['why did somebody not get the email', 'mailme'],
      ['how do I clock in', 'crewcore'],
      ['where do donation requests come from', 'givinggauge'],
      ['how is the sales goal calculated', 'backbone'],
      ['what happened to my misprint report', 'errorengine'],
      ['how do I get reimbursed for mileage', 'traveltrack'],
    ];
    cases.forEach(([q, expected]) => {
      const hits = pickDocs(DOCS, q);
      t.assert(hits.length > 0, 'nothing matched: ' + q);
      t.equal(hits[0].doc.app, expected, 'wrong top doc for: ' + q);
    });
  });

  t.test('singular and plural both find the same doc', () => {
    const one = pickDocs(DOCS, 'how is a purchase order tracked');
    const many = pickDocs(DOCS, 'how are purchase orders tracked');
    t.equal(one[0].doc.app, 'promopro');
    t.equal(many[0].doc.app, 'promopro');
  });

  t.test('a body mention counts for less than a title match', () => {
    const bb = docFor('backbone');
    const pp = docFor('promopro');
    // Both docs mention Printavo; only one is about purchase orders.
    t.assert(scoreDoc(pp, 'purchase order vendor') > scoreDoc(bb, 'purchase order vendor'),
      'the app the question is about must outrank one that mentions the word in passing');
  });

  t.test('repeating a word in one document cannot buy relevance', () => {
    const wordy = { app: 'x', title: 'Nothing', keywords: [], body: ('vendor ').repeat(50) };
    const real = docFor('promopro');
    t.assert(scoreDoc(real, 'vendor purchase order') > scoreDoc(wordy, 'vendor purchase order'),
      'body hits must be capped or length wins');
  });

  /* ---- the "I do not know" path ------------------------------------------- */

  t.test('a question about nothing in the docs returns nothing, not the least-bad doc', () => {
    const hits = pickDocs(DOCS, 'what is the capital of Nebraska');
    t.equal(hits.length, 0, 'an undocumented question must produce no sources, so the route says it does not know');
  });

  t.test('an empty question matches nothing', () => {
    t.equal(pickDocs(DOCS, '').length, 0);
    t.equal(pickDocs(DOCS, '   ').length, 0);
  });

  t.test('scoring never throws on junk', () => {
    t.equal(scoreDoc(null, 'anything'), 0);
    t.equal(pickDocs(null, 'anything').length, 0);
    t.equal(scoreDoc(docFor('backbone'), null), 0);
  });

  /* ---- scoping ------------------------------------------------------------ */

  t.test('a doc for an app the asker cannot open is never used', () => {
    const hits = pickDocs(DOCS, 'how does the CrewCore stipend work', { allowedApps: ['backbone', 'shopstock'] });
    t.equal(hits.some((h) => h.doc.app === 'crewcore'), false,
      'nobody should be told how a screen they cannot reach works');
  });

  t.test('the platform doc is available to everyone, whatever their apps', () => {
    const hits = pickDocs(DOCS, 'how does signing in work across the apps', { allowedApps: [] });
    t.assert(hits.length > 0, 'the general doc has no app and must survive scoping');
    t.equal(hits[0].doc.app, null);
  });

  /* ---- context tie-break --------------------------------------------------- */

  t.test('the app you are looking at is nudged up the results', () => {
    // A vague question that several docs half-answer. Without context the
    // app you are standing in does not make the cut; with it, it does. That
    // is what makes "how is this calculated" work without naming anything.
    const q = 'what does the reports screen show';
    const blind = pickDocs(DOCS, q).map((h) => h.doc.app);
    const standing = pickDocs(DOCS, q, { currentApp: 'traveltrack' }).map((h) => h.doc.app);
    t.equal(blind.includes('traveltrack'), false, 'precondition: it should not place on its own');
    t.equal(standing.includes('traveltrack'), true, 'the open app should be nudged into the results');
  });

  t.test('the nudge is small enough that it only ever breaks a tie', () => {
    const q = 'what does the reports screen show';
    const target = 'traveltrack';
    const raw = scoreDoc(docFor(target), q);
    const boosted = pickDocs(DOCS, q, { currentApp: target }).find((h) => h.doc.app === target);
    t.assert(boosted, 'expected the open app to appear');
    t.equal(boosted.score - raw, 2, 'a bigger nudge would let context outrank relevance');
  });

  t.test('but it never overrides a question that names another app', () => {
    const hits = pickDocs(DOCS, 'how does StitchSense estimate a PNG', { currentApp: 'backbone' });
    t.equal(hits[0].doc.app, 'stitchsense',
      'a named app must win over the one that happens to be open');
  });

  t.test('the tie-break cannot promote a document that matched nothing', () => {
    const hits = pickDocs(DOCS, 'how are stitch counts estimated', { currentApp: 'givinggauge' });
    t.equal(hits.some((h) => h.doc.app === 'givinggauge'), false,
      'a boost on a zero score would surface an unrelated doc');
  });

  t.test('at most three documents are ever sent', () => {
    const hits = pickDocs(DOCS, 'campaign email marketing customer sales vendor employee expense');
    t.assert(hits.length <= MAX_DOCS, 'sent ' + hits.length + ' docs, cap is ' + MAX_DOCS);
  });

  t.test('results come back best first', () => {
    const hits = pickDocs(DOCS, 'how does MailMe handle unsubscribes and suppression');
    for (let i = 1; i < hits.length; i++) {
      t.assert(hits[i - 1].score >= hits[i].score, 'results are out of order');
    }
    t.assert(hits[0].score >= MIN_SCORE, 'a returned hit must clear the floor');
  });

  /* ---- the prompt ---------------------------------------------------------- */

  t.test('the prompt forbids answering from anything but the documents', () => {
    const hits = pickDocs(DOCS, 'how is the sales goal calculated');
    const p = buildPrompt(hits, 'how is the sales goal calculated', {});
    t.assert(/ONLY from the documents/i.test(p.system), 'no grounding instruction');
    t.assert(/never fill a gap with a guess/i.test(p.system),
      'the guess prohibition is the whole safety property');
  });

  t.test('the prompt says plainly that it has no live data', () => {
    const p = buildPrompt(pickDocs(DOCS, 'sales goal'), 'what are sales this month', {});
    t.assert(/no access to live business data/i.test(p.system));
  });

  t.test('the prompt carries the document text, not just its title', () => {
    const hits = pickDocs(DOCS, 'how does the time clock handle a forgotten clock out');
    const p = buildPrompt(hits, 'forgotten clock out', {});
    t.assert(p.user.includes('18 hours'),
      'the actual rule must reach the model or it will invent one');
  });

  t.test('the prompt tells the model where the person is standing', () => {
    const p = buildPrompt(pickDocs(DOCS, 'sales goal'), 'how is this calculated',
      { appName: 'BackBone', viewName: 'Dashboard' });
    t.assert(/BackBone/.test(p.user) && /Dashboard/.test(p.user));
  });

  t.test('the prompt bans em dashes, same as everything else written for Ryan', () => {
    const p = buildPrompt(pickDocs(DOCS, 'sales goal'), 'anything', {});
    t.assert(/em dash/i.test(p.system));
  });

  /* ---- the route ------------------------------------------------------------ */

  t.test('api/help.js follows the shared handler contract', () => {
    const route = read('api/help.js');
    t.assert(/export default async function handler/.test(route));
    t.assert(/requireAuth\(req, res\)/.test(route), 'help must be behind the login');
  });

  t.test('the route never calls the model when nothing scored', () => {
    const route = read('api/help.js');
    const idx = route.indexOf('if (!hits.length)');
    t.assert(idx > 0, 'no empty-hits branch');
    t.assert(idx < route.indexOf('api.anthropic.com'),
      'the "I do not know" branch must return before the model call, or it will answer anyway');
  });

  t.test('the route reads no business data', () => {
    const route = read('api/help.js');
    t.assert(!/backbone-store|crewcore\/store|traveltrack|promopro\/store|mailme\//.test(route),
      'the help route must not import any business data store');
  });

  t.test('the question log is superuser only', () => {
    const route = read('api/help.js');
    const seg = route.slice(route.indexOf('req.query.log'), route.indexOf('req.query.log') + 400);
    t.assert(/superuser !== true/.test(seg), 'the log must be gated on the superuser flag');
  });

  t.test('a failed log write never costs the asker their answer', () => {
    const lib = read('lib/help/store.js');
    const fn = lib.slice(lib.indexOf('export async function logQuestion'));
    t.assert(/try \{/.test(fn) && /catch/.test(fn),
      'logging is a diagnostic and must not throw into the response path');
  });

  t.test('the log is capped so a diagnostic cannot become an incident', () => {
    const lib = read('lib/help/store.js');
    t.assert(/MAX_ENTRIES/.test(lib) && /slice\(0, MAX_ENTRIES\)/.test(lib));
  });

  t.test('unanswered() finds the questions worth documenting', () => {
    const rows = [
      { question: 'a', answered: true },
      { question: 'b', answered: false },
      { question: 'c', answered: false },
    ];
    t.equal(unanswered(rows).length, 2);
    t.equal(unanswered(null).length, 0);
  });

  /* ---- the bubble ------------------------------------------------------------ */

  t.test('the help bubble goes through the seam like everything else', () => {
    const ui = read('js/help.js');
    t.assert(/from '\.\/api\.js'/.test(ui), 'js/help.js must use the seam');
    t.assert(!/\bfetch\(/.test(ui), 'no direct fetch outside js/api.js');
  });

  t.test('the bubble carries no hex colors', () => {
    const ui = read('js/help.js');
    t.assert(!/#[0-9a-fA-F]{3,8}\b/.test(ui), 'css/tokens.css is the only place colors live');
  });

  t.test('the shell starts the bubble and hands it the CURRENT app', () => {
    const shell = read('js/shell.js');
    t.assert(/import \{ initHelp \}/.test(shell), 'the shell must import the bubble');
    t.assert(/initHelp\(\(\) =>/.test(shell),
      'the context must be a function, or the panel answers about whatever app was open at sign-in');
  });

  t.test('the seam marks the help endpoint live', () => {
    const api = read('js/api.js');
    t.assert(/help:\s*'\/api\/help'/.test(api), 'no ENDPOINTS.help');
    t.assert(/'\/api\/help'/.test(api.slice(0, api.indexOf('export const ENDPOINTS'))),
      'help must be in LIVE_PREFIXES or it answers from mock data');
  });

  t.test('the panel tells people up front that it has no live numbers', () => {
    const ui = read('js/help.js');
    t.assert(/cannot look up live numbers/i.test(ui),
      'the limit has to be visible before somebody asks for a figure and trusts the answer');
  });

  process.exit(t.report());
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
