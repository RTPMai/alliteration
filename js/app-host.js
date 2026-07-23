/**
 * alliteration. — app host
 *
 * THE APP CONTRACT. Every file in apps/ default-exports an object:
 *
 *   export default {
 *     id: 'errorengine',
 *     template: '<div class="tabs">...</div>',   // markup, or async html()
 *     styles: '...css...',                        // optional, scoped on mount
 *     async mount(ctx) { ... },                   // called once
 *     showView(view) { ... },                     // called on every route change
 *     unmount() { ... }                           // optional
 *   }
 *
 * ctx = { root, api, perms, user, go, views, defaultView }
 *
 * WHY THIS SHAPE
 * The existing apps are single-file monoliths with three different nav
 * conventions: BackBone uses .nav-btn + data-page + .page, ErrorEngine uses
 * .tab + data-tab + bare ids, ShopStock uses #page-* with pathname routing.
 * Rather than force one convention (a rewrite of working code), the shell asks
 * each app for a showView(view) function and lets the app keep its own
 * internals. adaptTabs() below implements the two common patterns so a port is
 * usually one line.
 *
 * Apps are mounted once and kept in the DOM, hidden. Switching apps does not
 * re-run mount(), so in-progress form state survives.
 */

import * as api from './api.js';

const mounted = new Map();   // id -> { app, root, ctx }

/* ------------------------------------------------------------------ *
 * STYLE SCOPING
 *
 * A ported monolith brings its own CSS, written when it was the only thing on
 * the page. Selectors like `table { ... }` or `.tab.active { ... }` would leak
 * across apps. On mount, each app's styles are prefixed so they only apply
 * inside that app's host.
 *
 * This is a pragmatic text transform, not a real CSS parser. It handles the
 * selector forms these four apps actually use. @media / @keyframes / @supports
 * blocks are passed through with their inner rules scoped.
 * ------------------------------------------------------------------ */

export function scopeCss(css, scopeSelector) {
  if (!css) return '';

  // Strip comments first so braces inside them can't confuse the split.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');

  return rewriteBlock(clean, scopeSelector);
}

function rewriteBlock(css, scope) {
  let out = '';
  let i = 0;

  while (i < css.length) {
    const brace = css.indexOf('{', i);
    if (brace === -1) { out += css.slice(i); break; }

    const prelude = css.slice(i, brace).trim();
    const end = matchBrace(css, brace);
    const inner = css.slice(brace + 1, end);

    if (prelude.startsWith('@')) {
      // Nested at-rule: scope what's inside, keep the wrapper.
      const nests = /^@(media|supports|container|layer)/i.test(prelude);
      out += prelude + '{' + (nests ? rewriteBlock(inner, scope) : inner) + '}';
    } else {
      out += scopeSelectorList(prelude, scope) + '{' + inner + '}';
    }

    i = end + 1;
  }

  return out;
}

function matchBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return s.length - 1;
}

function scopeSelectorList(list, scope) {
  return list.split(',').map((sel) => {
    const s = sel.trim();
    if (!s) return s;

    // :root / html / body inside an app become the host itself. This is what
    // lets a ported app's `:root { --accent: ... }` fall away in favour of
    // tokens.css without editing the app file.
    if (/^(:root|html|body)$/i.test(s)) return scope;
    if (/^(:root|html|body)\b/i.test(s)) return s.replace(/^(:root|html|body)\b/i, scope);

    return scope + ' ' + s;
  }).join(',');
}

function injectStyles(id, css, scopeSelector) {
  const styleId = 'app-style-' + id;
  if (document.getElementById(styleId)) return;
  const el = document.createElement('style');
  el.id = styleId;
  el.textContent = scopeCss(css, scopeSelector);
  document.head.appendChild(el);
}

/* ------------------------------------------------------------------ *
 * TAB ADAPTER
 *
 * Wires an app's existing nav markup to the shell router, so clicking a tab
 * updates the URL and a deep link selects the right tab. Supports both
 * conventions found in the repos.
 *
 *   adaptTabs(root, {
 *     buttons: '.nav-btn', attr: 'page', panes: '.page', paneId: (v) => 'page-' + v
 *   })
 *
 * Returns a showView(view) function to hand back from the app module.
 * ------------------------------------------------------------------ */

export function adaptTabs(root, opts) {
  const {
    buttons = '.nav-btn',
    attr = 'page',
    panes = '.page',
    paneId = (v) => 'page-' + v,
    activeClass = 'active',
    onShow = null,
    go = null
  } = opts || {};

  if (go) {
    root.querySelectorAll(buttons).forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const view = btn.dataset[attr];
        if (!view) return;
        e.preventDefault();
        go(view);          // let the router drive; it calls showView back
      });
    });
  }

  return function showView(view) {
    root.querySelectorAll(buttons).forEach((b) => {
      b.classList.toggle(activeClass, b.dataset[attr] === view);
    });

    const target = paneId(view);
    let found = false;
    root.querySelectorAll(panes).forEach((p) => {
      const match = p.id === target;
      p.classList.toggle(activeClass, match);
      if (match) found = true;
    });

    // ErrorEngine hides panes with [hidden] rather than a class.
    if (!found) {
      const el = root.querySelector('#' + CSS.escape(target));
      if (el) {
        root.querySelectorAll(panes).forEach((p) => { p.hidden = true; });
        el.hidden = false;
      }
    }

    if (onShow) onShow(view);
  };
}

/* ------------------------------------------------------------------ *
 * MOUNTING
 * ------------------------------------------------------------------ */

export function isMounted(id) {
  return mounted.has(id);
}

export function getMounted(id) {
  return mounted.get(id) || null;
}

/**
 * Load, mount and return an app. Idempotent: mounting twice returns the
 * existing instance rather than re-running mount().
 */
export async function mountApp(meta, host, ctxExtras) {
  if (mounted.has(meta.id)) return mounted.get(meta.id);

  // TWO LAYOUTS, both supported:
  //
  //   apps/<id>.js            a single file. The default, and right for most.
  //   apps/<id>/index.js      a folder. For an app big enough that one file
  //                           stops being navigable — BackBone is ~10k lines,
  //                           where "scroll to the leads code" is a real cost.
  //
  // meta.entry picks the folder form. Everything downstream is identical: the
  // module still default-exports one app object, so the contract does not
  // change, only where the pieces live.
  //
  // Resolved against THIS module's URL rather than left relative: a bare
  // specifier is resolved against the importing module, which is usually fine,
  // but server-side URL rewriting (Vercel's cleanUrls, for one) can turn
  // "/apps/x.js" into "/apps/x" and the import then 404s with a message that
  // only says the module failed to load.
  const rel = meta.entry || (meta.id + '.js');
  const url = new URL('../apps/' + rel, import.meta.url).href;

  let mod;
  try {
    mod = await import(url);
  } catch (e) {
    // Say which path failed. "Failed to fetch dynamically imported module" on
    // its own sends you looking in the wrong place.
    throw new Error(
      'Could not load ' + url + '. Check that apps/' + rel + ' deployed ' +
      'and that the server is not rewriting .js paths. Original error: ' + e.message
    );
  }

  const app = mod.default || mod;
  if (!app || typeof app !== 'object') {
    throw new Error('apps/' + rel + ' loaded but exported no app object.');
  }

  const root = document.createElement('div');
  root.className = 'app-root';
  root.dataset.appRoot = meta.id;
  host.appendChild(root);

  if (app.styles) {
    injectStyles(meta.id, app.styles, `[data-app-root="${meta.id}"]`);
  }

  if (app.template) {
    root.innerHTML = typeof app.template === 'function' ? await app.template() : app.template;
  } else if (app.html) {
    root.innerHTML = await app.html();
  }

  const ctx = Object.assign({
    root,
    api,
    meta,
    views: meta.views,
    defaultView: meta.defaultView
  }, ctxExtras);

  if (typeof app.mount === 'function') await app.mount(ctx);

  const entry = { app, root, ctx };
  mounted.set(meta.id, entry);
  return entry;
}

export function showView(id, view, param) {
  const entry = mounted.get(id);
  if (!entry) return;
  if (typeof entry.app.showView === 'function') {
    try { entry.app.showView(view, param, entry.ctx); }
    catch (e) { console.error(`[${id}] showView failed:`, e); }
  }
}

export function unmountApp(id) {
  const entry = mounted.get(id);
  if (!entry) return;
  if (typeof entry.app.unmount === 'function') {
    try { entry.app.unmount(entry.ctx); } catch (e) { console.error(e); }
  }
  entry.root.remove();
  const style = document.getElementById('app-style-' + id);
  if (style) style.remove();
  mounted.delete(id);
}
