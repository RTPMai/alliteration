// PUT IN: test/concontrol-attendee-import.test.cjs
/**
 * ConControl: past attendees onto the notify list (Sep 2026).
 *
 * Ryan's ask: populate the notify list with previous attendees, whose list
 * lives in a ticketing/registration export. That export does not spell its
 * columns "name, email, city_state", and before this every row of it would
 * have imported as "no usable email". Route CALLED with a real signed session
 * over a fake Upstash.
 *
 * Rules:
 *   - common export headers are recognised; first + last become a name,
 *     city + state become where
 *   - the attendee's email beats the buyer's (one person buys for a shop)
 *   - attendees are labelled past attendee, not "asked"
 *   - somebody already on the list is left exactly as they were
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const kv = new Map();
const P = 'alliteration:';

global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.endsWith('/pipeline')) {
    const cmds = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => cmds.map(([verb, key, val]) => {
        if (verb === 'SET') { kv.set(key, val); return { result: 'OK' }; }
        if (verb === 'GET') return { result: kv.has(key) ? kv.get(key) : null };
        if (verb === 'DEL') { const had = kv.has(key); kv.delete(key); return { result: had ? 1 : 0 }; }
        if (verb === 'INCR') { const n = Number(kv.get(key) || 0) + 1; kv.set(key, String(n)); return { result: n }; }
        return { result: null };
      }),
    };
  }
  const setM = u.match(/\/set\/(.+)$/);
  if (setM && opts && opts.method === 'POST') {
    kv.set(decodeURIComponent(setM[1]), opts.body);
    return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
  }
  const key = decodeURIComponent((u.match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-concontrol-attendees';

async function cookieFor(session) {
  const s = await import(path.join(ROOT, 'lib/session.js'));
  let header = null;
  s.setSessionCookie({ setHeader: (k, v) => { if (k === 'Set-Cookie') header = v; } }, session);
  return String(header).split('; ')[0];
}

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

const RYAN = { username: 'ryan', name: 'Ryan' };

async function call(handler, { method = 'POST', query = {}, body = null } = {}) {
  const res = fakeRes();
  await handler({ method, query, body, headers: { cookie: await cookieFor(RYAN) } }, res);
  return res;
}

(async () => {
  const resp = await import(path.join(ROOT, 'lib/concontrol/responses.js'));
  const { default: route } = await import(path.join(ROOT, 'api/concontrol/responses.js'));

  /* ---------------- the header mapping ---------------- */

  t.test('a typical registration export maps onto name, email and where', () => {
    const a = resp.signupFromRow({
      'First Name': 'Pat', 'Last Name': 'Lee', 'Email Address': 'Pat@Shop.test',
      'City': 'Ames', 'State': 'IA', 'Order Date': '2026-04-02',
    });
    t.equal(a.name, 'Pat Lee', 'first and last joined');
    t.equal(a.email, 'pat@shop.test', 'email found and lowercased');
    t.equal(a.city_state, 'Ames, IA', 'city and state joined');
    t.equal(a.submitted_at.slice(0, 10), '2026-04-02', 'the order date kept');
  });

  t.test('the attendee email beats the buyer email', () => {
    const a = resp.signupFromRow({ 'Buyer Email': 'boss@shop.test', 'Attendee Email': 'crew@shop.test' });
    t.equal(a.email, 'crew@shop.test', 'the person who came');
    const b = resp.signupFromRow({ 'Buyer Email': 'boss@shop.test' });
    t.equal(b.email, 'boss@shop.test', 'buyer only when that is all there is');
  });

  t.test('our own sheet headers still work', () => {
    const a = resp.signupFromRow({ name: 'Sam', email: 'sam@x.test', city_state: 'Des Moines, IA' });
    t.equal(a.name + '|' + a.email + '|' + a.city_state, 'Sam|sam@x.test|Des Moines, IA', 'unchanged');
  });

  t.test('a date that does not parse is dropped, not stored', () => {
    t.equal(resp.signupFromRow({ email: 'a@b.test', Date: 'Tuesday' }).submitted_at, '', 'blank');
  });

  t.test('where it came from reads in words', () => {
    t.equal(resp.signupOrigin({ source: 'attendee-import' }), 'past attendee', 'attendee');
    t.equal(resp.signupOrigin({ source: 'sheet-import' }), 'asked', 'sheet');
    t.equal(resp.signupOrigin({ source: 'manual' }), 'added by hand', 'by hand');
  });

  /* ---------------- Chipply, the real export shape ---------------- */

  const chip = (first, last, email, r1, r2) => ({
    'Organization Name': 'Flyover Con', 'Name': '="Flyover Con 2026"', 'Order Number': '="1"',
    'Order Date': '2/11/2026 3:25:09 PM', 'Email': email,
    'Bill First Name': first, 'Bill Last Name': last, 'Bill City': 'Ames', 'Bill State': 'IA',
    'Additional Info Question 1': 'Recipient First Name : ' + r1,
    'Additional Info Question 2': 'Recipient Last Name : ' + r2,
  });

  t.test('Chipply: the store name in "Name" never becomes the person', () => {
    const a = resp.signupFromRow(chip('Justin', 'Sebren', 'j@s.test', 'Justin', 'Sebren'));
    t.equal(a.name, 'Justin Sebren', 'the billing name, not "Flyover Con 2026"');
    t.equal(a.city_state, 'Ames, IA', 'Bill City and Bill State recognised');
    t.equal(a.submitted_at.slice(0, 10), '2026-02-11', 'US-style order date read');
  });

  t.test('Excel-style ="..." cells are unwrapped', () => {
    t.equal(resp.signupFromRow({ email: 'a@b.test', Name: '="Solo Name"' }).name, 'Solo Name', 'no quotes or equals sign');
  });

  t.test('Chipply: the ticket holder is read out of the Additional Info cells', () => {
    t.equal(resp.ticketHolder(chip('Ann', 'Boss', 'a@b.test', 'Crew', 'Member')), 'Crew Member', 'label stripped');
    t.equal(resp.ticketHolder({ email: 'x@y.test' }), '', 'nobody named, nothing returned');
  });

  t.test('a nickname is still the same person, a different person is not', () => {
    t.assert(resp.samePerson('Mike Cline', 'Michael Cline'), 'Mike on Michael\'s order');
    t.assert(resp.samePerson('christy shellenberger', 'Christy Shellenberger'), 'case ignored');
    t.assert(!resp.samePerson('Crew Member', 'Ann Boss'), 'somebody else');
  });

  /* ---------------- the route ---------------- */

  kv.clear();
  kv.set(P + 'users', JSON.stringify({ ryan: { username: 'ryan', name: 'Ryan', superuser: true } }));

  // Somebody who asked, before the import.
  await call(route, { body: { what: 'add-signup', name: 'Asked First', email: 'asked@shop.test' } });

  const csv = [
    'Order #,First Name,Last Name,Email Address,City,State,Ticket Type',
    '1001,Pat,Lee,pat@shop.test,Ames,IA,General',
    '1001,Pat,Lee,PAT@shop.test,Ames,IA,General',
    '1002,Asked,Again,asked@shop.test,Ankeny,IA,General',
    '1003,No,Email,,Polk City,IA,General',
    '1004,Jo,Ray,jo@ray.test,,,VIP',
  ].join('\n');

  const out = await call(route, { body: { what: 'import-attendees', csv } });
  t.test('the export imports', () => {
    t.equal(out.statusCode, 200, '200');
    t.equal(out.body.created, 2, 'Pat and Jo');
    t.equal(out.body.duplicate, 2, 'Pat twice, and the person who already asked');
    t.equal(out.body.unusable, 1, 'the row with no email');
  });

  const list = (await call(route, { method: 'GET' })).body.signups;
  const by = (e) => list.find((r) => r.answers.email === e);
  t.test('attendees are labelled as attendees', () => {
    t.equal(by('pat@shop.test').source, 'attendee-import', 'past attendee');
    t.equal(by('pat@shop.test').answers.name, 'Pat Lee', 'named');
    t.equal(by('pat@shop.test').answers.city_state, 'Ames, IA', 'placed');
  });
  t.test('somebody who asked stays as they asked', () => {
    t.equal(by('asked@shop.test').source, 'manual', 'not relabelled');
    t.equal(by('asked@shop.test').answers.name, 'Asked First', 'not renamed');
  });

  const again = await call(route, { body: { what: 'import-attendees', csv } });
  t.test('importing the same export twice adds nobody', () => {
    t.equal(again.body.created, 0, 'none');
  });

  // Chipply through the route: the owner bought for the crew.
  const chipRows = [
    ['Email','Name','Bill First Name','Bill Last Name','Bill City','Bill State','Order Date','Additional Info Question 1','Additional Info Question 2'],
    ['owner@shop2.test','="Flyover Con 2026"','Ann','Boss','Ames','IA','2/11/2026 3:25:09 PM','Recipient First Name : Ann','Recipient Last Name : Boss'],
    ['owner@shop2.test','="Flyover Con 2026"','Ann','Boss','Ames','IA','2/11/2026 3:25:09 PM','Recipient First Name : Crew','Recipient Last Name : Member'],
    ['owner@shop2.test','="Flyover Con 2026"','Ann','Boss','Ames','IA','2/11/2026 3:25:09 PM','Recipient First Name : Crew','Recipient Last Name : Member'],
    ['mike@cline.test','="Flyover Con 2026"','Michael','Cline','Yankton','SD','3/1/2026 9:00:00 AM','Recipient First Name : Mike','Recipient Last Name : Cline'],
  ].map((r) => r.map((c) => '"' + c.replace(/"/g, '""') + '"').join(',')).join('\n');

  const chipOut = await call(route, { body: { what: 'import-attendees', csv: chipRows } });
  t.test('Chipply: the buyer goes on the list, the crew is named, not lost', () => {
    t.equal(chipOut.body.created, 2, 'Ann and Michael');
    t.equal(chipOut.body.noEmail.length, 1, 'one crew member with no address, named once');
    t.equal(chipOut.body.noEmail[0].name, 'Crew Member', 'by name');
    t.equal(chipOut.body.noEmail[0].via, 'Ann Boss', 'and whose order they came on');
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL concontrol-attendee-import could not run: ' + (e && e.stack || e));
  process.exit(1);
});
