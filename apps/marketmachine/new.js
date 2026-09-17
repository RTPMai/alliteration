// PUT IN: apps/marketmachine/new.js
/**
 * Starting a campaign: pick the type (most used first, Ryan's call), then the
 * header. Under an event, only the types that can connect are offered.
 *
 * A factory, not a module of loose functions: every screen needs the same
 * live state, api and root element, and passing them to each call would be
 * noise. `ui` is the shared object every module's functions are hung on, so
 * one screen can call another's without importing it and creating a loop.
 */

import { CAMPAIGN_TYPES, FAMILIES, typeMeta, connectableTypes, typesByUse } from '../../lib/marketmachine/catalog.js';
import { PARTICIPATION } from '../../lib/marketmachine/campaign.js';
import { ENDPOINTS } from '../../js/api.js';
import { esc, PARTICIPATION_LABEL, msgBox } from './format.js';

export default function makeNew(app) {
  const { state, api, root, ui } = app;
  const $ = (sel) => root.querySelector(sel);

    function renderNew() {
      const pane = $('#mkNewPane');
      if (!pane) return;
      const parent = state.newParentId ? state.campaigns.find((c) => c.id === state.newParentId) : null;
      const allowed = parent ? connectableTypes(parent.type) : null;

      if (!state.newType) {
        const ranked = typesByUse(state.campaigns).filter((t) => !allowed || allowed.includes(t.key));
        const used = ranked.filter((t) => t.uses > 0);
        const card = (t) => {
          const meta = typeMeta(t.key);
          return `<button class="mk-type" data-type="${esc(t.key)}">
            <div class="n">${esc(t.label)}</div>
            <div class="s">${esc(meta.summary)}</div>
            ${t.uses ? `<div class="u">Used ${t.uses} time${t.uses === 1 ? '' : 's'}</div>` : ''}
          </button>`;
        };
        let body;
        if (used.length || parent) {
          body = `<div class="mk-types">${ranked.map(card).join('')}</div>`;
        } else {
          body = FAMILIES.map((fam) => {
            const group = ranked.filter((t) => t.family === fam.key);
            return group.length ? `<div class="mk-type-group">${esc(fam.label)}</div>
              <div class="mk-types">${group.map(card).join('')}</div>` : '';
          }).join('');
        }
        pane.innerHTML = `
          <div class="mk-hd">
            <div>
              <h1>${parent ? 'Add a connected campaign' : 'New campaign'}<span class="dot">.</span></h1>
              <div class="sub">${parent
                ? `Connected campaigns under ${esc(parent.name)} keep their own owner, dates, audience, and checklist.`
                : 'Pick the type. Its steps are laid out in order once it is created.'}</div>
            </div>
            <div class="mk-actions"><button class="mk-btn ghost sm" data-act="cancel-new">Cancel</button></div>
          </div>
          ${body}`;
        return;
      }

      const meta = typeMeta(state.newType);
      const defaults = parent ? {
        name: `${parent.name}: ${meta.label}`,
        date: parent.controlDate || '',
        am: parent.accountManagerId || '',
      } : { name: '', date: '', am: '' };

      pane.innerHTML = `
        <div class="mk-hd">
          <div>
            <h1>${esc(meta.label)}<span class="dot">.</span></h1>
            <div class="sub">${esc(meta.summary)}</div>
          </div>
          <div class="mk-actions"><button class="mk-btn ghost sm" data-act="back-types">Pick a different type</button></div>
        </div>
        ${msgBox(state.newMsg)}
        <div class="mk-card"><div class="mk-card-bd">
          ${parent ? `<div class="mk-notice">Connected to <b>${esc(parent.name)}</b>. The name, date, and
            Account Manager start from the event. Change any of them here; later changes to the event do
            not overwrite this campaign.</div>` : ''}
          <div class="mk-grid">
            <div class="mk-field full">
              <label for="mkNName">Campaign name</label>
              <input type="text" id="mkNName" maxlength="120" value="${esc(defaults.name)}">
            </div>
            <div class="mk-field">
              <label for="mkNAm">Account Manager</label>
              <div class="hint">Required when a client, recipient, or sales follow-up is involved.</div>
              <select id="mkNAm">${ui.amOptions(defaults.am)}</select>
              ${state.amUnavailable ? '<div class="hint">The account manager list could not be read from CrewCore just now.</div>' : ''}
            </div>
            <div class="mk-field">
              <label for="mkNDate">${esc(meta.controlLabel)}</label>
              <div class="hint">Due dates are suggested from this date. You can still move any of them.</div>
              <input type="date" id="mkNDate" value="${esc(defaults.date)}">
            </div>
            <div class="mk-field full">
              <span class="lbl">Audience</span>
              <div class="mk-radio">
                <label><input type="radio" name="mkNAudKind" value="list" checked> An exact list</label>
                <label><input type="radio" name="mkNAudKind" value="public"> A public audience</label>
              </div>
              <div class="hint">For a list, give the list or file name. For a public audience, describe who it is meant to reach.</div>
              <input type="text" id="mkNAudience" maxlength="500">
            </div>
            ${meta.parent ? `
              <div class="mk-field">
                <label for="mkNPart">Participation</label>
                <select id="mkNPart"><option value="">Not decided yet</option>
                  ${PARTICIPATION.map((p) => `<option value="${p}">${esc(PARTICIPATION_LABEL[p])}</option>`).join('')}
                </select>
              </div>
              <div class="mk-field">
                <label for="mkNBudget">Total budget</label>
                <input type="text" id="mkNBudget" inputmode="decimal" placeholder="Leave blank until approved">
              </div>` : ''}
            <div class="mk-field full">
              <label for="mkNNotes">Notes</label>
              <textarea id="mkNNotes" maxlength="4000"></textarea>
            </div>
          </div>
          <div class="mk-actions">
            <button class="mk-btn" data-act="create">Create campaign</button>
            <button class="mk-btn ghost" data-act="cancel-new">Cancel</button>
          </div>
        </div></div>`;
    }

    async function createFromForm() {
      const val = (id) => { const el = $('#' + id); return el ? el.value : ''; };
      const kind = root.querySelector('input[name="mkNAudKind"]:checked');
      const amId = val('mkNAm');
      const am = state.accountManagers.find((a) => a.id === amId);
      const body = {
        type: state.newType,
        parentId: state.newParentId || undefined,
        name: val('mkNName'),
        accountManagerId: amId || null,
        accountManagerName: am ? am.name : null,
        controlDate: val('mkNDate') || null,
        audienceKind: kind ? kind.value : 'list',
        audience: val('mkNAudience'),
        notes: val('mkNNotes'),
      };
      if ($('#mkNPart')) body.participation = val('mkNPart') || null;
      if ($('#mkNBudget')) body.budget = val('mkNBudget');
      try {
        const d = await api.post(ENDPOINTS.mkCampaigns, body);
        state.newMsg = null;
        await ui.loadList();
        await ui.openCampaign(d.campaign.id);
      } catch (e) {
        state.newMsg = { cls: 'err', text: e.message || 'The campaign was not created.' };
        renderNew();
      }
    }

    /* ---------------- detail ---------------- */

  return { renderNew, createFromForm };
}
