/**
 * ErrorEngine — quality/accountability layer. Logs production errors, attributes
 * root cause and owner, quantifies cost, surfaces patterns.
 *
 * PORTED from the standalone app (public/index.html). What changed and why:
 *
 *   - The header, tabs and logout came off. The shell has one header, the rail
 *     carries the nav, and auth is shell-level (one login, one cookie).
 *   - :root and the global reset came off. tokens.css and shell.css own those.
 *     Every color below is a token — no hex values outside tokens.css.
 *   - document.getElementById became a root-scoped lookup. Several apps are
 *     mounted at once, so a document-wide search could find another app's node.
 *   - fetch() became ctx.api + ENDPOINTS. Route moves from the standalone:
 *       /api/intake     -> ENDPOINTS.eeErrors     (/api/errors)
 *       /api/customers  -> ENDPOINTS.eeCustomers  (/api/errorengine/customers)
 *       /api/taxonomy   -> ENDPOINTS.eeTaxonomy   (/api/taxonomy, unchanged)
 *   - The Settings tab's USER MANAGEMENT is gone: the shell's Settings screen
 *     owns users now. The tab's other half, Manage Lists (+ the fusion price
 *     list), stays as this app's "lists" view, gated by the server's can_edit
 *     flag from /api/taxonomy.
 *   - The LIVE/demo probe is gone. The seam decides live vs sample data.
 *   - Tabs became registry views: dashboard / log / records / lists. The detail
 *     screen stays internal to the records view (opened by row click), exactly
 *     like the old app, so it needs no route plumbing.
 *
 * The four sections and all their logic are otherwise a faithful port.
 */

import { ENDPOINTS } from '../js/api.js';

// mount() installs the real section switcher here; showView() below delegates.
let showSectionRef = null;

export default {
  id: 'errorengine',

  styles: `
  .page { padding: 24px 32px 60px; max-width: 1400px; }

  /* Cards / stats */
  .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; margin-bottom: 24px; }
  .stat {
    background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 18px 20px;
  }
  .stat .label { font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat .value { font-size: 30px; font-weight: 800; letter-spacing: -0.02em; margin-top: 6px; }
  .stat .value.green { color: var(--success); }
  .stat .value.purple { color: var(--accent); }

  .panel {
    background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 22px 24px; margin-bottom: 20px;
  }
  .panel h2 { font-size: 15px; font-weight: 700; margin-bottom: 16px; }
  .dash-controls { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
  .dash-controls label { font-size: 13px; font-weight: 600; color: var(--muted); }
  .dash-controls select { font-family: inherit; font-size: 14px; padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--card); font-weight: 600; }
  .dash-controls select:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
  .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 10px; }
  .panel-head h2 { margin-bottom: 0; }
  .toggle { display: inline-flex; border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: hidden; }
  .tog { background: var(--card); border: none; padding: 6px 14px; font-size: 13px; font-weight: 600; color: var(--muted); cursor: pointer; font-family: inherit; }
  .tog.active { background: var(--accent); color: var(--on-accent); }

  /* Breakdown bars */
  .bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; font-size: 13px; }
  .bar-row .k { width: 150px; color: var(--muted); flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; height: 8px; background: var(--bg); border-radius: 5px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--accent); border-radius: 5px; }
  .bar-row .v { width: 34px; text-align: right; font-weight: 600; flex: none; }

  /* Form */
  form { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field.full { grid-column: 1 / -1; }
  label { font-size: 13px; font-weight: 600; }
  label .req { color: var(--accent); }
  input, select, textarea {
    font-family: inherit; font-size: 14px; padding: 10px 12px;
    border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--card); color: var(--ink);
  }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
  textarea { resize: vertical; min-height: 76px; }
  .combo { position: relative; }
  .combo-list {
    position: absolute; top: 100%; left: 0; right: 0; z-index: 20;
    background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-sm);
    margin-top: 4px; max-height: 220px; overflow-y: auto;
    box-shadow: var(--shadow-pop); display: none;
  }
  .combo-list.open { display: block; }
  .combo-item { padding: 9px 12px; font-size: 14px; cursor: pointer; }
  .combo-item:hover, .combo-item.active { background: var(--accent-tint); color: var(--accent-deep); }
  .combo-empty { padding: 9px 12px; font-size: 13px; color: var(--muted); }
  .actions { grid-column: 1 / -1; display: flex; gap: 12px; align-items: center; }
  button.primary {
    background: var(--accent); color: var(--on-accent); border: none; padding: 11px 22px;
    border-radius: var(--radius-sm); font-weight: 700; font-size: 14px; cursor: pointer; font-family: inherit;
  }
  button.primary:hover { background: var(--accent-deep); }
  .msg { font-size: 13px; font-weight: 600; }
  .msg.ok { color: var(--success); }
  .msg.err { color: var(--danger); }

  /* Table */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--line); font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
  td { padding: 11px 10px; border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: var(--radius-pill); font-size: 12px; font-weight: 600; }
  .pill.open { background: var(--danger-tint); color: var(--danger); }
  .pill.review { background: var(--amber-tint); color: var(--amber); }
  .pill.resolved { background: var(--success-tint); color: var(--success); }
  .pill.written { background: var(--accent-tint); color: var(--accent-deep); }
  .empty { text-align: center; color: var(--muted); padding: 40px 0; }
  .del-btn { background: none; border: 1px solid var(--line); color: var(--danger); width: 26px; height: 26px; border-radius: 6px; cursor: pointer; font-size: 13px; line-height: 1; font-family: inherit; }
  .del-btn:hover { background: var(--danger-tint); border-color: var(--danger); }
  .hidden { display: none; }
  .hint { font-size: 12px; color: var(--muted); }

  /* Clickable dashboard stat tiles */
  .stat.clickable { cursor: pointer; transition: border-color .12s, transform .12s; }
  .stat.clickable:hover { border-color: var(--accent); transform: translateY(-1px); }
  .stat.clickable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .stat .drill { font-size: 11px; color: var(--accent); font-weight: 600; margin-top: 4px; opacity: 0; }
  .stat.clickable:hover .drill { opacity: 1; }

  /* Records table: rows drill into detail */
  tr.rec-row { cursor: pointer; }
  tr.rec-row:hover td { background: var(--row-hover); }
  td.check-cell, th.check-cell { width: 34px; cursor: default; }
  td.check-cell input, th.check-cell input { cursor: pointer; width: 15px; height: 15px; accent-color: var(--accent); }

  /* Bulk action bar — only shown when rows are selected */
  .bulk-bar { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: var(--accent-tint);
    border: 1px solid var(--accent); border-radius: var(--radius-sm); margin-bottom: 14px; flex-wrap: wrap; }
  .bulk-bar .count { font-size: 13px; font-weight: 700; color: var(--accent-deep); }
  .bulk-bar select { font-family: inherit; font-size: 13px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 7px; }
  .btn-sm { background: var(--accent); color: var(--on-accent); border: none; padding: 8px 14px; border-radius: 7px;
    font-weight: 700; font-size: 13px; cursor: pointer; font-family: inherit; }
  .btn-sm:hover { background: var(--accent-deep); }
  .btn-sm:disabled { background: var(--muted); cursor: not-allowed; opacity: .6; }
  .btn-ghost { background: none; border: 1px solid var(--line); color: var(--muted); padding: 7px 12px;
    border-radius: 7px; font-weight: 600; font-size: 13px; cursor: pointer; font-family: inherit; }
  .btn-ghost:hover { border-color: var(--accent); color: var(--accent); }
  .btn-ghost.on { border-color: var(--success); color: var(--success); background: var(--success-tint); }

  /* Filter chip above the records table */
  .filter-chip { display: inline-flex; align-items: center; gap: 8px; background: var(--accent-tint); color: var(--accent-deep);
    padding: 5px 12px; border-radius: var(--radius-pill); font-size: 13px; font-weight: 600; margin-bottom: 14px; }
  .filter-chip button { background: none; border: none; color: inherit; cursor: pointer; font-size: 15px; line-height: 1; padding: 0; }

  .tag-sys { display: inline-block; background: var(--bg); border: 1px solid var(--line); color: var(--muted);
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
    padding: 1px 6px; border-radius: 4px; vertical-align: middle; }
  .del-btn[disabled], .btn-ghost[disabled] { opacity: .35; cursor: not-allowed; }
  .del-btn[disabled]:hover, .btn-ghost[disabled]:hover { background: none; border-color: var(--line); color: inherit; }

  /* Computed (read-only) inputs read as output, not as something to type in. */
  input.computed { background: var(--bg); color: var(--ink); font-weight: 700; cursor: default; }
  input.computed:focus { outline: none; border-color: var(--line); }

  /* Line items editor */
  .line-row { display: grid; grid-template-columns: auto 1fr 90px 110px 90px 32px; gap: 8px;
    align-items: center; margin-bottom: 8px; }
  .line-row select, .line-row input { font-size: 13px; padding: 8px 10px; }
  .line-row select.line-price { max-width: 170px; }
  .line-sum { font-size: 13px; font-weight: 700; text-align: right; }
  .line-actions { display: flex; align-items: center; justify-content: space-between;
    gap: 12px; margin-top: 10px; padding-top: 12px; border-top: 1px solid var(--line); }
  .line-total { font-size: 13px; color: var(--muted); }
  .line-total strong { font-size: 17px; color: var(--ink); margin-left: 4px; }
  .line-units { margin-left: 10px; padding-left: 10px; border-left: 1px solid var(--line); }
  @media (max-width: 720px) {
    .line-row { grid-template-columns: 1fr 1fr; }
    .line-row select.line-price { max-width: none; grid-column: 1 / -1; }
    .line-row .line-label { grid-column: 1 / -1; }
  }

  /* "X of Y vendor defects replaced" */
  .replaced-stat { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
  .rs-bar { height: 8px; background: var(--bg); border-radius: 5px; overflow: hidden; margin-bottom: 8px; }
  .rs-fill { height: 100%; background: var(--success); border-radius: 5px; transition: width .2s; }
  .rs-text { font-size: 13px; color: var(--muted); }
  .rs-text strong { color: var(--ink); font-size: 14px; }
  .rs-pct { color: var(--success); font-weight: 700; margin-left: 6px; }

  /* Toggle switch (Replaced?) */
  .toggle-switch { display: flex; align-items: center; gap: 10px; height: 40px; }
  .toggle-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .toggle-switch .switch {
    position: relative; display: inline-block; width: 46px; height: 26px; flex: none;
    background: var(--line); border-radius: 20px; cursor: pointer; transition: background .16s;
  }
  .toggle-switch .switch::after {
    content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px;
    background: var(--card); border-radius: 50%; transition: transform .16s;
    box-shadow: var(--shadow-card);
  }
  .toggle-switch input:checked + .switch { background: var(--success); }
  .toggle-switch input:checked + .switch::after { transform: translateX(20px); }
  .toggle-switch input:focus-visible + .switch { outline: 2px solid var(--accent); outline-offset: 2px; }
  .switch-text { font-size: 14px; font-weight: 600; color: var(--muted); }

  /* Post-submit confirmation on the dashboard */
  .flash { display: none; background: var(--success-tint); border: 1px solid var(--success); color: var(--success-dk);
    padding: 12px 16px; border-radius: var(--radius-sm); font-size: 14px; font-weight: 600; margin-bottom: 18px; }
  .flash.show { display: block; }

  /* Record detail view */
  .detail-head { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; flex-wrap: wrap; }
  .detail-head h2 { font-size: 20px; font-weight: 800; margin: 0; }
  .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .detail-grid .full { grid-column: 1 / -1; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px;
    padding-top: 18px; margin-top: 18px; border-top: 1px solid var(--line); }
  .meta .m-k { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
  .meta .m-v { font-size: 14px; margin-top: 2px; }

  @media (max-width: 720px) {
    .page { padding: 16px 16px 48px; }
    .grid { grid-template-columns: repeat(2, 1fr); }
    form { grid-template-columns: 1fr; }
    .bar-row .k { width: 110px; }
    .detail-grid { grid-template-columns: 1fr; }
  }
  `,

  template: `
  <div class="page">

    <!-- DASHBOARD -->
    <section data-ee-section="dash">
      <div class="dash-controls">
        <label for="ee-year-select">Year</label>
        <select id="ee-year-select"></select>
      </div>
      <div class="grid">
        <div class="stat clickable" data-drill="all" role="button" tabindex="0">
          <div class="label">Total Errors</div><div class="value" id="ee-s-total">0</div>
          <div class="drill">View records &rarr;</div>
        </div>
        <div class="stat clickable" data-drill="open" role="button" tabindex="0">
          <div class="label">Open</div><div class="value purple" id="ee-s-open">0</div>
          <div class="drill">View records &rarr;</div>
        </div>
        <div class="stat clickable" data-drill="resolved" role="button" tabindex="0">
          <div class="label">Resolved</div><div class="value green" id="ee-s-resolved">0</div>
          <div class="drill">View records &rarr;</div>
        </div>
        <div class="stat"><div class="label">Units Affected</div><div class="value" id="ee-s-units">0</div></div>
        <div class="stat"><div class="label">Cost to Remake</div><div class="value" id="ee-s-cost">$0</div></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>Errors by Month</h2>
          <div class="toggle" id="ee-month-metric">
            <button class="tog active" data-metric="count">Count</button>
            <button class="tog" data-metric="cost">Cost</button>
          </div>
        </div>
        <div id="ee-by-month"></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>Errors by Type</h2>
          <div class="toggle" id="ee-type-metric">
            <button class="tog active" data-metric="count">Count</button>
            <button class="tog" data-metric="cost">Cost</button>
          </div>
        </div>
        <div id="ee-by-type"><div class="empty">No data yet &mdash; log your first error.</div></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>Errors by Root Cause</h2>
          <div class="toggle" id="ee-cause-metric">
            <button class="tog active" data-metric="count">Count</button>
            <button class="tog" data-metric="cost">Cost</button>
          </div>
        </div>
        <div id="ee-by-cause"></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>Errors by Vendor</h2>
          <div class="toggle" id="ee-vendor-metric">
            <button class="tog active" data-metric="count">Count</button>
            <button class="tog" data-metric="cost">Cost</button>
          </div>
        </div>
        <div id="ee-by-vendor"></div>
        <div id="ee-replaced-stat"></div>
        <p class="hint" style="margin-top:12px">
          Vendor-attributed errors &mdash; root cause &ldquo;vendor&rdquo; or type &ldquo;vendor defect&rdquo;, grouped by the owner recorded on each error.
        </p>
      </div>
    </section>

    <!-- LOG FORM -->
    <section data-ee-section="log" class="hidden">
      <div class="panel">
        <h2>New Error Record</h2>
        <form id="ee-error-form">
          <div class="field">
            <label>Error Type <span class="req">*</span></label>
            <select name="error_type" required id="ee-f-type"></select>
          </div>
          <div class="field">
            <label>Root Cause <span class="req">*</span></label>
            <select name="root_cause" required id="ee-f-cause"></select>
          </div>
          <div class="field">
            <label>Invoice / Visual ID <span class="req">*</span></label>
            <input name="invoice_ref" required placeholder="e.g. 18432" />
          </div>
          <div class="field">
            <label>Customer <span class="req">*</span></label>
            <div class="combo" id="ee-customer-combo">
              <input type="text" id="ee-customer-search" placeholder="Type to search BackBone&hellip;" autocomplete="off" />
              <input type="hidden" name="customer_id" id="ee-f-customer" />
              <div class="combo-list" id="ee-customer-list"></div>
            </div>
          </div>
          <div class="field" id="ee-vendor-field" style="display:none">
            <label>Vendor <span class="req">*</span></label>
            <input name="owner" id="ee-f-owner" placeholder="Vendor name (e.g. SanMar, S&amp;S)" />
          </div>
          <div class="field" id="ee-replaced-field" style="display:none">
            <label>Replaced?</label>
            <div class="toggle-switch">
              <input type="checkbox" name="replaced" id="ee-f-replaced" />
              <label for="ee-f-replaced" class="switch"></label>
              <span class="switch-text" id="ee-f-replaced-text">No</span>
            </div>
            <span class="hint">Did the vendor replace the goods?</span>
          </div>
          <div class="field">
            <label>Status <span class="req">*</span></label>
            <select name="status" required id="ee-f-status"></select>
          </div>
          <div class="field full">
            <label>Items affected <span class="req">*</span></label>
            <p class="hint" style="margin:-2px 0 8px">
              One incident, however many priced items it involves &mdash; add a line for each so it stays a single error.
            </p>
            <div id="ee-f-lines"></div>
            <div class="line-actions">
              <button type="button" class="btn-ghost" id="ee-f-add-line">+ Add line</button>
              <span class="line-total">Total: <strong id="ee-f-grand-total">$0.00</strong>
                <span class="line-units" id="ee-f-grand-units">0 units</span></span>
            </div>
          </div>
          <div class="field full">
            <label>What happened &amp; why <span class="req">*</span></label>
            <textarea name="description" required placeholder="Describe the error and the root cause so it can be evaluated later."></textarea>
          </div>
          <div class="actions">
            <button class="primary" type="submit">Log Error</button>
            <span class="msg" id="ee-form-msg"></span>
          </div>
        </form>
      </div>
    </section>

    <!-- RECORDS -->
    <section data-ee-section="records" class="hidden">
      <div class="panel">
        <div class="panel-head">
          <h2 id="ee-records-title">All Records</h2>
          <div class="dash-controls" style="margin:0">
            <label for="ee-status-filter">Status</label>
            <select id="ee-status-filter"></select>
          </div>
        </div>
        <div id="ee-filter-chip-wrap"></div>
        <div id="ee-bulk-bar-wrap"></div>
        <div id="ee-records-body"><div class="empty">No records yet.</div></div>
      </div>
    </section>

    <!-- RECORD DETAIL (internal to the records view; opened by row click) -->
    <section data-ee-section="detail" class="hidden">
      <div class="panel">
        <div class="detail-head">
          <button class="btn-ghost" id="ee-detail-back">&larr; Back to records</button>
          <h2 id="ee-detail-id">&mdash;</h2>
          <span id="ee-detail-pill"></span>
          <span class="msg" id="ee-detail-msg" style="margin-left:auto"></span>
        </div>
        <form id="ee-detail-form" class="detail-grid">
          <div class="field">
            <label>Status</label>
            <select name="status" id="ee-d-status"></select>
          </div>
          <div class="field">
            <label>Error Type</label>
            <select name="error_type" id="ee-d-type"></select>
          </div>
          <div class="field">
            <label>Root Cause</label>
            <select name="root_cause" id="ee-d-cause"></select>
          </div>
          <div class="field">
            <label>Invoice / Visual ID</label>
            <input name="invoice_ref" id="ee-d-invoice" />
          </div>
          <div class="field">
            <label>Owner / Vendor</label>
            <input name="owner" id="ee-d-owner" placeholder="&mdash;" />
          </div>
          <div class="field full">
            <label>Items affected</label>
            <div id="ee-d-lines"></div>
            <div class="line-actions">
              <button type="button" class="btn-ghost" id="ee-d-add-line">+ Add line</button>
              <span class="line-total">Total: <strong id="ee-d-grand-total">$0.00</strong>
                <span class="line-units" id="ee-d-grand-units">0 units</span></span>
            </div>
          </div>
          <div class="field" id="ee-d-replaced-field" style="display:none">
            <label>Replaced?</label>
            <div class="toggle-switch">
              <input type="checkbox" id="ee-d-replaced" />
              <label for="ee-d-replaced" class="switch"></label>
              <span class="switch-text" id="ee-d-replaced-text">No</span>
            </div>
            <span class="hint">Did the vendor replace the goods?</span>
          </div>
          <div class="field full">
            <label>What happened &amp; why</label>
            <textarea name="description" id="ee-d-description"></textarea>
          </div>
          <div class="actions">
            <button class="primary" type="submit">Save changes</button>
            <button class="btn-ghost" type="button" id="ee-detail-reset">Discard</button>
          </div>
        </form>
        <div class="meta" id="ee-detail-meta"></div>
      </div>
    </section>

    <!-- MANAGE LISTS (admin + management; the old Settings tab minus users) -->
    <section data-ee-section="lists" class="hidden">
      <div id="ee-lists-denied" class="panel hidden">
        <div class="empty">Only management and admins can edit these lists.</div>
      </div>
      <div id="ee-lists-wrap" class="hidden">
        <div class="panel">
          <h2>Manage Lists</h2>
          <p class="hint" style="margin-bottom:18px">
            Add options, or retire ones you no longer use. <strong>Retiring</strong> removes an option from
            the new-record dropdowns but keeps it readable and countable on existing records &mdash; nothing
            historical is lost. Options that no record uses can be deleted outright.
          </p>
          <div class="dash-controls" style="margin-bottom:18px">
            <label for="ee-list-select">List</label>
            <select id="ee-list-select">
              <option value="error_type">Error Types</option>
              <option value="root_cause">Root Causes</option>
              <option value="status">Statuses</option>
            </select>
          </div>
          <form id="ee-list-add-form" style="grid-template-columns:1fr auto;align-items:end">
            <div class="field">
              <label>New option <span class="req">*</span></label>
              <input id="ee-list-value" placeholder="e.g. Embroidery Defect" />
            </div>
            <div class="actions" style="grid-column:auto">
              <button class="primary" type="submit">Add</button>
            </div>
            <div class="actions"><span class="msg" id="ee-list-msg"></span></div>
          </form>
        </div>
        <div class="panel">
          <h2 id="ee-list-title">Options</h2>
          <div id="ee-list-body"><div class="empty">Loading&hellip;</div></div>
        </div>
        <div class="panel">
          <h2>Fusion Price List</h2>
          <p class="hint" style="margin-bottom:18px">
            Used by the cost dropdown when logging an error. Tick <strong>Price list</strong> on a root cause
            above to have these offered for it. Prices are copied onto an error when it's logged, so editing
            one here never changes the cost of an error already recorded.
          </p>
          <form id="ee-price-add-form" style="grid-template-columns:1fr 140px auto;align-items:end">
            <div class="field">
              <label>Item <span class="req">*</span></label>
              <input id="ee-price-label" placeholder="e.g. 4x4" />
            </div>
            <div class="field">
              <label>Cost per unit <span class="req">*</span></label>
              <input id="ee-price-cost" type="number" min="0" step="0.01" placeholder="0.00" />
            </div>
            <div class="actions" style="grid-column:auto">
              <button class="primary" type="submit">Add</button>
            </div>
            <div class="actions"><span class="msg" id="ee-price-msg"></span></div>
          </form>
          <div id="ee-price-body" style="margin-top:18px"></div>
        </div>
      </div>
    </section>

  </div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const $ = (id) => root.querySelector('#' + id);
    const $$ = (sel) => root.querySelectorAll(sel);
    const api = ctx.api;

    /* ---------------- roles ---------------- */
    // Delete stays restricted; the server enforces this too (api/errors.js).
    // registry.js models superusers as perms.superuser === true (not a role
    // string), so check both shapes.
    const role = (ctx.user && ctx.user.role) || '';
    const superuser = !!(ctx.perms && ctx.perms.superuser) ||
      !!(ctx.user && ctx.user.perms && ctx.user.perms.superuser);
    const isAdmin = superuser || role === 'admin' || role === 'superuser';

    /* ---------------- taxonomy ---------------- */
    const SEED_ERROR_TYPES = ['misprint','wrong garment','wrong size/color','short ship','late','art error','vendor defect','replacement/reprint'];
    const SEED_ROOT_CAUSES = ['art','production','purchasing','vendor','CSR','customer-supplied'];
    const SEED_STATUSES = ['open','in review','resolved','written-off'];

    let TAXONOMY = {
      error_type: SEED_ERROR_TYPES.map(v => ({ value: v, label: v, active: true })),
      root_cause: SEED_ROOT_CAUSES.map(v => ({ value: v, label: v, active: true })),
      status: SEED_STATUSES.map(v => ({ value: v, label: v, active: true })),
    };
    let TAX_USAGE = {};
    let CAN_EDIT_TAXONOMY = false;
    let PROTECTED_VALUES = { status: ['open','resolved'], error_type: [], root_cause: [] };
    let PRICES = [];

    function allValues(field) { return TAXONOMY[field].map(o => o.value); }
    function activeValues(field) { return TAXONOMY[field].filter(o => o.active).map(o => o.value); }
    function labelFor(field, value) {
      const hit = TAXONOMY[field] && TAXONOMY[field].find(o => o.value === value);
      return hit ? hit.label : titleCase(value || '');
    }
    function ERROR_TYPES_ALL() { return allValues('error_type'); }
    function ROOT_CAUSES_ALL() { return allValues('root_cause'); }

    async function loadTaxonomy() {
      try {
        const j = await api.get(ENDPOINTS.eeTaxonomy);
        if (j && j.taxonomy) TAXONOMY = j.taxonomy;
        TAX_USAGE = (j && j.usage) || {};
        CAN_EDIT_TAXONOMY = !!(j && j.can_edit);
        if (j && j.protected) PROTECTED_VALUES = j.protected;
        PRICES = (j && j.prices) || [];
      } catch (e) { /* keep seeds */ }
    }

    function titleCase(s) {
      return String(s).replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
    }

    function fillSelect(id, opts) {
      const el = $(id);
      if (!el) return;
      const prev = el.value;
      el.innerHTML = opts.map(o => {
        const value = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? titleCase(o) : o.label;
        return '<option value="' + escapeHtml(value) + '">' + escapeHtml(label) + '</option>';
      }).join('');
      if (prev && opts.some(o => (typeof o === 'string' ? o : o.value) === prev)) el.value = prev;
    }

    function refreshOptionSelects() {
      const activeTypes = TAXONOMY.error_type.filter(o => o.active);
      const activeCauses = TAXONOMY.root_cause.filter(o => o.active);
      const activeStatuses = TAXONOMY.status.filter(o => o.active);

      // New-record form: active options only.
      fillSelect('ee-f-type', activeTypes);
      fillSelect('ee-f-cause', activeCauses);
      fillSelect('ee-f-status', activeStatuses);

      // Detail view: include retired options so an existing record that references
      // one still shows its actual value instead of silently switching to another.
      fillSelect('ee-d-type', TAXONOMY.error_type);
      fillSelect('ee-d-cause', TAXONOMY.root_cause);
      fillSelect('ee-d-status', TAXONOMY.status);

      // Records filter: all statuses, so retired ones remain filterable.
      const sf = $('ee-status-filter');
      if (sf) {
        const prev = sf.value;
        sf.innerHTML = '<option value="all">All statuses</option>' +
          TAXONOMY.status.map(o => '<option value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</option>').join('');
        if (prev) sf.value = prev;
      }
    }

    /* ---------------- money + lines ---------------- */
    function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
    function money(n) {
      return '$' + round2(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    let logLines = [];
    let detailLines = [];

    function blankLine() { return { label: '', units: '', unit_cost: '' }; }

    function rootCauseHasPrices(value) {
      const o = (TAXONOMY.root_cause || []).find(x => x.value === value);
      return !!(o && o.price_list);
    }

    function lineTotal(l) {
      const u = Number(l.units), uc = Number(l.unit_cost);
      return (isNaN(u) || isNaN(uc)) ? 0 : round2(u * uc);
    }
    function linesTotals(lines) {
      return lines.reduce((acc, l) => {
        acc.cost = round2(acc.cost + lineTotal(l));
        acc.units += Number(l.units) || 0;
        return acc;
      }, { cost: 0, units: 0 });
    }

    function renderLines(containerId, lines, showPrices) {
      const el = $(containerId);
      if (!lines.length) {
        el.innerHTML = '<div class="empty" style="padding:18px 0">No items yet &mdash; add a line.</div>';
        return;
      }
      el.innerHTML = lines.map((l, i) => {
        const priceSelect = showPrices ? `
          <select class="line-price" data-i="${i}" title="Price list">
            <option value="">Custom&hellip;</option>
            ${PRICES.map(p => `<option value="${escapeHtml(p.id)}"${l.label === p.label ? ' selected' : ''}>${escapeHtml(p.label)} &mdash; ${money(p.unit_cost)}</option>`).join('')}
          </select>` : '';
        return `<div class="line-row">
          ${priceSelect}
          <input class="line-label" data-i="${i}" placeholder="Description" value="${escapeHtml(l.label)}" />
          <input class="line-units" data-i="${i}" type="number" min="0" placeholder="Units" value="${escapeHtml(l.units)}" />
          <input class="line-cost" data-i="${i}" type="number" min="0" step="0.01" placeholder="$ / unit" value="${escapeHtml(l.unit_cost)}" />
          <span class="line-sum">${money(lineTotal(l))}</span>
          <button type="button" class="del-btn line-del" data-i="${i}" title="Remove line"${lines.length === 1 ? ' disabled' : ''}>✕</button>
        </div>`;
      }).join('');
    }

    function refreshLineTotals(lines, totalId, unitsId) {
      const t = linesTotals(lines);
      $(totalId).textContent = money(t.cost);
      $(unitsId).textContent = t.units + ' unit' + (t.units === 1 ? '' : 's');
    }

    function wireLines({ containerId, addBtnId, totalId, unitsId, get, set, causeSelectId }) {
      const container = $(containerId);

      const redraw = () => {
        renderLines(containerId, get(), rootCauseHasPrices($(causeSelectId).value));
        refreshLineTotals(get(), totalId, unitsId);
      };

      container.addEventListener('input', (e) => {
        const t = e.target;
        const i = Number(t.dataset.i);
        const lines = get();
        if (isNaN(i) || !lines[i]) return;
        if (t.classList.contains('line-label')) lines[i].label = t.value;
        else if (t.classList.contains('line-units')) lines[i].units = t.value;
        else if (t.classList.contains('line-cost')) lines[i].unit_cost = t.value;
        else return;
        // Update the running totals without a full redraw, so focus and caret stay put.
        const row = t.closest('.line-row');
        if (row) row.querySelector('.line-sum').textContent = money(lineTotal(lines[i]));
        refreshLineTotals(lines, totalId, unitsId);
      });

      container.addEventListener('change', (e) => {
        const sel = e.target.closest('.line-price');
        if (!sel) return;
        const i = Number(sel.dataset.i);
        const lines = get();
        if (!lines[i]) return;
        const p = PRICES.find(x => x.id === sel.value);
        if (p) {
          // Copy the price onto the line. Editing the price list later never
          // rewrites costs already recorded against an error.
          lines[i].label = p.label;
          lines[i].unit_cost = p.unit_cost;
        }
        redraw();
      });

      container.addEventListener('click', (e) => {
        const del = e.target.closest('.line-del');
        if (!del || del.disabled) return;
        const lines = get();
        lines.splice(Number(del.dataset.i), 1);
        if (!lines.length) lines.push(blankLine());
        set(lines);
        redraw();
      });

      $(addBtnId).addEventListener('click', () => {
        get().push(blankLine());
        redraw();
      });

      // Switching root cause can reveal or hide the price dropdown.
      $(causeSelectId).addEventListener('change', redraw);

      return redraw;
    }

    // Older records predate lines — present their flat units/unit_cost as one line
    // so the editor has something to show and edits produce a normal lines array.
    function linesFromRecord(rec) {
      if (Array.isArray(rec.lines) && rec.lines.length) {
        return rec.lines.map(l => ({ label: l.label || '', units: l.units ?? '', unit_cost: l.unit_cost ?? '' }));
      }
      return [{ label: '', units: rec.units ?? '', unit_cost: unitCostOf(rec) || '' }];
    }

    // Strip blank rows and coerce to the API shape.
    function linesForApi(lines) {
      return lines
        .filter(l => String(l.units).trim() !== '' || String(l.unit_cost).trim() !== '')
        .map(l => ({ label: String(l.label || '').trim(), units: Number(l.units) || 0, unit_cost: Number(l.unit_cost) || 0 }));
    }

    // Older records predate unit_cost — derive it so the detail view isn't blank.
    function unitCostOf(e) {
      if (e.unit_cost != null && e.unit_cost !== '') return Number(e.unit_cost);
      const u = Number(e.units), c = Number(e.cost);
      return u > 0 && !isNaN(c) ? round2(c / u) : 0;
    }

    /* ---------------- vendor / replaced fields ---------------- */
    const VENDOR_DEFECT = 'vendor defect';

    function updateVendorField() {
      const type = $('ee-f-type').value;
      const isVendor = type === VENDOR_DEFECT;
      const field = $('ee-vendor-field');
      const input = $('ee-f-owner');
      field.style.display = isVendor ? 'flex' : 'none';
      input.required = isVendor;
      if (!isVendor) input.value = ''; // don't submit a stale vendor name

      const rf = $('ee-replaced-field');
      const rc = $('ee-f-replaced');
      rf.style.display = isVendor ? 'flex' : 'none';
      if (!isVendor) rc.checked = false; // don't submit a stale flag
      syncReplacedText('ee-f-replaced', 'ee-f-replaced-text');
    }

    function syncReplacedText(boxId, textId) {
      const box = $(boxId);
      const txt = $(textId);
      if (box && txt) txt.textContent = box.checked ? 'Yes' : 'No';
    }
    $('ee-f-replaced').addEventListener('change', () => syncReplacedText('ee-f-replaced', 'ee-f-replaced-text'));
    $('ee-f-type').addEventListener('change', updateVendorField);

    /* ---------------- customers combo ---------------- */
    let CUSTOMERS = [];
    let comboActive = -1;

    async function loadCustomers() {
      try {
        const j = await api.get(ENDPOINTS.eeCustomers);
        CUSTOMERS = (j && j.customers) || [];
      } catch (e) { /* leave empty */ }
    }

    function renderComboList(filter) {
      const list = $('ee-customer-list');
      const q = filter.trim().toLowerCase();
      const matches = !q ? CUSTOMERS.slice(0, 50)
        : CUSTOMERS.filter(c => c.name.toLowerCase().includes(q)).slice(0, 50);
      comboActive = -1;
      if (!matches.length) {
        list.innerHTML = '<div class="combo-empty">No matching customers</div>';
        list.classList.add('open');
        return;
      }
      list.innerHTML = matches.map((c, i) =>
        '<div class="combo-item" data-id="' + escapeHtml(c.customer_id) + '" data-name="' + escapeHtml(c.name) + '" data-i="' + i + '">' + escapeHtml(c.name) + '</div>'
      ).join('');
      list.classList.add('open');
    }

    function pickCustomer(id, name) {
      $('ee-f-customer').value = id;
      $('ee-customer-search').value = name;
      $('ee-customer-list').classList.remove('open');
    }

    function initCustomerCombo() {
      const search = $('ee-customer-search');
      const list = $('ee-customer-list');
      const hidden = $('ee-f-customer');

      search.addEventListener('focus', () => renderComboList(search.value));
      search.addEventListener('input', () => { hidden.value = ''; renderComboList(search.value); });

      search.addEventListener('keydown', (e) => {
        const items = [...list.querySelectorAll('.combo-item')];
        if (!items.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); comboActive = Math.min(comboActive + 1, items.length - 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); comboActive = Math.max(comboActive - 1, 0); }
        else if (e.key === 'Enter') {
          if (comboActive >= 0) { e.preventDefault(); const el = items[comboActive]; pickCustomer(el.dataset.id, el.dataset.name); }
          return;
        } else if (e.key === 'Escape') { list.classList.remove('open'); return; }
        items.forEach((el, i) => el.classList.toggle('active', i === comboActive));
        if (comboActive >= 0) items[comboActive].scrollIntoView({ block: 'nearest' });
      });

      list.addEventListener('mousedown', (e) => {
        const el = e.target.closest('.combo-item');
        if (!el) return;
        e.preventDefault();
        pickCustomer(el.dataset.id, el.dataset.name);
      });

      // Close when clicking outside the combo. Root-scoped, so a click in
      // another app can't reach this handler.
      root.addEventListener('click', (e) => {
        if (!e.target.closest('#ee-customer-combo')) list.classList.remove('open');
      });
    }

    /* ---------------- sections ---------------- */
    // 'detail' is internal — reached by clicking a record. The shell's rail
    // stays on Records while it's open (the route never changes).
    const VIEW_TO_SECTION = { dashboard: 'dash', log: 'log', records: 'records', lists: 'lists' };

    function showSection(name) {
      $$('[data-ee-section]').forEach(el => {
        el.classList.toggle('hidden', el.dataset.eeSection !== name);
      });
      window.scrollTo({ top: 0 });
    }

    // Installed for showView() below: shell navigation lands here.
    showSectionRef = (view) => {
      const section = VIEW_TO_SECTION[view] || 'dash';
      showSection(section);
      if (view === 'lists') refreshListsGate();
    };

    /* ---------------- data through the seam ---------------- */
    async function loadErrors() {
      const j = await api.get(ENDPOINTS.eeErrors);
      return (j && j.errors) || [];
    }
    async function saveErrorRecord(rec) {
      try {
        const j = await api.post(ENDPOINTS.eeErrors, rec);
        return j.record;
      } catch (err) { throw withDetails(err); }
    }
    async function patchError(id, patch) {
      try {
        const j = await api.request(ENDPOINTS.eeErrors + '?id=' + encodeURIComponent(id), {
          method: 'PATCH', body: patch,
        });
        return j.record;
      } catch (err) { throw withDetails(err); }
    }
    async function patchErrorsBulk(ids, patch) {
      try {
        return await api.request(ENDPOINTS.eeErrors, { method: 'PATCH', body: { ids, patch } });
      } catch (err) { throw withDetails(err); }
    }
    async function deleteErrorRecord(id) {
      return api.request(ENDPOINTS.eeErrors + '?id=' + encodeURIComponent(id), { method: 'DELETE' });
    }
    // The API sends { error, details: [...] } on validation failures; the seam
    // keeps the payload on err.body. Fold details into the message.
    function withDetails(err) {
      if (err && err.body && Array.isArray(err.body.details)) {
        err.message = err.message + ': ' + err.body.details.join('; ');
      }
      return err;
    }

    /* ---------------- rendering ---------------- */
    function pillClass(s) {
      return s === 'open' ? 'open' : s === 'in review' ? 'review' : s === 'resolved' ? 'resolved' : 'written';
    }

    function renderBars(containerId, counts, opts) {
      opts = opts || {};
      const el = $(containerId);
      const entries = Object.entries(counts).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]);
      if (!entries.length) {
        el.innerHTML = '<div class="empty">' + (opts.empty || 'No data yet.') + '</div>';
        return;
      }
      const max = Math.max(...entries.map(e => e[1]));
      const fmt = opts.format || (v => v);
      const label = opts.label || (k => titleCase(k));
      const vw = opts.wide ? ' style="width:74px"' : '';
      el.innerHTML = entries.map(([k,v]) =>
        '<div class="bar-row"><div class="k" title="' + escapeHtml(label(k)) + '">' + escapeHtml(label(k)) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + (v/max)*100 + '%"></div></div><div class="v"' + vw + '>' + fmt(v) + '</div></div>'
      ).join('');
    }

    // Vendor names are free text, so they must be escaped everywhere they're rendered.
    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
      ));
    }

    function isVendorError(e) {
      return e.root_cause === 'vendor' || e.error_type === 'vendor defect';
    }
    function vendorTotals(errors, metric) {
      const out = {};
      errors.filter(isVendorError).forEach(e => {
        const name = (e.owner && String(e.owner).trim()) || 'Unattributed';
        out[name] = (out[name] || 0) + (metric === 'cost' ? (Number(e.cost) || 0) : 1);
      });
      return out;
    }

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let ALL_ERRORS = [];
    let selectedYear = new Date().getFullYear();
    let monthMetric = 'count';
    let vendorMetric = 'count';
    let typeMetric = 'count';
    let causeMetric = 'count';
    let statusFilter = 'all';
    const selected = new Set();

    function errorYear(e) {
      const d = e.date_logged ? new Date(e.date_logged) : null;
      return d && !isNaN(d) ? d.getFullYear() : null;
    }
    function errorMonth(e) {
      const d = e.date_logged ? new Date(e.date_logged) : null;
      return d && !isNaN(d) ? d.getMonth() : null; // 0-11
    }

    function populateYearSelect() {
      const sel = $('ee-year-select');
      const years = [...new Set(ALL_ERRORS.map(errorYear).filter(Boolean))].sort((a,b) => b-a);
      const current = new Date().getFullYear();
      if (!years.includes(current)) years.unshift(current); // always offer current year
      if (!years.includes(selectedYear) && selectedYear !== 'all') selectedYear = years[0];
      sel.innerHTML = years.map(y => '<option value="' + y + '"' + (y===selectedYear?' selected':'') + '>' + y + '</option>').join('')
        + '<option value="all"' + (selectedYear==='all'?' selected':'') + '>All years</option>';
    }

    function renderMonthChart(yearErrors) {
      const el = $('ee-by-month');
      const vals = MONTHS.map((_, m) => {
        const inMonth = yearErrors.filter(e => errorMonth(e) === m);
        if (monthMetric === 'cost') return inMonth.reduce((s,e) => s + (Number(e.cost)||0), 0);
        return inMonth.length;
      });
      const max = Math.max(1, ...vals);
      const fmt = (v) => monthMetric === 'cost' ? '$' + v.toLocaleString(undefined,{maximumFractionDigits:0}) : v;
      el.innerHTML = MONTHS.map((name, m) =>
        '<div class="bar-row"><div class="k" style="width:52px">' + name + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + (vals[m]/max)*100 + '%"></div></div>' +
        '<div class="v" style="width:64px">' + (vals[m] ? fmt(vals[m]) : '&mdash;') + '</div></div>'
      ).join('');
    }

    // Fetch + draw everything. Use this after any write.
    async function render() {
      ALL_ERRORS = await loadErrors();
      populateYearSelect();
      draw();
    }

    // Draw from the cached set — no refetch. Every filter change routes through
    // here, so the dashboard and records table can never disagree about the data.
    function draw() {
      const yearErrors = selectedYear === 'all'
        ? ALL_ERRORS
        : ALL_ERRORS.filter(e => errorYear(e) === Number(selectedYear));

      renderDashboard(yearErrors);
      renderRecords();
    }

    function renderDashboard(yearErrors) {
      const cost = yearErrors.reduce((s,e) => s + (Number(e.cost)||0), 0);
      const units = yearErrors.reduce((s,e) => s + (Number(e.units)||0), 0);
      $('ee-s-units').textContent = units.toLocaleString();
      $('ee-s-total').textContent = yearErrors.length;
      $('ee-s-open').textContent = yearErrors.filter(e => e.status === 'open').length;
      $('ee-s-resolved').textContent = yearErrors.filter(e => e.status === 'resolved').length;
      $('ee-s-cost').textContent = '$' + cost.toLocaleString(undefined,{maximumFractionDigits:0});

      renderMonthChart(yearErrors);

      // Type and cause honor the same Count/Cost toggle as month and vendor.
      // Count answers "what goes wrong most"; cost answers "what hurts most",
      // and they rank differently: one $900 short ship outweighs five $30
      // misprints on one axis and not the other.
      const groupTotals = (field, keys, metric) => {
        const totals = Object.fromEntries(keys.map(k => [k, 0]));
        yearErrors.forEach(e => {
          if (totals[e[field]] == null) return;
          totals[e[field]] += metric === 'cost' ? (Number(e.cost) || 0) : 1;
        });
        return totals;
      };
      const dollars = v => '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });

      renderBars('ee-by-type', groupTotals('error_type', ERROR_TYPES_ALL(), typeMetric), {
        label: k => labelFor('error_type', k),
        wide: typeMetric === 'cost',
        format: typeMetric === 'cost' ? dollars : undefined,
      });
      renderBars('ee-by-cause', groupTotals('root_cause', ROOT_CAUSES_ALL(), causeMetric), {
        label: k => labelFor('root_cause', k),
        wide: causeMetric === 'cost',
        format: causeMetric === 'cost' ? dollars : undefined,
      });

      renderBars('ee-by-vendor', vendorTotals(yearErrors, vendorMetric), {
        empty: 'No vendor-attributed errors in this period.',
        wide: vendorMetric === 'cost',
        format: vendorMetric === 'cost' ? dollars : undefined,
      });

      renderReplacedStat(yearErrors);
    }

    // "X of Y vendor defects replaced" — counts only records whose error type is
    // "vendor defect". Records logged before this field existed have no flag at
    // all; they count toward Y but not X, and are called out separately so the
    // ratio isn't misread as a definite "not replaced".
    function renderReplacedStat(errors) {
      const el = $('ee-replaced-stat');
      const defects = errors.filter(e => e.error_type === VENDOR_DEFECT);
      if (!defects.length) { el.innerHTML = ''; return; }

      const replaced = defects.filter(e => e.replaced === true).length;
      const unanswered = defects.filter(e => e.replaced !== true && e.replaced !== false).length;
      const pct = Math.round((replaced / defects.length) * 100);

      el.innerHTML = '<div class="replaced-stat">' +
        '<div class="rs-bar"><div class="rs-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="rs-text"><strong>' + replaced + ' of ' + defects.length + '</strong> vendor defect' + (defects.length === 1 ? '' : 's') + ' replaced' +
        '<span class="rs-pct">' + pct + '%</span></div>' +
        (unanswered ? '<div class="hint">' + unanswered + ' not yet answered</div>' : '') +
        '</div>';
    }

    // Records table. Honors the status filter (set directly, or by drilling in
    // from a dashboard tile) and the dashboard year filter.
    function renderRecords() {
      const body = $('ee-records-body');

      let list = [...ALL_ERRORS];
      if (selectedYear !== 'all') list = list.filter(e => errorYear(e) === Number(selectedYear));
      if (statusFilter !== 'all') list = list.filter(e => e.status === statusFilter);

      $('ee-records-title').textContent =
        statusFilter === 'all' ? 'All Records' : labelFor('status', statusFilter) + ' Records';
      renderFilterChip(list.length);

      // Drop selections for rows that are no longer visible, so a hidden row
      // can't be silently included in a bulk update.
      const visible = new Set(list.map(e => e.error_id));
      [...selected].forEach(id => { if (!visible.has(id)) selected.delete(id); });
      renderBulkBar();

      if (!list.length) {
        body.innerHTML = '<div class="empty">' + (ALL_ERRORS.length ? 'No records match this filter.' : 'No records yet.') + '</div>';
        return;
      }

      const rows = list.map(e => `
        <tr class="rec-row" data-id="${escapeHtml(e.error_id)}">
          <td class="check-cell"><input type="checkbox" class="row-check" data-id="${escapeHtml(e.error_id)}"${selected.has(e.error_id) ? ' checked' : ''} /></td>
          <td>${escapeHtml(e.error_id)}</td>
          <td>${escapeHtml(labelFor('error_type', e.error_type))}</td>
          <td>${escapeHtml(labelFor('root_cause', e.root_cause))}</td>
          <td>${escapeHtml(e.customer || '\u2014')}</td>
          <td>${escapeHtml(e.owner || '\u2014')}</td>
          <td>${e.units || '\u2014'}</td>
          <td>${money(e.cost)}</td>
          <td>${escapeHtml(e.logged_by_name || e.logged_by || '\u2014')}</td>
          <td><span class="pill ${pillClass(e.status)}">${escapeHtml(labelFor('status', e.status))}</span></td>
          ${isAdmin ? '<td><button class="del-btn" data-id="' + escapeHtml(e.error_id) + '" title="Delete">✕</button></td>' : ''}
        </tr>`).join('');

      const allChecked = list.length && list.every(e => selected.has(e.error_id));
      body.innerHTML = '<table><thead><tr>' +
        '<th class="check-cell"><input type="checkbox" id="ee-check-all"' + (allChecked ? ' checked' : '') + ' title="Select all" /></th>' +
        '<th>ID</th><th>Type</th><th>Cause</th><th>Customer</th><th>Owner</th><th>Units</th><th>Cost</th><th>Logged by</th><th>Status</th>' + (isAdmin ? '<th></th>' : '') +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function renderFilterChip(count) {
      const wrap = $('ee-filter-chip-wrap');
      if (statusFilter === 'all') { wrap.innerHTML = ''; return; }
      wrap.innerHTML = '<div class="filter-chip">Status: ' + escapeHtml(labelFor('status', statusFilter)) + ' (' + count + ')' +
        '<button id="ee-clear-filter" title="Clear filter" aria-label="Clear filter">&times;</button></div>';
    }

    function renderBulkBar() {
      const wrap = $('ee-bulk-bar-wrap');
      if (!selected.size) { wrap.innerHTML = ''; return; }
      wrap.innerHTML = '<div class="bulk-bar">' +
        '<span class="count">' + selected.size + ' selected</span>' +
        '<label class="hint" for="ee-bulk-status">Set status to</label>' +
        '<select id="ee-bulk-status">' + TAXONOMY.status.filter(o=>o.active).map(o => '<option value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</option>').join('') + '</select>' +
        '<button class="btn-sm" id="ee-bulk-apply">Apply</button>' +
        '<button class="btn-ghost" id="ee-bulk-clear">Clear selection</button>' +
        '<span class="msg" id="ee-bulk-msg"></span>' +
        '</div>';
    }

    /* ---------------- dashboard wiring ---------------- */
    $('ee-year-select').addEventListener('change', (e) => {
      selectedYear = e.target.value === 'all' ? 'all' : Number(e.target.value);
      draw();
    });

    $('ee-month-metric').addEventListener('click', (e) => {
      const btn = e.target.closest('.tog');
      if (!btn) return;
      monthMetric = btn.dataset.metric;
      $$('#ee-month-metric .tog').forEach(b => b.classList.toggle('active', b === btn));
      draw();
    });

    $('ee-vendor-metric').addEventListener('click', (e) => {
      const btn = e.target.closest('.tog');
      if (!btn) return;
      vendorMetric = btn.dataset.metric;
      $$('#ee-vendor-metric .tog').forEach(b => b.classList.toggle('active', b === btn));
      draw();
    });

    $('ee-type-metric').addEventListener('click', (e) => {
      const btn = e.target.closest('.tog');
      if (!btn) return;
      typeMetric = btn.dataset.metric;
      $$('#ee-type-metric .tog').forEach(b => b.classList.toggle('active', b === btn));
      draw();
    });

    $('ee-cause-metric').addEventListener('click', (e) => {
      const btn = e.target.closest('.tog');
      if (!btn) return;
      causeMetric = btn.dataset.metric;
      $$('#ee-cause-metric .tog').forEach(b => b.classList.toggle('active', b === btn));
      draw();
    });

    // Dashboard tiles drill into the matching records — via the router, so the
    // rail highlight follows.
    function drillTo(status) {
      statusFilter = status;
      $('ee-status-filter').value = status;
      selected.clear();
      draw();
      ctx.go('records');
    }
    $$('.stat.clickable').forEach(tile => {
      tile.addEventListener('click', () => drillTo(tile.dataset.drill));
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drillTo(tile.dataset.drill); }
      });
    });

    $('ee-status-filter').addEventListener('change', (e) => {
      statusFilter = e.target.value;
      selected.clear();
      draw();
    });

    $('ee-filter-chip-wrap').addEventListener('click', (e) => {
      if (!e.target.closest('#ee-clear-filter')) return;
      statusFilter = 'all';
      $('ee-status-filter').value = 'all';
      draw();
    });

    /* ---------------- selection + bulk status ---------------- */
    $('ee-records-body').addEventListener('change', (e) => {
      if (e.target.id === 'ee-check-all') {
        const ids = [...$$('.row-check')].map(c => c.dataset.id);
        if (e.target.checked) ids.forEach(id => selected.add(id));
        else ids.forEach(id => selected.delete(id));
        renderRecords();
        return;
      }
      const box = e.target.closest('.row-check');
      if (!box) return;
      if (box.checked) selected.add(box.dataset.id); else selected.delete(box.dataset.id);
      renderRecords();
    });

    $('ee-bulk-bar-wrap').addEventListener('click', async (e) => {
      if (e.target.closest('#ee-bulk-clear')) { selected.clear(); renderRecords(); return; }
      const apply = e.target.closest('#ee-bulk-apply');
      if (!apply) return;

      const status = $('ee-bulk-status').value;
      const ids = [...selected];
      const msg = $('ee-bulk-msg');
      if (!confirm('Set ' + ids.length + ' record' + (ids.length === 1 ? '' : 's') + ' to "' + labelFor('status', status) + '"?')) return;

      apply.disabled = true;
      msg.textContent = 'Updating\u2026';
      msg.className = 'msg';
      try {
        const res = await patchErrorsBulk(ids, { status });
        selected.clear();
        await render();
        if (res.missing && res.missing.length) {
          alert('Updated ' + res.updated + '. These were not found: ' + res.missing.join(', '));
        }
      } catch (err) {
        msg.textContent = 'Error: ' + err.message;
        msg.className = 'msg err';
        if (apply) apply.disabled = false;
      }
    });

    /* ---------------- record detail ---------------- */
    let currentRecord = null;

    const redrawDetailLines = wireLines({
      containerId: 'ee-d-lines', addBtnId: 'ee-d-add-line',
      totalId: 'ee-d-grand-total', unitsId: 'ee-d-grand-units',
      get: () => detailLines, set: (v) => { detailLines = v; },
      causeSelectId: 'ee-d-cause',
    });

    function openDetail(id) {
      const rec = ALL_ERRORS.find(e => e.error_id === id);
      if (!rec) return;
      currentRecord = rec;
      fillDetail(rec);
      showSection('detail'); // internal — the route stays on records
    }

    function fillDetail(rec) {
      $('ee-detail-id').textContent = rec.error_id;
      $('ee-detail-pill').innerHTML =
        '<span class="pill ' + pillClass(rec.status) + '">' + escapeHtml(labelFor('status', rec.status)) + '</span>';
      $('ee-d-status').value = rec.status || 'open';
      $('ee-d-type').value = rec.error_type || activeValues('error_type')[0];
      $('ee-d-cause').value = rec.root_cause || activeValues('root_cause')[0];
      $('ee-d-invoice').value = rec.invoice_ref || '';
      $('ee-d-owner').value = rec.owner || '';
      detailLines = linesFromRecord(rec);
      $('ee-d-description').value = rec.description || '';
      $('ee-d-replaced').checked = rec.replaced === true;
      updateDetailReplacedField();
      redrawDetailLines();
      $('ee-detail-msg').textContent = '';

      // Read-only provenance — these are set by the server, never edited here.
      $('ee-detail-meta').innerHTML = [
        ['Customer', rec.customer || '\u2014'],
        ['Customer ID', rec.customer_id || '\u2014'],
        ['Logged by', rec.logged_by_name || rec.logged_by || '\u2014'],
        ['Date logged', rec.date_logged ? new Date(rec.date_logged).toLocaleString() : '\u2014'],
        ['Date resolved', rec.date_resolved ? new Date(rec.date_resolved).toLocaleString() : '\u2014'],
      ].map(([k, v]) => '<div><div class="m-k">' + k + '</div><div class="m-v">' + escapeHtml(v) + '</div></div>').join('');
    }

    // Mirror the intake form: the toggle only appears while the record's type is
    // a vendor defect. Changing the type in the detail view shows/hides it live.
    function updateDetailReplacedField() {
      const isVendor = $('ee-d-type').value === VENDOR_DEFECT;
      $('ee-d-replaced-field').style.display = isVendor ? 'flex' : 'none';
      if (!isVendor) $('ee-d-replaced').checked = false;
      syncReplacedText('ee-d-replaced', 'ee-d-replaced-text');
    }
    $('ee-d-type').addEventListener('change', updateDetailReplacedField);
    $('ee-d-replaced').addEventListener('change', () => syncReplacedText('ee-d-replaced', 'ee-d-replaced-text'));

    // Row click opens the detail view — but not when the click was on a checkbox
    // or the delete button, which have their own behavior.
    $('ee-records-body').addEventListener('click', (e) => {
      if (e.target.closest('.check-cell') || e.target.closest('.del-btn')) return;
      const row = e.target.closest('.rec-row');
      if (row) openDetail(row.dataset.id);
    });

    $('ee-detail-back').addEventListener('click', () => showSection('records'));
    $('ee-detail-reset').addEventListener('click', () => {
      if (currentRecord) fillDetail(currentRecord);
    });

    $('ee-detail-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!currentRecord) return;
      const msg = $('ee-detail-msg');
      const btn = ev.target.querySelector('button[type=submit]');

      // Send only the editable fields; cost is derived server-side.
      const patch = {
        status: $('ee-d-status').value,
        error_type: $('ee-d-type').value,
        root_cause: $('ee-d-cause').value,
        invoice_ref: $('ee-d-invoice').value.trim(),
        owner: $('ee-d-owner').value.trim(),
        lines: linesForApi(detailLines),
        description: $('ee-d-description').value.trim(),
      };
      // Only send the flag when the (possibly just-changed) type is a vendor
      // defect. applyDerived() also strips it server-side, so the two can't disagree.
      if (patch.error_type === VENDOR_DEFECT) {
        patch.replaced = $('ee-d-replaced').checked;
      }
      // owner is optional; omit rather than sending "" (which the validator
      // rejects for required fields and would otherwise blank a legitimate value).
      if (!patch.owner) delete patch.owner;

      btn.disabled = true;
      msg.textContent = 'Saving\u2026';
      msg.className = 'msg';
      try {
        const updated = await patchError(currentRecord.error_id, patch);
        currentRecord = updated;
        await render();
        // ALL_ERRORS was replaced by render(); re-point at the fresh object.
        currentRecord = ALL_ERRORS.find(e => e.error_id === updated.error_id) || updated;
        fillDetail(currentRecord);
        msg.textContent = 'Saved';
        msg.className = 'msg ok';
        setTimeout(() => { msg.textContent = ''; }, 2500);
      } catch (err) {
        msg.textContent = 'Error: ' + err.message;
        msg.className = 'msg err';
      } finally {
        btn.disabled = false;
      }
    });

    /* ---------------- admin delete ---------------- */
    $('ee-records-body').addEventListener('click', async (e) => {
      const btn = e.target.closest('.del-btn');
      if (!btn) return;
      const id = btn.dataset.id;
      if (!confirm("Delete error " + id + "? This can't be undone.")) return;
      try {
        await deleteErrorRecord(id);
        // Drop it from the bulk selection too, or a deleted id would be sent in
        // the next bulk update.
        selected.delete(id);
        if (currentRecord && currentRecord.error_id === id) currentRecord = null;
        await render();
      } catch (err) { alert('Delete failed: ' + err.message); }
    });

    /* ---------------- log form ---------------- */
    $('ee-error-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const rec = Object.fromEntries(fd.entries());
      const msg = $('ee-form-msg');

      // An unchecked checkbox is omitted from FormData entirely, which would
      // store nothing rather than an explicit false. For a vendor defect we
      // always want a definite yes/no; for any other type we send nothing at all.
      if (rec.error_type === VENDOR_DEFECT) {
        rec.replaced = $('ee-f-replaced').checked;
      } else {
        delete rec.replaced;
      }

      // Lines replace the old flat units/unit_cost pair. The server recomputes
      // cost and units from them, so we never send a total the user could have
      // desynced.
      rec.lines = linesForApi(logLines);
      delete rec.units;
      delete rec.unit_cost;
      if (!rec.lines.length) {
        msg.textContent = 'Add at least one item with units and a cost.';
        msg.className = 'msg err';
        return;
      }

      // Customer is a searchable combo (hidden input), so browser 'required'
      // can't see it.
      if (!rec.customer_id) {
        msg.textContent = 'Please select a customer from the list.';
        msg.className = 'msg err';
        $('ee-customer-search').focus();
        return;
      }

      const btn = ev.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const saved = await saveErrorRecord(rec);
        ev.target.reset();
        $('ee-customer-search').value = '';
        $('ee-f-customer').value = '';
        updateVendorField();
        logLines = [blankLine()];
        redrawLogLines();
        await render();

        // Land back on the dashboard with the new record already reflected, and
        // confirm there rather than on the now-empty form.
        msg.textContent = '';
        flashBanner('Logged ' + saved.error_id);
        ctx.go('dashboard');
      } catch (e) {
        msg.textContent = 'Error: ' + e.message;
        msg.className = 'msg err';
      } finally {
        btn.disabled = false;
      }
    });

    // Transient confirmation shown on the dashboard after a redirect, since the
    // form's own message area is no longer on screen.
    let flashTimer = null;
    function flashBanner(text) {
      let el = $('ee-flash');
      if (!el) {
        el = document.createElement('div');
        el.id = 'ee-flash';
        el.className = 'flash';
        root.querySelector('[data-ee-section="dash"]').prepend(el);
      }
      el.textContent = text;
      el.classList.add('show');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => el.classList.remove('show'), 4000);
    }

    /* ---------------- Manage Lists ---------------- */
    let currentList = 'error_type';
    const LIST_TITLES = { error_type: 'Error Types', root_cause: 'Root Causes', status: 'Statuses' };

    function usageOf(field, value) {
      return (TAX_USAGE[field] && TAX_USAGE[field][value]) || 0;
    }
    function isProtectedValue(field, value) {
      return (PROTECTED_VALUES[field] || []).includes(value);
    }

    // The lists view gates on the SERVER'S can_edit flag, not a local role
    // check, so the UI and the API can never disagree about who may edit.
    function refreshListsGate() {
      $('ee-lists-denied').classList.toggle('hidden', CAN_EDIT_TAXONOMY);
      $('ee-lists-wrap').classList.toggle('hidden', !CAN_EDIT_TAXONOMY);
      if (CAN_EDIT_TAXONOMY) { renderList(); renderPrices(); }
    }

    function renderList() {
      const body = $('ee-list-body');
      $('ee-list-title').textContent = LIST_TITLES[currentList];
      const list = TAXONOMY[currentList] || [];
      if (!list.length) { body.innerHTML = '<div class="empty">No options.</div>'; return; }

      const rows = list.map(o => {
        const n = usageOf(currentList, o.value);
        const prot = isProtectedValue(currentList, o.value);
        const activeCount = list.filter(x => x.active).length;

        // Retiring the last active option would leave the intake form unusable.
        const lastActive = o.active && activeCount <= 1;
        const canRetire = o.active && !prot && !lastActive;
        const canDelete = n === 0 && !prot && !lastActive;

        const buttons = [
          o.active
            ? '<button class="btn-ghost act" data-act="retire" data-v="' + escapeHtml(o.value) + '"' + (canRetire ? '' : ' disabled') + '>Retire</button>'
            : '<button class="btn-sm act" data-act="restore" data-v="' + escapeHtml(o.value) + '">Restore</button>',
          '<button class="btn-ghost act" data-act="rename" data-v="' + escapeHtml(o.value) + '">Rename</button>',
          // Price-list opt-in is only meaningful on root causes today.
          currentList === 'root_cause'
            ? '<button class="btn-ghost act' + (o.price_list ? ' on' : '') + '" data-act="price_list" data-v="' + escapeHtml(o.value) + '" title="Offer the fusion price list when this root cause is chosen">' + (o.price_list ? '✓ Price list' : 'Price list') + '</button>'
            : '',
          '<button class="del-btn act" data-act="delete" data-v="' + escapeHtml(o.value) + '"' + (canDelete ? '' : ' disabled') + ' title="' + (n > 0 ? 'In use \u2014 retire instead' : prot ? 'System option' : 'Delete') + '">✕</button>',
        ].join(' ');

        return '<tr>' +
          '<td><strong>' + escapeHtml(o.label) + '</strong>' + (prot ? ' <span class="tag-sys">system</span>' : '') + '</td>' +
          '<td>' + (o.active ? '<span class="pill resolved">Active</span>' : '<span class="pill written">Retired</span>') + '</td>' +
          '<td>' + n + ' record' + (n === 1 ? '' : 's') + '</td>' +
          '<td style="white-space:nowrap">' + buttons + '</td>' +
          '</tr>';
      }).join('');

      body.innerHTML = '<table><thead><tr>' +
        '<th>Option</th><th>State</th><th>In use</th><th></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>' +
        '<p class="hint" style="margin-top:14px">' +
        "System options can be renamed but not retired \u2014 the dashboard's Open and Resolved " +
        'counters and the resolved-date stamp are built on them.</p>';
    }

    async function taxonomyRequest(method, payload) {
      let url = ENDPOINTS.eeTaxonomy;
      const opts = { method };
      if (method === 'DELETE') {
        url += '?field=' + encodeURIComponent(payload.field) + '&value=' + encodeURIComponent(payload.value);
      } else {
        opts.body = payload;
      }
      return api.request(url, opts);
    }

    // After any list change: refetch taxonomy + usage, rebuild every dropdown,
    // redraw.
    async function afterTaxonomyChange() {
      await loadTaxonomy();
      refreshOptionSelects();
      renderList();
      renderPrices();
      draw();
    }

    $('ee-list-select').addEventListener('change', (e) => {
      currentList = e.target.value;
      renderList();
    });

    $('ee-list-add-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const msg = $('ee-list-msg');
      const typed = $('ee-list-value').value.trim();
      if (!typed) { msg.textContent = 'Enter an option name.'; msg.className = 'msg err'; return; }
      // What you type is the display label. The stored value is derived from it
      // (lowercased server-side) and isn't shown anywhere in the UI.
      try {
        const j = await taxonomyRequest('POST', { field: currentList, value: typed, label: typed });
        $('ee-list-value').value = '';
        await afterTaxonomyChange();
        msg.textContent = j.reactivated ? 'Restored "' + typed + '" (it was retired)' : 'Added "' + typed + '"';
        msg.className = 'msg ok';
        setTimeout(() => { msg.textContent = ''; }, 3500);
      } catch (e) {
        msg.textContent = e.message;
        msg.className = 'msg err';
      }
    });

    $('ee-list-body').addEventListener('click', async (e) => {
      const btn = e.target.closest('.act');
      if (!btn || btn.disabled) return;
      const value = btn.dataset.v;
      const act = btn.dataset.act;
      const msg = $('ee-list-msg');
      msg.textContent = '';

      try {
        if (act === 'rename') {
          const cur = (TAXONOMY[currentList].find(o => o.value === value) || {}).label || value;
          const label = prompt('Rename "' + cur + '" to:', cur);
          if (label == null || !label.trim()) return;
          await taxonomyRequest('PATCH', { field: currentList, value, action: 'rename', label: label.trim() });
        } else if (act === 'retire') {
          const n = usageOf(currentList, value);
          const nm = labelFor(currentList, value);
          const warn = n > 0
            ? '\n\n' + n + ' existing record' + (n === 1 ? '' : 's') + " use this. They keep it and stay countable \u2014 it just won't be offered on new records."
            : '';
          if (!confirm('Retire "' + nm + '"?' + warn)) return;
          await taxonomyRequest('PATCH', { field: currentList, value, action: 'retire' });
        } else if (act === 'restore') {
          await taxonomyRequest('PATCH', { field: currentList, value, action: 'restore' });
        } else if (act === 'price_list') {
          const on = !(TAXONOMY[currentList].find(o => o.value === value) || {}).price_list;
          await taxonomyRequest('PATCH', { field: currentList, value, action: 'price_list', on });
        } else if (act === 'delete') {
          if (!confirm('Permanently delete "' + labelFor(currentList, value) + '"? No records use it, so this is safe \u2014 but it can\'t be undone.')) return;
          await taxonomyRequest('DELETE', { field: currentList, value });
        }
        await afterTaxonomyChange();
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'msg err';
      }
    });

    /* ---------------- fusion price list ---------------- */
    function renderPrices() {
      const body = $('ee-price-body');
      if (!PRICES.length) { body.innerHTML = '<div class="empty">No prices yet.</div>'; return; }
      body.innerHTML = '<table><thead><tr>' +
        '<th>Item</th><th>Cost per unit</th><th></th>' +
        '</tr></thead><tbody>' + PRICES.map(p => '<tr>' +
          '<td><strong>' + escapeHtml(p.label) + '</strong></td>' +
          '<td>' + money(p.unit_cost) + '</td>' +
          '<td style="white-space:nowrap">' +
            '<button class="btn-ghost price-act" data-act="edit" data-id="' + escapeHtml(p.id) + '">Edit</button> ' +
            '<button class="del-btn price-act" data-act="delete" data-id="' + escapeHtml(p.id) + '" title="Delete">✕</button>' +
          '</td>' +
        '</tr>').join('') + '</tbody></table>';
    }

    async function priceRequest(method, payload) {
      let url = ENDPOINTS.eeTaxonomy;
      const opts = { method };
      if (method === 'DELETE') url += '?kind=price&id=' + encodeURIComponent(payload.id);
      else opts.body = { kind: 'price', ...payload };
      const j = await api.request(url, opts);
      PRICES = (j && j.prices) || PRICES;
      return j;
    }

    $('ee-price-add-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const msg = $('ee-price-msg');
      const label = $('ee-price-label').value.trim();
      const cost = $('ee-price-cost').value;
      if (!label || cost === '') { msg.textContent = 'Enter an item and a cost.'; msg.className = 'msg err'; return; }
      try {
        await priceRequest('POST', { label, unit_cost: cost });
        $('ee-price-label').value = '';
        $('ee-price-cost').value = '';
        renderPrices();
        msg.textContent = 'Added "' + label + '"';
        msg.className = 'msg ok';
        setTimeout(() => { msg.textContent = ''; }, 3000);
      } catch (e) { msg.textContent = e.message; msg.className = 'msg err'; }
    });

    $('ee-price-body').addEventListener('click', async (e) => {
      const btn = e.target.closest('.price-act');
      if (!btn) return;
      const id = btn.dataset.id;
      const p = PRICES.find(x => x.id === id);
      const msg = $('ee-price-msg');
      msg.textContent = '';
      try {
        if (btn.dataset.act === 'edit') {
          const label = prompt('Item name:', p ? p.label : '');
          if (label == null) return;
          const cost = prompt('Cost per unit:', p ? p.unit_cost : '');
          if (cost == null) return;
          await priceRequest('PATCH', { id, label: label.trim(), unit_cost: cost });
        } else {
          if (!confirm('Delete "' + (p ? p.label : id) + '" from the price list?\n\nErrors already logged keep their recorded costs.')) return;
          await priceRequest('DELETE', { id });
        }
        renderPrices();
      } catch (err) { msg.textContent = err.message; msg.className = 'msg err'; }
    });

    /* ---------------- boot ---------------- */
    // Taxonomy first — every dropdown and label depends on it.
    await loadTaxonomy();
    refreshOptionSelects();

    // Line editor for the intake form (the detail editor is wired above).
    logLines = [blankLine()];
    var redrawLogLines = wireLines({
      containerId: 'ee-f-lines', addBtnId: 'ee-f-add-line',
      totalId: 'ee-f-grand-total', unitsId: 'ee-f-grand-units',
      get: () => logLines, set: (v) => { logLines = v; },
      causeSelectId: 'ee-f-cause',
    });
    redrawLogLines();
    updateVendorField();
    initCustomerCombo();
    refreshListsGate();

    await loadCustomers();
    await render();
  },

  showView(view) {
    // The shell calls this on every route change; mount() installs the switcher.
    if (showSectionRef) showSectionRef(view);
  }
};
