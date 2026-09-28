// PUT IN: test/promopro-imprint-paging.test.cjs
/**
 * Every imprint on the job, not the first page of them.
 *
 * Sep 28, 2026: an invoice with nine imprints showed six in PromoPro.
 * Printavo pages its connections and the lookup only ever read page one,
 * with no pageInfo asked for, so nothing said there was more. These tests
 * stand up a fake Printavo that pages the way the real one does and hold
 * the lookup to the whole job.
 */

const t = require('./harness.cjs');

(async () => {
  const pl = await import('../lib/promopro/printavo-lookup.js');
  process.env.PRINTAVO_API_TOKEN = 'x';
  process.env.PRINTAVO_EMAIL = 'x@y.com';

  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

  // Nine imprints, positions 1..9, each with one line and one imprint.
  const GROUPS = Array.from({ length: 9 }, (_, i) => ({
    id: 'g' + (i + 1),
    position: i + 1,
    lineItems: { nodes: [{ id: 'l' + (i + 1), description: 'Item ' + (i + 1), itemNumber: 'SKU' + (i + 1), items: 10 }] },
    imprints: { nodes: [{ id: 'i' + (i + 1), details: 'Art ' + (i + 1), typeOfWork: { id: 't', name: 'Screen Print' } }] },
  }));

  /** Slice a list the way a paged connection does, six to a page. */
  function page(list, after, size) {
    const start = after ? Number(after) : 0;
    const nodes = list.slice(start, start + size);
    const end = start + nodes.length;
    return { nodes, pageInfo: { hasNextPage: end < list.length, endCursor: String(end) } };
  }

  /**
   * A Printavo that pages at SIX per page whatever it is asked for, which is
   * exactly what the invoice in the bug report looked like from outside.
   */
  function fakePrintavo(opts) {
    const o = opts || {};
    pl._resetSchemaCache();
    const calls = [];
    global.fetch = async (url, init) => {
      const { query, variables } = JSON.parse(init.body);
      calls.push({ query, variables });
      if (/PromoProRoots/.test(query)) return ok({ data: {} });
      if (o.refuseArgs && /lineItemGroups\(/.test(query)) {
        return ok({ errors: [{ message: "Field 'lineItemGroups' doesn't accept argument 'first'" + " is not defined by the field" }] });
      }
      const after = variables && variables.after;

      if (/PromoProGroupLines/.test(query)) {
        const g = o.bigGroup && variables.id === o.bigGroup.id ? o.bigGroup : null;
        return ok({ data: { lineItemGroup: g ? { id: g.id, lineItems: page(g.allLines, after, 6) } : null } });
      }
      if (/PromoProImprints/.test(query)) {
        const conn = page(GROUPS, after, 6);
        conn.nodes = conn.nodes.map((g) => ({ id: g.id, imprints: g.imprints }));
        return ok({ data: { invoice: { id: '1', lineItemGroups: conn } } });
      }
      const groups = o.groups || GROUPS;
      const conn = o.refuseArgs ? { nodes: groups.slice(0, 6) } : page(groups, after, 6);
      conn.nodes = conn.nodes.map((g) => {
        if (o.bigGroup && g.id === o.bigGroup.id) {
          return { id: g.id, position: g.position, lineItems: page(o.bigGroup.allLines, null, 6) };
        }
        return { id: g.id, position: g.position, lineItems: g.lineItems };
      });
      return ok({ data: { invoice: {
        id: '1', visualId: 66700, contact: { fullName: 'Test Co' },
        lineItemGroups: conn,
      } } });
    };
    return calls;
  }

  await t.test('nine imprints come back as nine, not the first page of six', async () => {
    fakePrintavo();
    const r = await pl.getOrder('1', 'invoice');
    t.assert(r.invoice, 'the invoice should come back');
    t.equal(r.invoice.groups.length, 9);
    t.equal(r.invoice.groups.map((g) => g.imprintNumber).join(','), '1,2,3,4,5,6,7,8,9');
    t.equal(r.invoice.lines.length, 9);
    t.equal(r.invoice.warnings, undefined);
  });

  await t.test('imprints past the first page still get their text', async () => {
    fakePrintavo();
    const r = await pl.getOrder('1', 'invoice');
    const g9 = r.invoice.groups.find((g) => g.id === 'g9');
    t.assert(/Art 9/.test(g9.imprintText), 'imprint 9 had no text: "' + g9.imprintText + '"');
  });

  await t.test('the query asks for a page size and pageInfo, not the default', async () => {
    const calls = fakePrintavo();
    await pl.getOrder('1', 'invoice');
    const order = calls.find((c) => /PromoProOrder\(/.test(c.query));
    t.assert(/lineItemGroups\(first: \d+, after: \$after\)/.test(order.query), 'groups must be paged');
    t.assert(/pageInfo \{ hasNextPage endCursor \}/.test(order.query), 'without pageInfo nobody knows there is more');
    t.assert(calls.some((c) => /PromoProOrderGroups/.test(c.query) && c.variables.after === '6'),
      'the second page must be asked for from where the first ended');
  });

  await t.test('one imprint with more lines than a page gets all of them', async () => {
    const allLines = Array.from({ length: 14 }, (_, i) => ({ id: 'b' + i, description: 'Tee ' + i, itemNumber: 'PC54', items: 1 }));
    fakePrintavo({ bigGroup: { id: 'g2', allLines } });
    const r = await pl.getOrder('1', 'invoice');
    const g2 = r.invoice.groups.find((g) => g.id === 'g2');
    t.equal(g2.lines.length, 14);
  });

  await t.test('an account that refuses paging arguments still gets its order', async () => {
    fakePrintavo({ refuseArgs: true });
    const r = await pl.getOrder('1', 'invoice');
    t.assert(r.invoice, 'refusing paging must degrade to the old lookup, not break it');
    t.equal(r.invoice.groups.length, 6);
  });

  await t.test('a Printavo that says "more" forever cannot loop the lookup', async () => {
    let n = 0;
    const r = await pl.followPages(
      { nodes: [1], pageInfo: { hasNextPage: true, endCursor: 'c0' } },
      async () => { n += 1; return { nodes: [1], pageInfo: { hasNextPage: true, endCursor: 'c' + n } }; },
    );
    t.assert(n < 100, 'ran ' + n + ' pages');
    t.equal(r.complete, false);
  });

  await t.test('a repeated cursor stops the loop', async () => {
    let n = 0;
    const r = await pl.followPages(
      { nodes: [1], pageInfo: { hasNextPage: true, endCursor: 'same' } },
      async () => { n += 1; return { nodes: [2], pageInfo: { hasNextPage: true, endCursor: 'same' } }; },
    );
    t.equal(n, 1);
    t.equal(r.nodes.length, 2);
  });

  process.exit(t.report());
})();
