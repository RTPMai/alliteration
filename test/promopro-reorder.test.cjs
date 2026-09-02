// test/promopro-reorder.test.cjs
/**
 * PromoPro reorder: duplicating an order onto a new PO number.
 *
 * The part that matters is tested by CALLING it. copyArt takes the storage
 * copy as an argument precisely so this file can run it for real with a fake
 * store and check where the files land, rather than grepping the source and
 * proving only that the letters are there. That distinction is the reason
 * api/promopro/printavo.js was able to 500 in production for days with a
 * green suite.
 *
 * The source checks that follow are for wiring that has no function to call:
 * a button existing, a payload carrying a field.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = read('apps/promopro.js');
const posRoute = read('api/promopro/pos.js');
const copySrc = read('lib/promopro/art-copy.js');

/* ---- the real logic ----------------------------------------------------- */

(async () => {
  const ac = await import('../lib/promopro/art-copy.js');

  // A fake store. Records what it was asked to copy, and hands back what the
  // real one would: the pathname it wrote and a URL for it.
  function fakeStore(failOn) {
    const calls = [];
    return {
      calls,
      copy: async (from, to, opts) => {
        calls.push({ from, to, opts });
        const name = String(to).split('/').pop();
        if (failOn && failOn.includes(name)) throw new Error('storage said no');
        return { pathname: to + '-abc123', url: 'https://blob.example/' + to + '-abc123' };
      },
    };
  }

  const source = {
    id: 'po_old',
    poNumber: '26-66608-9',
    art: [
      { id: 'af_1', pathname: 'promopro/art/po_old/front.pdf', url: 'https://blob.example/front.pdf', filename: 'front.pdf', contentType: 'application/pdf', bytes: 1024 },
      { id: 'af_2', pathname: 'promopro/art/po_old/back.ai', url: 'https://blob.example/back.ai', filename: 'back.ai', contentType: 'application/illustrator', bytes: 2048 },
    ],
  };

  const store = fakeStore();
  const copied = await ac.copyArt(source, 'po_new', { copy: store.copy, by: 'ryan' });

  const failing = fakeStore(['back.ai']);
  const partial = await ac.copyArt(source, 'po_new', { copy: failing.copy });

  const emptyStore = fakeStore();
  const empty = await ac.copyArt({ id: 'po_old', art: [] }, 'po_new', { copy: emptyStore.copy });

  t.test('every file is copied into the NEW order\'s own folder', () => {
    // This is the whole point. The send lists the order's folder to decide
    // what artwork exists, so a file left in the old order's folder is a
    // reorder that emails the vendor with nothing attached.
    t.equal(store.calls.length, 2);
    store.calls.forEach((c) => {
      t.assert(c.to.startsWith('promopro/art/po_new/'),
        'copied to ' + c.to + ', which is not the new order\'s folder');
    });
  });

  t.test('the copy is read from the old order and written to the new one', () => {
    t.equal(store.calls[0].from, 'promopro/art/po_old/front.pdf');
    t.equal(store.calls[0].to, 'promopro/art/po_new/front.pdf');
  });

  t.test('the rows point at the copy, never at the original', () => {
    // A row still pointing at the old file is the shared-bytes bug wearing a
    // copy's clothes: deleting art on the old order would empty the new one.
    copied.art.forEach((a) => {
      t.assert(a.pathname.startsWith('promopro/art/po_new/'),
        'row points at ' + a.pathname);
      t.assert(a.pathname !== 'promopro/art/po_old/front.pdf');
    });
  });

  t.test('the filename a person recognizes survives the copy', () => {
    t.equal(copied.art[0].filename, 'front.pdf');
    t.equal(copied.art[1].filename, 'back.ai');
  });

  t.test('the copy remembers where it came from', () => {
    t.equal(copied.art[0].copiedFrom, 'promopro/art/po_old/front.pdf');
  });

  t.test('file order is kept, so the artwork reads the way it did', () => {
    t.equal(copied.art.map((a) => a.filename).join(','), 'front.pdf,back.ai');
  });

  t.test('content type and size carry over rather than being guessed again', () => {
    t.equal(copied.art[0].contentType, 'application/pdf');
    t.equal(copied.art[0].bytes, 1024);
  });

  t.test('who did it is recorded', () => {
    t.equal(copied.art[0].uploadedBy, 'ryan');
  });

  t.test('one file failing does not lose the others', () => {
    // Reported by name, because "some artwork did not copy" sends somebody
    // opening files one at a time to work out which.
    t.equal(partial.art.length, 1);
    t.equal(partial.art[0].filename, 'front.pdf');
    t.equal(partial.failed.length, 1);
    t.equal(partial.failed[0].filename, 'back.ai');
    t.assert(/storage said no/.test(partial.failed[0].error), 'the reason should survive');
  });

  t.test('a failure is a sentence somebody can act on', () => {
    const said = ac.copyProblem(partial.failed);
    t.assert(/back\.ai/.test(said), 'it should name the file: ' + said);
    t.assert(/before sending/.test(said), 'and say what to do about it');
    t.equal(ac.copyProblem([]), '');
    t.equal(ac.copyProblem(undefined), '');
  });

  t.test('an order with no artwork does no work at all', () => {
    t.equal(empty.art.length, 0);
    t.equal(emptyStore.calls.length, 0);
  });

  await t.test('copying somewhere unnamed is refused rather than guessed', async () => {
    let threw = false;
    try { await ac.copyArt(source, '', { copy: fakeStore().copy }); } catch (e) { threw = true; }
    t.assert(threw, 'a missing destination should throw, not write to a folder called undefined');
  });

  t.test('a copy always lands private, whatever the original was', () => {
    // The shared store is public and BackBone's briefs live in it. Artwork
    // that quietly became public would be a link anyone could guess.
    store.calls.forEach((c) => t.equal(c.opts.access, 'private'));
  });

  await t.test('the destination is built from the same prefix the send reads', async () => {
    const rec = await import('../lib/promopro/art-reconcile.js');
    t.assert(ac.destinationFor('po_new', { filename: 'front.pdf' }).startsWith(rec.artPrefix('po_new')),
      'art-copy and art-reconcile must agree on where a file lives, or the send cannot find it');
  });

  t.test('a nested pathname cannot escape the new order\'s folder', () => {
    // The filename is taken from the last segment on purpose.
    const dest = ac.destinationFor('po_new', { pathname: 'promopro/art/po_old/deep/front.pdf' });
    t.equal(dest, 'promopro/art/po_new/front.pdf');
  });

  /* ---- the route ------------------------------------------------------- */

  t.test('the route copies artwork for a reorder', () => {
    t.assert(/copyArt\(source, saved\.id/.test(posRoute), 'the copy should run against the saved order');
  });

  t.test('a reorder of an order that no longer exists is refused', () => {
    const fn = posRoute.slice(posRoute.indexOf('const reorderOf = body.reorderOf'));
    t.assert(/404/.test(fn.slice(0, 400)), 'a missing source should be a plain 404, not a silent blank order');
  });

  t.test('a failed copy never costs the purchase order', () => {
    // The order is real and correct. Losing it because storage had a bad
    // moment would be far worse than an order with art still to attach.
    const after = posRoute.slice(posRoute.indexOf('const saved = await savePo(record)'));
    const block = after.slice(0, after.indexOf('return res.status(200)'));
    t.assert(/try \{/.test(block) && /catch/.test(block), 'the copy has to be inside a try');
    t.assert(/artResult = \{/.test(block), 'and a failure still has to produce a result to report');
  });

  t.test('the new order records which order it came from', () => {
    t.assert(/reorderOf: source \? source\.id : null/.test(posRoute));
    t.assert(/reordered from/.test(posRoute), 'and says so in the history');
  });

  t.test('a Printavo number that already exists is refused, not silently duplicated', () => {
    t.assert(/duplicateNumber: true/.test(posRoute), 'the refusal should be answerable');
    t.assert(/confirmDuplicateNumber !== true/.test(posRoute), 'and overridable, because a second PO on one imprint is legal');
    t.assert(/409/.test(posRoute.slice(posRoute.indexOf('duplicateNumber') - 400)), 'refusals that ask a question are 409');
  });

  t.test('manual numbers are not checked, because they cannot collide', () => {
    // They come from an INCR. Checking them would cost a full listing on
    // every manual order to prove something already guaranteed.
    const guard = posRoute.slice(posRoute.indexOf('if (check.record.printavo && body.confirmDuplicateNumber'));
    t.assert(guard.startsWith('if (check.record.printavo'), 'the guard should only run for Printavo-derived numbers');
  });

  /* ---- the screen ------------------------------------------------------ */

  t.test('there is a Reorder button, and only for people who can edit', () => {
    t.assert(/id="ppReorder"/.test(app), 'the button should exist');
    const line = app.split('\n').find((l) => l.includes('id="ppReorder"'));
    t.assert(/canEdit/.test(line), 'read-only users should not be offered it: ' + line);
  });

  t.test('reordering fills the form and saves nothing', () => {
    const fn = app.slice(app.indexOf('function startReorder'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    t.assert(/renderForm\(\)/.test(body), 'it should render the form');
    t.assert(!/api\.post|api\.request/.test(body), 'and post nothing: nothing exists until Create is pressed');
  });

  t.test('a reorder starts its own clock, not the old order\'s', () => {
    // Copying the dates across would open the new order already late.
    const fn = app.slice(app.indexOf('function startReorder'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    ['submittedAt', 'confirmedAt', 'shippedAt', 'receivedAt', 'trackingNumber', 'receipts', 'history'].forEach((f) => {
      t.assert(!new RegExp('\\b' + f + '\\b').test(body), f + ' must not be carried over');
    });
  });

  t.test('the copied lines carry no received quantities', () => {
    const fn = app.slice(app.indexOf('function startReorder'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    t.assert(!/receivedQty/.test(body), 'a new order has received nothing');
  });

  t.test('the form tells you it is a reorder and what number it will get', () => {
    t.assert(/Reorder of /.test(app), 'the banner should name the order it came from');
    t.assert(/next manual number/.test(app), 'and explain where its own number comes from');
  });

  t.test('the save carries the order being copied', () => {
    const save = app.slice(app.indexOf('async function saveNew'));
    t.assert(/reorderOf: st\.reorderOf \? st\.reorderOf\.id : null/.test(save.slice(0, 1600)),
      'the create call should say which order this is a copy of');
  });

  t.test('a refusal is read off the thrown error, not the response', () => {
    // The seam throws on any non-2xx, so a 409 arrives as an exception. This
    // was live on Aug 26: the blacklist warning appeared with no question
    // attached, because the branch that asked could never be reached.
    t.assert(/function refusal\(e\)/.test(app), 'there should be one place that reads a 409 body');
    t.assert(/e\.status !== 409/.test(app));
    const save = app.slice(app.indexOf('async function saveNew'));
    const body = save.slice(0, save.indexOf('async function saveDetail'));
    t.assert(/refusal\(e\)/.test(body), 'the create path should use it');
    t.assert(/confirmDuplicateNumber\(asked\)/.test(body), 'including for a duplicate number');
    t.assert(/confirmBlacklisted\(asked\)/.test(body), 'and for a blacklisted vendor');
  });

  t.test('the wait for artwork counts the copied files too', () => {
    // A reorder arrives with art already on it. Counting only the new
    // uploads would call the wait done the moment the first one landed.
    const save = app.slice(app.indexOf('async function saveNew'));
    t.assert(/const already = Number\(res && res\.artCopied\)/.test(save));
    t.assert(/already \+ st\.stagedArt\.length/.test(save));
  });

  t.test('a copy that failed is reported on the order, not swallowed', () => {
    const save = app.slice(app.indexOf('async function saveNew'));
    t.assert(/res\.artProblem/.test(save), 'the server\'s sentence should reach the screen');
  });

  t.test('art-copy explains why a pointer would have been wrong', () => {
    // The next person to read this will be tempted by the shortcut. The
    // reasoning has to be here, not in a chat log.
    t.assert(/WHY A COPY AND NOT A POINTER/.test(copySrc));
  });

  process.exit(t.report());
})();
