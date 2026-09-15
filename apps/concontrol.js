/**
 * ConControl — the event, tracked in one place.
 *
 * Flyover Con is the first event through it. Six screens:
 *
 *   home      what is committed, collected, outstanding, and blocked on someone
 *   sponsors  who is in, what they owe, what we owe them
 *   money     income and spend in one ledger, budget against actual
 *   sessions  the program grid, and the source the public agenda reads
 *   speakers  proposals, confirmations, and what they still have to send
 *   settings  levels, categories, dates, and who gets told about an inquiry
 *
 * WHAT THIS REPLACES. A spreadsheet that held the money fine and could not hold
 * anything else: a blank cell meant "not yet" or "never owed one" and only the
 * person who typed it knew which, and the schedule lived in the website's
 * source and in somebody's head at the same time.
 *
 * All the arithmetic lives in lib/concontrol/{schema,ledger,program}.js, which
 * the server routes import too. Same pattern as poHealth() in PromoPro: one
 * function, so a figure on this screen and a figure in an export cannot
 * disagree.
 *
 * The seam: no fetch() in here. ctx.api.get/post/patch/del with ENDPOINTS.*.
 */

import { ENDPOINTS } from '../js/api.js';
import {
  STATUSES, STATUS_LABELS, DELIVERABLES, DELIVERABLE_KEYS, MOMENTS,
  OBLIGATIONS, sponsorMoney, deliverableStates, deliverableProgress,
  obligationStates, obligationProgress, obligationsFor, sponsorHealth, rollup,
  tierAvailability, momentAvailability, daysBetween,
  SEED_TIERS, SEED_CATEGORIES, PAYMENT_KINDS, PAYMENT_KIND_LABELS,
} from '../lib/concontrol/schema.js';
import {
  ENTRY_KINDS, ENTRY_STATES, ENTRY_STATE_LABELS,
} from '../lib/concontrol/ledger.js';
import {
  responderName, responderShop, SURVEY_QUESTIONS,
} from '../lib/concontrol/responses.js';
import {
  TRACKS, FORMATS, SESSION_STATUSES, SESSION_STATUS_LABELS,
  SPEAKER_STATUSES, SPEAKER_STATUS_LABELS, SPEAKER_MATERIALS,
  materialStates, materialProgress,
} from '../lib/concontrol/program.js';

let ctx = null;
let view = 'home';

const state = {
  settings: { event: 'FOC27', eventName: '', eventDate: '', commitBy: '', budget: null, tiers: [], categories: [], inquiryNotifyTo: '', speakNotifyTo: '' },
  sponsors: [],
  entries: [],
  sessions: [],
  speakers: [],
  summary: null,
  categories: null,
  conflicts: [],
  blockers: [],
  canEdit: false,
  canDelete: false,
  canEditSettings: false,
  // Money is gated separately: a read-only account cannot see the budget.
  moneyDenied: false,
  loaded: { sponsors: false, money: false, program: false, responses: false },
  responses: { inquiries: [], proposals: [], survey: [], signups: [], summary: null },
  responsesDenied: false,
  responseTab: 'survey',
  filter: 'all',
  search: '',
  error: null,
};

/* ------------------------------------------------------------------ *
 * FORMATTING
 * ------------------------------------------------------------------ */

function usd(n) {
  if (n === null || n === undefined) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function clock(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')}${ampm}`;
}

const trackLabel = (key) => (TRACKS.find((t) => t.key === key) || {}).label || key;

/* ------------------------------------------------------------------ *
 * APP
 * ------------------------------------------------------------------ */

export default {
  id: 'concontrol',

  styles: `
    .con-wrap { padding: 18px 20px 60px; }
    .con-pane { display: none; }
    .con-pane.on { display: block; }

    .con-totals { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 18px; }
    .con-tot { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; }
    .con-tot .k { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; }
    .con-tot .v { font-size: 22px; font-weight: 700; color: var(--ink); margin-top: 4px; line-height: 1.1; }
    .con-tot .sub { font-size: 12px; color: var(--muted); margin-top: 3px; }
    .con-tot.warn .v { color: var(--danger); }

    .con-left { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; margin-bottom: 18px; }
    .con-left h4 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
    .con-slots { display: flex; flex-wrap: wrap; gap: 6px; }
    .con-slot { font-size: 12px; padding: 4px 10px; border-radius: var(--radius-pill); border: 1px solid var(--line); color: var(--ink); background: transparent; font-family: inherit; }
    .con-slot b { font-weight: 700; }
    .con-slot.gone { color: var(--muted); border-style: dashed; }
    .con-slot.bad { color: var(--danger); border-color: var(--danger); font-weight: 600; }

    .con-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
    .con-bar input[type="search"] { flex: 1 1 200px; min-width: 160px; padding: 7px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--card); color: var(--ink); font-size: 13px; }
    .con-chip { padding: 5px 11px; border: 1px solid var(--line); border-radius: var(--radius-pill); background: var(--card); color: var(--muted); font-size: 12px; font-weight: 600; cursor: pointer; }
    .con-chip.on { background: var(--accent-tint); border-color: var(--accent); color: var(--accent-deep); }
    .con-btn { padding: 7px 13px; border: 0; border-radius: var(--radius-sm); background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
    .con-btn.ghost { background: transparent; border: 1px solid var(--line); color: var(--ink); }
    .con-btn[disabled] { opacity: .5; cursor: default; }
    .con-spacer { flex: 1; }

    .con-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); }
    .con-card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; cursor: pointer; text-align: left; width: 100%; font: inherit; color: inherit; }
    .con-card:hover { border-color: var(--accent); }
    .con-card .top { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
    .con-card h3 { margin: 0; font-size: 15px; color: var(--ink); font-weight: 700; line-height: 1.25; }
    .con-card .who { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .con-tier { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--accent-deep); background: var(--accent-tint); padding: 3px 8px; border-radius: var(--radius-pill); white-space: nowrap; }
    .con-money { margin-top: 12px; font-size: 13px; color: var(--ink); display: flex; justify-content: space-between; }
    .con-money .muted { color: var(--muted); }
    .con-meter { height: 5px; border-radius: 3px; background: var(--line); margin-top: 6px; overflow: hidden; }
    .con-meter > i { display: block; height: 100%; background: var(--accent); }
    .con-why { margin-top: 10px; font-size: 12px; display: flex; align-items: center; gap: 6px; color: var(--muted); }
    .con-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
    .con-dot.attention { background: var(--danger); }
    .con-dot.waiting { background: var(--warn); }
    .con-dot.done { background: var(--success); }
    .con-why.attention { color: var(--danger); font-weight: 600; }
    .con-deliv { display: flex; gap: 4px; margin-top: 10px; flex-wrap: wrap; }
    .con-pip { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: 2px 7px; border-radius: var(--radius-pill); border: 1px solid var(--line); color: var(--muted); }
    .con-pip.done { background: var(--accent-tint); border-color: transparent; color: var(--accent-deep); }
    .con-pip.na { opacity: .45; text-decoration: line-through; }

    .con-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .con-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--line); }
    .con-table td { padding: 8px; border-bottom: 1px solid var(--line); color: var(--ink); }
    .con-table tr[data-open] { cursor: pointer; }
    .con-table tr[data-open]:hover td { background: var(--accent-tint); }
    .con-num { text-align: right; font-variant-numeric: tabular-nums; }

    .con-day { margin-bottom: 22px; }
    .con-day > h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 8px; }
    .con-slotrow { display: flex; gap: 8px; align-items: stretch; margin-bottom: 8px; }
    .con-time { flex: 0 0 74px; font-size: 12px; color: var(--muted); padding-top: 12px; font-variant-numeric: tabular-nums; }
    .con-sessions { flex: 1; display: grid; gap: 8px; grid-template-columns: 1fr 1fr; }
    .con-sessions.whole { grid-template-columns: 1fr; }
    .con-sess { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; text-align: left; font: inherit; color: inherit; cursor: pointer; }
    .con-sess:hover { border-color: var(--accent); }
    .con-sess .t { font-weight: 700; font-size: 13px; color: var(--ink); }
    .con-sess .m { font-size: 12px; color: var(--muted); margin-top: 3px; }
    .con-sess.pending { border-style: dashed; }

    .con-empty { padding: 44px 20px; text-align: center; color: var(--muted); }
    .con-empty h3 { color: var(--ink); font-size: 16px; margin: 0 0 6px; }

    .con-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.38); z-index: 60; }
    .con-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(540px, 100%); background: var(--card); border-left: 1px solid var(--line); z-index: 61; overflow-y: auto; padding: 18px 20px 60px; }
    .con-drawer h2 { margin: 0 0 2px; font-size: 18px; color: var(--ink); }
    .con-drawer .close { position: absolute; top: 12px; right: 14px; background: none; border: 0; font-size: 22px; line-height: 1; color: var(--muted); cursor: pointer; }
    .con-sec { margin-top: 20px; }
    .con-sec > h4 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
    .con-field { margin-bottom: 10px; }
    .con-field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; font-weight: 600; }
    .con-field input, .con-field select, .con-field textarea { width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg); color: var(--ink); font: inherit; font-size: 13px; }
    .con-field textarea { min-height: 76px; resize: vertical; }
    .con-two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .con-three { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
    .con-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--ink); }
    .con-row:last-child { border-bottom: 0; }
    .con-states { display: flex; gap: 4px; }
    .con-states button { font-size: 11px; padding: 3px 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: var(--radius-pill); cursor: pointer; font-weight: 600; font-family: inherit; }
    .con-states button.on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
    .con-actions { display: flex; gap: 8px; margin-top: 22px; flex-wrap: wrap; }
    .con-err { background: var(--danger-tint); color: var(--danger); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; margin-bottom: 10px; }
    .con-ok { background: var(--accent-tint); color: var(--accent-deep); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; margin-bottom: 10px; }
    .con-note { font-size: 12px; color: var(--muted); line-height: 1.5; }
    .con-trail { font-size: 12px; color: var(--muted); line-height: 1.6; }
    .con-trail div { padding: 3px 0; border-bottom: 1px solid var(--line); }
    .con-trail div:last-child { border-bottom: 0; }
  `,

  template: `
    <div class="con-wrap">
      <div id="conErr"></div>

      <section class="con-pane" data-pane="home">
        <div id="conHomeTotals" class="con-totals"></div>
        <div id="conHomeLeft"></div>
        <div id="conHomeBlocked"></div>
      </section>

      <section class="con-pane" data-pane="sponsors">
        <div id="conTotals" class="con-totals"></div>
        <div id="conLeft"></div>
        <div class="con-bar">
          <input type="search" id="conSearch" placeholder="Search company or contact" autocomplete="off">
          <span id="conChips"></span>
          <span class="con-spacer"></span>
          <a class="con-btn ghost" id="conExportSponsors" download>Export</a>
          <a class="con-btn ghost" id="conExportSignage" download>Signage list</a>
          <button class="con-btn" id="conNew">Add sponsor</button>
        </div>
        <div id="conBody"></div>
      </section>

      <section class="con-pane" data-pane="money">
        <div id="conMoneyTotals" class="con-totals"></div>
        <div class="con-bar">
          <span class="con-spacer"></span>
          <a class="con-btn ghost" id="conExportLedger" download>Export</a>
          <button class="con-btn" id="conNewEntry">Add entry</button>
        </div>
        <div id="conMoneyBody"></div>
      </section>

      <section class="con-pane" data-pane="sessions">
        <div id="conProgramWarn"></div>
        <div class="con-bar">
          <span class="con-spacer"></span>
          <a class="con-btn ghost" id="conExportSessions" download>Export</a>
          <button class="con-btn" id="conNewSession">Add session</button>
        </div>
        <div id="conSessionBody"></div>
      </section>

      <section class="con-pane" data-pane="speakers">
        <div class="con-bar">
          <span class="con-spacer"></span>
          <a class="con-btn ghost" id="conExportSpeakers" download>Export</a>
          <button class="con-btn" id="conNewSpeaker">Add speaker</button>
        </div>
        <div id="conSpeakerBody"></div>
      </section>

      <section class="con-pane" data-pane="responses">
        <div class="con-bar">
          <span id="conRespTabs"></span>
          <span class="con-spacer"></span>
          <button class="con-btn ghost" id="conImportOpen">Import from the sheet</button>
          <button class="con-btn" id="conLoadFoc26">Load the FOC26 responses</button>
        </div>
        <div id="conRespBody"></div>
      </section>

      <section class="con-pane" data-pane="settings">
        <div id="conSettingsBody"></div>
      </section>
    </div>
    <div id="conDrawerHost"></div>
  `,

  async mount(c) {
    ctx = c;
    const root = ctx.root;

    root.querySelector('#conSearch').addEventListener('input', (e) => {
      state.search = e.target.value.toLowerCase();
      renderSponsorList();
    });
    root.querySelector('#conChips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-filter]');
      if (!chip) return;
      state.filter = chip.dataset.filter;
      renderChips();
      renderSponsorList();
    });

    root.querySelector('#conNew').addEventListener('click', () => sponsorDrawer(null));
    root.querySelector('#conNewEntry').addEventListener('click', () => entryDrawer(null));
    root.querySelector('#conNewSession').addEventListener('click', () => sessionDrawer(null));
    root.querySelector('#conNewSpeaker').addEventListener('click', () => speakerDrawer(null));
    root.querySelector('#conImportOpen').addEventListener('click', () => importDrawer());
    root.querySelector('#conLoadFoc26').addEventListener('click', (e) => loadFoc26(e.target));
    root.querySelector('#conRespTabs').addEventListener('click', (e) => {
      const t = e.target.closest('[data-rtab]');
      if (!t) return;
      state.responseTab = t.dataset.rtab;
      renderResponses();
    });

    wireExport('#conExportSponsors', 'sponsors');
    wireExport('#conExportSignage', 'signage');
    wireExport('#conExportLedger', 'ledger');
    wireExport('#conExportSessions', 'sessions');
    wireExport('#conExportSpeakers', 'speakers');

    renderChips();
    await loadSponsors();
  },

  showView(next) {
    view = next || 'home';
    ctx.root.querySelectorAll('.con-pane').forEach((p) => {
      p.classList.toggle('on', p.dataset.pane === view);
    });
    // Each screen loads the first time it is opened rather than all of it on
    // mount. Opening Sponsors should not pay for the ledger and the program.
    if (view === 'money' && !state.loaded.money) loadMoney();
    if ((view === 'sessions' || view === 'speakers') && !state.loaded.program) loadProgram();
    if (view === 'responses' && !state.loaded.responses) loadResponses();
    if (view === 'settings') loadSettings();
    if (view === 'home') renderHome();
  },
};

function wireExport(sel, what) {
  const el = ctx.root.querySelector(sel);
  if (el) el.href = `${ENDPOINTS.conExport}?what=${what}`;
}

/* ------------------------------------------------------------------ *
 * DATA
 * ------------------------------------------------------------------ */

function showError(msg) {
  const host = ctx.root.querySelector('#conErr');
  host.innerHTML = msg ? `<div class="con-err">${esc(msg)}</div>` : '';
}

async function loadSponsors() {
  try {
    const data = await ctx.api.get(ENDPOINTS.conSponsors);
    state.sponsors = Array.isArray(data.sponsors) ? data.sponsors : [];
    state.settings = data.settings || state.settings;
    state.canEdit = !!data.canEdit;
    state.canDelete = !!data.canDelete;
    state.loaded.sponsors = true;
    showError('');
  } catch (e) {
    showError(e.message || 'Could not load sponsors');
  }
  renderSponsors();
  renderHome();
}

async function loadSettings() {
  try {
    const data = await ctx.api.get(ENDPOINTS.conSettings);
    state.settings = data.settings || state.settings;
    state.canEditSettings = !!data.canEdit;
  } catch (e) {
    showError(e.message || 'Could not load settings');
  }
  renderSettings();
}

async function loadMoney() {
  try {
    const data = await ctx.api.get(ENDPOINTS.conLedger);
    state.entries = Array.isArray(data.entries) ? data.entries : [];
    state.summary = data.summary || null;
    state.categories = data.categories || null;
    state.settings = data.settings || state.settings;
    state.moneyDenied = false;
    state.loaded.money = true;
  } catch (e) {
    // A read-only account is refused the budget on purpose, and that is a
    // sentence rather than an error banner.
    if (e.status === 403) state.moneyDenied = true;
    else showError(e.message || 'Could not load the ledger');
  }
  renderMoney();
}

async function loadProgram() {
  try {
    const [s, k] = [
      await ctx.api.get(ENDPOINTS.conSessions),
      await ctx.api.get(ENDPOINTS.conSpeakers),
    ];
    state.sessions = Array.isArray(s.sessions) ? s.sessions : [];
    state.conflicts = Array.isArray(s.conflicts) ? s.conflicts : [];
    state.speakers = Array.isArray(k.speakers) ? k.speakers : [];
    state.blockers = Array.isArray(k.blockers) ? k.blockers : [];
    state.loaded.program = true;
  } catch (e) {
    showError(e.message || 'Could not load the program');
  }
  renderSessions();
  renderSpeakers();
  renderHome();
}

/* ------------------------------------------------------------------ *
 * HOME
 * ------------------------------------------------------------------ */

function renderHome() {
  const host = ctx.root.querySelector('#conHomeTotals');
  if (!host) return;
  const t = rollup(state.sponsors);
  const days = state.settings.commitBy ? -daysBetween(state.settings.commitBy, new Date()) : null;

  const cards = [
    { k: 'Committed', v: usd(t.committed), sub: `${t.sponsorCount} sponsors` },
    { k: 'Collected', v: usd(t.collected), sub: t.nonCash ? `${usd(t.cash)} cash, ${usd(t.nonCash)} credit and in kind` : 'All cash' },
    { k: 'Outstanding', v: usd(t.outstanding), sub: t.unpriced ? `${t.unpriced} unpriced, not counted` : '' },
    { k: 'Needs a nudge', v: String(t.blocked), sub: 'Sponsors waiting on us', warn: t.blocked > 0 },
  ];
  if (days !== null) {
    cards.push({
      k: 'Commitments by',
      v: days >= 0 ? `${days} days` : 'Passed',
      sub: prettyDate(state.settings.commitBy),
      warn: days !== null && days < 30,
    });
  }

  host.innerHTML = cards.map((c) => `
    <div class="con-tot${c.warn ? ' warn' : ''}">
      <div class="k">${esc(c.k)}</div>
      <div class="v">${esc(c.v)}</div>
      ${c.sub ? `<div class="sub">${esc(c.sub)}</div>` : ''}
    </div>`).join('');

  ctx.root.querySelector('#conHomeLeft').innerHTML = inventoryHtml();
  renderBlocked();
}

/**
 * Everything waiting on somebody, in one list, newest problem first.
 *
 * This is the screen's reason to exist: the four other screens each know their
 * own half, and the question "what is actually stuck" was the one that needed
 * opening all of them.
 */
function renderBlocked() {
  const host = ctx.root.querySelector('#conHomeBlocked');
  const rows = [];

  for (const s of state.sponsors) {
    const h = sponsorHealth(s);
    if (h.level === 'attention') rows.push({ what: s.company, why: h.why, go: 'sponsors', id: s.id });
  }
  for (const s of state.sponsors) {
    const o = obligationProgress(s);
    const m = sponsorMoney(s);
    if (m.paidInFull && o.owed && !o.complete) {
      rows.push({ what: s.company, why: `We owe them ${o.open} thing${o.open === 1 ? '' : 's'}`, go: 'sponsors', id: s.id });
    }
  }
  for (const c of state.conflicts) {
    const label = {
      'double-booked': 'Two sessions in one slot',
      'runs-against-whole-room': 'Runs against a whole-room slot',
      'confirmed-with-no-slot': 'Confirmed with no time set',
      'confirmed-with-no-speaker': 'Confirmed with no speaker',
    }[c.kind] || c.kind;
    rows.push({ what: 'Program', why: label, go: 'sessions', id: c.ids && c.ids[0] });
  }
  for (const b of state.blockers) {
    if (b.kind === 'speaker-materials') {
      rows.push({ what: b.name || 'Speaker', why: `${b.open} thing${b.open === 1 ? '' : 's'} still to send`, go: 'speakers', id: b.ids[0] });
    }
  }

  if (!rows.length) {
    host.innerHTML = `<div class="con-left"><h4>Waiting on someone</h4><div class="con-note">${state.loaded.program ? 'Nothing is stuck.' : 'Nothing on the sponsor side. Open Sessions or Speakers to check the program.'}</div></div>`;
    return;
  }

  host.innerHTML = `
    <div class="con-left">
      <h4>Waiting on someone</h4>
      <table class="con-table">
        <tbody>
          ${rows.map((r) => `
            <tr data-go="${esc(r.go)}" data-id="${esc(r.id || '')}">
              <td><strong>${esc(r.what)}</strong></td>
              <td>${esc(r.why)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-go]').forEach((tr) => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => ctx.go(tr.dataset.go));
  });
}

/* ------------------------------------------------------------------ *
 * SPONSORS
 * ------------------------------------------------------------------ */

function renderSponsors() {
  renderSponsorTotals();
  ctx.root.querySelector('#conLeft').innerHTML = inventoryHtml();
  renderSponsorList();
  ctx.root.querySelector('#conNew').disabled = !state.canEdit;
}

function renderChips() {
  const opts = [['all', 'All']].concat(STATUSES.map((s) => [s, STATUS_LABELS[s]]));
  ctx.root.querySelector('#conChips').innerHTML = opts
    .map(([k, label]) => `<button class="con-chip${state.filter === k ? ' on' : ''}" data-filter="${k}">${esc(label)}</button>`)
    .join(' ');
}

function renderSponsorTotals() {
  const host = ctx.root.querySelector('#conTotals');
  const t = rollup(state.sponsors);
  const cards = [
    { k: 'Committed', v: usd(t.committed), sub: t.unpriced ? `${t.unpriced} with no amount agreed` : `${t.sponsorCount} sponsors` },
    { k: 'Collected', v: usd(t.collected), sub: t.committed > 0 ? Math.round((t.collected / t.committed) * 100) + '% of committed' : '' },
    // Cash and value are never added together on a card. A credit is real
    // dollars and is not in the bank, and a total that mixes them is a number
    // somebody will quote and be wrong about.
    { k: 'Of that, cash', v: usd(t.cash), sub: t.nonCash ? usd(t.nonCash) + ' in credit and in kind' : 'All of it' },
    { k: 'Outstanding', v: usd(t.outstanding), sub: t.unpriced ? 'Excludes the unpriced' : '' },
    { k: 'Needs a nudge', v: String(t.blocked), sub: 'Sponsors waiting on us', warn: t.blocked > 0 },
    { k: 'Deliverables open', v: String(t.deliverablesOpen), sub: 'Logos, swag, posts, sessions' },
  ];
  host.innerHTML = cards.map((c) => `
    <div class="con-tot${c.warn ? ' warn' : ''}">
      <div class="k">${esc(c.k)}</div>
      <div class="v">${esc(c.v)}</div>
      ${c.sub ? `<div class="sub">${esc(c.sub)}</div>` : ''}
    </div>`).join('');
}

/**
 * What is still sellable, and who holds each moment.
 *
 * Computed from the records rather than read off the website, because the
 * website prints "3 available" as a static number and has no way to know that
 * two of them are gone.
 */
function inventoryHtml() {
  const tiers = tierAvailability(state.sponsors, state.settings.tiers);
  const moments = momentAvailability(state.sponsors);

  const slotChips = tiers.filter((t) => t.slots !== null).map((t) => {
    if (t.oversold) return `<span class="con-slot bad">${esc(t.name)}: ${t.sold} sold, ${t.slots} available</span>`;
    if (t.soldOut) return `<span class="con-slot gone">${esc(t.name)}: sold out${t.pending ? ' · ' + t.pending + ' asking' : ''}</span>`;
    return `<span class="con-slot"><b>${t.left}</b> ${esc(t.name)} left${t.pending ? ' · ' + t.pending + ' in conversation' : ''}</span>`;
  });

  const momentChips = moments.map((m) => {
    if (m.conflict) return `<span class="con-slot bad">${esc(m.label)}: claimed twice</span>`;
    if (m.claimedBy) return `<span class="con-slot gone">${esc(m.label)}: ${esc(m.claimedBy)}</span>`;
    if (m.pendingBy) return `<span class="con-slot">${esc(m.label)}: ${esc(m.pendingBy)} asking</span>`;
    return `<span class="con-slot"><b>${esc(m.label)}</b> open</span>`;
  });

  return `<div class="con-left"><h4>Still open</h4><div class="con-slots">${slotChips.concat(momentChips).join('')}</div></div>`;
}

function visibleSponsors() {
  return state.sponsors.filter((s) => {
    if (state.filter !== 'all' && s.status !== state.filter) return false;
    if (!state.search) return true;
    return `${s.company} ${s.contactName} ${s.email} ${s.tier}`.toLowerCase().includes(state.search);
  });
}

function renderSponsorList() {
  const host = ctx.root.querySelector('#conBody');
  const rows = visibleSponsors();

  if (!rows.length) {
    host.innerHTML = state.sponsors.length
      ? '<div class="con-empty"><h3>Nothing matches</h3><p>Try a different filter.</p></div>'
      : '<div class="con-empty"><h3>No sponsors yet</h3><p>Add the first one, or wait for an inquiry to arrive from the sponsor page.</p></div>';
    return;
  }

  host.innerHTML = `<div class="con-grid">${rows.map(sponsorCard).join('')}</div>`;
  host.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => sponsorDrawer(el.dataset.open));
  });
}

function sponsorCard(s) {
  const m = sponsorMoney(s);
  const h = sponsorHealth(s);
  const p = deliverableProgress(s);
  const o = obligationProgress(s);
  const states = deliverableStates(s);
  const pct = m.committedKnown && m.committed > 0 ? Math.min(100, Math.round((m.paid / m.committed) * 100)) : 0;

  return `
    <button class="con-card" data-open="${esc(s.id)}">
      <div class="top">
        <div>
          <h3>${esc(s.company || 'Untitled')}</h3>
          <div class="who">${esc(s.contactName || 'No contact yet')}</div>
        </div>
        ${s.tier ? `<span class="con-tier">${esc(s.tier)}</span>` : ''}
      </div>
      <div class="con-money">
        <span>${m.committedKnown ? usd(m.paid) + ' of ' + usd(m.committed) : 'No amount agreed'}</span>
        <span class="muted">${m.committedKnown && m.outstanding > 0
          ? usd(m.outstanding) + ' out'
          : (m.nonCash > 0 ? (m.cash > 0 ? usd(m.nonCash) + ' not cash' : 'Not cash') : '')}</span>
      </div>
      <div class="con-meter"><i style="width:${pct}%"></i></div>
      <div class="con-why ${esc(h.level)}"><span class="con-dot ${esc(h.level)}"></span>${esc(h.why)}</div>
      <div class="con-deliv">
        ${DELIVERABLES.map((d) => `<span class="con-pip ${esc(states[d.key].state)}">${esc(d.label.split(' ')[0])}</span>`).join('')}
        ${p.owed ? `<span class="con-pip">They owe ${p.done}/${p.owed}</span>` : ''}
        ${o.owed ? `<span class="con-pip${o.complete ? ' done' : ''}">We owe ${o.done}/${o.owed}</span>` : ''}
      </div>
    </button>`;
}

/* ------------------------------------------------------------------ *
 * MONEY
 * ------------------------------------------------------------------ */

function renderMoney() {
  const totals = ctx.root.querySelector('#conMoneyTotals');
  const body = ctx.root.querySelector('#conMoneyBody');
  ctx.root.querySelector('#conNewEntry').disabled = !state.canEdit || state.moneyDenied;

  if (state.moneyDenied) {
    totals.innerHTML = '';
    body.innerHTML = '<div class="con-empty"><h3>Not your screen</h3><p>The event budget is not open to read-only accounts. Everything else in ConControl still is.</p></div>';
    return;
  }

  const sum = state.summary;
  if (!sum) { body.innerHTML = '<div class="con-empty">Loading the ledger…</div>'; return; }

  const cards = [
    { k: 'Cash in', v: usd(sum.incomeIn), sub: `${usd(sum.sponsorCash)} of it from sponsors` },
    { k: 'Covered, not cash', v: usd(sum.sponsorNonCash), sub: sum.sponsorNonCash ? 'Credits and in kind, never in the bank' : 'Nothing so far' },
    { k: 'Still expected', v: usd(sum.incomeExpected), sub: 'Committed and not yet paid' },
    { k: 'Spent', v: usd(sum.spendOut), sub: sum.spend.gaps ? `${sum.spend.gaps} entries with no amount` : '' },
    { k: 'On the hook', v: usd(sum.spendAhead), sub: `${usd(sum.spend.committed)} committed, ${usd(sum.spend.estimated)} estimated` },
    { k: 'Position today', v: usd(sum.net), sub: `Projected ${usd(sum.projected)}`, warn: sum.net < 0 },
  ];
  if (sum.budget !== null) {
    cards.push({ k: 'Budget left', v: usd(sum.budgetLeft), sub: `of ${usd(sum.budget)}`, warn: sum.budgetLeft !== null && sum.budgetLeft < 0 });
  }

  totals.innerHTML = cards.map((c) => `
    <div class="con-tot${c.warn ? ' warn' : ''}">
      <div class="k">${esc(c.k)}</div>
      <div class="v">${esc(c.v)}</div>
      ${c.sub ? `<div class="sub">${esc(c.sub)}</div>` : ''}
    </div>`).join('');

  const cats = state.categories || { rows: [], gaps: 0 };
  const catHtml = cats.rows.length ? `
    <div class="con-left">
      <h4>Where it goes</h4>
      <table class="con-table">
        <thead><tr><th>Category</th><th class="con-num">Paid</th><th class="con-num">Ahead</th><th class="con-num">Total</th></tr></thead>
        <tbody>
          ${cats.rows.map((r) => `
            <tr>
              <td>${esc(r.category)}</td>
              <td class="con-num">${usd(r.paid)}</td>
              <td class="con-num">${usd(r.ahead)}</td>
              <td class="con-num"><strong>${usd(r.total)}</strong></td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${cats.gaps ? `<div class="con-note" style="margin-top:8px">${cats.gaps} entr${cats.gaps === 1 ? 'y has' : 'ies have'} no amount yet, and are left out rather than counted as zero.</div>` : ''}
    </div>` : '';

  const ledgerHtml = state.entries.length ? `
    <table class="con-table">
      <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>State</th><th class="con-num">Amount</th></tr></thead>
      <tbody>
        ${state.entries.map((e) => `
          <tr data-open="${esc(e.id)}">
            <td>${esc(prettyDate(e.date)) || '<span style="opacity:.5">no date</span>'}</td>
            <td><strong>${esc(e.description)}</strong>${e.vendor ? '<br><span style="opacity:.7">' + esc(e.vendor) + '</span>' : ''}</td>
            <td>${esc(e.category) || '<span style="opacity:.5">none</span>'}</td>
            <td>${esc(ENTRY_STATE_LABELS[e.state] || e.state)}${e.kind === 'income' ? ' · income' : ''}</td>
            <td class="con-num">${e.amount === null ? '<span style="opacity:.5">not set</span>' : usd(e.amount)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`
    : '<div class="con-empty"><h3>Nothing recorded yet</h3><p>Sponsor money is already counted from the sponsor records. This is for everything else: food, video, venue, print, swag, speaker costs.</p></div>';

  body.innerHTML = catHtml + ledgerHtml;
  body.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => entryDrawer(el.dataset.open));
  });
}

/* ------------------------------------------------------------------ *
 * SESSIONS
 * ------------------------------------------------------------------ */

function renderSessions() {
  const warn = ctx.root.querySelector('#conProgramWarn');
  const body = ctx.root.querySelector('#conSessionBody');
  ctx.root.querySelector('#conNewSession').disabled = !state.canEdit;

  warn.innerHTML = state.conflicts.length ? `
    <div class="con-left">
      <h4>Needs sorting out</h4>
      <div class="con-slots">
        ${state.conflicts.map((c) => {
          const label = {
            'double-booked': `Two sessions at ${clock(c.start)} in ${trackLabel(c.track)}`,
            'runs-against-whole-room': `${trackLabel(c.track)} at ${clock(c.start)} runs against a whole-room slot`,
            'confirmed-with-no-slot': 'A confirmed session has no time',
            'confirmed-with-no-speaker': 'A confirmed session has no speaker',
          }[c.kind] || c.kind;
          return `<span class="con-slot bad">${esc(label)}</span>`;
        }).join('')}
      </div>
    </div>` : '';

  if (!state.sessions.length) {
    body.innerHTML = '<div class="con-empty"><h3>No sessions yet</h3><p>Build the grid here and the public agenda reads from it, instead of the schedule living in two places.</p></div>';
    return;
  }

  const days = Array.from(new Set(state.sessions.map((s) => s.day || 1))).sort();
  body.innerHTML = days.map((day) => {
    const mine = state.sessions.filter((s) => (s.day || 1) === day);
    const times = Array.from(new Set(mine.map((s) => s.start || ''))).sort();
    return `
      <div class="con-day">
        <h3>Day ${day}</h3>
        ${times.map((time) => {
          const slot = mine.filter((s) => (s.start || '') === time);
          const whole = slot.some((s) => s.track === 'all');
          return `
            <div class="con-slotrow">
              <div class="con-time">${time ? esc(clock(time)) : 'no time'}</div>
              <div class="con-sessions${whole ? ' whole' : ''}">
                ${slot.map(sessionCard).join('')}
              </div>
            </div>`;
        }).join('')}
      </div>`;
  }).join('');

  body.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => sessionDrawer(el.dataset.open));
  });
}

function sessionCard(s) {
  const names = (s.speakerIds || [])
    .map((id) => (state.speakers.find((k) => k.id === id) || {}).name)
    .filter(Boolean);
  const pending = s.status !== 'confirmed';
  return `
    <button class="con-sess${pending ? ' pending' : ''}" data-open="${esc(s.id)}">
      <div class="t">${esc(s.title || 'Untitled')}</div>
      <div class="m">
        ${esc(trackLabel(s.track))} · ${esc(s.minutes)} min · ${esc(SESSION_STATUS_LABELS[s.status] || s.status)}
        ${names.length ? '<br>' + esc(names.join(', ')) : (['meal', 'social'].includes(s.format) ? '' : '<br><span style="opacity:.6">no speaker</span>')}
      </div>
    </button>`;
}

/* ------------------------------------------------------------------ *
 * SPEAKERS
 * ------------------------------------------------------------------ */

function renderSpeakers() {
  const body = ctx.root.querySelector('#conSpeakerBody');
  ctx.root.querySelector('#conNewSpeaker').disabled = !state.canEdit;

  if (!state.speakers.length) {
    body.innerHTML = '<div class="con-empty"><h3>No speakers yet</h3><p>Proposals from the call-for-speakers page land here, and the ones you pass on stay as next year&rsquo;s list.</p></div>';
    return;
  }

  body.innerHTML = `<div class="con-grid">${state.speakers.map(speakerCard).join('')}</div>`;
  body.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => speakerDrawer(el.dataset.open));
  });
}

function speakerCard(k) {
  const p = materialProgress(k);
  const states = materialStates(k);
  const sessions = state.sessions.filter((s) => (s.speakerIds || []).includes(k.id));
  return `
    <button class="con-card" data-open="${esc(k.id)}">
      <div class="top">
        <div>
          <h3>${esc(k.name)}</h3>
          <div class="who">${esc(k.company || 'No company given')}</div>
        </div>
        <span class="con-tier">${esc(SPEAKER_STATUS_LABELS[k.status] || k.status)}</span>
      </div>
      ${k.topic ? `<div class="con-why">${esc(k.topic.slice(0, 120))}${k.topic.length > 120 ? '…' : ''}</div>` : ''}
      <div class="con-deliv">
        ${SPEAKER_MATERIALS.map((m) => `<span class="con-pip ${esc(states[m.key].state)}">${esc(m.label.split(' ')[0])}</span>`).join('')}
      </div>
      <div class="con-why">
        ${k.status === 'confirmed'
          ? `<span class="con-dot ${p.complete ? 'done' : 'waiting'}"></span>${p.complete ? 'Everything in' : p.open + ' still to send'}`
          : '<span class="con-dot"></span>Not confirmed yet'}
        ${sessions.length ? ' · ' + sessions.length + ' session' + (sessions.length === 1 ? '' : 's') : ''}
      </div>
    </button>`;
}

/* ------------------------------------------------------------------ *
 * SETTINGS
 * ------------------------------------------------------------------ */

function renderSettings() {
  const host = ctx.root.querySelector('#conSettingsBody');
  const s = state.settings;
  const ro = !state.canEditSettings;

  host.innerHTML = `
    <div class="con-left" style="max-width:640px">
      <h4>The event</h4>
      <div class="con-two">
        <div class="con-field"><label>Code</label><input id="set_event" value="${esc(s.event)}" ${ro ? 'disabled' : ''}></div>
        <div class="con-field"><label>Name</label><input id="set_eventName" value="${esc(s.eventName)}" ${ro ? 'disabled' : ''}></div>
      </div>
      <div class="con-two">
        <div class="con-field"><label>First day</label><input id="set_eventDate" type="date" value="${esc(s.eventDate)}" ${ro ? 'disabled' : ''}></div>
        <div class="con-field"><label>Commitments by</label><input id="set_commitBy" type="date" value="${esc(s.commitBy)}" ${ro ? 'disabled' : ''}></div>
      </div>
      <div class="con-field"><label>Budget, if you set one</label><input id="set_budget" inputmode="decimal" value="${s.budget === null ? '' : esc(s.budget)}" placeholder="Leave blank for no budget" ${ro ? 'disabled' : ''}></div>

      <h4 style="margin-top:20px">Sponsor levels</h4>
      <div class="con-note" style="margin-bottom:8px">One per line: name, amount, places. Leave places blank for unlimited. A sponsor keeps the level name they were sold at, so renaming one here does not rewrite history.</div>
      <div class="con-field"><textarea id="set_tiers" ${ro ? 'disabled' : ''}>${esc((s.tiers || []).map((t) => [t.name, t.amount === null || t.amount === undefined ? '' : t.amount, t.slots === null || t.slots === undefined ? '' : t.slots].join(', ')).join('\n'))}</textarea></div>

      ${ro ? '' : '<button class="con-slot" data-defaults="tiers" style="margin-bottom:12px">Refill with the FOC27 levels</button>'}

      <h4 style="margin-top:20px">Spend categories</h4>
      <div class="con-field"><textarea id="set_categories" ${ro ? 'disabled' : ''}>${esc((s.categories || []).join('\n'))}</textarea></div>

      ${ro ? '' : '<button class="con-slot" data-defaults="categories" style="margin-bottom:12px">Refill with the default categories</button>'}

      <h4 style="margin-top:20px">Who hears about it</h4>
      <div class="con-note" style="margin-bottom:8px">A username. When one is set, a sponsor inquiry or a session proposal from the website raises a notification for that person. Left blank, the record is still saved and nobody is told.</div>
      <div class="con-two">
        <div class="con-field"><label>Sponsor inquiries</label><input id="set_inquiryNotifyTo" value="${esc(s.inquiryNotifyTo)}" placeholder="Nobody" ${ro ? 'disabled' : ''}></div>
        <div class="con-field"><label>Speaker proposals</label><input id="set_speakNotifyTo" value="${esc(s.speakNotifyTo)}" placeholder="Nobody" ${ro ? 'disabled' : ''}></div>
      </div>

      <div id="conSetMsg"></div>
      <div class="con-actions">
        ${ro ? '<div class="con-note">Event settings are admin only. What is here changes what the whole team sees.</div>' : '<button class="con-btn" id="conSaveSettings">Save settings</button>'}
      </div>
    </div>

    ${ro ? '' : `
    <div class="con-left" style="max-width:640px">
      <h4>Start from last year</h4>
      <div class="con-note" style="margin-bottom:10px">
        Safe to press twice. The survey is not here: it lands in Responses, where
        you read it and decide what becomes a session. The second button takes
        back the session ideas and wishlist speakers an earlier version put on
        the program by itself, leaving anything you have since scheduled,
        confirmed or invited exactly where it is.
      </div>
      <div class="con-slots">
        <button class="con-slot" data-seed="sponsors">FOC26 sponsors as prospects</button>
        <button class="con-slot" data-seed="undo-survey">Clear what was seeded in</button>
      </div>
      <div id="conSeedMsg" style="margin-top:10px"></div>
      <div class="con-note" style="margin-top:8px">
        Prior-year sponsors arrive with no committed amount: they sponsored last
        year, they have not agreed to anything for this one.
      </div>
    </div>`}`;

  const btn = host.querySelector('#conSaveSettings');
  if (btn) btn.addEventListener('click', saveSettings);

  // Refill, not save. The box is filled and nothing is written until Save is
  // pressed, so a misclick costs one undo rather than the lineup.
  host.querySelectorAll('[data-defaults]').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.defaults === 'tiers') {
        ctx.root.querySelector('#set_tiers').value = SEED_TIERS
          .map((t) => [t.name, t.amount === null ? '' : t.amount, t.slots === null ? '' : t.slots].join(', '))
          .join('\n');
      } else {
        ctx.root.querySelector('#set_categories').value = SEED_CATEGORIES.join('\n');
      }
      ctx.root.querySelector('#conSetMsg').innerHTML =
        '<div class="con-ok">Filled in. Nothing is saved until you press Save settings.</div>';
    });
  });

  host.querySelectorAll('[data-seed]').forEach((el) => {
    el.addEventListener('click', () => runSeed(el, el.dataset.seed));
  });
}

async function saveSettings() {
  const v = (id) => {
    const el = ctx.root.querySelector('#' + id);
    return el ? el.value.trim() : '';
  };
  const msg = ctx.root.querySelector('#conSetMsg');

  // Split on real newlines AND on a literal backslash-n. The textarea used to
  // be filled with the literal, so a box that has not been retyped since still
  // holds one long line, and splitting only on newlines would save the whole
  // lineup as a single tier called "Presenting, 7000, 1\\nGold...". That is
  // exactly what happened once, and it collapsed five levels into one.
  const lines = (text) => text.split(/\r?\n|\\n/).map((x) => x.trim()).filter(Boolean);

  const tiers = lines(v('set_tiers')).map((line) => {
    const [name, amount, slots] = line.split(',').map((x) => (x || '').trim());
    return { name, amount: amount === '' ? null : amount, slots: slots === '' ? null : slots };
  }).filter((t) => t.name);

  const body = {
    event: v('set_event'),
    eventName: v('set_eventName'),
    eventDate: v('set_eventDate'),
    commitBy: v('set_commitBy'),
    budget: v('set_budget') === '' ? null : v('set_budget'),
    tiers,
    categories: lines(v('set_categories')),
    inquiryNotifyTo: v('set_inquiryNotifyTo'),
    speakNotifyTo: v('set_speakNotifyTo'),
  };

  try {
    const res = await ctx.api.patch(ENDPOINTS.conSettings, body);
    state.settings = res.settings;
    msg.innerHTML = '<div class="con-ok">Saved.</div>';
    renderSponsors();
    renderHome();
  } catch (e) {
    msg.innerHTML = `<div class="con-err">${esc(e.message || 'Could not save')}</div>`;
  }
}

/**
 * Run one of the one-time imports and say in words what it did.
 *
 * "Imported" on its own is not a result. Created, refreshed and skipped are
 * three different outcomes, and on a second run the interesting number is the
 * skipped one, because that is the importer declining to overwrite a decision
 * somebody made.
 */
async function runSeed(button, what) {
  const msg = ctx.root.querySelector('#conSeedMsg');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  msg.innerHTML = '';

  try {
    const res = await ctx.api.post(ENDPOINTS.conSeed, { what });
    const parts = [];
    if (res.created && res.created.length) parts.push(`${res.created.length} created`);
    if (res.updated && res.updated.length) parts.push(`${res.updated.length} refreshed`);
    if (res.skipped && res.skipped.length) parts.push(`${res.skipped.length} left alone`);
    if (res.removedSessions) parts.push(`${res.removedSessions.length} session ideas removed`);
    if (res.removedSpeakers) parts.push(`${res.removedSpeakers.length} wishlist speakers removed`);
    if (res.removedSponsors) parts.push(`${res.removedSponsors.length} untouched prospects removed`);
    const kept = (res.keptSessions || []).concat(res.keptSpeakers || [], res.keptSponsors || []);
    if (kept.length) parts.push(`${kept.length} kept because you had moved them on: ${kept.join(', ')}`);
    msg.innerHTML = `<div class="con-ok">${esc(parts.length ? parts.join(', ') : 'Nothing to do')}${res.skipped && res.skipped.length ? '. Skipped: ' + esc(res.skipped.join(', ')) : '.'}</div>`;

    // The imported records are on other screens, so those caches are now stale.
    state.loaded.program = false;
    state.loaded.sponsors = false;
    await loadSponsors();
    await loadProgram();
  } catch (e) {
    msg.innerHTML = `<div class="con-err">${esc(e.message || 'Import failed')}</div>`;
  }

  button.disabled = false;
  button.textContent = label;
}


/* ------------------------------------------------------------------ *
 * RESPONSES
 *
 * Four streams, four tabs. Nothing here writes to the program by itself: a
 * topic becomes a session idea when somebody presses the button on its row,
 * which is the whole reason this screen exists rather than an importer.
 * ------------------------------------------------------------------ */

async function loadResponses() {
  try {
    const data = await ctx.api.get(ENDPOINTS.conResponses);
    state.responses = data;
    state.responsesDenied = false;
    state.loaded.responses = true;
  } catch (e) {
    if (e.status === 403) state.responsesDenied = true;
    else showError(e.message || 'Could not load responses');
  }
  renderResponses();
}

// The four forms on the event site, in the order somebody meets them: they
// answer the survey or ask to be told about next year long before they apply
// to sponsor or speak.
const RESP_TABS = [
  ['survey', 'Survey'],
  ['signups', 'Notify list'],
  ['inquiries', 'Sponsor applications'],
  ['proposals', 'Speaker applications'],
];

function renderResponses() {
  const tabs = ctx.root.querySelector('#conRespTabs');
  const body = ctx.root.querySelector('#conRespBody');
  if (!tabs) return;

  if (state.responsesDenied) {
    tabs.innerHTML = '';
    body.innerHTML = '<div class="con-empty"><h3>Not your screen</h3><p>People wrote candidly about their own shops here, so responses are not open to read-only accounts.</p></div>';
    return;
  }

  const r = state.responses;
  const counts = {
    survey: (r.survey || []).length,
    inquiries: (r.inquiries || []).length,
    proposals: (r.proposals || []).length,
    signups: (r.signups || []).length,
  };

  tabs.innerHTML = RESP_TABS.map(([k, label]) =>
    `<button class="con-chip${state.responseTab === k ? ' on' : ''}" data-rtab="${k}">${esc(label)} ${counts[k]}</button>`
  ).join(' ');

  if (state.responseTab === 'survey') return renderSurvey(body);
  if (state.responseTab === 'inquiries') return renderInquiries(body);
  if (state.responseTab === 'proposals') return renderProposals(body);
  return renderSignups(body);
}

/**
 * The survey, laid out in the order the question catalog declares.
 *
 * Generated, not hand written, so a question added to the form next year shows
 * up here correctly without anybody editing this file.
 */
function renderSurvey(body) {
  const sum = state.responses.summary;
  const rows = state.responses.survey || [];

  if (!rows.length) {
    body.innerHTML = '<div class="con-empty"><h3>No survey responses yet</h3><p>Press Load the FOC26 responses to bring in the nineteen answers and the notify list. Later surveys come in through Import from the sheet.</p></div>';
    return;
  }

  const acted = new Set();
  for (const rec of rows) for (const t of (rec.actedOn || [])) acted.add(t);

  const demand = (sum && sum.topics) || { rows: [], respondents: rows.length };

  const topicTable = `
    <div class="con-left">
      <h4>What to teach, as ${demand.respondents} shops asked for it</h4>
      <div class="con-note" style="margin-bottom:8px">
        Picked is how many chose it among their five. Must-have is how many named
        it as the one session they would not miss. The two disagree in useful
        ways, so they are not collapsed into a rank.
      </div>
      <table class="con-table">
        <thead><tr><th>Topic</th><th class="con-num">Picked</th><th class="con-num">Must-have</th><th></th></tr></thead>
        <tbody>
          ${demand.rows.map((row) => `
            <tr>
              <td>${esc(row.topic)}</td>
              <td class="con-num">${row.picked}</td>
              <td class="con-num">${row.mustHave ? '<strong>' + row.mustHave + '</strong>' : '<span style="opacity:.4">0</span>'}</td>
              <td class="con-num">${acted.has(row.topic)
                ? '<span class="con-pip done">On the program</span>'
                : (state.responses.canEdit ? `<button class="con-slot" data-promote="${esc(row.topic)}">Make a session idea</button>` : '')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  const countBlocks = [].concat(sum.headline || [], sum.counts || [])
    .filter((b) => b.key !== 'topics' && b.key !== 'must_have_session')
    .map((b) => `
      <div class="con-left">
        <h4>${esc(b.label)} · ${b.answered} answered</h4>
        <table class="con-table">
          <tbody>
            ${b.rows.map((row) => `
              <tr>
                <td>${esc(row.value)}</td>
                <td class="con-num" style="width:60px">${row.count}</td>
                <td style="width:120px">
                  <div class="con-meter"><i style="width:${Math.round(row.share * 100)}%"></i></div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`).join('');

  const textBlocks = (sum.text || []).map((b) => `
    <div class="con-left">
      <h4>${esc(b.label)} · ${b.answered} answered</h4>
      ${b.rows.map((row) => `
        <div class="con-row" style="align-items:flex-start">
          <span style="flex:1">${esc(row.text)}</span>
          <span class="con-note" style="white-space:nowrap">${esc(row.who)}${row.shop ? ', ' + esc(row.shop) : ''}</span>
        </div>`).join('')}
    </div>`).join('');

  const people = `
    <div class="con-left">
      <h4>Who answered</h4>
      <table class="con-table">
        <tbody>
          ${rows.map((rec) => `
            <tr data-open-response="${esc(rec.id)}">
              <td><strong>${esc(responderName(rec))}</strong></td>
              <td>${esc(responderShop(rec))}</td>
              <td class="con-note">${esc(prettyDate(rec.submittedAt))}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  body.innerHTML = topicTable + countBlocks + textBlocks + people;

  body.querySelectorAll('[data-promote]').forEach((el) => {
    el.addEventListener('click', () => promoteTopic(el, el.dataset.promote));
  });
  body.querySelectorAll('[data-open-response]').forEach((el) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => responseDrawer(el.dataset.openResponse));
  });
}

/**
 * Bring in the FOC26 survey and notify list, which ship with the app.
 *
 * A button rather than a paste because every version of this that asked for a
 * CSV export went unrun. Pressing it twice is harmless: the same email and
 * submitted-at matching the paste uses applies here.
 */
async function loadFoc26(button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    const res = await ctx.api.post(ENDPOINTS.conResponses, { what: 'load-foc26' });
    state.loaded.responses = false;
    await loadResponses();
    const s = res.survey || {};
    const g = res.signups || {};
    showError('');
    const msg = [`${s.created} survey responses added`, `${g.created} on the notify list`]
      .concat(s.duplicate ? [`${s.duplicate} were already here`] : []).join(', ');
    ctx.root.querySelector('#conRespBody').insertAdjacentHTML('afterbegin', `<div class="con-ok">${esc(msg)}.</div>`);
  } catch (e) {
    showError(e.message || 'Could not load them');
  }
  button.disabled = false;
  button.textContent = label;
}

async function promoteTopic(button, topic) {
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    await ctx.api.post(ENDPOINTS.conResponses, { what: 'promote', topic });
    state.loaded.program = false;
    await loadResponses();
    await loadProgram();
  } catch (e) {
    showError(e.message || 'Could not add that');
    button.disabled = false;
    button.textContent = 'Make a session idea';
  }
}

function renderInquiries(body) {
  const rows = state.responses.inquiries || [];
  if (!rows.length) {
    body.innerHTML = '<div class="con-empty"><h3>No sponsor applications yet</h3><p>Anything submitted on the sponsor page lands here. A sponsor you added yourself, or a prospect carried over from last year, is not an application and stays on the Sponsors screen.</p></div>';
    return;
  }
  body.innerHTML = `
    <div class="con-left">
      <table class="con-table">
        <thead><tr><th>Company</th><th>Contact</th><th>Level asked about</th><th>Arrived</th></tr></thead>
        <tbody>
          ${rows.map((s) => `
            <tr data-open-sponsor="${esc(s.id)}">
              <td><strong>${esc(s.company)}</strong></td>
              <td>${esc(s.contactName || s.email)}</td>
              <td>${esc(s.tier) || '<span style="opacity:.5">not said</span>'}</td>
              <td class="con-note">${esc(prettyDate(s.createdAt))}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  body.querySelectorAll('[data-open-sponsor]').forEach((el) => {
    el.addEventListener('click', () => { ctx.go('sponsors'); sponsorDrawer(el.dataset.openSponsor); });
  });
}

function renderProposals(body) {
  const rows = state.responses.proposals || [];
  if (!rows.length) {
    body.innerHTML = '<div class="con-empty"><h3>No speaker applications yet</h3><p>Anything submitted on the call for speakers lands here. Names people wrote in the survey are answers to a survey question, so they are in the Survey tab under who they would drive to hear.</p></div>';
    return;
  }
  body.innerHTML = `
    <div class="con-left">
      <table class="con-table">
        <thead><tr><th>Name</th><th>Shop</th><th>What they want to teach</th><th></th></tr></thead>
        <tbody>
          ${rows.map((k) => `
            <tr data-open-speaker="${esc(k.id)}">
              <td><strong>${esc(k.name)}</strong></td>
              <td>${esc(k.company)}</td>
              <td>${esc((k.topic || '').slice(0, 90))}${(k.topic || '').length > 90 ? '…' : ''}</td>
              <td class="con-note">${esc(SPEAKER_STATUS_LABELS[k.status] || k.status)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  body.querySelectorAll('[data-open-speaker]').forEach((el) => {
    el.addEventListener('click', () => { ctx.go('speakers'); speakerDrawer(el.dataset.openSpeaker); });
  });
}

function renderSignups(body) {
  const rows = state.responses.signups || [];
  if (!rows.length) {
    body.innerHTML = '<div class="con-empty"><h3>Nobody on the notify list yet</h3><p>Paste the sheet tab in with Import from the sheet.</p></div>';
    return;
  }
  body.innerHTML = `
    <div class="con-left">
      <div class="con-note" style="margin-bottom:8px">
        These people asked to be told about FOC27. They belong in MailMe's Flyover
        Con list as well; this is the record of who asked and when.
      </div>
      <table class="con-table">
        <thead><tr><th>Name</th><th>Email</th><th>Where</th><th>Asked</th></tr></thead>
        <tbody>
          ${rows.map((r) => {
            const a = r.answers || {};
            return `
            <tr>
              <td>${esc(a.name) || '<span style="opacity:.5">not given</span>'}</td>
              <td>${esc(a.email)}</td>
              <td>${esc(a.city_state) || '<span style="opacity:.5">not given</span>'}</td>
              <td class="con-note">${esc(prettyDate(r.submittedAt))}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

/** One person's whole survey, every question they answered, as they wrote it. */
function responseDrawer(id) {
  const rec = (state.responses.survey || []).find((r) => r.id === id);
  if (!rec) return;
  const a = rec.answers || {};

  const blocks = SURVEY_QUESTIONS
    .filter((q) => q.kind !== 'contact' && String(a[q.key] || '').trim())
    .map((q) => `
      <div class="con-sec">
        <h4>${esc(q.label)}</h4>
        <div style="font-size:13px;color:var(--ink);line-height:1.6">
          ${q.kind === 'multi'
            ? String(a[q.key]).split('|').map((x) => `<div>${esc(x.trim())}</div>`).join('')
            : esc(a[q.key])}
        </div>
      </div>`).join('');

  openDrawerHtml(
    responderName(rec),
    [responderShop(rec), a.city_state, prettyDate(rec.submittedAt)].filter(Boolean).join(' · '),
    `${a.email ? `<div class="con-note">${esc(a.email)}</div>` : ''}
     ${blocks}
     <div class="con-actions"><button class="con-btn ghost" data-close>Close</button></div>`
  );
}

/** Paste the sheet export. See the route for why this is not a file in the repo. */
function importDrawer() {
  openDrawerHtml('Import from the sheet', null, `
    <div class="con-sec">
      <div class="con-note" style="margin-bottom:10px">
        In the Google Sheet, File, Download, Comma separated values, then open
        the file and paste the whole thing here. Safe to paste the same export
        twice: a response already here is matched on email and time and skipped.
      </div>
      <div class="con-field">
        <label>Which tab</label>
        <select id="imp_kind">
          <option value="import-survey">Responses, the survey</option>
          <option value="import-signups">Notify, the mailing list</option>
        </select>
      </div>
      <div class="con-field">
        <label>Paste the CSV</label>
        <textarea id="imp_csv" style="min-height:220px;font-family:monospace;font-size:12px"></textarea>
      </div>
      <div id="impMsg"></div>
      <div class="con-actions">
        <button class="con-btn" id="impRun">Import</button>
        <button class="con-btn ghost" data-close>Close</button>
      </div>
    </div>`);

  drawerHost().querySelector('#impRun').addEventListener('click', async () => {
    const msg = ctx.root.querySelector('#impMsg');
    const csv = ctx.root.querySelector('#imp_csv').value;
    if (!csv.trim()) { msg.innerHTML = '<div class="con-err">Paste the CSV first.</div>'; return; }
    msg.innerHTML = '<div class="con-note">Working…</div>';
    try {
      const res = await ctx.api.post(ENDPOINTS.conResponses, {
        what: ctx.root.querySelector('#imp_kind').value,
        csv,
      });
      const bits = [`${res.created} added`];
      if (res.duplicate) bits.push(`${res.duplicate} already here`);
      if (res.empty) bits.push(`${res.empty} blank`);
      if (res.unusable) bits.push(`${res.unusable} with no usable email`);
      msg.innerHTML = `<div class="con-ok">${esc(bits.join(', '))}.${
        res.unknownColumns && res.unknownColumns.length
          ? ' Kept columns this app does not know about: ' + esc(res.unknownColumns.join(', ')) + '.'
          : ''}</div>`;
      state.loaded.responses = false;
      await loadResponses();
    } catch (e) {
      msg.innerHTML = `<div class="con-err">${esc(e.message || 'Import failed')}</div>`;
    }
  });
}

/* ------------------------------------------------------------------ *
 * DRAWERS
 *
 * One drawer per record type, and each does both jobs: a new record is an
 * empty one. Separate create and edit screens are how a field gets added to
 * one and forgotten on the other.
 * ------------------------------------------------------------------ */

function drawerHost() { return ctx.root.querySelector('#conDrawerHost'); }

function closeDrawer() { drawerHost().innerHTML = ''; }

function openDrawerHtml(title, subtitle, inner) {
  drawerHost().innerHTML = `
    <div class="con-scrim" data-close></div>
    <aside class="con-drawer" role="dialog">
      <button class="close" data-close aria-label="Close">&times;</button>
      <h2>${esc(title)}</h2>
      ${subtitle ? `<div class="con-note">${esc(subtitle)}</div>` : ''}
      <div id="conFormErr"></div>
      ${inner}
    </aside>`;
  drawerHost().querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeDrawer));
}

function formError(msg) {
  const host = ctx.root.querySelector('#conFormErr');
  if (host) host.innerHTML = msg ? `<div class="con-err">${esc(msg)}</div>` : '';
}

function val(id) {
  const el = ctx.root.querySelector('#' + id);
  return el ? el.value.trim() : '';
}

function trailHtml(record) {
  const rows = Array.isArray(record.history) ? record.history.slice().reverse() : [];
  if (!rows.length) return '';
  return `
    <div class="con-sec">
      <h4>What happened</h4>
      <div class="con-trail">
        ${rows.slice(0, 20).map((h) => `<div>${esc(prettyDate(h.at))} · ${esc(h.what)}${h.by ? ' · ' + esc(h.by) : ''}</div>`).join('')}
      </div>
    </div>`;
}

/* ---------------- sponsor drawer ---------------- */

function sponsorDrawer(id) {
  const s = id ? state.sponsors.find((x) => x.id === id) : null;
  const ro = !state.canEdit;
  const avail = tierAvailability(state.sponsors, state.settings.tiers);
  const tiers = (state.settings.tiers || []).map((t) => t.name);
  const tierNote = (name) => {
    const a = avail.find((x) => x.name === name);
    if (!a || a.slots === null) return '';
    if (a.oversold) return ' (oversold)';
    if (a.soldOut) return ' (sold out)';
    return ` (${a.left} left)`;
  };
  const m = s ? sponsorMoney(s) : null;
  const dStates = deliverableStates(s || {});
  const oStates = s ? obligationStates(s) : {};
  const owed = s ? obligationsFor(s.tier) : [];

  openDrawerHtml(
    s ? s.company : 'New sponsor',
    s ? `${s.id} · ${s.event || state.settings.event}` : state.settings.event,
    `
    <div class="con-sec">
      <h4>Who</h4>
      <div class="con-field"><label>Company</label><input id="f_company" value="${esc(s && s.company)}" ${ro ? 'disabled' : ''}></div>
      <div class="con-two">
        <div class="con-field"><label>Contact</label><input id="f_contactName" value="${esc(s && s.contactName)}" ${ro ? 'disabled' : ''}></div>
        <div class="con-field"><label>Phone</label><input id="f_phone" value="${esc(s && s.phone)}" ${ro ? 'disabled' : ''}></div>
      </div>
      <div class="con-field"><label>Email</label><input id="f_email" type="email" value="${esc(s && s.email)}" ${ro ? 'disabled' : ''}></div>
      <div class="con-field"><label>Website</label><input id="f_website" value="${esc(s && s.website)}" ${ro ? 'disabled' : ''}></div>
    </div>

    <div class="con-sec">
      <h4>The deal</h4>
      <div class="con-two">
        <div class="con-field"><label>Level</label>
          <select id="f_tier" ${ro ? 'disabled' : ''}>
            <option value="">Not set</option>
            ${tiers.map((t) => `<option value="${esc(t)}"${s && s.tier === t ? ' selected' : ''}>${esc(t + tierNote(t))}</option>`).join('')}
            ${s && s.tier && !tiers.includes(s.tier) ? `<option value="${esc(s.tier)}" selected>${esc(s.tier)}</option>` : ''}
          </select>
        </div>
        <div class="con-field"><label>Status</label>
          <select id="f_status" ${ro ? 'disabled' : ''}>
            ${STATUSES.map((k) => `<option value="${k}"${s && s.status === k ? ' selected' : ''}>${esc(STATUS_LABELS[k])}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="con-two">
        <div class="con-field"><label>Committed</label><input id="f_committed" inputmode="decimal" value="${s && s.committed !== null && s.committed !== undefined ? esc(s.committed) : ''}" placeholder="Blank if not agreed" ${ro ? 'disabled' : ''}></div>
        <div class="con-field"><label>Invoiced</label><input id="f_invoicedAmount" inputmode="decimal" value="${s && s.invoicedAmount !== null && s.invoicedAmount !== undefined ? esc(s.invoicedAmount) : ''}" ${ro ? 'disabled' : ''}></div>
      </div>
      <div class="con-two">
        <div class="con-field"><label>Invoice date</label><input id="f_invoicedAt" type="date" value="${esc(s && s.invoicedAt)}" ${ro ? 'disabled' : ''}></div>
        <div class="con-field"><label>QuickBooks number</label><input id="f_invoiceNumber" value="${esc(s && s.invoiceNumber)}" placeholder="The invoice stays in QB" ${ro ? 'disabled' : ''}></div>
      </div>
    </div>

    ${s ? `
    <div class="con-sec">
      <h4>Payments · ${usd(m.paid)} received${m.nonCash > 0 ? `, ${usd(m.cash)} of it cash` : ''}</h4>
      <div>
        ${(s.payments || []).length
          ? (s.payments || []).map((p, i) => `
              <div class="con-row">
                <span>${usd(p.amount)} · ${esc(PAYMENT_KIND_LABELS[p.kind] || PAYMENT_KIND_LABELS.cash)}${p.date ? ' · ' + esc(prettyDate(p.date)) : ''}</span>
                ${ro ? '' : `<button class="con-btn ghost" data-droppay="${i}">Remove</button>`}
              </div>`).join('')
          : '<div class="con-note">Nothing received yet.</div>'}
      </div>
      ${ro ? '' : `
      <div class="con-three" style="margin-top:10px">
        <div class="con-field"><label>Add payment</label><input id="p_amount" inputmode="decimal" placeholder="Amount"></div>
        <div class="con-field"><label>How</label>
          <select id="p_kind">
            ${PAYMENT_KINDS.map((k) => `<option value="${k}">${esc(PAYMENT_KIND_LABELS[k])}</option>`).join('')}
          </select>
        </div>
        <div class="con-field"><label>Date</label><input id="p_date" type="date"></div>
      </div>
      <button class="con-btn ghost" id="conAddPay">Record payment</button>
      <div class="con-note" style="margin-top:8px">A credit on our account with them, or something they provide directly, counts as paid and is kept out of the cash total. It is real money and it is not in the bank.</div>`}
    </div>

    <div class="con-sec">
      <h4>They owe us</h4>
      ${DELIVERABLES.map((d) => `
        <div class="con-row">
          <span title="${esc(d.hint)}">${esc(d.label)}</span>
          <span class="con-states" data-deliv="${d.key}">
            ${['open', 'done', 'na'].map((st) => `<button data-state="${st}" class="${dStates[d.key].state === st ? 'on' : ''}" ${ro ? 'disabled' : ''}>${st === 'na' ? 'N/A' : st === 'done' ? 'Done' : 'Open'}</button>`).join('')}
          </span>
        </div>`).join('')}
      <div class="con-note" style="margin-top:8px">N/A means they never owed it, and it is left out of their count rather than sitting open forever.</div>
    </div>

    <div class="con-sec">
      <h4>We owe them</h4>
      ${owed.length ? owed.map((o) => `
        <div class="con-row">
          <span>${esc(o.label)}</span>
          <span class="con-states" data-oblig="${o.key}">
            ${['open', 'done'].map((st) => `<button data-state="${st}" class="${(oStates[o.key] || {}).state === st ? 'on' : ''}" ${ro ? 'disabled' : ''}>${st === 'done' ? 'Done' : 'Open'}</button>`).join('')}
          </span>
        </div>`).join('')
        : '<div class="con-note">Set a level and this fills in with what that level promises them.</div>'}
      <div class="con-note" style="margin-top:8px">Taken from what the sponsor page promises at each level. A sponsor who paid and never got what they were sold is the expensive half of this list.</div>
    </div>

    <div class="con-sec">
      <h4>Moments claimed</h4>
      <div class="con-slots" data-moments>
        ${MOMENTS.map((mm) => {
          const held = Array.isArray(s.moments) && s.moments.includes(mm.key);
          return `<button class="con-slot${held ? '' : ' gone'}" data-moment="${mm.key}" ${ro ? 'disabled' : ''}>${held ? '\u2713 ' : ''}${esc(mm.label)}</button>`;
        }).join('')}
      </div>
      <div class="con-note" style="margin-top:8px">Each moment sells once. Claiming one another committed sponsor holds shows as a conflict on the board rather than quietly replacing them.</div>
    </div>` : ''}

    <div class="con-sec">
      <h4>Notes</h4>
      <div class="con-field"><textarea id="f_notes" ${ro ? 'disabled' : ''}>${esc(s && s.notes)}</textarea></div>
    </div>

    ${s ? trailHtml(s) : ''}

    <div class="con-actions">
      ${ro ? '<div class="con-note">Your account is read-only in ConControl.</div>' : `<button class="con-btn" id="conSave">${s ? 'Save' : 'Create sponsor'}</button>`}
      <button class="con-btn ghost" data-close>Close</button>
      ${s && state.canDelete ? '<button class="con-btn ghost" id="conDelete" style="margin-left:auto">Delete</button>' : ''}
    </div>`
  );

  const host = drawerHost();
  const save = host.querySelector('#conSave');
  if (save) save.addEventListener('click', () => submitSponsor(s));
  const del = host.querySelector('#conDelete');
  if (del) del.addEventListener('click', () => removeSponsor(s));
  const addPay = host.querySelector('#conAddPay');
  if (addPay) addPay.addEventListener('click', () => addPayment(s));

  host.querySelectorAll('[data-droppay]').forEach((el) => {
    el.addEventListener('click', () => dropPayment(s, Number(el.dataset.droppay)));
  });
  host.querySelectorAll('[data-moment]').forEach((btn) => {
    btn.addEventListener('click', () => toggleMoment(s, btn.dataset.moment));
  });
  host.querySelectorAll('[data-deliv] button').forEach((btn) => {
    btn.addEventListener('click', () => setDeliverable(s, btn.closest('[data-deliv]').dataset.deliv, btn.dataset.state));
  });
  host.querySelectorAll('[data-oblig] button').forEach((btn) => {
    btn.addEventListener('click', () => setObligation(s, btn.closest('[data-oblig]').dataset.oblig, btn.dataset.state));
  });
}

function readSponsorForm() {
  return {
    company: val('f_company'),
    contactName: val('f_contactName'),
    email: val('f_email'),
    phone: val('f_phone'),
    website: val('f_website'),
    tier: val('f_tier'),
    status: val('f_status'),
    committed: val('f_committed') === '' ? null : val('f_committed'),
    invoicedAmount: val('f_invoicedAmount') === '' ? null : val('f_invoicedAmount'),
    invoicedAt: val('f_invoicedAt') === '' ? null : val('f_invoicedAt'),
    invoiceNumber: val('f_invoiceNumber'),
    notes: val('f_notes'),
  };
}

async function submitSponsor(existing) {
  const body = readSponsorForm();
  if (!body.company) { formError('A sponsor needs a company name'); return; }
  formError('');
  try {
    if (existing) await ctx.api.patch(ENDPOINTS.conSponsors, { ...body, id: existing.id });
    else await ctx.api.post(ENDPOINTS.conSponsors, body);
    closeDrawer();
    await loadSponsors();
  } catch (e) {
    formError(e.message || 'Could not save');
  }
}

async function removeSponsor(s) {
  if (!s) return;
  if (!window.confirm(`Delete ${s.company}? This removes the record of what was agreed and paid.`)) return;
  try {
    await ctx.api.del(ENDPOINTS.conSponsors, { query: { id: s.id } });
    closeDrawer();
    await loadSponsors();
  } catch (e) {
    formError(e.message || 'Could not delete');
  }
}

async function addPayment(s) {
  const amount = val('p_amount');
  const date = val('p_date');
  if (!amount) { formError('A payment needs an amount'); return; }
  formError('');
  await patchSponsor(s, { payments: (s.payments || []).concat([{ amount, kind: val('p_kind') || 'cash', date: date || null }]) });
}

async function dropPayment(s, index) {
  await patchSponsor(s, { payments: (s.payments || []).filter((_, i) => i !== index) });
}

async function toggleMoment(s, key) {
  const held = Array.isArray(s.moments) ? s.moments.slice() : [];
  const i = held.indexOf(key);
  if (i >= 0) held.splice(i, 1); else held.push(key);
  await patchSponsor(s, { moments: held });
}

async function setDeliverable(s, key, next) {
  const current = deliverableStates(s);
  const deliverables = {};
  for (const k of DELIVERABLE_KEYS) deliverables[k] = { ...current[k] };
  deliverables[key] = {
    state: next,
    // Stamped only when it is actually done. A date on an open row is a date
    // for nothing, and a date on an N/A row reads as a completion.
    at: next === 'done' ? new Date().toISOString().slice(0, 10) : null,
    by: next === 'done' ? (ctx.user && (ctx.user.name || ctx.user.username)) || null : null,
    note: current[key].note,
  };
  await patchSponsor(s, { deliverables });
}

async function setObligation(s, key, next) {
  const current = obligationStates(s);
  const obligations = {};
  for (const k of Object.keys(current)) obligations[k] = { state: current[k].state, at: current[k].at, by: current[k].by };
  obligations[key] = {
    state: next,
    at: next === 'done' ? new Date().toISOString().slice(0, 10) : null,
    by: next === 'done' ? (ctx.user && (ctx.user.name || ctx.user.username)) || null : null,
  };
  await patchSponsor(s, { obligations });
}

/**
 * Save one field and redraw the drawer in place. Reloading the whole list here
 * would close and reopen the drawer under the cursor, which is what made
 * ticking four things in a row unpleasant.
 */
async function patchSponsor(s, body) {
  try {
    const res = await ctx.api.patch(ENDPOINTS.conSponsors, { id: s.id, ...body });
    const saved = res && res.sponsor;
    if (!saved) { await loadSponsors(); return; }
    const i = state.sponsors.findIndex((x) => x.id === saved.id);
    if (i >= 0) state.sponsors[i] = saved; else state.sponsors.unshift(saved);
    renderSponsors();
    renderHome();
    sponsorDrawer(saved.id);
  } catch (e) {
    formError(e.message || 'Could not update that');
  }
}

/* ---------------- ledger drawer ---------------- */

function entryDrawer(id) {
  const e = id ? state.entries.find((x) => x.id === id) : null;
  const ro = !state.canEdit;
  const cats = state.settings.categories || [];

  openDrawerHtml(e ? e.description || 'Entry' : 'New entry', e ? e.id : null, `
    <div class="con-sec">
      <div class="con-field"><label>Description</label><input id="e_description" value="${esc(e && e.description)}" ${ro ? 'disabled' : ''}></div>
      <div class="con-three">
        <div class="con-field"><label>Kind</label>
          <select id="e_kind" ${ro ? 'disabled' : ''}>
            ${ENTRY_KINDS.map((k) => `<option value="${k}"${e && e.kind === k ? ' selected' : ''}>${k === 'income' ? 'Income' : 'Spend'}</option>`).join('')}
          </select>
        </div>
        <div class="con-field"><label>State</label>
          <select id="e_state" ${ro ? 'disabled' : ''}>
            ${ENTRY_STATES.map((k) => `<option value="${k}"${e && e.state === k ? ' selected' : ''}>${esc(ENTRY_STATE_LABELS[k])}</option>`).join('')}
          </select>
        </div>
        <div class="con-field"><label>Amount</label><input id="e_amount" inputmode="decimal" value="${e && e.amount !== null && e.amount !== undefined ? esc(e.amount) : ''}" ${ro ? 'disabled' : ''}></div>
      </div>
      <div class="con-two">
        <div class="con-field"><label>Category</label>
          <select id="e_category" ${ro ? 'disabled' : ''}>
            <option value="">Not set</option>
            ${cats.map((c) => `<option value="${esc(c)}"${e && e.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div class="con-field"><label>Date</label><input id="e_date" type="date" value="${esc(e && e.date)}" ${ro ? 'disabled' : ''}></div>
      </div>
      <div class="con-two">
        <div class="con-field"><label>Vendor</label><input id="e_vendor" value="${esc(e && e.vendor)}" ${ro ? 'disabled' : ''}></div>
        <div class="con-field"><label>Invoice number</label><input id="e_invoiceNumber" value="${esc(e && e.invoiceNumber)}" ${ro ? 'disabled' : ''}></div>
      </div>
      <div class="con-field"><label>Notes</label><textarea id="e_notes" ${ro ? 'disabled' : ''}>${esc(e && e.notes)}</textarea></div>
      <div class="con-note">An estimate is a guess, committed is money promised, paid is money gone. They are counted apart because "we have spent this" and "we are on the hook for this" are different sentences.</div>
    </div>

    ${e ? trailHtml(e) : ''}

    <div class="con-actions">
      ${ro ? '' : `<button class="con-btn" id="conSaveEntry">${e ? 'Save' : 'Add entry'}</button>`}
      <button class="con-btn ghost" data-close>Close</button>
      ${e && state.canDelete ? '<button class="con-btn ghost" id="conDeleteEntry" style="margin-left:auto">Delete</button>' : ''}
    </div>`);

  const host = drawerHost();
  const save = host.querySelector('#conSaveEntry');
  if (save) save.addEventListener('click', async () => {
    const body = {
      description: val('e_description'), kind: val('e_kind'), state: val('e_state'),
      amount: val('e_amount') === '' ? null : val('e_amount'),
      category: val('e_category'), date: val('e_date') === '' ? null : val('e_date'),
      vendor: val('e_vendor'), invoiceNumber: val('e_invoiceNumber'), notes: val('e_notes'),
    };
    if (!body.description) { formError('An entry needs a description'); return; }
    try {
      if (e) await ctx.api.patch(ENDPOINTS.conLedger, { ...body, id: e.id });
      else await ctx.api.post(ENDPOINTS.conLedger, body);
      closeDrawer();
      await loadMoney();
    } catch (err) {
      formError(err.message || 'Could not save');
    }
  });

  const del = host.querySelector('#conDeleteEntry');
  if (del) del.addEventListener('click', async () => {
    if (!window.confirm('Delete this entry?')) return;
    try {
      await ctx.api.del(ENDPOINTS.conLedger, { query: { id: e.id } });
      closeDrawer();
      await loadMoney();
    } catch (err) { formError(err.message || 'Could not delete'); }
  });
}

/* ---------------- session drawer ---------------- */

function sessionDrawer(id) {
  const s = id ? state.sessions.find((x) => x.id === id) : null;
  const ro = !state.canEdit;

  openDrawerHtml(s ? s.title || 'Session' : 'New session', s ? s.id : null, `
    <div class="con-sec">
      <div class="con-field"><label>Title</label><input id="s_title" value="${esc(s && s.title)}" ${ro ? 'disabled' : ''}></div>
      <div class="con-field"><label>Blurb, as it would read on the agenda</label><textarea id="s_blurb" ${ro ? 'disabled' : ''}>${esc(s && s.blurb)}</textarea></div>
      <div class="con-three">
        <div class="con-field"><label>Day</label><input id="s_day" type="number" min="1" max="2" value="${esc((s && s.day) || 1)}" ${ro ? 'disabled' : ''}></div>
        <div class="con-field"><label>Start</label><input id="s_start" type="time" value="${esc(s && s.start)}" ${ro ? 'disabled' : ''}></div>
        <div class="con-field"><label>Minutes</label><input id="s_minutes" type="number" min="5" value="${esc((s && s.minutes) || 60)}" ${ro ? 'disabled' : ''}></div>
      </div>
      <div class="con-three">
        <div class="con-field"><label>Track</label>
          <select id="s_track" ${ro ? 'disabled' : ''}>
            ${TRACKS.map((t) => `<option value="${t.key}"${s && s.track === t.key ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>
        </div>
        <div class="con-field"><label>Format</label>
          <select id="s_format" ${ro ? 'disabled' : ''}>
            ${FORMATS.map((f) => `<option value="${f}"${s && s.format === f ? ' selected' : ''}>${esc(f)}</option>`).join('')}
          </select>
        </div>
        <div class="con-field"><label>Status</label>
          <select id="s_status" ${ro ? 'disabled' : ''}>
            ${SESSION_STATUSES.map((k) => `<option value="${k}"${s && s.status === k ? ' selected' : ''}>${esc(SESSION_STATUS_LABELS[k])}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="con-note">Only confirmed sessions with a day and a time reach the public agenda. Everything else is a plan.</div>
    </div>

    <div class="con-sec">
      <h4>Speakers</h4>
      ${state.speakers.length ? state.speakers.map((k) => `
        <div class="con-row">
          <span>${esc(k.name)}${k.company ? ' · ' + esc(k.company) : ''}</span>
          <span class="con-states">
            <button data-speaker="${esc(k.id)}" class="${s && (s.speakerIds || []).includes(k.id) ? 'on' : ''}" ${ro || !s ? 'disabled' : ''}>${s && (s.speakerIds || []).includes(k.id) ? 'On it' : 'Add'}</button>
          </span>
        </div>`).join('')
        : '<div class="con-note">No speakers yet. Add them on the Speakers screen first.</div>'}
      ${s ? '' : '<div class="con-note" style="margin-top:8px">Create the session first, then put speakers on it.</div>'}
    </div>

    <div class="con-sec">
      <h4>Sponsored slot</h4>
      <div class="con-field">
        <select id="s_sponsorId" ${ro ? 'disabled' : ''}>
          <option value="">Not sponsored</option>
          ${state.sponsors.filter((x) => x.status === 'committed').map((x) => `<option value="${esc(x.id)}"${s && s.sponsorId === x.id ? ' selected' : ''}>${esc(x.company)}</option>`).join('')}
        </select>
      </div>
      <div class="con-field"><label>Equipment needed</label><input id="s_equipment" value="${esc(s && s.equipment)}" ${ro ? 'disabled' : ''}></div>
      <div class="con-field"><label>Notes</label><textarea id="s_notes" ${ro ? 'disabled' : ''}>${esc(s && s.notes)}</textarea></div>
    </div>

    ${s ? trailHtml(s) : ''}

    <div class="con-actions">
      ${ro ? '' : `<button class="con-btn" id="conSaveSession">${s ? 'Save' : 'Create session'}</button>`}
      <button class="con-btn ghost" data-close>Close</button>
      ${s && state.canDelete ? '<button class="con-btn ghost" id="conDeleteSession" style="margin-left:auto">Delete</button>' : ''}
    </div>`);

  const host = drawerHost();

  host.querySelectorAll('[data-speaker]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ids = (s.speakerIds || []).slice();
      const key = btn.dataset.speaker;
      const i = ids.indexOf(key);
      if (i >= 0) ids.splice(i, 1); else ids.push(key);
      try {
        await ctx.api.patch(ENDPOINTS.conSessions, { id: s.id, speakerIds: ids });
        await loadProgram();
        sessionDrawer(s.id);
      } catch (e) { formError(e.message || 'Could not update'); }
    });
  });

  const save = host.querySelector('#conSaveSession');
  if (save) save.addEventListener('click', async () => {
    const body = {
      title: val('s_title'), blurb: val('s_blurb'),
      day: Number(val('s_day')) || 1, start: val('s_start'),
      minutes: Number(val('s_minutes')) || 60,
      track: val('s_track'), format: val('s_format'), status: val('s_status'),
      sponsorId: val('s_sponsorId') || null,
      equipment: val('s_equipment'), notes: val('s_notes'),
    };
    if (!body.title) { formError('A session needs a title'); return; }
    try {
      if (s) await ctx.api.patch(ENDPOINTS.conSessions, { ...body, id: s.id });
      else await ctx.api.post(ENDPOINTS.conSessions, body);
      closeDrawer();
      await loadProgram();
    } catch (e) { formError(e.message || 'Could not save'); }
  });

  const del = host.querySelector('#conDeleteSession');
  if (del) del.addEventListener('click', async () => {
    if (!window.confirm(`Delete "${s.title}"?`)) return;
    try {
      await ctx.api.del(ENDPOINTS.conSessions, { query: { id: s.id } });
      closeDrawer();
      await loadProgram();
    } catch (e) { formError(e.message || 'Could not delete'); }
  });
}

/* ---------------- speaker drawer ---------------- */

function speakerDrawer(id) {
  const k = id ? state.speakers.find((x) => x.id === id) : null;
  const ro = !state.canEdit;
  const mStates = materialStates(k || {});
  const theirSessions = k ? state.sessions.filter((s) => (s.speakerIds || []).includes(k.id)) : [];

  openDrawerHtml(k ? k.name : 'New speaker', k ? `${k.id} · ${k.source === 'speak-form' ? 'from the call for speakers' : 'added here'}` : null, `
    <div class="con-sec">
      <div class="con-two">
        <div class="con-field"><label>Name</label><input id="k_name" value="${esc(k && k.name)}" ${ro ? 'disabled' : ''}></div>
        <div class="con-field"><label>Company</label><input id="k_company" value="${esc(k && k.company)}" ${ro ? 'disabled' : ''}></div>
      </div>
      <div class="con-two">
        <div class="con-field"><label>Email</label><input id="k_email" type="email" value="${esc(k && k.email)}" ${ro ? 'disabled' : ''}></div>
        <div class="con-field"><label>Phone</label><input id="k_phone" value="${esc(k && k.phone)}" ${ro ? 'disabled' : ''}></div>
      </div>
      <div class="con-field"><label>Status</label>
        <select id="k_status" ${ro ? 'disabled' : ''}>
          ${SPEAKER_STATUSES.map((st) => `<option value="${st}"${k && k.status === st ? ' selected' : ''}>${esc(SPEAKER_STATUS_LABELS[st])}</option>`).join('')}
        </select>
      </div>
      <div class="con-field"><label>What they want to teach</label><textarea id="k_topic" ${ro ? 'disabled' : ''}>${esc(k && k.topic)}</textarea></div>
      <div class="con-field"><label>Bio, as it would print</label><textarea id="k_bio" ${ro ? 'disabled' : ''}>${esc(k && k.bio)}</textarea></div>
      <div class="con-field"><label>Headshot link</label><input id="k_headshot" value="${esc(k && k.headshot)}" ${ro ? 'disabled' : ''}></div>
      <div class="con-field"><label>Travel and lodging</label><textarea id="k_travelNotes" ${ro ? 'disabled' : ''}>${esc(k && k.travelNotes)}</textarea></div>
    </div>

    ${k ? `
    <div class="con-sec">
      <h4>What they still owe us</h4>
      ${SPEAKER_MATERIALS.map((m) => `
        <div class="con-row">
          <span>${esc(m.label)}</span>
          <span class="con-states" data-material="${m.key}">
            ${['open', 'done', 'na'].map((st) => `<button data-state="${st}" class="${mStates[m.key].state === st ? 'on' : ''}" ${ro ? 'disabled' : ''}>${st === 'na' ? 'N/A' : st === 'done' ? 'Done' : 'Open'}</button>`).join('')}
          </span>
        </div>`).join('')}
      <div class="con-note" style="margin-top:8px">Only confirmed speakers get chased. Asking somebody for a headshot before they have said yes is how a proposal turns into a no.</div>
    </div>

    ${theirSessions.length ? `
    <div class="con-sec">
      <h4>Their sessions</h4>
      ${theirSessions.map((s) => `<div class="con-row"><span>${esc(s.title)}</span><span class="con-note">Day ${esc(s.day)} ${esc(clock(s.start))}</span></div>`).join('')}
    </div>` : ''}

    <div class="con-sec">
      <h4>Notes</h4>
      <div class="con-field"><textarea id="k_notes" ${ro ? 'disabled' : ''}>${esc(k && k.notes)}</textarea></div>
    </div>

    ${trailHtml(k)}` : ''}

    <div class="con-actions">
      ${ro ? '' : `<button class="con-btn" id="conSaveSpeaker">${k ? 'Save' : 'Add speaker'}</button>`}
      <button class="con-btn ghost" data-close>Close</button>
      ${k && state.canDelete ? '<button class="con-btn ghost" id="conDeleteSpeaker" style="margin-left:auto">Delete</button>' : ''}
    </div>`);

  const host = drawerHost();

  host.querySelectorAll('[data-material] button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.closest('[data-material]').dataset.material;
      const current = materialStates(k);
      const materials = {};
      for (const mk of Object.keys(current)) materials[mk] = { state: current[mk].state, at: current[mk].at, by: current[mk].by };
      materials[key] = {
        state: btn.dataset.state,
        at: btn.dataset.state === 'done' ? new Date().toISOString().slice(0, 10) : null,
        by: btn.dataset.state === 'done' ? (ctx.user && (ctx.user.name || ctx.user.username)) || null : null,
      };
      try {
        await ctx.api.patch(ENDPOINTS.conSpeakers, { id: k.id, materials });
        await loadProgram();
        speakerDrawer(k.id);
      } catch (e) { formError(e.message || 'Could not update'); }
    });
  });

  const save = host.querySelector('#conSaveSpeaker');
  if (save) save.addEventListener('click', async () => {
    const body = {
      name: val('k_name'), company: val('k_company'), email: val('k_email'),
      phone: val('k_phone'), status: val('k_status'), topic: val('k_topic'),
      bio: val('k_bio'), headshot: val('k_headshot'),
      travelNotes: val('k_travelNotes'), notes: val('k_notes'),
    };
    if (!body.name) { formError('A speaker needs a name'); return; }
    try {
      if (k) await ctx.api.patch(ENDPOINTS.conSpeakers, { ...body, id: k.id });
      else await ctx.api.post(ENDPOINTS.conSpeakers, body);
      closeDrawer();
      await loadProgram();
    } catch (e) { formError(e.message || 'Could not save'); }
  });

  const del = host.querySelector('#conDeleteSpeaker');
  if (del) del.addEventListener('click', async () => {
    if (!window.confirm(`Delete ${k.name}? A proposal you passed on is next year's list.`)) return;
    try {
      await ctx.api.del(ENDPOINTS.conSpeakers, { query: { id: k.id } });
      closeDrawer();
      await loadProgram();
    } catch (e) { formError(e.message || 'Could not delete'); }
  });
}
