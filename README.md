# alliteration.

One shell, one login, five internal apps. Replaces five separate deployments.

Static files, native ES modules, no build step. Deploys to Vercel from the
folder root.

```
bash test/run.sh     # 129 tests. Never let it go red.
```

Open `index.html` through a local server (ES modules need http, not `file://`):

```
python3 -m http.server 8000
```

Runs in mock mode by default, so it works with no backend. `?mock=0` hits real
endpoints.

---

## Layout

```
index.html            shell entry (header, rail, content region)
css/tokens.css        THE ONLY place colors and dimensions are defined
css/shell.css         chrome + shared component vocabulary, zero hex values
js/api.js             THE SEAM. the only file that calls fetch()
js/registry.js        app list. two lines to add an app
js/router.js          hash routing: #/<app>/<view>
js/app-host.js        app mount contract + CSS scoping + tab adapter
js/shell.js           boot, session, app switching
js/giving-engine.js   ES adapter over the verbatim scoring engine
vendor/               verbatim algorithm ports. DO NOT EDIT
apps/hub.js           the "All apps" landing view
apps/<id>.js          one file per app
lib/                  backend: storage, sessions, accounts
api/                  backend routes: auth, users
login.html            sign-in / first-run setup
test/                 zero-dependency suite
```

## Setup

The shell needs two environment variables in Vercel:

```
SESSION_SECRET       generate with: openssl rand -base64 32
KV_REST_API_URL      from the Upstash / Vercel KV integration
KV_REST_API_TOKEN    same
```

`SESSION_SECRET` must be the SAME value everywhere the shell runs. Changing it
signs everybody out, because existing cookies stop verifying.

First run: open the site and it redirects to `login.html`, which detects that no
accounts exist and switches into setup mode. The first account you create is the
administrator, and it is the only one that can add everyone else.

Locally, `?mock=1` skips auth and storage entirely.

## Sign-in

ONE cookie (`alliteration_session`) and ONE account list for all five apps.

Before the shell, BackBone and ErrorEngine each had their own `session.js`
(byte-identical apart from comments) and their own user store. The stores hashed
passwords in incompatible formats — BackBone `salt:hash` hex via `scryptSync`,
ErrorEngine `scrypt$N$salt$hash` base64 via async `scrypt`. Same algorithm,
mutually unreadable output.

That matters because a shared cookie with separate account lists is the worst of
both: a valid key for a building you are not on the guest list for. Merging the
cookie without merging the accounts would have looked like it worked.

The merged store keeps ErrorEngine's hashing (async, tunable, timing-safe) and
BackBone's richer permissions (per-app access, not just a role label).

  lib/kv.js         storage wrapper, everything under "alliteration:"
  lib/session.js    the one lock: sign, verify, guard
  lib/users.js      the one guest list: accounts, roles, permissions
  api/auth.js       login / logout / session / first-admin bootstrap
  api/users.js      admin-only account management
  login.html        sign-in, doubles as first-run setup

Roles grant apps by registry id, which is what `perms.tabs` carries to the front
end. Permissions are looked up fresh on every session check rather than trusted
from the cookie, so a role change takes effect on the next request instead of
waiting 12 hours for the cookie to expire.

## Ports

- **GivingGauge** — DONE. First real port. Single view (the request queue). Its
  score comes entirely from the two verbatim files in vendor/ (scoring-engine.cjs
  and gauge.cjs), reached through js/giving-engine.js and js/giving-dial.js. The
  six sample requests moved into api.js as mock data, so MOCK=false hits the real
  endpoint with no change to the app. What the port touched: removed the app's own
  header and :root, scoped every getElementById to the app root, moved the click
  listener off document, and routed data through ctx.api.
- **ShopStock** — DONE. Dashboard, Full Inventory, Admin. All 10 fetch calls go
  through the seam; all 70 DOM lookups are scoped to the app root. Its 46 inline
  `onclick` handlers are namespaced to ONE global, `window.ShopStock` (see the
  note at the top of apps/shopstock.js). The QR library loads on demand rather
  than on every page view, and printed labels now point at the shell route
  instead of the old standalone `/item/:id`, which matters because labels are
  permanent.
- **BackBone** — DONE. Six views, 8,795 lines of application code, and all 12
  API endpoints. See "What the BackBone port fixed" below.
- **ErrorEngine** — not yet ported. The last one.

### What the BackBone port fixed

Three security problems that were live in the standalone app:

- **The roster was readable by anyone.** api/data.js had no authentication and
  sent wildcard CORS: company names, revenue, invoice counts, contacts and
  scores were available to anyone with the URL, from any origin. BackBone
  contained a fixed version in lib/data.js that was never wired up; that is the
  one now deployed.
- **api/printavo-schema.js** was also unauthenticated with wildcard CORS, and it
  introspects Printavo using the shop's credentials.
- **The public intake form was broken.** api/intake.js and intake.html are
  byte-identical in the source repo — the API file contains the HTML page — so
  every submission from the "Start a Project" form posted to something that
  returned a web page. api/intake.js here is the handler that file was supposed
  to contain.

Two data-loss guards carried across deliberately:

- **save.js merges, never overwrites.** A whole-object write would destroy
  hand-entered enrichment on every Printavo sync.
- **leads-save throws on a failed write.** An earlier version returned
  { ok: true } regardless, so a failed save looked successful and nobody
  re-entered what they believed was stored.

### Account matching

GivingGauge scores a request out of 100, and 46 of those points come from the
requesting organisation's relationship and spend. Until a request is matched to
a real account those 46 score zero, so a real customer's request was
indistinguishable from a stranger's — the same submission scores F (32) unmatched
and C (56) matched.

api/customer-match.js bridges the two: given a name it searches BackBone's
roster and returns candidates in the shape the scoring engine reads. Matching is
by token overlap rather than edit distance, because organisations get renamed,
extended and abbreviated far more often than they get misspelt. Legal suffixes
and generic words (Inc, LLC, Foundation, Association) are ignored.

It SUGGESTS rather than decides. Only a single high-confidence hit applies
automatically; everything else waits for a human, because a wrong match puts a
wrong score on a real decision.

### QR labels are permanent

ShopStock prints QR labels that get stuck on physical bins. They cannot be
recalled, so both formats must work forever:

  /item/<id>                  labels printed BEFORE the shell. A vercel rewrite
                              sends these to item.html, which moves the id into
                              the hash. Do not delete that file.
  /#/shopstock/item/<id>      what the shell prints now.

The router carries a third path segment as `param`, and "item" is listed in
ShopStock's `hiddenViews`: routable by URL, but not shown in the rail. Both
halves are needed — without routable the shell rejects a scan and bounces to the
dashboard, without hidden the rail grows a dead link.

### Vendor files exist twice, on purpose

  vendor/x.cjs   what NODE requires. package.json sets "type": "module", so a
                 .js here would be parsed as ESM and require() would fail.
  vendor/x.js    what the BROWSER fetches. A .cjs has no registered MIME type,
                 so hosts serve it inconsistently: as a download, as HTML, or
                 rewritten. A .js is unambiguous.

Both are byte-identical and the parity test hashes both against the same
fingerprint, so they cannot drift.

Related: `cleanUrls` must stay OFF in vercel.json. It strips `.js` from static
URLs, which breaks the dynamic `import('../apps/<id>.js')` the shell uses to load
apps. `/login` gets an explicit rewrite instead.

### The token rule has three narrow exemptions

`apps/` may not contain hex colors, with three exceptions, each marked
`TOKEN-EXEMPT` in the source and pattern-matched by the test:

1. **Department colors** are data Ryan picks in Admin, not theming. A department
   keeps its color whichever app is on screen.
2. **QR codes** are generated images. `var(--ink)` would render a blank code.
3. **Print windows** are separate documents that never load tokens.css, so a CSS
   variable resolves to nothing there. Labels are black on white deliberately.

The exemption is declared in the code, not assumed by the test, so this stays a
real rule. A stray hex anywhere else still fails the build.

## GivingGauge intake

Donation requests come from the Jotform at form.jotform.com/231636854478064.

  api/giving-intake.js     the webhook. PUBLIC — Jotform is never signed in.
                           Can only CREATE a pending request; it cannot read,
                           edit or delete. Optional shared secret via
                           JOTFORM_WEBHOOK_TOKEN and ?token=.
  api/giving-requests.js   read + decide + backfill. Session required.
  lib/giving.js            storage and the field mapping.

Setup:
  1. Vercel env: JOTFORM_API_KEY, JOTFORM_FORM_ID (backfill only), and
     optionally JOTFORM_WEBHOOK_TOKEN.
  2. In Jotform: Settings > Integrations > Webhooks, point at
     https://<domain>/api/giving-intake
  3. Backfill once: POST /api/giving-requests?action=backfill  (admin/manager).
     Defaults to submissions from Jan 1 of the current year. Re-running is safe;
     anything already stored is skipped by submission id.

### The score is a FLOOR until a human looks

The form cannot answer everything the engine scores. Two things are left unset
on purpose:

- **The account is unmatched.** Relationship and spend are 46 of 100 points and
  score zero until someone matches the org to Apparelytics. The submitter ticking
  "current customer" is a claim, not a match.
- **Mission fit and org type are unclassified.** The engine defaults mission to
  general civic benefit and says so in its reason text.

The same real submission scores **F (26)** on arrival and **C (58)** once matched
and classified. So the arriving grade is a floor, not a verdict, and the card
says "Needs review" rather than presenting it as a decision.

Nothing infers `isReligious` or `isPolitical` from the text. Both are hard
disqualifiers, and a keyword match on "Christian" would auto-decline a school
with no trace of why. A human sets them.

## Chrome

Header and left rail are persistent: they never re-render on navigation. The
rail lists apps, and expands the active app's views beneath it as sub-nav. Only
the content region swaps.

Routes are `#/` for the hub and `#/<app>/<view>` for everything else.

The hub is a registered app like any other (`apps/hub.js`), which is why it gets
the same mount contract and its own accent. Its cross-app flow table is the
actual argument for a shared shell: each app holds a number the others need to
tell the truth about a client.

`shell.css` also carries a shared component vocabulary (`.card`, `.stat`,
`.pill`, `table`, `.bar`) so ported apps can drop their own copies. An app that
keeps its own CSS still wins inside its host, since `scopeCss()` prefixes it and
the extra specificity outranks the bare element rules.

## The three rules

**1. tokens.css owns color.** No app file declares a hex value. Components use
`var(--accent)`. Setting `data-app` on `<body>` re-themes everything. Tests fail
the build if a hex appears in `shell.css`, `index.html`, or any file in `apps/`.
The one exemption is the brand SVG artwork in the header: the P&M mark must not
recolor when the accent changes, so its fills are baked in deliberately.

**2. api.js is the seam.** No app file calls `fetch()` directly, ever. A test
enforces this. `MOCK = true` returns fake data; flipping to false hits the real
endpoints, already written in.

**3. Verbatim ports stay verbatim.** `vendor/scoring-engine.cjs` is a
byte-for-byte copy of Ryan's real algorithm. Do not improve it. If a rule
changes, it changes in the source repo and gets re-copied. `engine-parity.test`
hashes the file and fails if it drifts.

---

### An app can be a folder

Most apps are one file. BackBone is ~10,000 lines, where "go to the leads code"
becomes a scroll rather than a jump, so it splits:

  apps/backbone/index.js      the app contract, mount, routing
  apps/backbone/styles.js     575 lines of CSS, tokenised
  apps/backbone/template.js   the six pages and five modals
  apps/backbone/main.js       the application code (8,795 lines)

Selected by `entry: 'backbone/index.js'` in the registry. The contract does not
change: the entry module still default-exports one app object with the same
members. Single-file remains the default and the right choice for most apps.

The test scanners recurse into app folders. A flat readdir would skip
apps/backbone/ entirely, and a rule test that silently checks nothing is worse
than one that fails.

## Adding an app

1. `apps/<id>.js` exporting the contract below
2. Two lines in `js/registry.js`
3. A `body[data-app="<id>"]` block in `css/tokens.css`

```js
export default {
  id: 'errorengine',
  styles: `...`,        // optional; auto-scoped to this app on mount
  template: `...`,      // markup string, or an async function
  async mount(ctx) {},  // once, on first open
  showView(view) {},    // every route change
  unmount(ctx) {}       // optional
};
```

`ctx` = `{ root, api, perms, user, go, views, defaultView, meta }`.

Apps mount once and stay in the DOM, hidden. Switching apps does not re-run
`mount()`, so in-progress form state survives.

---

## Porting a monolith

The existing apps are single-file HTML with inline `<style>` and `<script>`, and
they use three different nav conventions:

| app | buttons | attribute | panes |
|---|---|---|---|
| BackBone | `.nav-btn` | `data-page` | `.page` |
| ErrorEngine | `.tab` | `data-tab` | bare ids |
| ShopStock | pathname | n/a | `#page-*` |

Rather than force one convention, the shell asks each app for `showView(view)`
and leaves the internals alone. `adaptTabs()` implements both common patterns,
so the nav wiring is usually one line:

```js
import { adaptTabs } from '../js/app-host.js';

let show;
export default {
  id: 'errorengine',
  styles: EE_CSS,
  template: EE_HTML,
  async mount(ctx) {
    show = adaptTabs(ctx.root, {
      buttons: '.tab', attr: 'tab', panes: '[data-pane]',
      paneId: (v) => v, go: ctx.go
    });
    await loadData(ctx.api);
  },
  showView(v) { show(v); }
};
```

Recipe:

1. Move the `<style>` contents into `styles`. Leave the CSS as-is; `scopeCss()`
   prefixes every selector to the app's host, and collapses `:root`/`body` so
   `tokens.css` wins. Delete only the app's own `--accent` declarations.
2. Move the `<body>` markup into `template`.
3. Move the `<script>` into `mount()`.
4. Replace every `fetch(...)` with `ctx.api.get/post(ENDPOINTS.x)`.
5. Replace the app's own nav click handler with `adaptTabs`.
6. Add tests. Never let the suite go red.

---

## Notes from the migration

**Endpoint collisions.** Four were listed; two are real file collisions
(`api/auth.js`, `api/intake.js`, both shipped by BackBone and ErrorEngine).
`users` and `customers` exist only in ErrorEngine, so nothing of BackBone's
"wins" there. All four are namespaced anyway so BackBone can add `/api/users`
later without silently stealing ErrorEngine's route. ErrorEngine's intake is
`/api/errors`, behind `ERRORS_ENDPOINT`.

**One login. DONE.** The two `session.js` files were byte-identical apart from
comments, so consolidating the cookie was easy. The part the original notes
missed: the two apps also had separate user stores with incompatible password
hashes, so a shared cookie alone would have produced a valid key for a building
you were not on the guest list for. Both are merged now. See Sign-in above.

**perms.tabs.** Currently holds BackBone's internal tab names
(`dashboard`, `roster`, ...). Under one login it must also carry app IDs.
`canAccess()` treats a list containing no app IDs as legacy and grants BackBone
only, so stored roles keep working until they are re-saved. Per-view grants use
`<appId>:<view>` so BackBone's "settings" and ErrorEngine's "settings" stay
distinct.

**GivingGauge is gold, not green.** The brief listed `#3D9A5C`, but that value
is `--success` in all four apps, and GivingGauge's gauge renders green/gold/red
as *grade* outcomes. A green accent would make the app chrome match its own
"grade A" color. The app ships gold (`#D5A029`).

**Why the engine is `.cjs`.** It ends in `module.exports` plus a `window`
global, and GivingGauge's own tests `require()` it. The shell is ESM, so
`package.json` sets `"type": "module"`, which would otherwise reinterpret a
`.js` engine as ESM and break `require`. The `.cjs` extension preserves its
semantics with the contents untouched. `js/giving-engine.js` loads it as a
classic script and re-exports the global.
