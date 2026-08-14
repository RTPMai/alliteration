/**
 * PromoPro — purchase orders to vendors, and where each one stands.
 *
 * The problem it replaces: a PO was raised in QuickBooks, emailed to the
 * vendor, and from that moment the only record of what was happening lived in
 * one person's inbox. Nobody else could answer "did they confirm", nothing had
 * a clock on it, and a vendor going quiet for six days looked exactly like a
 * vendor who replied yesterday.
 *
 * Four views:
 *   pipeline  — every open PO grouped by stage, worst health first
 *   orders    — the full list, filterable, and the create form
 *   vendors   — who we buy from, and how long each one normally takes
 *   settings  — defaults
 *
 * Health colours come from lib/promopro/schema.js's poHealth(), which is
 * shared with the server rather than re-implemented here. The one rule this
 * file must not break: a number shown on screen is never computed twice in
 * two places.
 *
 * No fetch() here. Everything goes through ctx.api and ENDPOINTS, per the
 * seam rule.
 */

import { ENDPOINTS } from '../js/api.js';
import {
  STAGES, currentStage, poHealth, poTotal, lineTotal, orderByDate
} from '../lib/promopro/schema.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

export default {
  id: 'promopro',

  styles: `
    .pp-page { padding: 24px 32px 60px; max-width: 1600px; }
    .pp-hd { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 18px; flex-wrap: wrap; gap: 12px; }
    .pp-hd h1 { font-size: 28px; font-weight: 800; letter-spacing: -.02em; }
    .pp-hd .sub { font-size: 13px; color: var(--muted); margin-top: 2px; }

    .pp-btn {
      background: var(--accent); border: 1px solid var(--accent); color: var(--on-accent);
      border-radius: var(--radius-sm); padding: 8px 16px; font-size: 13px; font-weight: 700;
      cursor: pointer; font-family: inherit;
    }
    .pp-btn.ghost { background: var(--card); border-color: var(--line); color: var(--muted); }
    .pp-btn.ghost:hover { color: var(--ink); }
    .pp-btn:disabled { opacity: .5; cursor: default; }

    .pp-filters { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 18px; }
    .pp-filters button {
      background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-sm);
      padding: 6px 12px; font-size: 13px; font-weight: 600; color: var(--muted);
      cursor: pointer; font-family: inherit;
    }
    .pp-filters button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }

    /* ---- pipeline ---- */
    .pp-lanes { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; align-items: start; }
    .pp-lane { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 14px; }
    .pp-lane h3 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 10px; }
    .pp-lane h3 .n { float: right; opacity: .7; }

    .pp-card {
      display: block; width: 100%; text-align: left; font-family: inherit; color: inherit;
      background: var(--bg); border: 1px solid var(--line); border-left-width: 3px;
      border-radius: var(--radius-sm); padding: 10px 12px; margin-bottom: 8px; cursor: pointer;
    }
    .pp-card:hover { border-color: var(--faint); }
    .pp-card .po { font-weight: 700; font-size: 13px; }
    .pp-card .cust { font-size: 12px; color: var(--muted); margin-top: 1px; }
    .pp-card .vend { font-size: 12px; margin-top: 4px; }
    .pp-card .why { font-size: 11px; margin-top: 5px; font-weight: 600; }

    /* Health. Semantic status colours, not app accent: these mean the same
       thing in every app and must not re-theme per app. */
    .pp-h-ok    { border-left-color: var(--line); }
    .pp-h-amber { border-left-color: var(--warn); }
    .pp-h-amber .why { color: var(--warn); }
    .pp-h-red   { border-left-color: var(--danger); }
    .pp-h-red .why { color: var(--danger); }
    .pp-h-done  { border-left-color: var(--success); opacity: .75; }

    /* ---- table ---- */
    .pp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .pp-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 8px 10px; border-bottom: 1px solid var(--line); }
    .pp-table td { padding: 10px; border-bottom: 1px solid var(--line); }
    .pp-table tr[data-po] { cursor: pointer; }
    .pp-table tr[data-po]:hover td { background: var(--accent-tint); }
    .pp-table .num { text-align: right; font-variant-numeric: tabular-nums; }

    .pp-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; background: var(--accent-tint); color: var(--accent-deep); }

    /* ---- forms ---- */
    .pp-form { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 20px; margin-bottom: 20px; }
    .pp-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 12px; }
    .pp-field label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
    .pp-field input, .pp-field select, .pp-field textarea {
      width: 100%; padding: 8px 10px; font-size: 13px; font-family: inherit;
      border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg); color: var(--ink);
    }
    .pp-field textarea { min-height: 64px; resize: vertical; }

    .pp-lines { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 10px; }
    .pp-lines th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--muted); padding: 6px; }
    .pp-lines td { padding: 4px; }
    .pp-lines input { width: 100%; padding: 6px 8px; font-size: 13px; font-family: inherit; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg); color: var(--ink); }
    .pp-lines .w-qty { width: 80px; }
    .pp-lines .w-cost { width: 100px; }

    .pp-search-results { border: 1px solid var(--line); border-radius: var(--radius-sm); margin-top: 6px; max-height: 240px; overflow: auto; }
    .pp-search-results button { display: block; width: 100%; text-align: left; font-family: inherit; color: inherit; background: var(--card); border: 0; border-bottom: 1px solid var(--line); padding: 9px 12px; cursor: pointer; font-size: 13px; }
    .pp-search-results button:hover { background: var(--accent-tint); }

    .pp-empty { padding: 40px; text-align: center; color: var(--muted); font-size: 14px; }
    .pp-notice { background: var(--accent-tint); border: 1px solid var(--accent); border-radius: var(--radius-sm); padding: 12px 14px; font-size: 13px; margin-bottom: 16px; }
    .pp-err { color: var(--danger); font-size: 13px; font-weight: 600; margin-top: 8px; }

    .pp-detail { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 20px; }
    .pp-trail { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 14px 0; }
    .pp-step { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px; }
    .pp-step .k { font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); font-weight: 700; }
    .pp-step input { width: 100%; margin-top: 5px; padding: 5px 7px; font-size: 12px; font-family: inherit; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg); color: var(--ink); }
    .pp-step.done { background: var(--accent-tint); }
  `,

  template: `
    <div class="pp-page" id="ppPipelinePage">
      <div class="pp-hd">
        <div>
          <h1>Pipeline.</h1>
          <div class="sub" id="ppPipeSub">Every open purchase order, by stage.</div>
        </div>
        <button class="pp-btn" id="ppNewFromPipe">New purchase order</button>
      </div>
      <div id="ppPipeBody">Loading…</div>
    </div>

    <div class="pp-page" id="ppOrdersPage" hidden>
      <div class="pp-hd">
        <div>
          <h1>Purchase Orders.</h1>
          <div class="sub" id="ppOrdersSub"></div>
        </div>
        <button class="pp-btn" id="ppNewToggle">New purchase order</button>
      </div>
      <div id="ppFormWrap" hidden></div>
      <div id="ppDetailWrap" hidden></div>
      <div class="pp-filters" id="ppOrdersFilters"></div>
      <div id="ppOrdersBody">Loading…</div>
    </div>

    <div class="pp-page" id="ppVendorsPage" hidden>
      <div class="pp-hd">
        <div>
          <h1>Vendors.</h1>
          <div class="sub">Who we buy from, and how long each one normally takes.</div>
        </div>
        <button class="pp-btn" id="ppNewVendor">Add vendor</button>
      </div>
      <div id="ppVendorsBody">Loading…</div>
    </div>

    <div class="pp-page" id="ppSettingsPage" hidden>
      <div class="pp-hd">
        <div>
          <h1>Settings.</h1>
          <div class="sub">Defaults for new purchase orders.</div>
        </div>
      </div>
      <div id="ppSettingsBody">Loading…</div>
    </div>
  `,

  async mount(ctx) {
    this._root = ctx.root;
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);

    const canEdit = !!(ctx.perms && (ctx.perms.can_edit !== false || ctx.perms.superuser));
    const isAdmin = !!(ctx.perms && (ctx.perms.role === 'admin' || ctx.perms.superuser));

    const st = {
      pos: [],
      vendors: [],
      filter: 'open',
      draftLines: [],
      picked: null,        // the chosen Printavo invoice, if any
      openPoId: null,
      searchTimer: null,
    };

    const vendorById = (id) => st.vendors.find((v) => v.id === id) || null;
    const vendorName = (id) => { const v = vendorById(id); return v ? v.name : 'Unknown vendor'; };

    /* ---------------- loading ---------------- */

    async function loadAll() {
      const [posRes, venRes] = await Promise.all([
        ctx.api.get(ENDPOINTS.ppPos),
        ctx.api.get(ENDPOINTS.ppVendors),
      ]);
      st.pos = (posRes && posRes.pos) || [];
      st.vendors = (venRes && venRes.vendors) || [];
    }

    /* ---------------- pipeline ---------------- */

    function renderPipeline() {
      const body = $('#ppPipeBody');
      const open = st.pos.filter((p) => {
        const s = currentStage(p);
        return s !== 'closed' && s !== 'cancelled' && s !== 'received';
      });

      if (!st.pos.length) {
        body.innerHTML = '<div class="pp-empty">No purchase orders yet. Create one to get started.</div>';
        $('#ppPipeSub').textContent = 'Every open purchase order, by stage.';
        return;
      }

      const scored = open.map((p) => ({ po: p, health: poHealth(p, vendorById(p.vendorId), today()) }));
      const late = scored.filter((x) => x.health.level === 'red').length;
      const soon = scored.filter((x) => x.health.level === 'amber').length;
      $('#ppPipeSub').textContent =
        open.length + ' open, ' + late + ' late, ' + soon + ' needing attention';

      // Draft and closed do not get lanes: draft is not in flight yet and
      // closed is finished. Everything between them is what needs watching.
      const lanes = STAGES.filter((s) => s.key !== 'closed');

      body.innerHTML = '<div class="pp-lanes">' + lanes.map((lane) => {
        const inLane = scored
          .filter((x) => x.health.stage === lane.key)
          .sort((a, b) => {
            const rank = { red: 0, amber: 1, ok: 2, done: 3 };
            return rank[a.health.level] - rank[b.health.level];
          });

        const cards = inLane.length
          ? inLane.map((x) => {
              const p = x.po;
              const why = x.health.reasons.length ? x.health.reasons[0] : '';
              return '<button class="pp-card pp-h-' + x.health.level + '" data-po="' + esc(p.id) + '">' +
                '<div class="po">' + esc(p.poNumber || 'Draft') + '</div>' +
                '<div class="cust">' + esc((p.printavo && p.printavo.customerName) || 'Manual order') + '</div>' +
                '<div class="vend">' + esc(vendorName(p.vendorId)) + ' &middot; ' + money(poTotal(p)) + '</div>' +
                (why ? '<div class="why">' + esc(why) + '</div>' : '') +
              '</button>';
            }).join('')
          : '<div style="font-size:12px;color:var(--muted);padding:4px 0">None</div>';

        return '<div class="pp-lane"><h3>' + esc(lane.label) + '<span class="n">' + inLane.length + '</span></h3>' + cards + '</div>';
      }).join('') + '</div>';
    }

    /* ---------------- orders list ---------------- */

    function renderFilters() {
      const counts = {
        open: st.pos.filter((p) => !['closed', 'cancelled', 'received'].includes(currentStage(p))).length,
        late: st.pos.filter((p) => poHealth(p, vendorById(p.vendorId), today()).level === 'red').length,
        all: st.pos.length,
      };
      $('#ppOrdersFilters').innerHTML = [
        ['open', 'Open', counts.open],
        ['late', 'Late', counts.late],
        ['all', 'All', counts.all],
      ].map(([k, label, n]) =>
        '<button data-filter="' + k + '" aria-pressed="' + (st.filter === k) + '">' + label + ' ' + n + '</button>'
      ).join('');
    }

    function visiblePos() {
      if (st.filter === 'all') return st.pos;
      if (st.filter === 'late') return st.pos.filter((p) => poHealth(p, vendorById(p.vendorId), today()).level === 'red');
      return st.pos.filter((p) => !['closed', 'cancelled', 'received'].includes(currentStage(p)));
    }

    function renderOrders() {
      renderFilters();
      const rows = visiblePos();
      const body = $('#ppOrdersBody');
      $('#ppOrdersSub').textContent = st.pos.length + ' purchase orders on file';

      if (!rows.length) {
        body.innerHTML = '<div class="pp-empty">Nothing here. Try a different filter, or create a purchase order.</div>';
        return;
      }

      body.innerHTML = '<table class="pp-table"><thead><tr>' +
        '<th>PO</th><th>Customer</th><th>Vendor</th><th>Stage</th><th>Needed by</th><th class="num">Total</th><th>Status</th>' +
        '</tr></thead><tbody>' +
        rows.map((p) => {
          const h = poHealth(p, vendorById(p.vendorId), today());
          const stageDef = STAGES.find((s) => s.key === h.stage);
          const due = p.neededBy || (p.printavo && p.printavo.dueDate) || '';
          return '<tr data-po="' + esc(p.id) + '">' +
            '<td><strong>' + esc(p.poNumber || 'Draft') + '</strong></td>' +
            '<td>' + esc((p.printavo && p.printavo.customerName) || 'Manual order') + '</td>' +
            '<td>' + esc(vendorName(p.vendorId)) + '</td>' +
            '<td><span class="pp-pill">' + esc(stageDef ? stageDef.label : h.stage) + '</span></td>' +
            '<td>' + esc(due) + '</td>' +
            '<td class="num">' + money(poTotal(p)) + '</td>' +
            '<td class="pp-h-' + h.level + '"><span class="why">' + esc(h.reasons[0] || (h.level === 'done' ? 'Complete' : 'On track')) + '</span></td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    }

    /* ---------------- create form ---------------- */

    function lineRowHtml(l, i) {
      return '<tr data-line="' + i + '">' +
        '<td><input data-f="description" value="' + esc(l.description) + '" placeholder="Item"></td>' +
        '<td><input data-f="detail" value="' + esc(l.detail || '') + '" placeholder="Color / sizes"></td>' +
        '<td><input class="w-qty" data-f="qty" type="number" min="0" value="' + esc(l.qty) + '"></td>' +
        '<td><input class="w-cost" data-f="unitCost" type="number" step="0.01" min="0" value="' + esc(l.unitCost) + '"></td>' +
        '<td class="num">' + money(lineTotal(l)) + '</td>' +
        '<td><button class="pp-btn ghost" data-rmline="' + i + '">Remove</button></td>' +
      '</tr>';
    }

    function renderForm() {
      const wrap = $('#ppFormWrap');
      const vendorOpts = st.vendors.filter((v) => v.active !== false)
        .map((v) => '<option value="' + esc(v.id) + '">' + esc(v.name) + '</option>').join('');

      const total = st.draftLines.reduce((a, l) => a + lineTotal(l), 0);

      wrap.innerHTML = '<div class="pp-form">' +
        (st.vendors.length ? '' : '<div class="pp-notice">No vendors yet. Add one on the Vendors tab first, since a purchase order has to go to somebody.</div>') +

        '<div class="pp-field" style="margin-bottom:12px">' +
          '<label>Find the Printavo quote or invoice</label>' +
          '<input id="ppSearch" placeholder="Invoice number or customer name. Leave blank for a manual web order.">' +
          '<div id="ppSearchResults"></div>' +
        '</div>' +

        (st.picked
          ? '<div class="pp-notice">Filling from Printavo invoice <strong>' + esc(st.picked.invoiceNumber) + '</strong>' +
            (st.picked.customerName ? ' for ' + esc(st.picked.customerName) : '') +
            (st.picked.dueDate ? ', due ' + esc(st.picked.dueDate) : '') +
            ' <button class="pp-btn ghost" id="ppClearPick">Clear</button></div>'
          : '') +

        '<div class="pp-row">' +
          '<div class="pp-field"><label>Vendor</label><select id="ppVendor">' +
            '<option value="">Choose a vendor</option>' + vendorOpts + '</select></div>' +
          '<div class="pp-field"><label>Needed by</label><input id="ppNeededBy" type="date" value="' + esc((st.picked && st.picked.dueDate) || '') + '"></div>' +
          '<div class="pp-field"><label>Decorating buffer (days)</label><input id="ppBuffer" type="number" min="0" value="0"></div>' +
        '</div>' +

        '<table class="pp-lines"><thead><tr>' +
          '<th>Description</th><th>Detail</th><th>Qty</th><th>Our cost</th><th class="num">Line total</th><th></th>' +
        '</tr></thead><tbody id="ppLinesBody">' +
          (st.draftLines.length ? st.draftLines.map(lineRowHtml).join('') : '') +
        '</tbody></table>' +
        '<button class="pp-btn ghost" id="ppAddLine">Add a line</button>' +
        '<div style="float:right;font-weight:700;padding-top:8px">Total ' + money(total) + '</div>' +
        '<div style="clear:both"></div>' +

        '<div class="pp-row" style="margin-top:14px">' +
          '<div class="pp-field"><label>Ship to</label><input id="ppShipTo" placeholder="Our shop, or drop ship address"></div>' +
        '</div>' +
        '<div class="pp-field"><label>Notes to the vendor</label><textarea id="ppNotes"></textarea></div>' +

        '<div style="margin-top:14px;display:flex;gap:8px">' +
          '<button class="pp-btn" id="ppSave">Create purchase order</button>' +
          '<button class="pp-btn ghost" id="ppCancel">Cancel</button>' +
        '</div>' +
        '<div class="pp-err" id="ppFormErr" hidden></div>' +
      '</div>';
    }

    async function runSearch(term) {
      const box = $('#ppSearchResults');
      if (!box) return;
      if (!String(term || '').trim()) { box.innerHTML = ''; return; }
      box.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--muted)">Searching…</div>';
      try {
        const res = await ctx.api.get(ENDPOINTS.ppPrintavo, { q: term });
        if (res && res.configured === false) {
          box.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--muted)">Printavo is not connected, so fill the lines in by hand.</div>';
          return;
        }
        if (res && res.error) {
          box.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--muted)">Search is unavailable right now. Fill the lines in by hand.</div>';
          return;
        }
        const results = (res && res.results) || [];
        box.innerHTML = results.length
          ? '<div class="pp-search-results">' + results.map((r) =>
              '<button data-inv="' + esc(r.id) + '"><strong>' + esc(r.invoiceNumber) + '</strong> ' +
              esc(r.customerName) + (r.dueDate ? ' &middot; due ' + esc(r.dueDate) : '') +
              ' &middot; ' + money(r.total) + '</button>'
            ).join('') + '</div>'
          : '<div style="padding:8px;font-size:12px;color:var(--muted)">Nothing matched.</div>';
      } catch (e) {
        box.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--muted)">Search failed. Fill the lines in by hand.</div>';
      }
    }

    async function pickInvoice(id) {
      const res = await ctx.api.get(ENDPOINTS.ppPrintavo, { id });
      const inv = res && res.invoice;
      if (!inv) return;
      st.picked = inv;
      // Costs come back zero on purpose. Printavo holds what we CHARGE, and
      // a PO holds what the vendor charges US, so copying the sell price in
      // would look filled-in and be wrong.
      st.draftLines = inv.lines.map((l) => ({ ...l }));
      renderForm();
    }

    /* ---------------- detail ---------------- */

    function renderDetail(po) {
      const wrap = $('#ppDetailWrap');
      const v = vendorById(po.vendorId);
      const h = poHealth(po, v, today());
      const orderBy = orderByDate(po, v);

      wrap.innerHTML = '<div class="pp-detail">' +
        '<div class="pp-hd"><div>' +
          '<h1 style="font-size:22px">' + esc(po.poNumber || 'Draft') + '</h1>' +
          '<div class="sub">' + esc(vendorName(po.vendorId)) + ' &middot; ' +
            esc((po.printavo && po.printavo.customerName) || 'Manual order') +
            (po.printavo ? ' &middot; Printavo ' + esc(po.printavo.invoiceNumber) : '') +
          '</div>' +
        '</div><button class="pp-btn ghost" id="ppCloseDetail">Close</button></div>' +

        (h.reasons.length ? '<div class="pp-notice"><strong>Attention.</strong> ' + esc(h.reasons.join('. ')) + '</div>' : '') +
        (orderBy ? '<div class="sub" style="font-size:12px;color:var(--muted)">To hit the due date this needed ordering by ' + esc(orderBy) + '</div>' : '') +

        '<div class="pp-trail">' + STAGES.filter((s) => s.dateField).map((s) => {
          const val = po[s.dateField] || '';
          return '<div class="pp-step' + (val ? ' done' : '') + '">' +
            '<div class="k">' + esc(s.label) + '</div>' +
            '<input type="date" data-datefield="' + esc(s.dateField) + '" value="' + esc(val) + '"' + (canEdit ? '' : ' disabled') + '>' +
          '</div>';
        }).join('') + '</div>' +

        '<div class="pp-row">' +
          '<div class="pp-field"><label>Carrier</label><input id="ppCarrier" value="' + esc(po.carrier || '') + '"' + (canEdit ? '' : ' disabled') + '></div>' +
          '<div class="pp-field"><label>Tracking number</label><input id="ppTracking" value="' + esc(po.trackingNumber || '') + '"' + (canEdit ? '' : ' disabled') + '></div>' +
        '</div>' +

        '<table class="pp-table"><thead><tr><th>Description</th><th>Detail</th><th class="num">Qty</th><th class="num">Cost</th><th class="num">Total</th></tr></thead><tbody>' +
          (po.lines || []).map((l) =>
            '<tr><td>' + esc(l.description) + '</td><td>' + esc(l.detail || '') + '</td>' +
            '<td class="num">' + esc(l.qty) + '</td><td class="num">' + money(l.unitCost) + '</td>' +
            '<td class="num">' + money(lineTotal(l)) + '</td></tr>'
          ).join('') +
          '<tr><td colspan="4" class="num"><strong>Total</strong></td><td class="num"><strong>' + money(poTotal(po)) + '</strong></td></tr>' +
        '</tbody></table>' +

        (canEdit ? '<div style="margin-top:14px"><button class="pp-btn" id="ppSaveDetail">Save changes</button></div>' : '') +
        '<div class="pp-err" id="ppDetailErr" hidden></div>' +
      '</div>';

      wrap.hidden = false;
      $('#ppFormWrap').hidden = true;
    }

    /* ---------------- vendors ---------------- */

    function renderVendors() {
      const body = $('#ppVendorsBody');
      if (!st.vendors.length) {
        body.innerHTML = '<div class="pp-empty">No vendors yet. Add the suppliers you order promo from, with how long each one usually takes.</div>';
        return;
      }
      body.innerHTML = '<table class="pp-table"><thead><tr>' +
        '<th>Vendor</th><th>Email</th><th>Terms</th><th class="num">Lead days</th><th>Prepay</th><th>Open POs</th>' + (isAdmin ? '<th></th>' : '') +
        '</tr></thead><tbody>' +
        st.vendors.map((v) => {
          const openCount = st.pos.filter((p) => p.vendorId === v.id && !['closed', 'cancelled', 'received'].includes(currentStage(p))).length;
          return '<tr' + (v.active === false ? ' style="opacity:.5"' : '') + '>' +
            '<td><strong>' + esc(v.name) + '</strong>' + (v.active === false ? ' <span class="pp-pill">Inactive</span>' : '') + '</td>' +
            '<td>' + esc(v.email || '') + '</td>' +
            '<td>' + esc(v.terms || '') + '</td>' +
            '<td class="num">' + esc(v.leadDays) + '</td>' +
            '<td>' + (v.prepay ? 'Yes' : 'No') + '</td>' +
            '<td>' + openCount + '</td>' +
            (isAdmin ? '<td><button class="pp-btn ghost" data-rmvendor="' + esc(v.id) + '">Remove</button></td>' : '') +
          '</tr>';
        }).join('') + '</tbody></table>';
    }

    function renderSettings() {
      $('#ppSettingsBody').innerHTML =
        '<div class="pp-form">' +
        '<p style="font-size:13px;color:var(--muted);margin-bottom:12px">' +
        'PromoPro builds the PO number from the year, the Printavo invoice number, and an imprint sequence when a job has more than one. ' +
        'A manual web order has no invoice, so it uses an M sequence instead, which makes it obvious that no Printavo job sits behind it.' +
        '</p>' +
        '<p style="font-size:13px;color:var(--muted)">' +
        'Per-vendor lead times and stage waits live on the Vendors tab, since what counts as late depends on who you are waiting for.' +
        '</p>' +
        '</div>';
    }

    function renderAll() {
      renderPipeline();
      renderOrders();
      renderVendors();
      renderSettings();
    }

    /* ---------------- events ---------------- */

    // One delegated listener on the app root, not on document: several apps
    // are mounted at once and a click in BackBone must not reach this handler.
    root.addEventListener('click', async (e) => {
      const t = e.target.closest('button, tr[data-po]');
      if (!t || !root.contains(t)) return;

      if (t.id === 'ppNewFromPipe' || t.id === 'ppNewToggle') {
        st.picked = null;
        st.draftLines = [{ description: '', detail: '', qty: 1, unitCost: 0 }];
        renderForm();
        $('#ppFormWrap').hidden = false;
        $('#ppDetailWrap').hidden = true;
        if (t.id === 'ppNewFromPipe') this.showView('orders');
        return;
      }

      if (t.id === 'ppCancel') { $('#ppFormWrap').hidden = true; return; }
      if (t.id === 'ppCloseDetail') { $('#ppDetailWrap').hidden = true; st.openPoId = null; return; }
      if (t.id === 'ppClearPick') { st.picked = null; renderForm(); return; }

      if (t.id === 'ppAddLine') {
        st.draftLines.push({ description: '', detail: '', qty: 1, unitCost: 0 });
        renderForm();
        return;
      }

      if (t.dataset && t.dataset.rmline !== undefined) {
        st.draftLines.splice(Number(t.dataset.rmline), 1);
        renderForm();
        return;
      }

      if (t.dataset && t.dataset.inv) { await pickInvoice(t.dataset.inv); return; }

      if (t.dataset && t.dataset.filter) { st.filter = t.dataset.filter; renderOrders(); return; }

      if (t.dataset && t.dataset.po) {
        const po = st.pos.find((p) => p.id === t.dataset.po);
        if (po) { st.openPoId = po.id; renderDetail(po); this.showView('orders'); }
        return;
      }

      if (t.id === 'ppSave') { await saveNew(); return; }
      if (t.id === 'ppSaveDetail') { await saveDetail(); return; }

      if (t.dataset && t.dataset.rmvendor) {
        await ctx.api.request(ENDPOINTS.ppVendors + '?id=' + encodeURIComponent(t.dataset.rmvendor), { method: 'DELETE' });
        await loadAll();
        renderAll();
        return;
      }

      if (t.id === 'ppNewVendor') { await addVendorPrompt(); return; }
    });

    // Line edits write straight back to the draft rather than being read off
    // the DOM at save time, so a re-render never loses what was typed.
    root.addEventListener('input', (e) => {
      const cell = e.target.closest('#ppLinesBody tr[data-line] input');
      if (cell) {
        const i = Number(e.target.closest('tr').dataset.line);
        const f = e.target.dataset.f;
        if (st.draftLines[i]) {
          st.draftLines[i][f] = (f === 'qty' || f === 'unitCost') ? Number(e.target.value) : e.target.value;
        }
        return;
      }
      if (e.target.id === 'ppSearch') {
        clearTimeout(st.searchTimer);
        const val = e.target.value;
        st.searchTimer = setTimeout(() => runSearch(val), 350);
      }
    });

    async function saveNew() {
      const err = $('#ppFormErr');
      err.hidden = true;
      const payload = {
        vendorId: $('#ppVendor').value,
        neededBy: $('#ppNeededBy').value || null,
        decorateBufferDays: Number($('#ppBuffer').value) || 0,
        shipTo: $('#ppShipTo').value,
        notes: $('#ppNotes').value,
        lines: st.draftLines,
        printavo: st.picked ? {
          id: st.picked.id,
          invoiceNumber: st.picked.invoiceNumber,
          customerName: st.picked.customerName,
          dueDate: st.picked.dueDate,
        } : null,
      };
      try {
        const res = await ctx.api.post(ENDPOINTS.ppPos, payload);
        if (res && res.error) { err.textContent = res.error; err.hidden = false; return; }
        st.picked = null;
        st.draftLines = [];
        $('#ppFormWrap').hidden = true;
        await loadAll();
        renderAll();
      } catch (e) {
        err.textContent = e.message || 'Could not save.';
        err.hidden = false;
      }
    }

    async function saveDetail() {
      const err = $('#ppDetailErr');
      err.hidden = true;
      const patch = { id: st.openPoId, carrier: $('#ppCarrier').value, trackingNumber: $('#ppTracking').value };
      root.querySelectorAll('[data-datefield]').forEach((el) => {
        patch[el.dataset.datefield] = el.value || null;
      });
      try {
        const res = await ctx.api.request(ENDPOINTS.ppPos, { method: 'PATCH', body: JSON.stringify(patch) });
        if (res && res.error) { err.textContent = res.error; err.hidden = false; return; }
        await loadAll();
        renderAll();
        const po = st.pos.find((p) => p.id === st.openPoId);
        if (po) renderDetail(po);
      } catch (e) {
        err.textContent = e.message || 'Could not save.';
        err.hidden = false;
      }
    }

    async function addVendorPrompt() {
      const name = window.prompt('Vendor name');
      if (!name) return;
      const lead = window.prompt('How many days from confirmed order to goods on our dock?', '10');
      try {
        await ctx.api.post(ENDPOINTS.ppVendors, { name, leadDays: Number(lead) || 10 });
        await loadAll();
        renderAll();
      } catch (e) {
        window.alert(e.message || 'Could not add the vendor.');
      }
    }

    await loadAll();
    renderAll();
  },

  showView(view) {
    const root = this._root;
    if (!root) return;
    const pages = {
      pipeline: '#ppPipelinePage',
      orders: '#ppOrdersPage',
      vendors: '#ppVendorsPage',
      settings: '#ppSettingsPage',
    };
    Object.keys(pages).forEach((k) => {
      const el = root.querySelector(pages[k]);
      if (el) el.hidden = (k !== view);
    });
    if (!pages[view]) {
      const el = root.querySelector(pages.pipeline);
      if (el) el.hidden = false;
    }
  }
};
