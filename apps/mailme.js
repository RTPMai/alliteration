/**
 * MailMe — email marketing.
 *
 * Built fresh (no standalone predecessor to port). Three views:
 *
 *   Dashboard  list health at a glance: mailable, unsubscribed, bounced,
 *              and how much of the roster has no email on file at all.
 *   Contacts   the BackBone roster joined with subscribe state and tags.
 *   Campaigns  draft composer with a live recipient count.
 *
 * THE CONTACT LIST IS NOT STORED HERE. It is resolved server-side from
 * backbone_data every time (see lib/mailme/store.js resolveContacts). MailMe
 * stores only what BackBone has no concept of: subscribe status and tags.
 * The practical effect is that there is no "import contacts" button and no
 * list that can drift out of date against the roster.
 *
 * SENDING IS NOT WIRED. Campaigns save as drafts and the API refuses any
 * status but "draft". The UI says so plainly rather than showing a Send
 * button that fails, because a marketing tool where you are unsure whether
 * something went out is worse than one that clearly cannot send yet. See the
 * header comment in api/mailme/campaigns.js for the three prerequisites.
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

// Status presentation. Kept as one table so the pill, the dashboard tile and
// the filter buttons can never disagree about what a status is called.
const STATUS_META = {
  subscribed:  { label: 'Subscribed',  cls: 'ok' },
  unsubscribed:{ label: 'Unsubscribed',cls: 'warn' },
  bounced:     { label: 'Bounced',     cls: 'bad' },
  complained:  { label: 'Complained',  cls: 'bad' }
};

const SUPPRESSED = ['unsubscribed', 'bounced', 'complained'];

export default {
  id: 'mailme',

  styles: `
  .mm-page{padding:24px 32px 60px}
  .mm-hd{display:flex;justify-content:space-between;align-items:flex-start;
    margin-bottom:20px;flex-wrap:wrap;gap:12px}
  .mm-hd h1{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .mm-hd .sub{font-size:13px;color:var(--muted);margin-top:3px}

  .mm-notice{
    background:var(--warn-tint);border:1px solid var(--warn-tint);
    border-left:3px solid var(--warn);border-radius:var(--radius-sm);
    padding:11px 14px;font-size:12.5px;color:var(--warn-dk);
    line-height:1.55;margin-bottom:18px;
  }
  .mm-notice b{font-weight:700}

  /* ---------- tiles ---------- */
  .mm-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
    gap:14px;margin-bottom:22px}
  .mm-tile{background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-md);padding:16px 18px}
  .mm-tile .v{font-size:26px;font-weight:800;letter-spacing:-.02em;line-height:1.1}
  .mm-tile .l{font-size:12px;color:var(--muted);margin-top:5px;font-weight:600}
  .mm-tile .n{font-size:11.5px;color:var(--faint);margin-top:3px;line-height:1.45}
  .mm-tile.ok .v{color:var(--success-dk)}
  .mm-tile.warn .v{color:var(--warn-dk)}
  .mm-tile.bad .v{color:var(--danger-dk)}

  /* ---------- card ---------- */
  .mm-card{background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-md);margin-bottom:18px;overflow:hidden}
  .mm-card-hd{display:flex;justify-content:space-between;align-items:center;
    padding:14px 18px;border-bottom:1px solid var(--line-soft);gap:12px;flex-wrap:wrap}
  .mm-card-hd h3{font-size:14px;font-weight:700}
  .mm-card-hd .meta{font-size:12px;color:var(--muted)}
  .mm-card-bd{padding:18px}

  /* ---------- filters ---------- */
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
  .mm-search{flex:1;min-width:180px;max-width:320px;padding:7px 11px;
    border:1px solid var(--line);border-radius:var(--radius-sm);
    font-family:inherit;font-size:13px;color:var(--ink);background:var(--card)}
  .mm-search:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}

  /* ---------- table ---------- */
  .mm-table{width:100%;border-collapse:collapse;font-size:13px}
  .mm-table th{text-align:left;font-size:11px;text-transform:uppercase;
    letter-spacing:.05em;color:var(--muted);font-weight:700;padding:9px 12px;
    background:var(--head-bg);border-bottom:1px solid var(--line);white-space:nowrap}
  .mm-table td{padding:10px 12px;border-bottom:1px solid var(--line-soft);
    vertical-align:middle}
  .mm-table tr:hover td{background:var(--row-hover)}
  .mm-table .co{font-weight:600;color:var(--ink)}
  .mm-table .em{color:var(--muted);font-size:12.5px}
  .mm-table .who{color:var(--faint);font-size:12px}

  .pill{display:inline-block;padding:2px 9px;border-radius:var(--radius-pill);
    font-size:11px;font-weight:700;white-space:nowrap}
  .pill.ok{background:var(--success-tint);color:var(--success-dk)}
  .pill.warn{background:var(--warn-tint);color:var(--warn-dk)}
  .pill.bad{background:var(--danger-tint);color:var(--danger-dk)}

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

  /* ---------- composer ---------- */
  .mm-field{margin-bottom:14px}
  .mm-field label{display:block;font-size:11px;text-transform:uppercase;
    letter-spacing:.05em;color:var(--muted);font-weight:700;margin-bottom:5px}
  .mm-field input,.mm-field textarea{width:100%;padding:9px 11px;
    border:1px solid var(--line);border-radius:var(--radius-sm);
    font-family:inherit;font-size:13px;color:var(--ink);background:var(--card)}
  .mm-field textarea{min-height:170px;resize:vertical;line-height:1.6}
  .mm-field input:focus,.mm-field textarea:focus{outline:2px solid var(--accent);
    outline-offset:-1px;border-color:var(--accent)}
  .mm-field .hint{font-size:11.5px;color:var(--faint);margin-top:4px;line-height:1.5}

  .mm-recip{background:var(--accent-tint);border-radius:var(--radius-sm);
    padding:11px 14px;font-size:12.5px;color:var(--accent-deep);
    font-weight:600;margin-bottom:14px;line-height:1.5}

  .mm-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

  .mm-empty{text-align:center;padding:34px 20px;color:var(--muted);font-size:13px;
    line-height:1.6}
  .mm-empty h4{font-size:14px;color:var(--ink);margin-bottom:6px;font-weight:700}

  .mm-err{background:var(--danger-tint);border:1px solid var(--danger-line);
    border-radius:var(--radius-sm);padding:11px 14px;font-size:12.5px;
    color:var(--danger-dk);margin-bottom:14px;line-height:1.5}

  .mm-ok{background:var(--success-tint);border-radius:var(--radius-sm);
    padding:11px 14px;font-size:12.5px;color:var(--success-dk);
    margin-bottom:14px;font-weight:600}
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
        </div>
        <div class="mm-notice" id="mmSendNotice"></div>
        <div class="mm-tiles" id="mmTiles"></div>
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>Where this list comes from</h3>
            <span class="meta">BackBone roster</span>
          </div>
          <div class="mm-card-bd">
            <p style="font-size:13px;color:var(--muted);line-height:1.65;margin:0">
              MailMe does not keep its own contact list. Every contact here is a
              BackBone customer with an email on file, resolved fresh each time
              this page loads. Fix an email in BackBone and it is fixed here.
              MailMe stores only what BackBone has no field for: whether someone
              unsubscribed, and any tags you have put them in.
            </p>
          </div>
        </div>
      </section>

      <!-- Contacts -->
      <section id="mmContacts" hidden>
        <div class="mm-hd">
          <div>
            <h1>Contacts<span class="dot">.</span></h1>
            <div class="sub" id="mmContactsSub"></div>
          </div>
        </div>
        <div id="mmContactsMsg"></div>
        <div class="mm-filters" id="mmContactFilters"></div>
        <div class="mm-card">
          <div class="mm-card-bd" style="padding:0">
            <div id="mmContactsTable"></div>
          </div>
        </div>
      </section>

      <!-- Campaigns -->
      <section id="mmCampaigns" hidden>
        <div class="mm-hd">
          <div>
            <h1>Campaigns<span class="dot">.</span></h1>
            <div class="sub">Drafts. Sending is not switched on yet.</div>
          </div>
          <button class="mm-btn" id="mmNewCampaign">New draft</button>
        </div>
        <div id="mmCampaignMsg"></div>
        <div id="mmComposer" hidden></div>
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>Saved drafts</h3>
            <span class="meta" id="mmCampaignCount"></span>
          </div>
          <div class="mm-card-bd" style="padding:0">
            <div id="mmCampaignList"></div>
          </div>
        </div>
      </section>
    </div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);
    const api = ctx.api;

    this._root = root;

    // ---- state ----
    const state = {
      contacts: [],
      tags: [],
      customersWithoutEmail: 0,
      totalRosterSize: 0,
      campaigns: [],
      filter: 'all',
      search: '',
      editing: null,      // campaign being composed, or null
      loaded: false
    };
    this._state = state;

    /* ------------------------------------------------------------------ *
     * DATA
     * ------------------------------------------------------------------ */

    async function loadContacts() {
      const d = await api.get(ENDPOINTS.mmContacts);
      state.contacts = Array.isArray(d && d.contacts) ? d.contacts : [];
      state.tags = Array.isArray(d && d.tags) ? d.tags : [];
      state.customersWithoutEmail = (d && d.customersWithoutEmail) || 0;
      state.totalRosterSize = (d && d.totalRosterSize) || 0;
    }

    async function loadCampaigns() {
      const d = await api.get(ENDPOINTS.mmCampaigns);
      state.campaigns = Array.isArray(d && d.campaigns) ? d.campaigns : [];
    }

    const counts = () => {
      const c = { subscribed: 0, unsubscribed: 0, bounced: 0, complained: 0 };
      state.contacts.forEach((x) => { if (c[x.status] !== undefined) c[x.status]++; });
      return c;
    };

    const mailable = () => state.contacts.filter((c) => !SUPPRESSED.includes(c.status));

    /* ------------------------------------------------------------------ *
     * DASHBOARD
     * ------------------------------------------------------------------ */

    function renderDash() {
      const c = counts();
      const total = state.contacts.length;

      $('#mmSendNotice').innerHTML =
        '<b>Sending is not switched on.</b> Campaigns save as drafts only. ' +
        'Before real email can go out this needs a sending provider account, ' +
        'a sending domain authenticated with SPF, DKIM and DMARC, and the ' +
        'unsubscribe page wired up. Until then nothing here can email anyone.';

      const tiles = [
        { v: c.subscribed, l: 'Mailable', cls: 'ok',
          n: total ? Math.round((c.subscribed / total) * 100) + '% of contacts with an email' : '' },
        { v: c.unsubscribed, l: 'Unsubscribed', cls: c.unsubscribed ? 'warn' : '',
          n: 'Opted out. Never included in a send.' },
        { v: c.bounced + c.complained, l: 'Bounced or complained', cls: (c.bounced + c.complained) ? 'bad' : '',
          n: 'Set by the mail provider, not by hand.' },
        { v: state.customersWithoutEmail, l: 'No email on file', cls: '',
          n: 'Roster customers MailMe cannot reach. Add an email in BackBone.' }
      ];

      $('#mmTiles').innerHTML = tiles.map((t) => `
        <div class="mm-tile ${t.cls}">
          <div class="v">${esc(t.v)}</div>
          <div class="l">${esc(t.l)}</div>
          <div class="n">${esc(t.n)}</div>
        </div>`).join('');
    }

    /* ------------------------------------------------------------------ *
     * CONTACTS
     * ------------------------------------------------------------------ */

    function visibleContacts() {
      const q = state.search.trim().toLowerCase();
      return state.contacts.filter((c) => {
        if (state.filter === 'mailable' && SUPPRESSED.includes(c.status)) return false;
        if (state.filter !== 'all' && state.filter !== 'mailable' && c.status !== state.filter) return false;
        if (!q) return true;
        return (c.company_name + ' ' + c.email + ' ' + c.contact_name + ' ' + c.tags.join(' '))
          .toLowerCase().includes(q);
      });
    }

    function renderFilters() {
      const c = counts();
      const opts = [
        ['all', 'All', state.contacts.length],
        ['mailable', 'Mailable', c.subscribed],
        ['unsubscribed', 'Unsubscribed', c.unsubscribed],
        ['bounced', 'Bounced', c.bounced]
      ];
      $('#mmContactFilters').innerHTML =
        opts.map(([k, label, n]) =>
          `<button class="mm-filt" data-filt="${k}" aria-pressed="${state.filter === k}">
             ${esc(label)}<span class="n">${n}</span></button>`).join('') +
        `<input class="mm-search" id="mmSearch" type="search"
                placeholder="Search company, email or tag" value="${esc(state.search)}">`;

      $('#mmContactFilters').querySelectorAll('[data-filt]').forEach((b) => {
        b.addEventListener('click', () => {
          state.filter = b.dataset.filt;
          renderFilters();
          renderContactsTable();
        });
      });

      const search = $('#mmSearch');
      search.addEventListener('input', (e) => {
        state.search = e.target.value;
        renderContactsTable();
      });
    }

    function renderContactsTable() {
      const rows = visibleContacts();
      $('#mmContactsSub').textContent =
        state.contacts.length + ' contact' + (state.contacts.length === 1 ? '' : 's') +
        ' from a roster of ' + state.totalRosterSize +
        (state.customersWithoutEmail ? ' · ' + state.customersWithoutEmail + ' with no email' : '');

      if (!rows.length) {
        $('#mmContactsTable').innerHTML =
          '<div class="mm-empty"><h4>Nothing matches</h4>' +
          '<div>Try a different filter or search.</div></div>';
        return;
      }

      $('#mmContactsTable').innerHTML = `
        <table class="mm-table">
          <thead>
            <tr>
              <th>Company</th><th>Email</th><th>Status</th>
              <th>Tags</th><th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((c) => {
              const meta = STATUS_META[c.status] || STATUS_META.subscribed;
              const locked = c.status === 'bounced' || c.status === 'complained';
              return `
              <tr>
                <td>
                  <div class="co">${esc(c.company_name)}</div>
                  ${c.contact_name ? `<div class="who">${esc(c.contact_name)}</div>` : ''}
                </td>
                <td class="em">${esc(c.email)}</td>
                <td>
                  <span class="pill ${meta.cls}">${esc(meta.label)}</span>
                  ${c.reason ? `<div class="who" style="margin-top:3px">${esc(c.reason)}</div>` : ''}
                </td>
                <td>
                  ${c.tags.length
                    ? c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')
                    : '<span class="tag-none">none</span>'}
                </td>
                <td style="text-align:right;white-space:nowrap">
                  ${locked
                    ? '<span class="who">provider-set</span>'
                    : `<button class="mm-btn ghost sm" data-toggle="${esc(c.customer_id)}">
                         ${c.status === 'unsubscribed' ? 'Resubscribe' : 'Unsubscribe'}
                       </button>`}
                  <button class="mm-btn ghost sm" data-tags="${esc(c.customer_id)}">Tags</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;

      $('#mmContactsTable').querySelectorAll('[data-toggle]').forEach((b) => {
        b.addEventListener('click', () => toggleSub(b.dataset.toggle));
      });
      $('#mmContactsTable').querySelectorAll('[data-tags]').forEach((b) => {
        b.addEventListener('click', () => editTags(b.dataset.tags));
      });
    }

    function contactMsg(html, cls) {
      $('#mmContactsMsg').innerHTML = html ? `<div class="${cls}">${html}</div>` : '';
    }

    async function toggleSub(id) {
      const c = state.contacts.find((x) => String(x.customer_id) === String(id));
      if (!c) return;

      let payload;
      if (c.status === 'unsubscribed') {
        payload = { customer_id: id, status: 'subscribed' };
      } else {
        // Capturing WHY someone opted out is the whole reason MailMe keeps a
        // reason field: providers report the unsubscribe but not the cause.
        const reason = window.prompt(
          'Unsubscribe ' + c.company_name + '.\n\nReason (optional, for your own reporting):', '');
        if (reason === null) return;   // cancelled
        payload = { customer_id: id, status: 'unsubscribed', reason };
      }

      try {
        await api.patch(ENDPOINTS.mmContacts, payload);
        await loadContacts();
        renderFilters();
        renderContactsTable();
        renderDash();
        contactMsg('Updated ' + esc(c.company_name) + '.', 'mm-ok');
      } catch (e) {
        contactMsg('Could not update: ' + esc(e.message), 'mm-err');
      }
    }

    async function editTags(id) {
      const c = state.contacts.find((x) => String(x.customer_id) === String(id));
      if (!c) return;
      const next = window.prompt(
        'Tags for ' + c.company_name + '.\n\nComma separated. These are your segments, ' +
        'so a campaign can go to just this group.',
        c.tags.join(', '));
      if (next === null) return;

      const tags = next.split(',').map((t) => t.trim()).filter(Boolean);
      try {
        await api.patch(ENDPOINTS.mmContacts, { customer_id: id, tags });
        await loadContacts();
        renderFilters();
        renderContactsTable();
        contactMsg('Tags updated for ' + esc(c.company_name) + '.', 'mm-ok');
      } catch (e) {
        contactMsg('Could not update tags: ' + esc(e.message), 'mm-err');
      }
    }

    /* ------------------------------------------------------------------ *
     * CAMPAIGNS
     * ------------------------------------------------------------------ */

    function campaignMsg(html, cls) {
      $('#mmCampaignMsg').innerHTML = html ? `<div class="${cls}">${html}</div>` : '';
    }

    // Recipient preview, computed client-side with the SAME rule the server
    // uses (suppression first, then tags). It is a preview only; the server
    // recomputes before any send would ever happen.
    function previewRecipients(segmentTags) {
      const base = mailable();
      if (!segmentTags || !segmentTags.length) return base;
      // Normalized the same way lib/mailme/schema.js selectRecipients does.
      // If these two drifted, the count shown here would not match who
      // actually received the email, which is the kind of mismatch nobody
      // notices until after a send.
      const want = new Set(
        segmentTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean));
      if (!want.size) return base;
      return base.filter((c) => Array.isArray(c.tags) &&
        c.tags.some((t) => want.has(String(t).trim().toLowerCase())));
    }

    function renderComposer() {
      const box = $('#mmComposer');
      if (!state.editing) { box.hidden = true; box.innerHTML = ''; return; }

      const d = state.editing;
      const recips = previewRecipients(d.segmentTags);

      box.hidden = false;
      box.innerHTML = `
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>${d.id ? 'Edit draft ' + esc(d.id) : 'New draft'}</h3>
            <span class="meta">Saved as a draft. Nothing sends.</span>
          </div>
          <div class="mm-card-bd">
            <div class="mm-recip" id="mmRecipCount"></div>
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
              <label for="mmSegment">Send to</label>
              <input id="mmSegment" type="text" value="${esc((d.segmentTags || []).join(', '))}"
                     placeholder="Leave blank for everyone mailable">
              <div class="hint">
                Comma-separated tags. A contact matching any one of them is included.
                ${state.tags.length ? 'Tags in use: ' + esc(state.tags.join(', ')) : 'No tags created yet.'}
              </div>
            </div>
            <div class="mm-field">
              <label for="mmBody">Body</label>
              <textarea id="mmBody" placeholder="Write the email here.">${esc(d.body)}</textarea>
              <div class="hint">
                {{first_name}} and {{company_name}} will fill in per recipient once sending is wired.
              </div>
            </div>
            <div class="mm-actions">
              <button class="mm-btn" id="mmSaveDraft">Save draft</button>
              <button class="mm-btn ghost" id="mmCancelDraft">Cancel</button>
              ${d.id ? '<button class="mm-btn ghost" id="mmDeleteDraft">Delete</button>' : ''}
            </div>
          </div>
        </div>`;

      const updateRecipLine = () => {
        const tags = $('#mmSegment').value.split(',').map((t) => t.trim()).filter(Boolean);
        const n = previewRecipients(tags).length;
        const suppressed = state.contacts.length - mailable().length;
        $('#mmRecipCount').textContent =
          n + ' recipient' + (n === 1 ? '' : 's') +
          (tags.length ? ' matching ' + tags.join(', ') : ' (everyone mailable)') +
          (suppressed ? ' · ' + suppressed + ' suppressed and excluded' : '');
      };
      updateRecipLine();
      $('#mmSegment').addEventListener('input', updateRecipLine);

      $('#mmSaveDraft').addEventListener('click', saveDraft);
      $('#mmCancelDraft').addEventListener('click', () => {
        state.editing = null;
        renderComposer();
      });
      const del = $('#mmDeleteDraft');
      if (del) del.addEventListener('click', () => deleteDraft(d.id));

      void recips;
    }

    async function saveDraft() {
      const d = state.editing;
      const payload = {
        subject: $('#mmSubject').value,
        preheader: $('#mmPreheader').value,
        body: $('#mmBody').value,
        segmentTags: $('#mmSegment').value.split(',').map((t) => t.trim()).filter(Boolean)
      };

      if (!payload.subject.trim() || !payload.body.trim()) {
        campaignMsg('A draft needs both a subject and a body.', 'mm-err');
        return;
      }

      try {
        if (d.id) {
          await api.patch(ENDPOINTS.mmCampaigns, { id: d.id, ...payload });
        } else {
          await api.post(ENDPOINTS.mmCampaigns, payload);
        }
        state.editing = null;
        await loadCampaigns();
        renderComposer();
        renderCampaignList();
        campaignMsg('Draft saved.', 'mm-ok');
      } catch (e) {
        campaignMsg('Could not save: ' + esc(e.message), 'mm-err');
      }
    }

    async function deleteDraft(id) {
      if (!window.confirm('Delete this draft?')) return;
      try {
        // del() takes options, not a body — the id rides as a query param.
        await api.del(ENDPOINTS.mmCampaigns, { query: { id } });
        state.editing = null;
        await loadCampaigns();
        renderComposer();
        renderCampaignList();
        campaignMsg('Draft deleted.', 'mm-ok');
      } catch (e) {
        campaignMsg('Could not delete: ' + esc(e.message), 'mm-err');
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
          <thead>
            <tr><th>Subject</th><th>Segment</th><th>Recipients</th>
                <th>Updated</th><th style="text-align:right"></th></tr>
          </thead>
          <tbody>
            ${state.campaigns.map((c) => {
              const n = previewRecipients(c.segmentTags).length;
              return `
              <tr>
                <td>
                  <div class="co">${esc(c.subject)}</div>
                  <div class="who">${esc(c.id)} · ${esc(c.status)}</div>
                </td>
                <td>${(c.segmentTags && c.segmentTags.length)
                  ? c.segmentTags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')
                  : '<span class="tag-none">everyone mailable</span>'}</td>
                <td>${n}</td>
                <td class="em">${esc(fmtDate(c.updatedAt))}</td>
                <td style="text-align:right">
                  <button class="mm-btn ghost sm" data-edit="${esc(c.id)}">Edit</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;

      $('#mmCampaignList').querySelectorAll('[data-edit]').forEach((b) => {
        b.addEventListener('click', () => {
          const c = state.campaigns.find((x) => x.id === b.dataset.edit);
          if (!c) return;
          state.editing = { ...c, segmentTags: c.segmentTags || [] };
          renderComposer();
        });
      });
    }

    $('#mmNewCampaign').addEventListener('click', () => {
      state.editing = { subject: '', preheader: '', body: '', segmentTags: [] };
      renderComposer();
      campaignMsg('', '');
    });

    /* ------------------------------------------------------------------ *
     * BOOT
     * ------------------------------------------------------------------ */

    try {
      await Promise.all([loadContacts(), loadCampaigns()]);
      state.loaded = true;
    } catch (e) {
      // A failed load must not leave blank panes with no explanation.
      contactMsg('Could not load contacts: ' + esc(e.message), 'mm-err');
      campaignMsg('Could not load campaigns: ' + esc(e.message), 'mm-err');
    }

    renderDash();
    renderFilters();
    renderContactsTable();
    renderCampaignList();

    // Exposed so showView() can re-render a pane on each visit without
    // re-running mount(), matching TravelTrack's pattern.
    this._renders = {
      dashboard: renderDash,
      contacts: () => { renderFilters(); renderContactsTable(); },
      campaigns: renderCampaignList
    };
  },

  showView(view) {
    const root = this._root;
    if (!root) return;
    const ids = { dashboard: 'mmDash', contacts: 'mmContacts', campaigns: 'mmCampaigns' };
    Object.entries(ids).forEach(([v, id]) => {
      const el = root.querySelector('#' + id);
      if (el) el.hidden = v !== view;
    });
    if (this._renders && this._renders[view]) this._renders[view]();
  },

  unmount() {
    // No document-level listeners were attached; nothing to tear down.
  }
};
