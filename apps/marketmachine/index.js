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
import { mountEmbedded } from '../../js/app-host.js';
import { todayCentral } from '../../lib/marketmachine/dates.js';
import { CALC_INPUTS } from '../../lib/marketmachine/calculations.js';
import { emailPrefill, formFor, emailInSteps, nextEmailStep } from '../../lib/marketmachine/forms.js';
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
import makeStepForms from './stepforms.js';

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
      taskOpen: null,        // campaignId:stepKey whose details are showing
      taskFull: false,       // may this person open the campaign page
      calcEditing: false,
      scorecardEditing: false,
      calcMsg: null,
      openStep: null,        // step key whose details are expanded
      stepMsg: {},           // step key -> { cls, text }
      detailMsg: null,
      editingHeader: false,

      // The Email section (Oct 1 2026): MailMe's composer, on the campaign.
      emailOpen: false,      // shown even before Email is ticked as a platform
      emailTab: 'campaigns', // campaigns (the emails) | reports (their results)
      mailmeAccess: !!(ctx.perms && (ctx.perms.superuser === true ||
        (Array.isArray(ctx.perms.tabs) && ctx.perms.tabs.includes('mailme')))),

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
      makeConnect(app), makeCalc(app), makeTimeline(app), makeSettings(app), makeTasks(app), makeStepForms(app));
    const ui = app.ui;

    // Loading and saving stay here, and go on `ui` too, because a screen
    // sometimes has to reload after it saves: the new-campaign form opens the
    // campaign it just created. Function declarations, so the order of this
    // line and their definitions below does not matter.
    Object.assign(ui, {
      loadTasks, loadList, loadDetail, loadInitiatives, showPane, openCampaign,
      refreshDetailKeepingPlace, patchConnection, patchStep, patchHeader,
    });

    /* ---------------- the Email section ----------------
     *
     * MailMe's own composer, mounted once per open campaign and MOVED into
     * the slot after every repaint of this page. Moving a live node keeps
     * everything typed into it; re-mounting would throw it away. Destroyed
     * when the page leaves this campaign.
     */
    let emailEmbed = null;   // { campaignId, root, ready, destroy }

    function dropEmailEmbed() {
      if (emailEmbed) { emailEmbed.destroy(); emailEmbed = null; }
    }

    function attachEmailEmbed() {
      const slot = root.querySelector('#mkEmailSlot');
      const c = state.detail && state.detail.campaign;
      if (!slot || !c) return;
      if (emailEmbed && emailEmbed.campaignId !== c.id) dropEmailEmbed();
      if (!emailEmbed) {
        let refreshTimer = null;
        const e = mountEmbedded('mailme', {
          perms: ctx.perms,
          user: ctx.user,
          embed: {
            campaignId: c.id,
            campaignName: c.name,
            // Somebody else's campaign: its emails and results, nothing to write.
            readOnly: !!(state.detail.access && state.detail.access.canEdit === false),
            // The audience step's list and the Picks steps' answers, read
            // when an email is started so they are always the latest.
            prefill: () => (state.detail && state.detail.campaign ? emailPrefill(state.detail.campaign) : {}),
            // Saved, sent, scheduled or deleted: the numbers further down
            // this page are read live, so ask for them again. Debounced, as
            // one save can reload the email list more than once.
            onChange: () => {
              clearTimeout(refreshTimer);
              refreshTimer = setTimeout(() => {
                if (state.pane === 'detail' && state.detail && state.detail.campaign.id === c.id) {
                  refreshDetailKeepingPlace();
                }
              }, 400);
            },
          },
          // MailMe's Report button routes to its Results view; here that is
          // the Results tab of this section.
          go: (view) => { state.emailTab = view === 'reports' ? 'reports' : 'campaigns'; showEmailTab(); },
          goApp: ctx.goApp,
        });
        emailEmbed = { campaignId: c.id, ...e };
        e.ready.then(async () => {
          await showEmailTab();
        }).catch((err) => {
          e.root.innerHTML = `<div class="mk-err">Email did not load: ${esc(err.message || 'try Refresh')}</div>`;
        });
      }
      slot.appendChild(emailEmbed.root);
      maybeStartEmail();
    }

    // Opening an email step on a campaign with no email yet starts one, so
    // the first thing on screen is the email, not a button to make one.
    // 'ifNone' leaves a campaign that already has emails on its list.
    async function maybeStartEmail() {
      const want = state.autoNewEmail;
      if (!want || !emailEmbed) return;
      state.autoNewEmail = false;
      const det = state.detail || {};
      if (det.access && det.access.canEdit === false) return;
      const had = (det.connections && det.connections.email && det.connections.email.count) || 0;
      if (want === 'ifNone' && had > 0) return;
      try {
        const inst = await emailEmbed.ready;
        inst.showView('campaigns');
        state.emailTab = 'campaigns';
        const r = emailEmbed.root;
        // Already writing one (the step was closed and reopened): leave it.
        if (r.querySelector('#mmComposeView:not([hidden]) #mmSubject')) return;
        const nb = r.querySelector('#mmNewCampaign');
        if (nb) nb.click();
      } catch (e) { /* the load error is already on screen */ }
    }

    async function showEmailTab() {
      if (!emailEmbed) return;
      root.querySelectorAll('[data-act="email-tab"]').forEach((b) => {
        b.classList.toggle('on', b.dataset.tab === state.emailTab);
      });
      try {
        const inst = await emailEmbed.ready;
        inst.showView(state.emailTab === 'reports' ? 'reports' : 'campaigns');
      } catch (e) { /* the load error is already on screen */ }
    }

    /* ---------------- New email, from anywhere ----------------
     *
     * The one button for "I need to send an email" (Oct 1 2026). It makes a
     * Quick Email campaign in this person's name, opens it, and starts the
     * email, so the first thing on screen is "who gets it". Everything else
     * about email is on the Email screen.
     */
    async function newEmail(btn) {
      if (btn) btn.disabled = true;
      try {
        const day = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const body = { type: 'quick_email', name: `Quick email, ${day}`, audienceKind: 'list', platforms: ['email'] };
        if (state.me && state.me.id) body.accountManagers = [{ id: state.me.id, name: state.me.name }];
        const r = await api.post(ENDPOINTS.mkCampaigns, body);
        const id = r && r.campaign && r.campaign.id;
        if (!id) throw new Error('no campaign came back');
        // Lands on the campaign with "Pick who gets it" open. Its Save and
        // mark done opens "Write the email", which starts the email.
        state.pendingOpenStep = 'qe_audience';
        if (typeof ctx.goApp === 'function') ctx.goApp('marketmachine', 'campaigns', id);
        else { await openCampaign(id); }
      } catch (e) {
        window.alert('A new email could not be started: ' + (e.message || 'try again'));
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    /* ---------------- the Email screen and email settings ----------------
     *
     * Everything about email that is not one campaign's: people and lists,
     * every email that went out (including the ones from before email moved
     * here), and results. Plus the sending setup, under Settings, for
     * Admins. One more copy of MailMe's own screens, moved between the two
     * slots so there is only ever one.
     */
    let hubEmbed = null;
    async function showEmailHub(slotId, view) {
      const slot = root.querySelector('#' + slotId);
      if (!slot || !state.mailmeAccess) return;
      if (!hubEmbed) {
        hubEmbed = mountEmbedded('mailme', {
          perms: ctx.perms, user: ctx.user, goApp: ctx.goApp,
          embedHub: true,
          newEmail: (btn) => newEmail(btn),
          go: (v) => { state.hubTab = v; showEmailHub('mkEmailHubSlot', v); },
        });
        hubEmbed.ready.catch((err) => {
          hubEmbed.root.innerHTML = `<div class="mk-err">Email did not load: ${esc(err.message || 'try again')}</div>`;
        });
      }
      slot.appendChild(hubEmbed.root);
      root.querySelectorAll('[data-act="hub-tab"]').forEach((b) => b.classList.toggle('on', b.dataset.tab === view));
      try { (await hubEmbed.ready).showView(view); } catch (e) { /* shown above */ }
    }
    this._dropHubEmbed = () => { if (hubEmbed) { hubEmbed.destroy(); hubEmbed = null; } };

    // Every repaint of the campaign page puts the composer back in its slot.
    const paintDetail = ui.renderDetail;
    ui.renderDetail = () => { paintDetail(); attachEmailEmbed(); };
    this._dropEmailEmbed = dropEmailEmbed;

    /**
     * My tasks. Its own request, and the only one this screen needs, so a
     * person who is not an Admin never waits on campaign data they cannot see.
     */
    async function loadTasks() {
      try {
        const d = await api.get(ENDPOINTS.mkCampaigns, { mine: 'tasks' });
        state.tasks = Array.isArray(d && d.tasks) ? d.tasks : [];
        state.taskFull = !!(d && d.full === true);
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
        access: d.access || null,
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
      if (which !== 'detail') dropEmailEmbed();
      const list = $('#mkListPane'), neu = $('#mkNewPane'), det = $('#mkDetailPane');
      if (list) list.hidden = which !== 'list';
      if (neu) neu.hidden = which !== 'new';
      if (det) det.hidden = which !== 'detail';
    }

    async function openCampaign(id) {
      state.emailOpen = false;
      state.emailTab = 'campaigns';
      state.platMsg = null;
      state.artUploading = {};
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
        if (state.pendingOpenStep) {
          const k = state.pendingOpenStep;
          state.pendingOpenStep = null;
          if ((state.detail.campaign.steps || []).some((x) => x.key === k && !x.done)) state.openStep = k;
        }
        ui.renderDetail();
        window.scrollTo(0, 0);
      } catch (e) {
        if (det) det.innerHTML = `<div class="mk-err">${esc(e.message || 'The campaign did not load.')}</div>
          <button class="mk-btn ghost" data-act="to-list">Back to campaigns</button>`;
      }
    }

    /**
     * From My tasks to the campaign page (Admins only; the button is not drawn
     * for anyone else and the server refuses them anyway). Goes through the
     * shell so the address becomes #/marketmachine/campaigns/<id> and the
     * browser's Back button returns to the tasks. When the address is already
     * that one, the shell sees no change, so the view is switched here.
     */
    const self = this;
    function openFromTask(id) {
      const before = location.hash;
      if (typeof ctx.goApp === 'function') ctx.goApp('marketmachine', 'campaigns', id);
      if (location.hash === before) self.showView('campaigns', id);
    }
    this._openCampaign = openCampaign;

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
        const pv = Array.isArray(d.printavo) ? d.printavo : [];
        const pvText = pv.map((r) => r.connected
          ? `Printavo invoice ${r.number}${r.customer ? ' (' + r.customer + ')' : ''} ${r.connected === 'already' ? 'was already connected' : 'is now connected'}. Its status, total and due date are under Connections.`
          : r.number
            ? `Printavo invoice ${r.number} was found but not connected: ${r.error || 'try again'}.`
            : `A Printavo link could not be matched: ${r.error}. Connect the invoice number by hand under Connections.`).join(' ');
        const bad = pv.some((r) => !r.connected);
        state.stepMsg = okText || pvText ? { [key]: { cls: bad ? 'err' : 'ok', text: [okText, pvText].filter(Boolean).join(' ') } } : {};
        const listRow = state.campaigns.find((x) => x.id === c.id);
        if (listRow && d.progress) listRow.progress = d.progress;
        if (pv.some((r) => r.connected === 'added')) {
          const keep = state.stepMsg;
          await refreshDetailKeepingPlace();
          state.stepMsg = keep;
        }
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

      if (t.dataset && t.dataset.artRemove !== undefined && t.dataset.artRemove) {
        if (!window.confirm('Remove this art from the campaign? If it is already scheduled on a platform, it stays there.')) return;
        state.platMsg = (await patchHeader({ removeArt: t.dataset.artRemove })) ? { cls: 'ok', text: 'Removed.' } : state.detailMsg;
        state.detailMsg = null;
        ui.renderDetail();
        return;
      }
      if (t.dataset && t.dataset.artLink) {
        const k = t.dataset.artLink;
        const el = root.querySelector('#mkArtLink-' + k);
        const url = el ? el.value.trim() : '';
        if (!url) { state.platMsg = { cls: 'err', text: 'Paste the link first.' }; ui.renderDetail(); return; }
        await postArt(k, { link: /^https?:\/\//i.test(url) ? url : 'https://' + url, name: url.replace(/^https?:\/\//i, '').slice(0, 80) });
        return;
      }
      if (t.dataset && t.dataset.postLink) {
        const k = t.dataset.postLink;
        const el = root.querySelector('#mkPostLink-' + k);
        let url = el ? el.value.trim() : '';
        if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
        state.platMsg = (await patchHeader({ platformLink: { platform: k, url } }))
          ? { cls: 'ok', text: url ? 'Link saved.' : 'Link cleared.' } : state.detailMsg;
        state.detailMsg = null;
        ui.renderDetail();
        return;
      }

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

      // The step forms (results, approvals, audience, picks, spend).
      if (await ui.onFormClick(t)) return;

      const d = t.dataset;
      if (d.taskMore) { ui.toggleTask(d.taskMore); return; }
      if (d.taskCampaign) { openFromTask(d.taskCampaign); return; }
      if (d.open) { ev.preventDefault(); await openCampaign(d.open); return; }
      if (d.show) { state.filters.show = d.show; ui.renderList(); return; }
      if (d.whose) { state.filters.whose = d.whose; ui.renderList(); return; }
      if (d.type) { state.newType = d.type; state.newMsg = null; ui.renderNew(); return; }
      if (d.jump) {
        const el = root.querySelector('#mkStage-' + d.jump);
        if (el) el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        return;
      }
      if (d.more) {
        state.openStep = state.openStep === d.more ? null : d.more;
        state.stepMsg = {};
        const st = state.openStep && state.detail && (state.detail.campaign.steps || []).find((x) => x.key === state.openStep);
        if (st && formFor(st) === 'email' && !st.done) state.autoNewEmail = 'ifNone';
        ui.renderDetail();
        return;
      }
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
        case 'open-email': {
          // Opens the Email section on this page instead of sending people
          // to MailMe. The section mounts MailMe's composer itself.
          state.emailTab = 'campaigns';
          const cc = state.detail && state.detail.campaign;
          if (cc && emailInSteps(cc)) {
            // The email lives in the campaign's email step: open that one.
            const st = nextEmailStep(cc);
            state.openStep = st.key;
            if (!st.done) state.autoNewEmail = 'ifNone';
            ui.renderDetail();
            const el = root.querySelector(`[data-step="${CSS.escape(st.key)}"]`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            break;
          }
          state.emailOpen = true;
          ui.renderDetail();
          const card = root.querySelector('#mkEmailCard');
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        }
        case 'new-email': await newEmail(t); break;
        case 'hub-tab': {
          state.hubTab = t.dataset.tab;
          await showEmailHub('mkEmailHubSlot', state.hubTab);
          break;
        }
        case 'email-tab': {
          state.emailTab = t.dataset.tab === 'reports' ? 'reports' : 'campaigns';
          await showEmailTab();
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
          const kind = root.querySelector('input[name="mkHAudKind"]:checked');
          const body = {
            name: val('mkHName'),
            accountManagers: ui.readAmPicker('mkHAms') || [],
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

    async function postArt(platform, body) {
      const c = state.detail && state.detail.campaign;
      if (!c) return;
      state.artUploading = Object.assign({}, state.artUploading, { [platform]: true });
      ui.renderDetail();
      const still = () => state.detail && state.detail.campaign && state.detail.campaign.id === c.id;
      let d = null, err = null;
      try {
        d = await api.post(ENDPOINTS.mkCampaigns, Object.assign({ platform }, body), { query: { id: c.id, art: 1 } });
      } catch (e) { err = e; }
      // A 3 MB upload takes a few seconds. If somebody opened a different
      // campaign meanwhile, this answer belongs to the old one and must not
      // replace what is on screen now.
      if (!still()) return;
      if (d) { state.detail.campaign = d.campaign; state.platMsg = { cls: 'ok', text: 'Art added.' }; }
      else state.platMsg = { cls: 'err', text: (err && err.message) || 'The art was not added.' };
      state.artUploading = Object.assign({}, state.artUploading, { [platform]: false });
      ui.renderDetail();
    }

    const onChange = async (ev) => {
      const t = ev.target;
      if (await ui.onFormChange(t)) return;
      if (t.dataset && t.dataset.platform) {
        const picked = Array.from(root.querySelectorAll('input[data-platform]:checked')).map((el) => el.dataset.platform);
        const ok = await patchHeader({ platforms: picked });
        state.platMsg = ok ? null : state.detailMsg;
        if (!ok) state.detailMsg = null;
        ui.renderDetail();
        return;
      }
      if (t.dataset && t.dataset.artFile && t.files && t.files[0]) {
        const file = t.files[0];
        const k = t.dataset.artFile;
        if (file.size > 3 * 1024 * 1024) {
          state.platMsg = { cls: 'err', text: `${file.name} is over 3 MB. Put it in Dropbox or Drive and add it as a link instead.` };
          ui.renderDetail();
          return;
        }
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(new Error('That file could not be read.'));
          r.readAsDataURL(file);
        }).catch((e) => { state.platMsg = { cls: 'err', text: e.message }; return null; });
        if (dataUrl) await postArt(k, { dataUrl, name: file.name });
        else ui.renderDetail();
        return;
      }
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

    // The Email section holds MailMe's composer, which wires its own
    // controls. Its rows use data-open too (for an email id), so without this
    // fence a click on an email would try to open a campaign by that id.
    const notEmbedded = (fn) => (ev) => {
      if (ev.target && ev.target.closest && ev.target.closest('.app-embed')) return;
      return fn(ev);
    };
    const onClickOwn = notEmbedded(onClick);
    const onChangeOwn = notEmbedded(onChange);
    const onKeyOwn = notEmbedded(onKey);
    root.addEventListener('click', onClickOwn);
    root.addEventListener('change', onChangeOwn);
    root.addEventListener('keydown', onKeyOwn);
    this._off = () => {
      root.removeEventListener('click', onClickOwn);
      root.removeEventListener('change', onChangeOwn);
      root.removeEventListener('keydown', onKeyOwn);
    };

    await Promise.all([loadTasks(), loadList(), loadInitiatives()]);
    showPane('list');
    ui.renderTasks();
    ui.renderList();

    this._renders = {
      tasks: async () => { await loadTasks(); ui.renderTasks(); },
      campaigns: async () => { if (state.pane === 'list') { await loadList(); ui.renderList(); } },
      calendar: async () => { await loadList(); ui.renderTimeline(); },
      settings: async () => {
        await Promise.all([loadList(), loadInitiatives()]);
        ui.renderSettings();
        // Sending setup lives with the rest of the Admin settings now.
        const wrap = root.querySelector('#mkEmailSettingsWrap');
        if (wrap) wrap.hidden = !state.mailmeAccess;
        await showEmailHub('mkEmailSettingsSlot', 'settings');
      },
      email: async () => { await showEmailHub('mkEmailHubSlot', state.hubTab || 'audience'); },
    };
  },
  showView(view, param) {
    const root = this._root;
    if (!root) return;
    const ids = { tasks: 'mkTasksView', campaigns: 'mkCampaignsView', email: 'mkEmailView', calendar: 'mkCalendarView', settings: 'mkSettingsView' };
    Object.entries(ids).forEach(([v, id]) => {
      const el = root.querySelector('#' + id);
      if (el) el.hidden = v !== view;
    });
    // #/marketmachine/campaigns/<id> opens that campaign (Sept 24 2026), which
    // is how My tasks links to one and how a campaign address can be shared.
    if (view === 'campaigns' && param && this._openCampaign) { this._openCampaign(String(param)); return; }
    if (this._renders && this._renders[view]) this._renders[view]();
  },

  unmount() {
    if (this._off) { this._off(); this._off = null; }
    if (this._dropEmailEmbed) this._dropEmailEmbed();
    if (this._dropHubEmbed) this._dropHubEmbed();
  }
};
