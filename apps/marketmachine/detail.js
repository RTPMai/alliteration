// PUT IN: apps/marketmachine/detail.js
/**
 * One campaign: what is next first, then the header, then the six stages with
 * every step, then connections and calculations, then close out and history.
 *
 * A factory, not a module of loose functions: every screen needs the same
 * live state, api and root element, and passing them to each call would be
 * noise. `ui` is the shared object every module's functions are hung on, so
 * one screen can call another's without importing it and creating a loop.
 */

import { STAGES, typeMeta, connectableTypes } from '../../lib/marketmachine/catalog.js';
import { progress, headerDates, ownerFor, unmetDependencies, PARTICIPATION, amsOf, amNames, PLATFORMS, platformsOf, platformLabel, usesPlatforms, stepGate } from '../../lib/marketmachine/campaign.js';
import { dueDateFor, timingLabel } from '../../lib/marketmachine/dates.js';
import { esc, fmtDate, fmtStamp, statusClass, PARTICIPATION_LABEL, msgBox } from './format.js';

export default function makeDetail(app) {
  const { state, api, root, ui } = app;
  const $ = (sel) => root.querySelector(sel);

    function headerView(c, meta, dates) {
      const v = (x) => x ? `<div class="v">${x}</div>` : '<div class="v none">Not set</div>';
      const audience = c.audience
        ? (c.audienceKind === 'public' ? 'Public audience: ' + esc(c.audience) : esc(c.audience))
        : '';
      return `
        <div class="mk-head">
          <div><div class="k">Campaign name and project number</div>${v(esc(c.name) + ' <span class="who">' + esc(c.id) + '</span>')}</div>
          <div><div class="k">Campaign type</div>${v(esc(meta.label || c.type))}</div>
          <div><div class="k">${amsOf(c).length > 1 ? 'Account Managers' : 'Account Manager'}</div>${v(esc(amNames(c)))}</div>
          <div><div class="k">Approver</div>${v('Ryan or Megan')}</div>
          <div><div class="k">Audience</div>${v(audience)}</div>
          <div><div class="k">Working start date</div>${v(esc(fmtDate(dates.workingStart)))}</div>
          <div><div class="k">Prelaunch review date</div>${v(esc(fmtDate(dates.prelaunchReview)))}</div>
          <div><div class="k">${esc(meta.controlLabel || 'Launch date')}</div>${v(esc(fmtDate(dates.control)))}</div>
          <div><div class="k">Post-launch review date</div>${v(esc(fmtDate(dates.postLaunchReview)))}</div>
          ${meta.parent ? `
            <div><div class="k">Participation</div>${v(esc(PARTICIPATION_LABEL[c.participation] || ''))}</div>
            <div><div class="k">Total budget</div>${v(c.budget != null ? '$' + Number(c.budget).toLocaleString() : '')}</div>` : ''}
          ${c.notes ? `<div style="grid-column:1/-1"><div class="k">Notes</div><div class="v" style="white-space:pre-wrap">${esc(c.notes)}</div></div>` : ''}
        </div>`;
    }

    function headerForm(c, meta) {
      return `
        <div class="mk-grid">
          <div class="mk-field full"><label for="mkHName">Campaign name</label>
            <input type="text" id="mkHName" maxlength="120" value="${esc(c.name)}"></div>
          <div class="mk-field"><span class="lbl">Account Managers</span>
            ${ui.amPicker('mkHAms', amsOf(c))}</div>
          <div class="mk-field"><label for="mkHDate">${esc(meta.controlLabel)}</label>
            <div class="hint">Moving this moves every suggested due date. Dates somebody set by hand stay put.</div>
            <input type="date" id="mkHDate" value="${esc(c.controlDate || '')}"></div>
          <div class="mk-field full"><span class="lbl">Audience</span>
            <div class="mk-radio">
              <label><input type="radio" name="mkHAudKind" value="list"${c.audienceKind !== 'public' ? ' checked' : ''}> An exact list</label>
              <label><input type="radio" name="mkHAudKind" value="public"${c.audienceKind === 'public' ? ' checked' : ''}> A public audience</label>
            </div>
            <input type="text" id="mkHAudience" maxlength="500" value="${esc(c.audience || '')}"></div>
          ${meta.parent ? `
            <div class="mk-field"><label for="mkHPart">Participation</label>
              <select id="mkHPart"><option value="">Not decided yet</option>
                ${PARTICIPATION.map((p) => `<option value="${p}"${c.participation === p ? ' selected' : ''}>${esc(PARTICIPATION_LABEL[p])}</option>`).join('')}
              </select></div>
            <div class="mk-field"><label for="mkHBudget">Total budget</label>
              <input type="text" id="mkHBudget" inputmode="decimal" value="${c.budget != null ? esc(c.budget) : ''}"></div>` : ''}
          <div class="mk-field full"><label for="mkHNotes">Notes</label>
            <textarea id="mkHNotes" maxlength="4000">${esc(c.notes || '')}</textarea></div>
        </div>
        <div class="mk-actions">
          <button class="mk-btn" data-act="save-header">Save</button>
          <button class="mk-btn ghost" data-act="cancel-header">Cancel</button>
        </div>`;
    }

    function stepRow(c, s, today) {
      const due = dueDateFor(s, c.controlDate);
      const clear = s.done || s.notApplicable;
      const late = !clear && due && due < today;
      const unmet = clear ? [] : unmetDependencies(c, s.key);
      const gate = clear ? '' : stepGate(c, s.key);
      const locked = unmet.length > 0 || !!gate;
      const open = state.openStep === s.key;
      const m = state.stepMsg[s.key];
      const cls = ['mk-step', s.done ? 'is-done' : '', s.notApplicable ? 'is-na' : '', late ? 'is-late' : ''].join(' ');
      const timing = timingLabel(s.timing, (typeMeta(c.type) || {}).controlLabel);
      const editable = c.status === 'open';

      const control = s.approval && !s.done && !s.notApplicable
        ? `<button class="mk-btn sm" data-approve="${esc(s.key)}"${locked || !editable ? ' disabled' : ''}>Approve</button>`
        : '';

      return `
        <div class="${cls}" data-step="${esc(s.key)}">
          <div class="mk-step-row">
            <input type="checkbox" class="mk-check" data-done="${esc(s.key)}" aria-label="Done: ${esc(s.label)}"
              ${s.done ? 'checked' : ''}${(locked && !s.done) || s.notApplicable || !editable || (s.approval && !s.done) ? ' disabled' : ''}>
            <div>
              <div class="lbl">${esc(s.label)}</div>
              ${s.help ? `<div class="help">${esc(s.help)}</div>` : ''}
              <div class="facts">
                <span>Owner: <b>${esc(ownerFor(s, c))}</b></span>
                <span>Due: ${due ? `<b class="${late ? 'late' : ''}">${esc(fmtDate(due))}</b>` : '<b>No date</b>'}${s.dueOverride ? ' (set by hand)' : ''}</span>
                <span>Timing: ${esc(timing)}</span>
                ${s.done ? `<span>${s.approval ? 'Approved' : 'Done'} ${esc(fmtDate(s.doneAt))}${s.doneBy ? ' by ' + esc(s.doneBy) : ''}</span>` : ''}
                ${s.notApplicable ? '<span><b>Not applicable</b></span>' : ''}
              </div>
              ${unmet.length ? `<div class="wait">Waiting on: ${esc(unmet[0].label)}</div>` : gate ? `<div class="wait">${esc(gate)}</div>` : ''}
              ${s.blocked ? `<div class="blocker">Blocked: ${esc(s.blocked)}</div>` : ''}
              ${s.notes && !open ? `<div class="noted">${esc(s.notes)}</div>` : ''}
              ${(s.links || []).length && !open ? `<div class="facts">${s.links.map((l) =>
                `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || l.url)}</a>`).join('')}</div>` : ''}
              ${m ? `<div class="${m.cls === 'ok' ? 'mk-ok' : 'mk-err'}" style="margin:8px 0 0">${esc(m.text)}</div>` : ''}
            </div>
            <div class="mk-step-side">
              ${control}
              <button class="mk-btn ghost sm" data-more="${esc(s.key)}" aria-expanded="${open}">${open ? 'Close' : 'Details'}</button>
            </div>
          </div>
          ${open ? stepDetails(c, s, due) : ''}
        </div>`;
    }

    function stepDetails(c, s, due) {
      const editable = c.status === 'open';
      const dis = editable ? '' : ' disabled';
      const links = (s.links || []).map((l) => `${l.label ? l.label + ' ' : ''}${l.url}`).join('\n');
      return `
        <div class="mk-step-more">
          <div class="mk-grid">
            <div class="mk-field">
              <label for="mkSDue-${esc(s.key)}">Due date</label>
              <div class="hint">${s.dueOverride ? 'Set by hand. Clear it to go back to the suggested date.' : 'Suggested from the campaign date. Change it to set it by hand.'}</div>
              <input type="date" id="mkSDue-${esc(s.key)}" value="${esc(due || '')}"${dis}>
            </div>
            ${s.done ? `
              <div class="mk-field">
                <label for="mkSDoneAt-${esc(s.key)}">Date completed</label>
                <div class="hint">Change it if the work was done on an earlier day.</div>
                <input type="date" id="mkSDoneAt-${esc(s.key)}" value="${esc(s.doneAt || '')}" max="${esc(state.today)}"${dis}>
              </div>` : ''}
            ${!s.done ? `
              <div class="mk-field full">
                <label for="mkSBlock-${esc(s.key)}">What is blocking this</label>
                <div class="hint">Leave blank when nothing is.</div>
                <input type="text" id="mkSBlock-${esc(s.key)}" maxlength="500" value="${esc(s.blocked || '')}"${dis}>
              </div>` : ''}
            <div class="mk-field full">
              <label for="mkSNotes-${esc(s.key)}">Details and notes</label>
              <textarea id="mkSNotes-${esc(s.key)}" maxlength="4000"${dis}>${esc(s.notes || '')}</textarea>
            </div>
            <div class="mk-field full">
              <label for="mkSLinks-${esc(s.key)}">Files and links</label>
              <div class="hint">One per line: an optional name, then the web address. Printavo invoices, artwork, and receipts go here.</div>
              <textarea id="mkSLinks-${esc(s.key)}"${dis} placeholder="Printavo invoice https://www.printavo.com/invoices/12345">${esc(links)}</textarea>
            </div>
          </div>
          <div class="mk-actions" style="margin-bottom:10px">
            <button class="mk-btn sm" data-save-step="${esc(s.key)}"${dis}>Save details</button>
            ${s.na ? (s.notApplicable
              ? `<button class="mk-btn ghost sm" data-na="${esc(s.key)}" data-na-to="0"${dis}>This step applies after all</button>`
              : (!s.done ? `<button class="mk-btn ghost sm" data-na="${esc(s.key)}" data-na-to="1"${dis}>Mark not applicable</button>` : ''))
              : ''}
            ${s.done ? `<button class="mk-btn ghost sm" data-undo="${esc(s.key)}"${dis}>Mark not done</button>` : ''}
          </div>
        </div>`;
    }

    /**
     * Platforms and art (Sep 29 2026). Only on campaign types whose checklist
     * picks platforms. Tick a platform, then each ticked one gets its art
     * (upload, or a link for anything big) and, once it is live, the link to
     * the post or ad. The checklist's platform and Art steps stay locked
     * until this is filled in; the server holds the same rule.
     */
    function platformsCard(c) {
      if (!usesPlatforms(c)) return '';
      const chosen = platformsOf(c);
      const art = Array.isArray(c.art) ? c.art : [];
      const links = c.platformLinks || {};
      const m = state.platMsg;
      const up = state.artUploading || {};
      const per = chosen.map((k) => {
        const mine = art.filter((a) => a.platform === k);
        return `
          <div class="mk-plat">
            <div class="mk-plat-hd"><b>${esc(platformLabel(k))}</b>
              ${mine.length ? `<span class="who">${mine.length} art file${mine.length === 1 ? '' : 's'}</span>` : '<span class="late">Needs art</span>'}</div>
            ${mine.length ? `<ul class="mk-art">${mine.map((a) => `
              <li><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name || 'Art file')}</a>
                <span class="who">${a.kind === 'link' ? 'link' : 'file'}${a.by ? ', ' + esc(a.by) : ''}</span>
                <button class="mk-link" data-art-remove="${esc(a.url)}">Remove</button></li>`).join('')}</ul>` : ''}
            <div class="mk-actions">
              <label class="mk-btn sm mk-upload">${up[k] ? 'Uploading' : 'Upload art'}
                <input type="file" data-art-file="${esc(k)}" accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.mp4" hidden${up[k] ? ' disabled' : ''}></label>
              <input type="url" class="mk-inline-input" id="mkArtLink-${esc(k)}" placeholder="Or paste a link to the art (Dropbox, Canva, Drive)">
              <button class="mk-btn ghost sm" data-art-link="${esc(k)}">Add link</button>
            </div>
            <div class="mk-actions" style="margin-top:8px">
              <input type="url" class="mk-inline-input" id="mkPostLink-${esc(k)}" value="${esc(links[k] || '')}" placeholder="Link to the live post or ad, once it is up">
              <button class="mk-btn ghost sm" data-post-link="${esc(k)}">Save link</button>
              ${links[k] ? `<a class="mk-link" href="${esc(links[k])}" target="_blank" rel="noopener">Open</a>` : ''}
            </div>
          </div>`;
      }).join('');
      return `
        <div class="mk-card" id="mkPlatforms">
          <div class="mk-card-hd"><h3>Platforms and art</h3><span class="meta">Tick where this runs. Only ticked platforms get art.</span></div>
          <div class="mk-card-bd">
            ${m ? msgBox(m) : ''}
            <div class="mk-checks" role="group" aria-label="Platforms">
              ${PLATFORMS.map((p) => `<label class="mk-check-pill"><input type="checkbox" data-platform="${esc(p.key)}"${chosen.includes(p.key) ? ' checked' : ''}> ${esc(p.label)}</label>`).join('')}
            </div>
            ${chosen.length ? per : '<div class="who" style="margin-top:8px">Nothing ticked yet. The platform and Art steps unlock once you pick.</div>'}
            <div class="who" style="margin-top:8px">Files up to 3 MB (PNG, JPG, GIF, WebP, PDF, MP4). Anything bigger, add as a link.</div>
          </div>
        </div>`;
    }

    function renderDetail() {
      const det = $('#mkDetailPane');
      if (!det || !state.detail) return;
      const { campaign: c, parent, children, connections } = state.detail;
      const meta = typeMeta(c.type) || { label: c.type, controlLabel: 'Launch date' };
      const today = state.today;
      const p = progress(c, today);
      const dates = headerDates(c);
      const steps = Array.isArray(c.steps) ? c.steps : [];
      const connectable = connectableTypes(c.type);

      const stageTabs = STAGES.map((st, i) => {
        const inStage = steps.filter((s) => s.stage === st.key);
        const clear = inStage.filter((s) => s.done || s.notApplicable).length;
        const pct = inStage.length ? Math.round((clear / inStage.length) * 100) : 100;
        const isDone = inStage.length > 0 && clear === inStage.length;
        const current = p.stage === st.key && c.status === 'open';
        return `<button class="mk-stage-tab${isDone ? ' done' : ''}${current ? ' current' : ''}" data-jump="${st.key}"
            aria-label="${esc(st.label)}: ${clear} of ${inStage.length} done">
          <div class="num">${i + 1}</div>
          <div class="nm">${esc(st.label)}</div>
          <div class="ct">${inStage.length ? `${clear} of ${inStage.length}` : 'No steps'}</div>
          <div class="bar"><i style="width:${pct}%"></i></div>
        </button>`;
      }).join('');

      const stageSections = STAGES.map((st, i) => {
        const inStage = steps.filter((s) => s.stage === st.key);
        const clear = inStage.filter((s) => s.done || s.notApplicable).length;
        return `
          <section class="mk-stage" id="mkStage-${st.key}">
            <div class="mk-stage-hd"><h2>${i + 1}. ${esc(st.label.toLowerCase())}.</h2>
              <span class="ct">${inStage.length ? `${clear} of ${inStage.length} done` : ''}</span></div>
            <div class="about">${esc(st.about)}</div>
            ${inStage.length ? inStage.map((s) => stepRow(c, s, today)).join('')
              : `<div class="nothing">${esc(meta.label)} has no steps in this stage.</div>`}
          </section>`;
      }).join('');

      let now;
      if (c.status !== 'open') {
        now = `<div class="mk-now done"><div class="k">This campaign is ${esc(c.status)}</div>
          <div class="facts">Reopen it to change steps.</div></div>`;
      } else if (!p.next) {
        now = `<div class="mk-now done"><div class="k">Every step is finished</div>
          <div class="step">Ready to close</div>
          <div class="facts">Mark it complete below when the results are in.</div></div>`;
      } else {
        const late = p.next.due && p.next.due < today;
        now = `<div class="mk-now">
          <div class="k">Next step, ${esc((STAGES.find((s) => s.key === p.stage) || {}).label || '')}</div>
          <div class="step">${esc(p.next.label)}</div>
          <div class="facts">
            <span>Owner: <b>${esc(p.next.owner)}</b></span>
            <span>Due: ${p.next.due ? `<b class="${late ? 'late' : ''}">${esc(fmtDate(p.next.due))}${late ? ', overdue' : ''}</b>` : '<b>No date</b>'}</span>
            <span>Done: <b>${p.done} of ${p.total}</b></span>
            ${p.overdue ? `<span class="late">${p.overdue} step${p.overdue === 1 ? '' : 's'} overdue</span>` : ''}
          </div>
          ${p.firstBlocker ? `<div class="facts" style="margin-top:6px"><span class="late">Blocked: ${esc(p.firstBlocker.label)}: ${esc(p.firstBlocker.blocked)}</span></div>` : ''}
          ${p.missingDate ? `<div class="facts" style="margin-top:6px"><span>Set the ${esc((meta.controlLabel || 'launch date').toLowerCase())} to get suggested due dates.</span></div>` : ''}
        </div>`;
      }

      const childrenCard = meta.parent ? `
        <div class="mk-card">
          <div class="mk-card-hd"><h3>Connected campaigns</h3>
            ${c.status === 'open' ? '<button class="mk-btn sm" data-act="add-child">Add a connected campaign</button>' : ''}</div>
          <div class="mk-card-bd flush mk-wrap">
            ${children.length ? `<table class="mk-table"><thead><tr>
                <th>Campaign</th><th>Account Manager</th><th>Where it stands</th><th>Next step</th><th>Blocker</th>
              </tr></thead><tbody>
              ${children.map((k) => {
                const kp = k.progress || {};
                const nx = kp.next;
                const late = nx && nx.due && nx.due < today;
                return `<tr class="clickable" data-open="${esc(k.id)}" tabindex="0">
                  <td><div class="co">${esc(k.name)}</div><div class="who">${esc(k.typeLabel)}</div></td>
                  <td>${esc(k.accountManagerName || 'Not set')}</td>
                  <td><span class="pill ${statusClass(kp.label)}">${esc(kp.label || '')}</span>
                    ${kp.overdue ? `<div class="who late">${kp.overdue} overdue</div>` : ''}</td>
                  <td>${nx ? `${esc(nx.label)}<div class="who">${esc(nx.owner)}${nx.due ? `, due <span class="${late ? 'late' : ''}">${esc(fmtDate(nx.due))}</span>` : ''}</div>` : '<span class="who">Nothing open</span>'}</td>
                  <td>${kp.firstBlocker ? `<span class="late">${esc(kp.firstBlocker.blocked)}</span>` : '<span class="who">None</span>'}</td>
                </tr>`;
              }).join('')}</tbody></table>`
              : `<div class="mk-empty">No connected campaigns yet. Postal, Digital Platform, Live Screen Printing,
                  Live Customization, and Sampling can each run under this event with their own checklist.</div>`}
          </div>
        </div>` : '';

      const emailCard = ui.calculationsSection(c, meta) + ui.connectionsSection(c, meta, connections);

      const history = (c.history || []).slice().reverse().slice(0, 40);

      det.innerHTML = `
        <div class="mk-actions" style="margin-bottom:12px">
          <button class="mk-link" data-act="to-list">Back to campaigns</button>
          ${parent ? `<span class="who">Connected to</span> <button class="mk-link" data-open="${esc(parent.id)}">${esc(parent.name)}</button>` : ''}
        </div>
        <div class="mk-hd">
          <div>
            <h1>${esc(c.name)}<span class="dot">.</span></h1>
            <div class="sub">${esc(meta.label)} <span class="pill ${statusClass(p.label)}">${esc(p.label)}</span></div>
          </div>
          <div class="mk-actions">
            <button class="mk-btn ghost sm" data-act="reload">Refresh</button>
            ${!state.editingHeader ? '<button class="mk-btn ghost sm" data-act="edit-header">Edit details</button>' : ''}
          </div>
        </div>
        ${msgBox(state.detailMsg)}
        ${now}
        <div class="mk-card"><div class="mk-card-bd">
          ${state.editingHeader ? headerForm(c, meta) : headerView(c, meta, dates)}
        </div></div>
        ${platformsCard(c)}
        <nav class="mk-stages" aria-label="Stages">${stageTabs}</nav>
        ${stageSections}
        ${childrenCard}
        ${emailCard}
        <div class="mk-card">
          <div class="mk-card-hd"><h3>Close out</h3></div>
          <div class="mk-card-bd">
            <div class="mk-actions">
              ${c.status === 'open' ? `
                <button class="mk-btn" data-status="complete"${p.next ? ' disabled' : ''}>Mark complete</button>
                <button class="mk-btn ghost" data-status="cancelled">Cancel this campaign</button>`
                : '<button class="mk-btn ghost" data-status="open">Reopen</button>'}
              <button class="mk-btn danger" data-act="delete">Delete</button>
            </div>
            ${c.status === 'open' && p.next ? '<div class="who" style="margin-top:8px">Complete becomes available when every step is done or not applicable.</div>' : ''}
          </div>
        </div>
        <div class="mk-card">
          <div class="mk-card-hd"><h3>History</h3><span class="meta">Who changed what, newest first</span></div>
          <div class="mk-card-bd"><div class="mk-history">
            ${history.length ? history.map((h) => `<div><b>${esc(h.by || 'Someone')}</b> ${esc(h.what)} <span>${esc(fmtStamp(h.at))}</span></div>`).join('') : 'Nothing yet.'}
          </div></div>
        </div>`;
    }

  return { headerView, headerForm, stepRow, stepDetails, renderDetail };
}
