// PUT IN: apps/marketmachine/shared.js
/**
 * Small pieces more than one screen needs: the admin-only notice, a campaign's
 * name by id, and the Account Manager dropdown.
 *
 * A factory, not a module of loose functions: every screen needs the same
 * live state, api and root element, and passing them to each call would be
 * noise. `ui` is the shared object every module's functions are hung on, so
 * one screen can call another's without importing it and creating a loop.
 */

import { esc } from './format.js';

export default function makeShared(app) {
  const { state, api, root, ui } = app;
  const $ = (sel) => root.querySelector(sel);

    function limitedScreen() {
      return `
        <div class="mk-hd"><div><h1>MarketMachine<span class="dot">.</span></h1></div></div>
        <div class="mk-notice">${esc(state.limitedMessage)} An Admin can open campaigns and their checklists.
          Emails in MailMe can still be attached to a campaign by name.</div>`;
    }

    /* ---------------- list ---------------- */

    function nameOf(id) {
      const c = state.campaigns.find((x) => x.id === id);
      return c ? c.name : id;
    }

    function amOptions(selected, blankLabel) {
      const opts = state.accountManagers.slice();
      if (selected && !opts.some((a) => a.id === selected)) {
        const known = state.campaigns.find((c) => c.accountManagerId === selected);
        opts.push({ id: selected, name: (known && known.accountManagerName) || 'Former Account Manager' });
      }
      return `<option value="">${esc(blankLabel || 'Nobody yet')}</option>` +
        opts.map((a) => `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
    }

    /**
     * More than one Account Manager (Sep 29 2026). Ticks rather than a
     * multi-select box: a multi-select needs Ctrl-click, which nobody finds.
     * `selected` is [{ id, name }]. Someone no longer on the list stays
     * ticked under their saved name, so editing a campaign never quietly
     * drops them.
     */
    function amPicker(prefix, selected) {
      const chosen = Array.isArray(selected) ? selected : [];
      const opts = state.accountManagers.slice();
      // A saved Account Manager with a name but no id (very old records) is
      // kept as a tick too, keyed by name, so saving never drops them.
      const keyOf = (a) => a.id || ('name:' + (a.name || ''));
      chosen.forEach((a) => {
        if (!opts.some((o) => keyOf(o) === keyOf(a))) opts.push({ id: a.id || null, name: a.name || 'Former Account Manager' });
      });
      if (!opts.length) return '<div class="hint">No Account Managers to choose from yet.</div>';
      return `<div class="mk-checks" id="${esc(prefix)}" role="group" aria-label="Account Managers">` +
        opts.map((a) => `<label class="mk-check-pill"><input type="checkbox" value="${esc(keyOf(a))}" data-name="${esc(a.name)}"${chosen.some((x) => keyOf(x) === keyOf(a)) ? ' checked' : ''}> ${esc(a.name)}</label>`).join('') +
        '</div>';
    }

    function readAmPicker(prefix) {
      const box = root.querySelector('#' + prefix);
      if (!box) return undefined;
      return Array.from(box.querySelectorAll('input[type="checkbox"]:checked'))
        .map((el) => ({ id: el.value.indexOf('name:') === 0 ? null : el.value, name: el.getAttribute('data-name') || '' }));
    }

  return { limitedScreen, nameOf, amOptions, amPicker, readAmPicker };
}
