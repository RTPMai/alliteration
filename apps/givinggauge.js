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
    ctx.data = (payload && payload.requests) || [];

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

      return '<div class="card"><div class="card-hd">The account</div>' + body + '</div>';
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
        delete state.reopened[dec.dataset.id];
        state.decisions[dec.dataset.id] = {
          status: dec.dataset.decide,
          by: 'Ryan',
          note: ''
        };
        renderQueue();
        openPanel(dec.dataset.id);
        return;
      }

      var undo = e.target.closest('[data-undo]');
      if (undo) {
        var id = undo.dataset.undo;
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

    onKeydown = function (e) {
      if (e.key === 'Escape' && state.openId) closePanel();
    };
    document.addEventListener('keydown', onKeydown);

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
