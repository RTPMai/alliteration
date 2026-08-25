// apps/promopro.js
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
  STAGES, currentStage, poHealth, poTotal, lineTotal, orderByDate,
  withSettingDefaults, ccListFor, parseEmailList, receiptSummary
} from '../lib/promopro/schema.js';
import { promoGroups } from '../lib/promopro/printavo-lookup.js';

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
    .pp-pill.bad { background: var(--danger-tint); color: var(--danger-dk); }

    .pp-addvendor { color: var(--accent); font-weight: 700; }

    /* Quick-add sits over the order form rather than replacing it: the half
       finished purchase order underneath must still be there afterwards. */
    .pp-modal-back {
      position: fixed; inset: 0; background: rgba(0,0,0,.35);
      display: flex; align-items: flex-start; justify-content: center;
      padding: 8vh 16px; z-index: 60;
    }
    .pp-modal {
      background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
      width: 100%; max-width: 620px; padding: 20px 22px 22px; box-shadow: var(--shadow-pop);
      max-height: 80vh; overflow: auto;
    }
    .pp-modal h2 { font-size: 18px; font-weight: 800; margin-bottom: 2px; }

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
    .pp-lines .w-item { width: 130px; }
    .pp-lines .pp-imprintline { margin-top: 4px; font-size: 12px; color: var(--muted); }
    .pp-lines td { vertical-align: top; }
    .pp-lines .w-qty { width: 80px; }
    .pp-lines .w-cost { width: 100px; }

    .pp-search-results { border: 1px solid var(--line); border-radius: var(--radius-sm); margin-top: 6px; max-height: 240px; overflow: auto; }
    .pp-search-results button { display: block; width: 100%; text-align: left; font-family: inherit; color: inherit; background: var(--card); border: 0; border-bottom: 1px solid var(--line); padding: 9px 12px; cursor: pointer; font-size: 13px; }
    .pp-search-results button:hover { background: var(--accent-tint); }

    .pp-empty { padding: 40px; text-align: center; color: var(--muted); font-size: 14px; }
    .pp-notice { background: var(--accent-tint); border: 1px solid var(--accent); border-radius: var(--radius-sm); padding: 12px 14px; font-size: 13px; margin-bottom: 16px; }
    .pp-err { color: var(--danger); font-size: 13px; font-weight: 600; margin-top: 8px; }

    .pp-sect { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 18px 0 8px; }
    .pp-sect:first-child { margin-top: 0; }
    .pp-hint { font-size: 11px; color: var(--muted); margin-top: 4px; }

    .pp-amgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }
    .pp-amrow {
      display: flex; gap: 10px; align-items: flex-start; cursor: pointer;
      border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; background: var(--bg);
    }
    .pp-amrow:hover { border-color: var(--faint); }
    .pp-amrow.off { opacity: .55; cursor: default; }
    .pp-amrow input { margin-top: 2px; }
    .pp-amrow .nm { display: block; font-size: 13px; font-weight: 700; }
    .pp-amrow .dept { display: inline-block; font-size: 11px; color: var(--muted); }
    .pp-amrow .em { display: block; font-size: 11px; color: var(--muted); }

    .pp-imprints { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
    .pp-imprint {
      display: flex; gap: 10px; align-items: flex-start; cursor: pointer;
      border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; background: var(--bg);
    }
    .pp-imprint.on { border-color: var(--accent); background: var(--accent-tint); }
    .pp-imprint .nm { display: block; font-size: 13px; font-weight: 700; }
    .pp-imprint .em { display: block; font-size: 11px; color: var(--muted); }

    .pp-cattag {
      display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
      border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; margin-right: 4px; font-size: 11px;
    }
    .pp-cattag.on { border-color: var(--accent); background: var(--accent-tint); color: var(--accent-deep); font-weight: 700; }

    .pp-locked {
      display: flex; align-items: center; gap: 12px; justify-content: space-between;
      border: 1px solid var(--accent); background: var(--accent-tint);
      border-radius: var(--radius-sm); padding: 12px 14px; margin-bottom: 14px; font-size: 13px;
    }
    .pp-confirm { display: flex; align-items: flex-end; gap: 12px; margin: 14px 0 4px; }

    .pp-artgrid { display: flex; flex-direction: column; gap: 6px; }
    .pp-artrow {
      display: flex; align-items: center; gap: 10px;
      border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 8px 12px; background: var(--bg);
    }
    .pp-artrow a { font-size: 13px; font-weight: 600; color: var(--accent-deep); }
    .pp-artrow .sz { font-size: 11px; color: var(--muted); margin-left: auto; }

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
      <div id="ppVendorFormWrap" hidden></div>
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
      settings: { chaseAfterDays: 3, alwaysCc: [], accountManagers: [] },
      loadErrors: [],
      settingsFailed: false,
      filter: 'open',
      draftLines: [],
      draftVendorId: '',
      pickedGroups: [],      // the imprints this PO covers
      imprintLocked: false,  // selection confirmed, picker collapsed
      poSuffix: '',          // what goes after the invoice number
      stagedArt: [],         // files chosen before the PO exists yet
      picked: null,        // the chosen Printavo invoice, if any
      openPoId: null,
      searchTimer: null,
    };

    const vendorById = (id) => st.vendors.find((v) => v.id === id) || null;
    const vendorName = (id) => { const v = vendorById(id); return v ? v.name : 'Unknown vendor'; };

    /* ---------------- loading ---------------- */

    async function loadAll() {
      // allSettled, not all. One endpoint that has not deployed yet should
      // degrade that section, not blank the whole app. A 404 on settings
      // used to take the entire screen down with "could not load PromoPro",
      // which says nothing about which of three routes was missing.
      const [posRes, venRes, setRes] = await Promise.allSettled([
        ctx.api.get(ENDPOINTS.ppPos),
        ctx.api.get(ENDPOINTS.ppVendors),
        ctx.api.get(ENDPOINTS.ppSettings),
      ]);

      st.loadErrors = [];
      const took = (res, key, fallback, label) => {
        if (res.status === 'fulfilled') return (res.value && res.value[key]) || fallback;
        st.loadErrors.push(label + ': ' + (res.reason && res.reason.message ? res.reason.message : 'failed'));
        return fallback;
      };

      st.pos = took(posRes, 'pos', [], 'Purchase orders');
      st.vendors = took(venRes, 'vendors', [], 'Vendors');
      st.settingsFailed = setRes.status !== 'fulfilled';
      st.settings = withSettingDefaults(took(setRes, 'settings', null, 'Settings'));
    }

    function loadErrorHtml() {
      if (!st.loadErrors || !st.loadErrors.length) return '';
      return '<div class="pp-notice"><strong>Some data did not load.</strong> ' +
        esc(st.loadErrors.join('. ')) +
        '. If this says 404, that route has not been deployed yet.</div>';
    }

    // One wrapper so every screen judges lateness against the same shop-wide
    // setting. Calling poHealth directly anywhere would quietly fall back to
    // the built-in default and disagree with the rest of the app.
    const health = (p) => poHealth(p, vendorById(p.vendorId), today(), { chaseAfterDays: st.settings.chaseAfterDays });

    const amById = (id) => st.settings.accountManagers.find((a) => a.id === id) || null;
    const amName = (id) => { const a = amById(id); return a ? a.name : 'Unassigned'; };

    /* ---------------- pipeline ---------------- */

    function renderPipeline() {
      const body = $('#ppPipeBody');
      const open = st.pos.filter((p) => {
        const s = currentStage(p);
        return s !== 'closed' && s !== 'cancelled' && s !== 'received';
      });

      if (!st.pos.length) {
        body.innerHTML = loadErrorHtml() + '<div class="pp-empty">No purchase orders yet. Create one to get started.</div>';
        $('#ppPipeSub').textContent = 'Every open purchase order, by stage.';
        return;
      }

      const scored = open.map((p) => ({ po: p, health: health(p) }));
      const late = scored.filter((x) => x.health.level === 'red').length;
      const soon = scored.filter((x) => x.health.level === 'amber').length;
      $('#ppPipeSub').textContent =
        open.length + ' open, ' + late + ' late, ' + soon + ' needing attention';

      // Draft and closed do not get lanes: draft is not in flight yet and
      // closed is finished. Everything between them is what needs watching.
      const lanes = STAGES.filter((s) => s.key !== 'closed');

      body.innerHTML = loadErrorHtml() + '<div class="pp-lanes">' + lanes.map((lane) => {
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
        late: st.pos.filter((p) => health(p).level === 'red').length,
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
      if (st.filter === 'late') return st.pos.filter((p) => health(p).level === 'red');
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
        '<th>PO</th><th>Customer</th><th>Vendor</th><th>AM</th><th>Stage</th><th>Needed by</th><th class="num">Total</th><th>Status</th>' +
        '</tr></thead><tbody>' +
        rows.map((p) => {
          const h = health(p);
          const stageDef = STAGES.find((s) => s.key === h.stage);
          const due = p.neededBy || (p.printavo && p.printavo.dueDate) || '';
          return '<tr data-po="' + esc(p.id) + '">' +
            '<td><strong>' + esc(p.poNumber || 'Draft') + '</strong></td>' +
            '<td>' + esc((p.printavo && p.printavo.customerName) || 'Manual order') + '</td>' +
            '<td>' + esc(vendorName(p.vendorId)) + '</td>' +
            '<td>' + esc(amName(p.accountManager)) + '</td>' +
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
        '<td><input class="w-item" data-f="itemNumber" value="' + esc(l.itemNumber || '') + '" placeholder="e.g. 1234-BLK"></td>' +
        '<td>' +
          '<input data-f="description" value="' + esc(l.description) + '" placeholder="Item">' +
          // Imprint sits under the description because it describes the same
          // line, and because a vendor reads "what is it" then "what goes on
          // it" in that order. Pulled from Printavo, editable: the wording a
          // supplier needs is not always the wording the quote used.
          '<input class="pp-imprintline" data-f="imprint" value="' + esc(l.imprint || '') + '" placeholder="Imprint, pulled from Printavo">' +
        '</td>' +
        '<td><input data-f="detail" value="' + esc(l.detail || '') + '" placeholder="Color / sizes"></td>' +
        '<td><input class="w-qty" data-f="qty" type="number" min="0" value="' + esc(l.qty) + '"></td>' +
        '<td><input class="w-cost" data-f="unitCost" type="number" step="0.01" min="0" value="' + esc(l.unitCost) + '"></td>' +
        '<td class="num" data-linetotal>' + money(lineTotal(l)) + '</td>' +
        '<td><button class="pp-btn ghost" data-rmline="' + i + '">Remove</button></td>' +
      '</tr>';
    }

    function renderForm() {
      const wrap = $('#ppFormWrap');
      const pickedVendor = vendorById(st.draftVendorId);
      const pickedVendorName = pickedVendor ? pickedVendor.name : '';
      const amOpts = st.settings.accountManagers
        .map((a) => '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>').join('');

      const total = st.draftLines.reduce((a, l) => a + lineTotal(l), 0);

      wrap.innerHTML = '<div class="pp-form">' +
        (st.vendors.length ? '' : '<div class="pp-notice">No vendors yet. Add one on the Vendors tab first, since a purchase order has to go to somebody.</div>') +
        (st.settings.accountManagers.length ? '' : '<div class="pp-notice">No account managers set up yet. Add them in Settings, since every purchase order needs an owner and they get copied on the vendor email.</div>') +

        (st.imprintLocked ? '' :
          '<div class="pp-field" style="margin-bottom:12px">' +
            '<label>Find the Printavo quote or invoice</label>' +
            '<input id="ppSearch" placeholder="Invoice number or customer name. Leave blank for a manual web order.">' +
            '<div id="ppSearchResults"></div>' +
          '</div>') +

        (st.picked && !st.imprintLocked
          ? '<div class="pp-notice">Filling from Printavo invoice <strong>' + esc(st.picked.invoiceNumber) + '</strong>' +
            (st.picked.customerName ? ' for ' + esc(st.picked.customerName) : '') +
            (st.picked.dueDate ? ', due ' + esc(st.picked.dueDate) : '') +
            ' <button class="pp-btn ghost" id="ppClearPick">Clear</button>' +
            (st.pickedVia && st.pickedVia !== 'full'
              ? '<div class="pp-hint">Printavo gave us the "' + esc(st.pickedVia) + '" field set, so some detail columns are blank. Mention this and the fallback can be tuned to your account.</div>'
              : '') +
            '</div>'
          : '') +

        imprintPickerHtml() +

        '<div class="pp-row">' +
          // Searchable rather than a plain select: the vendor list grows past
          // the point where scrolling a dropdown is faster than typing three
          // letters. The id lives in a hidden field so the value posted is
          // always a real vendor, never whatever text was typed.
          '<div class="pp-field"><label>Vendor</label>' +
            '<input id="ppVendorSearch" autocomplete="off" placeholder="Start typing a vendor name" value="' + esc(pickedVendorName) + '">' +
            (pickedVendor && pickedVendor.blacklisted === true
              ? '<div class="pp-notice" style="margin-top:6px"><strong>' + esc(pickedVendor.name) + ' is blacklisted.</strong> ' +
                esc(pickedVendor.blacklistReason || 'No reason was recorded.') +
                ' You will be asked to confirm before this order is created.</div>'
              : '') +
            '<input type="hidden" id="ppVendor" value="' + esc(st.draftVendorId || '') + '">' +
            '<div id="ppVendorResults"></div>' +
          '</div>' +
          '<div class="pp-field"><label>Account manager (required)</label><select id="ppAm">' +
            '<option value="">Choose an account manager</option>' + amOpts + '</select></div>' +
          '<div class="pp-field"><label>Needed by</label><input id="ppNeededBy" type="date" value="' + esc((st.picked && st.picked.dueDate) || '') + '"></div>' +
          '<div class="pp-field"><label>Decorating buffer (days)</label><input id="ppBuffer" type="number" min="0" value="0"></div>' +
        '</div>' +

        // Shown before sending, not after. Who gets copied on an email to an
        // outside party is worth seeing while you can still change it.
        '<div id="ppCcPreview" style="font-size:12px;color:var(--muted);margin-bottom:12px"></div>' +

        '<table class="pp-lines"><thead><tr>' +
          '<th>Item #</th><th>Description</th><th>Detail</th><th>Qty</th><th>Our cost</th><th class="num">Line total</th><th></th>' +
        '</tr></thead><tbody id="ppLinesBody">' +
          (st.draftLines.length ? st.draftLines.map(lineRowHtml).join('') : '') +
        '</tbody></table>' +
        '<button class="pp-btn ghost" id="ppAddLine">Add a line</button>' +
        '<div id="ppDraftTotal" style="float:right;font-weight:700;padding-top:8px">Total ' + money(total) + '</div>' +
        '<div style="clear:both"></div>' +

        '<div class="pp-row" style="margin-top:14px">' +
          '<div class="pp-field"><label>Ship to</label>' +
            '<input id="ppShipTo" value="' + esc(st.settings.defaultShipTo || '') + '" placeholder="Our shop, or drop ship address">' +
            '<div class="pp-hint">Prefilled from Settings. Change it for a drop ship.</div>' +
          '</div>' +
          '<div class="pp-field"><label>Shipping instructions</label>' +
            '<input id="ppShipVia" value="' + esc(st.settings.shippingInstructions || '') + '" placeholder="Set a default in Settings">' +
          '</div>' +
        '</div>' +
        '<div class="pp-field"><label>Notes to the vendor</label><textarea id="ppNotes"></textarea></div>' +

        '<div class="pp-sect">Artwork for the vendor</div>' +
        '<div class="pp-hint" style="margin-bottom:8px">' +
          'Optional now, and you can always add more later from the order itself. ' +
          'Anyone with the link can open these without signing in, which is how the vendor gets them.' +
        '</div>' +
        '<div id="ppStagedArt">' + stagedArtHtml() + '</div>' +
        '<div style="margin-top:8px">' +
          '<input type="file" id="ppStageFile" multiple style="display:none" ' +
            'accept=".ai,.eps,.svg,.psd,.pdf,.indd,.tif,.tiff,.cdr,.zip,image/*,application/pdf">' +
          '<button class="pp-btn ghost" id="ppStagePick">Attach artwork</button>' +
        '</div>' +

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
      const box = $('#ppSearchResults');
      if (box) box.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--muted)">Loading that order…</div>';

      let res;
      try {
        res = await ctx.api.get(ENDPOINTS.ppPrintavo, { id });
      } catch (e) {
        if (box) box.innerHTML = '<div class="pp-notice">Could not load that order: ' + esc(e.message || 'request failed') + '. Fill the lines in by hand.</div>';
        return;
      }

      const inv = res && res.invoice;
      if (!inv) {
        // Never fail silently here. A search result that does nothing when
        // clicked is the worst possible outcome: nothing to read, nothing to
        // report, and no way to tell a broken lookup from a slow one.
        const why = (res && res.error) || 'Printavo returned nothing for that order';
        if (box) {
          box.innerHTML = '<div class="pp-notice"><strong>Could not load that order.</strong> ' + esc(why) +
            '<br>You can still build the PO by hand: fill in the lines below.</div>';
        }
        return;
      }

      st.picked = inv;
      // Pick the promo imprint automatically when the shop has told us which
      // categories count. When it has not, leave nothing selected and let the
      // imprint list ask, rather than guessing and quietly pulling garments
      // onto a promo PO.
      const promo = promoGroups(inv, st.settings.promoCategories);
      // Preselect when there is only one sensible answer: either the promo
      // categories point at exactly one imprint, or the job only has one
      // imprint at all. Anything else is a real choice and stays unpicked,
      // because guessing would quietly put garments on a promo PO.
      st.pickedGroups =
        (promo.matched && promo.groups.length) ? promo.groups.map((g) => g.id)
        : ((inv.groups || []).length === 1 ? [inv.groups[0].id] : []);
      st.imprintLocked = false;
      applyGroupSelection();
      // Which field set Printavo accepted. Worth surfacing once: it tells us
      // this account's real schema, so the fallback ladder can be trimmed to
      // the one that works instead of guessing on every lookup.
      st.pickedVia = (res && res.via) || null;
      // Costs come back zero on purpose. Printavo holds what we CHARGE, and
      // a PO holds what the vendor charges US, so copying the sell price in
      // would look filled-in and be wrong.
      renderForm();
    }

    /** Copy the chosen imprints' lines into the draft, in imprint order. */
    function applyGroupSelection() {
      const inv = st.picked;
      if (!inv) { st.draftLines = []; return; }
      const chosen = (inv.groups || [])
        .filter((g) => st.pickedGroups.includes(g.id))
        .sort((a, b) => a.imprintNumber - b.imprintNumber);
      st.draftLines = chosen.reduce((acc, g) => acc.concat(g.lines.map((l) => ({ ...l }))), []);
      st.poSuffix = defaultSuffix();
    }

    /**
     * The suffix for the PO number, from the chosen imprints.
     *
     * One imprint is unambiguous: imprint 9 gives 26-66608-9. More than one
     * has no established convention here, so it is joined with a plus and
     * left EDITABLE rather than decided for you. A made-up number on a
     * document a vendor reads is worse than asking.
     */
    function defaultSuffix() {
      const inv = st.picked;
      if (!inv) return '';
      return (inv.groups || [])
        .filter((g) => st.pickedGroups.includes(g.id))
        .map((g) => g.imprintNumber)
        .sort((a, b) => a - b)
        .join('+');
    }

    function poNumberPreview() {
      const inv = st.picked;
      const year = String(new Date().getFullYear()).slice(-2);
      if (!inv) return year + '-M###';
      const suffix = String(st.poSuffix || '').trim();
      return year + '-' + inv.invoiceNumber + (suffix ? '-' + suffix : '');
    }

    function imprintPickerHtml() {
      const inv = st.picked;
      if (!inv || !inv.groups || !inv.groups.length) return '';

      // Confirmed: collapse to one line. The picker and the invoice banner
      // have done their job by now, and leaving them open buries the fields
      // still to be filled under choices already made.
      if (st.imprintLocked) {
        const chosen = inv.groups.filter((g) => st.pickedGroups.includes(g.id));
        const pieces = chosen.reduce((a, g) => a + g.lines.reduce((x, l) => x + (Number(l.qty) || 0), 0), 0);
        return '<div class="pp-locked">' +
          '<div>' +
            '<strong>' + esc(poNumberPreview()) + '</strong> &middot; ' +
            esc(inv.customerName || ('Printavo ' + inv.invoiceNumber)) +
            (inv.dueDate ? ' &middot; due ' + esc(inv.dueDate) : '') +
            '<div class="pp-hint">Imprint' + (chosen.length === 1 ? ' ' : 's ') +
              esc(chosen.map((g) => g.imprintNumber).join(', ')) +
              ' &middot; ' + st.draftLines.length + ' line' + (st.draftLines.length === 1 ? '' : 's') +
              ' &middot; ' + pieces + ' pieces</div>' +
          '</div>' +
          '<button class="pp-btn ghost" id="ppUnlockImprints">Change</button>' +
        '</div>';
      }

      const promo = promoGroups(inv, st.settings.promoCategories);
      const promoIds = new Set(promo.matched ? promo.groups.map((g) => g.id) : []);

      return '<div class="pp-sect">Which imprint is this PO for?</div>' +
        (!promo.matched
          ? '<div class="pp-notice">Tick the categories that mean promo below and they will be remembered, so next time the right imprint is chosen for you.</div>'
          : '') +
        '<div class="pp-imprints">' + inv.groups.map((g) => {
          const qty = g.lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
          const on = st.pickedGroups.includes(g.id);
          return '<label class="pp-imprint' + (on ? ' on' : '') + '">' +
            '<input type="checkbox" data-imprint="' + esc(g.id) + '"' + (on ? ' checked' : '') + '>' +
            '<span>' +
              '<span class="nm">Imprint ' + esc(g.imprintNumber) + (promoIds.has(g.id) ? ' <span class="pp-pill">Promo</span>' : '') + '</span>' +
              '<span class="em">' + esc(g.categories.join(', ') || 'No category') + '</span>' +
              '<span class="em">' + g.lines.length + ' line' + (g.lines.length === 1 ? '' : 's') + ', ' + qty + ' pieces</span>' +
            '</span>' +
          '</label>';
        }).join('') + '</div>' +

        (inv.categories && inv.categories.length
          ? '<div class="pp-hint" style="margin-top:8px">Categories on this job: ' +
            inv.categories.map((c) => {
              const on = (st.settings.promoCategories || []).some((p) => p.toLowerCase() === c.toLowerCase());
              return '<label class="pp-cattag' + (on ? ' on' : '') + '">' +
                '<input type="checkbox" data-promocat="' + esc(c) + '"' + (on ? ' checked' : '') + '> ' + esc(c) +
              '</label>';
            }).join(' ') +
            (isAdmin ? '<button class="pp-btn ghost" id="ppSavePromoCats" style="margin-left:8px">Remember as promo</button>' : '') +
            '</div>'
          : '') +

        '<div class="pp-confirm">' +
          '<div class="pp-field" style="max-width:200px">' +
            '<label>PO number</label>' +
            '<input id="ppSuffix" value="' + esc(st.poSuffix) + '" placeholder="imprint number">' +
            '<div class="pp-hint" id="ppNumPreview">' + esc(poNumberPreview()) + '</div>' +
          '</div>' +
          '<button class="pp-btn" id="ppUseImprints"' + (st.pickedGroups.length ? '' : ' disabled') + '>' +
            'Use ' + (st.pickedGroups.length === 1 ? 'this imprint' : st.pickedGroups.length + ' imprints') +
          '</button>' +
        '</div>';
    }

    /* ---------------- artwork ---------------- */

    const fileSize = (b) => {
      const n = Number(b) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
      return (n / 1048576).toFixed(1) + ' MB';
    };

    /**
     * Files chosen before the PO exists.
     *
     * They cannot be uploaded yet: a blob has to be attached to a purchase
     * order, and there is no purchase order until Create is pressed. So they
     * are held in memory and sent immediately afterwards. The alternative,
     * telling somebody to create the order and then go find it again to
     * attach the art, is how art ends up never attached.
     */
    function stagedArtHtml() {
      if (!st.stagedArt.length) return '<div class="pp-hint">Nothing attached yet.</div>';
      return '<div class="pp-artgrid">' + st.stagedArt.map((f, i) =>
        '<div class="pp-artrow">' +
          '<span>' + esc(f.name) + '</span>' +
          '<span class="sz">' + esc(fileSize(f.size)) + '</span>' +
          '<button class="pp-btn ghost" data-rmstaged="' + i + '">Remove</button>' +
        '</div>'
      ).join('') + '</div>';
    }

    function artListHtml(po) {
      const art = Array.isArray(po.art) ? po.art : [];
      if (!art.length) return '<div class="pp-hint">Nothing attached yet.</div>';
      // Staff open files through the same route the vendor uses, but by id
      // with a session rather than with a signed token. One way in means one
      // place where "can this person have this file" is decided.
      return '<div class="pp-artgrid">' + art.map((a) =>
        '<div class="pp-artrow">' +
          '<a href="' + esc(ENDPOINTS.ppArtFile + '?poId=' + encodeURIComponent(po.id) + '&id=' + encodeURIComponent(a.id || '')) + '" target="_blank" rel="noopener">' + esc(a.filename) + '</a>' +
          '<span class="sz">' + esc(fileSize(a.bytes)) + '</span>' +
          (canEdit ? '<button class="pp-btn ghost" data-rmart="' + esc(a.id || '') + '">Remove</button>' : '') +
        '</div>'
      ).join('') + '</div>';
    }

    // Files go up one at a time rather than in one request. A 25 MB cap per
    // file times a multi-select would blow the request limit, and one failure
    // in a batch should not lose the ones that already worked.
    /**
     * Upload files to a PO, one at a time. Returns the names that failed.
     *
     * One request per file rather than one batch: a 25 MB cap times a
     * multi-select would blow the request limit, and one bad file in a batch
     * should not lose the ones that already worked. Which is also why a
     * failure carries on to the next file instead of stopping the run.
     */
    // The real ceiling, and why it is checked HERE rather than only on the
    // server. An upload travels as base64 inside a JSON request, and Vercel
    // refuses any request body over 4.5 MB with a bare 413 before our own
    // code runs. Base64 inflates a file by about a third, so anything over
    // roughly 3.3 MB never reaches the friendly error the server would have
    // given. Checking in the browser is the only place a person can be told
    // what actually went wrong.
    const ART_MAX_BYTES = 3 * 1024 * 1024;

    async function uploadArtTo(poId, files, onProgress) {
      const list = Array.from(files || []);
      const failed = [];

      for (let i = 0; i < list.length; i++) {
        const f = list[i];

        if (f.size > ART_MAX_BYTES) {
          failed.push(
            f.name + ' is ' + (f.size / 1048576).toFixed(1) + ' MB. The limit is 3 MB, ' +
            'so send a compressed copy or put a link to the full-size art in the notes.'
          );
          continue;
        }

        if (onProgress) onProgress('Uploading ' + (i + 1) + ' of ' + list.length + ': ' + f.name);
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error('could not be read'));
            r.readAsDataURL(f);
          });
          const res = await ctx.api.post(ENDPOINTS.ppArt, { poId, data_url: dataUrl, filename: f.name });
          if (res && res.error) failed.push(f.name + ' (' + res.error + ')');
        } catch (e) {
          failed.push(f.name + ' (' + (e.message || 'upload failed') + ')');
        }
      }

      if (onProgress) onProgress('');
      return failed;
    }

    /** Attach to the PO currently open on the detail screen. */
    async function uploadArt(files) {
      const status = $('#ppArtStatus');
      const set = (msg) => { if (status) status.textContent = msg; };
      const failed = await uploadArtTo(st.openPoId, files, set);

      await loadAll();
      renderAll();
      const po = st.pos.find((p) => p.id === st.openPoId);
      if (po) renderDetail(po);

      if (failed.length) {
        const s2 = $('#ppArtStatus');
        if (s2) s2.textContent = 'Did not upload: ' + failed.join(', ');
      }
    }

    /* ---------------- receiving ---------------- */

    /**
     * Book goods in, line by line.
     *
     * Deliberately additive: the boxes are "how many arrived today", not
     * "the total is now". Recording the second delivery must not require
     * knowing what the first one was, and the running total is the app's job
     * to keep, not the receiver's.
     */
    function receivingHtml(po) {
      const sum = receiptSummary(po);
      const receipts = Array.isArray(po.receipts) ? po.receipts : [];

      const banner = sum.complete
        ? '<div class="pp-hint">All ' + sum.ordered + ' received.</div>'
        : sum.partial
          ? '<div class="pp-notice"><strong>Partly received.</strong> ' + sum.received + ' of ' + sum.ordered +
            ' in, ' + sum.outstanding + ' still outstanding on ' + sum.short.length +
            (sum.short.length === 1 ? ' line' : ' lines') + '.</div>'
          : '<div class="pp-hint">Nothing booked in yet.</div>';

      const log = receipts.length
        ? '<div class="pp-hint" style="margin-top:8px">' + receipts.map((r) =>
            esc(r.date) + ': ' + r.lines.map((l) => (l.qty > 0 ? '+' : '') + l.qty).join(', ') +
            (r.by ? ' by ' + esc(r.by) : '') +
            (r.note ? ' (' + esc(r.note) + ')' : '')
          ).join('<br>') + '</div>'
        : '';

      if (!canEdit || sum.complete) return '<div class="pp-sect">Receiving</div>' + banner + log;

      return '<div class="pp-sect">Receiving</div>' + banner +
        '<table class="pp-table"><thead><tr><th>Line</th><th class="num">Ordered</th>' +
        '<th class="num">Already in</th><th class="num">Arrived now</th></tr></thead><tbody>' +
        (po.lines || []).map((l, i) => {
          const got = Number(l.receivedQty) || 0;
          const short = Math.max(0, (Number(l.qty) || 0) - got);
          return '<tr><td>' + esc(l.description) + (l.itemNumber ? ' <span class="pp-hint">' + esc(l.itemNumber) + '</span>' : '') + '</td>' +
            '<td class="num">' + esc(l.qty) + '</td>' +
            '<td class="num">' + esc(got) + '</td>' +
            '<td class="num"><input type="number" step="1" style="width:90px;text-align:right" ' +
              'data-recvline="' + i + '" placeholder="' + (short ? esc(short) : '0') + '"></td></tr>';
        }).join('') + '</tbody></table>' +
        '<div class="pp-row" style="margin-top:8px">' +
          '<div class="pp-field"><label>Date received</label><input type="date" id="ppRecvDate" value="' + esc(today()) + '"></div>' +
          '<div class="pp-field"><label>Note</label><input id="ppRecvNote" placeholder="Short 24, vendor says Friday"></div>' +
        '</div>' +
        '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="pp-btn" id="ppReceive">Book in</button>' +
          '<button class="pp-btn ghost" id="ppReceiveAll">Everything outstanding arrived</button>' +
        '</div>' +
        '<div class="pp-hint" style="margin-top:6px">A negative number corrects a miscount. The order is marked received on its own once nothing is short.</div>' +
        '<div class="pp-err" id="ppRecvErr" hidden></div>' + log;
    }

    async function postReceipt(entries) {
      const err = $('#ppRecvErr');
      if (err) err.hidden = true;
      if (!entries.length) {
        if (err) { err.textContent = 'Nothing was entered to receive.'; err.hidden = false; }
        return;
      }
      try {
        const res = await ctx.api.post(ENDPOINTS.ppReceive, {
          poId: st.openPoId,
          entries,
          date: $('#ppRecvDate') ? $('#ppRecvDate').value : today(),
          note: $('#ppRecvNote') ? $('#ppRecvNote').value : '',
        });
        if (res && res.error) {
          if (err) { err.textContent = res.error; err.hidden = false; }
          return;
        }
        await loadAll();
        renderAll();
        const po = st.pos.find((p) => p.id === st.openPoId);
        if (po) renderDetail(po);
      } catch (e) {
        if (err) { err.textContent = e.message || 'Could not record that.'; err.hidden = false; }
      }
    }

    /* ---------------- detail ---------------- */

    function renderDetail(po) {
      const wrap = $('#ppDetailWrap');
      const v = vendorById(po.vendorId);
      const h = health(po);
      const orderBy = orderByDate(po, v);

      wrap.innerHTML = '<div class="pp-detail">' +
        '<div class="pp-hd"><div>' +
          '<h1 style="font-size:22px">' + esc(po.poNumber || 'Draft') + '</h1>' +
          '<div class="sub">' + esc(vendorName(po.vendorId)) + ' &middot; ' +
            esc((po.printavo && po.printavo.customerName) || 'Manual order') +
            (po.printavo ? ' &middot; Printavo ' + esc(po.printavo.invoiceNumber) : '') +
          '</div>' +
          '<div class="sub" style="font-size:12px">AM ' + esc(amName(po.accountManager)) +
            (ccListFor(po, v, st.settings).length
              ? ' &middot; CC ' + esc(ccListFor(po, v, st.settings).join(', '))
              : '') +
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

        '<table class="pp-table"><thead><tr><th>Item #</th><th>Description</th><th>Detail</th>' +
          '<th class="num">Qty</th><th class="num">In</th><th class="num">Short</th>' +
          '<th class="num">Cost</th><th class="num">Total</th></tr></thead><tbody>' +
          (po.lines || []).map((l) => {
            const got = Number(l.receivedQty) || 0;
            const short = Math.max(0, (Number(l.qty) || 0) - got);
            return '<tr><td>' + esc(l.itemNumber || '') + '</td>' +
            '<td>' + esc(l.description) +
              (l.imprint ? '<div class="pp-hint">' + esc(l.imprint) + '</div>' : '') +
            '</td><td>' + esc(l.detail || '') + '</td>' +
            '<td class="num">' + esc(l.qty) + '</td>' +
            '<td class="num">' + (got ? esc(got) : '<span class="pp-hint">0</span>') + '</td>' +
            '<td class="num">' + (short ? '<strong>' + esc(short) + '</strong>' : '\u2013') + '</td>' +
            '<td class="num">' + money(l.unitCost) + '</td>' +
            '<td class="num">' + money(lineTotal(l)) + '</td></tr>';
          }).join('') +
          '<tr><td colspan="7" class="num"><strong>Total</strong></td><td class="num"><strong>' + money(poTotal(po)) + '</strong></td></tr>' +
        '</tbody></table>' +

        receivingHtml(po) +

        (po.shipTo || po.shippingInstructions
          ? '<div class="pp-sect">Shipping</div>' +
            '<div style="font-size:13px">' + esc(po.shipTo || '') +
            (po.shippingInstructions ? '<div class="pp-hint" style="font-size:12px">' + esc(po.shippingInstructions) + '</div>' : '') +
            '</div>'
          : '') +

        '<div class="pp-sect">Artwork for the vendor</div>' +
        '<div class="pp-hint" style="margin-bottom:8px">' +
          'The vendor gets a signed link that expires. Withdrawing links kills every one already sent for this order, ' +
          'which is what to do if a link went somewhere it should not have.' +
        '</div>' +
        '<div id="ppArtList">' + artListHtml(po) + '</div>' +
        (canEdit
          ? '<div style="margin-top:8px">' +
              '<input type="file" id="ppArtFile" multiple style="display:none" ' +
                'accept=".ai,.eps,.svg,.psd,.pdf,.indd,.tif,.tiff,.cdr,.zip,image/*,application/pdf">' +
              '<button class="pp-btn ghost" id="ppArtPick">Attach artwork</button>' +
              '<span class="pp-hint" style="margin-left:8px">3 MB per file</span>' +
              ((po.art || []).length ? '<button class="pp-btn ghost" id="ppArtRevoke" style="margin-left:6px">Withdraw sent links</button>' : '') +
              '<span id="ppArtStatus" class="pp-hint" style="margin-left:10px"></span>' +
            '</div>'
          : '') +

        '<div class="pp-sect">Send this order</div>' +
        (po.lastSentAt
          ? '<div class="pp-hint" style="margin-bottom:8px">Last emailed ' + esc(String(po.lastSentAt).slice(0, 16).replace('T', ' ')) +
            ' to ' + esc(po.sentTo || '') +
            (Number(po.sendCount) > 1 ? ' (' + esc(po.sendCount) + ' times)' : '') + '</div>'
          : '<div class="pp-hint" style="margin-bottom:8px">Not sent yet.</div>') +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="pp-btn ghost" id="ppPrint">Print or save as PDF</button>' +
          (canEdit ? '<button class="pp-btn ghost" id="ppSendTest">Send a test to me</button>' : '') +
          (canEdit ? '<button class="pp-btn" id="ppSend">' + (po.lastSentAt ? 'Send again' : 'Send to vendor') + '</button>' : '') +
        '</div>' +
        '<div id="ppSendMsg" class="pp-hint" style="margin-top:6px"></div>' +

        (canEdit ? '<div style="margin-top:14px"><button class="pp-btn" id="ppSaveDetail">Save changes</button></div>' : '') +
        '<div class="pp-err" id="ppDetailErr" hidden></div>' +

        // Two different things, kept apart on purpose.
        //
        // CANCEL is for an order that was real and stopped being real. The
        // vendor may already have it. The record survives, drops out of the
        // pipeline and stops being chased, and the vendor scorecard counts it
        // as cancelled rather than as a completed order, so calling one off
        // does not drag their numbers down.
        //
        // DELETE is for a mistake: typed wrong, never sent. Admin only, and
        // hidden entirely once the order has been emailed, because deleting
        // the only record of a document a vendor is working from is the one
        // thing here that cannot be walked back.
        (canEdit
          ? '<div class="pp-sect">This order</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
              (po.cancelledAt
                ? '<button class="pp-btn ghost" id="ppUncancel">Reinstate this order</button>' +
                  '<span class="pp-hint">Cancelled ' + esc(String(po.cancelledAt).slice(0, 10)) + '.</span>'
                : '<button class="pp-btn ghost" id="ppCancelPo">Cancel this order</button>') +
              (isAdmin && !po.lastSentAt
                ? '<button class="pp-btn ghost" id="ppDeletePo">Delete, raised in error</button>'
                : '') +
            '</div>' +
            '<div class="pp-hint" style="margin-top:6px">' +
              (po.lastSentAt
                ? 'This order has been emailed, so it can be cancelled but not deleted. The record of what the vendor received stays.'
                : 'Cancelling keeps the record and stops the chasing. Deleting removes it entirely, which is only offered because this one has never been sent.') +
            '</div>'
          : '') +
      '</div>';

      wrap.hidden = false;
      $('#ppFormWrap').hidden = true;
    }

    /* ---------------- vendor form ---------------- */

    // One card with every field, not a chain of prompts. Adding a vendor is a
    // judgement call about lead times, and you cannot make it well when you
    // can only see one question at a time and cannot go back to change an
    // earlier answer.
    function renderVendorForm(vendor) {
      const v = vendor || {};
      const isEdit = !!v.id;
      const wrap = $('#ppVendorFormWrap');

      wrap.innerHTML = '<div class="pp-form">' +
        '<div class="pp-hd"><div>' +
          '<h1 style="font-size:20px">' + (isEdit ? 'Edit ' + esc(v.name) : 'Add a vendor') + '.</h1>' +
          '<div class="sub">Lead times here decide what counts as late for every order with this vendor.</div>' +
        '</div></div>' +

        '<input type="hidden" id="ppVenId" value="' + esc(v.id || '') + '">' +

        '<div class="pp-row">' +
          '<div class="pp-field"><label>Vendor name</label><input id="ppVenName" value="' + esc(v.name || '') + '" placeholder="SanMar"></div>' +
          '<div class="pp-field"><label>Order email</label><input id="ppVenEmail" type="email" value="' + esc(v.email || '') + '" placeholder="orders@vendor.com"></div>' +
          '<div class="pp-field"><label>CC email</label><input id="ppVenCc" type="email" value="' + esc(v.ccEmail || '') + '" placeholder="Optional second contact"></div>' +
        '</div>' +

        '<div class="pp-row">' +
          '<div class="pp-field"><label>Payment terms</label><input id="ppVenTerms" value="' + esc(v.terms || '') + '" placeholder="Net 30"></div>' +
          '<div class="pp-field"><label>Lead days, order to our dock</label><input id="ppVenLead" type="number" min="0" value="' + esc(v.leadDays === undefined ? 10 : v.leadDays) + '"></div>' +
          '<div class="pp-field"><label>Payment before production</label>' +
            '<select id="ppVenPrepay">' +
              '<option value="no"' + (v.prepay ? '' : ' selected') + '>No</option>' +
              '<option value="yes"' + (v.prepay ? ' selected' : '') + '>Yes, prepay</option>' +
            '</select></div>' +
        '</div>' +

        '<div class="pp-row">' +
          '<div class="pp-field"><label>Slow to reply? Days before we chase</label>' +
            '<input id="ppVenResponse" type="number" min="1" value="' + esc(v.responseDays == null ? '' : v.responseDays) + '" placeholder="Leave blank for the usual ' + esc(st.settings.chaseAfterDays) + '">' +
            '<div style="font-size:11px;color:var(--muted);margin-top:4px">Only fill this in for a supplier who is reliably slower than the rest.</div>' +
          '</div>' +
        '</div>' +

        '<div class="pp-row">' +
          '<div class="pp-field"><label>Our rating</label>' +
            '<select id="ppVenRating">' +
              '<option value=""' + (v.rating ? '' : ' selected') + '>Not rated</option>' +
              [1, 2, 3, 4, 5].map((n) =>
                '<option value="' + n + '"' + (Number(v.rating) === n ? ' selected' : '') + '>' +
                  n + ' \u2013 ' + ['Avoid', 'Poor', 'Fine', 'Good', 'Excellent'][n - 1] +
                '</option>'
              ).join('') +
            '</select>' +
            '<div style="font-size:11px;color:var(--muted);margin-top:4px">Your judgement of them. The scorecard next to it is computed from the orders themselves, and the two are allowed to disagree.</div>' +
          '</div>' +
          '<div class="pp-field"><label>Blacklist</label>' +
            '<select id="ppVenBlack">' +
              '<option value="no"' + (v.blacklisted ? '' : ' selected') + '>No, fine to order from</option>' +
              '<option value="yes"' + (v.blacklisted ? ' selected' : '') + '>Yes, warn before ordering</option>' +
            '</select>' +
          '</div>' +
        '</div>' +

        '<div class="pp-field" id="ppVenBlackWrap"' + (v.blacklisted ? '' : ' hidden') + '>' +
          '<label>Why are they blacklisted</label>' +
          '<input id="ppVenBlackWhy" value="' + esc(v.blackListReason || v.blacklistReason || '') + '" placeholder="Shipped the wrong garment twice and would not credit it">' +
          '<div style="font-size:11px;color:var(--muted);margin-top:4px">Required. In six months this sentence is the only thing standing between somebody and the same mistake.</div>' +
          (v.blacklistedAt
            ? '<div style="font-size:11px;color:var(--muted);margin-top:4px">Blacklisted ' + esc(String(v.blacklistedAt).slice(0, 10)) +
              (v.blacklistedBy ? ' by ' + esc(v.blacklistedBy) : '') + '.</div>'
            : '') +
        '</div>' +

        '<div class="pp-field"><label>Notes</label><textarea id="ppVenNotes" placeholder="Minimums, rep name, quirks worth remembering">' + esc(v.notes || '') + '</textarea></div>' +

        (isEdit
          ? '<div class="pp-field" style="margin-top:12px"><label>Status</label><select id="ppVenActive">' +
              '<option value="yes"' + (v.active === false ? '' : ' selected') + '>Active</option>' +
              '<option value="no"' + (v.active === false ? ' selected' : '') + '>Inactive, hide from new orders</option>' +
            '</select></div>'
          : '') +

        '<div style="margin-top:16px;display:flex;gap:8px">' +
          '<button class="pp-btn" id="ppVenSave">' + (isEdit ? 'Save vendor' : 'Add vendor') + '</button>' +
          '<button class="pp-btn ghost" id="ppVenCancel">Cancel</button>' +
        '</div>' +
        '<div class="pp-err" id="ppVenErr" hidden></div>' +
      '</div>';

      wrap.hidden = false;
    }

    async function saveVendor() {
      const err = $('#ppVenErr');
      err.hidden = true;

      const id = $('#ppVenId').value;
      const respRaw = $('#ppVenResponse').value;
      const ratingRaw = $('#ppVenRating') ? $('#ppVenRating').value : '';
      const blacklisted = $('#ppVenBlack') ? $('#ppVenBlack').value === 'yes' : false;
      const payload = {
        rating: ratingRaw === '' ? null : Number(ratingRaw),
        blacklisted,
        blacklistReason: $('#ppVenBlackWhy') ? $('#ppVenBlackWhy').value : '',
        name: $('#ppVenName').value,
        email: $('#ppVenEmail').value,
        ccEmail: $('#ppVenCc').value,
        terms: $('#ppVenTerms').value,
        leadDays: Number($('#ppVenLead').value) || 0,
        prepay: $('#ppVenPrepay').value === 'yes',
        notes: $('#ppVenNotes').value,
        responseDays: respRaw === '' ? null : Number(respRaw),
      };
      const activeEl = $('#ppVenActive');
      if (activeEl) payload.active = activeEl.value === 'yes';

      try {
        const res = id
          ? await ctx.api.request(ENDPOINTS.ppVendors, { method: 'PATCH', body: JSON.stringify({ ...payload, id }) })
          : await ctx.api.post(ENDPOINTS.ppVendors, payload);
        if (res && res.error) { err.textContent = res.error; err.hidden = false; return; }
        $('#ppVendorFormWrap').hidden = true;
        await loadAll();
        renderAll();
      } catch (e) {
        err.textContent = e.message || 'Could not save the vendor.';
        err.hidden = false;
      }
    }

    /* ---------------- quick add a vendor ---------------- */

    /**
     * The minimum needed to send this vendor an order, and nothing else.
     *
     * Deliberately shorter than the full card on the Vendors tab. Somebody
     * halfway through a purchase order does not know, and should not be
     * stopped to decide, whether this supplier is reliably slower to reply
     * than the rest. Name and order email are the two the PO genuinely
     * cannot go out without; the rest can be filled in later by whoever
     * maintains the vendor list.
     */
    function openQuickVendor(prefillName) {
      const back = document.createElement('div');
      back.className = 'pp-modal-back';
      back.id = 'ppQuickBack';
      back.innerHTML = '<div class="pp-modal">' +
        '<h2>Add a vendor</h2>' +
        '<div class="pp-hint" style="margin-bottom:14px">Just enough to send them this order. Lead time and the rest can be filled in on the Vendors tab later.</div>' +
        '<div class="pp-row">' +
          '<div class="pp-field"><label>Vendor name</label><input id="ppQName" value="' + esc(prefillName || '') + '" placeholder="SanMar"></div>' +
          '<div class="pp-field"><label>Order email</label><input id="ppQEmail" type="email" placeholder="orders@vendor.com"></div>' +
        '</div>' +
        '<div class="pp-row">' +
          '<div class="pp-field"><label>Lead days, order to our dock</label><input id="ppQLead" type="number" min="0" value="10">' +
            '<div style="font-size:11px;color:var(--muted);margin-top:4px">A rough guess is fine and can be corrected. Left at ten it just means ten.</div>' +
          '</div>' +
          '<div class="pp-field"><label>Payment terms</label><input id="ppQTerms" placeholder="Net 30"></div>' +
        '</div>' +
        '<div style="margin-top:16px;display:flex;gap:8px">' +
          '<button class="pp-btn" id="ppQSave">Add and use</button>' +
          '<button class="pp-btn ghost" id="ppQCancel">Cancel</button>' +
        '</div>' +
        '<div class="pp-err" id="ppQErr" hidden></div>' +
      '</div>';
      root.appendChild(back);
      const name = $('#ppQName');
      if (name) { name.focus(); name.select(); }
    }

    function closeQuickVendor() {
      const back = $('#ppQuickBack');
      if (back) back.remove();
    }

    async function saveQuickVendor() {
      const err = $('#ppQErr');
      if (err) err.hidden = true;
      const payload = {
        name: $('#ppQName').value,
        email: $('#ppQEmail').value,
        leadDays: Number($('#ppQLead').value) || 0,
        terms: $('#ppQTerms').value,
      };
      if (!String(payload.name || '').trim()) {
        if (err) { err.textContent = 'A vendor needs a name.'; err.hidden = false; }
        return;
      }
      try {
        const res = await ctx.api.post(ENDPOINTS.ppVendors, payload);
        if (res && res.error) { if (err) { err.textContent = res.error; err.hidden = false; } return; }
        // Take the list straight off the response rather than re-reading
        // everything: the order form underneath is half filled in and a full
        // reload would rebuild it.
        if (Array.isArray(res.vendors)) st.vendors = res.vendors;
        closeQuickVendor();
        if (res.vendor && res.vendor.id) pickVendor(res.vendor.id);
      } catch (e) {
        if (err) { err.textContent = e.message || 'Could not add the vendor.'; err.hidden = false; }
      }
    }

    /* ---------------- vendors ---------------- */

    function renderVendors() {
      const body = $('#ppVendorsBody');
      if (!st.vendors.length) {
        body.innerHTML = '<div class="pp-empty">No vendors yet. Add the suppliers you order promo from, with how long each one usually takes.</div>';
        return;
      }
      // Blacklisted first, deliberately. They are the rows somebody needs to
      // see, and burying them at the bottom of an alphabetical list is how a
      // warning gets missed.
      const sorted = st.vendors.slice().sort((a, b) => {
        if ((a.blacklisted === true) !== (b.blacklisted === true)) return a.blacklisted ? -1 : 1;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });

      const blackCount = sorted.filter((v) => v.blacklisted === true).length;

      body.innerHTML =
        (blackCount
          ? '<div class="pp-notice" style="margin-bottom:12px"><strong>' + blackCount +
            (blackCount === 1 ? ' vendor is' : ' vendors are') + ' blacklisted.</strong> ' +
            'Raising or sending an order to one asks for a confirmation first.</div>'
          : '') +
        '<table class="pp-table"><thead><tr>' +
        '<th>Vendor</th><th>Rating</th><th>Scorecard</th><th>Email</th><th>Terms</th>' +
        '<th class="num">Lead days</th><th>Prepay</th><th>Open POs</th>' + (isAdmin ? '<th></th>' : '') +
        '</tr></thead><tbody>' +
        sorted.map((v) => {
          const openCount = st.pos.filter((p) => p.vendorId === v.id && !['closed', 'cancelled', 'received'].includes(currentStage(p))).length;
          const dim = v.active === false && v.blacklisted !== true;
          return '<tr' + (dim ? ' style="opacity:.5"' : '') + '>' +
            '<td><strong>' + esc(v.name) + '</strong>' +
              (v.blacklisted === true ? ' <span class="pp-pill bad">Blacklisted</span>' : '') +
              (v.active === false ? ' <span class="pp-pill">Inactive</span>' : '') +
              (v.blacklisted === true && v.blacklistReason
                ? '<div class="pp-hint" style="font-size:12px">' + esc(v.blacklistReason) + '</div>'
                : '') +
            '</td>' +
            '<td>' + ratingCell(v) + '</td>' +
            '<td>' + scoreCell(v.stats) + '</td>' +
            '<td>' + esc(v.email || '') + '</td>' +
            '<td>' + esc(v.terms || '') + '</td>' +
            '<td class="num">' + esc(v.leadDays) + '</td>' +
            '<td>' + (v.prepay ? 'Yes' : 'No') + '</td>' +
            '<td>' + openCount + '</td>' +
            (isAdmin
              ? '<td><button class="pp-btn ghost" data-editvendor="' + esc(v.id) + '">Edit</button> ' +
                '<button class="pp-btn ghost" data-rmvendor="' + esc(v.id) + '">Remove</button></td>'
              : '') +
          '</tr>';
        }).join('') + '</tbody></table>';
    }

    /** The hand-set 1 to 5, or plainly nothing. */
    function ratingCell(v) {
      const n = Number(v && v.rating);
      if (!Number.isFinite(n) || n < 1) return '<span class="pp-hint">Not rated</span>';
      return '<span title="' + esc(n) + ' of 5">' + '\u2605'.repeat(n) + '<span style="opacity:.25">' + '\u2605'.repeat(5 - n) + '</span></span>';
    }

    /**
     * The computed record. Says "not enough history" rather than showing a
     * score built on one or two orders, because a number on screen gets used
     * to make a buying decision whether or not it deserves to be.
     */
    function scoreCell(stats) {
      if (!stats) return '<span class="pp-hint">\u2013</span>';
      if (stats.score === null) {
        return '<span class="pp-hint">' + esc(stats.scoreBasis || 'no history yet') + '</span>';
      }
      const bits = [];
      if (stats.onTimeRate !== null) bits.push(stats.onTimeRate + '% on time');
      if (stats.avgResponseDays !== null) bits.push('replies in ' + stats.avgResponseDays + 'd');
      return '<strong>' + stats.score + '</strong><span class="pp-hint" style="font-size:12px">' +
        esc(bits.join(', ')) + ' across ' + stats.completed + ' finished</span>';
    }

    function renderSettings() {
      const S = st.settings;
      const chosen = new Set(S.accountManagerIds || []);
      const candidates = Array.isArray(S.candidates) ? S.candidates : [];

      let amBlock;
      if (st.settingsFailed) {
        // Never blame CrewCore for a failure that was ours. Before this, a
        // 404 on the settings route rendered "No active employees found in
        // CrewCore", which sent the search in exactly the wrong direction.
        amBlock = '<div class="pp-notice"><strong>Settings could not be loaded.</strong> ' +
          esc(st.loadErrors.join('. ')) +
          '. This is not a CrewCore problem: the roster was never read. If it says 404, ' +
          'check that <code>api/promopro/settings.js</code> is deployed and spelled correctly.</div>';
      } else if (S.rosterUnavailable) {
        amBlock = '<div class="pp-notice">The CrewCore roster could not be read, so account managers are unavailable right now. Purchase orders cannot be created until it comes back.</div>';
      } else if (!isAdmin) {
        // Non-admins see who is set, not the whole roster.
        amBlock = S.accountManagers.length
          ? '<div style="font-size:13px">' + S.accountManagers.map((a) => esc(a.name)).join(', ') + '</div>'
          : '<div style="font-size:13px;color:var(--muted)">None set. An admin can choose them here.</div>';
      } else if (!candidates.length) {
        // Several very different causes land here, so say which one it is.
        const rc = S.rosterCounts || {};
        let why;
        if (rc.adminView === false) {
          why = 'Your account is not being treated as an administrator, so the roster was not sent. ' +
            'Check your role and superuser flag in the shell Settings.';
        } else if (!rc.total) {
          why = 'CrewCore has no employee records at all.';
        } else {
          why = 'CrewCore has ' + esc(rc.total) + ' employee records but none are active.';
        }
        amBlock = '<div class="pp-notice"><strong>No account managers to choose from.</strong> ' + why + '</div>';
      } else if (!candidates.some((c) => c.selectable)) {
        // The likely real-world case: the roster exists but nobody has an
        // email on their record yet. Say that plainly instead of showing a
        // list of greyed-out names with no explanation of what to do.
        amBlock = '<div class="pp-notice"><strong>Nobody on the roster has an email address yet.</strong> ' +
          'Add emails to the employee records in CrewCore and they become selectable here. ' +
          'An account manager with no address would never be copied on the vendor thread, so they cannot be picked.</div>' +
          '<div class="pp-amgrid">' + candidates.map((c) =>
            '<label class="pp-amrow off"><input type="checkbox" disabled>' +
            '<span><span class="nm">' + esc(c.name) + '</span>' +
            (c.department ? '<span class="dept">' + esc(c.department) + '</span>' : '') +
            '<span class="em">' + esc(c.reason) + '</span></span></label>'
          ).join('') + '</div>';
      } else {
        amBlock =
          (S.usingDefaults
            ? '<div class="pp-notice">Nobody has been chosen yet, so everyone in Sales is ticked by default. Adjust and save to make it stick.</div>'
            : '') +
          '<div class="pp-amgrid">' + candidates.map((c) =>
            '<label class="pp-amrow' + (c.selectable ? '' : ' off') + '">' +
              '<input type="checkbox" data-amid="' + esc(c.id) + '"' +
                (chosen.has(c.id) ? ' checked' : '') +
                (c.selectable ? '' : ' disabled') + '>' +
              '<span>' +
                '<span class="nm">' + esc(c.name || '(no name)') + '</span>' +
                (c.department ? '<span class="dept">' + esc(c.department) + '</span>' : '') +
                '<span class="em">' + esc(c.selectable ? c.email : c.reason) + '</span>' +
              '</span>' +
            '</label>'
          ).join('') + '</div>';
      }

      $('#ppSettingsBody').innerHTML =
        '<div class="pp-form">' +
          '<div class="pp-sect">Email</div>' +
          '<div class="pp-field" style="margin-bottom:12px">' +
            '<label>Always CC on every purchase order</label>' +
            '<textarea id="ppAlwaysCc" placeholder="one per line, or comma separated"' + (isAdmin ? '' : ' disabled') + '>' + esc((S.alwaysCc || []).join('\n')) + '</textarea>' +
            '<div class="pp-hint">Everyone here is copied on every PO, on top of the account manager and the vendor\u2019s own second contact.</div>' +
          '</div>' +

          '<div class="pp-sect">Sending</div>' +
          '<div class="pp-row">' +
            '<div class="pp-field"><label>Purchase orders come from</label>' +
              '<input id="ppFromAddress" value="' + esc(S.fromAddress || '') + '" placeholder="po@pmapparel.com"' + (isAdmin ? '' : ' disabled') + '>' +
              '<div class="pp-hint">Must be on a domain verified in Resend.</div>' +
            '</div>' +
            '<div class="pp-field"><label>Vendors reply to</label>' +
              '<input id="ppReplyTo" value="' + esc(S.replyTo || '') + '" placeholder="Blank uses the account manager"' + (isAdmin ? '' : ' disabled') + '>' +
              '<div class="pp-hint">A vendor hitting Reply must reach a person.</div>' +
            '</div>' +
            '<div class="pp-field"><label>Phone on the PO</label>' +
              '<input id="ppBrandPhone" value="' + esc(S.brandPhone || '') + '"' + (isAdmin ? '' : ' disabled') + '></div>' +
          '</div>' +

          '<div class="pp-sect">Shipping</div>' +
          '<div class="pp-row">' +
            '<div class="pp-field"><label>Default ship to</label>' +
              '<input id="ppDefaultShipTo" value="' + esc(S.defaultShipTo || '') + '"' + (isAdmin ? '' : ' disabled') + '>' +
              '<div class="pp-hint">Prefilled on every new PO. Still editable per order for a drop ship.</div>' +
            '</div>' +
            '<div class="pp-field"><label>Shipping instructions</label>' +
              '<input id="ppShipInstructions" value="' + esc(S.shippingInstructions || '') + '" placeholder="Please ship via our UPS number: ..."' + (isAdmin ? '' : ' disabled') + '>' +
              '<div class="pp-hint">Printed on every PO. Keep the freight account here rather than in the code: this repository is public.</div>' +
            '</div>' +
          '</div>' +

          '<div class="pp-sect">Who can own a purchase order</div>' +
          '<div class="pp-hint" style="margin-bottom:10px">' +
            'Pulled live from the CrewCore roster. Names and addresses are never stored here, so changing someone\u2019s email in CrewCore changes it everywhere.' +
          '</div>' +
          amBlock +

          '<div class="pp-sect">Chasing</div>' +
          '<div class="pp-row">' +
            '<div class="pp-field"><label>Days of vendor silence before a PO goes amber</label>' +
              '<input id="ppChase" type="number" min="1" value="' + esc(S.chaseAfterDays) + '"' + (isAdmin ? '' : ' disabled') + '></div>' +
            '<div class="pp-field"><label>Morning digest to</label>' +
              '<input id="ppDigestTo" value="' + esc((S.chaseDigestTo || []).join(', ')) + '" placeholder="Blank means nobody" ' + (isAdmin ? '' : 'disabled') + '>' +
              '<div class="pp-hint">On top of Notifications, not instead of them. Nothing is sent on a clean morning.</div>' +
            '</div>' +
          '</div>' +
          '<div class="pp-hint">' +
            'Every weekday morning, any order that has gone amber or red raises one item on the account manager\u2019s Notifications list. ' +
            'It is updated in place rather than re-posted daily, and closes itself when the order recovers. ' +
            'This applies only where we are waiting on the vendor. Steps that are ours, like approving art and sending payment, do not raise a vendor alarm. ' +
            'A single supplier who is reliably slower can override this on their own card.' +
          '</div>' +

          '<div class="pp-sect">Who can raise and edit purchase orders</div>' +
          '<div class="pp-hint" style="margin-bottom:10px">' +
            'Reading stays open to everyone, so an account manager can always answer \u201cwhere is my order\u201d without asking. ' +
            'This is about who can create, change and send them. Superusers always can. ' +
            'Tick nothing and it falls back to whoever the shell already lets edit, which is how it behaved before this list existed.' +
          '</div>' +
          (isAdmin
            ? (Array.isArray(S.roleChoices) && S.roleChoices.length
                ? '<div class="pp-amgrid">' + S.roleChoices.map((r) =>
                    '<label class="pp-amrow"><input type="checkbox" data-editrole="' + esc(r.name) + '"' +
                      ((S.editRoles || []).includes(r.name) ? ' checked' : '') + '>' +
                    '<span><span class="nm">' + esc(r.label || r.name) + '</span>' +
                    '<span class="em">' + esc(r.name) + '</span></span></label>'
                  ).join('') + '</div>'
                : '<div class="pp-notice">The shell role list could not be read, so this cannot be changed right now.</div>')
            : '<div style="font-size:13px">' +
                ((S.editRoles || []).length ? esc((S.editRoles || []).join(', ')) : 'Anyone with edit access in the shell.') +
              '</div>') +

          '<div class="pp-sect">Promo categories</div>' +
          '<div class="pp-hint" style="margin-bottom:10px">' +
            'Which Printavo line-item categories count as promo. A lookup then shows just those imprints instead of the whole job. ' +
            'Leave it empty and every imprint is offered, which is safer than guessing wrong and hiding the one you wanted. ' +
            'The \u201cRemember as promo\u201d button on a lookup adds to this list too.' +
          '</div>' +
          '<div class="pp-field" style="margin-bottom:12px">' +
            '<textarea id="ppPromoCats" placeholder="one per line, or comma separated"' + (isAdmin ? '' : ' disabled') + '>' +
              esc((S.promoCategories || []).join('\n')) +
            '</textarea>' +
          '</div>' +

          '<div class="pp-sect">Vendor replies</div>' +
          '<div class="pp-hint" style="margin-bottom:10px">' +
            'With this on, a vendor hitting Reply lands on the order itself: the message is logged against the PO, the silence clock stops, ' +
            'and it is forwarded to the account manager so a person still sees it. The stage is never changed automatically, because ' +
            '\u201cgot it, we will confirm Monday\u201d and \u201cconfirmed\u201d look identical to a parser. ' +
            'Leave it off until the MX record exists, or vendor replies go nowhere.' +
          '</div>' +
          '<div class="pp-row">' +
            '<div class="pp-field"><label>Capture vendor replies</label>' +
              '<select id="ppCapture"' + (isAdmin ? '' : ' disabled') + '>' +
                '<option value="no"' + (S.captureReplies ? '' : ' selected') + '>Off, replies go straight to the account manager</option>' +
                '<option value="yes"' + (S.captureReplies ? ' selected' : '') + '>On</option>' +
              '</select></div>' +
            '<div class="pp-field"><label>Capture domain</label>' +
              '<input id="ppCaptureDomain" value="' + esc(S.captureDomain || '') + '" placeholder="po.pmapparel.com"' + (isAdmin ? '' : ' disabled') + '>' +
              '<div class="pp-hint">A subdomain, never pmapparel.com itself, or all your normal email routes to Resend.</div>' +
            '</div>' +
            '<div class="pp-field"><label>Unmatched replies go to</label>' +
              '<input id="ppReplyFallback" value="' + esc(S.replyFallbackTo || '') + '" placeholder="po@pmapparel.com"' + (isAdmin ? '' : ' disabled') + '>' +
            '</div>' +
          '</div>' +

          '<div class="pp-sect">Logo on the purchase order</div>' +
          '<div class="pp-row">' +
            '<div class="pp-field"><label>Logo</label>' +
              '<input id="ppLogoUrl" value="' + esc(S.logoUrl === undefined ? '' : S.logoUrl) + '" placeholder="/assets/brand/pm-apparel-logo.png"' + (isAdmin ? '' : ' disabled') + '>' +
              '<div class="pp-hint">Shown on the emailed order and the printed copy. Clear it for no logo. ' +
                'A PO going out as Flyover Con or Iowa On Demand can point at its own file here.</div>' +
            '</div>' +
            (S.logoUrl
              ? '<div class="pp-field"><label>Preview</label>' +
                  '<img src="' + esc(S.logoUrl) + '" alt="" style="width:64px;height:64px;display:block">' +
                '</div>'
              : '') +
          '</div>' +

          '<div class="pp-sect">Artwork links</div>' +
          '<div class="pp-row">' +
            '<div class="pp-field"><label>Days a vendor\u2019s artwork link stays good</label>' +
              '<input id="ppArtDays" type="number" min="1" value="' + esc(S.artLinkDays || 90) + '"' + (isAdmin ? '' : ' disabled') + '>' +
              '<div class="pp-hint">Files are private. A link that expires can be reissued by sending the order again, and an order\u2019s links can be withdrawn from its own screen.</div>' +
            '</div>' +
          '</div>' +

          (isAdmin ? '<div style="margin-top:16px"><button class="pp-btn" id="ppSaveSettings">Save settings</button></div>' : '') +
          '<div class="pp-err" id="ppSettingsErr" hidden></div>' +
          '<div id="ppSettingsOk" class="pp-hint" hidden style="margin-top:8px;font-weight:700">Saved.</div>' +
        '</div>' +

        '<div class="pp-form">' +
          '<div class="pp-sect">How PO numbers are built</div>' +
          '<p style="font-size:13px;color:var(--muted)">' +
            'Year, Printavo invoice number, then an imprint sequence when a job has more than one. A manual web order has no invoice, so it uses an M sequence instead, ' +
            'which makes it obvious at a glance that no Printavo job sits behind it.' +
          '</p>' +
        '</div>';
    }

    async function saveSettingsForm() {
      const err = $('#ppSettingsErr');
      const ok = $('#ppSettingsOk');
      err.hidden = true;
      if (ok) ok.hidden = true;

      if (st.settingsFailed) {
        err.textContent = 'Settings did not load, so saving would overwrite them with defaults. Fix the route first.';
        err.hidden = false;
        return;
      }

      const accountManagerIds = [];
      root.querySelectorAll('[data-amid]').forEach((el) => {
        if (el.checked) accountManagerIds.push(el.dataset.amid);
      });

      const payload = {
        alwaysCc: parseEmailList($('#ppAlwaysCc').value),
        chaseAfterDays: Number($('#ppChase').value) || 3,
        defaultShipTo: $('#ppDefaultShipTo').value,
        shippingInstructions: $('#ppShipInstructions').value,
        fromAddress: $('#ppFromAddress').value,
        replyTo: $('#ppReplyTo').value,
        brandPhone: $('#ppBrandPhone').value,
      };
      // Only send the list when the picker was actually on screen. A
      // non-admin view has no checkboxes, and posting an empty array would
      // wipe everyone.
      if (root.querySelector('[data-amid]')) payload.accountManagerIds = accountManagerIds;

      // Same rule for every admin-only field below: absent from the payload
      // when it was not rendered, rather than sent as a blank that clears
      // what an admin set.
      if ($('#ppDigestTo')) payload.chaseDigestTo = parseEmailList($('#ppDigestTo').value);
      if ($('#ppArtDays')) payload.artLinkDays = Number($('#ppArtDays').value) || 90;
      if ($('#ppLogoUrl')) payload.logoUrl = $('#ppLogoUrl').value.trim();
      if ($('#ppCapture')) {
        payload.captureReplies = $('#ppCapture').value === 'yes';
        payload.captureDomain = $('#ppCaptureDomain') ? $('#ppCaptureDomain').value : '';
        payload.replyFallbackTo = $('#ppReplyFallback') ? $('#ppReplyFallback').value : '';
      }
      if ($('#ppPromoCats')) {
        payload.promoCategories = String($('#ppPromoCats').value || '')
          .split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
      }
      if (root.querySelector('[data-editrole]')) {
        const editRoles = [];
        root.querySelectorAll('[data-editrole]').forEach((el) => {
          if (el.checked) editRoles.push(el.dataset.editrole);
        });
        payload.editRoles = editRoles;
      }

      try {
        const res = await ctx.api.request(ENDPOINTS.ppSettings, { method: 'PATCH', body: JSON.stringify(payload) });
        if (res && res.error) { err.textContent = res.error; err.hidden = false; return; }
        await loadAll();
        renderAll();
        const ok2 = $('#ppSettingsOk');
        if (ok2) ok2.hidden = false;
      } catch (e) {
        err.textContent = (e.message || 'Could not save settings.') +
          (/404/.test(e.message || '') ? ' That route has not been deployed yet.' : '');
        err.hidden = false;
      }
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
        st.pickedGroups = [];
        st.imprintLocked = false;
        st.poSuffix = '';
        st.draftVendorId = '';
        st.draftLines = [{ itemNumber: '', description: '', imprint: '', detail: '', qty: 1, unitCost: 0 }];
        renderForm();
        renderCcPreview();
        $('#ppFormWrap').hidden = false;
        $('#ppDetailWrap').hidden = true;
        if (t.id === 'ppNewFromPipe') this.showView('orders');
        return;
      }

      if (t.dataset && t.dataset.newvendor !== undefined) {
        openQuickVendor(t.dataset.newvendor);
        return;
      }
      if (t.id === 'ppQSave') { await saveQuickVendor(); return; }
      if (t.id === 'ppQCancel') { closeQuickVendor(); return; }

      if (t.id === 'ppCancel') { $('#ppFormWrap').hidden = true; return; }
      if (t.id === 'ppCloseDetail') { $('#ppDetailWrap').hidden = true; st.openPoId = null; return; }
      if (t.id === 'ppClearPick') {
        st.picked = null; st.pickedGroups = []; st.imprintLocked = false;
        st.poSuffix = ''; st.draftLines = [];
        renderForm();
        return;
      }

      if (t.id === 'ppUseImprints') {
        if (!st.pickedGroups.length) return;
        st.imprintLocked = true;
        renderForm();
        renderCcPreview();
        return;
      }

      if (t.id === 'ppUnlockImprints') { st.imprintLocked = false; renderForm(); return; }

      if (t.id === 'ppAddLine') {
        st.draftLines.push({ itemNumber: '', description: '', imprint: '', detail: '', qty: 1, unitCost: 0 });
        renderForm();
        return;
      }

      if (t.dataset && t.dataset.rmline !== undefined) {
        st.draftLines.splice(Number(t.dataset.rmline), 1);
        renderForm();
        return;
      }

      if (t.dataset && t.dataset.inv) { await pickInvoice(t.dataset.inv); return; }

      if (t.dataset && t.dataset.vendorpick) { pickVendor(t.dataset.vendorpick); return; }

      if (t.dataset && t.dataset.filter) { st.filter = t.dataset.filter; renderOrders(); return; }

      if (t.dataset && t.dataset.po) {
        const po = st.pos.find((p) => p.id === t.dataset.po);
        if (po) { st.openPoId = po.id; renderDetail(po); this.showView('orders'); }
        return;
      }

      if (t.id === 'ppSavePromoCats') {
        const cats = [];
        root.querySelectorAll('[data-promocat]').forEach((el) => {
          if (el.checked) cats.push(el.dataset.promocat);
        });
        try {
          const res = await ctx.api.request(ENDPOINTS.ppSettings, { method: 'PATCH', body: JSON.stringify({ promoCategories: cats }) });
          if (res && res.error) throw new Error(res.error);
          await loadAll();
          renderForm();
        } catch (e) {
          // Inline, never a browser alert: an alert loses the half-filled
          // form behind it and cannot be read alongside what caused it.
          const err = $('#ppFormErr');
          if (err) { err.textContent = e.message || 'Could not save the promo categories.'; err.hidden = false; }
        }
        return;
      }

      if (t.id === 'ppSave') { await saveNew(); return; }
      if (t.id === 'ppSaveDetail') { await saveDetail(); return; }

      if (t.id === 'ppCancelPo' || t.id === 'ppUncancel') {
        const undo = t.id === 'ppUncancel';
        if (!undo && !window.confirm('Cancel this purchase order? It stays on the record and stops being chased. Let the vendor know separately if they already have it.')) return;
        const err = $('#ppDetailErr');
        if (err) err.hidden = true;
        try {
          const res = await ctx.api.request(ENDPOINTS.ppPos, {
            method: 'PATCH',
            body: JSON.stringify({ id: st.openPoId, cancelledAt: undo ? null : today() }),
          });
          if (res && res.error) { if (err) { err.textContent = res.error; err.hidden = false; } return; }
          await loadAll();
          renderAll();
          const po = st.pos.find((p) => p.id === st.openPoId);
          if (po) renderDetail(po);
        } catch (e) {
          if (err) { err.textContent = e.message || 'Could not change that.'; err.hidden = false; }
        }
        return;
      }

      if (t.id === 'ppDeletePo') {
        const po = st.pos.find((p) => p.id === st.openPoId);
        // Typing the number is deliberate friction. This is the one action in
        // the app with nothing behind it.
        const typed = window.prompt(
          'This deletes the purchase order and its history for good. There is no undo.\n\n' +
          'Type the PO number to confirm: ' + ((po && po.poNumber) || ''));
        if (!typed || typed.trim() !== String((po && po.poNumber) || '').trim()) return;
        const err = $('#ppDetailErr');
        if (err) err.hidden = true;
        try {
          const res = await ctx.api.request(ENDPOINTS.ppPos + '?id=' + encodeURIComponent(st.openPoId), { method: 'DELETE' });
          if (res && res.error) { if (err) { err.textContent = res.error; err.hidden = false; } return; }
          $('#ppDetailWrap').hidden = true;
          st.openPoId = null;
          await loadAll();
          renderAll();
        } catch (e) {
          if (err) { err.textContent = e.message || 'Could not delete it.'; err.hidden = false; }
        }
        return;
      }

      if (t.id === 'ppReceive' || t.id === 'ppReceiveAll') {
        const po = st.pos.find((p) => p.id === st.openPoId);
        if (!po) return;
        const entries = [];
        if (t.id === 'ppReceiveAll') {
          // "Everything outstanding arrived" fills in the shortfall per line
          // rather than stamping a single received date, so the line counts
          // stay true and a later correction still has something to work
          // against.
          (po.lines || []).forEach((l, i) => {
            const short = Math.max(0, (Number(l.qty) || 0) - (Number(l.receivedQty) || 0));
            if (short > 0) entries.push({ index: i, qty: short });
          });
        } else {
          root.querySelectorAll('[data-recvline]').forEach((el) => {
            const qty = Number(el.value);
            if (!Number.isFinite(qty) || qty === 0) return;
            entries.push({ index: Number(el.dataset.recvline), qty });
          });
        }
        t.disabled = true;
        await postReceipt(entries);
        return;
      }

      if (t.id === 'ppPrint') {
        // A new tab, not a fetch: the browser's own print dialog is what
        // turns this into a PDF.
        window.open(ENDPOINTS.ppPrint + '?id=' + encodeURIComponent(st.openPoId), '_blank', 'noopener');
        return;
      }

      if (t.id === 'ppSend' || t.id === 'ppSendTest') {
        const isTest = t.id === 'ppSendTest';
        const msg = $('#ppSendMsg');
        // Sending to an outside party is not undoable, so it asks once.
        if (!isTest && !window.confirm('Email this purchase order to the vendor?')) return;
        if (msg) msg.textContent = isTest ? 'Sending a test…' : 'Sending…';
        t.disabled = true;
        try {
          let res = await ctx.api.post(ENDPOINTS.ppSend, { poId: st.openPoId, test: isTest });
          // Asked again at send time, not just at creation: a vendor can be
          // blacklisted AFTER the order was raised, which is the case most
          // worth catching.
          if (res && res.blacklisted === true) {
            if (!confirmBlacklisted(res)) {
              if (msg) msg.textContent = res.error + ' Nothing was sent.';
              t.disabled = false;
              return;
            }
            res = await ctx.api.post(ENDPOINTS.ppSend, { poId: st.openPoId, test: isTest, confirmBlacklist: true });
          }
          if (res && res.error) {
            if (msg) msg.textContent = res.error;
            t.disabled = false;
            return;
          }
          if (isTest) {
            if (msg) msg.textContent = 'Test sent to ' + (res.to || []).join(', ');
            t.disabled = false;
            return;
          }
          await loadAll();
          renderAll();
          const po = st.pos.find((p) => p.id === st.openPoId);
          if (po) renderDetail(po);
          const msg2 = $('#ppSendMsg');
          if (msg2) msg2.textContent = 'Sent to ' + (res.to || []).join(', ') +
            ((res.cc && res.cc.length) ? ', copied to ' + res.cc.join(', ') : '');
        } catch (e) {
          if (msg) msg.textContent = e.message || 'Could not send.';
          t.disabled = false;
        }
        return;
      }

      if (t.id === 'ppArtPick') { const el = $('#ppArtFile'); if (el) el.click(); return; }

      if (t.id === 'ppStagePick') { const el = $('#ppStageFile'); if (el) el.click(); return; }

      if (t.dataset && t.dataset.rmstaged !== undefined) {
        st.stagedArt.splice(Number(t.dataset.rmstaged), 1);
        const box = $('#ppStagedArt');
        if (box) box.innerHTML = stagedArtHtml();
        return;
      }

      if (t.dataset && t.dataset.rmart) {
        if (!window.confirm('Delete this file? Any link the vendor already has stops working.')) return;
        await ctx.api.request(
          ENDPOINTS.ppArt + '?poId=' + encodeURIComponent(st.openPoId) + '&id=' + encodeURIComponent(t.dataset.rmart),
          { method: 'DELETE' }
        );
        await loadAll();
        renderAll();
        const po = st.pos.find((p) => p.id === st.openPoId);
        if (po) renderDetail(po);
        return;
      }

      if (t.id === 'ppArtRevoke') {
        if (!window.confirm('Withdraw every artwork link already sent for this order? The files stay attached. You can send the order again to issue fresh links.')) return;
        const status = $('#ppArtStatus');
        try {
          const res = await ctx.api.request(ENDPOINTS.ppArt, {
            method: 'PATCH',
            body: JSON.stringify({ poId: st.openPoId, revoke: true }),
          });
          if (status) status.textContent = (res && res.error) ? res.error : 'Links withdrawn. Send the order again to issue new ones.';
        } catch (e) {
          if (status) status.textContent = e.message || 'Could not withdraw the links.';
        }
        return;
      }

      if (t.dataset && t.dataset.rmvendor) {
        await ctx.api.request(ENDPOINTS.ppVendors + '?id=' + encodeURIComponent(t.dataset.rmvendor), { method: 'DELETE' });
        await loadAll();
        renderAll();
        return;
      }

      if (t.id === 'ppSaveSettings') { await saveSettingsForm(); return; }

      if (t.id === 'ppNewVendor') { renderVendorForm(null); return; }

      if (t.dataset && t.dataset.editvendor) {
        renderVendorForm(vendorById(t.dataset.editvendor));
        return;
      }

      if (t.id === 'ppVenSave') { await saveVendor(); return; }
      if (t.id === 'ppVenCancel') { $('#ppVendorFormWrap').hidden = true; return; }
    });

    // Shows matches as you type, and everything when the box is focused but
    // empty, so it still behaves like a dropdown for someone who does not
    // remember the name and just wants to browse.
    function renderVendorMatches(term) {
      const box = $('#ppVendorResults');
      if (!box) return;
      const q = String(term || '').trim().toLowerCase();
      const active = st.vendors.filter((v) => v.active !== false);
      const matches = q
        ? active.filter((v) => v.name.toLowerCase().includes(q))
        : active;

      // Adding a vendor mid-order is data entry, not administration. Sending
      // somebody to another tab to do it is how they either abandon the order
      // or pick a near-enough vendor that was already in the list, which is
      // worse than the typing it saved.
      const addRow = (label) => canEdit
        ? '<button data-newvendor="' + esc(q ? term : '') + '" class="pp-addvendor">+ ' + esc(label) + '</button>'
        : '<div style="padding:8px;font-size:12px;color:var(--muted)">Not on the list. Ask an account manager to add them.</div>';

      if (!active.length) {
        box.innerHTML = '<div class="pp-search-results">' +
          '<div style="padding:8px;font-size:12px;color:var(--muted)">No vendors yet.</div>' +
          addRow(q ? 'Add ' + term : 'Add a vendor') + '</div>';
        return;
      }
      if (!matches.length) {
        box.innerHTML = '<div class="pp-search-results">' +
          '<div style="padding:8px;font-size:12px;color:var(--muted)">No vendor matches that.</div>' +
          addRow(q ? 'Add ' + term + ' as a new vendor' : 'Add a vendor') + '</div>';
        return;
      }
      // Blacklisted vendors stay IN the list and are marked, rather than
      // being hidden. Hiding one turns "we do not order from them, and here
      // is why" into "that vendor seems to be missing", and somebody adds
      // them again as a duplicate.
      box.innerHTML = '<div class="pp-search-results">' + matches.slice(0, 12).map((v) =>
        '<button data-vendorpick="' + esc(v.id) + '"><strong>' + esc(v.name) + '</strong>' +
        (v.blacklisted === true ? ' <span class="pp-pill bad">Blacklisted</span>' : '') +
        (v.leadDays != null ? ' <span style="color:var(--muted)">' + esc(v.leadDays) + ' day lead</span>' : '') +
        '</button>'
      ).join('') +
      // Offered even when something matched: "Sanmar" partially matching
      // "SanMar Canada" must not stop you adding the one you meant.
      (q && canEdit ? '<button data-newvendor="' + esc(term) + '" class="pp-addvendor">+ Add ' + esc(term) + ' as a new vendor</button>' : '') +
      '</div>';
    }

    function pickVendor(id) {
      const v = vendorById(id);
      st.draftVendorId = id;
      const searchEl = $('#ppVendorSearch');
      const hiddenEl = $('#ppVendor');
      if (searchEl) searchEl.value = v ? v.name : '';
      if (hiddenEl) hiddenEl.value = id;
      const box = $('#ppVendorResults');
      if (box) box.innerHTML = '';
      renderCcPreview();
    }

    function renderCcPreview() {
      const box = $('#ppCcPreview');
      if (!box) return;
      const amEl = $('#ppAm');
      const venEl = $('#ppVendor');
      if (!amEl || !venEl) return;
      const cc = ccListFor(
        { accountManager: amEl.value },
        vendorById(venEl.value),
        st.settings
      );
      box.textContent = cc.length
        ? 'Will be CC\u2019d on this PO: ' + cc.join(', ')
        : 'Nobody is set to be CC\u2019d yet.';
    }

    root.addEventListener('change', (e) => {
      if (e.target.id === 'ppAm') renderCcPreview();
      if (e.target.dataset && e.target.dataset.imprint) {
        const gid = e.target.dataset.imprint;
        st.pickedGroups = e.target.checked
          ? st.pickedGroups.concat([gid])
          : st.pickedGroups.filter((x) => x !== gid);
        applyGroupSelection();
        renderForm();
      }
      if (e.target.id === 'ppArtFile') uploadArt(e.target.files);

      if (e.target.id === 'ppStageFile') {
        // Appended, not replaced: picking a second time should add rather
        // than quietly discard the first selection.
        st.stagedArt = st.stagedArt.concat(Array.from(e.target.files || []));
        const box = $('#ppStagedArt');
        if (box) box.innerHTML = stagedArtHtml();
        e.target.value = '';
      }
    });

    root.addEventListener('focusin', (e) => {
      if (e.target.id === 'ppVendorSearch') renderVendorMatches(e.target.value);
    });

    // Line edits write straight back to the draft rather than being read off
    // the DOM at save time, so a re-render never loses what was typed.
    root.addEventListener('input', (e) => {
      const cell = e.target.closest('#ppLinesBody tr[data-line] input');
      if (cell) {
        const row = e.target.closest('tr');
        const i = Number(row.dataset.line);
        const f = e.target.dataset.f;
        if (st.draftLines[i]) {
          st.draftLines[i][f] = (f === 'qty' || f === 'unitCost') ? Number(e.target.value) : e.target.value;
          // Update the two figures in place rather than re-rendering the
          // table: a re-render would rebuild the input being typed into and
          // lose the caret mid-number.
          const cellTotal = row.querySelector('[data-linetotal]');
          if (cellTotal) cellTotal.textContent = money(lineTotal(st.draftLines[i]));
          const grand = $('#ppDraftTotal');
          if (grand) grand.textContent = 'Total ' + money(st.draftLines.reduce((a, l) => a + lineTotal(l), 0));
        }
        return;
      }
      if (e.target.id === 'ppSuffix') {
        // Held in state, not read off the DOM at save time, so a re-render
        // never loses what was typed.
        st.poSuffix = e.target.value;
        const prev = $('#ppNumPreview');
        if (prev) prev.textContent = poNumberPreview();
        return;
      }

      if (e.target.id === 'ppVendorSearch') {
        // Typing after a pick clears the pick, so the hidden id can never be
        // left pointing at a vendor whose name is no longer in the box.
        st.draftVendorId = '';
        const hid = $('#ppVendor');
        if (hid) hid.value = '';
        renderVendorMatches(e.target.value);
        renderCcPreview();
        return;
      }

      if (e.target.id === 'ppSearch') {
        clearTimeout(st.searchTimer);
        const val = e.target.value;
        st.searchTimer = setTimeout(() => runSearch(val), 350);
      }
    });

    /**
     * The blacklist stop.
     *
     * The server refuses with 409 and the reason, and this asks the question
     * rather than the browser deciding on its own. That ordering matters: the
     * warning text comes from the vendor record on the server, so it cannot
     * drift out of date in a page somebody left open, and the refusal still
     * happens for anything that never goes through this screen.
     *
     * Returns true when the caller should retry with confirmBlacklist set.
     */
    function confirmBlacklisted(res) {
      if (!res || res.blacklisted !== true) return false;
      const reason = res.reason
        ? '\n\nReason on file: ' + res.reason
        : '\n\nNo reason was recorded, which is worth fixing on the vendor card.';
      return window.confirm(
        'You are ordering from ' + (res.vendorName || 'a blacklisted vendor') + ', which is blacklisted.' +
        reason +
        '\n\nGo ahead anyway? This gets recorded on the order.'
      );
    }

    async function saveNew(confirmBlacklist) {
      const err = $('#ppFormErr');
      err.hidden = true;
      const payload = {
        confirmBlacklist: confirmBlacklist === true,
        vendorId: $('#ppVendor').value,
        accountManager: $('#ppAm').value,
        neededBy: $('#ppNeededBy').value || null,
        decorateBufferDays: Number($('#ppBuffer').value) || 0,
        shipTo: $('#ppShipTo').value,
        shippingInstructions: $('#ppShipVia').value,
        notes: $('#ppNotes').value,
        lines: st.draftLines,
        printavo: st.picked ? {
          id: st.picked.id,
          invoiceNumber: st.picked.invoiceNumber,
          customerName: st.picked.customerName,
          dueDate: st.picked.dueDate,
          // Drives the PO number's suffix: 26-66608-9.
          imprintNumber: st.poSuffix,
          imprintNumbers: (st.picked.groups || [])
            .filter((g) => st.pickedGroups.includes(g.id))
            .map((g) => g.imprintNumber),
          groupIds: st.pickedGroups.slice(),
        } : null,
      };
      try {
        const res = await ctx.api.post(ENDPOINTS.ppPos, payload);
        if (res && res.blacklisted === true && !payload.confirmBlacklist) {
          if (confirmBlacklisted(res)) return saveNew(true);
          err.textContent = res.error + ' Nothing was created.';
          err.hidden = false;
          return;
        }
        if (res && res.error) { err.textContent = res.error; err.hidden = false; return; }

        // The PO exists now, so the staged files finally have something to
        // attach to. Failures here are reported but do NOT roll back the PO:
        // the order is real and correct, and losing it because an upload
        // stalled would be far worse than an order with art still to add.
        const newId = res && res.po && res.po.id;
        let artProblem = '';
        if (newId && st.stagedArt.length) {
          const failed = await uploadArtTo(newId, st.stagedArt);
          if (failed.length) {
            artProblem = ' The order was created, but ' + failed.length +
              ' file' + (failed.length === 1 ? '' : 's') + ' did not upload: ' + failed.join(', ') +
              '. Open the order to try again.';
          }
        }

        st.picked = null;
        st.pickedGroups = [];
        st.imprintLocked = false;
        st.poSuffix = '';
        st.draftVendorId = '';
        st.draftLines = [];
        st.stagedArt = [];
        $('#ppFormWrap').hidden = true;
        await loadAll();
        renderAll();

        if (artProblem) {
          err.textContent = artProblem.trim();
          err.hidden = false;
          $('#ppFormWrap').hidden = false;
        }
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
