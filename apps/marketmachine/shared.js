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

  return { limitedScreen, nameOf, amOptions };
}
