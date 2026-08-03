/**
 * MailMe — email marketing.
 *
 * Built fresh (no standalone predecessor to port). Five views:
 *
 *   Dashboard  list health, split by audience, with deliverability warnings.
 *   Contacts   both sources in one sortable table, with filters and tagging.
 *   Lists      saved segments: dynamic (a rule) or static (a fixed set).
 *   Import     CSV import of cold-outreach prospects, preview before commit.
 *   Campaigns  draft composer with live recipient counts, and results.
 *
 * TWO CONTACT SOURCES:
 *   client   — the BackBone roster, resolved live server-side, never stored
 *              here. Fix an email in BackBone and it is fixed here.
 *   prospect — imported cold-outreach records that MailMe owns, because
 *              nothing else in the shell knows about them.
 *
 * The two are kept apart for a concrete reason, not tidiness: cold outreach
 * bounces and draws spam complaints at rates a customer list never does, and
 * mailbox providers score sender reputation per DOMAIN. Mixing the streams
 * would put quotes and invoices at risk of landing in customers' spam. Each
 * source therefore sends from its own domain, and a campaign targets exactly
 * one of them.
 *
 * SENDING IS NOT WIRED. Campaigns save as drafts and the API refuses any
 * status but "draft". The UI says so plainly rather than showing a Send
 * button that fails: a marketing tool where you are unsure whether something
 * went out is worse than one that clearly cannot send yet.
 *
 * No fetch() here: everything goes through ctx.api and ENDPOINTS, per the
 * seam rule. No hex colors: tokens.css owns theming via data-app="mailme".
 */

import { ENDPOINTS } from '../js/api.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString();
}

function pct(n) { return (Math.round(n * 10) / 10) + '%'; }

// Status presentation, kept as one table so the pill, the tiles and the
// filters can never disagree about what a status is called.
const STATUS_META = {
  subscribed:   { label: 'Subscribed',   cls: 'ok' },
  unsubscribed: { label: 'Unsubscribed', cls: 'warn' },
  bounced:      { label: 'Bounced',      cls: 'bad' },
  complained:   { label: 'Complained',   cls: 'bad' }
};

const SUPPRESSED = ['unsubscribed', 'bounced', 'complained'];

// Where a view's refresh feedback goes. Dashboard has no message strip of its
// own, so its refresh reports through the stamp alone.
const MSG_TARGET = {
  contacts: '#mmContactsMsg',
  lists: '#mmListMsg',
  campaigns: '#mmCampaignMsg',
  import: '#mmImportMsg',
  settings: '#mmSettingsMsg'
};

const SOURCE_META = {
  client:   { label: 'Client',   note: 'From the BackBone roster' },
  lead:     { label: 'Lead',     note: "From BackBone's qualified pipeline" },
  giving:   { label: 'Giving',   note: 'Asked P&M for a donation or sponsorship' },
  prospect: { label: 'Prospect', note: 'Imported for cold outreach' }
};

// Only imported prospects are genuinely cold. Leads and giving contacts were
// already in conversation with the shop, so they send from the warm domain.
const COLD_SOURCES = ['prospect'];

const REORDER_META = {
  'not-due': { label: 'On schedule', cls: 'mute' },
  due:       { label: 'Due',         cls: 'ok' },
  overdue:   { label: 'Overdue',     cls: 'warn' },
  lapsed:    { label: 'Lapsed',      cls: 'bad' },
  unknown:   { label: '',            cls: 'mute' }
};

export default {
  id: 'mailme',

  styles: `
  .mm-page{padding:24px 32px 60px}
  .mm-hd{display:flex;justify-content:space-between;align-items:flex-start;
    margin-bottom:20px;flex-wrap:wrap;gap:12px}
  .mm-hd h1{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .mm-hd .sub{font-size:13px;color:var(--muted);margin-top:3px}

  .mm-notice{background:var(--warn-tint);border:1px solid var(--warn-tint);
    border-left:3px solid var(--warn);border-radius:var(--radius-sm);
    padding:11px 14px;font-size:12.5px;color:var(--warn-dk);
    line-height:1.55;margin-bottom:18px}
  .mm-notice b{font-weight:700}
  .mm-notice.danger{background:var(--danger-tint);border-color:var(--danger-line);
    border-left-color:var(--danger);color:var(--danger-dk)}

  .mm-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
    gap:14px;margin-bottom:22px}
  .mm-tile{background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-md);padding:16px 18px}
  .mm-tile .v{font-size:25px;font-weight:800;letter-spacing:-.02em;line-height:1.1}
  .mm-tile .l{font-size:12px;color:var(--muted);margin-top:5px;font-weight:600}
  .mm-tile .n{font-size:11.5px;color:var(--faint);margin-top:3px;line-height:1.45}
  .mm-tile.ok .v{color:var(--success-dk)}
  .mm-tile.warn .v{color:var(--warn-dk)}
  .mm-tile.bad .v{color:var(--danger-dk)}

  .mm-card{background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-md);margin-bottom:18px;overflow:hidden}
  .mm-card-hd{display:flex;justify-content:space-between;align-items:center;
    padding:14px 18px;border-bottom:1px solid var(--line-soft);gap:12px;flex-wrap:wrap}
  .mm-card-hd h3{font-size:14px;font-weight:700}
  .mm-card-hd .meta{font-size:12px;color:var(--muted)}
  .mm-card-bd{padding:18px}
  .mm-card-bd.flush{padding:0}

  .mm-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
  .mm-filt{background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-sm);padding:6px 12px;font-size:12.5px;font-weight:600;
    color:var(--muted);cursor:pointer;font-family:inherit;transition:var(--speed)}
  .mm-filt:hover{color:var(--ink)}
  .mm-filt[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);
    color:var(--on-accent)}
  .mm-filt:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .mm-filt .n{opacity:.6;margin-left:5px;font-weight:700}
  .mm-filt[aria-pressed="true"] .n{opacity:.85}
  .mm-sep{width:1px;height:22px;background:var(--line);margin:0 4px}
  .mm-search{flex:1;min-width:170px;max-width:300px;padding:7px 11px;
    border:1px solid var(--line);border-radius:var(--radius-sm);
    font-family:inherit;font-size:13px;color:var(--ink);background:var(--card)}
  .mm-search:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}

  .mm-table{width:100%;border-collapse:collapse;font-size:13px}
  .mm-table th{text-align:left;font-size:11px;text-transform:uppercase;
    letter-spacing:.05em;color:var(--muted);font-weight:700;padding:9px 12px;
    background:var(--head-bg);border-bottom:1px solid var(--line);white-space:nowrap}
  .mm-table th.sortable{cursor:pointer;user-select:none}
  .mm-table th.sortable:hover{color:var(--ink)}
  .mm-table th .arrow{opacity:.4;margin-left:4px}
  .mm-table th[aria-sort] .arrow{opacity:1;color:var(--accent-deep)}
  .mm-table td{padding:10px 12px;border-bottom:1px solid var(--line-soft);vertical-align:middle}
  .mm-table tr:hover td{background:var(--row-hover)}
  .mm-table .co{font-weight:600;color:var(--ink)}
  .mm-table .em{color:var(--muted);font-size:12.5px}
  .mm-table .who{color:var(--faint);font-size:12px}
  .mm-table td.num{text-align:right;font-variant-numeric:tabular-nums}

  .pill{display:inline-block;padding:2px 9px;border-radius:var(--radius-pill);
    font-size:11px;font-weight:700;white-space:nowrap}
  .pill.ok{background:var(--success-tint);color:var(--success-dk)}
  .pill.warn{background:var(--warn-tint);color:var(--warn-dk)}
  .pill.bad{background:var(--danger-tint);color:var(--danger-dk)}
  .pill.src{background:var(--accent-tint);color:var(--accent-deep)}
  .pill.mute{background:var(--line-soft);color:var(--muted)}

  .tag{display:inline-block;padding:2px 8px;border-radius:var(--radius-pill);
    background:var(--accent-tint);color:var(--accent-deep);font-size:11px;
    font-weight:600;margin-right:4px;margin-bottom:2px}
  .tag-none{color:var(--faint);font-size:12px}

  .mm-btn{background:var(--accent);color:var(--on-accent);border:1px solid var(--accent);
    border-radius:var(--radius-sm);padding:7px 14px;font-size:13px;font-weight:600;
    cursor:pointer;font-family:inherit;transition:var(--speed)}
  .mm-btn:hover{background:var(--accent-deep);border-color:var(--accent-deep)}
  .mm-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .mm-btn[disabled]{opacity:.5;cursor:not-allowed}
  .mm-btn.ghost{background:transparent;color:var(--muted);border-color:var(--line)}
  .mm-btn.ghost:hover{color:var(--ink);background:var(--row-hover)}
  .mm-btn.sm{padding:4px 10px;font-size:12px}
  .mm-btn.danger{background:var(--danger);border-color:var(--danger)}
  .mm-btn.danger:hover{background:var(--danger-dk);border-color:var(--danger-dk)}

  .mm-field{margin-bottom:14px}
  .mm-field label{display:block;font-size:11px;text-transform:uppercase;
    letter-spacing:.05em;color:var(--muted);font-weight:700;margin-bottom:5px}
  .mm-field input,.mm-field textarea,.mm-field select{width:100%;padding:9px 11px;
    border:1px solid var(--line);border-radius:var(--radius-sm);
    font-family:inherit;font-size:13px;color:var(--ink);background:var(--card)}
  .mm-field textarea{min-height:150px;resize:vertical;line-height:1.6}
  .mm-field textarea.csv{min-height:200px;font-family:var(--font-mono);font-size:12px}
  .mm-field input:focus,.mm-field textarea:focus,.mm-field select:focus{
    outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
  .mm-field .hint{font-size:11.5px;color:var(--faint);margin-top:4px;line-height:1.5}
  .mm-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}

  .mm-recip{background:var(--accent-tint);border-radius:var(--radius-sm);
    padding:11px 14px;font-size:12.5px;color:var(--accent-deep);
    font-weight:600;margin-bottom:14px;line-height:1.5}
  .mm-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .mm-refresh{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .mm-refresh .stamp{font-size:11.5px;color:var(--faint);white-space:nowrap}

  .mm-empty{text-align:center;padding:34px 20px;color:var(--muted);font-size:13px;line-height:1.6}
  .mm-empty h4{font-size:14px;color:var(--ink);margin-bottom:6px;font-weight:700}
  .mm-err{background:var(--danger-tint);border:1px solid var(--danger-line);
    border-radius:var(--radius-sm);padding:11px 14px;font-size:12.5px;
    color:var(--danger-dk);margin-bottom:14px;line-height:1.5}
  .mm-ok{background:var(--success-tint);border-radius:var(--radius-sm);
    padding:11px 14px;font-size:12.5px;color:var(--success-dk);
    margin-bottom:14px;font-weight:600}

  .mm-stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));
    gap:12px;margin-bottom:16px}
  .mm-stat{background:var(--head-bg);border-radius:var(--radius-sm);padding:12px 14px}
  .mm-stat .v{font-size:20px;font-weight:800;letter-spacing:-.02em}
  .mm-stat .l{font-size:11px;color:var(--muted);margin-top:3px;font-weight:600}
  `,

  template: `
    <div class="mm-page">
      <!-- Dashboard -->
      <section id="mmDash" hidden>
        <div class="mm-hd">
          <div>
            <h1>MailMe<span class="dot">.</span></h1>
            <div class="sub">Who you can email, and who you can't.</div>
          </div>
          <div class="mm-refresh">
            <span class="stamp" data-mm-stamp></span>
            <button class="mm-btn ghost sm" data-mm-refresh="dashboard">Refresh</button>
          </div>
        </div>
        <div class="mm-notice" id="mmSendNotice"></div>
        <div id="mmDeliverability"></div>
        <div class="mm-tiles" id="mmTiles"></div>
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>Two audiences, two sending domains</h3>
            <span class="meta">Why the split matters</span>
          </div>
          <div class="mm-card-bd">
            <p style="font-size:13px;color:var(--muted);line-height:1.65;margin:0 0 10px">
              <b style="color:var(--ink)">Clients</b> come from the BackBone roster and are
              resolved fresh every time this page loads. MailMe keeps no copy, so fixing an
              email in BackBone fixes it here.
            </p>
            <p style="font-size:13px;color:var(--muted);line-height:1.65;margin:0 0 10px">
              <b style="color:var(--ink)">Prospects</b> are imported for cold outreach and are
              MailMe's own records, because nothing else in the shell knows about them.
            </p>
            <p style="font-size:13px;color:var(--muted);line-height:1.65;margin:0">
              They send from different domains on purpose. Cold outreach bounces and draws
              spam complaints far more than a customer list does, and mailbox providers judge
              reputation per domain. Keeping them apart means a rough cold campaign cannot
              push your quotes and invoices into customers' spam folders.
            </p>
          </div>
        </div>
      </section>

      <!-- Contacts -->
      <section id="mmContactsView" hidden>
        <div class="mm-hd">
          <div>
            <h1>Contacts<span class="dot">.</span></h1>
            <div class="sub" id="mmContactsSub"></div>
          </div>
          <div class="mm-refresh">
            <span class="stamp" data-mm-stamp></span>
            <button class="mm-btn ghost sm" data-mm-refresh="contacts">Refresh</button>
            <button class="mm-btn ghost" id="mmSaveAsList">Save view as list</button>
          </div>
        </div>
        <div id="mmContactsMsg"></div>
        <div class="mm-filters" id="mmContactFilters"></div>
        <div class="mm-card">
          <div class="mm-card-bd flush"><div id="mmContactsTable"></div></div>
        </div>
      </section>

      <!-- Lists -->
      <section id="mmListsView" hidden>
        <div class="mm-hd">
          <div>
            <h1>Lists<span class="dot">.</span></h1>
            <div class="sub">Saved segments. Dynamic lists stay current on their own.</div>
          </div>
          <div class="mm-refresh">
            <span class="stamp" data-mm-stamp></span>
            <button class="mm-btn ghost sm" data-mm-refresh="lists">Refresh</button>
            <button class="mm-btn" id="mmNewList">New list</button>
          </div>
        </div>
        <div id="mmListMsg"></div>
        <div id="mmListEditor" hidden></div>
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>Saved lists</h3><span class="meta" id="mmListCount"></span>
          </div>
          <div class="mm-card-bd flush"><div id="mmListTable"></div></div>
        </div>
      </section>

      <!-- Import -->
      <section id="mmImportView" hidden>
        <div class="mm-hd">
          <div>
            <h1>Import<span class="dot">.</span></h1>
            <div class="sub">Add cold-outreach prospects from a CSV.</div>
          </div>
        </div>
        <div id="mmImportMsg"></div>
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>Paste or upload a CSV</h3>
            <span class="meta">Preview first, import second</span>
          </div>
          <div class="mm-card-bd">
            <div class="mm-field">
              <label for="mmCsvFile">CSV file</label>
              <input type="file" id="mmCsvFile" accept=".csv,text/csv">
              <div class="hint">
                Needs an email column. Company, Name, Title, Phone, City and State are picked
                up automatically if present, under most common column names.
              </div>
            </div>
            <div class="mm-field">
              <label for="mmCsvText">Or paste the rows</label>
              <textarea id="mmCsvText" class="csv" placeholder="Email,Company,Name,Title"></textarea>
            </div>
            <div class="mm-field">
              <label for="mmImportTags">Tag this batch</label>
              <input id="mmImportTags" type="text" placeholder="cold-2026-q3, school-districts">
              <div class="hint">
                Comma separated, applied to every imported row. This is how a cold list stays
                segmentable later, so it is worth filling in.
              </div>
            </div>
            <div class="mm-actions">
              <button class="mm-btn" id="mmPreviewImport">Preview</button>
              <button class="mm-btn" id="mmCommitImport" hidden>Import them</button>
              <button class="mm-btn ghost" id="mmClearImport">Clear</button>
            </div>
          </div>
        </div>
        <div id="mmImportPreview"></div>
      </section>

      <!-- Settings -->
      <section id="mmSettingsView" hidden>
        <div class="mm-hd">
          <div>
            <h1>Settings<span class="dot">.</span></h1>
            <div class="sub">Sending identity, compliance, and the rules that decide who gets mailed.</div>
          </div>
          <div class="mm-refresh">
            <span class="stamp" data-mm-stamp></span>
            <button class="mm-btn ghost sm" data-mm-refresh="settings">Refresh</button>
          </div>
        </div>
        <div id="mmSettingsMsg"></div>
        <div id="mmBlockers"></div>
        <div id="mmSettingsForm"></div>
      </section>

      <!-- Campaigns -->
      <section id="mmCampaignsView" hidden>
        <div class="mm-hd">
          <div>
            <h1>Campaigns<span class="dot">.</span></h1>
            <div class="sub">Drafts. Sending is not switched on yet.</div>
          </div>
          <div class="mm-refresh">
            <span class="stamp" data-mm-stamp></span>
            <button class="mm-btn ghost sm" data-mm-refresh="campaigns">Refresh</button>
            <button class="mm-btn" id="mmNewCampaign">New draft</button>
          </div>
        </div>
        <div id="mmCampaignMsg"></div>
        <div id="mmComposer" hidden></div>
        <div id="mmResults" hidden></div>
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>Saved drafts</h3><span class="meta" id="mmCampaignCount"></span>
          </div>
          <div class="mm-card-bd flush"><div id="mmCampaignList"></div></div>
        </div>
      </section>
    </div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);
    const api = ctx.api;
    this._root = root;

    const state = {
      contacts: [], counts: {}, tags: [],
      lists: [], campaigns: [],
      source: 'all', status: 'all', search: '',
      sort: 'company_name', dir: 'asc',
      editingList: null, editingCampaign: null,
      importPreview: null, importCsv: '',
      settings: null, blockers: [], footerPreview: '', coldCapToday: 0,
      viewingResults: null
    };
    this._state = state;
    state.lastLoaded = null;
    state.refreshing = false;

    const msg = (sel, html, cls) => {
      const el = $(sel);
      if (el) el.innerHTML = html ? `<div class="${cls}">${html}</div>` : '';
    };

    /* ---------------- data ---------------- */

    async function loadContacts() {
      // Filtering and sorting are done SERVER-side so this view and a send
      // agree on the same rule. The client re-sorting locally would be a
      // second implementation to keep in step.
      const q = { sort: state.sort, dir: state.dir };
      if (state.source !== 'all') q.source = state.source;
      if (state.status !== 'all') q.status = state.status;
      if (state.search.trim()) q.q = state.search.trim();

      const d = await api.get(ENDPOINTS.mmContacts, q);
      state.contacts = Array.isArray(d && d.contacts) ? d.contacts : [];
      state.counts = (d && d.counts) || {};
      state.tags = Array.isArray(d && d.tags) ? d.tags : [];
    }

    async function loadLists() {
      const d = await api.get(ENDPOINTS.mmLists);
      state.lists = Array.isArray(d && d.lists) ? d.lists : [];
    }

    async function loadCampaigns() {
      const d = await api.get(ENDPOINTS.mmCampaigns);
      state.campaigns = Array.isArray(d && d.campaigns) ? d.campaigns : [];
    }

    /* ---------------- dashboard ---------------- */

    function renderDash() {
      const c = state.counts;

      $('#mmSendNotice').innerHTML =
        '<b>Sending is not switched on.</b> Campaigns save as drafts only. ' +
        'Before real email goes out this needs a sending provider, two authenticated ' +
        'sending domains (one for clients, one for cold outreach), and the unsubscribe ' +
        'page wired up. Until then nothing here can email anyone.';

      // Bounce/complaint rates are the early warning that a sending domain is
      // in trouble. Surfaced on the dashboard because by the time someone
      // notices mail "feels slow", filtering has usually already started.
      const bounced = c.bounced || 0;
      const complained = c.complained || 0;
      const totalOnce = (c.total || 0) || 1;
      const warn = [];
      if (bounced / totalOnce >= 0.02) {
        warn.push('Bounced addresses are over 2% of your list. Clean them out before the next send: ' +
          'mailbox providers start throttling senders at that level.');
      }
      if (complained > 0) {
        warn.push(complained + ' contact' + (complained === 1 ? ' has' : 's have') +
          ' marked your mail as spam. Complaints above 0.1% of a send get a sender filtered.');
      }
      $('#mmDeliverability').innerHTML = warn.length
        ? '<div class="mm-notice danger"><b>Deliverability.</b> ' + warn.map(esc).join(' ') + '</div>'
        : '';

      // Reorder-due clients are the highest-value audience in the app: they
      // already buy, and they are past their own normal cadence. Surfaced on
      // the dashboard rather than buried behind a filter.
      const dueNow = state.contacts.filter((x) =>
        x.source === 'client' && x.reorder && x.reorder.confident &&
        (x.reorder.state === 'due' || x.reorder.state === 'overdue')).length;

      const tiles = [
        { v: dueNow, l: 'Due to reorder', cls: dueNow ? 'ok' : '',
          n: 'Clients past their own normal gap. Your warmest list.' },
        { v: c.mailable || 0, l: 'Mailable', cls: 'ok',
          n: (c.client || 0) + ' client, ' + (c.lead || 0) + ' lead, ' +
             (c.giving || 0) + ' giving, ' + (c.prospect || 0) + ' prospect' },
        { v: (c.lead || 0) + (c.giving || 0), l: 'Leads and giving', cls: '',
          n: 'Warmer than anything you could buy' },
        { v: c.prospect || 0, l: 'Prospects', cls: '',
          n: 'Imported for cold outreach' },
        { v: c.unsubscribed || 0, l: 'Unsubscribed', cls: (c.unsubscribed ? 'warn' : ''),
          n: 'Opted out. Never included in a send.' },
        { v: bounced + complained, l: 'Bounced / complained', cls: ((bounced + complained) ? 'bad' : ''),
          n: 'Set by the mail provider, not by hand.' },
        { v: c.customersWithoutEmail || 0, l: 'No email on file', cls: '',
          n: 'Roster customers MailMe cannot reach.' }
      ];

      $('#mmTiles').innerHTML = tiles.map((t) => `
        <div class="mm-tile ${t.cls}">
          <div class="v">${esc(t.v)}</div>
          <div class="l">${esc(t.l)}</div>
          <div class="n">${esc(t.n)}</div>
        </div>`).join('');
    }

    /* ---------------- contacts ---------------- */

    function renderFilters() {
      const c = state.counts;
      const srcOpts = [
        ['all', 'All sources', c.total || 0],
        ['client', 'Clients', c.client || 0],
        ['lead', 'Leads', c.lead || 0],
        ['giving', 'Giving', c.giving || 0],
        ['prospect', 'Prospects', c.prospect || 0]
      ];
      const statOpts = [
        ['all', 'Any status', null],
        ['mailable', 'Mailable', c.mailable || 0],
        ['unsubscribed', 'Unsubscribed', c.unsubscribed || 0],
        ['bounced', 'Bounced', c.bounced || 0]
      ];

      $('#mmContactFilters').innerHTML =
        srcOpts.map(([k, label, n]) =>
          `<button class="mm-filt" data-src="${k}" aria-pressed="${state.source === k}">
             ${esc(label)}<span class="n">${n}</span></button>`).join('') +
        '<span class="mm-sep"></span>' +
        statOpts.map(([k, label, n]) =>
          `<button class="mm-filt" data-stat="${k}" aria-pressed="${state.status === k}">
             ${esc(label)}${n === null ? '' : `<span class="n">${n}</span>`}</button>`).join('') +
        `<input class="mm-search" id="mmSearch" type="search"
                placeholder="Search company, email, title or tag" value="${esc(state.search)}">`;

      $('#mmContactFilters').querySelectorAll('[data-src]').forEach((b) => {
        b.addEventListener('click', async () => {
          state.source = b.dataset.src;
          await loadContacts(); renderFilters(); renderContactsTable();
        });
      });
      $('#mmContactFilters').querySelectorAll('[data-stat]').forEach((b) => {
        b.addEventListener('click', async () => {
          state.status = b.dataset.stat;
          await loadContacts(); renderFilters(); renderContactsTable();
        });
      });

      // Debounced so typing does not fire a request per keystroke.
      const search = $('#mmSearch');
      let timer = null;
      search.addEventListener('input', (e) => {
        state.search = e.target.value;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          await loadContacts(); renderContactsTable();
        }, 250);
      });
    }

    const COLUMNS = [
      ['company_name', 'Company'],
      ['contact_name', 'Contact'],
      ['email', 'Email'],
      ['source', 'Source'],
      ['status', 'Status'],
      ['reorder', 'Reorder'],
      ['tags', 'Tags']
    ];

    async function setSort(key) {
      // Third click on the same column does not cycle back to unsorted: a
      // table with no order is not a useful state to land on by accident.
      if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      else { state.sort = key; state.dir = 'asc'; }
      await loadContacts();
      renderContactsTable();
    }

    // Reorder timing only means anything for clients, and only when they
    // have enough order history for a median gap to be a real pattern.
    function reorderCell(ct) {
      const r = ct.reorder;
      if (!r || !r.confident || r.state === 'unknown') {
        return ct.source === 'client'
          ? '<span class="who">not enough history</span>' : '';
      }
      const m = REORDER_META[r.state] || REORDER_META.unknown;
      const detail = r.daysSince != null && r.expectedGap
        ? `${r.daysSince}d since, usually ${Math.round(r.expectedGap)}d` : '';
      return `<span class="pill ${m.cls}">${esc(m.label)}</span>` +
        (detail ? `<div class="who" style="margin-top:3px">${esc(detail)}</div>` : '');
    }

    function renderContactsTable() {
      const c = state.counts;
      $('#mmContactsSub').textContent =
        (c.shown != null ? c.shown : state.contacts.length) + ' shown of ' + (c.total || 0) +
        ' · ' + (c.client || 0) + ' client, ' + (c.prospect || 0) + ' prospect' +
        (c.customersWithoutEmail ? ' · ' + c.customersWithoutEmail + ' roster customers with no email' : '');

      if (!state.contacts.length) {
        $('#mmContactsTable').innerHTML =
          '<div class="mm-empty"><h4>Nothing matches</h4><div>Try a different filter or search.</div></div>';
        return;
      }

      const head = COLUMNS.map(([key, label]) => {
        const active = state.sort === key;
        // Literal glyphs, not HTML entities: an entity like &#9650; matches
        // the repo's hex-color test regex and fails the no-hex rule.
        const arrow = active ? (state.dir === 'asc' ? '\u25B2' : '\u25BC') : '\u25C6';
        return `<th class="sortable" data-sort="${key}"${active ? ` aria-sort="${state.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>
                  ${esc(label)}<span class="arrow">${arrow}</span></th>`;
      }).join('');

      $('#mmContactsTable').innerHTML = `
        <table class="mm-table">
          <thead><tr>${head}<th style="text-align:right">Actions</th></tr></thead>
          <tbody>
            ${state.contacts.map((ct) => {
              const meta = STATUS_META[ct.status] || STATUS_META.subscribed;
              const src = SOURCE_META[ct.source] || SOURCE_META.client;
              const locked = ct.status === 'bounced' || ct.status === 'complained';
              return `
              <tr>
                <td><div class="co">${esc(ct.company_name || '(no company)')}</div>
                    ${ct.city ? `<div class="who">${esc([ct.city, ct.state].filter(Boolean).join(', '))}</div>` : ''}</td>
                <td>${esc(ct.contact_name || '')}
                    ${ct.title ? `<div class="who">${esc(ct.title)}</div>` : ''}</td>
                <td class="em">${esc(ct.email)}</td>
                <td><span class="pill src" title="${esc(src.note)}">${esc(src.label)}</span></td>
                <td><span class="pill ${meta.cls}">${esc(meta.label)}</span>
                    ${ct.reason ? `<div class="who" style="margin-top:3px">${esc(ct.reason)}</div>` : ''}
                    ${ct.verification === 'invalid'
                      ? '<div class="who">Failed verification</div>' : ''}</td>
                <td>${reorderCell(ct)}</td>
                <td>${ct.tags && ct.tags.length
                  ? ct.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')
                  : '<span class="tag-none">none</span>'}</td>
                <td style="text-align:right;white-space:nowrap">
                  ${locked ? '<span class="who">provider-set</span>'
                    : `<button class="mm-btn ghost sm" data-toggle="${esc(ct.id)}">${
                        ct.status === 'unsubscribed' ? 'Resubscribe' : 'Unsubscribe'}</button>`}
                  <button class="mm-btn ghost sm" data-tags="${esc(ct.id)}">Tags</button>
                  ${ct.source === 'prospect'
                    ? `<button class="mm-btn ghost sm" data-del="${esc(ct.id)}">Delete</button>` : ''}
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;

      $('#mmContactsTable').querySelectorAll('[data-sort]').forEach((th) => {
        th.addEventListener('click', () => setSort(th.dataset.sort));
      });
      $('#mmContactsTable').querySelectorAll('[data-toggle]').forEach((b) => {
        b.addEventListener('click', () => toggleSub(b.dataset.toggle));
      });
      $('#mmContactsTable').querySelectorAll('[data-tags]').forEach((b) => {
        b.addEventListener('click', () => editTags(b.dataset.tags));
      });
      $('#mmContactsTable').querySelectorAll('[data-del]').forEach((b) => {
        b.addEventListener('click', () => deleteProspect(b.dataset.del));
      });
    }

    async function toggleSub(id) {
      const ct = state.contacts.find((x) => x.id === id);
      if (!ct) return;
      let payload;
      if (ct.status === 'unsubscribed') {
        payload = { id, status: 'subscribed' };
      } else {
        // Capturing WHY is the reason MailMe keeps a reason field at all:
        // providers report the unsubscribe but never the cause.
        const reason = window.prompt(
          'Unsubscribe ' + (ct.company_name || ct.email) +
          '.\n\nReason (optional, for your own reporting):', '');
        if (reason === null) return;
        payload = { id, status: 'unsubscribed', reason };
      }
      try {
        await api.patch(ENDPOINTS.mmContacts, payload);
        await loadContacts();
        renderFilters(); renderContactsTable(); renderDash();
        msg('#mmContactsMsg', 'Updated ' + esc(ct.company_name || ct.email) + '.', 'mm-ok');
      } catch (e) {
        msg('#mmContactsMsg', 'Could not update: ' + esc(e.message), 'mm-err');
      }
    }

    async function editTags(id) {
      const ct = state.contacts.find((x) => x.id === id);
      if (!ct) return;
      const next = window.prompt(
        'Tags for ' + (ct.company_name || ct.email) +
        '.\n\nComma separated. These are your segments.', (ct.tags || []).join(', '));
      if (next === null) return;
      const tags = next.split(',').map((t) => t.trim()).filter(Boolean);
      try {
        await api.patch(ENDPOINTS.mmContacts, { id, tags });
        await loadContacts(); renderFilters(); renderContactsTable();
        msg('#mmContactsMsg', 'Tags updated.', 'mm-ok');
      } catch (e) {
        msg('#mmContactsMsg', 'Could not update tags: ' + esc(e.message), 'mm-err');
      }
    }

    async function deleteProspect(id) {
      const ct = state.contacts.find((x) => x.id === id);
      if (!ct) return;
      if (!window.confirm('Delete ' + (ct.company_name || ct.email) + ' from prospects?\n\n' +
        'If they ever unsubscribed, that stays on record: deleting and re-importing ' +
        'will not start mailing them again.')) return;
      try {
        await api.del(ENDPOINTS.mmContacts, { query: { id } });
        await loadContacts(); renderFilters(); renderContactsTable(); renderDash();
        msg('#mmContactsMsg', 'Prospect deleted.', 'mm-ok');
      } catch (e) {
        msg('#mmContactsMsg', 'Could not delete: ' + esc(e.message), 'mm-err');
      }
    }

    /* ---------------- lists ---------------- */

    function renderListEditor() {
      const box = $('#mmListEditor');
      const l = state.editingList;
      if (!l) { box.hidden = true; box.innerHTML = ''; return; }

      const rule = l.rule || { source: '', statuses: [], tags: [], tagMatch: 'any', search: '' };
      box.hidden = false;
      box.innerHTML = `
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>${l.id ? 'Edit ' + esc(l.id) : 'New list'}</h3>
            <span class="meta">${l.kind === 'static' ? 'Fixed set' : 'Rule, re-evaluated each time'}</span>
          </div>
          <div class="mm-card-bd">
            <div class="mm-field">
              <label for="mmListName">Name</label>
              <input id="mmListName" type="text" value="${esc(l.name || '')}"
                     placeholder="Cold prospects, central Iowa schools">
            </div>
            ${l.kind === 'static' ? `
              <div class="mm-recip">${(l.members || []).length} contacts, fixed at the time it was saved.</div>
            ` : `
              <div class="mm-row">
                <div class="mm-field">
                  <label for="mmRuleSource">Source</label>
                  <select id="mmRuleSource">
                    <option value=""${!rule.source ? ' selected' : ''}>Any source</option>
                    <option value="client"${rule.source === 'client' ? ' selected' : ''}>Clients only</option>
                    <option value="prospect"${rule.source === 'prospect' ? ' selected' : ''}>Prospects only</option>
                  </select>
                </div>
                <div class="mm-field">
                  <label for="mmRuleTagMatch">Tag match</label>
                  <select id="mmRuleTagMatch">
                    <option value="any"${rule.tagMatch !== 'all' ? ' selected' : ''}>Any of these tags</option>
                    <option value="all"${rule.tagMatch === 'all' ? ' selected' : ''}>All of these tags</option>
                  </select>
                </div>
              </div>
              <div class="mm-field">
                <label for="mmRuleTags">Tags</label>
                <input id="mmRuleTags" type="text" value="${esc((rule.tags || []).join(', '))}"
                       placeholder="Leave blank for no tag filter">
                <div class="hint">${state.tags.length
                  ? 'Tags in use: ' + esc(state.tags.join(', ')) : 'No tags created yet.'}</div>
              </div>
              <div class="mm-field">
                <label for="mmRuleSearch">Text match</label>
                <input id="mmRuleSearch" type="text" value="${esc(rule.search || '')}"
                       placeholder="Matches company, name, email or title">
              </div>
            `}
            <div class="mm-actions">
              <button class="mm-btn" id="mmSaveList">Save list</button>
              <button class="mm-btn ghost" id="mmCancelList">Cancel</button>
              ${l.id ? '<button class="mm-btn ghost" id="mmDeleteList">Delete</button>' : ''}
            </div>
          </div>
        </div>`;

      $('#mmSaveList').addEventListener('click', saveList);
      $('#mmCancelList').addEventListener('click', () => { state.editingList = null; renderListEditor(); });
      const del = $('#mmDeleteList');
      if (del) del.addEventListener('click', () => removeList(l.id));
    }

    async function saveList() {
      const l = state.editingList;
      const payload = { name: $('#mmListName').value, kind: l.kind };

      if (l.kind === 'static') {
        payload.members = l.members || [];
      } else {
        payload.rule = {
          source: $('#mmRuleSource').value || null,
          statuses: [],
          tags: $('#mmRuleTags').value.split(',').map((t) => t.trim()).filter(Boolean),
          tagMatch: $('#mmRuleTagMatch').value,
          search: $('#mmRuleSearch').value
        };
      }

      if (!payload.name.trim()) {
        msg('#mmListMsg', 'A list needs a name.', 'mm-err');
        return;
      }
      try {
        if (l.id) await api.patch(ENDPOINTS.mmLists, { id: l.id, ...payload });
        else await api.post(ENDPOINTS.mmLists, payload);
        state.editingList = null;
        await loadLists();
        renderListEditor(); renderListTable();
        msg('#mmListMsg', 'List saved.', 'mm-ok');
      } catch (e) {
        msg('#mmListMsg', 'Could not save: ' + esc(e.message), 'mm-err');
      }
    }

    async function removeList(id) {
      if (!window.confirm('Delete this list? The contacts in it are not affected.')) return;
      try {
        await api.del(ENDPOINTS.mmLists, { query: { id } });
        state.editingList = null;
        await loadLists(); renderListEditor(); renderListTable();
        msg('#mmListMsg', 'List deleted.', 'mm-ok');
      } catch (e) {
        msg('#mmListMsg', 'Could not delete: ' + esc(e.message), 'mm-err');
      }
    }

    function renderListTable() {
      $('#mmListCount').textContent =
        state.lists.length + ' list' + (state.lists.length === 1 ? '' : 's');

      if (!state.lists.length) {
        $('#mmListTable').innerHTML =
          '<div class="mm-empty"><h4>No lists yet</h4>' +
          '<div>A dynamic list is a saved rule, so it stays current as contacts change. ' +
          'Filter the Contacts view and use "Save view as list" for the quickest start.</div></div>';
        return;
      }

      $('#mmListTable').innerHTML = `
        <table class="mm-table">
          <thead><tr><th>Name</th><th>Kind</th><th>Rule</th>
            <th class="num">Members</th><th class="num">Mailable</th>
            <th style="text-align:right"></th></tr></thead>
          <tbody>
            ${state.lists.map((l) => {
              const r = l.rule || {};
              const bits = [];
              if (r.source) bits.push(SOURCE_META[r.source] ? SOURCE_META[r.source].label + 's' : r.source);
              if ((r.tags || []).length) bits.push((r.tagMatch === 'all' ? 'all of ' : 'any of ') + r.tags.join(', '));
              if (r.search) bits.push('matching "' + r.search + '"');
              return `
              <tr>
                <td><div class="co">${esc(l.name)}</div><div class="who">${esc(l.id)}</div></td>
                <td><span class="pill ${l.kind === 'static' ? 'mute' : 'src'}">${esc(l.kind)}</span></td>
                <td class="em">${l.kind === 'static'
                  ? 'Fixed set' : (bits.length ? esc(bits.join(' · ')) : 'Everyone')}</td>
                <td class="num">${l.memberCount != null ? l.memberCount : '—'}</td>
                <td class="num">${l.mailableCount != null ? l.mailableCount : '—'}</td>
                <td style="text-align:right">
                  <button class="mm-btn ghost sm" data-editlist="${esc(l.id)}">Edit</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;

      $('#mmListTable').querySelectorAll('[data-editlist]').forEach((b) => {
        b.addEventListener('click', () => {
          const l = state.lists.find((x) => x.id === b.dataset.editlist);
          if (!l) return;
          state.editingList = { ...l };
          renderListEditor();
        });
      });
    }

    $('#mmNewList').addEventListener('click', () => {
      state.editingList = { name: '', kind: 'dynamic', rule: { source: '', tags: [], tagMatch: 'any', search: '' } };
      renderListEditor(); msg('#mmListMsg', '', '');
    });

    // Turn the current Contacts filters straight into a dynamic list. The
    // filters ARE a rule, so making someone re-enter them in the list editor
    // would be asking twice for the same thing.
    $('#mmSaveAsList').addEventListener('click', () => {
      state.editingList = {
        name: '',
        kind: 'dynamic',
        rule: {
          source: state.source === 'all' ? '' : state.source,
          tags: [],
          tagMatch: 'any',
          search: state.search.trim()
        }
      };
      ctx.go('lists');
    });

    /* ---------------- import ---------------- */

    // Reading the file in the browser keeps a large CSV off the network until
    // it has been parsed and previewed.
    $('#mmCsvFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        $('#mmCsvText').value = String(reader.result || '');
        msg('#mmImportMsg', 'Loaded ' + esc(file.name) + '. Preview it before importing.', 'mm-ok');
      };
      reader.onerror = () => msg('#mmImportMsg', 'Could not read that file.', 'mm-err');
      reader.readAsText(file);
    });

    $('#mmClearImport').addEventListener('click', () => {
      $('#mmCsvText').value = '';
      $('#mmCsvFile').value = '';
      $('#mmImportTags').value = '';
      state.importPreview = null;
      $('#mmImportPreview').innerHTML = '';
      $('#mmCommitImport').hidden = true;
      msg('#mmImportMsg', '', '');
    });

    const importTags = () =>
      $('#mmImportTags').value.split(',').map((t) => t.trim()).filter(Boolean);

    $('#mmPreviewImport').addEventListener('click', async () => {
      const csv = $('#mmCsvText').value;
      if (!csv.trim()) {
        msg('#mmImportMsg', 'Paste some rows or choose a file first.', 'mm-err');
        return;
      }
      msg('#mmImportMsg', 'Checking the file...', 'mm-ok');
      try {
        const d = await api.post(ENDPOINTS.mmImport, { csv, tags: importTags() });
        state.importPreview = d;
        state.importCsv = csv;
        renderImportPreview();
        msg('#mmImportMsg', '', '');
      } catch (e) {
        state.importPreview = null;
        $('#mmImportPreview').innerHTML = '';
        $('#mmCommitImport').hidden = true;
        msg('#mmImportMsg', esc(e.message), 'mm-err');
      }
    });

    $('#mmCommitImport').addEventListener('click', async () => {
      if (!state.importPreview) return;
      const n = state.importPreview.summary.importable;
      if (!window.confirm('Import ' + n + ' new prospect' + (n === 1 ? '' : 's') + '?')) return;
      try {
        const d = await api.post(ENDPOINTS.mmImport, {
          csv: state.importCsv, tags: importTags(), commit: true
        });
        await Promise.all([loadContacts(), loadLists()]);
        renderDash(); renderFilters(); renderContactsTable();
        state.importPreview = null;
        $('#mmImportPreview').innerHTML = '';
        $('#mmCommitImport').hidden = true;
        $('#mmCsvText').value = '';
        $('#mmCsvFile').value = '';
        msg('#mmImportMsg',
          'Imported ' + d.imported + ' prospect' + (d.imported === 1 ? '' : 's') +
          '. Batch ' + esc(d.batchId) + '.', 'mm-ok');
      } catch (e) {
        msg('#mmImportMsg', 'Import failed: ' + esc(e.message), 'mm-err');
      }
    });

    function rejectTable(title, rows, tone) {
      if (!rows || !rows.length) return '';
      return `
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>${esc(title)}</h3>
            <span class="meta">${rows.length} shown</span>
          </div>
          <div class="mm-card-bd flush">
            <table class="mm-table">
              <thead><tr><th>Line</th><th>Email</th><th>Company</th><th>Why</th></tr></thead>
              <tbody>${rows.map((r) => `
                <tr>
                  <td class="who">${esc(r.lineNumber)}</td>
                  <td class="em">${esc(r.email || '(blank)')}</td>
                  <td>${esc(r.company_name || '')}</td>
                  <td><span class="pill ${tone}">${esc(r.problem || '')}</span></td>
                </tr>`).join('')}</tbody>
            </table>
          </div>
        </div>`;
    }

    function renderImportPreview() {
      const d = state.importPreview;
      if (!d) { $('#mmImportPreview').innerHTML = ''; return; }
      const s = d.summary;
      const rej = d.rejected || {};

      $('#mmCommitImport').hidden = !s.importable;

      const unmapped = (s.unmappedColumns || []).length
        ? `<div class="mm-notice"><b>Columns not recognized:</b> ${esc(s.unmappedColumns.join(', '))}.
             These are ignored. If one of them holds the company or contact name, rename it and
             preview again.</div>` : '';

      // A cold list dominated by one domain is usually a scrape of a single
      // directory, and is worth a second look before it goes out.
      const domains = (s.topDomains || []).length
        ? `<div class="mm-field"><label>Top domains in this batch</label>
             <div>${s.topDomains.map((t) =>
               `<span class="tag">${esc(t.domain)} \u00D7${t.count}</span>`).join('')}</div>
             <div class="hint">A batch heavily weighted to one domain is often a scrape of a
               single directory. Worth a look before sending.</div></div>` : '';

      $('#mmImportPreview').innerHTML = `
        ${unmapped}
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>Preview</h3>
            <span class="meta">Nothing has been imported yet</span>
          </div>
          <div class="mm-card-bd">
            <div class="mm-stat-row">
              <div class="mm-stat"><div class="v">${s.parsed}</div><div class="l">Rows read</div></div>
              <div class="mm-stat"><div class="v">${s.importable}</div><div class="l">Importable</div></div>
              <div class="mm-stat"><div class="v">${s.duplicate}</div><div class="l">Duplicates</div></div>
              <div class="mm-stat"><div class="v">${s.existingClients}</div><div class="l">Already clients</div></div>
              <div class="mm-stat"><div class="v">${s.suppressed}</div><div class="l">Opted out before</div></div>
              <div class="mm-stat"><div class="v">${s.invalid}</div><div class="l">Invalid</div></div>
            </div>
            ${domains}
            ${(s.tags || []).length
              ? `<div class="mm-field"><label>Tags to apply</label>
                   <div>${s.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>`
              : `<div class="hint">No batch tags set. Adding one now makes this list far easier
                   to segment later.</div>`}
          </div>
        </div>
        ${(d.preview || []).length ? `
        <div class="mm-card">
          <div class="mm-card-hd"><h3>Will be imported</h3>
            <span class="meta">first ${Math.min(25, d.preview.length)} of ${s.importable}</span></div>
          <div class="mm-card-bd flush">
            <table class="mm-table">
              <thead><tr><th>Email</th><th>Company</th><th>Contact</th><th>Title</th></tr></thead>
              <tbody>${d.preview.map((r) => `
                <tr><td class="em">${esc(r.email)}</td><td>${esc(r.company_name || '')}</td>
                    <td>${esc(r.contact_name || '')}</td><td class="who">${esc(r.title || '')}</td></tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : ''}
        ${rejectTable('Already opted out — will not be imported', rej.suppressed, 'bad')}
        ${rejectTable('Already clients in BackBone', rej.existingClients, 'warn')}
        ${rejectTable('Duplicates', rej.duplicate, 'mute')}
        ${rejectTable('Invalid rows', rej.invalid, 'bad')}
      `;
    }

    /* ---------------- campaigns ---------------- */

    function renderComposer() {
      const box = $('#mmComposer');
      const d = state.editingCampaign;
      if (!d) { box.hidden = true; box.innerHTML = ''; return; }

      const listOpts = state.lists
        .filter((l) => !d.source || !l.rule || !l.rule.source || l.rule.source === d.source);

      box.hidden = false;
      box.innerHTML = `
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>${d.id ? 'Edit draft ' + esc(d.id) : 'New draft'}</h3>
            <span class="meta">Saved as a draft. Nothing sends.</span>
          </div>
          <div class="mm-card-bd">
            <div class="mm-recip" id="mmRecipCount"></div>
            <div class="mm-row">
              <div class="mm-field">
                <label for="mmSource">Audience</label>
                <select id="mmSource">
                  <option value="client"${d.source === 'client' ? ' selected' : ''}>Clients</option>
                  <option value="lead"${d.source === 'lead' ? ' selected' : ''}>Leads</option>
                  <option value="giving"${d.source === 'giving' ? ' selected' : ''}>Giving contacts</option>
                  <option value="prospect"${d.source === 'prospect' ? ' selected' : ''}>Prospects (cold)</option>
                </select>
                <div class="hint" id="mmIdentityHint"></div>
              </div>
              <div class="mm-field">
                <label for="mmList">Send to list</label>
                <select id="mmList">
                  <option value="">No list, use tags below</option>
                  ${listOpts.map((l) =>
                    `<option value="${esc(l.id)}"${d.listId === l.id ? ' selected' : ''}>
                       ${esc(l.name)} (${l.mailableCount != null ? l.mailableCount : '?'})</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="mm-field">
              <label for="mmSubject">Subject</label>
              <input id="mmSubject" type="text" value="${esc(d.subject)}"
                     placeholder="Fall order deadlines are coming up">
            </div>
            <div class="mm-field">
              <label for="mmPreheader">Preheader</label>
              <input id="mmPreheader" type="text" value="${esc(d.preheader || '')}"
                     placeholder="The short line inboxes show next to the subject">
            </div>
            <div class="mm-field">
              <label for="mmSegment">Tags</label>
              <input id="mmSegment" type="text" value="${esc((d.segmentTags || []).join(', '))}"
                     placeholder="Leave blank for everyone mailable in this audience">
              <div class="hint">Ignored when a list is chosen above.</div>
            </div>
            <div class="mm-field">
              <label for="mmBody">Body</label>
              <textarea id="mmBody" placeholder="Write the email here.">${esc(d.body)}</textarea>
              <div class="hint">
                {{first_name}} and {{company_name}} fill in per recipient once sending is wired.
              </div>
            </div>
            <div class="mm-actions">
              <button class="mm-btn" id="mmSaveDraft">Save draft</button>
              <button class="mm-btn ghost" id="mmCancelDraft">Cancel</button>
              ${d.id ? '<button class="mm-btn ghost" id="mmDeleteDraft">Delete</button>' : ''}
            </div>
          </div>
        </div>`;

      const refresh = () => {
        const source = $('#mmSource').value;
        const listId = $('#mmList').value;
        const tags = $('#mmSegment').value.split(',').map((t) => t.trim()).filter(Boolean);

        let n;
        if (listId) {
          const l = state.lists.find((x) => x.id === listId);
          n = l && l.mailableCount != null ? l.mailableCount : 0;
        } else {
          n = previewRecipients(source, tags).length;
        }

        $('#mmRecipCount').textContent =
          n + ' recipient' + (n === 1 ? '' : 's') +
          (listId ? ' from the chosen list'
            : tags.length ? ' matching ' + tags.join(', ') : ' (everyone mailable)') +
          ' · suppressed contacts are always excluded';

        // The sending domain is shown because it is the consequence of the
        // audience choice, and it is the thing that protects client mail.
        $('#mmIdentityHint').textContent = COLD_SOURCES.includes(source)
          ? 'Sends from outreach.pmapparel.com, kept separate so cold complaints cannot hurt client mail.'
          : 'Sends from mail.pmapparel.com, the warm domain shared by clients, leads and giving contacts.';
      };
      refresh();
      $('#mmSource').addEventListener('change', refresh);
      $('#mmList').addEventListener('change', refresh);
      $('#mmSegment').addEventListener('input', refresh);

      $('#mmSaveDraft').addEventListener('click', saveDraft);
      $('#mmCancelDraft').addEventListener('click', () => { state.editingCampaign = null; renderComposer(); });
      const del = $('#mmDeleteDraft');
      if (del) del.addEventListener('click', () => deleteDraft(d.id));
    }

    // Client-side estimate only. The server recomputes with the same rule
    // before anything would ever send; this exists so the number moves as you
    // type instead of after a round trip.
    function previewRecipients(source, tags) {
      let base = state.contacts.filter((c) => !SUPPRESSED.includes(c.status));
      if (source) base = base.filter((c) => c.source === source);
      if (!tags || !tags.length) return base;
      const want = new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
      if (!want.size) return base;
      return base.filter((c) => Array.isArray(c.tags) &&
        c.tags.some((t) => want.has(String(t).trim().toLowerCase())));
    }

    async function saveDraft() {
      const d = state.editingCampaign;
      const payload = {
        subject: $('#mmSubject').value,
        preheader: $('#mmPreheader').value,
        body: $('#mmBody').value,
        source: $('#mmSource').value,
        listId: $('#mmList').value || null,
        segmentTags: $('#mmSegment').value.split(',').map((t) => t.trim()).filter(Boolean)
      };
      if (!payload.subject.trim() || !payload.body.trim()) {
        msg('#mmCampaignMsg', 'A draft needs both a subject and a body.', 'mm-err');
        return;
      }
      try {
        if (d.id) await api.patch(ENDPOINTS.mmCampaigns, { id: d.id, ...payload });
        else await api.post(ENDPOINTS.mmCampaigns, payload);
        state.editingCampaign = null;
        await loadCampaigns();
        renderComposer(); renderCampaignList();
        msg('#mmCampaignMsg', 'Draft saved.', 'mm-ok');
      } catch (e) {
        msg('#mmCampaignMsg', 'Could not save: ' + esc(e.message), 'mm-err');
      }
    }

    async function deleteDraft(id) {
      if (!window.confirm('Delete this draft?')) return;
      try {
        await api.del(ENDPOINTS.mmCampaigns, { query: { id } });
        state.editingCampaign = null;
        await loadCampaigns(); renderComposer(); renderCampaignList();
        msg('#mmCampaignMsg', 'Draft deleted.', 'mm-ok');
      } catch (e) {
        msg('#mmCampaignMsg', 'Could not delete: ' + esc(e.message), 'mm-err');
      }
    }

    async function showResults(id) {
      const box = $('#mmResults');
      try {
        const d = await api.get(ENDPOINTS.mmCampaigns, { id });
        const r = d.results || {};
        const s = r.stats || {};
        const rates = r.rates || {};
        const warnings = r.warnings || [];
        const sent = d.campaign && d.campaign.sentAt;

        box.hidden = false;
        box.innerHTML = `
          <div class="mm-card">
            <div class="mm-card-hd">
              <h3>Results: ${esc(d.campaign.subject)}</h3>
              <span class="meta">${esc(d.campaign.id)} · ${sent ? 'sent ' + esc(fmtDate(sent)) : 'not sent'}</span>
            </div>
            <div class="mm-card-bd">
              ${warnings.map((w) =>
                `<div class="mm-notice ${w.level === 'danger' ? 'danger' : ''}">${esc(w.text)}</div>`).join('')}
              ${!sent ? `<div class="mm-notice">This campaign has not been sent, so there is
                nothing to report yet. These are the figures that will appear once sending is
                switched on.</div>` : ''}
              ${(d.blockers || []).length ? `<div class="mm-notice danger">
                <b>Not legal to send yet.</b> ${esc(d.blockers.map((b) => b.text).join(' '))}
                Fix these in Settings.</div>` : ''}
              ${d.sendPlan && d.sendPlan.days > 1 ? `<div class="mm-notice">
                <b>This send would take ${d.sendPlan.days} days.</b> The
                ${d.sendPlan.isCold ? 'cold' : 'client'} daily cap is ${d.sendPlan.dailyCap}
                ${d.sendPlan.isCold ? `(day ${d.sendPlan.rampDay} of the warm-up)` : ''}.
                Sending it all at once would look like a spam run.</div>` : ''}
              ${d.heldCount ? `<div class="mm-notice">
                <b>${d.heldCount} contact${d.heldCount === 1 ? '' : 's'} held back</b> by the
                frequency cap, an open quote, or failed verification. They are excluded from
                the recipient count above, not silently dropped: see the list below.
                </div>
                <table class="mm-table" style="margin-bottom:14px">
                  <thead><tr><th>Company</th><th>Why held</th></tr></thead>
                  <tbody>${(d.held || []).map((h) => `<tr>
                    <td>${esc(h.company_name || h.email)}</td>
                    <td class="em">${esc(h.heldReason || '')}</td></tr>`).join('')}</tbody>
                </table>` : ''}
              <div class="mm-stat-row">
                <div class="mm-stat"><div class="v">${d.recipientCount}</div><div class="l">Recipients</div></div>
                <div class="mm-stat"><div class="v">${s.delivered || 0}</div><div class="l">Delivered</div></div>
                <div class="mm-stat"><div class="v">${s.replies || 0}</div><div class="l">Replies</div></div>
                <div class="mm-stat"><div class="v">${s.uniqueClicks || 0}</div><div class="l">Clicked (${pct(rates.clickRate || 0)})</div></div>
                <div class="mm-stat"><div class="v">${s.bounces || 0}</div><div class="l">Bounced (${pct(rates.bounceRate || 0)})</div></div>
                <div class="mm-stat"><div class="v">${s.complaints || 0}</div><div class="l">Complaints</div></div>
                <div class="mm-stat"><div class="v">${s.unsubscribes || 0}</div><div class="l">Unsubscribes</div></div>
              </div>
              <div class="hint" style="margin-bottom:14px">
                Replies and clicks lead here on purpose. Rates use UNIQUE people over
                delivered, so ${s.clicks || 0} total clicks from ${s.uniqueClicks || 0} people
                cannot inflate the figure.
              </div>
              <details style="margin-bottom:14px">
                <summary style="cursor:pointer;font-size:12.5px;color:var(--muted);font-weight:600">
                  Opens (${s.uniqueOpens || 0}, ${pct(rates.openRate || 0)}) &mdash; why these are unreliable
                </summary>
                <div class="hint" style="margin-top:8px">${esc(r.openRateCaveat || '')}</div>
              </details>
              ${(r.links || []).length ? `
                <h3 style="font-size:13px;font-weight:700;margin-bottom:8px">Links</h3>
                <table class="mm-table">
                  <thead><tr><th>URL</th><th class="num">Clicks</th><th class="num">Unique</th></tr></thead>
                  <tbody>${r.links.map((l) => `
                    <tr><td class="em">${esc(l.url)}</td>
                        <td class="num">${l.clicks}</td>
                        <td class="num">${l.uniqueClicks}</td></tr>`).join('')}</tbody>
                </table>` : ''}
              <div class="mm-actions" style="margin-top:14px">
                <button class="mm-btn ghost" id="mmCloseResults">Close</button>
              </div>
            </div>
          </div>`;
        $('#mmCloseResults').addEventListener('click', () => { box.hidden = true; box.innerHTML = ''; });
      } catch (e) {
        msg('#mmCampaignMsg', 'Could not load results: ' + esc(e.message), 'mm-err');
      }
    }

    function renderCampaignList() {
      $('#mmCampaignCount').textContent =
        state.campaigns.length + ' draft' + (state.campaigns.length === 1 ? '' : 's');

      if (!state.campaigns.length) {
        $('#mmCampaignList').innerHTML =
          '<div class="mm-empty"><h4>No drafts yet</h4>' +
          '<div>Start one to work out the wording and the segment. ' +
          'Nothing will send until sending is switched on.</div></div>';
        return;
      }

      $('#mmCampaignList').innerHTML = `
        <table class="mm-table">
          <thead><tr><th>Subject</th><th>Audience</th><th>Target</th>
            <th class="num">Recipients</th><th>Updated</th><th style="text-align:right"></th></tr></thead>
          <tbody>
            ${state.campaigns.map((c) => {
              const list = c.listId ? state.lists.find((l) => l.id === c.listId) : null;
              const src = SOURCE_META[c.source] || SOURCE_META.client;
              return `
              <tr>
                <td><div class="co">${esc(c.subject)}</div>
                    <div class="who">${esc(c.id)} · ${esc(c.status)}</div></td>
                <td><span class="pill src">${esc(src.label)}</span></td>
                <td class="em">${list ? esc(list.name)
                  : (c.segmentTags && c.segmentTags.length
                    ? c.segmentTags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')
                    : '<span class="tag-none">everyone mailable</span>')}</td>
                <td class="num">${c.recipientCount != null ? c.recipientCount : '—'}</td>
                <td class="em">${esc(fmtDate(c.updatedAt))}</td>
                <td style="text-align:right;white-space:nowrap">
                  <button class="mm-btn ghost sm" data-results="${esc(c.id)}">Results</button>
                  <button class="mm-btn ghost sm" data-edit="${esc(c.id)}">Edit</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;

      $('#mmCampaignList').querySelectorAll('[data-edit]').forEach((b) => {
        b.addEventListener('click', () => {
          const c = state.campaigns.find((x) => x.id === b.dataset.edit);
          if (!c) return;
          state.editingCampaign = { ...c, segmentTags: c.segmentTags || [] };
          renderComposer();
        });
      });
      $('#mmCampaignList').querySelectorAll('[data-results]').forEach((b) => {
        b.addEventListener('click', () => showResults(b.dataset.results));
      });
    }

    $('#mmNewCampaign').addEventListener('click', () => {
      state.editingCampaign = {
        subject: '', preheader: '', body: '',
        source: 'client', listId: null, segmentTags: []
      };
      renderComposer(); msg('#mmCampaignMsg', '', '');
    });

    /* ---------------- boot ---------------- */

    try {
      await Promise.all([loadContacts(), loadLists(), loadCampaigns(), loadSettings()]);
    } catch (e) {
      msg('#mmContactsMsg', 'Could not load contacts: ' + esc(e.message), 'mm-err');
      msg('#mmCampaignMsg', 'Could not load campaigns: ' + esc(e.message), 'mm-err');
    }

    renderDash();
    renderFilters();
    renderContactsTable();
    renderListTable();
    renderCampaignList();

    /* ---------------- settings ---------------- */

    async function loadSettings() {
      const d = await api.get(ENDPOINTS.mmSettings);
      state.settings = (d && d.settings) || null;
      state.blockers = (d && d.blockers) || [];
      state.footerPreview = (d && d.footerPreview) || '';
      state.coldCapToday = (d && d.coldCapToday) || 0;
    }

    function renderBlockers() {
      const box = $('#mmBlockers');
      if (!box) return;
      if (!state.blockers || !state.blockers.length) {
        box.innerHTML = '<div class="mm-notice"><b>Compliance looks complete.</b> ' +
          'Sending is still switched off in code until a provider and the sending ' +
          'domains are set up.</div>';
        return;
      }
      // These are hard blockers, not suggestions. CAN-SPAM requires a real
      // postal address and a working opt-out in every commercial message.
      box.innerHTML = '<div class="mm-notice danger"><b>Not legal to send yet.</b> ' +
        'Every commercial email needs these, and they are missing:<ul style="margin:8px 0 0 18px">' +
        state.blockers.map((b) => `<li>${esc(b.text)}</li>`).join('') + '</ul></div>';
    }

    function renderSettings() {
      const box = $('#mmSettingsForm');
      if (!box) return;
      const st = state.settings;
      if (!st) { box.innerHTML = '<div class="mm-empty">Could not load settings.</div>'; return; }

      const a = st.postalAddress || {};
      const p = st.policy || {};
      const r = st.reorder || {};

      box.innerHTML = `
        <div class="mm-card">
          <div class="mm-card-hd"><h3>Identity and compliance</h3>
            <span class="meta">Required before any send</span></div>
          <div class="mm-card-bd">
            <div class="mm-row">
              <div class="mm-field"><label for="setCompany">Company name</label>
                <input id="setCompany" type="text" value="${esc(st.companyName || '')}"></div>
              <div class="mm-field"><label for="setFromName">From name</label>
                <input id="setFromName" type="text" value="${esc(st.fromName || '')}"
                  placeholder="P&amp;M Apparel">
                <div class="hint">Shown as the sender. A person's name beside the shop's
                  usually outperforms the shop alone.</div></div>
            </div>
            <div class="mm-row">
              <div class="mm-field"><label for="setReplyMode">Replies go to</label>
                <select id="setReplyMode">
                  <option value="account-manager"${st.replyToMode === 'account-manager' ? ' selected' : ''}>The account manager</option>
                  <option value="fixed"${st.replyToMode === 'fixed' ? ' selected' : ''}>One fixed address</option>
                </select>
                <div class="hint">BackBone already knows who owns each account, so replies
                  can land with the right person automatically.</div></div>
              <div class="mm-field"><label for="setReplyFixed">Fixed reply-to</label>
                <input id="setReplyFixed" type="text" value="${esc(st.replyToFixed || '')}"
                  placeholder="hello@pmapparel.com">
                <div class="hint">Used when the mode above is fixed, or when an account has
                  no manager. Must be a monitored inbox: cold outreach gets replies.</div></div>
            </div>
            <div class="mm-field"><label for="setUnsub">Unsubscribe page URL</label>
              <input id="setUnsub" type="text" value="${esc(st.unsubscribeUrl || '')}"
                placeholder="https://alliteration-eight.vercel.app/unsubscribe.html">
              <div class="hint">The public page. Already built and deployed at
                /unsubscribe.html; paste its full address here.</div></div>
            <h3 style="font-size:13px;font-weight:700;margin:18px 0 8px">Postal address</h3>
            <div class="hint" style="margin-bottom:10px">
              Required by CAN-SPAM in every commercial email. This is the most commonly
              missed requirement, so nothing can send until it is filled in.
            </div>
            <div class="mm-row">
              <div class="mm-field"><label for="setLine1">Street</label>
                <input id="setLine1" type="text" value="${esc(a.line1 || '')}"></div>
              <div class="mm-field"><label for="setLine2">Suite / unit</label>
                <input id="setLine2" type="text" value="${esc(a.line2 || '')}"></div>
            </div>
            <div class="mm-row">
              <div class="mm-field"><label for="setCity">City</label>
                <input id="setCity" type="text" value="${esc(a.city || '')}"></div>
              <div class="mm-field"><label for="setState">State</label>
                <input id="setState" type="text" value="${esc(a.state || '')}"></div>
            </div>
            <div class="mm-field" style="max-width:220px"><label for="setZip">ZIP</label>
              <input id="setZip" type="text" value="${esc(a.postalCode || '')}"></div>
            ${state.footerPreview ? `<div class="mm-field"><label>Footer preview</label>
              <div class="mm-recip" style="white-space:pre-wrap">${esc(state.footerPreview)}</div></div>` : ''}
          </div>
        </div>

        <div class="mm-card">
          <div class="mm-card-hd"><h3>Sending limits</h3>
            <span class="meta">Protects the sending domains</span></div>
          <div class="mm-card-bd">
            <div class="hint" style="margin-bottom:12px">
              A new sending domain going from zero to hundreds of cold emails a day is
              itself a spam signal, so the cold cap climbs over the ramp period.
              Today's cold cap: <b>${state.coldCapToday}</b>.
            </div>
            <div class="mm-row">
              <div class="mm-field"><label for="setFreq">Days between emails to one person</label>
                <input id="setFreq" type="number" min="0" value="${p.minDaysBetweenEmails}">
                <div class="hint">Stops the same contact getting three campaigns in a week
                  because they match three lists.</div></div>
              <div class="mm-field"><label for="setClientCap">Client daily cap</label>
                <input id="setClientCap" type="number" min="1" value="${p.clientDailyCap}"></div>
            </div>
            <div class="mm-row">
              <div class="mm-field"><label for="setColdStart">Cold cap, day one</label>
                <input id="setColdStart" type="number" min="1" value="${p.coldDailyCapStart}"></div>
              <div class="mm-field"><label for="setColdMax">Cold cap, maximum</label>
                <input id="setColdMax" type="number" min="1" value="${p.coldDailyCapMax}"></div>
            </div>
            <div class="mm-field" style="max-width:260px"><label for="setRamp">Ramp length (days)</label>
              <input id="setRamp" type="number" min="1" value="${p.coldRampDays}"></div>
            <div class="mm-field">
              <label><input type="checkbox" id="setSkipQuotes" style="width:auto;margin-right:8px"
                ${p.skipOpenQuotes ? 'checked' : ''}>Skip accounts with an open quote</label>
              <div class="hint">Cold-blasting someone an AM is mid-deal with can cost the deal.</div>
            </div>
            <div class="mm-field">
              <label><input type="checkbox" id="setSkipInvalid" style="width:auto;margin-right:8px"
                ${p.skipInvalidVerification ? 'checked' : ''}>Skip addresses that failed verification</label>
              <div class="hint">Bought lists run 10-20% undeliverable, and providers throttle
                a sender at 2% bounce.</div>
            </div>
          </div>
        </div>

        <div class="mm-card">
          <div class="mm-card-hd"><h3>Reorder timing</h3>
            <span class="meta">Multiples of each customer's own cadence</span></div>
          <div class="mm-card-bd">
            <div class="hint" style="margin-bottom:12px">
              Thresholds are multiples of a customer's own median gap, not fixed days. A
              school ordering twice a year is not late at day 90; a contractor ordering
              fortnightly very much is.
            </div>
            <div class="mm-row">
              <div class="mm-field"><label for="setDue">Due at</label>
                <input id="setDue" type="number" step="0.1" min="0.1" value="${r.dueAt}"></div>
              <div class="mm-field"><label for="setOverdue">Overdue at</label>
                <input id="setOverdue" type="number" step="0.1" min="0.1" value="${r.overdueAt}"></div>
            </div>
            <div class="mm-row">
              <div class="mm-field"><label for="setLapsed">Lapsed at</label>
                <input id="setLapsed" type="number" step="0.1" min="0.1" value="${r.lapsedAt}"></div>
              <div class="mm-field"><label for="setMinOrders">Minimum orders to judge</label>
                <input id="setMinOrders" type="number" min="1" value="${r.minOrders}"></div>
            </div>
            <div class="mm-actions">
              <button class="mm-btn" id="mmSaveSettings">Save settings</button>
            </div>
          </div>
        </div>`;

      $('#mmSaveSettings').addEventListener('click', saveSettings);
    }

    async function saveSettings() {
      const val = (id) => $('#' + id).value;
      const numv = (id) => Number($('#' + id).value);
      const payload = {
        companyName: val('setCompany'),
        fromName: val('setFromName'),
        replyToMode: val('setReplyMode'),
        replyToFixed: val('setReplyFixed'),
        unsubscribeUrl: val('setUnsub'),
        postalAddress: {
          line1: val('setLine1'), line2: val('setLine2'), city: val('setCity'),
          state: val('setState'), postalCode: val('setZip')
        },
        policy: {
          minDaysBetweenEmails: numv('setFreq'),
          clientDailyCap: numv('setClientCap'),
          coldDailyCapStart: numv('setColdStart'),
          coldDailyCapMax: numv('setColdMax'),
          coldRampDays: numv('setRamp'),
          skipOpenQuotes: $('#setSkipQuotes').checked,
          skipInvalidVerification: $('#setSkipInvalid').checked
        },
        reorder: {
          dueAt: numv('setDue'), overdueAt: numv('setOverdue'),
          lapsedAt: numv('setLapsed'), minOrders: numv('setMinOrders'),
          minGapDays: (state.settings.reorder || {}).minGapDays
        }
      };
      try {
        const d = await api.patch(ENDPOINTS.mmSettings, payload);
        state.settings = d.settings;
        state.blockers = d.blockers || [];
        state.footerPreview = d.footerPreview || '';
        renderBlockers(); renderSettings();
        msg('#mmSettingsMsg', 'Settings saved.', 'mm-ok');
      } catch (e) {
        msg('#mmSettingsMsg', 'Could not save: ' + esc(e.message), 'mm-err');
      }
    }

    /* ---------------- refresh ---------------- */

    // WHY THIS EXISTS. mount() runs once; showView() runs on every visit. If
    // the view renders only repaint whatever mount() loaded, the numbers rot:
    // tag a contact, come back to Lists, and a dynamic list still shows its
    // old member count. Worse, a list created on the Lists screen would be
    // missing from the campaign composer's dropdown until the whole app was
    // remounted, which looks like the save silently failed.
    //
    // So each view REFETCHES what it actually shows on entry, and there is a
    // manual Refresh alongside a stamp saying how current the numbers are.
    // Same reasoning as BackBone's "Data through" stamp: a number with no
    // freshness indicator gets trusted long after it stopped being true.

    const VIEW_LOADERS = {
      // Dashboard reads contact counts only.
      dashboard: [loadContacts],
      // Contacts needs its own rows; list counts do not appear here.
      contacts: [loadContacts],
      // Lists shows live member counts, which depend on contacts.
      lists: [loadContacts, loadLists],
      // Import compares against existing contacts to flag duplicates.
      import: [loadContacts],
      // The composer's dropdown is built from lists, so both are needed.
      campaigns: [loadContacts, loadLists, loadCampaigns],
      settings: [loadSettings]
    };

    function stampText() {
      if (!state.lastLoaded) return '';
      const secs = Math.round((Date.now() - state.lastLoaded) / 1000);
      if (secs < 45) return 'Updated just now';
      const mins = Math.round(secs / 60);
      if (mins < 60) return 'Updated ' + mins + ' min ago';
      return 'Updated ' + new Date(state.lastLoaded).toLocaleTimeString();
    }

    function paintStamps() {
      root.querySelectorAll('[data-mm-stamp]').forEach((el) => {
        el.textContent = state.refreshing ? 'Refreshing...' : stampText();
      });
      root.querySelectorAll('[data-mm-refresh]').forEach((b) => {
        b.disabled = state.refreshing;
      });
    }

    // Repaint a view from whatever is already in state, without fetching.
    const REPAINT = {
      dashboard: () => renderDash(),
      contacts: () => { renderFilters(); renderContactsTable(); },
      lists: () => {
        // Do NOT re-render the editor while it is open: it rebuilds its
        // inputs from state, which would wipe out anything half-typed.
        if (!state.editingList) renderListEditor();
        renderListTable();
      },
      import: () => {},
      campaigns: () => {
        if (!state.editingCampaign) renderComposer();
        renderCampaignList();
      },
      settings: () => { renderBlockers(); renderSettings(); }
    };

    async function refreshView(view, opts) {
      const loaders = VIEW_LOADERS[view] || [];
      // Repaint immediately so switching views feels instant, then update
      // once the fetch lands.
      if (REPAINT[view]) REPAINT[view]();

      if (!loaders.length || state.refreshing) { paintStamps(); return; }

      state.refreshing = true;
      paintStamps();
      try {
        await Promise.all(loaders.map((fn) => fn()));
        state.lastLoaded = Date.now();
        if (REPAINT[view]) REPAINT[view]();
        if (opts && opts.announce) {
          msg(opts.announce, 'Refreshed.', 'mm-ok');
        }
      } catch (e) {
        // A failed refresh must not blank the screen: the previous numbers
        // are stale but still better than nothing, and the stamp will say so.
        if (opts && opts.announce) {
          msg(opts.announce, 'Could not refresh: ' + esc(e.message), 'mm-err');
        }
      } finally {
        state.refreshing = false;
        paintStamps();
      }
    }
    this._refreshView = refreshView;

    root.querySelectorAll('[data-mm-refresh]').forEach((b) => {
      b.addEventListener('click', () => {
        const view = b.dataset.mmRefresh;
        refreshView(view, { announce: MSG_TARGET[view] });
      });
    });

    // Keep the stamp honest while someone sits on a screen: the text is
    // relative ("2 min ago"), so it has to tick even when nothing refetches.
    this._stampTimer = setInterval(paintStamps, 30000);

    state.lastLoaded = Date.now();
    paintStamps();

    // Exposed so showView() can refresh and repaint a pane on each visit
    // without re-running mount(), matching TravelTrack's pattern.
    this._renders = {
      dashboard: () => refreshView('dashboard'),
      contacts: () => refreshView('contacts'),
      lists: () => refreshView('lists'),
      import: () => refreshView('import'),
      campaigns: () => refreshView('campaigns'),
      settings: () => refreshView('settings')
    };
  },

  showView(view) {
    const root = this._root;
    if (!root) return;
    const ids = {
      dashboard: 'mmDash', contacts: 'mmContactsView', lists: 'mmListsView',
      import: 'mmImportView', campaigns: 'mmCampaignsView',
      settings: 'mmSettingsView'
    };
    Object.entries(ids).forEach(([v, id]) => {
      const el = root.querySelector('#' + id);
      if (el) el.hidden = v !== view;
    });
    if (this._renders && this._renders[view]) this._renders[view]();
  },

  unmount() {
    // No document-level listeners, but the stamp ticker is a real interval
    // and would keep firing against a detached root forever.
    if (this._stampTimer) {
      clearInterval(this._stampTimer);
      this._stampTimer = null;
    }
  }
};
