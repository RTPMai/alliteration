/**
 * ConControl — the event, tracked in one place.
 *
 * Flyover Con is the first event through it. Sponsors is the first screen,
 * because it is the one with no missing pieces: we know who they are, what
 * they owe, and what they still have to send us. Money, Sessions and Speakers
 * follow, and they are deliberately NOT listed in the registry until they are
 * real. A tab that opens onto "coming soon" is a tab people stop clicking.
 *
 * WHAT THIS REPLACES. A spreadsheet that held the money fine and could not
 * hold the deliverables at all: a blank cell meant "not yet" or "never owed
 * one" and only the person who typed it knew which. Every deliverable here is
 * open, done, or N/A, and N/A is a decision somebody made.
 *
 * All money and health math lives in lib/concontrol/schema.js, which the
 * server route imports too. Same pattern as poHealth() in PromoPro: one
 * function, so a figure on this screen and a figure in an export cannot
 * disagree.
 *
 * The seam: no fetch() in here. ctx.api.get/post/patch/del with ENDPOINTS.*.
 */

import { ENDPOINTS } from '../js/api.js';
import {
  STATUSES, STATUS_LABELS, DELIVERABLES, DELIVERABLE_KEYS, MOMENTS,
  sponsorMoney, deliverableStates, deliverableProgress, sponsorHealth, rollup,
  tierAvailability, momentAvailability,
} from '../lib/concontrol/schema.js';

let ctx = null;
let state = {
  sponsors: [],
  settings: { event: 'FOC27', tiers: [] },
  canEdit: false,
  canDelete: false,
  filter: 'all',
  search: '',
  openId: null,
  loading: true,
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
  const d = new Date(iso + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/* ------------------------------------------------------------------ *
 * APP
 * ------------------------------------------------------------------ */

export default {
  id: 'concontrol',

  styles: `
    .con-wrap { padding: 18px 20px 60px; }

    /* Totals strip */
    .con-totals { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-bottom: 18px; }
    .con-tot { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; }
    .con-tot .k { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; }
    .con-tot .v { font-size: 22px; font-weight: 700; color: var(--ink); margin-top: 4px; line-height: 1.1; }
    .con-tot .sub { font-size: 12px; color: var(--muted); margin-top: 3px; }
    .con-tot.warn .v { color: var(--danger); }

    /* What is left to sell */
    .con-left { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; margin-bottom: 18px; }
    .con-left h4 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
    .con-slots { display: flex; flex-wrap: wrap; gap: 6px; }
    .con-slot { font-size: 12px; padding: 4px 10px; border-radius: var(--radius-pill); border: 1px solid var(--line); color: var(--ink); }
    .con-slot b { font-weight: 700; }
    .con-slot.gone { color: var(--muted); border-style: dashed; }
    .con-slot.bad { color: var(--danger); border-color: var(--danger); font-weight: 600; }

    /* Controls */
    .con-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
    .con-bar input[type="search"] { flex: 1 1 200px; min-width: 160px; padding: 7px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--card); color: var(--ink); font-size: 13px; }
    .con-chip { padding: 5px 11px; border: 1px solid var(--line); border-radius: var(--radius-pill); background: var(--card); color: var(--muted); font-size: 12px; font-weight: 600; cursor: pointer; }
    .con-chip.on { background: var(--accent-tint); border-color: var(--accent); color: var(--accent-deep); }
    .con-btn { padding: 7px 13px; border: 0; border-radius: var(--radius-sm); background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 600; cursor: pointer; }
    .con-btn.ghost { background: transparent; border: 1px solid var(--line); color: var(--ink); }
    .con-btn[disabled] { opacity: .5; cursor: default; }

    /* Sponsor cards */
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

    .con-empty { padding: 44px 20px; text-align: center; color: var(--muted); }
    .con-empty h3 { color: var(--ink); font-size: 16px; margin: 0 0 6px; }

    /* Detail drawer */
    .con-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.38); z-index: 60; }
    .con-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 100%); background: var(--card); border-left: 1px solid var(--line); z-index: 61; overflow-y: auto; padding: 18px 20px 60px; }
    .con-drawer h2 { margin: 0 0 2px; font-size: 18px; color: var(--ink); }
    .con-drawer .close { position: absolute; top: 12px; right: 14px; background: none; border: 0; font-size: 22px; line-height: 1; color: var(--muted); cursor: pointer; }
    .con-sec { margin-top: 20px; }
    .con-sec > h4 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
    .con-field { margin-bottom: 10px; }
    .con-field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; font-weight: 600; }
    .con-field input, .con-field select, .con-field textarea { width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg, var(--card)); color: var(--ink); font: inherit; font-size: 13px; }
    .con-field textarea { min-height: 76px; resize: vertical; }
    .con-two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .con-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--ink); }
    .con-row:last-child { border-bottom: 0; }
    .con-states { display: flex; gap: 4px; }
    .con-states button { font-size: 11px; padding: 3px 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: var(--radius-pill); cursor: pointer; font-weight: 600; }
    .con-states button.on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
    .con-actions { display: flex; gap: 8px; margin-top: 22px; flex-wrap: wrap; }
    .con-err { background: var(--accent-tint); color: var(--danger); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; margin-bottom: 10px; }
    .con-note { font-size: 12px; color: var(--muted); line-height: 1.5; }
  `,

  template: `
    <div class="con-wrap">
      <div id="conTotals" class="con-totals"></div>
      <div id="conLeft"></div>
      <div class="con-bar">
        <input type="search" id="conSearch" placeholder="Search company or contact" autocomplete="off">
        <span id="conChips"></span>
        <button class="con-btn" id="conNew">Add sponsor</button>
      </div>
      <div id="conBody"></div>
    </div>
    <div id="conDrawerHost"></div>
  `,

  async mount(c) {
    ctx = c;
    const root = ctx.root;

    root.querySelector('#conSearch').addEventListener('input', (e) => {
      state.search = e.target.value.toLowerCase();
      renderList();
    });

    root.querySelector('#conNew').addEventListener('click', () => openDrawer(null));

    root.querySelector('#conChips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-filter]');
      if (!chip) return;
      state.filter = chip.dataset.filter;
      renderChips();
      renderList();
    });

    renderChips();
    await load();
  },

  showView() {
    // One view for now. Money, Sessions and Speakers land here as they are
    // built, and the registry gains a tab each time.
  },
};

/* ------------------------------------------------------------------ *
 * DATA
 * ------------------------------------------------------------------ */

async function load() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const data = await ctx.api.get(ENDPOINTS.conSponsors);
    state.sponsors = Array.isArray(data.sponsors) ? data.sponsors : [];
    state.settings = data.settings || state.settings;
    state.canEdit = !!data.canEdit;
    state.canDelete = !!data.canDelete;
  } catch (e) {
    state.error = e.message || 'Could not load sponsors';
  }
  state.loading = false;
  render();
}

/* ------------------------------------------------------------------ *
 * RENDER
 * ------------------------------------------------------------------ */

function render() {
  renderTotals();
  renderInventory();
  renderList();
  ctx.root.querySelector('#conNew').disabled = !state.canEdit;
}

function renderChips() {
  const opts = [['all', 'All']].concat(STATUSES.map((s) => [s, STATUS_LABELS[s]]));
  ctx.root.querySelector('#conChips').innerHTML = opts
    .map(([k, label]) => `<button class="con-chip${state.filter === k ? ' on' : ''}" data-filter="${k}">${esc(label)}</button>`)
    .join(' ');
}

function renderTotals() {
  const host = ctx.root.querySelector('#conTotals');
  const t = rollup(state.sponsors);

  const cards = [
    { k: 'Committed', v: usd(t.committed), sub: t.unpriced ? `${t.unpriced} with no amount agreed` : `${t.sponsorCount} sponsors` },
    { k: 'Collected', v: usd(t.collected), sub: t.committed > 0 ? Math.round((t.collected / t.committed) * 100) + '% of committed' : '' },
    { k: 'Outstanding', v: usd(t.outstanding), sub: t.unpriced ? 'Excludes the unpriced' : '' },
    { k: 'Needs a nudge', v: String(t.blocked), sub: 'Sponsors waiting on us', warn: t.blocked > 0 },
    { k: 'Deliverables open', v: String(t.deliverablesOpen), sub: 'Logos, swag, posts, sessions' },
  ];

  host.innerHTML = cards.map((c) => `
    <div class="con-tot${c.warn ? ' warn' : ''}">
      <div class="k">${esc(c.k)}</div>
      <div class="v">${esc(c.v)}</div>
      ${c.sub ? `<div class="sub">${esc(c.sub)}</div>` : ''}
    </div>
  `).join('');
}

/**
 * What is still sellable, and who has which moment.
 *
 * Computed from the same records rather than read off the website, because the
 * website prints "3 available" as a static number and has no way to know that
 * two of them are gone.
 */
function renderInventory() {
  const host = ctx.root.querySelector('#conLeft');
  const tiers = tierAvailability(state.sponsors, state.settings.tiers);
  const moments = momentAvailability(state.sponsors);

  const capped = tiers.filter((t) => t.slots !== null);
  const slotChips = capped.map((t) => {
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

  host.innerHTML = `
    <div class="con-left">
      <h4>Still open</h4>
      <div class="con-slots">${slotChips.concat(momentChips).join('')}</div>
    </div>`;
}

function visible() {
  return state.sponsors.filter((s) => {
    if (state.filter !== 'all' && s.status !== state.filter) return false;
    if (!state.search) return true;
    const hay = `${s.company} ${s.contactName} ${s.email} ${s.tier}`.toLowerCase();
    return hay.includes(state.search);
  });
}

function renderList() {
  const host = ctx.root.querySelector('#conBody');

  if (state.loading) { host.innerHTML = '<div class="con-empty">Loading sponsors…</div>'; return; }
  if (state.error) { host.innerHTML = `<div class="con-err">${esc(state.error)}</div>`; return; }

  const rows = visible();
  if (!rows.length) {
    host.innerHTML = state.sponsors.length
      ? '<div class="con-empty"><h3>Nothing matches</h3><p>Try a different filter.</p></div>'
      : `<div class="con-empty"><h3>No sponsors yet</h3><p>Add the first one, or wait for an inquiry to come in from the sponsor page.</p></div>`;
    return;
  }

  host.innerHTML = `<div class="con-grid">${rows.map(card).join('')}</div>`;
  host.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => openDrawer(el.dataset.open));
  });
}

function card(s) {
  const m = sponsorMoney(s);
  const h = sponsorHealth(s);
  const p = deliverableProgress(s);
  const states = deliverableStates(s);
  const pct = m.committedKnown && m.committed > 0
    ? Math.min(100, Math.round((m.paid / m.committed) * 100))
    : 0;

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
        <span class="muted">${m.committedKnown && m.outstanding > 0 ? usd(m.outstanding) + ' out' : ''}</span>
      </div>
      <div class="con-meter"><i style="width:${pct}%"></i></div>

      <div class="con-why ${esc(h.level)}">
        <span class="con-dot ${esc(h.level)}"></span>${esc(h.why)}
      </div>

      <div class="con-deliv">
        ${DELIVERABLES.map((d) => {
          const st = states[d.key].state;
          return `<span class="con-pip ${esc(st)}">${esc(d.label.replace(' received', '').replace(' scheduled', '').replace(' posted', ''))}</span>`;
        }).join('')}
        ${p.owed ? `<span class="con-pip">${p.done}/${p.owed}</span>` : ''}
      </div>
    </button>
  `;
}

/* ------------------------------------------------------------------ *
 * DRAWER
 *
 * One drawer does both jobs: a new sponsor is an empty one. Two near
 * identical screens for create and edit is how a field gets added to one and
 * forgotten on the other.
 * ------------------------------------------------------------------ */

function openDrawer(id) {
  state.openId = id;
  const s = id ? state.sponsors.find((x) => x.id === id) : null;
  const host = ctx.root.querySelector('#conDrawerHost');
  const ro = !state.canEdit;

  // The dropdown says what is left next to each level, so the sold-out answer
  // is in front of you at the moment you are about to sell one.
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
  const states = deliverableStates(s || {});

  host.innerHTML = `
    <div class="con-scrim" data-close></div>
    <aside class="con-drawer" role="dialog" aria-label="Sponsor">
      <button class="close" data-close aria-label="Close">&times;</button>
      <h2>${s ? esc(s.company) : 'New sponsor'}</h2>
      <div class="con-note">${s ? esc(s.id) + ' · ' + esc(s.event || state.settings.event) : esc(state.settings.event)}</div>
      <div id="conFormErr"></div>

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
          <div class="con-field">
            <label>Tier</label>
            <select id="f_tier" ${ro ? 'disabled' : ''}>
              <option value="">Not set</option>
              ${tiers.map((t) => `<option value="${esc(t)}"${s && s.tier === t ? ' selected' : ''}>${esc(t + tierNote(t))}</option>`).join('')}
              ${s && s.tier && !tiers.includes(s.tier) ? `<option value="${esc(s.tier)}" selected>${esc(s.tier)}</option>` : ''}
            </select>
          </div>
          <div class="con-field">
            <label>Status</label>
            <select id="f_status" ${ro ? 'disabled' : ''}>
              ${STATUSES.map((k) => `<option value="${k}"${s && s.status === k ? ' selected' : ''}>${esc(STATUS_LABELS[k])}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="con-two">
          <div class="con-field"><label>Committed</label><input id="f_committed" inputmode="decimal" value="${s && s.committed !== null && s.committed !== undefined ? esc(s.committed) : ''}" placeholder="Leave blank if not agreed" ${ro ? 'disabled' : ''}></div>
          <div class="con-field"><label>Invoiced</label><input id="f_invoicedAmount" inputmode="decimal" value="${s && s.invoicedAmount !== null && s.invoicedAmount !== undefined ? esc(s.invoicedAmount) : ''}" ${ro ? 'disabled' : ''}></div>
        </div>
        <div class="con-field"><label>Invoice date</label><input id="f_invoicedAt" type="date" value="${esc(s && s.invoicedAt)}" ${ro ? 'disabled' : ''}></div>
      </div>

      ${s ? `
      <div class="con-sec">
        <h4>Payments · ${usd(m.paid)} received</h4>
        <div id="conPayments">
          ${(s.payments || []).length
            ? (s.payments || []).map((p, i) => `
                <div class="con-row">
                  <span>${usd(p.amount)}${p.date ? ' · ' + esc(prettyDate(p.date)) : ''}${p.method ? ' · ' + esc(p.method) : ''}</span>
                  ${ro ? '' : `<button class="con-btn ghost" data-droppay="${i}">Remove</button>`}
                </div>`).join('')
            : '<div class="con-note">Nothing received yet.</div>'}
        </div>
        ${ro ? '' : `
        <div class="con-two" style="margin-top:10px">
          <div class="con-field"><label>Add payment</label><input id="p_amount" inputmode="decimal" placeholder="Amount"></div>
          <div class="con-field"><label>Date</label><input id="p_date" type="date"></div>
        </div>
        <button class="con-btn ghost" id="conAddPay">Record payment</button>`}
      </div>

      <div class="con-sec">
        <h4>Deliverables</h4>
        ${DELIVERABLES.map((d) => `
          <div class="con-row">
            <span title="${esc(d.hint)}">${esc(d.label)}</span>
            <span class="con-states" data-deliv="${d.key}">
              ${['open', 'done', 'na'].map((st) => `
                <button data-state="${st}" class="${states[d.key].state === st ? 'on' : ''}" ${ro ? 'disabled' : ''}>${st === 'na' ? 'N/A' : st === 'done' ? 'Done' : 'Open'}</button>
              `).join('')}
            </span>
          </div>`).join('')}
        <div class="con-note" style="margin-top:8px">N/A means this sponsor never owed it. It is left out of their count rather than sitting open forever.</div>
      </div>

      <div class="con-sec">
        <h4>Moments claimed</h4>
        <div class="con-slots" data-moments>
          ${MOMENTS.map((mm) => {
            const held = Array.isArray(s.moments) && s.moments.includes(mm.key);
            return `<button class="con-slot${held ? '' : ' gone'}" data-moment="${mm.key}" ${ro ? 'disabled' : ''}>${held ? '\u2713 ' : ''}${esc(mm.label)}</button>`;
          }).join('')}
        </div>
        <div class="con-note" style="margin-top:8px">Each moment can only be sold once. Claiming one already held by another committed sponsor shows as a conflict on the board rather than quietly replacing them.</div>
      </div>` : ''}

      <div class="con-sec">
        <h4>Notes</h4>
        <div class="con-field"><textarea id="f_notes" ${ro ? 'disabled' : ''}>${esc(s && s.notes)}</textarea></div>
      </div>

      <div class="con-actions">
        ${ro ? '<div class="con-note">Your account is read-only in ConControl.</div>' : `<button class="con-btn" id="conSave">${s ? 'Save' : 'Create sponsor'}</button>`}
        <button class="con-btn ghost" data-close>Close</button>
        ${s && state.canDelete ? '<button class="con-btn ghost" id="conDelete" style="margin-left:auto">Delete</button>' : ''}
      </div>
    </aside>
  `;

  host.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeDrawer));

  const save = host.querySelector('#conSave');
  if (save) save.addEventListener('click', () => submit(s));

  const del = host.querySelector('#conDelete');
  if (del) del.addEventListener('click', () => remove(s));

  const addPay = host.querySelector('#conAddPay');
  if (addPay) addPay.addEventListener('click', () => addPayment(s));

  host.querySelectorAll('[data-droppay]').forEach((el) => {
    el.addEventListener('click', () => dropPayment(s, Number(el.dataset.droppay)));
  });

  host.querySelectorAll('[data-moment]').forEach((btn) => {
    btn.addEventListener('click', () => toggleMoment(s, btn.dataset.moment));
  });

  host.querySelectorAll('[data-deliv] button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.closest('[data-deliv]').dataset.deliv;
      setDeliverable(s, key, btn.dataset.state);
    });
  });
}

function closeDrawer() {
  state.openId = null;
  ctx.root.querySelector('#conDrawerHost').innerHTML = '';
}

function readForm() {
  const root = ctx.root;
  const val = (id) => {
    const el = root.querySelector('#' + id);
    return el ? el.value.trim() : '';
  };
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
    notes: val('f_notes'),
  };
}

function showFormError(msg) {
  const host = ctx.root.querySelector('#conFormErr');
  if (host) host.innerHTML = msg ? `<div class="con-err">${esc(msg)}</div>` : '';
}

async function submit(existing) {
  const body = readForm();
  if (!body.company) { showFormError('A sponsor needs a company name'); return; }
  showFormError('');
  try {
    if (existing) {
      await ctx.api.patch(ENDPOINTS.conSponsors, { ...body, id: existing.id });
    } else {
      await ctx.api.post(ENDPOINTS.conSponsors, body);
    }
    closeDrawer();
    await load();
  } catch (e) {
    showFormError(e.message || 'Could not save');
  }
}

async function remove(s) {
  if (!s) return;
  // A sponsor record holds what was agreed and what was paid. Asking once is
  // the right amount of friction; a soft delete would just be a second list
  // nobody reads.
  if (!window.confirm(`Delete ${s.company}? This removes the record of what was agreed and paid.`)) return;
  try {
    await ctx.api.del(ENDPOINTS.conSponsors, { query: { id: s.id } });
    closeDrawer();
    await load();
  } catch (e) {
    showFormError(e.message || 'Could not delete');
  }
}

async function addPayment(s) {
  const root = ctx.root;
  const amount = root.querySelector('#p_amount').value.trim();
  const date = root.querySelector('#p_date').value.trim();
  if (!amount) { showFormError('A payment needs an amount'); return; }
  showFormError('');

  const payments = (s.payments || []).concat([{ amount, date: date || null }]);
  try {
    const res = await ctx.api.patch(ENDPOINTS.conSponsors, { id: s.id, payments });
    await refreshAfterPatch(res);
  } catch (e) {
    showFormError(e.message || 'Could not record that payment');
  }
}

async function dropPayment(s, index) {
  const payments = (s.payments || []).filter((_, i) => i !== index);
  try {
    const res = await ctx.api.patch(ENDPOINTS.conSponsors, { id: s.id, payments });
    await refreshAfterPatch(res);
  } catch (e) {
    showFormError(e.message || 'Could not remove that payment');
  }
}

async function toggleMoment(s, key) {
  const held = Array.isArray(s.moments) ? s.moments.slice() : [];
  const i = held.indexOf(key);
  if (i >= 0) held.splice(i, 1);
  else held.push(key);
  try {
    const res = await ctx.api.patch(ENDPOINTS.conSponsors, { id: s.id, moments: held });
    await refreshAfterPatch(res);
  } catch (e) {
    showFormError(e.message || 'Could not update that');
  }
}

async function setDeliverable(s, key, next) {
  const current = deliverableStates(s);
  const deliverables = {};
  for (const k of DELIVERABLE_KEYS) {
    deliverables[k] = { ...current[k] };
  }
  deliverables[key] = {
    state: next,
    // Stamped only when it is actually done. A date on an open row is a date
    // for nothing, and a date on an N/A row reads as a completion.
    at: next === 'done' ? new Date().toISOString().slice(0, 10) : null,
    by: next === 'done' ? (ctx.user && (ctx.user.name || ctx.user.username)) || null : null,
    note: current[key].note,
  };
  try {
    const res = await ctx.api.patch(ENDPOINTS.conSponsors, { id: s.id, deliverables });
    await refreshAfterPatch(res);
  } catch (e) {
    showFormError(e.message || 'Could not update that');
  }
}

/**
 * Fold one saved record back into the list and redraw the drawer in place.
 * Reloading the whole list here would close and reopen the drawer under the
 * cursor, which is what made ticking four deliverables in a row unpleasant.
 */
async function refreshAfterPatch(res) {
  const saved = res && res.sponsor;
  if (!saved) { await load(); return; }
  const i = state.sponsors.findIndex((x) => x.id === saved.id);
  if (i >= 0) state.sponsors[i] = saved;
  else state.sponsors.unshift(saved);
  render();
  openDrawer(saved.id);
}
