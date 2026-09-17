// PUT IN: apps/marketmachine/settings.js
/**
 * Every campaign type's starter steps, the BackBone lead list, and the old
 * sample campaign cleanup.
 *
 * A factory, not a module of loose functions: every screen needs the same
 * live state, api and root element, and passing them to each call would be
 * noise. `ui` is the shared object every module's functions are hung on, so
 * one screen can call another's without importing it and creating a loop.
 */

import { CAMPAIGN_TYPES, STAGES } from '../../lib/marketmachine/catalog.js';
import { timingLabel } from '../../lib/marketmachine/dates.js';
import { esc } from './format.js';

export default function makeSettings(app) {
  const { state, api, root, ui } = app;
  const $ = (sel) => root.querySelector(sel);

    function renderSettings() {
      const body = $('#mkSettingsBody');
      if (!body) return;
      if (state.limited) { body.innerHTML = `<div class="mk-notice">${esc(state.limitedMessage)}</div>`; return; }

      const typesRef = CAMPAIGN_TYPES.map((t) => `
        <details>
          <summary>${esc(t.label)}<span>${t.steps.length} steps, dated from the ${esc(t.controlLabel.toLowerCase())}</span></summary>
          ${STAGES.map((st) => {
            const inStage = t.steps.filter((s) => s.stage === st.key);
            if (!inStage.length) return '';
            return `<div class="st">${esc(st.label)}</div><ol>${inStage.map((s) =>
              `<li>${esc(s.label)} <span class="o">Owner: ${esc(s.owner)}. ${esc(timingLabel(s.timing, t.controlLabel))}.${s.na ? ' Can be marked not applicable.' : ''}${s.approval ? ' Approval.' : ''}</span></li>`).join('')}</ol>`;
          }).join('')}
        </details>`).join('');

      body.innerHTML = `
        ${msgBox(state.settingsMsg)}
        <div class="mk-card">
          <div class="mk-card-hd"><h3>Campaign types and their steps</h3>
            <span class="meta">From Jacob's handoff. Read only.</span></div>
          <div class="mk-card-bd">
            <div class="who" style="margin-bottom:12px;max-width:78ch">These are the starter checklists a new campaign
              copies when it is created. A campaign already running keeps the checklist it started with. The detailed
              campaign master documents will add to these once they arrive.</div>
            <div class="mk-steps-ref">${typesRef}</div>
          </div>
        </div>
        <div class="mk-card">
          <div class="mk-card-hd"><h3>BackBone lead list</h3>
            <span class="meta">The dropdown on BackBone's lead form</span></div>
          <div class="mk-card-bd">
            <div class="mk-field">
              <label for="mkInitiatives">One per line</label>
              <div class="hint">BackBone still labels this "Marketing initiative". Renaming it there is a later step.</div>
              <textarea id="mkInitiatives" style="min-height:140px">${esc(state.initiatives.join('\n'))}</textarea>
            </div>
            <button class="mk-btn" data-act="save-initiatives">Save the list</button>
          </div>
        </div>
        ${state.legacyCount ? `
          <div class="mk-card">
            <div class="mk-card-hd"><h3>Old sample campaigns</h3></div>
            <div class="mk-card-bd">
              <div class="mk-notice">${state.legacyCount} campaign${state.legacyCount === 1 ? '' : 's'} from before the rebuild
                ${state.legacyCount === 1 ? 'is' : 'are'} still in storage. Nothing shows them any more. Deleting removes them
                and their typed-in numbers for good.</div>
              <button class="mk-btn danger" data-act="clear-legacy">Delete the old sample campaigns</button>
            </div>
          </div>` : ''}`;
    }

    /* ---------------- events ---------------- */

  return { renderSettings };
}
