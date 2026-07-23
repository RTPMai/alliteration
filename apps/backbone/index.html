/**
 * BackBone — accounts, leads, roster, scorecard.
 *
 * WHY THIS IS A FOLDER
 * Every other app is one file in apps/. BackBone is ~10,000 lines, and one file
 * that long stops being navigable: "go to the leads code" becomes a scroll
 * rather than a jump. So it splits:
 *
 *   apps/backbone/index.js      this file — the app contract, mount, routing
 *   apps/backbone/styles.js     575 lines of CSS, tokenised
 *   apps/backbone/template.js   the six pages and five modals
 *   apps/backbone/main.js       the application code (added next)
 *
 * The CONTRACT is unchanged: this still default-exports one object with the
 * same members, and app-host still mounts it the same way. Only the layout
 * differs, selected by `entry: 'backbone/index.js'` in the registry.
 *
 * PORTED — what changed from the standalone app:
 *   - The login gate, header and nav came off. The shell owns sign-in and
 *     navigation; the rail carries the six views.
 *   - Users and Roles left Settings for the shell's own Settings screen.
 *     Accounts cover every app now, so one app cannot own them.
 *   - All 57 hardcoded colors became tokens.
 */

import styles from './styles.js';
import template from './template.js';

export default {
  id: 'backbone',

  styles,
  template,

  async mount(ctx) {
    // The application code lives in its own module so this file stays readable:
    // index.js should describe the app's SHAPE, not contain 9,000 lines of it.
    //
    // Loaded optionally on purpose. The CSS and markup are ported; main.js is
    // not yet. Without this guard the whole app fails to mount and you cannot
    // see the layout at all — which makes an unfinished port indistinguishable
    // from a broken one.
    try {
      const { start } = await import('./main.js');
      this._app = await start(ctx);
    } catch (e) {
      const missing = /Failed to fetch|not found|Cannot find/i.test(e.message || '');
      if (!missing) throw e;   // a real error in main.js must still surface

      console.warn('[backbone] main.js is not present yet; rendering static markup only.');
      const note = document.createElement('div');
      note.className = 'shell-msg';
      note.style.margin = '24px auto';
      note.innerHTML =
        '<h2>Views only</h2>' +
        '<p>BackBone\'s pages and styling are ported. The application code ' +
        '(data loading, filters, the scorecard) has not been moved across yet, ' +
        'so nothing here is live.</p>';
      ctx.root.insertBefore(note, ctx.root.firstChild);
    }
  },

  showView(view, param) {
    if (this._app && typeof this._app.showView === 'function') {
      this._app.showView(view, param);
    }
  },

  unmount() {
    if (this._app && typeof this._app.teardown === 'function') {
      this._app.teardown();
    }
  }
};
