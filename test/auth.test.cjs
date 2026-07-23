/**
 * ShopStock — supply inventory, ordering, and QR labels.
 *
 * PORTED from the standalone app. What changed and why:
 *
 *   - The header came off; the shell has one and the rail carries the nav.
 *   - :root and the reset came off; tokens.css and shell.css own them.
 *   - Every document.getElementById became a root-scoped lookup ($id/$one/$all).
 *     Several apps are mounted at once, so a document-wide search could reach
 *     into another app's DOM.
 *   - All 10 fetch() calls now go through ctx.api. The old code inspected
 *     r.ok and awaited r.json(); the seam returns parsed data and throws on a
 *     non-2xx, so those became try/catch.
 *   - 46 inline onclick handlers were namespaced to window.ShopStock.* (see
 *     THE GLOBALS NOTE below).
 *   - The QR library loads on demand instead of on every page view.
 *   - localStorage key "supply_admin_key" became "shopstock.admin_key": five
 *     apps now share one origin, and a bare key could collide.
 *
 * THE GLOBALS NOTE
 * This app wires its buttons with inline onclick="doThing()", which needs those
 * functions reachable from the page. The shell runs each app in module scope,
 * where they are not. Rather than rewrite 46 handlers and the render functions
 * that generate them, the functions are exposed under ONE namespaced global,
 * window.ShopStock, and the handlers call ShopStock.doThing().
 *
 * That is a deliberate compromise, not an oversight. One global is a small,
 * contained collision risk; 27 bare globals would not be. The cleaner fix is
 * event delegation (data-action attributes and a single root listener, the way
 * GivingGauge works), and it is worth doing later, once this app is confirmed
 * working under the shell and there is something to compare behaviour against.
 *
 * The namespace is torn down in unmount().
 */

import { ENDPOINTS } from '../js/api.js';
import { loadQRCode } from '../js/qrcode-loader.js';

export default {
  id: 'shopstock',

  styles: `


  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}



  .logomark svg{width:36px;height:36px;display:block}









  .badge{position:absolute;top:-6px;right:-14px;background:var(--danger);color:var(--on-accent);border-radius:99px;font-size:10px;font-weight:700;padding:1px 5px;min-width:16px;text-align:center}
  .btn{border:none;padding:9px 18px;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;font-weight:700;display:inline-flex;align-items:center;gap:6px;font-family:inherit}
  .btn-green{background:var(--accent);color:var(--on-accent)}.btn-green:hover{background:var(--accent-deep)}
  .btn-gray{background:var(--on-accent);color:var(--accent-deep);border:1px solid var(--line)}.btn-gray:hover{background:var(--line-soft)}
  .btn-red{background:var(--danger-tint);color:var(--danger);border:1px solid var(--danger-line)}.btn-red:hover{background:var(--danger-line)}
  .btn-amber{background:var(--amber-tint);color:var(--amber);border:1px solid var(--amber-line)}.btn-amber:hover{background:var(--amber-hover)}
  .btn-sm{padding:5px 12px;font-size:12px}
  .btn:disabled{opacity:.4;cursor:not-allowed}

  /* Pages */
  .page{display:none;padding:24px}.page.active{display:block}

  /* Search/filter bar */
  .toolbar{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;align-items:center}
  .search-input{background:var(--on-accent);border:1px solid var(--line);border-radius:var(--radius-sm);padding:8px 14px;font-size:13px;color:var(--ink);outline:none;width:260px}
  .search-input:focus{border-color:var(--accent);outline:2px solid var(--accent);outline-offset:-1px}
  .filter-select{background:var(--on-accent);border:1px solid var(--line);border-radius:var(--radius-sm);padding:8px 12px;font-size:13px;color:var(--ink);outline:none;cursor:pointer}
  .filter-select:focus{border-color:var(--accent);outline:2px solid var(--accent);outline-offset:-1px}

  /* Stats row */
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:24px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:16px 20px}
  .stat-lbl{font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}
  .stat-val{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .stat-sub{font-size:11px;color:var(--muted);margin-top:3px}

  /* Table */
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden;margin-bottom:16px}
  .card-hd{padding:16px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}
  .card-hd h3{font-size:15px;font-weight:700}
  .tbl-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);padding:10px 14px;font-weight:600;background:var(--head-bg);border-bottom:1px solid var(--line);cursor:pointer;white-space:nowrap;user-select:none}
  th:hover{color:var(--ink)}
  td{padding:11px 14px;border-bottom:1px solid var(--line);color:var(--ink);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:var(--head-bg)}

  /* Status pills */
  .status{display:inline-flex;align-items:center;gap:4px;padding:3px 11px;border-radius:20px;font-size:11px;font-weight:600;white-space:nowrap}
  .s-stock{background:var(--success-tint);color:var(--success)}
  .s-need{background:var(--danger-tint);color:var(--danger)}
  .s-ordered{background:var(--amber-tint);color:var(--amber)}
  .s-issue{background:var(--accent-tint);color:var(--accent-deep)}

  /* Item detail page */
  .item-hero{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:28px;margin-bottom:20px}
  .item-name{font-size:28px;font-weight:800;letter-spacing:-.02em;margin-bottom:6px}
  .item-meta{font-size:13px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px}
  .item-actions{display:flex;gap:10px;flex-wrap:wrap}
  .item-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
  .info-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:20px}
  .info-card h4{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:12px}
  .info-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px}
  .info-row:last-child{border-bottom:none}
  .info-row .lbl{color:var(--muted)}
  .info-row .val{font-weight:500}
  .price-history{display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto}
  .ph-row{display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-bottom:1px solid var(--line)}
  .ph-row:last-child{border-bottom:none}

  /* QR */
  .qr-wrap{background:var(--on-accent);border:1px solid var(--line);border-radius:var(--radius-md);padding:20px;text-align:center;display:inline-block}
  .qr-wrap canvas{display:block;margin:0 auto 8px}

  /* Modal */
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:none;align-items:center;justify-content:center;padding:20px}
  .overlay.open{display:flex}
  .modal{background:var(--on-accent);border-radius:var(--radius-md);width:100%;max-width:560px;box-shadow:0 20px 60px rgba(0,0,0,.2);overflow:hidden;max-height:90vh;overflow-y:auto}
  .modal-hd{padding:18px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--on-accent);z-index:1}
  .modal-hd h2{font-size:16px;font-weight:700}
  .modal-close{background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);line-height:1;padding:2px}
  .modal-close:hover{color:var(--ink)}
  .modal-bd{padding:20px}
  .field{margin-bottom:16px}
  .field label{display:block;font-size:11px;font-weight:600;color:var(--muted);margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em}
  .field label .req{color:var(--accent)}
  .field input,.field select,.field textarea{width:100%;background:var(--on-accent);border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px;font-size:13px;color:var(--ink);outline:none;font-family:inherit}
  .field input:focus,.field select:focus,.field textarea:focus{border-color:var(--accent);outline:2px solid var(--accent);outline-offset:-1px;background:var(--on-accent)}
  .field textarea{resize:vertical;min-height:72px}
  .field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .modal-footer{padding:14px 20px;border-top:1px solid var(--line);display:flex;gap:10px;justify-content:flex-end;background:var(--head-bg)}

  /* Flag page (QR scan destination) */
  .flag-wrap{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center}
  .flag-icon{font-size:64px;margin-bottom:16px}
  .flag-title{font-size:24px;font-weight:700;margin-bottom:8px}
  .flag-sub{font-size:15px;color:var(--muted);margin-bottom:32px;max-width:340px;line-height:1.6}
  .flag-btn{font-size:18px;padding:16px 40px;border-radius:10px;width:100%;max-width:320px;justify-content:center}
  .flag-success{background:var(--success-tint);border-radius:var(--radius-md);padding:24px;max-width:360px;width:100%}

  /* Order queue */
  .queue-item{background:var(--on-accent);border:1px solid var(--line);border-radius:var(--radius-md);padding:16px 20px;display:flex;align-items:center;gap:16px;margin-bottom:10px}
  .queue-item:hover{border-color:var(--accent)}
  .queue-info{flex:1}
  .queue-name{font-size:14px;font-weight:600;margin-bottom:2px}
  .queue-meta{font-size:12px;color:var(--muted)}
  .queue-actions{display:flex;gap:8px}

  /* Toast */
  .toast{position:fixed;bottom:24px;right:24px;background:var(--ink);color:var(--on-accent);padding:12px 20px;border-radius:var(--radius-sm);font-size:13px;font-weight:500;z-index:300;opacity:0;transition:opacity .3s;pointer-events:none}
  .toast.show{opacity:1}

  /* Empty state */
  .empty{text-align:center;padding:48px 24px;color:var(--faint)}
  .empty-icon{font-size:40px;margin-bottom:12px}
  .empty p{font-size:14px}

  @media(max-width:600px){.item-grid{grid-template-columns:1fr}.field-row{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr}}

  /* Department sections */
  .dept-section{margin-bottom:16px;border-radius:var(--radius-md);overflow:hidden;border:1px solid var(--line)}
  .dept-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;cursor:pointer;user-select:none;font-weight:600;font-size:14px}
  .dept-header:hover{filter:brightness(.97)}
  .dept-toggle{font-size:18px;transition:transform .2s;line-height:1}
  .dept-toggle.collapsed{transform:rotate(-90deg)}
  .dept-body{border-top:1px solid rgba(0,0,0,.08)}
  .dept-body.hidden{display:none}
  .dept-count{font-size:12px;font-weight:500;opacity:.7;margin-left:8px}

  /* Needs ordering cards */
  .order-card{display:flex;align-items:center;gap:14px;padding:14px 16px;border-bottom:1px solid rgba(0,0,0,.06);background:var(--on-accent)}
  .order-card:last-child{border-bottom:none}
  .order-card:hover{background:var(--row-hover)}
  .order-card-info{flex:1;min-width:0}
  .order-card-name{font-weight:600;font-size:14px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .order-card-meta{font-size:12px;color:var(--muted)}
  .order-card-price{font-size:15px;font-weight:700;color:var(--ink);white-space:nowrap}
  .order-card-actions{display:flex;gap:6px;flex-shrink:0}
  .empty-dept{padding:20px;text-align:center;color:var(--faint);font-size:13px}
  .empty-star-wrap{display:flex;flex-direction:row;align-items:center;justify-content:center;gap:14px;padding:26px 20px}
  .empty-star{width:80px;height:80px;flex-shrink:0}
  .empty-star svg{width:100%;height:100%;display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.08))}
  .empty-star-text{font-size:15px;font-weight:700;color:var(--ink);font-family:'Inter',sans-serif}

  /* Dashboard side-by-side sections */
  .dashboard-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
  @media(max-width:800px){.dashboard-grid{grid-template-columns:1fr}}

  `,

  template: `
    <!-- Needs Ordering page (default dashboard) -->
    <div id="page-inventory" class="page active">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:28px;font-weight:800;letter-spacing:-.02em">Dashboard.</div>
          <div style="font-size:13px;color:var(--muted);margin-top:2px" id="inv-sub"></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:6px;background:var(--head-bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px">
            <span style="font-size:12px;color:var(--muted);white-space:nowrap">Bulk:</span>
            <select id="bulk-status-select" style="border:none;background:transparent;font-size:12px;color:var(--ink);outline:none;cursor:pointer">
              <option value="">Change selected to...</option>
              <option value="In Stock">In Stock</option>
              <option value="Needs Ordered">Needs Ordered</option>
              <option value="Ordered">Ordered</option>
              <option value="Issue">Issue</option>
            </select>
            <span id="bulk-count" style="font-size:12px;color:var(--accent);font-weight:600;white-space:nowrap"></span>
            <button class="btn btn-green btn-sm" onclick="ShopStock.bulkStatusChange()">Apply</button>
          </div>
          <button class="btn btn-green" onclick="ShopStock.openAddModal()">Add item</button>
        </div>
      </div>
      <div class="stats" id="inv-stats"></div>
      <div id="needs-ordering-list"></div>
    </div>

    <!-- Full Inventory page -->
    <div id="page-full" class="page">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:28px;font-weight:800;letter-spacing:-.02em">Full inventory.</div>
          <div style="font-size:13px;color:var(--muted);margin-top:2px" id="full-sub"></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input class="search-input" id="full-search" placeholder="Search items..." oninput="ShopStock.renderFullInventory()"/>
          <select class="filter-select" id="full-filter-supplier" onchange="ShopStock.renderFullInventory()">
            <option value="">All Suppliers</option>
          </select>
          <button class="btn btn-gray" onclick="ShopStock.bulkPrintQR()" title="Print QR codes for checked items, or all items if none checked">🖨️ Print QR Codes</button>
          <button class="btn btn-green" onclick="ShopStock.openAddModal()">Add item</button>
        </div>
      </div>
      <div id="full-inventory-list"></div>
    </div>

    <!-- Order Queue page -->
    <div id="page-queue" class="page">
      <div style="font-size:28px;font-weight:800;letter-spacing:-.02em;margin-bottom:4px">Order queue.</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:24px">Items flagged as needing to be ordered</div>
      <div id="queue-list"></div>
    </div>

    <!-- Item detail page (QR destination) -->
    <div id="page-item" class="page">
      <div id="item-detail"></div>
    </div>

    <!-- Admin page -->
    <div id="page-admin" class="page">
      <div style="font-size:28px;font-weight:800;letter-spacing:-.02em;margin-bottom:4px">Admin.</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:24px">Manage settings, trigger price scraping, and configure ShopStock</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:1100px">
        <div class="card">
          <div class="card-hd"><h3>Departments & Colors</h3></div>
          <div style="padding:16px">
            <div style="font-size:12px;color:var(--muted);margin-bottom:12px">Add departments and customize their colors. These are used throughout the dashboard.</div>
            <div id="dept-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px"></div>
            <div style="display:flex;gap:8px">
              <input type="text" id="new-dept-name" placeholder="Department name" style="flex:1;background:var(--head-bg);border:1px solid var(--line);border-radius:7px;padding:8px 12px;font-size:13px;outline:none"/>
              <!-- TOKEN-EXEMPT: default value for a department color picker; data, not theme -->
        <input type="color" id="new-dept-color" value="#3D9A5C" style="width:40px;height:36px;border:1px solid var(--line);border-radius:7px;cursor:pointer;padding:2px"/>
              <button class="btn btn-green btn-sm" onclick="ShopStock.addDepartment()">Add</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>Categories</h3></div>
          <div style="padding:16px">
            <div style="font-size:12px;color:var(--muted);margin-bottom:12px">Add categories to organize items within departments.</div>
            <div id="cat-list" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px"></div>
            <div style="display:flex;gap:8px">
              <input type="text" id="new-cat-name" placeholder="Category name" style="flex:1;background:var(--head-bg);border:1px solid var(--line);border-radius:7px;padding:8px 12px;font-size:13px;outline:none"/>
              <button class="btn btn-green btn-sm" onclick="ShopStock.addCategory()">Add</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>Admin Access</h3></div>
          <div style="padding:16px">
            <div class="field">
              <label>Admin Key</label>
              <input type="password" id="admin-key-input" placeholder="Enter admin key"/>
            </div>
            <button class="btn btn-green" onclick="ShopStock.saveAdminKey()" style="margin-bottom:10px">Save Admin Key</button>
            <div style="font-size:12px;color:var(--muted)">The admin key is set in your Vercel environment variables as ADMIN_KEY. Enter it here to unlock admin features.</div>
            <div style="margin-top:10px;font-size:13px;font-weight:600" id="admin-status"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>Price Scraping</h3></div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="font-size:13px;color:var(--muted)">Automatically check supplier URLs and update prices where possible.</div>
            <button class="btn btn-green btn-sm" onclick="ShopStock.runScrape()">Run Price Scrape Now</button>
            <div style="font-size:12px;color:var(--faint)" id="scrape-status"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>Import from CSV</h3></div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="font-size:13px;color:var(--muted)">Upload a CSV to bulk-import items. Columns: name, department, category, supplier, supplierLink, unit, currentPrice, notes</div>
            <input type="file" id="csv-input" accept=".csv"/>
            <button class="btn btn-green btn-sm" onclick="ShopStock.importCSV(this.closest('[data-app-root]').querySelector('#csv-input'))" style="margin-top:8px">Import CSV</button>
            <div style="font-size:12px;color:var(--faint);margin-top:8px" id="import-status"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>Export</h3></div>
          <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
            <div style="font-size:13px;color:var(--muted)">Export all inventory data as CSV.</div>
            <button class="btn btn-gray btn-sm" onclick="ShopStock.exportCSV()">Export to CSV</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Add/Edit Modal -->
    <div class="overlay" id="item-modal" onclick="ShopStock.closeModal(event)">
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-hd">
          <h2 id="modal-title">Add Item</h2>
          <button class="modal-close" onclick="ShopStock.closeModal()">×</button>
        </div>
        <div class="modal-bd">
          <input type="hidden" id="edit-id"/>
          <div class="field-row">
            <div class="field"><label>Item name <span class="req">*</span></label><input type="text" id="f-name" placeholder="e.g. PMS Process Blue"/></div>
            <div class="field"><label>Department</label>
              <select id="f-dept"></select>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Category</label>
              <select id="f-cat-select" onchange="if(this.value)this.closest('[data-app-root]').querySelector('#f-cat').value=this.value"></select>
              <input type="text" id="f-cat" placeholder="Or type a custom category" style="margin-top:6px"/>
            </div>
            <div class="field"><label>Unit</label><input type="text" id="f-unit" placeholder="e.g. 1 Gallon, Case of 24"/></div>
          </div>
          <div class="field-row">
            <div class="field"><label>Supplier</label><input type="text" id="f-supplier" placeholder="e.g. SPSI, Atlas, Uline"/></div>
            <div class="field"><label>Current Price ($)</label><input type="number" id="f-price" step="0.01" placeholder="0.00"/></div>
          </div>
          <div class="field"><label>Supplier Link (for scraping)</label><input type="url" id="f-link" placeholder="https://..."/></div>
          <div class="field"><label>Notes</label><textarea id="f-notes" placeholder="Any notes..."></textarea></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-gray" onclick="ShopStock.closeModal()">Cancel</button>
          <button class="btn btn-green" onclick="ShopStock.saveItem()">Save Item</button>
        </div>
      </div>
    </div>

    <!-- QR Modal -->
    <div class="overlay" id="qr-modal" onclick="ShopStock.closeQRModal(event)">
      <div class="modal" style="max-width:360px;text-align:center" onclick="event.stopPropagation()">
        <div class="modal-hd">
          <h2 id="qr-title">QR Code</h2>
          <button class="modal-close" onclick="ShopStock.closeQRModal()">×</button>
        </div>
        <div class="modal-bd" style="display:flex;flex-direction:column;align-items:center;gap:16px">
          <div class="qr-wrap"><div id="qr-code"></div></div>
          <div style="font-size:12px;color:var(--muted)" id="qr-url"></div>
          <button class="btn btn-green" onclick="ShopStock.printQR()">Print QR Code</button>
        </div>
      </div>
    </div>

    <div class="toast" id="toast"></div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const api = ctx.api;

    // Root-scoped DOM helpers. These replace document.getElementById and
    // friends so this app can only ever see its own markup.
    const $id  = (id) => root.querySelector('#' + CSS.escape(id));
    const $one = (sel) => root.querySelector(sel);
    const $all = (sel) => root.querySelectorAll(sel);


    // API paths come from ENDPOINTS; see api.js (the seam).

    // TOKEN-EXEMPT: department colors are DATA, not theming. Ryan picks them in
    // Admin and they are stored in settings, so they must NOT follow the app
    // accent — a department keeps its color whichever app is on screen.
    const DEFAULT_DEPT_COLORS = {
      "Screen Printing": "#FB8C00",
      "Embroidery":      "#8E24AA",
      "Office":          "#1E88E5",
      "General":         "#43A047",
      "Heat Seal":       "#E91E63",
      "Compiling":       "#00ACC1",
      "DTF":             "#FFB300",
      "Promo Products":  "#7CB342",
    };
    const DEFAULT_CATEGORIES = ["Inks","Chemicals","Tools","Tape","Emulsion","Thread","Stabilizer","Consumables","Safety","Packaging","Paper","Electronics","Pens & Markers","Cleaning","Vinyl"];

    // In-memory settings — loaded from Upstash on startup
    let _deptColors = {...DEFAULT_DEPT_COLORS};
    let _categories = [...DEFAULT_CATEGORIES];

    function getDeptColors() { return _deptColors; }
    function getCategories() { return _categories; }

    async function loadSettings() {
      try {
        const s = await api.get(ENDPOINTS.ssSettings);
        if (s) {
          if(s.deptColors) _deptColors = s.deptColors;
          if(s.categories) _categories = s.categories;
        }
      } catch(e) { console.warn("Could not load settings", e); }
    }

    async function saveSettings() {
      try {
        await api.request(ENDPOINTS.ssSettings, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
          body: JSON.stringify({ deptColors: _deptColors, categories: _categories })
        });
      } catch(e) { console.warn("Could not save settings", e); }
    }
    function hexToRgb(hex) {
      const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
      return {r,g,b};
    }
    function colorVariants(hex) {
      const {r,g,b} = hexToRgb(hex);
      return {
        bg: `rgba(${r},${g},${b},0.1)`,
        border: hex,
        text: `rgba(${Math.max(0,r-60)},${Math.max(0,g-60)},${Math.max(0,b-60)},1)`,
        dot: hex
      };
    }
    function deptColor(dept) {
      const colors = getDeptColors();
      const hex = colors[dept];
      if(hex) return colorVariants(hex);
      return { bg: "var(--line-soft)", border: "var(--faint)", text: "var(--ink)", dot: "var(--faint)" };
    }
    function deptBadge(dept) {
      const c = deptColor(dept);
      return `<span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:${c.bg};color:${c.text};border:1px solid ${c.border}">${dept||"General"}</span>`;
    }

    let allItems = [];
    let sortCol = "name", sortDir = 1;
    let adminKey = localStorage.getItem("shopstock.admin_key") || "";
    let currentItemId = null;

    // ── Routing ───────────────────────────────────────────────────────────────
    function getPage() {
      // The standalone app read window.location.pathname. Under the shell the
      // pathname is always "/" and the route lives in the hash, so read that:
      //   #/shopstock/<page>          e.g. #/shopstock/full
      //   #/shopstock/item/<id>       the QR scan destination
      const hash = window.location.hash.replace(/^#\/?/, "");
      const parts = hash.split("/").filter(Boolean);   // ["shopstock", page, id?]
      const page = parts[1] || "inventory";
      if (page === "item" && parts[2]) return { page: "item", id: parts[2] };
      return { page };
    }

    function showPage(name, btn) {
      $all(".page").forEach(p => p.classList.remove("active"));
      $all(".nav-btn").forEach(b => b.classList.remove("active"));
      $id("page-"+name).classList.add("active");
      if(btn) btn.classList.add("active");
      else $id("nav-"+name) && $id("nav-"+name).classList.add("active");
      if(name === "queue") renderQueue();
      if(name === "admin") initAdmin();
      if(name === "full") renderFullInventory();
    }

    // ── Data ──────────────────────────────────────────────────────────────────
    async function loadItems() {
      try {
        await loadSettings();
        // The seam may return the array directly or wrapped as { items }.
        const payload = await api.get(ENDPOINTS.ssItems);
        allItems = Array.isArray(payload) ? payload : (payload && payload.items) || [];
        updateBadge();
        renderInventory();
        populateFilters();
      } catch(e) {
        // Surface the real reason. A bare "Failed to load items" hides whether
        // the endpoint is missing, the data is malformed, or a render threw.
        console.error('[shopstock] loadItems failed:', e);
        showToast("Failed to load items: " + (e && e.message ? e.message : e), true);
      }
    }

    function updateBadge() {
      const n = allItems.filter(i => i.status === "Needs Ordered").length;
      // "queue-badge" lived in the app's OWN header, which the shell replaced,
      // so this element no longer exists. The count still matters, so it is
      // published to the shell instead of silently dropped. Guarded because the
      // element is genuinely absent, not because null checks are free.
      const badge = $id("queue-badge");
      if (badge) {
        badge.textContent = n;
        badge.style.display = n > 0 ? "" : "none";
      }
      if (typeof ctx.setBadge === "function") ctx.setBadge(n);
    }

    // ── Needs Ordering view (dashboard) ──────────────────────────────────────
    function renderInventory() {
      const needOrder = allItems.filter(i=>i.status==="Needs Ordered").length;
      const ordered   = allItems.filter(i=>i.status==="Ordered").length;

      $id("inv-stats").innerHTML = `
        <div class="stat"><div class="stat-lbl">Total Items</div><div class="stat-val">${allItems.length}</div><div class="stat-sub">across all departments</div></div>
        <div class="stat"><div class="stat-lbl">Needs Ordered</div><div class="stat-val" style="color:var(--danger)">${needOrder}</div><div class="stat-sub">flagged for reorder</div></div>
        <div class="stat"><div class="stat-lbl">On Order</div><div class="stat-val" style="color:var(--accent)">${ordered}</div><div class="stat-sub">awaiting arrival</div></div>
        <div class="stat"><div class="stat-lbl">In Stock</div><div class="stat-val" style="color:var(--success)">${allItems.length - needOrder - ordered}</div><div class="stat-sub">all good</div></div>
      `;
      $id("inv-sub").textContent = `${needOrder} items need ordering · ${ordered} on order`;

      const needItemsOnly = allItems.filter(i=>i.status==="Needs Ordered");
      const orderedItemsOnly = allItems.filter(i=>i.status==="Ordered");
      const el = $id("needs-ordering-list");

      // Always show both sections side by side — never collapse away when empty
      const sections = [
        { label:"Needs Ordered", color:"var(--danger)", bg:"var(--danger-tint)", border:"var(--danger-line)", items: needItemsOnly },
        { label:"On Order",      color:"var(--amber)", bg:"var(--amber-tint)", border:"var(--amber-line)", items: orderedItemsOnly },
      ];

      el.innerHTML = `<div class="dashboard-grid">${sections.map(sec=>`
        <div class="dept-section" style="border-color:${sec.border};margin-bottom:0">
          <div class="dept-header" style="background:${sec.bg};color:${sec.color}" onclick="ShopStock.toggleDept(this)">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="width:10px;height:10px;border-radius:50%;background:${sec.color};display:inline-block;flex-shrink:0"></span>
              ${sec.label}
              <span class="dept-count" style="color:${sec.color}">${sec.items.length} item${sec.items.length!==1?"s":""}</span>
            </div>
            <span class="dept-toggle">▼</span>
          </div>
          <div class="dept-body">
            ${sec.items.length ? sec.items.map(item=>`
              <div class="order-card">
                <input type="checkbox" class="dash-check" data-id="${item.id}" onchange="ShopStock.updateBulkCount()" style="width:16px;height:16px;flex-shrink:0;cursor:pointer;accent-color:var(--accent)"/>
                <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${sec.color};flex-shrink:0"></span>
                <div class="order-card-info">
                  <div class="order-card-name" style="cursor:pointer;color:var(--accent);font-weight:600" onclick="ShopStock.viewItem('${item.id}')">${item.name}</div>
                  <div class="order-card-meta">${item.department||""} · ${item.supplier||"No supplier"} · ${item.unit||""}</div>
                </div>
                <div class="order-card-price">$${(item.currentPrice||0).toFixed(2)}</div>
                <div class="order-card-actions">
                  ${item.supplierLink&&!item.supplierLink.startsWith("email")&&!item.supplierLink.startsWith("EMAIL")?`<a href="${item.supplierLink}" target="_blank" class="btn btn-gray btn-sm" style="text-decoration:none">🛒 Order</a>`:""}
                  <select onchange="ShopStock.updateStatus('${item.id}',this.value)" style="background:var(--head-bg);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font-size:12px;cursor:pointer;outline:none">
                    <option value="In Stock">In Stock</option>
                    <option value="Needs Ordered" ${item.status==="Needs Ordered"?"selected":""}>Needs Ordered</option>
                    <option value="Ordered" ${item.status==="Ordered"?"selected":""}>Ordered</option>
                    <option value="Issue" ${item.status==="Issue"?"selected":""}>Issue</option>
                  </select>
                </div>
              </div>`).join("") : `<div class="empty-star-wrap">
                <div class="empty-star">
                  <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                    <polygon points="46,3 58,33 96,36 66,55 74,92 45,70 12,90 22,53 2,32 40,30" fill="var(--gold-bright)" stroke="var(--gold-deep)" stroke-width="1.6" stroke-linejoin="round"/>
                  </svg>
                </div>
                <span class="empty-star-text">You Did It!</span>
              </div>`}
          </div>
        </div>`).join("")}</div>`;
    }

    // ── Full Inventory view (by department, collapsible) ───────────────────────
    function renderFullInventory() {
      const search   = ($id("full-search")?.value||"").toLowerCase();
      const supplier = $id("full-filter-supplier")?.value||"";

      let items = allItems.filter(i => {
        if(search && !i.name.toLowerCase().includes(search) &&
           !(i.supplier||"").toLowerCase().includes(search) &&
           !(i.category||"").toLowerCase().includes(search)) return false;
        if(supplier && i.supplier !== supplier) return false;
        return true;
      });

      $id("full-sub").textContent = `${items.length} of ${allItems.length} items`;

      const depts = [...new Set(items.map(i=>i.department||"General"))].sort();
      const el = $id("full-inventory-list");

      el.innerHTML = depts.map(dept => {
        const c = deptColor(dept);
        const deptItems = items.filter(i=>(i.department||"General")===dept)
          .sort((a,b)=>a.name.localeCompare(b.name));
        return `<div class="dept-section" style="border-color:${c.border}">
          <div class="dept-header" style="background:${c.bg};color:${c.text}" onclick="ShopStock.toggleDept(this)">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="width:10px;height:10px;border-radius:50%;background:${c.dot};display:inline-block;flex-shrink:0"></span>
              ${dept}
              <span class="dept-count">${deptItems.length} item${deptItems.length!==1?"s":""}</span>
            </div>
            <span class="dept-toggle">▼</span>
          </div>
          <div class="dept-body">
            <div class="tbl-wrap">
            <table style="table-layout:fixed;width:100%">
              <thead><tr>
                <th style="width:32px"><input type="checkbox" onclick="ShopStock.toggleAllChecks(this)" title="Select all"/></th>
                <th style="width:30%">Item</th>
                <th style="width:12%">Supplier</th>
                <th style="width:8%">Price</th>
                <th style="width:12%">Unit</th>
                <th style="width:12%">Status</th>
                <th style="width:10%">Last Ordered</th>
                <th style="width:5%">YTD</th>
                <th style="width:11%">Actions</th>
              </tr></thead>
              <tbody>
                ${deptItems.map(item=>`<tr>
                  <td><input type="checkbox" class="bulk-check" data-id="${item.id}"/></td>
                  <td style="overflow:hidden;cursor:pointer" onclick="ShopStock.viewItem('${item.id}')">
                    <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--accent)">${item.name}</div>
                    ${item.category?`<div style="font-size:11px;color:var(--faint)">${item.category}</div>`:""}
                  </td>
                  <td style="overflow:hidden">
                    <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:3px">${item.supplier||"—"}</div>
                    ${item.supplierLink&&!item.supplierLink.startsWith("EMAIL")&&!item.supplierLink.startsWith("email")?`<a href="${item.supplierLink}" target="_blank" style="display:inline-block;padding:2px 8px;background:var(--accent-tint);color:var(--accent-deep);border:1px solid var(--accent-tint);border-radius:4px;font-size:11px;font-weight:600;text-decoration:none">🛒 Order</a>`:item.supplierLink?`<span style="font-size:11px;color:var(--faint)">📧 Email order</span>`:""}
                  </td>
                  <td style="font-weight:600">$${(item.currentPrice||0).toFixed(2)}</td>
                  <td style="color:var(--muted)">${item.unit||"—"}</td>
                  <td>
                    <select onchange="ShopStock.updateStatus('${item.id}',this.value)" style="background:var(--head-bg);border:1px solid var(--line);border-radius:6px;padding:4px 6px;font-size:12px;cursor:pointer;outline:none">
                      <option value="In Stock" ${(item.status||"In Stock")==="In Stock"?"selected":""}>In Stock</option>
                      <option value="Needs Ordered" ${item.status==="Needs Ordered"?"selected":""}>Needs Ordered</option>
                      <option value="Ordered" ${item.status==="Ordered"?"selected":""}>Ordered</option>
                      <option value="Issue" ${item.status==="Issue"?"selected":""}>Issue</option>
                    </select>
                  </td>
                  <td style="color:var(--muted)">${item.lastOrdered?new Date(item.lastOrdered).toLocaleDateString():"Never"}</td>
                  <td style="text-align:center">${item.timesOrderedYTD||0}</td>
                  <td>
                    <div style="display:flex;gap:4px">
                      <button class="btn btn-gray btn-sm" onclick="ShopStock.showQR('${item.id}')">QR</button>
                      <button class="btn btn-gray btn-sm" onclick="ShopStock.openEditModal('${item.id}')">Edit</button>
                    </div>
                  </td>
                </tr>`).join("")}
              </tbody>
            </table>
            </div>
          </div>
        </div>`;
      }).join("");
    }

    function toggleDept(header) {
      const body = header.nextElementSibling;
      const arrow = header.querySelector(".dept-toggle");
      body.classList.toggle("hidden");
      arrow.classList.toggle("collapsed");
    }

    function populateFilters() {
      const suppliers = [...new Set(allItems.map(i=>i.supplier).filter(Boolean))].sort();
      const supSel = $id("full-filter-supplier");
      if(supSel) supSel.innerHTML = `<option value="">All Suppliers</option>` + suppliers.map(s=>`<option>${s}</option>`).join("");
    }

    function filterItems() { renderInventory(); }
    function toggleAllChecks(master) {
      $all(".bulk-check").forEach(c=>c.checked=master.checked);
    }
    function sortBy(col) { sortDir = sortCol===col ? -sortDir : 1; sortCol=col; renderFullInventory(); }

    function statusClass(s) {
      if(s==="Needs Ordered") return "s-need";
      if(s==="Ordered") return "s-ordered";
      if(s==="Issue") return "s-issue";
      return "s-stock";
    }
    function statusDot(s) {
      if(s==="Needs Ordered") return "🔴";
      if(s==="Ordered") return "🟡";
      if(s==="Issue") return "🔵";
      return "🟢";
    }

    // ── Order Queue ───────────────────────────────────────────────────────────
    function renderQueue() {
      const items = allItems.filter(i => i.status === "Needs Ordered" || i.status === "Ordered");
      const el = $id("queue-list");
      if(!items.length) {
        el.innerHTML = `<div class="empty"><div class="empty-icon">✅</div><p>Nothing needs ordering right now</p></div>`;
        return;
      }
      el.innerHTML = items.map(item => `
        <div class="queue-item">
          <div style="font-size:28px">${item.status==="Needs Ordered"?"🔴":"🟡"}</div>
          <div class="queue-info">
            <div class="queue-name">${item.name}</div>
            <div class="queue-meta">${item.department||""} · ${item.supplier||"No supplier"} · $${(item.currentPrice||0).toFixed(2)} ${item.unit||""}</div>
            ${item.supplierLink?`<a href="${item.supplierLink}" target="_blank" style="font-size:12px;color:var(--accent)">Open supplier page →</a>`:""}
          </div>
          <div class="queue-actions">
            ${item.status==="Needs Ordered"?`<button class="btn btn-amber btn-sm" onclick="ShopStock.updateStatus('${item.id}','Ordered')">Mark Ordered</button>`:""}
            <button class="btn btn-green btn-sm" onclick="ShopStock.updateStatus('${item.id}','In Stock')">Mark Issue</button>
            <button class="btn btn-gray btn-sm" onclick="ShopStock.viewItem('${item.id}')">Details</button>
          </div>
        </div>
      `).join("");
    }

    async function updateStatus(id, status) {
      try {
        const updated = await api.request(ENDPOINTS.ssItems + "?id=" + id, {
          method: "PUT",
          headers: { "x-admin-key": adminKey },
          body: { status }
        });
        const idx = allItems.findIndex(i=>i.id===id);
        if(idx>=0) allItems[idx] = updated;
        updateBadge(); renderQueue(); renderInventory();
        showToast(`Marked as ${status}`);
      } catch (e) {
        showToast("Failed — check admin key", true);
      }
    }

    // ── Bulk status change (dashboard) ────────────────────────────────────────
    function getDashSelection() {
      return [...$all(".dash-check:checked")].map(c=>c.dataset.id);
    }

    function updateBulkCount() {
      const n = getDashSelection().length;
      const el = $id("bulk-count");
      if(el) el.textContent = n ? `${n} selected` : "";
    }

    async function bulkStatusChange() {
      const sel = $id("bulk-status-select");
      const status = sel ? sel.value : "";
      const ids = getDashSelection();

      // Explicit selection required — no select-all fallback
      if(!ids.length) { showToast("Select at least one item first", true); return; }
      if(!status) { showToast("Choose a status to apply", true); return; }
      if(!adminKey) { showToast("Admin key required — set it in Admin", true); return; }

      showToast(`Updating ${ids.length} item${ids.length!==1?"s":""}...`);

      let ok = 0, fail = 0;
      for(const id of ids) {
        try {
          const updated = await api.request(ENDPOINTS.ssItems + "?id=" + id, {
            method: "PUT",
            headers: { "x-admin-key": adminKey },
            body: { status }
          });
          const idx = allItems.findIndex(i=>i.id===id);
          if(idx>=0) allItems[idx] = updated;
          ok++;
        } catch(e) { fail++; }
      }

      if(sel) sel.value = "";
      updateBadge(); renderInventory(); renderQueue();
      updateBulkCount();
      showToast(fail ? `${ok} updated, ${fail} failed — check admin key` : `${ok} item${ok!==1?"s":""} marked as ${status}`, fail>0);
    }

    // ── Item detail ───────────────────────────────────────────────────────────
    function viewItem(id) {
      currentItemId = id;
      const item = allItems.find(i=>i.id===id);
      if(!item) return;
      showPage("item");
      $all(".nav-btn").forEach(b=>b.classList.remove("active"));

      const ph = (item.priceHistory||[]).slice().reverse();
      $id("item-detail").innerHTML = `
        <div class="item-hero">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px">
            <div>
              <div class="item-name">${item.name}</div>
              <div class="item-meta">
                <span>📦 ${item.department||"No dept"}</span>
                <span>🏷 ${item.category||"No category"}</span>
                <span>🏭 ${item.supplier||"No supplier"}</span>
                <span><span class="status ${statusClass(item.status)}">${statusDot(item.status)} ${item.status||"In Stock"}</span></span>
              </div>
            </div>
            <div style="font-size:32px;font-weight:800;letter-spacing:-.02em;color:var(--ink)">$${(item.currentPrice||0).toFixed(2)}</div>
          </div>
          <div class="item-actions">
            ${item.status==="In Stock"?
              `<button class="btn btn-red" style="font-size:16px;padding:12px 24px" onclick="ShopStock.flagItem('${item.id}')">🚨 Flag as Needs Ordered</button>`
              :item.status==="Needs Ordered"?
              `<div style="display:flex;flex-direction:column;gap:8px;width:100%">
                <span class="status s-need" style="font-size:14px;padding:8px 16px;justify-content:center">🔴 Flagged — Needs Ordered</span>
                <button class="btn btn-amber" style="font-size:15px;padding:11px 20px" onclick="ShopStock.updateStatus('${item.id}','Ordered')">📦 Mark as Ordered</button>
              </div>`
              :item.status==="Ordered"?
              `<button class="btn btn-green" style="font-size:16px;padding:12px 24px" onclick="ShopStock.updateStatus('${item.id}','In Stock')">✅ Mark as Issue — Back in Stock</button>`
              :`<button class="btn btn-red" style="font-size:16px;padding:12px 24px" onclick="ShopStock.flagItem('${item.id}')">🚨 Flag as Needs Ordered</button>`
            }
            ${item.supplierLink&&!item.supplierLink.startsWith("email")&&!item.supplierLink.startsWith("EMAIL")?`<a href="${item.supplierLink}" target="_blank" class="btn btn-green" style="text-decoration:none">🛒 Place Order</a>`:item.supplierLink?`<span class="btn btn-gray" style="cursor:default">📧 ${item.supplierLink}</span>`:""}
            <button class="btn btn-gray" onclick="ShopStock.openEditModal('${item.id}')">✏️ Edit</button>
            <button class="btn btn-gray" onclick="ShopStock.showQR('${item.id}')">📱 QR Code</button>
          </div>
        </div>

        <div class="item-grid">
          <div class="info-card">
            <h4>Item Details</h4>
            <div class="info-row"><span class="lbl">Unit</span><span class="val">${item.unit||"—"}</span></div>
            <div class="info-row"><span class="lbl">Supplier</span><span class="val">${item.supplier||"—"}</span></div>
            <div class="info-row"><span class="lbl">Supplier Link</span><span class="val" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">
              ${item.supplierLink&&!item.supplierLink.startsWith("EMAIL")&&!item.supplierLink.startsWith("email")
                ?`<a href="${item.supplierLink}" target="_blank" style="color:var(--accent);word-break:break-all">${item.supplierLink}</a>`
                :item.supplierLink?item.supplierLink:"—"}
            </span></div>
            <div class="info-row"><span class="lbl">Last Ordered</span><span class="val">${item.lastOrdered?new Date(item.lastOrdered).toLocaleDateString():"Never"}</span></div>
            <div class="info-row"><span class="lbl">Times Ordered YTD</span><span class="val">${item.timesOrderedYTD||0}</span></div>
            <div class="info-row"><span class="lbl">Last Scraped</span><span class="val">${item.lastScraped?new Date(item.lastScraped).toLocaleDateString():"Never"}</span></div>
            ${item.notes?`<div class="info-row"><span class="lbl">Notes</span><span class="val">${item.notes}</span></div>`:""}
          </div>
          <div class="info-card">
            <h4>Price History</h4>
            ${ph.length?`<div class="price-history">${ph.map((p,i)=>`
              <div class="ph-row" style="${i===0?"font-weight:600":""}">
                <span>$${p.price.toFixed(2)} — ${p.supplier||"?"}</span>
                <span style="color:var(--faint)">${new Date(p.date).toLocaleDateString()}${p.source==="auto-scraped"?" 🤖":""}</span>
              </div>`).join("")}</div>`:`<div style="color:var(--faint);font-size:13px">No price history yet</div>`}
            <button class="btn btn-gray btn-sm" style="margin-top:12px" onclick="ShopStock.scrapeOne('${item.id}')">🤖 Scrape Price Now</button>
          </div>
        </div>
        <button class="btn btn-gray" onclick="ShopStock.showPage('inventory')">← Back to Inventory</button>
      `;
    }

    async function flagItem(id) {
      try {
        const updated = await api.request(ENDPOINTS.ssItems + "?id=" + id, {
          method: "PUT",
          body: { action: "flag" }
        });
        const idx = allItems.findIndex(i=>i.id===id);
        if(idx>=0) allItems[idx] = updated;
        updateBadge();
        viewItem(id);
        showToast("Flagged as Needs Ordered — manager notified");
      } catch (e) {
        showToast("Failed to flag item", true);
      }
    }

    async function scrapeOne(id) {
      showToast("Scraping price...");
      const data = await api.get(ENDPOINTS.ssScrape, { id }, { headers: { "x-admin-key": adminKey } });
      if(data && data.updated) {
        const idx = allItems.findIndex(i=>i.id===id);
        if(idx>=0) allItems[idx] = data.item;
        viewItem(id);
        showToast(`Price updated to $${data.newPrice.toFixed(2)}`);
      } else {
        showToast(`No update: ${data.reason||"price unchanged"}`, false);
      }
    }

    // ── Add / Edit Modal ──────────────────────────────────────────────────────
    function openAddModal() {
      $id("modal-title").textContent = "Add Item";
      $id("edit-id").value = "";
      ["name","cat","unit","supplier","link","notes"].forEach(f => $id("f-"+f).value = "");
      $id("f-price").value = "";
      updateDeptDropdown();
      updateCatDropdown();
      $id("item-modal").classList.add("open");
    }

    function openEditModal(id) {
      const item = allItems.find(i=>i.id===id);
      if(!item) return;
      $id("modal-title").textContent = "Edit Item";
      $id("edit-id").value = id;
      $id("f-name").value = item.name||"";
      updateDeptDropdown();
      updateCatDropdown();
      $id("f-dept").value = item.department||"";
      $id("f-cat").value = item.category||"";
      $id("f-unit").value = item.unit||"";
      $id("f-supplier").value = item.supplier||"";
      $id("f-price").value = item.currentPrice||"";
      $id("f-link").value = item.supplierLink||"";
      $id("f-notes").value = item.notes||"";
      $id("item-modal").classList.add("open");
    }

    async function saveItem() {
      const id = $id("edit-id").value;
      const body = {
        name: $id("f-name").value.trim(),
        department: $id("f-dept").value,
        category: $id("f-cat").value.trim(),
        unit: $id("f-unit").value.trim(),
        supplier: $id("f-supplier").value.trim(),
        currentPrice: $id("f-price").value,
        supplierLink: $id("f-link").value.trim(),
        notes: $id("f-notes").value.trim(),
      };
      if(!body.name) return showToast("Item name is required", true);

      const url = id ? ENDPOINTS.ssItems + "?id=" + id : ENDPOINTS.ssItems;
      const method = id ? "PUT" : "POST";
      try {
        // The seam returns parsed JSON and throws on a non-2xx, so there is no
        // r.ok to check and no r.json() to await.
        const item = await api.request(url, {
          method,
          body,
          headers: { "x-admin-key": adminKey }
        });
        if(id) { const idx=allItems.findIndex(i=>i.id===id); if(idx>=0) allItems[idx]=item; }
        else { allItems.push(item); }
        closeModal();
        renderInventory(); populateFilters(); updateBadge();
        showToast(id ? "Item updated" : "Item added");
      } catch (err) {
        showToast(err.message || "Save failed — check admin key", true);
      }
    }

    function closeModal(e) {
      if(!e || e.target === $id("item-modal")) {
        $id("item-modal").classList.remove("open");
      }
    }

    // ── QR Code ───────────────────────────────────────────────────────────────
    // TOKEN-EXEMPT: QR codes are generated IMAGES, not styled markup. The
    // library needs a real color value; var(--ink) would render nothing.
    async function showQR(id) {
      await loadQRCode();
      const item = allItems.find(i=>i.id===id);
      if(!item) return;
      const url = `${window.location.origin}/#/shopstock/item/${id}`;
      $id("qr-title").textContent = item.name;
      $id("qr-url").textContent = url;
      $id("qr-code").innerHTML = "";
      new QRCode($id("qr-code"), { text: url, width: 200, height: 200, colorDark: "#000000", colorLight: "#ffffff" });
      $id("qr-modal").classList.add("open");
    }

    function closeQRModal(e) {
      if(!e || e.target === $id("qr-modal")) {
        $id("qr-modal").classList.remove("open");
      }
    }

    // TOKEN-EXEMPT: see showQR — a generated image needs a literal color.
    async function getQRDataUrl(id) {
      await loadQRCode();
      // Generate a fresh QR canvas for any item by id
      const url = `${window.location.origin}/#/shopstock/item/${id}`;
      const div = document.createElement("div");
      div.style.display = "none";
      document.body.appendChild(div);
      new QRCode(div, { text: url, width: 200, height: 200, colorDark: "#000000", colorLight: "#ffffff" });
      const canvas = div.querySelector("canvas");
      const dataUrl = canvas ? canvas.toDataURL() : null;
      document.body.removeChild(div);
      return { dataUrl, url };
    }

    async function buildLabelHTML(item) {
      const { dataUrl, url } = await getQRDataUrl(item.id);
      if(!dataUrl) return "";
      return `<div class="label">
        <div class="dept">${item.department||""}</div>
        <div class="item-name">${item.name}</div>
        <img src="${dataUrl}" class="qr-img"/>
        <div class="scan-text">Scan to update status</div>
      </div>`;
    }

    // TOKEN-EXEMPT: label printing opens a SEPARATE window. That document never
    // loads tokens.css, so var(--x) would resolve to nothing there. Labels are
    // deliberately black on white for thermal printing.
    function printQR() {
      const canvas = $one("#qr-code canvas");
      const title  = $id("qr-title").textContent;
      const url    = $id("qr-url").textContent;
      if(!canvas) return;
      const item = allItems.find(i=>url.includes(i.id));
      const dept = item ? (item.department||"") : "";
      const w = window.open("","_blank");
      w.document.write(`<!DOCTYPE html><html><head>
        <style>
          @page { margin: 4mm; }
          @media print { .no-print { display:none; } }
          * { box-sizing: border-box; }
          body { font-family: Arial, sans-serif; text-align:center; margin:0; padding:12px; background:#fff; color:#000; }
          .label { display:inline-block; border:2px solid #000; border-radius:6px; padding:14px 18px; max-width:260px; width:100%; }
          .dept { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; color:#000; margin-bottom:6px; border-bottom:1px solid #000; padding-bottom:6px; }
          .item-name { font-size:15px; font-weight:700; color:#000; margin:8px 0 10px; line-height:1.3; }
          .qr-img { display:block; margin:0 auto 8px; width:180px; height:180px; }
          .scan-text { font-size:11px; color:#000; }
          .print-btn { margin-top:16px; padding:10px 24px; background:#000; color:#fff; border:none; border-radius:6px; font-size:14px; cursor:pointer; font-weight:600; }
        </style>
      </head><body>
        <div class="label">
          <div class="dept">${dept}</div>
          <div class="item-name">${title}</div>
          <img src="${canvas.toDataURL()}" class="qr-img"/>
          <div class="scan-text">Scan to update status</div>
        </div>
        <br/>
        <button class="print-btn no-print" onclick="window.print();window.close()">Print</button>
      </body></html>`);
      w.document.close();
    }

    // TOKEN-EXEMPT: separate print window; see printQR.
    async function bulkPrintQR() {
      // Get all checked items, or all items if none checked
      const checked = [...$all(".bulk-check:checked")].map(c=>c.dataset.id);
      const items = checked.length > 0
        ? allItems.filter(i=>checked.includes(i.id))
        : allItems;

      if(!items.length) { showToast("No items to print", true); return; }

      // Build all labels. buildLabelHTML is async (it waits on the QR library), so
      // .map yields promises and they must be awaited together before printing.
      const labels = (await Promise.all(items.map(item => buildLabelHTML(item)))).filter(Boolean);

      const w = window.open("","_blank");
      w.document.write(`<!DOCTYPE html><html><head>
        <style>
          @page { margin: 4mm; }
          @media print { .no-print { display:none; } }
          * { box-sizing: border-box; }
          body { font-family: Arial, sans-serif; margin:0; padding:8px; background:#fff; color:#000; }
          .grid { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-start; }
          .label { border:2px solid #000; border-radius:6px; padding:10px 12px; width:200px; text-align:center; page-break-inside:avoid; }
          .dept { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:1px; border-bottom:1px solid #000; padding-bottom:4px; margin-bottom:4px; }
          .item-name { font-size:12px; font-weight:700; margin:4px 0 6px; line-height:1.2; min-height:30px; display:flex; align-items:center; justify-content:center; }
          .qr-img { display:block; margin:0 auto 4px; width:150px; height:150px; }
          .scan-text { font-size:9px; }
          .controls { padding:12px; display:flex; gap:10px; align-items:center; }
          .print-btn { padding:10px 24px; background:#000; color:#fff; border:none; border-radius:6px; font-size:14px; cursor:pointer; font-weight:600; }
          .count { font-size:13px; color:#666; }
        </style>
      </head><body>
        <div class="controls no-print">
          <button class="print-btn" onclick="window.print()">Print All ${items.length} Labels</button>
          <span class="count">${items.length} QR codes ready</span>
        </div>
        <div class="grid">${labels.join("")}</div>
      </body></html>`);
      w.document.close();
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    function initAdmin() {
      $id("admin-key-input").value = adminKey;
      $id("admin-status").textContent = adminKey ? "✅ Admin key saved" : "";
      renderDeptList();
      renderCatList();
    }

    function renderDeptList() {
      const colors = getDeptColors();
      const el = $id("dept-list");
      if(!el) return;
      // Include departments from actual items too
      const allDepts = [...new Set([...Object.keys(colors), ...allItems.map(i=>i.department).filter(Boolean)])].sort();
      el.innerHTML = allDepts.map(d => {
        const hex = colors[d] || "var(--faint)";
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line-soft)">
          <input type="color" value="${hex}" onchange="ShopStock.updateDeptColor('${d}',this.value)"
            style="width:32px;height:28px;border:1px solid var(--line);border-radius:5px;cursor:pointer;padding:1px"/>
          <span style="flex:1;font-size:13px;font-weight:500">${d}</span>
          <span style="font-size:11px;color:var(--faint)">${allItems.filter(i=>i.department===d).length} items</span>
          <button class="btn btn-gray btn-sm" onclick="ShopStock.removeDept('${d}')" style="padding:2px 8px;font-size:11px">✕</button>
        </div>`;
      }).join("");
    }

    function renderCatList() {
      const cats = getCategories();
      const el = $id("cat-list");
      if(!el) return;
      // Include categories from actual items too
      const allCats = [...new Set([...cats, ...allItems.map(i=>i.category).filter(Boolean)])].sort();
      el.innerHTML = allCats.map(c => `
        <div style="display:inline-flex;align-items:center;gap:4px;background:var(--line-soft);border-radius:99px;padding:3px 10px;font-size:12px;font-weight:500">
          ${c}
          <button onclick="ShopStock.removeCat('${c}')" style="background:none;border:none;cursor:pointer;color:var(--faint);font-size:14px;line-height:1;padding:0 0 0 2px">×</button>
        </div>`).join("");
    }

    function addDepartment() {
      const name = $id("new-dept-name").value.trim();
      const color = $id("new-dept-color").value;
      if(!name) return;
      const colors = getDeptColors();
      colors[name] = color;
      _deptColors = colors; saveSettings();
      $id("new-dept-name").value = "";
      renderDeptList();
      // Update dept dropdowns in add/edit modal
      updateDeptDropdown();
      showToast(`Department "${name}" added`);
    }

    function updateDeptColor(dept, hex) {
      const colors = getDeptColors();
      colors[dept] = hex;
      _deptColors = colors; saveSettings();
      renderInventory();
      renderFullInventory();
    }

    function removeDept(dept) {
      if(!confirm(`Remove department "${dept}"? Items in this department will not be deleted.`)) return;
      const colors = getDeptColors();
      delete colors[dept];
      _deptColors = colors; saveSettings();
      renderDeptList();
    }

    function addCategory() {
      const name = $id("new-cat-name").value.trim();
      if(!name) return;
      const cats = getCategories();
      if(!cats.includes(name)) { cats.push(name); _categories = cats; saveSettings(); }
      $id("new-cat-name").value = "";
      renderCatList();
      updateCatDropdown();
      showToast(`Category "${name}" added`);
    }

    function removeCat(cat) {
      const cats = getCategories().filter(c=>c!==cat);
      _categories = cats; saveSettings();
      renderCatList();
    }

    function updateDeptDropdown() {
      const colors = getDeptColors();
      const allDepts = [...new Set([...Object.keys(colors), ...allItems.map(i=>i.department).filter(Boolean)])].sort();
      const sel = $id("f-dept");
      if(sel) sel.innerHTML = allDepts.map(d=>`<option>${d}</option>`).join("");
    }

    function updateCatDropdown() {
      const cats = [...new Set([...getCategories(), ...allItems.map(i=>i.category).filter(Boolean)])].sort();
      const sel = $id("f-cat-select");
      if(sel) sel.innerHTML = `<option value="">Select or type below</option>` + cats.map(c=>`<option>${c}</option>`).join("");
    }

    function saveAdminKey() {
      adminKey = $id("admin-key-input").value;
      localStorage.setItem("shopstock.admin_key", adminKey);
      $id("admin-status").textContent = adminKey ? "✅ Admin key saved" : "";
    }

    async function runScrape() {
      $id("scrape-status").textContent = "Running... this may take a minute";
      const data = await api.get(ENDPOINTS.ssScrape, null, { headers: { "x-admin-key": adminKey } });
      if(data.ok) {
        $id("scrape-status").textContent = `Done — ${data.updated} prices updated, ${data.failed} failed. ${new Date().toLocaleTimeString()}`;
        await loadItems();
      } else {
        $id("scrape-status").textContent = `Error: ${data.error}`;
      }
    }

    async function importCSV(input) {
      const file = input.files[0];
      if(!file) { showToast("Please select a CSV file first", true); return; }
      if(!adminKey) { showToast("Please save your admin key first", true); return; }

      const statusEl = $id("import-status");
      statusEl.textContent = "Reading file...";

      const text = await file.text();
      // Handle both Windows (\r\n) and Unix (\n) line endings
      const lines = text.replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n").filter(l=>l.trim());
      if(lines.length < 2) { statusEl.textContent = "CSV appears empty"; return; }

      // Parse header using same RFC 4180 parser
      const headers = parseCSVLine(lines[0]).map(h=>h.toLowerCase().trim());
      statusEl.textContent = `Found ${lines.length-1} rows, importing...`;

      // Proper RFC 4180 CSV parser
      function parseCSVLine(line) {
        const vals = []; let cur = "", inQ = false, i = 0;
        while(i < line.length) {
          const ch = line[i];
          if(ch === '"') {
            if(inQ && line[i+1] === '"') { cur += '"'; i++; } // escaped quote
            else { inQ = !inQ; }
          } else if(ch === ',' && !inQ) {
            vals.push(cur); cur = "";
          } else {
            cur += ch;
          }
          i++;
        }
        vals.push(cur);
        return vals.map(v => v.trim());
      }

      let imported = 0, failed = 0, skipped = 0;
      for(let i=1;i<lines.length;i++) {
        const vals = parseCSVLine(lines[i]);
        const obj = {};
        headers.forEach((h,j)=>obj[h]=(vals[j]||""));
        if(!obj.name) { skipped++; continue; }

        try {
          const item = await api.request(ENDPOINTS.ssItems, {
            method:"POST",
            headers:{"x-admin-key":adminKey},
            body:obj
          });
          imported++;
          allItems.push(item);
          statusEl.textContent = `Importing... ${imported} done`;
        } catch(e){
          console.error("Error row", i, e);
          failed++;
        }
        await new Promise(r=>setTimeout(r,150));
      }

      statusEl.textContent = `Done — ${imported} imported, ${failed} failed, ${skipped} skipped`;
      showToast(`Imported ${imported} items`);
      renderInventory(); populateFilters(); updateBadge();
    }

    function exportCSV() {
      const headers = ["name","department","category","supplier","supplierLink","unit","currentPrice","status","lastOrdered","timesOrderedYTD","notes"];
      const rows = allItems.map(i=>headers.map(h=>`"${(i[h]||"").toString().replace(/"/g,'""')}"`).join(","));
      const csv = [headers.join(","), ...rows].join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv"}));
      a.download = "supply-deck-export.csv";
      a.click();
    }

    // ── Toast ─────────────────────────────────────────────────────────────────
    function showToast(msg, error=false) {
      const t = $id("toast");
      t.textContent = msg;
      t.style.background = error ? "var(--danger)" : "var(--ink)";
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), 3000);
    }


    // ---- namespaced globals for the inline handlers (see note at top) ----
    window.ShopStock = {
      addCategory,
      addDepartment,
      bulkPrintQR,
      bulkStatusChange,
      closeModal,
      closeQRModal,
      exportCSV,
      flagItem,
      importCSV,
      openAddModal,
      openEditModal,
      printQR,
      removeCat,
      removeDept,
      renderFullInventory,
      runScrape,
      saveAdminKey,
      saveItem,
      scrapeOne,
      showPage,
      showQR,
      toggleAllChecks,
      toggleDept,
      updateBulkCount,
      updateDeptColor,
      updateStatus,
      viewItem,
    };

    // Init runs AFTER window.ShopStock exists: the markup contains inline
    // handlers, and one firing before the namespace was set would silently fail.
    const route = getPage();
    if (route.page === "item" && route.id) {
      // QR scan destination: load items, then open that item.
      showPage("item");
      await loadItems();
      const item = allItems.find(i => i.id === route.id);
      if (item) viewItem(route.id);
      else $id("item-detail").innerHTML =
        `<div class="flag-wrap"><div class="flag-icon">?</div>` +
        `<div class="flag-title">Item not found</div>` +
        `<div class="flag-sub">This QR code may be outdated.</div></div>`;
    } else {
      showPage(route.page);
      await loadItems();
    }
  },

  showView(view) {
    // The rail drives navigation now, but the app's own showPage() still owns
    // what each page does on entry (rendering, admin init), so route through it
    // rather than duplicating that logic here.
    if (window.ShopStock && window.ShopStock.showPage) {
      window.ShopStock.showPage(view);
    }
  },

  unmount() {
    // Drop the namespace so a remount does not leave a stale one behind.
    delete window.ShopStock;
  }
};
