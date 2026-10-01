// PUT IN: apps/marketmachine/stepforms.js
/**
 * Steps that are a small form (Oct 1 2026): results, approvals, audience,
 * picks, spend. Which step gets which is decided in lib/marketmachine/forms.js,
 * the same file the server checks against.
 *
 * Every form saves through the ordinary step PATCH with a `form` body, so the
 * Account Manager rules (their own campaigns only, never money or approvals)
 * apply unchanged. "Save and mark done" is two things in one press, because
 * filling in the numbers and ticking the step are one job.
 *
 * The audience form reuses MailMe's own server routes for lists, uploads and
 * filtered counts, so a list made here is the same list the campaign's email
 * uses, under the same opt-out and dedupe rules.
 */

import { ENDPOINTS } from '../../js/api.js';
import { esc, fmtMoney } from './format.js';
import {
  formFor, resultFieldsFor, RESULT_FIELDS, picksStatus, pickComplete,
  MAX_PICKS, PICKS_NEEDED, SEASONS, VENDORS, proposalsFor,
} from '../../lib/marketmachine/forms.js';

const TOP = [['', 'Everyone who matches'], ['25:lifetimeRevenue', 'Top 25 clients, all time'],
  ['50:lifetimeRevenue', 'Top 50 clients, all time'], ['100:lifetimeRevenue', 'Top 100 clients, all time'],
  ['25:ytdRevenue', 'Top 25 clients, this year'], ['50:ytdRevenue', 'Top 50 clients, this year']];
const TIERS = ['Platinum', 'Gold', 'Silver', 'Bronze', 'Valuable Dirt'];

export default function makeStepForms(app) {
  const { state, api, root, ui } = app;
  const $ = (sel) => root.querySelector(sel);
  const id = (key, f) => `mkF-${key}-${f}`;
  const val = (key, f) => { const el = $('#' + id(key, f)); return el ? el.value : undefined; };

  state.aud = state.aud || {};          // step key -> { mode, preview, count, hits }
  state.pickDraft = state.pickDraft || {};
  // What was typed into a form whose save has not gone through yet. A refused
  // save (three picks, a word in a number box) must not wipe the typing.
  state.formDraft = state.formDraft || {};

  const actions = (key, canEdit, label) => !canEdit ? '' : `
    <div class="mk-actions" style="margin:4px 0 12px">
      <button class="mk-btn sm" data-form-done="${esc(key)}">${label || 'Save and mark done'}</button>
      <button class="mk-btn ghost sm" data-form-save="${esc(key)}">Save, not done yet</button>
    </div>`;
  const dis = (canEdit) => canEdit ? '' : ' disabled';

  /* ---------------- rendering ---------------- */

  function stepFormHtml(c, s, canEdit, admin) {
    const kind = formFor(s);
    if (!kind) return '';
    const f = state.formDraft[s.key] || s.form || {};
    const d = dis(canEdit);

    if (kind === 'results') {
      return `<div class="mk-form">
        <div class="mk-form-hd">The numbers</div>
        <div class="mk-form-grid">${resultFieldsFor(s).map((k) => `
          <div class="mk-field"><label for="${id(s.key, k)}">${esc(RESULT_FIELDS[k].label)}</label>
            <input type="text" inputmode="decimal" id="${id(s.key, k)}" data-ff="${k}"
              value="${f[k] != null ? esc(f[k]) : ''}" placeholder="${RESULT_FIELDS[k].money ? '$0' : '0'}"${d}></div>`).join('')}
        </div>
        <div class="hint" style="margin-bottom:8px">Blank means not known yet, not zero. These add up in Results so far.</div>
        ${actions(s.key, canEdit)}
      </div>`;
    }

    if (kind === 'spend') {
      return `<div class="mk-form">
        <div class="mk-form-hd">The proposal</div>
        <div class="mk-form-grid">
          <div class="mk-field"><label for="${id(s.key, 'amount')}">Amount</label>
            <input type="text" inputmode="decimal" id="${id(s.key, 'amount')}" value="${f.amount != null ? esc(f.amount) : ''}" placeholder="$0"${d}></div>
          <div class="mk-field full"><label for="${id(s.key, 'what')}">What it is for</label>
            <input type="text" id="${id(s.key, 'what')}" maxlength="300" value="${esc(f.what || '')}" placeholder="Facebook and Instagram ads, two weeks"${d}></div>
        </div>
        ${actions(s.key, canEdit)}
      </div>`;
    }

    if (kind === 'picksInfo') {
      return `<div class="mk-form">
        <div class="mk-form-hd">Season and vendor</div>
        <div class="mk-form-grid">
          <div class="mk-field"><label for="${id(s.key, 'season')}">Season</label>
            <select id="${id(s.key, 'season')}"${d}><option value="">Pick one</option>
              ${SEASONS.map((x) => `<option value="${x}"${f.season === x ? ' selected' : ''}>${x === 'spring' ? 'Spring' : 'Fall'}</option>`).join('')}</select></div>
          <div class="mk-field"><label for="${id(s.key, 'year')}">Year</label>
            <input type="text" inputmode="numeric" maxlength="4" id="${id(s.key, 'year')}" value="${esc(f.year || state.today.slice(0, 4))}"${d}></div>
          <div class="mk-field"><label for="${id(s.key, 'vendor')}">Vendor</label>
            <select id="${id(s.key, 'vendor')}"${d}><option value="">Pick one</option>
              ${Object.entries(VENDORS).map(([k, l]) => `<option value="${k}"${f.vendor === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
          <div class="mk-field"><label for="${id(s.key, 'teamMember')}">Whose picks</label>
            <input type="text" id="${id(s.key, 'teamMember')}" maxlength="60" value="${esc(f.teamMember || '')}" placeholder="Hannah"${d}></div>
        </div>
        <div class="hint" style="margin-bottom:8px">The Picks email starts with these filled in.</div>
        ${actions(s.key, canEdit)}
      </div>`;
    }

    if (kind === 'picks') {
      const picks = state.pickDraft[s.key] || (f.picks && f.picks.length ? f.picks : [{}, {}, {}, {}, {}]);
      const st = picksStatus({ picks });
      return `<div class="mk-form">
        <div class="mk-form-hd">The picks <span class="who">${st.complete} of ${PICKS_NEEDED} complete. Photos go in the email.</span></div>
        ${picks.map((p, i) => `
          <div class="mk-pick${pickComplete(p) ? ' ok' : ''}" data-pick-row="${i}">
            <div class="mk-pick-hd"><b>Pick ${i + 1}</b>${canEdit && picks.length > 1 ? `<button class="mk-link" data-pick-remove="${esc(s.key)}" data-i="${i}">Remove</button>` : ''}</div>
            <div class="mk-form-grid">
              <div class="mk-field"><label>Product name</label><input type="text" data-pf="name" maxlength="80" value="${esc(p.name || '')}"${d}></div>
              <div class="mk-field"><label>Style number</label><input type="text" data-pf="style" maxlength="40" value="${esc(p.style || '')}"${d}></div>
              <div class="mk-field"><label>MSRP</label><input type="text" data-pf="msrp" maxlength="20" value="${esc(p.msrp || '')}" placeholder="$24.99"${d}></div>
              <div class="mk-field"><label>Link to it</label><input type="text" data-pf="url" maxlength="600" value="${esc(p.url || '')}" placeholder="https://"${d}></div>
              <div class="mk-field full"><label>Why I like it</label><input type="text" data-pf="reason" maxlength="400" value="${esc(p.reason || '')}"${d}></div>
              <div class="mk-field full"><label>Colors, separated by commas</label><input type="text" data-pf="colors" value="${esc((p.colors || []).join(', '))}" placeholder="Navy, Heather Grey, Black"${d}></div>
            </div>
          </div>`).join('')}
        ${canEdit && picks.length < MAX_PICKS ? `<button class="mk-btn ghost sm" data-pick-add="${esc(s.key)}" style="margin-bottom:10px">Add a pick</button>` : ''}
        ${actions(s.key, canEdit, 'Save and mark done')}
      </div>`;
    }

    if (kind === 'audience') return audienceHtml(c, s, canEdit);

    // The email itself, right in the step (Oct 1 2026). MailMe's composer is
    // moved into #mkEmailSlot by index.js; only one step is open at a time,
    // so there is only ever one slot.
    if (kind === 'email') {
      if (!state.mailmeAccess) {
        return '<div class="mk-notice" style="margin:0 0 12px">Writing and sending email needs Email access on your account. An Admin can turn it on in Settings, Accounts.</div>';
      }
      return `<div class="mk-form mk-email-step">
        <div class="mk-form-hd" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <span>The email</span>
          <span class="mk-actions" style="margin:0">
            <button class="mk-btn ghost sm${state.emailTab !== 'reports' ? ' on' : ''}" data-act="email-tab" data-tab="campaigns">Emails</button>
            <button class="mk-btn ghost sm${state.emailTab === 'reports' ? ' on' : ''}" data-act="email-tab" data-tab="reports">Results</button>
          </span></div>
        ${!canEdit ? '<div class="who" style="margin-bottom:10px">Written by this campaign\'s Account Managers. You can read it and its results.</div>' : ''}
        <div id="mkEmailSlot"></div>
        ${canEdit && !s.done ? `<div class="mk-actions" style="margin:12px 0">
          <button class="mk-btn sm" data-email-step-done="${esc(s.key)}">This step is done</button></div>` : ''}
      </div>`;
    }

    if (kind === 'approval') {
      const props = proposalsFor(c, s);
      const last = f.decision === 'sent_back' ? `<div class="mk-notice" style="margin:0 0 10px"><b>Sent back${f.by ? ' by ' + esc(f.by) : ''}:</b> ${esc(f.comment)}</div>` : '';
      return `<div class="mk-form">
        <div class="mk-form-hd">The decision</div>
        ${props.length ? `<div style="margin-bottom:10px">Proposed: ${props.map((p) => `<b>${fmtMoney(p.form.amount)}</b>${p.form.what ? ' for ' + esc(p.form.what) : ''}`).join(' and ')}</div>` : ''}
        ${last}
        ${s.done ? `<div class="who" style="margin-bottom:10px">Approved${f.by ? ' by ' + esc(f.by) : ''}.</div>`
          : admin && canEdit ? `
            <div class="mk-field full"><label for="${id(s.key, 'comment')}">If you send it back, say what needs to change</label>
              <input type="text" id="${id(s.key, 'comment')}" maxlength="500" placeholder="The art needs the new logo"></div>
            <div class="mk-actions" style="margin:4px 0 12px">
              <button class="mk-btn ghost sm" data-sendback="${esc(s.key)}">Send it back</button>
            </div>`
          : '<div class="who" style="margin-bottom:10px">Ryan or Megan approves or sends this back.</div>'}
      </div>`;
    }
    return '';
  }

  /* ---------------- audience ---------------- */

  function audienceHtml(c, s, canEdit) {
    const f = s.form || {};
    const a = state.aud[s.key] || (state.aud[s.key] = { mode: 'list' });
    if (!state.mailmeAccess) {
      return `<div class="mk-form"><div class="mk-form-hd">Who it goes to</div>
        <div class="mk-field full"><input type="text" id="${id(s.key, 'listName')}" maxlength="160" value="${esc(f.listName || '')}" placeholder="Describe who this goes to"${dis(canEdit)}></div>
        ${actions(s.key, canEdit)}</div>`;
    }
    if (state.mmLists === undefined) { state.mmLists = null; loadLists(); }
    const lists = state.mmLists || [];
    const seg = canEdit ? `<div class="mk-seg">${[['list', 'A saved list'], ['upload', 'Upload a file'], ['filter', 'Pick by filters']].map(([k, l]) =>
      `<button type="button" aria-pressed="${a.mode === k ? 'true' : 'false'}" data-aud-mode="${esc(s.key)}" data-mode="${k}">${l}</button>`).join('')}</div>` : '';

    let body;
    if (a.mode === 'upload') {
      const p = a.preview && a.preview.listPlan;
      body = `
        <div class="mk-form-grid">
          <div class="mk-field"><label for="${id(s.key, 'upName')}">List name</label>
            <input type="text" id="${id(s.key, 'upName')}" value="${esc(a.upName || f.listName || c.name)}"></div>
          <div class="mk-field"><label for="${id(s.key, 'upFile')}">CSV file</label>
            <input type="file" id="${id(s.key, 'upFile')}" accept=".csv,text/csv" data-aud-file="${esc(s.key)}"></div>
        </div>
        <div class="hint" style="margin-bottom:8px">Needs an email column. New people are created, people already in the system go on as they are, opted-out never do.</div>
        ${a.msg ? `<div class="${a.msg.cls === 'ok' ? 'mk-ok' : 'mk-err'}">${esc(a.msg.text)}</div>` : ''}
        ${p ? `<div class="mk-notice good" style="margin:6px 0 10px"><b>Not added yet.</b> ${p.exists ? `"${esc(p.name)}" has ${p.before} now; after, <b>${p.after}</b>.` : `This makes "${esc(p.name)}" with <b>${p.after}</b>.`}
            ${a.preview.summary && (a.preview.summary.suppressed + a.preview.summary.invalid) ? ` ${a.preview.summary.suppressed + a.preview.summary.invalid} skipped (opted out or invalid).` : ''}</div>
          <button class="mk-btn sm" data-aud-commit="${esc(s.key)}"${(p.addingNew + p.addingExisting) ? '' : ' disabled'}>Add ${p.addingNew + p.addingExisting} and use this list</button>` : ''}`;
    } else if (a.mode === 'filter') {
      const fac = state.mmFacets || { industries: [] };
      const fv = a.filter || {};
      body = `
        <div class="mk-form-grid">
          <div class="mk-field"><label>Who</label><select data-aud-f="source" data-aud-key="${esc(s.key)}">
            ${[['client', 'Clients'], ['lead', 'Leads'], ['prospect', 'Prospects'], ['all', 'Everyone']].map(([v, l]) => `<option value="${v}"${(fv.source || 'client') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="mk-field"><label>How many</label><select data-aud-f="top" data-aud-key="${esc(s.key)}">
            ${TOP.map(([v, l]) => `<option value="${v}"${(fv.top || '') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
          <div class="mk-field"><label>Industry</label><select data-aud-f="industry" data-aud-key="${esc(s.key)}"><option value="">Any industry</option>
            ${(fac.industries || []).map((i) => `<option value="${esc(i.value)}"${fv.industry === i.value ? ' selected' : ''}>${esc(i.value)}</option>`).join('')}</select></div>
          <div class="mk-field"><label>Tier</label><select data-aud-f="tier" data-aud-key="${esc(s.key)}"><option value="">Any tier</option>
            ${TIERS.map((t) => `<option value="${t}"${fv.tier === t ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
          <div class="mk-field full"><label for="${id(s.key, 'flName')}">Save the list as</label>
            <input type="text" id="${id(s.key, 'flName')}" value="${esc(a.flName || filterName(fv))}"></div>
        </div>
        ${a.msg ? `<div class="${a.msg.cls === 'ok' ? 'mk-ok' : 'mk-err'}">${esc(a.msg.text)}</div>` : ''}
        <div class="mk-notice${a.hits && a.hits.length ? ' good' : ''}" style="margin:6px 0 10px">${a.hits == null ? 'Counting...'
          : a.hits.length ? `<b>${a.hits.length} ${a.hits.length === 1 ? 'person' : 'people'}</b> can be emailed. ${esc(a.hits.slice(0, 5).map((h) => h.company_name || h.email).join(', '))}${a.hits.length > 5 ? ', and more' : ''}`
          : '<b>Nobody matches.</b> Loosen a filter.'}</div>
        <button class="mk-btn sm" data-aud-filter-save="${esc(s.key)}"${a.hits && a.hits.length ? '' : ' disabled'}>Use these people</button>`;
      if (a.hits === undefined) { a.hits = null; countFilter(s.key); }
    } else {
      body = `
        <div class="mk-field full"><label for="${id(s.key, 'listId')}">List</label>
          <select id="${id(s.key, 'listId')}"${dis(canEdit)}><option value="">${state.mmLists === null ? 'Loading lists...' : 'Pick a list'}</option>
            ${lists.map((l) => `<option value="${esc(l.id)}" data-name="${esc(l.name)}" data-count="${l.mailableCount != null ? l.mailableCount : ''}"${f.listId === l.id ? ' selected' : ''}>${esc(l.name)}${l.mailableCount != null ? ` (${l.mailableCount})` : ''}</option>`).join('')}
          </select></div>
        ${actions(s.key, canEdit)}`;
    }
    return `<div class="mk-form"><div class="mk-form-hd">Who it goes to</div>
      ${f.listName ? `<div style="margin-bottom:8px">Now: <b>${esc(f.listName)}</b>${f.count != null ? ` (${f.count})` : ''}. The campaign's emails start on this list.</div>` : ''}
      ${seg}${body}</div>`;
  }

  function filterName(fv) {
    const bits = [];
    if (fv.top) { const [n, by] = String(fv.top).split(':'); bits.push(`Top ${n} ${by === 'ytdRevenue' ? 'this year' : 'all time'}`); }
    if (fv.tier) bits.push(fv.tier);
    if (fv.industry) bits.push(fv.industry);
    const who = { client: 'clients', lead: 'leads', prospect: 'prospects', all: 'everyone' }[fv.source || 'client'];
    return bits.length ? `${bits.join(', ')} (${who})` : who.charAt(0).toUpperCase() + who.slice(1);
  }

  async function loadLists() {
    try {
      const [l, c] = await Promise.all([api.get(ENDPOINTS.mmLists), api.get(ENDPOINTS.mmContacts, { status: 'mailable', q: '__none__' })]);
      state.mmLists = (l && l.lists) || [];
      state.mmFacets = (c && c.facets) || { industries: [] };
    } catch (e) { state.mmLists = []; }
    ui.renderDetail();
  }

  async function countFilter(key) {
    const a = state.aud[key];
    const fv = a.filter || {};
    const q = { status: 'mailable' };
    if ((fv.source || 'client') !== 'all') q.source = fv.source || 'client';
    if (fv.industry) q.industry = fv.industry;
    if (fv.tier) q.tier = fv.tier;
    if (fv.top) { const [n, by] = String(fv.top).split(':'); q.top = n; q.by = by; }
    try {
      const d = await api.get(ENDPOINTS.mmContacts, q);
      a.hits = (d && d.contacts) || [];
      if (d && d.facets) state.mmFacets = d.facets;
    } catch (e) { a.hits = []; a.msg = { cls: 'err', text: 'Could not count: ' + e.message }; }
    ui.renderDetail();
  }

  // After a step is done, the next one is opened for you, so the page always
  // shows what to do now. Only when this one really is done (the save went
  // through), and only steps that are not done or skipped.
  function openNext(key) {
    const c = state.detail && state.detail.campaign;
    const steps = (c && c.steps) || [];
    const at = steps.findIndex((x) => x.key === key);
    if (at < 0 || !steps[at].done) { ui.renderDetail(); return; }
    const next = steps.slice(at + 1).find((x) => !x.done && !x.notApplicable);
    if (next) {
      state.openStep = next.key;
      if (formFor(next) === 'email') state.autoNewEmail = 'ifNone';
    }
    ui.renderDetail();
    const el = next && root.querySelector(`[data-step="${CSS.escape(next.key)}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /* ---------------- reading and saving ---------------- */

  function readPicks(key) {
    const box = $(`[data-step="${CSS.escape(key)}"]`);
    if (!box) return [];
    return Array.from(box.querySelectorAll('[data-pick-row]')).map((row) => {
      const g = (f) => { const el = row.querySelector(`[data-pf="${f}"]`); return el ? el.value : ''; };
      // A link pasted without https:// still counts; the server wants it whole.
      let url = g('url').trim();
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      url = url.replace(/^http:\/\//i, 'https://');
      return { name: g('name'), style: g('style'), msrp: g('msrp'), url, reason: g('reason'),
        colors: g('colors').split(',').map((x) => x.trim()).filter(Boolean) };
    });
  }

  function readForm(c, s) {
    const kind = formFor(s);
    if (kind === 'results') {
      const out = {};
      resultFieldsFor(s).forEach((k) => { out[k] = val(s.key, k); });
      return out;
    }
    if (kind === 'spend') return { amount: val(s.key, 'amount'), what: val(s.key, 'what') };
    if (kind === 'picksInfo') return { season: val(s.key, 'season'), year: val(s.key, 'year'), vendor: val(s.key, 'vendor'), teamMember: val(s.key, 'teamMember') };
    if (kind === 'picks') return { picks: readPicks(s.key) };
    if (kind === 'audience') {
      const sel = $('#' + id(s.key, 'listId'));
      if (sel && sel.value) {
        const opt = sel.selectedOptions[0];
        return { listId: sel.value, listName: opt.dataset.name, count: opt.dataset.count };
      }
      return { listName: val(s.key, 'listName') };
    }
    return {};
  }

  // The click and change handlers for every form. Returns true when handled.
  async function onFormClick(t) {
    const d = t.dataset || {};
    const c = state.detail && state.detail.campaign;
    if (!c) return false;
    const step = (key) => c.steps.find((x) => x.key === key);

    if (d.formSave || d.formDone) {
      const key = d.formSave || d.formDone;
      const s = step(key);
      const body = { form: readForm(c, s) };
      if (d.formDone && !s.done) body.done = true;
      state.formDraft[key] = body.form;
      delete state.pickDraft[key];
      await ui.patchStep(key, body, d.formDone ? 'Saved and marked done.' : 'Saved.');
      const m = state.stepMsg && state.stepMsg[key];
      if (!(m && m.cls === 'err')) {
        delete state.formDraft[key];
        if (d.formDone) openNext(key); else ui.renderDetail();
      }
      return true;
    }
    if (d.emailStepDone) {
      await ui.patchStep(d.emailStepDone, { done: true }, 'Done.');
      openNext(d.emailStepDone);
      return true;
    }
    if (d.pickAdd) { state.pickDraft[d.pickAdd] = readPicks(d.pickAdd).concat([{}]); ui.renderDetail(); return true; }
    if (d.pickRemove) {
      const list = readPicks(d.pickRemove); list.splice(Number(d.i), 1);
      state.pickDraft[d.pickRemove] = list.length ? list : [{}]; ui.renderDetail(); return true;
    }
    if (d.sendbackOpen) { state.openStep = d.sendbackOpen; ui.renderDetail();
      const el = $('#' + id(d.sendbackOpen, 'comment')); if (el) el.focus(); return true; }
    if (d.sendback) {
      const comment = (val(d.sendback, 'comment') || '').trim();
      if (!comment) { state.stepMsg = { [d.sendback]: { cls: 'err', text: 'Say what needs to change first.' } }; ui.renderDetail(); return true; }
      await ui.patchStep(d.sendback, { sendBack: comment }, 'Sent back. It shows as the blocker until it is fixed.');
      return true;
    }
    if (d.audMode) {
      state.aud[d.audMode] = { mode: d.mode };
      ui.renderDetail();
      return true;
    }
    if (d.audCommit) {
      const a = state.aud[d.audCommit];
      try {
        const r = await api.post(ENDPOINTS.mmImport, { csv: a.csv, commit: true, listName: a.upName });
        if (!r.list) throw new Error(r.listError || 'the list was not made');
        state.mmLists = undefined;
        state.aud[d.audCommit] = { mode: 'list' };
        await ui.patchStep(d.audCommit, { form: { listId: r.list.id, listName: r.list.name, count: r.list.memberCount } },
          `"${r.list.name}" has ${r.list.memberCount} people and is this campaign's audience.`);
      } catch (e) { a.msg = { cls: 'err', text: 'Not added: ' + e.message }; ui.renderDetail(); }
      return true;
    }
    if (d.audFilterSave) {
      const key = d.audFilterSave;
      const a = state.aud[key];
      const fv = a.filter || {};
      const name = (val(key, 'flName') || '').trim() || filterName(fv);
      try {
        const payload = fv.top
          ? { name, kind: 'static', members: (a.hits || []).map((h) => String(h.id)) }
          : { name, kind: 'dynamic', rule: { source: (fv.source || 'client') === 'all' ? null : (fv.source || 'client'),
              tags: [], tagMatch: 'any', search: '', industries: fv.industry ? [fv.industry] : [], tiers: fv.tier ? [fv.tier] : [] } };
        const r = await api.post(ENDPOINTS.mmLists, payload);
        state.mmLists = undefined;
        state.aud[key] = { mode: 'list' };
        await ui.patchStep(key, { form: { listId: r.list.id, listName: r.list.name, count: (a.hits || []).length } },
          `Made "${r.list.name}" (${(a.hits || []).length}). It is this campaign's audience.`);
      } catch (e) { a.msg = { cls: 'err', text: 'Could not make the list: ' + e.message }; ui.renderDetail(); }
      return true;
    }
    return false;
  }

  async function onFormChange(t) {
    const d = t.dataset || {};
    if (d.audFile) {
      const key = d.audFile;
      const a = state.aud[key];
      const file = t.files && t.files[0];
      if (!file) return true;
      a.upName = (val(key, 'upName') || '').trim();
      a.csv = await file.text();
      a.msg = { cls: 'ok', text: 'Checking the file...' };
      a.preview = null;
      ui.renderDetail();
      try {
        a.preview = await api.post(ENDPOINTS.mmImport, { csv: a.csv, listName: a.upName });
        a.msg = null;
      } catch (e) { a.msg = { cls: 'err', text: e.message }; }
      ui.renderDetail();
      return true;
    }
    if (d.audF) {
      const a = state.aud[d.audKey];
      a.filter = { ...(a.filter || {}), [d.audF]: t.value };
      a.flName = undefined;
      a.hits = null;
      ui.renderDetail();
      countFilter(d.audKey);
      return true;
    }
    return false;
  }

  return { stepFormHtml, onFormClick, onFormChange, openNext };
}
