/**
 * GivingGauge — donation and sponsorship scoring.
 *
 * PORTED from the standalone app. What changed and why:
 *
 *   - The header came off. The shell has one, and the rail carries the nav.
 *   - :root and the global reset came off. tokens.css and shell.css own those,
 *     which is what lets data-app re-theme this app for free.
 *   - document.getElementById became a root-scoped lookup. Several apps are
 *     mounted at once, so a document-wide search could find another app's node.
 *   - The click listener moved from document to the app root, so a click in
 *     BackBone can't reach this handler.
 *   - REQUESTS (six hardcoded records) became ctx.api. The records now live in
 *     api.js as mock data, so flipping MOCK=false hits the real endpoint with
 *     no change here.
 *
 * The SCORE IS NEVER COMPUTED HERE. Every number comes from the verbatim engine
 * via js/giving-engine.js. This layer only decides what to show. If a number
 * looks wrong, the bug is in the engine or the request data, not in this file.
 */

import { loadEngine } from '../js/giving-engine.js';
import { loadDial } from '../js/giving-dial.js';
import { ENDPOINTS } from '../js/api.js';

export default {
  id: 'givinggauge',

  styles: `
  /* ---------- page ---------- */
  .page{padding:24px 32px 60px;max-width:1720px}
  .page-hd{
    display:flex;justify-content:space-between;align-items:center;
    margin-bottom:20px;flex-wrap:wrap;gap:12px;
  }
  .page-hd h1{font-size:28px;font-weight:800;letter-spacing:-.02em}
  .page-hd .sub{font-size:13px;color:var(--muted);margin-top:2px}

  /* ---------- filters ---------- */
  .filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
  .filt{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:7px 14px;font-size:13px;font-weight:600;color:var(--muted);
    cursor:pointer;font-family:inherit;transition:.12s;
  }
  .filt:hover{color:var(--ink)}
  .filt[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
  .filt:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .filt .n{opacity:.6;margin-left:6px;font-weight:700}
  .filt[aria-pressed="true"] .n{opacity:.85}

  /* ---------- queue ---------- */
  .queue{
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(300px,1fr));
    gap:16px;
    align-items:stretch;
  }
  .req{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);
    padding:20px 20px 18px;display:flex;flex-direction:column;align-items:center;
    text-align:center;cursor:pointer;width:100%;height:100%;
    font-family:inherit;color:inherit;transition:border-color .12s,box-shadow .12s;
  }
  .req:hover{border-color:var(--faint);box-shadow:var(--shadow-card)}
  .req:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .req .dial{width:168px;display:block;margin-bottom:4px}
  .req h3{
    font-size:16px;font-weight:700;letter-spacing:-.01em;line-height:1.3;
    margin-bottom:5px;
  }
  .req .line{font-size:12.5px;color:var(--muted);line-height:1.55;display:block}
  .req .tags{
    display:flex;gap:6px;flex-wrap:wrap;justify-content:center;
    margin-top:12px;
  }
  /* pushes the verdict to the bottom so pills line up across the row */
  .req .spacer{flex:1 1 auto;min-height:14px}

  .chip{
    display:inline-flex;align-items:center;padding:2px 8px;border-radius:99px;
    font-size:11px;font-weight:600;background:var(--line-soft);color:var(--ink);
  }
  .chip.red{background:var(--danger-tint);color:var(--danger)}
  .chip.gold{background:var(--accent-tint);color:var(--accent-deep)}
  .chip.green{background:var(--success-tint);color:var(--success)}

  .verdict{
    font-size:12.5px;font-weight:700;padding:8px 16px;border-radius:99px;
    white-space:nowrap;display:inline-block;
  }
  .verdict.green{background:var(--success-tint);color:var(--success)}
  .verdict.gold{background:var(--accent-tint);color:var(--accent-deep)}
  .verdict.red{background:var(--danger-tint);color:var(--danger)}

  .status-dot{
    display:inline-block;width:6px;height:6px;border-radius:99px;
    background:var(--accent);margin-right:6px;vertical-align:middle;
  }
  .status-dot.done{background:var(--success)}
  .status-dot.declined{background:var(--danger)}

  .empty{
    grid-column:1/-1;
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);
    padding:48px 24px;text-align:center;
  }
  .empty h3{font-size:15px;font-weight:700;margin-bottom:5px}
  .empty p{font-size:13px;color:var(--muted)}

  /* ---------- detail panel ---------- */
  .scrim{
    position:fixed;inset:0;background:rgba(28,36,48,.32);
    opacity:0;pointer-events:none;transition:opacity .18s;z-index:110;
  }
  .scrim.open{opacity:1;pointer-events:auto}
  .panel{
    position:fixed;top:0;right:0;bottom:0;width:min(560px,100%);
    background:var(--bg);z-index:120;overflow-y:auto;
    transform:translateX(100%);transition:transform .22s cubic-bezier(.4,0,.2,1);
    box-shadow:-14px 0 40px rgba(16,24,40,.13);
  }
  .panel.open{transform:none}
  .panel-in{padding:20px 24px 40px}
  .panel-top{
    display:flex;align-items:flex-start;justify-content:space-between;
    gap:14px;padding-bottom:16px;
  }
  .panel-top h2{font-size:22px;font-weight:800;letter-spacing:-.02em;line-height:1.2}
  .panel-top .sub{font-size:12.5px;color:var(--muted);margin-top:3px}
  .x{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);
    width:32px;height:32px;flex:0 0 32px;cursor:pointer;font-size:16px;
    color:var(--muted);font-family:inherit;line-height:1;
  }
  .x:hover{color:var(--ink)}
  .x:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

  .card{
    background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-md);padding:18px 20px;margin-bottom:12px;
  }
  .card.hero{display:flex;align-items:center;gap:18px}
  .card.hero .dial{flex:0 0 132px}
  .card.hero .read{flex:1 1 auto;min-width:0}
  .card.hero .rec{font-size:17px;font-weight:800;letter-spacing:-.01em;line-height:1.3;margin-bottom:5px}
  .card.hero .read p{font-size:12.5px;color:var(--muted);line-height:1.55}

  .card-hd{
    font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
    color:var(--muted);margin-bottom:12px;
  }
  .card-hd.red{color:var(--danger)}

  .facts li{
    list-style:none;display:flex;gap:12px;font-size:13px;
    padding:8px 0;border-bottom:1px solid var(--line-soft);line-height:1.45;
  }
  .facts li:last-child{border-bottom:none;padding-bottom:0}
  .facts b{
    flex:0 0 96px;color:var(--muted);font-weight:600;font-size:11px;
    letter-spacing:.05em;text-transform:uppercase;padding-top:2px;
  }
  .facts .flag{color:var(--danger);font-weight:600}

  .dim{padding:10px 0;border-bottom:1px solid var(--line-soft)}
  .dim:last-of-type{border-bottom:none}
  .dim .r1{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
  .dim .nm{font-size:13.5px;font-weight:700}
  .dim .pt{font-size:13px;font-weight:800;white-space:nowrap}
  .dim .pt em{font-style:normal;color:var(--muted);font-weight:600;font-size:11.5px}
  .dim .why{font-size:12px;color:var(--muted);margin-top:3px;line-height:1.5}
  .dim .meter{height:4px;background:var(--line);border-radius:99px;margin-top:8px;overflow:hidden}
  .dim .meter i{display:block;height:100%;border-radius:99px;background:var(--accent)}

  .totals{
    display:flex;align-items:baseline;justify-content:space-between;
    padding-top:12px;margin-top:8px;border-top:1.5px solid var(--ink);
  }
  .totals .k{font-size:12.5px;font-weight:700}
  .totals .v{font-size:18px;font-weight:800}
  .totals .v em{font-style:normal;color:var(--muted);font-size:12px;font-weight:600}
  .mod{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;color:var(--muted);padding-top:10px}
  .mod b{font-weight:700;color:var(--ink)}

  .flag-item{padding:10px 0;border-bottom:1px solid var(--line-soft)}
  .flag-item:last-child{border-bottom:none;padding-bottom:0}
  .flag-item .ft{font-size:13px;font-weight:700;display:flex;align-items:center;gap:8px}
  .flag-item .fd{font-size:12px;color:var(--muted);margin-top:3px;line-height:1.5}
  .sev{width:7px;height:7px;border-radius:99px;flex:0 0 7px}
  .sev.red{background:var(--danger)}
  .sev.amber{background:var(--accent)}
  .sev.green{background:var(--success)}

  .card.dq{background:var(--danger-tint);border-color:var(--danger-line)}
  .card.dq .ft{color:var(--danger)}
  .card.dq .fd{color:var(--danger-dk)}
  .card.dq .flag-item{border-bottom-color:var(--danger-line)}

  /* ---------- account matching ---------- */
  .match-wrap{margin-top:14px;padding-top:14px;border-top:1px solid var(--line-soft)}
  .match-btn{
    background:var(--accent);border:none;color:var(--on-accent);font-family:inherit;
    font-size:12.5px;font-weight:700;padding:8px 14px;border-radius:var(--radius-sm);cursor:pointer;
  }
  .match-btn:hover{background:var(--accent-deep)}
  .match-btn:disabled{opacity:.6;cursor:default}
  .match-hint{display:block;font-size:11.5px;color:var(--muted);margin-top:6px;line-height:1.5}
  .match-results{margin-top:10px}
  .match-row{
    display:flex;align-items:center;justify-content:space-between;gap:10px;
    padding:9px 11px;border:1px solid var(--line);border-radius:var(--radius-sm);
    margin-bottom:6px;cursor:pointer;background:var(--card);
  }
  .match-row:hover{border-color:var(--accent)}
  .match-row .nm{font-size:13px;font-weight:700}
  .match-row .meta{font-size:11.5px;color:var(--muted);margin-top:1px}
  .match-row .conf{
    font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:var(--radius-pill);
    background:var(--line-soft);color:var(--muted);white-space:nowrap;
  }
  .match-row .conf.high{background:var(--success-tint);color:var(--success-dk)}
  .match-row .conf.medium{background:var(--amber-tint);color:var(--amber)}
  .match-done{
    margin-top:14px;padding-top:14px;border-top:1px solid var(--line-soft);
    font-size:12.5px;color:var(--muted);
  }
  .match-done b{color:var(--ink)}
  .match-clear{
    background:none;border:none;color:var(--accent-deep);font-family:inherit;
    font-size:12px;font-weight:600;cursor:pointer;text-decoration:underline;padding:0;margin-left:6px;
  }

  /* ---------- classify ---------- */
  .cls-intro{font-size:12.5px;color:var(--muted);line-height:1.55;margin-bottom:14px}
  .cls-row{display:block;margin-bottom:12px}
  .cls-row:last-child{margin-bottom:0}
  .cls-lbl{
    display:block;font-size:11px;font-weight:700;letter-spacing:.05em;
    text-transform:uppercase;color:var(--muted);margin-bottom:5px;
  }
  .cls-sel{
    width:100%;border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:9px 11px;font-family:inherit;font-size:13px;color:var(--ink);
    background:var(--card);cursor:pointer;
  }
  .cls-sel:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-tint)}
  .cls-note{display:block;font-size:11.5px;color:var(--faint);margin-top:4px;line-height:1.5}

  /* ---------- toolbar ---------- */
  .tools{display:flex;gap:8px;align-items:center}
  .tool-btn{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:8px 14px;font-size:13px;font-weight:600;color:var(--ink);
    cursor:pointer;font-family:inherit;
  }
  .tool-btn:hover{border-color:var(--muted)}
  .tool-btn:disabled{opacity:.6;cursor:default}
  .tool-msg{font-size:12.5px;color:var(--muted)}

  /* ---------- decision ---------- */
  .decide{position:sticky;bottom:0;background:var(--bg);padding:12px 0 0}
  .btns{display:flex;gap:8px}
  .btn{
    border:none;padding:11px 16px;border-radius:var(--radius-sm);cursor:pointer;
    font-size:13px;font-weight:700;font-family:inherit;flex:1 1 0;
    transition:background .12s,transform .04s;
  }
  .btn:active{transform:translateY(.5px)}
  .btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .btn-green{background:var(--success);color:var(--on-accent)}
  .btn-green:hover{background:var(--success-dk)}
  .btn-red{background:var(--on-accent);color:var(--danger);border:1px solid var(--danger-line)}
  .btn-red:hover{background:var(--danger-tint)}

  .logged{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:12px 14px;font-size:12.5px;color:var(--muted);line-height:1.55;
  }
  .logged b{font-weight:700;color:var(--ink)}
  .logged .ov{color:var(--accent-deep);font-weight:700}
  .undo{
    background:none;border:none;color:var(--muted);font-family:inherit;
    font-size:12px;font-weight:600;cursor:pointer;text-decoration:underline;
    padding:0;margin-top:6px;
  }
  .undo:hover{color:var(--ink)}

  @media (max-width:820px){
    .page{padding:20px 16px 60px}
    .queue{grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
    .req{padding:18px 16px 16px}
    .req .dial{width:150px}
    .card.hero{flex-direction:column;align-items:stretch;text-align:center}
    .card.hero .dial{flex:none;margin:0 auto}
  }
  @media (prefers-reduced-motion:reduce){
    *{transition:none!important;animation:none!important}
  }
  `,

  template: `
    <div class="page">
      <div class="page-hd">
        <div>
          <h1>Requests.</h1>
          <div class="sub" id="queueMeta"></div>
        </div>
        <div class="tools">
          <span class="tool-msg" id="importMsg"></span>
          <button class="tool-btn" id="importBtn">Import from Jotform</button>
        </div>
      </div>
      <div class="filters" id="filters"></div>
      <div class="queue" id="queue"></div>
    </div>

    <div class="scrim" id="scrim"></div>
    <aside class="panel" id="panel" aria-label="Request detail" tabindex="-1">
      <div class="panel-in" id="panelIn"></div>
    </aside>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);

    // The engine is a verbatim CommonJS port, so it loads as a classic script
    // and re-exports its global. Both resolve before the first render.
    const engine = await loadEngine();
    const dial = await loadDial();

    // Requests come through the seam. Under MOCK these are the same six records
    // the standalone app had inline; with MOCK off they come from the endpoint.
    const payload = await ctx.api.get(ENDPOINTS.ggRequests);
    ctx.data = Array.isArray(payload) ? payload : ((payload && payload.requests) || []);

    let onKeydown;


  

    var TODAY = '2026-07-21';

    var DIM_LABEL = {
      relationship: 'Customer relationship',
      spend: 'Spend weight',
      cadence: 'Order health',
      region: 'Region',
      mission: 'Mission fit',
      exposure: 'Brand exposure',
      revenueAttach: 'Revenue attach'
    };

    var state = {
      filter: 'pending',
      openId: null,
      // decisions made in-session, keyed by request id
      decisions: {},
      // requests explicitly reopened, so they don't fall back to meta.status
      reopened: {}
    };

    /* ---------------- data ---------------- */

    function evaluated() {
      return (ctx.data || []).map(function (r) {
        return {
          meta: r,
          result: engine.evaluate(r.request, r.account, { today: TODAY })
        };
      });
    }

    function statusOf(row) {
      var d = state.decisions[row.meta.id];
      if (d) return d.status;
      if (state.reopened[row.meta.id]) return 'pending';
      return row.meta.status;
    }

    function decisionOf(row) {
      var d = state.decisions[row.meta.id];
      if (d) return d;
      if (state.reopened[row.meta.id]) return null;
      if (row.meta.status === 'pending') return null;
      return {
        status: row.meta.status,
        by: row.meta.decidedBy,
        note: row.meta.note,
        override: !!row.meta.override
      };
    }

    /** Did the human land somewhere the engine did not recommend? */
    function isOverride(result, status) {
      if (status === 'pending') return false;
      var engineSaysApprove = result.decision.indexOf('Approve') === 0;
      if (status === 'approved' && !engineSaysApprove) return true;
      if (status === 'declined' && engineSaysApprove) return true;
      return false;
    }

    /* ---------------- small helpers ---------------- */

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function money(n) {
      return '$' + Number(n || 0).toLocaleString();
    }

    function daysLabel(n) {
      if (n == null) return 'No date';
      if (n < 0) return 'Past';
      return n + ' day' + (n === 1 ? '' : 's');
    }

    /* ---------------- queue ---------------- */

    function renderFilters(rows) {
      var counts = { pending: 0, approved: 0, declined: 0 };
      rows.forEach(function (r) { counts[statusOf(r)]++; });

      var defs = [
        ['pending', 'Needs a decision', counts.pending],
        ['approved', 'Approved', counts.approved],
        ['declined', 'Declined', counts.declined],
        ['all', 'All', rows.length]
      ];

      $('#filters').innerHTML = defs.map(function (d) {
        return '<button class="filt" data-filter="' + d[0] + '" aria-pressed="' +
          (state.filter === d[0]) + '">' + esc(d[1]) +
          '<span class="n">' + d[2] + '</span></button>';
      }).join('');

      var pend = counts.pending;
      $('#queueMeta').textContent =
        pend === 0
          ? 'Queue clear. Nothing waiting on a decision.'
          : pend + ' waiting on a decision';

      var nc = $('#navCount');
      if (nc) {
        nc.textContent = pend;
        nc.style.display = pend === 0 ? 'none' : '';
      }
    }

    function requestCard(row) {
      var r = row.result;
      var q = row.meta.request;
      var status = statusOf(row);
      var dec = decisionOf(row);

      var tags = [];
      if (r.disqualified) {
        tags.push(['red', r.disqualifiers[0].label]);
      } else {
        if (r.daysOut != null && r.daysOut < 35) tags.push(['gold', daysLabel(r.daysOut) + ' out']);
        var red = r.flags.filter(function (f) { return f.severity === 'red'; });
        if (red.length) tags.push(['red', red[0].label]);
        var lead = r.flags.filter(function (f) { return f.code === 'LEAD_NOT_HANDOUT'; });
        if (lead.length) tags.push(['green', 'Lead, not a handout']);
      }
      if (!row.meta.account.found) tags.push(['', 'Not a customer']);
      else tags.push(['', row.meta.account.tier]);

      // Anything the intake could not determine. Until these are answered the
      // score is a FLOOR, not a verdict: an unmatched account scores 0 of the
      // 55 relationship-and-spend points, and an unclassified mission defaults
      // to general civic. Saying so on the card stops a provisional F reading
      // as a decision.
      var review = row.meta.needsReview || [];
      if (review.length) tags.push(['gold', 'Needs review (' + review.length + ')']);

      var dotClass = status === 'approved' ? 'done' : status === 'declined' ? 'declined' : '';
      var verdictText = status === 'pending'
        ? r.decision
        : (status === 'approved' ? 'Approved' : 'Declined');
      var verdictTone = status === 'pending'
        ? r.gaugeColor
        : (status === 'approved' ? 'green' : 'red');

      var ovr = dec && (dec.override || isOverride(r, status));

      return '' +
        '<button class="req" data-id="' + row.meta.id + '">' +
          '<span class="dial">' + dial.renderGauge(r, { size: 168 }) + '</span>' +
          '<h3>' + esc(q.orgName) + '</h3>' +
          '<span class="line">' +
            '<span class="status-dot ' + dotClass + '"></span>' +
            esc(q.eventName || 'Request') + '<br>' +
            esc(q.city) + ' &middot; ' + daysLabel(r.daysOut) + ' out' +
            (ovr ? ' &middot; owner override' : '') +
          '</span>' +
          '<span class="tags">' +
            tags.map(function (t) {
              return '<span class="chip ' + t[0] + '">' + esc(t[1]) + '</span>';
            }).join('') +
          '</span>' +
          '<span class="spacer"></span>' +
          '<span class="verdict ' + verdictTone + '">' + esc(verdictText) + '</span>' +
        '</button>';
    }

    function renderQueue() {
      var rows = evaluated();
      renderFilters(rows);

      var shown = rows.filter(function (r) {
        return state.filter === 'all' || statusOf(r) === state.filter;
      });

      var el = $('#queue');
      if (!shown.length) {
        el.innerHTML =
          '<div class="empty"><h3>Nothing here</h3>' +
          '<p>New requests land in this queue when the form is submitted.</p></div>';
        return;
      }
      el.innerHTML = shown.map(requestCard).join('');
    }

    /* ---------------- detail panel ---------------- */

    function scorecard(r) {
      if (r.disqualified) return '';

      var rows = Object.keys(r.dimensions).map(function (k) {
        var d = r.dimensions[k];
        var pct = d.max ? Math.round((d.points / d.max) * 100) : 0;
        return '' +
          '<div class="dim">' +
            '<div class="r1">' +
              '<span class="nm">' + esc(DIM_LABEL[k]) + '</span>' +
              '<span class="pt">' + d.points + '<em>/' + d.max + '</em></span>' +
            '</div>' +
            '<div class="why">' + esc(d.reason) + '</div>' +
            '<div class="meter"><i style="width:' + pct + '%"></i></div>' +
          '</div>';
      }).join('');

      var mod = r.modifier;
      var modLine = '' +
        '<div class="mod"><span>Ask size &middot; ' + esc(mod.reason) + '</span>' +
        '<b>' + (mod.modifier === 0 ? '0' : mod.modifier) + '</b></div>';

      return '' +
        '<div class="card">' +
          '<div class="card-hd">Scorecard</div>' +
          rows +
          modLine +
          '<div class="totals"><span class="k">Total</span>' +
          '<span class="v">' + r.total + '<em>/100</em></span></div>' +
        '</div>';
    }

    function flagCards(r) {
      var out = '';

      if (r.disqualifiers.length) {
        out += '<div class="card dq"><div class="card-hd red">Automatic decline</div>' +
          r.disqualifiers.map(function (d) {
            return '<div class="flag-item"><div class="ft"><span class="sev red"></span>' +
              esc(d.label) + '</div><div class="fd">' + esc(d.detail) + '</div></div>';
          }).join('') + '</div>';
      }

      if (r.reviewNotes && r.reviewNotes.length) {
        out += '<div class="card"><div class="card-hd">Owner review</div>' +
          r.reviewNotes.map(function (d) {
            return '<div class="flag-item"><div class="ft"><span class="sev amber"></span>' +
              esc(d.label) + '</div><div class="fd">' + esc(d.detail) + '</div></div>';
          }).join('') + '</div>';
      }

      var fl = (r.flags || []).filter(function (f) {
        return !r.disqualifiers.some(function (d) { return d.code === f.code; });
      });
      if (fl.length) {
        out += '<div class="card"><div class="card-hd">What the score can\'t see</div>' +
          fl.map(function (f) {
            return '<div class="flag-item"><div class="ft"><span class="sev ' +
              (f.severity || 'amber') + '"></span>' + esc(f.label) + '</div>' +
              '<div class="fd">' + esc(f.detail) + '</div></div>';
          }).join('') + '</div>';
      }

      return out;
    }

    /** What the intake could not determine, and what it costs the score. */
    function reviewCard(row) {
      var review = row.meta.needsReview || [];
      if (!review.length) return '';

      var unmatched = !row.meta.account.found;
      var lead = unmatched
        ? 'This score is a floor. The account is not matched, so relationship ' +
          'and spend score zero out of 46.'
        : 'Some details could not be read from the submission.';

      return '' +
        '<div class="card">' +
          '<div class="card-hd">Needs a human</div>' +
          '<p style="font-size:12.5px;color:var(--muted);line-height:1.55;margin-bottom:12px">' +
            esc(lead) + '</p>' +
          review.map(function (n) {
            return '<div class="flag-item">' +
              '<div class="ft"><span class="sev amber"></span>' + esc(n.field) + '</div>' +
              '<div class="fd">' + esc(n.why) + '</div></div>';
          }).join('') +
        '</div>';
    }

    function accountCard(row) {
      var a = row.meta.account;
      var r = row.result;
      var sr = r.selfReport;

      var body;
      if (!a.found) {
        body = '<ul class="facts">' +
          '<li><b>Status</b><span class="flag">No record in Apparelytics. Not a current client.</span></li>' +
          '<li><b>They said</b><span>' + esc(sr.claim || 'Not answered') + '</span></li>' +
          '<li><b>Contact</b><span>' + esc(row.meta.request.contactName) + ' &middot; ' +
            esc(row.meta.request.email) + '</span></li>' +
          '</ul>';
      } else {
        body = '<ul class="facts">' +
          '<li><b>Status</b><span>' + esc(a.tier) + ' &middot; score ' + a.score +
            ' &middot; ' + esc(a.matchConfidence) + '</span></li>' +
          '<li><b>They said</b><span>' + esc(sr.claim || 'Not answered') + ' &mdash; ' + esc(sr.verdict) + '</span></li>' +
          '<li><b>Lifetime</b><span>' + money(a.lifetimeRevenue) + ' across ' + a.orderCount + ' orders</span></li>' +
          '<li><b>Cadence</b><span>' + a.medianGapDays + '-day median &middot; ' +
            a.daysSinceLastOrder + ' days since last order</span></li>' +
          '<li><b>Rep</b><span>' + esc(a.owner || 'Unassigned') + '</span></li>' +
          '</ul>';
      }

      // Matching is where 46 of the 100 points come from. Until it happens the
      // score is a floor, so the control lives right where the gap is visible.
      var matchUI = a.found
        ? '<div class="match-done">Matched to <b>' + esc(a.name || '') + '</b>' +
            (a.matchConfidence ? ' (' + esc(a.matchConfidence) + ' confidence)' : '') +
            ' <button class="match-clear" data-unmatch="' + esc(row.meta.id) + '">Change</button></div>'
        : '<div class="match-wrap">' +
            '<button class="match-btn" data-match="' + esc(row.meta.id) + '">Find this account</button>' +
            '<span class="match-hint">Relationship and spend score 0 of 46 until matched.</span>' +
            '<div class="match-results" data-results="' + esc(row.meta.id) + '"></div>' +
          '</div>';

      return '<div class="card"><div class="card-hd">The account</div>' + body + matchUI + '</div>';
    }

    function eventCard(row) {
      var q = row.meta.request;
      var r = row.result;
      return '' +
        '<div class="card">' +
          '<div class="card-hd">The request</div>' +
          '<p style="font-size:13px;line-height:1.6;margin-bottom:14px">' +
            esc(q.description || '') + '</p>' +
          '<ul class="facts">' +
            '<li><b>The ask</b><span>' +
              (q.pieceCount == null
                ? '<span class="flag">No piece count given</span>'
                : q.pieceCount + ' pieces') +
              ' &middot; ' + esc(q.merchandise || '') + '</span></li>' +
            '<li><b>Buying too</b><span>' +
              (q.purchaseIntent === 'specific' ? 'Yes, specific'
                : q.purchaseIntent === 'vague' ? 'Yes, unspecified'
                : q.purchaseIntent === 'no' ? 'No'
                : '<span class="flag">Not answered</span>') + '</span></li>' +
            '<li><b>Event</b><span>' + esc(q.eventDate) + ' &middot; ' +
              daysLabel(r.daysOut) + ' out</span></li>' +
            '<li><b>Draw</b><span>' + (q.attendance ? q.attendance.toLocaleString() : 'Not given') +
              ' &middot; ' + (q.yearsActive ? q.yearsActive + ' years running' : 'First year') + '</span></li>' +
            '<li><b>Tax status</b><span>' + esc(q.taxStatus === 'exempt' ? 'Exempt' : 'Business') + '</span></li>' +
          '</ul>' +
        '</div>';
    }

    /* ---------------- classification ---------------- */

    // The engine's own vocabulary. These strings must match MISSION_POINTS in
    // vendor/scoring-engine.cjs exactly, or the score silently defaults.
    var MISSION_OPTIONS = [
      ['core',        'Core priority — children, mental health, foster/adoption', 18],
      ['adjacent',    'Adjacent — school programs, youth sports, first responders', 13],
      ['civic',       'Civic — chamber, festivals, service clubs', 7],
      ['promotional', 'Promotional — a business marketing event, for-profit raffle', 2],
      ['contrary',    'Contrary to values / reputationally risky', 0]
    ];

    var ORG_OPTIONS = [
      ['nonprofit',  'Nonprofit'],
      ['school',     'School or district'],
      ['youth',      'Youth sports / club'],
      ['civic',      'Civic or service org'],
      ['religious',  'Religious'],
      ['political',  'Political'],
      ['business',   'For-profit business'],
      ['individual', 'Individual']
    ];

    /**
     * Lets a human answer what the form cannot. Until this is filled in the
     * engine scores mission as general civic (7 of 18) and skips the religious
     * and political checks entirely, so an unclassified request is scoring
     * BELOW what it deserves, not above.
     */
    function classifyCard(row) {
      var q = row.meta.request;
      var id = row.meta.id;

      function sel(name, options, current, hint) {
        return '' +
          '<label class="cls-row">' +
            '<span class="cls-lbl">' + esc(name) + '</span>' +
            '<select class="cls-sel" data-classify="' + esc(hint) + '" data-id="' + esc(id) + '">' +
              '<option value="">Not classified</option>' +
              options.map(function (o) {
                return '<option value="' + o[0] + '"' +
                  (current === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
              }).join('') +
            '</select>' +
          '</label>';
      }

      function tri(name, current, hint, note) {
        return '' +
          '<label class="cls-row">' +
            '<span class="cls-lbl">' + esc(name) + '</span>' +
            '<select class="cls-sel" data-classify="' + esc(hint) + '" data-id="' + esc(id) + '">' +
              '<option value=""' + (current == null ? ' selected' : '') + '>Not answered</option>' +
              '<option value="yes"' + (current === true ? ' selected' : '') + '>Yes</option>' +
              '<option value="no"' + (current === false ? ' selected' : '') + '>No</option>' +
            '</select>' +
            (note ? '<span class="cls-note">' + esc(note) + '</span>' : '') +
          '</label>';
      }

      return '' +
        '<div class="card">' +
          '<div class="card-hd">Classify</div>' +
          '<p class="cls-intro">The form cannot ask these. The score updates as you set them.</p>' +
          sel('Mission fit', MISSION_OPTIONS, q.missionFit, 'missionFit') +
          sel('Organization type', ORG_OPTIONS, q.orgType, 'orgType') +
          tri('Religious org', q.isReligious, 'isReligious',
              'Not an automatic decline for a customer, or when the ask is secular.') +
          tri('Political org', q.isPolitical, 'isPolitical',
              'Always an automatic decline.') +
          tri('Ask is secular', q.askIsSecular, 'askIsSecular',
              'Only matters if the org is religious.') +
        '</div>';
    }

    function decisionBlock(row) {
      var r = row.result;
      var dec = decisionOf(row);

      if (dec) {
        var ovr = dec.override || isOverride(r, dec.status);
        return '' +
          '<div class="decide">' +
            '<div class="logged">' +
              '<b>' + (dec.status === 'approved' ? 'Approved' : 'Declined') + '</b>' +
              (dec.by ? ' by ' + esc(dec.by) : '') +
              (ovr ? ' &middot; <span class="ov">override</span>, engine said ' + esc(r.decision) : '') +
              (dec.note ? '<br>' + esc(dec.note) : '') +
              '<br><button class="undo" data-undo="' + row.meta.id + '">Reopen this request</button>' +
            '</div>' +
          '</div>';
      }

      return '' +
        '<div class="decide">' +
          '<div class="btns">' +
            '<button class="btn btn-green" data-decide="approved" data-id="' + row.meta.id + '">Approve</button>' +
            '<button class="btn btn-red" data-decide="declined" data-id="' + row.meta.id + '">Decline</button>' +
          '</div>' +
        '</div>';
    }

    function openPanel(id) {
      var row = evaluated().filter(function (r) { return r.meta.id === id; })[0];
      if (!row) return;
      state.openId = id;

      var r = row.result;
      var q = row.meta.request;

      var recLine = r.disqualified
        ? 'Automatic decline'
        : r.decision;

      var recWhy = r.disqualified
        ? r.disqualifiers[0].detail
        : summarise(row);

      $('#panelIn').innerHTML = '' +
        '<div class="panel-top">' +
          '<div>' +
            '<h2>' + esc(q.orgName) + '</h2>' +
            '<div class="sub">' + esc(q.eventName || '') + ' &middot; ' + esc(q.city) +
              ', ' + esc(q.state) + ' &middot; ' + esc(row.meta.id) + '</div>' +
          '</div>' +
          '<button class="x" id="closePanel" aria-label="Close">&times;</button>' +
        '</div>' +

        '<div class="card hero">' +
          '<div class="dial">' + dial.renderGauge(r, { size: 132 }) + '</div>' +
          '<div class="read">' +
            '<div class="rec">' + esc(recLine) + '</div>' +
            '<p>' + esc(recWhy) + '</p>' +
          '</div>' +
        '</div>' +

        reviewCard(row) +
        classifyCard(row) +
        eventCard(row) +
        accountCard(row) +
        scorecard(r) +
        flagCards(r) +
        decisionBlock(row);

      $('#panel').classList.add('open');
      $('#scrim').classList.add('open');
      $('#panel').focus();
    }

    /** One line of plain judgment. Not scoring arithmetic. */
    function summarise(row) {
      var r = row.result;
      var a = row.meta.account;
      var bits = [];

      if (!a.found) bits.push('Not a customer, so relationship and spend score zero.');
      else if (r.flags.some(function (f) { return f.code === 'DORMANT_MEANINGFUL'; }))
        bits.push('Dormant account with real history. Open a quote before committing product.');
      else bits.push(a.tier + ' account, ' + money(a.lifetimeRevenue) + ' lifetime.');

      var m = r.dimensions && r.dimensions.mission;
      if (m && m.points >= 18) bits.push('Mission lands squarely in a core priority.');
      else if (m && m.points <= 2) bits.push('Mission case is thin.');

      if (r.flags.some(function (f) { return f.code === 'LEAD_NOT_HANDOUT'; }))
        bits.push('They plan to buy — route to a rep either way.');

      return bits.join(' ');
    }

    function closePanel() {
      state.openId = null;
      $('#panel').classList.remove('open');
      $('#scrim').classList.remove('open');
    }

    /* ---------------- events ---------------- */

    root.addEventListener('click', function (e) {
      var f = e.target.closest('[data-filter]');
      if (f) { state.filter = f.dataset.filter; renderQueue(); return; }

      var req = e.target.closest('.req');
      if (req) { openPanel(req.dataset.id); return; }

      if (e.target.id === 'closePanel' || e.target.id === 'scrim') { closePanel(); return; }

      var dec = e.target.closest('[data-decide]');
      if (dec) {
        var decId = dec.dataset.id;
        var status = dec.dataset.decide;

        delete state.reopened[decId];
        state.decisions[decId] = { status: status, by: ctx.user ? (ctx.user.name || ctx.user.username) : '', note: '' };
        renderQueue();
        openPanel(decId);

        // Persist. Before there was a backend this lived only in memory and a
        // refresh silently undid every decision.
        saveDecision(decId, status);
        return;
      }

      var undo = e.target.closest('[data-undo]');
      if (undo) {
        var id = undo.dataset.undo;
        saveDecision(id, 'pending');
        // Delete rather than set to pending: decisionOf() treats any stored
        // object as a made decision, so a {status:'pending'} stub would keep
        // the request locked in the decided state.
        delete state.decisions[id];
        state.reopened[id] = true;
        renderQueue();
        openPanel(id);
        return;
      }
    });

    /** Write a decision through the seam; roll the screen back if it fails. */
    function saveDecision(id, status) {
      var row = (ctx.data || []).filter(function (r) { return r.id === id; })[0];
      var previous = row ? row.status : null;
      if (row) row.status = status;

      return ctx.api.request(ENDPOINTS.ggRequests + '?id=' + encodeURIComponent(id), {
        method: 'PATCH',
        body: { status: status }
      }).catch(function (err) {
        if (row) row.status = previous;
        delete state.decisions[id];
        renderQueue();
        openPanel(id);
        console.error('[givinggauge] could not save decision:', err);
        alert('Could not save that decision: ' + (err && err.message ? err.message : err));
      });
    }

    /**
     * Classification changes save immediately and re-score. No save button:
     * a half-classified request that was never submitted is worse than one
     * saved a field at a time, because the score would keep lying quietly.
     */
    root.addEventListener('change', function (e) {
      var sel = e.target.closest('[data-classify]');
      if (!sel) return;

      var field = sel.dataset.classify;
      var id = sel.dataset.id;
      var raw = sel.value;

      var value;
      if (field === 'missionFit' || field === 'orgType') {
        value = raw || null;
      } else {
        value = raw === 'yes' ? true : raw === 'no' ? false : null;
      }

      var row = (ctx.data || []).filter(function (r) { return r.id === id; })[0];
      if (!row) return;

      var previous = row.request[field];
      row.request[field] = value;      // optimistic, so the score updates now

      renderQueue();
      openPanel(id);

      ctx.api.request(ENDPOINTS.ggRequests + '?id=' + encodeURIComponent(id), {
        method: 'PATCH',
        body: { request: (function () { var o = {}; o[field] = value; return o; })() }
      }).catch(function (err) {
        // Put it back rather than leaving the screen disagreeing with storage.
        row.request[field] = previous;
        renderQueue();
        openPanel(id);
        console.error('[givinggauge] could not save ' + field + ':', err);
        alert('Could not save that classification: ' + (err && err.message ? err.message : err));
      });
    });

    onKeydown = function (e) {
      if (e.key === 'Escape' && state.openId) closePanel();
    };
    document.addEventListener('keydown', onKeydown);

    /* ---------------- account matching ---------------- */

    /** Persist a match and re-score. The account is 46 of the 100 points. */
    async function applyMatch(id, account) {
      var row = (ctx.data || []).filter(function (r) { return r.id === id; })[0];
      if (!row) return;

      var previous = row.account;
      row.account = account;          // optimistic, so the score updates now
      renderQueue();
      openPanel(id);

      try {
        await ctx.api.request(ENDPOINTS.ggRequests + '?id=' + encodeURIComponent(id), {
          method: 'PATCH',
          body: { account: account }
        });
      } catch (err) {
        row.account = previous;
        renderQueue();
        openPanel(id);
        console.error('[givinggauge] could not save match:', err);
        alert('Could not save that match: ' + (err && err.message ? err.message : err));
      }
    }

    root.addEventListener('click', async function (e) {
      // ---- search for candidates ----
      var find = e.target.closest('[data-match]');
      if (find) {
        var id = find.dataset.match;
        var row = (ctx.data || []).filter(function (r) { return r.id === id; })[0];
        if (!row) return;

        var results = root.querySelector('[data-results="' + id + '"]');
        find.disabled = true;
        if (results) results.innerHTML = '<div class="match-hint">Searching the roster\u2026</div>';

        try {
          var out = await ctx.api.get(ENDPOINTS.bbCustomerMatch, {
            name: row.request.orgName
          });

          if (!out.candidates || !out.candidates.length) {
            results.innerHTML = '<div class="match-hint">No similar account on the roster. ' +
              'This looks like a genuine non-customer, which is what the score already assumes.</div>';
            find.disabled = false;
            return;
          }

          // A single high-confidence hit is applied directly; anything else is
          // a suggestion, because a wrong match puts a wrong score on a real
          // decision.
          if (out.autoMatch) {
            await applyMatch(id, out.autoMatch);
            return;
          }

          results.innerHTML = out.candidates.map(function (c) {
            return '<div class="match-row" data-pick="' + esc(id) + '" data-cid="' + esc(c.customerId) + '">' +
              '<div>' +
                '<div class="nm">' + esc(c.name) + '</div>' +
                '<div class="meta">' + esc(c.tier) + ' \u00b7 ' + money(c.lifetimeRevenue) +
                  ' lifetime \u00b7 ' + c.orderCount + ' orders</div>' +
              '</div>' +
              '<span class="conf ' + esc(c.matchConfidence) + '">' + esc(c.matchConfidence) + '</span>' +
            '</div>';
          }).join('');

          // Hold the candidates so a click can apply one without re-fetching.
          root._matchCandidates = out.candidates;
        } catch (err) {
          console.error('[givinggauge] match lookup failed:', err);
          results.innerHTML = '<div class="match-hint">Could not reach the roster: ' +
            esc(err && err.message ? err.message : 'unknown error') + '</div>';
        }
        find.disabled = false;
        return;
      }

      // ---- pick one ----
      var pick = e.target.closest('[data-pick]');
      if (pick) {
        var chosen = (root._matchCandidates || []).filter(function (c) {
          return String(c.customerId) === pick.dataset.cid;
        })[0];
        if (chosen) applyMatch(pick.dataset.pick, chosen);
        return;
      }

      // ---- unmatch ----
      var un = e.target.closest('[data-unmatch]');
      if (un) {
        applyMatch(un.dataset.unmatch, { found: false });
        return;
      }
    });

    /* ---------------- import from Jotform ---------------- */

    var importBtn = $('#importBtn');
    var importMsg = $('#importMsg');

    // Only admins and managers can run this; the endpoint enforces it too, so
    // hiding the button is a courtesy rather than the control.
    var role = ctx.user && ctx.user.role;
    if (role !== 'admin' && role !== 'manager') {
      if (importBtn) importBtn.style.display = 'none';
    }

    if (importBtn) {
      importBtn.addEventListener('click', async function () {
        importBtn.disabled = true;
        importMsg.textContent = 'Importing...';

        try {
          // Safe to run repeatedly: the endpoint skips submissions it already
          // has, matched on Jotform's own submission id.
          var out = await ctx.api.post(ENDPOINTS.ggRequests + '?action=backfill', {});

          var bits = [];
          if (out.imported) bits.push(out.imported + ' imported');
          if (out.skipped) bits.push(out.skipped + ' already here');
          if (out.tooOld) bits.push(out.tooOld + ' before ' + out.since);
          if (out.failed) bits.push(out.failed + ' failed');
          importMsg.textContent = bits.length ? bits.join(' · ') : 'Nothing new';

          if (out.imported) {
            var payload = await ctx.api.get(ENDPOINTS.ggRequests);
            ctx.data = Array.isArray(payload) ? payload : ((payload && payload.requests) || []);
            renderQueue();
          }
        } catch (err) {
          console.error('[givinggauge] import failed:', err);
          importMsg.textContent = (err && err.message) ? err.message : 'Import failed';
        } finally {
          importBtn.disabled = false;
        }
      });
    }

    renderQueue();


    // Handed back so the shell can tear the listener down if this app is ever
    // unmounted. Without it the handler would outlive the app.
    this._teardown = () => {
      if (onKeydown) document.removeEventListener('keydown', onKeydown);
    };
  },

  showView() {
    // Single view. The rail shows no sub-nav for a one-view app.
  },

  unmount() {
    if (this._teardown) this._teardown();
  }
};
