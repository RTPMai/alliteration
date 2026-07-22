# alliteration.

One shell, one login, five internal apps. Replaces five separate deployments.

Static files, native ES modules, no build step. Deploys to Vercel from the
folder root.

```
bash test/run.sh     # 27 tests. Never let it go red.
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
index.html            shell entry
css/tokens.css        THE ONLY place colors and dimensions are defined
css/shell.css         chrome only (header, switcher, view host)
js/api.js             THE SEAM. the only file that calls fetch()
js/registry.js        app list. two lines to add an app
js/router.js          hash routing: #/<app>/<view>
js/app-host.js        app mount contract + CSS scoping + tab adapter
js/shell.js           boot, session, app switching
js/giving-engine.js   ES adapter over the verbatim scoring engine
vendor/               verbatim algorithm ports. DO NOT EDIT
apps/<id>.js          one file per app
test/                 zero-dependency suite
```

## The three rules

**1. tokens.css owns color.** No app file declares a hex value. Components use
`var(--accent)`. Setting `data-app` on `<body>` re-themes everything. Tests fail
the build if a hex appears in `shell.css`, `index.html`, or any file in `apps/`.

**2. api.js is the seam.** No app file calls `fetch()` directly, ever. A test
enforces this. `MOCK = true` returns fake data; flipping to false hits the real
endpoints, already written in.

**3. Verbatim ports stay verbatim.** `vendor/scoring-engine.cjs` is a
byte-for-byte copy of Ryan's real algorithm. Do not improve it. If a rule
changes, it changes in the source repo and gets re-copied. `engine-parity.test`
hashes the file and fails if it drifts.

---

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

**One login.** Both `lib/session.js` files are already byte-identical except for
the cookie name (`backbone_session` vs `errorengine_session`), same HMAC, same
`SESSION_SECRET`. Consolidating is mostly deleting one and standardising the
cookie name. `SESSION_SECRET` must be identical across all apps or one-login
breaks.

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
