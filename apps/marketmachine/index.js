// PUT IN: apps/marketmachine/index.js
/**
 * MarketMachine — every campaign, run as an ordered checklist.
 *
 * REBUILT Sept 2026, phase 1 of the plan Ryan approved from Jacob's handoff.
 * The old app recorded campaigns and hand-typed channel numbers. This one
 * runs the work: pick a campaign type, and the type lays out its steps in the
 * order they really happen, across six stages. Every step shows who owns it,
 * when it is due, a done box, the date it was done, and notes.
 *
 * WHAT A PERSON SEES FIRST on a campaign is the handoff's rule: where it
 * stands, the next step, its owner, its due date, and anything blocking it.
 * The checklist sits underneath, top to bottom, in the order the team works.
 *
 * CONNECTIONS (phase 2): a campaign points at TravelTrack trips, BackBone
 * leads and Printavo invoice numbers by id, and MailMe emails point at the
 * campaign. Everything is read live from its own app and counted once, so an
 * event's totals never add the same invoice or lead twice.
 *
 * CALCULATIONS (phase 3): the handoff's five formulas, each shown with its
 * equation, the numbers going in, where each came from, estimate or actual,
 * and when it last changed. Missing data reads as words, never as 0.
 *
 * WHAT LIVES ELSEWHERE, deliberately:
 *   - the rules (what can be marked done, when a campaign can close, what a
 *     connected campaign inherits) are in lib/marketmachine/campaign.js, and
 *     the server enforces them. This screen reads the same file so it never
 *     offers a button the server will refuse.
 *   - the campaign types and their steps are in lib/marketmachine/catalog.js.
 *
 * Admin only for now (Ryan's call). The server enforces it; this screen just
 * explains it when somebody else opens the app.
 *
 * No fetch() here: everything goes through ctx.api and ENDPOINTS, per the
 * seam rule. No hex colors: tokens.css owns theming via data-app.
 *
 * WHY THIS IS A FOLDER (Sept 2026). One file had reached 94 KB, close to the
 * 100 KB line above which the GitHub web uploader is off limits, and a screen
 * that size stops being navigable. Same layout BackBone uses, and the same
 * contract: this file still default-exports one object with the same members,
 * selected by `entry: 'marketmachine/index.js'` in the registry.
 *
 *   index.js      this file: state, loading, saving, events, the app contract
 *   styles.js     the CSS
 *   template.js   the three screens
 *   format.js     escaping, dates, money, status words
 *   shared.js     pieces more than one screen uses
 *   list.js       the Campaigns list
 *   new.js        starting a campaign
 *   detail.js     one campaign: next step, header, the six stages
 *   connect.js    the connections cards
 *   calc.js       the five calculations
 *   timeline.js   month, quarter and year
 *   settings.js   campaign types, the lead list, old sample data
 *
 * Every view module is a factory handed the same `app` object, and hangs its
 * functions on `app.ui`. Nothing renders until all of them are attached.
 */

import { ENDPOINTS } from '../../js/api.js';
import { todayCentral } from '../../lib/marketmachine/dates.js';
import { esc, msgBox } from './format.js';
import styles from './styles.js';
import template from './template.js';
import makeShared from './shared.js';
import makeList from './list.js';
import makeNew from './new.js';
import makeDetail from './detail.js';
import makeConnect from './connect.js';
import makeCalc from './calc.js';
import makeTimeline from './timeline.js';
import makeSettings from './settings.js';
import makeTasks from './tasks.js';

export default {
  id: 'marketmachine',

  styles,
  template,

  async mount(ctx) {
    const root = ctx.root;
    const api = ctx.api;
    const $ = (sel) => root.querySelector(sel);
    this._root = root;

    const state = {
      campaigns: [],
      accountManagers: [],
      amUnavailable: false,
      me: null,
      legacyCount: 0,
      demoCount: 0,
      limited: false,
      limitedMessage: '',
      loadError: '',
      today: todayCentral(),

      filters: { show: 'open', whose: 'all', type: '', am: '' },

      pane: 'list',          // list | new | detail
      detail: null,          // { campaign, parent, children, connections }
      connOptions: null,     // { trips, leads } for the connect pickers, loaded on first use
      connAdding: null,      // trips | leads | invoices while its add form is open
      connMsg: null,
      printavo: {},          // invoice number -> status from the last on-demand check
      printavoChecking: false,
      calculations: [],
      tasks: [],
      taskMsg: null,
      taskError: '',
      taskSaving: null,
      calcEditing: false,
      scorecardEditing: false,
      calcMsg: null,
      openStep: null,        // step key whose details are expanded
      stepMsg: {},           // step key -> { cls, text }
      detailMsg: null,
      editingHeader: false,

      newParentId: null,
      newType: null,
      newMsg: null,

      tl: { span: 'month', anchor: todayCentral().slice(0, 7) + '-01', type: '', am: '' },

      initiatives: [],
      settingsMsg: null,
    };
    this._state = state;

    /* ---------------- data ---------------- */
    // Every screen gets the same live state, api and root element. `ui` is
    // filled before anything renders, so one screen can call another's
    // renderer without importing it and creating a loop.
    const app = { state, api, root, ui: {} };
    Object.assign(app.ui,
      makeShared(app), makeList(app), makeNew(app), makeDetail(app),
      makeConnect(app), makeCalc(app), makeTimeline(app), makeSettings(app), makeTasks(app));
    const ui = app.ui;

    // Loading and saving stay here, and go on `ui` too, because a screen
    // sometimes has to reload after it saves: the new-campaign form opens the
    // campaign it just created. Function declarations, so the order of this
    // line and their definitions below does not matter.
    Object.assign(ui, {
      loadTasks, loadList, loadDetail, loadInitiatives, showPane, openCampaign,
      refreshDetailKeepingPlace, patchConnection, patchStep, patchHeader,
    });

    /**
     * My tasks. Its own request, and the only one this screen needs, so a
     * person who is not an Admin never waits on campaign data they cannot see.
     */
    async function loadTasks() {
      try {
        const d = await api.get(ENDPOINTS.mkCampaigns, { mine: 'tasks' });
        state.tasks = Array.isArray(d && d.tasks) ? d.tasks : [];
        state.taskError = '';
        if (d && d.today) state.today = d.today;
      } catch (e) {
        state.taskError = e.message || 'Your tasks did not load.';
      }
    }

    async function loadList() {
      try {
        const d = await api.get(ENDPOINTS.mkCampaigns);
        if (d && d.limited) {
          state.limited = true;
          state.limitedMessage = d.message || 'MarketMachine is admin only for now.';
          state.campaigns = [];
          return;
        }
        state.limited = false;
        state.loadError = '';
        state.campaigns = Array.isArray(d && d.campaigns) ? d.campaigns : [];
        state.accountManagers = Array.isArray(d && d.accountManagers) ? d.accountManagers : [];
        state.amUnavailable = !!(d && d.accountManagersUnavailable);
        state.me = (d && d.me) || null;
        state.legacyCount = Number((d && d.legacyCount) || 0);
        state.demoCount = Number((d && d.demoCount) || 0);
        if (d && d.today) state.today = d.today;
      } catch (e) {
        state.loadError = e.message || 'Campaigns did not load.';
      }
    }

    async function loadDetail(id) {
      const d = await api.get(ENDPOINTS.mkCampaigns, { id });
      state.detail = {
        campaign: d.campaign,
        parent: d.parent || null,
        children: Array.isArray(d.children) ? d.children : [],
        connections: d.connections || null,
        calculations: Array.isArray(d.calculations) ? d.calculations : [],
        advisories: Array.isArray(d.advisories) ? d.advisories : [],
        scorecard: Array.isArray(d.scorecard) ? d.scorecard : [],
      };
      if (Array.isArray(d.accountManagers)) state.accountManagers = d.accountManagers;
      if (d.today) state.today = d.today;
    }

    async function loadInitiatives() {
      try {
        const d = await api.get(ENDPOINTS.mkInitiatives);
        state.initiatives = Array.isArray(d && d.initiatives) ? d.initiatives : [];
      } catch (e) {
        state.initiatives = [];
      }
    }


    function showPane(which) {
      state.pane = which;
      const list = $('#mkListPane'), neu = $('#mkNewPane'), det = $('#mkDetailPane');
      if (list) list.hidden = which !== 'list';
      if (neu) neu.hidden = which !== 'new';
      if (det) det.hidden = which !== 'detail';
    }

    async function openCampaign(id) {
      state.openStep = null;
      state.stepMsg = {};
      state.detailMsg = null;
      state.editingHeader = false;
      state.connAdding = null;
      state.connMsg = null;
      state.printavo = {};
      state.calcEditing = false;
      state.scorecardEditing = false;
      state.calcMsg = null;
      showPane('detail');
      const det = $('#mkDetailPane');
      if (det) det.innerHTML = '<div class="mk-empty">Loading the campaign.</div>';
      try {
        await loadDetail(id);
        ui.renderDetail();
        window.scrollTo(0, 0);
      } catch (e) {
        if (det) det.innerHTML = `<div class="mk-err">${esc(e.message || 'The campaign did not load.')}</div>
          <button class="mk-btn ghost" data-act="to-list">Back to campaigns</button>`;
      }
    }

    async function refreshDetailKeepingPlace() {
      const y = window.scrollY;
      await loadDetail(state.detail.campaign.id);
      ui.renderDetail();
      window.scrollTo(0, y);
    }

    async function patchConnection(kind, ref, remove) {
      const c = state.detail && state.detail.campaign;
      if (!c) return;
      try {
        await api.patch(ENDPOINTS.mkCampaigns, { kind, ref, remove: !!remove }, { query: { id: c.id, connect: 1 } });
        state.connAdding = null;
        state.connMsg = { cls: 'ok', text: remove ? 'Disconnected.' : 'Connected.' };
      } catch (e) {
        state.connMsg = { cls: 'err', text: e.message || 'That connection was not saved.' };
      }
      await refreshDetailKeepingPlace();
    }

    async function patchStep(key, body, okText) {
      const c = state.detail && state.detail.campaign;
      if (!c) return;
      try {
        const d = await api.patch(ENDPOINTS.mkCampaigns, body, { query: { id: c.id, step: key } });
        state.detail.campaign = d.campaign;
        state.stepMsg = okText ? { [key]: { cls: 'ok', text: okText } } : {};
        const listRow = state.campaigns.find((x) => x.id === c.id);
        if (listRow && d.progress) listRow.progress = d.progress;
      } catch (e) {
        state.stepMsg = { [key]: { cls: 'err', text: e.message || 'That change was not saved.' } };
      }
      ui.renderDetail();
    }

    async function patchHeader(body) {
      const c = state.detail && state.detail.campaign;
      if (!c) return false;
      try {
        const d = await api.patch(ENDPOINTS.mkCampaigns, body, { query: { id: c.id } });
        state.detail.campaign = d.campaign;
        state.detailMsg = null;
        await loadList();
        return true;
      } catch (e) {
        state.detailMsg = { cls: 'err', text: e.message || 'That change was not saved.' };
        return false;
      }
    }

    /* ---------------- timeline ---------------- */

    const onClick = async (ev) => {
      const t = ev.target.closest('button, [data-open], input.mk-check');
      if (!t || !root.contains(t)) return;

      if (t.matches('input.mk-check')) {
        const campaignId = t.getAttribute('data-task-done');
        if (campaignId) {
          await ui.tickTask(campaignId, t.getAttribute('data-task-step'), t.checked);
          return;
        }
        const key = t.getAttribute('data-done');
        await patchStep(key, { done: t.checked }, null);
        return;
      }

      const d = t.dataset;
      if (d.open) { ev.preventDefault(); await openCampaign(d.open); return; }
      if (d.show) { state.filters.show = d.show; ui.renderList(); return; }
      if (d.whose) { state.filters.whose = d.whose; ui.renderList(); return; }
      if (d.type) { state.newType = d.type; state.newMsg = null; ui.renderNew(); return; }
      if (d.jump) {
        const el = root.querySelector('#mkStage-' + d.jump);
        if (el) el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        return;
      }
      if (d.more) { state.openStep = state.openStep === d.more ? null : d.more; state.stepMsg = {}; ui.renderDetail(); return; }
      if (d.approve) { await patchStep(d.approve, { done: true }, 'Approved.'); return; }
      if (d.undo) { await patchStep(d.undo, { done: false }, 'Marked not done.'); return; }
      if (d.na) { await patchStep(d.na, { notApplicable: d.naTo === '1' }, d.naTo === '1' ? 'Marked not applicable.' : 'This step applies again.'); return; }
      if (d.saveStep) {
        const k = d.saveStep;
        const s = state.detail.campaign.steps.find((x) => x.key === k);
        const val = (id) => { const el = root.querySelector('#' + id); return el ? el.value : undefined; };
        const due = val('mkSDue-' + k);
        const suggested = s && s.timing ? dueDateFor({ timing: s.timing }, state.detail.campaign.controlDate) : null;
        const body = {
          notes: val('mkSNotes-' + k),
          links: parseLinks(val('mkSLinks-' + k)).filter((l) => l.url),
        };
        if (due !== undefined) {
          // Only a date that differs from the suggestion is a person's date.
          // Sent only when it changes, so saving notes does not log a due date.
          const wanted = due && due !== suggested ? due : null;
          if (wanted !== ((s && s.dueOverride) || null)) body.dueDate = wanted;
        }
        const block = val('mkSBlock-' + k);
        if (block !== undefined) body.blocked = block;
        const doneAt = val('mkSDoneAt-' + k);
        if (doneAt !== undefined && s && s.done && doneAt && doneAt !== s.doneAt) body.doneAt = doneAt;
        const bad = parseLinks(val('mkSLinks-' + k)).filter((l) => !l.url);
        await patchStep(k, body, bad.length ? 'Saved. Lines without a web address were left out.' : 'Saved.');
        return;
      }
      if (d.connAdd) {
        state.connAdding = d.connAdd;
        state.connMsg = null;
        if ((d.connAdd === 'trips' || d.connAdd === 'leads') && !state.connOptions) {
          try { state.connOptions = await api.get(ENDPOINTS.mkCampaigns, { options: 'connections' }); }
          catch (e) { state.connOptions = { trips: null, leads: null }; }
        }
        ui.renderDetail();
        const el = root.querySelector('#mkConnRef-' + d.connAdd);
        if (el) el.focus();
        return;
      }
      if (d.scorecardSave) {
        const key = d.scorecardSave;
        const val = (f) => { const el = root.querySelector(`#mkSc-${key}-${f}`); return el ? el.value : ''; };
        try {
          await api.patch(ENDPOINTS.mkCampaigns,
            { key, target: val('target'), actual: val('actual'), range: val('range'), source: val('source'), notes: val('notes') },
            { query: { id: state.detail.campaign.id, scorecard: 1 } });
          state.calcMsg = { cls: 'ok', text: 'Scorecard row saved.' };
        } catch (e) {
          state.calcMsg = { cls: 'err', text: e.message || 'That row was not saved.' };
        }
        await refreshDetailKeepingPlace();
        return;
      }
      if (d.connCancel) { state.connAdding = null; ui.renderDetail(); return; }
      if (d.connSave) {
        const el = root.querySelector('#mkConnRef-' + d.connSave);
        const ref = el ? el.value.trim() : '';
        if (!ref) { state.connMsg = { cls: 'err', text: 'Pick or type one first.' }; ui.renderDetail(); return; }
        await patchConnection(d.connSave, ref, false);
        return;
      }
      if (d.connRemove) {
        if (!window.confirm('Disconnect this from the campaign? Nothing is deleted in the other app.')) return;
        await patchConnection(d.connRemove, d.ref, true);
        return;
      }
      if (d.status) {
        const label = d.status === 'cancelled' ? 'Cancel this campaign? It can be reopened later.' : null;
        if (label && !window.confirm(label)) return;
        await patchHeader({ status: d.status });
        ui.renderDetail();
        return;
      }
      if (d.span) { state.tl.span = d.span; ui.renderTimeline(); return; }
      if (d.shift !== undefined) {
        if (d.shift === '0') state.tl.anchor = state.today.slice(0, 7) + '-01';
        else ui.shiftPeriod(Number(d.shift));
        ui.renderTimeline();
        return;
      }

      switch (d.act) {
        case 'refresh': await loadList(); ui.renderList(); break;
        case 'tasks-refresh': state.taskMsg = null; await loadTasks(); ui.renderTasks(); break;
        case 'new':
          state.newParentId = null; state.newType = null; state.newMsg = null;
          showPane('new'); ui.renderNew(); break;
        case 'add-child':
          state.newParentId = state.detail.campaign.id; state.newType = null; state.newMsg = null;
          showPane('new'); ui.renderNew(); break;
        case 'cancel-new':
          if (state.newParentId) await openCampaign(state.newParentId);
          else { showPane('list'); ui.renderList(); }
          break;
        case 'back-types': state.newType = null; ui.renderNew(); break;
        case 'create': t.disabled = true; await ui.createFromForm(); break;
        case 'to-list': showPane('list'); await loadList(); ui.renderList(); break;
        case 'reload': await openCampaign(state.detail.campaign.id); break;
        case 'calc-save-all': {
          // Only what changed is sent, one input at a time, so one bad number
          // is reported by name and every good one next to it still saves.
          const c = state.detail.campaign;
          const inputs = (c.calc && c.calc.inputs) || {};
          const changed = Object.keys(CALC_INPUTS).filter((key) => {
            const v = root.querySelector('#mkCalc-' + key);
            if (!v) return false;
            const src = root.querySelector('#mkCalcSrc-' + key);
            const cur = inputs[key] || {};
            const curVal = cur.value != null ? String(cur.value) : '';
            return v.value.trim() !== curVal || (src && src.value.trim() !== (cur.source || ''));
          });
          if (!changed.length) { state.calcMsg = { cls: 'ok', text: 'Nothing changed.' }; ui.renderDetail(); break; }
          const values = Object.fromEntries(changed.map((key) => {
            const src = root.querySelector('#mkCalcSrc-' + key);
            return [key, { value: root.querySelector('#mkCalc-' + key).value, source: src ? src.value : '' }];
          }));
          const errors = [];
          const failed = [];
          for (const key of changed) {
            try {
              await api.patch(ENDPOINTS.mkCampaigns, { key, ...values[key] }, { query: { id: c.id, calc: 1 } });
            } catch (e) {
              errors.push(e.message || CALC_INPUTS[key].label + ' was not saved');
              failed.push(key);
            }
          }
          state.calcMsg = errors.length
            ? { cls: 'err', text: errors.join(' ') + (errors.length < changed.length ? ' The other numbers saved.' : '') }
            : { cls: 'ok', text: `Saved ${changed.length} number${changed.length === 1 ? '' : 's'}.` };
          if (!errors.length) state.calcEditing = false;
          await refreshDetailKeepingPlace();
          // Put back what did not save, so a typo costs one retype, not all of them.
          failed.forEach((key) => {
            const v = root.querySelector('#mkCalc-' + key);
            const src = root.querySelector('#mkCalcSrc-' + key);
            if (v) v.value = values[key].value;
            if (src) src.value = values[key].source;
          });
          break;
        }
        case 'scorecard-edit': state.scorecardEditing = !state.scorecardEditing; ui.renderDetail(); break;
        case 'calc-edit': state.calcEditing = !state.calcEditing; state.calcMsg = null; ui.renderDetail(); break;
        case 'start-email': {
          const c = state.detail.campaign;
          try {
            // Subject and body are left out, not blanked: MailMe refuses an
            // explicitly empty subject, and a subject written by nobody is
            // worse than none. The Account Manager writes every email.
            const d2 = await api.post(ENDPOINTS.mmCampaigns, { marketingCampaignId: c.id, marketingChannelId: 'email' });
            const made = d2 && d2.campaign;
            state.connMsg = { cls: 'ok', text: `Draft ${made && made.id ? made.id : ''} started in MailMe and attached to this campaign. Open MailMe, Sends, to write it.` };
          } catch (e) {
            state.connMsg = { cls: 'err', text: 'MailMe did not start the draft: ' + (e.message || 'no answer') };
          }
          await refreshDetailKeepingPlace();
          break;
        }
        case 'check-printavo': {
          state.printavoChecking = true;
          ui.renderDetail();
          try {
            const r = await api.get(ENDPOINTS.mkCampaigns, { id: state.detail.campaign.id, printavo: 1 });
            state.printavo = (r && r.statuses) || {};
            state.connMsg = null;
          } catch (e) {
            state.connMsg = { cls: 'err', text: 'Printavo did not answer: ' + (e.message || 'try again in a minute') };
          }
          state.printavoChecking = false;
          ui.renderDetail();
          break;
        }
        case 'edit-header': state.editingHeader = true; ui.renderDetail(); break;
        case 'cancel-header': state.editingHeader = false; ui.renderDetail(); break;
        case 'save-header': {
          const c = state.detail.campaign;
          const val = (id) => { const el = root.querySelector('#' + id); return el ? el.value : undefined; };
          const amId = val('mkHAm');
          const am = state.accountManagers.find((a) => a.id === amId);
          const kind = root.querySelector('input[name="mkHAudKind"]:checked');
          const body = {
            name: val('mkHName'),
            accountManagerId: amId || null,
            accountManagerName: am ? am.name : (amId === c.accountManagerId ? c.accountManagerName : null),
            controlDate: val('mkHDate') || null,
            audienceKind: kind ? kind.value : c.audienceKind,
            audience: val('mkHAudience'),
            notes: val('mkHNotes'),
          };
          if (val('mkHPart') !== undefined) body.participation = val('mkHPart') || null;
          if (val('mkHBudget') !== undefined) body.budget = val('mkHBudget');
          if (await patchHeader(body)) state.editingHeader = false;
          ui.renderDetail();
          break;
        }
        case 'delete': {
          const c = state.detail.campaign;
          if (!window.confirm(`Delete "${c.name}" and its whole checklist? This cannot be undone. Cancelling keeps the record instead.`)) return;
          try {
            await api.del(ENDPOINTS.mkCampaigns, { query: { id: c.id } });
            showPane('list'); await loadList(); ui.renderList();
          } catch (e) {
            state.detailMsg = { cls: 'err', text: e.message || 'The campaign was not deleted.' };
            ui.renderDetail();
          }
          break;
        }
        case 'save-initiatives': {
          const list = ($('#mkInitiatives').value || '').split('\n').map((s) => s.trim()).filter(Boolean);
          try {
            const r = await api.put(ENDPOINTS.mkInitiatives, { initiatives: list });
            state.initiatives = r.initiatives || list;
            state.settingsMsg = { cls: 'ok', text: 'Saved. BackBone shows the new list the next time a lead form opens.' };
          } catch (e) {
            state.settingsMsg = { cls: 'err', text: e.message || 'The list was not saved.' };
          }
          ui.renderSettings();
          break;
        }
        case 'load-demo': {
          try {
            const r = await api.post(ENDPOINTS.mkCampaigns, {}, { query: { demo: 'load' } });
            state.settingsMsg = { cls: 'ok', text: `Loaded ${r.created || 0} example campaigns. They are named EXAMPLE and can be removed here.` };
          } catch (e) {
            state.settingsMsg = { cls: 'err', text: e.message || 'The examples were not loaded.' };
          }
          await loadList(); ui.renderSettings();
          break;
        }
        case 'remove-demo': {
          if (!window.confirm('Remove every example campaign? Real campaigns are not touched.')) return;
          try {
            const r = await api.del(ENDPOINTS.mkCampaigns, { query: { demo: 'all' } });
            state.settingsMsg = { cls: 'ok', text: `Removed ${r.removed || 0} example campaigns.` };
          } catch (e) {
            state.settingsMsg = { cls: 'err', text: e.message || 'The examples were not removed.' };
          }
          await loadList(); ui.renderSettings();
          break;
        }
        case 'clear-legacy': {
          if (!window.confirm('Delete every old sample campaign and its numbers for good?')) return;
          try {
            const r = await api.del(ENDPOINTS.mkCampaigns, { query: { legacy: 'all' } });
            state.legacyCount = 0;
            state.settingsMsg = { cls: 'ok', text: `Deleted ${r.removed || 0} old sample campaign${r.removed === 1 ? '' : 's'}.` };
          } catch (e) {
            state.settingsMsg = { cls: 'err', text: e.message || 'The old campaigns were not deleted.' };
          }
          ui.renderSettings();
          break;
        }
        default: break;
      }
    };

    const onChange = (ev) => {
      const t = ev.target;
      if (t.id === 'mkFType') { state.filters.type = t.value; ui.renderList(); }
      else if (t.id === 'mkFAm') { state.filters.am = t.value; ui.renderList(); }
      else if (t.id === 'mkTlType') { state.tl.type = t.value; ui.renderTimeline(); }
      else if (t.id === 'mkTlAm') { state.tl.am = t.value; ui.renderTimeline(); }
    };

    const onKey = (ev) => {
      if (ev.key !== 'Enter') return;
      const row = ev.target.closest && ev.target.closest('[data-open]');
      if (row && row.tagName !== 'BUTTON') { ev.preventDefault(); openCampaign(row.getAttribute('data-open')); }
    };

    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onKey);
    this._off = () => {
      root.removeEventListener('click', onClick);
      root.removeEventListener('change', onChange);
      root.removeEventListener('keydown', onKey);
    };

    await Promise.all([loadTasks(), loadList(), loadInitiatives()]);
    showPane('list');
    ui.renderTasks();
    ui.renderList();

    this._renders = {
      tasks: async () => { await loadTasks(); ui.renderTasks(); },
      campaigns: async () => { if (state.pane === 'list') { await loadList(); ui.renderList(); } },
      calendar: async () => { await loadList(); ui.renderTimeline(); },
      settings: async () => { await Promise.all([loadList(), loadInitiatives()]); ui.renderSettings(); },
    };
  },
  showView(view) {
    const root = this._root;
    if (!root) return;
    const ids = { tasks: 'mkTasksView', campaigns: 'mkCampaignsView', calendar: 'mkCalendarView', settings: 'mkSettingsView' };
    Object.entries(ids).forEach(([v, id]) => {
      const el = root.querySelector('#' + id);
      if (el) el.hidden = v !== view;
    });
    if (this._renders && this._renders[view]) this._renders[view]();
  },

  unmount() {
    if (this._off) { this._off(); this._off = null; }
  }
};
