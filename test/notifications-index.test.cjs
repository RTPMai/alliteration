/**
 * Notifications index tests (Aug 2026).
 *
 * WHY THIS FILE EXISTS
 * The header bell polls once a minute per open browser tab. It used to ask
 * for the full notification list and take .length, and the route answered
 * by reading every record one at a time. That was one Upstash command per
 * notification, per poll, per tab, growing every time anyone created a
 * notification, and it was the single largest consumer of the command
 * budget on a free-tier database.
 *
 * The index now carries a summary per notification so the count is one
 * command. That buys speed at the cost of a SECOND COPY of five fields,
 * and a second copy of a fact drifts the first time a write path forgets
 * it. These tests exist mostly to make that drift impossible to ship:
 * every write path is exercised and the count is re-read afterwards.
 *
 * These are REAL function calls against a fake Upstash that actually
 * stores values and counts commands, not source-text matching. The command
 * counts asserted below are the point of the change, so they are pinned
 * as numbers rather than described in a comment.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---- fake Upstash ---------------------------------------------------- *
 * Implements the four commands the store issues (GET, SET, DEL, INCR)
 * over an in-memory map, and counts COMMANDS rather than HTTP requests,
 * because commands are what Upstash bills and what ran out.
 * --------------------------------------------------------------------- */

const kv = new Map();
let commandCount = 0;

function resetKv() { kv.clear(); commandCount = 0; }

global.fetch = async (url, opts) => {
  const u = String(url);

  if (u.endsWith('/pipeline')) {
    const cmds = JSON.parse(opts.body);
    commandCount += cmds.length;
    const results = cmds.map(([op, key, val]) => {
      if (op === 'GET') return { result: kv.has(key) ? kv.get(key) : null };
      if (op === 'SET') { kv.set(key, val); return { result: 'OK' }; }
      if (op === 'DEL') { const had = kv.delete(key); return { result: had ? 1 : 0 }; }
      if (op === 'INCR') {
        const n = (Number(kv.get(key)) || 0) + 1;
        kv.set(key, String(n));
        return { result: n };
      }
      return { result: null };
    });
    return { ok: true, status: 200, json: async () => results };
  }

  commandCount += 1;
  const key = decodeURIComponent((u.match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

// Set BEFORE the import: the store reads these at module load.
process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';

/**
 * Await the body fully, THEN report through the harness. The harness is
 * synchronous, so handing it an async function would mark a test passed
 * before its assertions ran.
 */
async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const store = await import(path.join(ROOT, 'lib/notifications/store.js'));
  const { keys } = await import(path.join(ROOT, 'lib/notifications/schema.js'));

  const note = (over) => ({
    id: 'N-00001', assignedTo: 'margo', createdBy: 'ryan', status: 'open',
    visibility: 'team', message: 'check the ship date',
    createdAt: '2026-08-20T12:00:00.000Z', ...over,
  });

  // How many open items is this person looking at? Exactly what the bell asks.
  const bellCount = async (who) => store.countSummaries(
    await store.listNotificationSummaries(), { assignedTo: who, status: 'open' }, who,
  );

  async function seed(n, over) {
    resetKv();
    for (let i = 1; i <= n; i++) {
      await store.saveNotification(note({ id: `N-${String(i).padStart(5, '0')}`, ...(over || {}) }));
    }
  }

  /* ---- the summary ---------------------------------------------------- */

  await check('a summary carries exactly the fields the count is computed from', async () => {
    const s = store.summaryOf(note({ message: 'a long message that must not be copied' }));
    t.equal(Object.keys(s).sort().join(','), 'assignedTo,createdBy,id,status,visibility');
    t.assert(!('message' in s), 'the index must not become a second copy of the record body');
  });

  await check('a record missing status or visibility summarises to the same defaults the filters assume', async () => {
    const s = store.summaryOf({ id: 'N-1', assignedTo: 'Margo', createdBy: 'Ryan' });
    t.equal(s.status, 'open', 'no status means open, matching the list view');
    t.equal(s.visibility, 'team', 'no visibility means team, matching hidden() in the route');
    t.equal(s.assignedTo, 'margo', 'usernames are compared lowercased everywhere else');
    t.equal(s.createdBy, 'ryan');
  });

  /* ---- the point of the whole change ---------------------------------- */

  await check('the index holds summaries, not bare ids', async () => {
    await seed(3);
    const raw = JSON.parse(kv.get(keys.index()));
    t.assert(typeof raw[0] === 'object', 'a bare id would force a record read to answer any question');
    t.equal(raw.length, 3);
  });

  await check('the bell count costs ONE command', async () => {
    await seed(12);
    commandCount = 0;
    const n = await bellCount('margo');
    t.equal(n, 12, 'the count itself must still be right');
    t.equal(commandCount, 1, 'reading the index is the only storage call the bell may make');
  });

  await check('the bell cost does not grow with the number of notifications', async () => {
    await seed(5);
    commandCount = 0;
    await bellCount('margo');
    const small = commandCount;

    await seed(60);
    commandCount = 0;
    await bellCount('margo');
    const large = commandCount;

    t.equal(small, large, 'this is the regression that ran the free tier out: cost scaled with the table');
    t.equal(large, 1);
  });

  /* ---- drift: every write path must move the summary too --------------- */

  await check('marking an item done drops it out of the count', async () => {
    await seed(3);
    t.equal(await bellCount('margo'), 3);
    await store.updateNotification('N-00002', { status: 'done' });
    t.equal(await bellCount('margo'), 2,
      'updateNotification used to write the record only, which would leave the badge permanently wrong');
  });

  await check('reassigning moves the count from one person to the other', async () => {
    await seed(2);
    t.equal(await bellCount('margo'), 2);
    t.equal(await bellCount('hannah'), 0);
    await store.updateNotification('N-00001', { assignedTo: 'hannah' });
    t.equal(await bellCount('margo'), 1);
    t.equal(await bellCount('hannah'), 1);
  });

  await check('reopening a done item brings it back into the count', async () => {
    await seed(1);
    await store.updateNotification('N-00001', { status: 'done' });
    t.equal(await bellCount('margo'), 0);
    await store.updateNotification('N-00001', { status: 'open' });
    t.equal(await bellCount('margo'), 1);
  });

  await check('deleting removes the summary as well as the record', async () => {
    await seed(3);
    t.equal(await store.deleteNotification('N-00002'), true);
    t.equal(await bellCount('margo'), 2);
    const ids = await store.listNotificationIds();
    t.assert(!ids.includes('N-00002'), 'a deleted id left in the index would be counted forever');
    t.equal(await store.deleteNotification('N-00002'), false, 'deleting twice must not report success');
  });

  await check('saving the same id twice updates in place instead of duplicating', async () => {
    await seed(1);
    await store.saveNotification(note({ id: 'N-00001', status: 'done' }));
    const ids = await store.listNotificationIds();
    t.equal(ids.length, 1, 'a resave must not add a second summary for one record');
    t.equal(await bellCount('margo'), 0);
  });

  await check('the record stays the source of truth and the full list still reads it', async () => {
    await seed(2);
    const list = await store.listNotifications();
    t.equal(list.length, 2);
    t.assert(list[0].message, 'the list view needs the body, which only the record has');
  });

  /* ---- privacy --------------------------------------------------------- */

  await check('a private item counts for its creator and nobody else', async () => {
    resetKv();
    await store.saveNotification(note({ id: 'N-00001', assignedTo: 'ryan', createdBy: 'ryan', visibility: 'private' }));
    await store.saveNotification(note({ id: 'N-00002', assignedTo: 'ryan', createdBy: 'margo', visibility: 'private' }));
    const summaries = await store.listNotificationSummaries();
    t.equal(store.countSummaries(summaries, { assignedTo: 'ryan', status: 'open' }, 'ryan'), 1,
      'only the item ryan created may be counted for ryan');
    t.equal(store.countSummaries(summaries, { assignedTo: 'ryan', status: 'open' }, 'margo'), 1,
      "margo's own private item stays visible to margo");
    t.equal(store.countSummaries(summaries, { assignedTo: 'ryan', status: 'open' }, 'hannah'), 0,
      'a third party sees neither, admin or not');
  });

  /* ---- migration off the old id-only index ----------------------------- */

  await check('a legacy id-only index is upgraded on first read', async () => {
    resetKv();
    // Exactly what is in production right now: records written, index of ids.
    kv.set(keys.record('N-00001'), JSON.stringify(note({ id: 'N-00001' })));
    kv.set(keys.record('N-00002'), JSON.stringify(note({ id: 'N-00002', status: 'done' })));
    kv.set(keys.index(), JSON.stringify(['N-00001', 'N-00002']));

    t.equal(await bellCount('margo'), 1, 'the count must be right on the very first read after deploy');
    const raw = JSON.parse(kv.get(keys.index()));
    t.assert(typeof raw[0] === 'object', 'the index must have been rewritten as summaries');
  });

  await check('the migration happens once, not on every poll', async () => {
    resetKv();
    for (let i = 1; i <= 10; i++) {
      kv.set(keys.record(`N-${String(i).padStart(5, '0')}`), JSON.stringify(note({ id: `N-${String(i).padStart(5, '0')}` })));
    }
    kv.set(keys.index(), JSON.stringify(Array.from({ length: 10 }, (_, i) => `N-${String(i + 1).padStart(5, '0')}`)));

    commandCount = 0;
    await bellCount('margo');
    const first = commandCount;
    t.assert(first > 1, 'the upgrade itself has to read the records once');

    commandCount = 0;
    await bellCount('margo');
    t.equal(commandCount, 1, 'every poll after the upgrade must be cheap');
  });

  await check('rebuilding regenerates the index from the records', async () => {
    await seed(3);
    // Corrupt the index by hand, the way a half-completed write would.
    kv.set(keys.index(), JSON.stringify([]));
    t.equal(await bellCount('margo'), 0, 'an empty index reads as empty, which is why a repair path exists');

    kv.set(keys.index(), JSON.stringify(['N-00001', 'N-00002', 'N-00003']));
    const rebuilt = await store.rebuildIndex();
    t.equal(rebuilt.length, 3);
    t.equal(await bellCount('margo'), 3);
  });

  await check('rebuilding drops an id whose record is gone', async () => {
    await seed(2);
    kv.delete(keys.record('N-00002'));
    const rebuilt = await store.rebuildIndex();
    t.equal(rebuilt.length, 1, 'an orphan id must not survive as a null or an inflated count');
    t.equal(rebuilt[0].id, 'N-00001');
  });

  /* ---- the fallback ---------------------------------------------------- */

  await check('the index refuses filters it cannot answer', async () => {
    t.equal(store.canCountFromIndex({ assignedTo: 'margo', status: 'open' }), true);
    t.equal(store.canCountFromIndex({ createdBy: 'ryan', visibility: 'team' }), true);
    t.equal(store.canCountFromIndex({ assignedTo: 'margo', appId: 'backbone' }), false,
      'app tags live on the record, so counting them from the index would be a guess');
    t.equal(store.canCountFromIndex({ type: 'handoff' }), false);
    t.equal(store.canCountFromIndex({ assignedTo: 'margo', appId: '' }), true,
      'an empty filter is not a filter');
  });

  /* ---- wiring ---------------------------------------------------------- */

  await check('the route exposes count mode and falls back rather than guessing', async () => {
    const route = read('api/notifications.js');
    t.assert(/q\.count === "1"/.test(route), 'the route must offer a count-only mode');
    t.assert(/canCountFromIndex/.test(route), 'count mode must check the filters are answerable');
    t.assert(/countSummaries\(summaries, filters, me\)/.test(route),
      'the count must apply the same privacy rule as the list');
    const countBlock = route.slice(route.indexOf('q.count === "1"'));
    t.assert(countBlock.indexOf('listNotifications()') > countBlock.indexOf('listNotificationSummaries()'),
      'an unanswerable filter must fall through to the full list, not return a wrong number');
  });

  await check('the shell asks for a count and stops polling in a hidden tab', async () => {
    const shell = read('js/shell.js');
    t.assert(/count: '1'/.test(shell), 'the bell must use the cheap endpoint');
    t.assert(/typeof data\.count === 'number'/.test(shell),
      'it must read the count, while still tolerating the old list shape mid-deploy');
    t.assert(/document\.visibilityState/.test(shell), 'a hidden tab must be detectable');
    t.assert(/addEventListener\('visibilitychange'/.test(shell),
      'coming back to the tab has to refresh, or the badge goes stale');
    t.assert(/function stopBellPolling/.test(shell), 'a hidden tab must clear its interval, not just skip the fetch');
    t.assert(/bellVisibilityBound/.test(shell),
      'the listener must bind once, or every sign-in stacks another refresh');
  });

  process.exit(t.report());
})().catch((e) => {
  console.log('  FAIL notifications-index suite could not run: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
