/**
 * BackBone — styles.
 *
 * Lifted from the standalone app with three changes:
 *   - :root, the global reset and body came off; tokens.css and shell.css own
 *     them, which is what lets data-app re-theme this app for free.
 *   - The app's own header, nav and login gate came off with their markup.
 *   - All 57 hardcoded colors became tokens. Most mapped onto the existing
 *     palette; the ones that encode MEANING rather than decoration (lead stage,
 *     what contact details are on file, account manager load) got --hue-*
 *     tokens, because collapsing them into --accent would destroy the signal.
 *
 * scopeCss() in app-host prefixes every selector to this app's host on mount,
 * so nothing here can leak into another app.
 */

export default `

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}









.btn{border:none;padding:9px 16px;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;font-weight:700;font-family:inherit;transition:background .12s,box-shadow .12s,transform .04s}
.btn:active{transform:translateY(.5px)}
.btn-green{background:var(--accent);color:var(--card);box-shadow:none}.btn-green:hover{background:var(--accent-deep)}
.btn-gray{background:var(--card);color:var(--accent-deep);border:1px solid var(--line);box-shadow:none}.btn-gray:hover{background:var(--head-bg);border-color:var(--line)}
.btn-danger{background:var(--card);color:var(--danger);border:1px solid var(--danger-line);box-shadow:var(--shadow-card)}.btn-danger:hover{background:var(--danger-tint);border-color:var(--danger-line)}
.btn-danger.confirm{background:var(--danger);color:var(--card);border-color:var(--danger)}.btn-danger.confirm:hover{background:var(--danger-dk)}
.btn-sm{padding:5px 11px;font-size:12px}
.btn:disabled{opacity:.5;cursor:not-allowed}
.last-updated{font-size:11px;color:var(--faint)}





.inbox-item{border:1px solid var(--line);border-radius:12px;padding:15px 17px;margin-bottom:11px;cursor:pointer;transition:border-color .12s,box-shadow .12s;background:var(--card);box-shadow:var(--shadow-card)}
.inbox-item:hover{border-color:var(--accent-tint);box-shadow:0 2px 8px rgba(16,24,40,.08)}
.inbox-item.is-new{border-left:3px solid var(--accent)}
.inbox-item.is-done{opacity:.62}
.inbox-top{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.inbox-co{font-size:14px;font-weight:600;color:var(--ink)}
.inbox-meta{font-size:12px;color:var(--muted);margin-top:3px}
.inbox-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.chip{display:inline-flex;align-items:center;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:var(--line-soft);color:var(--ink)}
.chip-existing{background:var(--success-tint);color:var(--success)}
.chip-new{background:var(--hue-indigo-tint);color:var(--hue-indigo)}
.chip-internal{background:var(--hue-violet-tint);color:var(--hue-violet)}
.page{display:none}.page.active{display:block}
.dash{padding:32px;max-width:1440px;margin:0 auto}

.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin-bottom:22px}
#page-dashboard #dashPortfolioKpiGrid{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
#page-dashboard #dashPortfolioKpiGrid .kpi{padding:13px 15px}
#page-dashboard #dashPortfolioKpiGrid .kpi-val{font-size:24px}
.kpi{position:relative;background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:22px;box-shadow:none}
.kpi-lbl{font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;padding-right:44px}
.kpi-val{font-size:30px;font-weight:800;letter-spacing:-.8px;line-height:1.1}
.kpi-s{font-size:12px;color:var(--muted);margin-top:6px}
.kpi-ico{position:absolute;top:18px;right:18px;width:36px;height:36px;border-radius:var(--radius-sm);background:var(--accent-tint);color:var(--accent);display:flex;align-items:center;justify-content:center}
.kpi-ico svg{width:18px;height:18px;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}

.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600}
.badge-amber{background:var(--amber-tint);color:var(--amber)}
.badge-green{background:var(--success-tint);color:var(--success)}

.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden;box-shadow:none}
.card-hd{padding:18px 22px 16px;border-bottom:1px solid var(--line-soft);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.card-hd h3{font-size:15px;font-weight:700;letter-spacing:-.2px}
.card-bd{padding:22px}

.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.search{padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);font-size:13px;min-width:240px;background:var(--card);box-shadow:none;transition:border-color .12s,box-shadow .12s}
.search:focus{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent);box-shadow:none}
.sort-group{display:flex;background:var(--line-soft);border-radius:var(--radius-sm);padding:3px;gap:3px}
.sort-btn{border:none;padding:6px 13px;border-radius:6px;font-family:inherit;cursor:pointer;font-size:13px;font-weight:500;background:transparent;color:var(--muted);transition:background .12s,color .12s,box-shadow .12s}
.sort-btn:hover{color:var(--ink)}
.sort-btn.active{background:var(--card);color:var(--ink);font-weight:600;box-shadow:var(--shadow-pop)}

table{width:100%;border-collapse:collapse;font-size:13px}
#tableWrap,#dashAmWrap{overflow-x:auto}
#tableWrap table,#dashAmWrap table{min-width:100%}
/* Scorecard: keep the columns clustered together on the left so the eye doesn't travel across
   empty space. Company gets a comfortable but capped width and truncates; the number columns are
   fixed-width and left-aligned right beside it; a trailing spacer column soaks up all leftover
   width at the far right. */
#scoreTableWrap{overflow-x:auto}
#scoreTableWrap table{width:100%;table-layout:auto}
#scoreTableWrap th,#scoreTableWrap td{padding:9px 14px;white-space:nowrap}
#scoreTableWrap th.sc-company,#scoreTableWrap td.sc-company{max-width:340px;overflow:hidden;text-overflow:ellipsis;text-align:left}
#scoreTableWrap th.sc-num,#scoreTableWrap td.sc-num{width:1px;text-align:left}
#scoreTableWrap th.sc-spacer,#scoreTableWrap td.sc-spacer{width:99%;padding:0}
#scoreTableWrap .badge{padding:2px 5px;font-size:11px}
th{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--head-bg);font-weight:600;color:var(--ink);white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid var(--line-soft);white-space:nowrap}
tr.row{cursor:pointer}
tr.row:hover td{background:var(--head-bg)}
.company-cell{font-weight:600}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%}
.dot-filled{background:var(--accent)}
.dot-empty{border:1px solid var(--line)}

.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;display:none;align-items:flex-start;justify-content:center;padding:40px 20px;overflow-y:auto}
.modal-overlay.open{display:flex}
.modal{background:var(--card);border-radius:var(--radius-md);width:100%;max-width:720px;box-shadow:0 20px 60px rgba(0,0,0,.2);overflow:hidden}
.modal-hd{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}
.modal-hd h3{font-size:16px;font-weight:700}
.modal-close{background:none;border:none;font-size:20px;cursor:pointer;color:var(--muted);line-height:1;padding:4px}
.modal-bd{padding:20px;max-height:85vh;overflow-y:auto}
.section-lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:16px 0 8px}
.section-lbl:first-child{margin-top:0}
.synced-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px;margin-bottom:8px}
.synced-grid>div{min-width:0}
.field-lbl{font-size:11px;color:var(--faint);display:block;margin-bottom:3px}
.enrich-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.enrich-field{display:flex;flex-direction:column;min-width:0}
.enrich-field.wide{grid-column:1/-1}
input.field,textarea.field,select.field{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);font-size:13px;font-family:inherit;background:var(--card)}
input.field:focus,textarea.field:focus,select.field:focus{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
.req-star{color:var(--accent);font-weight:700}
textarea.field{min-height:60px;resize:vertical}
.modal-ft{padding:14px 20px;border-top:1px solid var(--line);display:flex;align-items:center;gap:10px}
.save-status{font-size:12px;color:var(--muted)}

.import-textarea{width:100%;min-height:180px;padding:10px;border:1px solid var(--line);border-radius:6px;font-size:12px;font-family:monospace;background:var(--head-bg);margin-bottom:10px}
.err{background:var(--danger-tint);border:1px solid var(--danger-line);border-radius:8px;padding:10px 14px;color:var(--danger);font-size:13px;margin-bottom:10px}
.help{font-size:12px;color:var(--muted);margin-bottom:12px;line-height:1.5}
.empty-state{padding:40px;text-align:center;color:var(--faint)}

.alert-group{border:1px solid var(--line);border-radius:8px;margin-bottom:10px;overflow:hidden;background:var(--card)}
.alert-group:last-child{margin-bottom:0}
.alert-group summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:11px 14px;font-size:13px;font-weight:600;gap:8px}
.alert-group summary::-webkit-details-marker{display:none}
.alert-group summary::before{content:"▸";display:inline-block;margin-right:8px;transition:transform .15s ease;color:var(--faint);font-size:11px}
.alert-group[open] summary::before{transform:rotate(90deg)}
.alert-group.sev-high{border-color:var(--danger-line)}
.alert-group.sev-high summary{background:var(--danger-tint)}
.alert-group.sev-med{border-color:var(--amber-line)}
.alert-group.sev-med summary{background:var(--amber-tint)}
.alert-group.sev-low summary{background:var(--head-bg)}
.alert-group-body{padding:10px 14px 12px}
.alert-count{background:var(--line-soft);color:var(--ink);border-radius:99px;padding:2px 9px;font-size:12px;font-weight:700}
.alert-count.warn{background:var(--danger-tint);color:var(--danger)}
.alert-count.amber{background:var(--amber-tint);color:var(--amber)}
.alert-row{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--line-soft);border-radius:6px;margin-bottom:6px;cursor:pointer;font-size:13px}
.alert-row:last-child{margin-bottom:0}
.alert-row:hover{background:var(--head-bg)}
.alert-row .meta{color:var(--muted);font-size:12px}
.mix-bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:13px}
.mix-bar-lbl{width:190px;flex-shrink:0;color:var(--ink)}
.mix-bar-track{flex:1;background:var(--line-soft);border-radius:99px;height:14px;overflow:hidden;display:flex}
.mix-bar-fill{height:100%}
.mix-bar-val{width:110px;flex-shrink:0;text-align:right;color:var(--muted);font-size:12px}
/* Industry sort toggle */
.mix-sort{display:inline-flex;gap:3px;background:var(--bg);padding:3px;border-radius:99px;margin-bottom:12px}
.mix-sort button{border:none;background:none;font-family:inherit;font-size:11.5px;font-weight:600;
  color:var(--faint);padding:4px 12px;border-radius:99px;cursor:pointer;transition:all .12s ease}
.mix-sort button.on{background:var(--card);color:var(--ink);box-shadow:0 1px 2px rgba(16,24,40,.08)}
/* Sales vs goal (flat, no gradients) */
.sg-hero{display:flex;align-items:baseline;gap:10px;margin-bottom:4px}
.sg-hero-n{font-size:26px;font-weight:800;letter-spacing:-.02em;line-height:1}
.sg-hero-s{font-size:12px;color:var(--faint);font-weight:500}
.sg-track{position:relative;height:10px;background:var(--line-soft);border-radius:99px;overflow:visible;margin:10px 0 4px}
.sg-fill{height:100%;border-radius:99px;transition:width .5s cubic-bezier(.22,1,.36,1)}
.sg-pace-marker{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink);opacity:.5;border-radius:2px}
.sg-pacenote{font-size:11.5px;font-weight:700;margin:2px 0 2px}
.sg-months{display:flex;align-items:flex-end;gap:6px;height:150px;padding-top:10px}
.sg-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0}
.sg-barwrap{width:100%;max-width:38px;height:110px;display:flex;align-items:flex-end;position:relative}
.sg-bar{width:100%;border-radius:6px 6px 0 0;min-height:2px;transition:height .5s cubic-bezier(.22,1,.36,1)}
.sg-goal-line{position:absolute;left:-2px;right:-2px;height:2px;background:var(--ink);opacity:.28}
.sg-mlbl{font-size:10px;color:var(--faint);font-weight:700}
.sg-mval{font-size:9.5px;color:var(--muted);font-weight:700}
/* Outstanding list */
.out-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--bg);font-size:13px}
.out-row:last-child{border-bottom:none}
.out-main{flex:1;min-width:0}
.out-name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.out-name:hover{color:var(--accent)}
.out-sub{font-size:11px;color:var(--faint);margin-top:2px}
.out-amt{flex:0 0 auto;font-weight:800;color:var(--danger-dk);font-size:14px}
/* Workload bucket pills in AM table */
.wl-cell{display:flex;gap:5px;flex-wrap:wrap}
.wl-pill{font-size:10px;font-weight:800;padding:2px 8px;border-radius:99px;white-space:nowrap;letter-spacing:.02em}
.wl-q{background:var(--hue-blue-tint);color:var(--hue-blue-deep)}
.wl-p{background:var(--amber-tint);color:var(--amber)}
.wl-h{background:var(--danger-tint);color:var(--danger-dk)}
.wl-zero{color:var(--faint);font-size:12px}
.am-brief-btn{border:1px solid var(--line);background:var(--card);color:var(--accent-deep);font-family:inherit;font-size:11px;
  font-weight:700;padding:4px 10px;border-radius:99px;cursor:pointer}
.am-brief-btn:hover{background:var(--accent-tint);border-color:var(--accent)}
/* Dormant resolve controls */
.dm-resolve{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-left:8px}
.dm-rbtn{border:1px solid var(--line);background:var(--card);color:var(--muted);font-family:inherit;font-size:10.5px;
  font-weight:700;padding:3px 8px;border-radius:99px;cursor:pointer}
.dm-rbtn:hover{border-color:var(--faint);color:var(--ink)}
.dm-resolved{font-size:10.5px;color:var(--faint);font-style:italic}
.dm-undo{border:none;background:none;color:var(--accent);font-family:inherit;font-size:10.5px;font-weight:700;cursor:pointer;padding:0 2px}
/* Brief modal print area */
.brief-doc{font-size:13px;line-height:1.5;color:var(--ink)}
.brief-doc h2{font-size:18px;font-weight:800;margin-bottom:2px}
.brief-doc .brief-meta{font-size:12px;color:var(--faint);margin-bottom:16px}
.brief-sec{margin-bottom:18px}
.brief-sec-l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);margin-bottom:8px;border-bottom:1px solid var(--line-soft);padding-bottom:5px}
.brief-hero{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-bottom:18px;padding:12px 14px;background:var(--head-bg);border:1px solid var(--line-soft);border-radius:10px}
.brief-tier{padding:2px 9px;border-radius:99px;font-size:11.5px;font-weight:800}
.brief-stat{font-size:12.5px;color:var(--muted)}
.brief-stat b{color:var(--ink);font-weight:800;font-size:14px}
.brief-kv{width:100%;border-collapse:collapse;font-size:13px}
.brief-kv td{padding:4px 0;vertical-align:top}
.brief-kv td:first-child{color:var(--muted);width:150px;white-space:nowrap;padding-right:12px}
.brief-kv td:last-child{color:var(--ink);font-weight:500}
.brief-contact{font-size:13px;line-height:1.7}
.brief-contact .bc-name{font-weight:700;font-size:13.5px}
.brief-prod{display:flex;flex-direction:column;gap:6px}
.brief-prod-row{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:6px 10px;background:var(--head-bg);border:1px solid var(--line-soft);border-radius:6px}
.brief-prod-row .bp-name{font-weight:600}
.brief-prod-row .bp-meta{color:var(--muted);white-space:nowrap;font-size:12px}
.brief-empty{font-size:12.5px;color:var(--faint);line-height:1.5;font-style:italic}
.brief-empty code{font-style:normal;background:var(--line-soft);padding:1px 5px;border-radius:4px;font-size:11.5px}
.brief-trend{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:2px}
.brief-trend th,.brief-trend td{padding:5px 8px;text-align:right;border-bottom:1px solid var(--bg)}
.brief-trend th:first-child,.brief-trend td:first-child{text-align:left;color:var(--muted);font-weight:600}
.brief-trend thead th{color:var(--faint);font-weight:700;font-size:11px}
.brief-trend-note{font-size:11.5px;font-weight:700;margin-top:6px}

/* --- At-Risk brief: mirrors api/brief.js (the emailed Lead Brief) exactly, so the
   two briefs are visually indistinguishable. Tier colours come in as CSS vars
   (--bt-bar / --bt-bg / --bt-fg / --bt-uc) set inline on .brief-sheet. Scoped so
   these generic class names don't collide with the rest of the app. */
.brief-sheet{max-width:520px;margin:0 auto;font-family:Inter,-apple-system,system-ui,sans-serif;color:var(--ink);line-height:1.5}
.brief-sheet .card{background:var(--card);border-radius:16px;box-shadow:0 1px 3px rgba(16,24,40,.07);padding:20px;margin-bottom:12px}
.brief-sheet .top{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.brief-sheet .badge{width:24px;height:24px;border-radius:7px;background:var(--accent);display:flex;align-items:center;justify-content:center;color:var(--card);font-weight:800;font-size:12px}
.brief-sheet .top-t{font-weight:700;font-size:12px;letter-spacing:.02em;color:var(--muted)}
.brief-sheet .top-am{margin-left:auto;font-size:11px;color:var(--faint)}
.brief-sheet .hero{text-align:center;padding:22px 20px 20px}
.brief-sheet .stars{font-size:19px;letter-spacing:3px;color:var(--bt-bar);margin-bottom:10px}
.brief-sheet .stars .off{color:var(--line)}
.brief-sheet .co{font-size:25px;font-weight:800;letter-spacing:-.02em;line-height:1.2}
.brief-sheet .ind{font-size:13px;color:var(--faint);margin-top:4px}
.brief-sheet .site-btn{display:inline-flex;align-items:center;gap:7px;margin-top:12px;padding:11px 18px;border-radius:11px;background:var(--card);border:2px solid var(--bt-bar);color:var(--bt-bar);font-size:14px;font-weight:700;text-decoration:none}
.brief-sheet .site-btn:hover{background:var(--bt-bg)}
.brief-sheet .site-none{margin-top:12px;font-size:12px;color:var(--faint);font-weight:600}
.brief-sheet .dial{margin-top:16px}
.brief-sheet .dial-n{font-size:40px;font-weight:800;letter-spacing:-.03em;line-height:1;color:var(--bt-bar)}
.brief-sheet .dial-n small{font-size:14px;font-weight:500;color:var(--faint)}
.brief-sheet .dial-bar{height:7px;border-radius:99px;background:var(--line-soft);margin:11px auto 10px;max-width:220px;overflow:hidden}
.brief-sheet .dial-fill{height:100%;border-radius:99px;background:var(--bt-bar);width:var(--bt-pct,0)}
.brief-sheet .tier{display:inline-block;padding:5px 13px;border-radius:99px;font-size:11.5px;font-weight:700;background:var(--bt-bg);color:var(--bt-fg)}
.brief-sheet .sum{font-size:15px;line-height:1.6;text-align:center;color:var(--ink)}
.brief-sheet .call{background:var(--card);border-radius:16px;padding:20px;margin-bottom:12px;box-shadow:0 2px 10px rgba(16,24,40,.10);border:2px solid var(--bt-bar)}
.brief-sheet .call-l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--bt-bar);margin-bottom:9px}
.brief-sheet .call-hd{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.brief-sheet .call-name{font-size:20px;font-weight:800;letter-spacing:-.01em}
.brief-sheet .call-title{font-size:13.5px;color:var(--muted);margin-top:1px}
.brief-sheet .call-acts{margin-top:14px;display:flex;flex-direction:column;gap:8px}
.brief-sheet .act{display:flex;align-items:center;gap:9px;padding:13px 15px;border-radius:11px;font-size:14.5px;font-weight:600;text-decoration:none}
.brief-sheet .act-i{font-size:15px;opacity:.85}
.brief-sheet .act-primary{background:var(--bt-bar);color:var(--card)}
.brief-sheet .act-secondary{background:var(--bg);color:var(--ink)}
.brief-sheet .act-none{background:var(--amber-tint);color:var(--amber);font-size:13px;font-weight:600}
.brief-sheet .say-l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.brief-sheet .say{font-size:15.5px;font-weight:600;line-height:1.55}
.brief-sheet .say-m{font-size:12.5px;color:var(--faint);margin-top:10px}
.brief-sheet .say-m b{color:var(--ink)}
.brief-sheet .pb{background:var(--card);border-radius:16px;padding:20px;margin-bottom:12px;box-shadow:0 1px 3px rgba(16,24,40,.07);border-left:4px solid var(--bt-bar)}
.brief-sheet .pb-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}
.brief-sheet .pb-l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--bt-bar)}
.brief-sheet .pb-tag{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;padding:3px 9px;border-radius:99px;background:var(--bt-bg);color:var(--bt-fg)}
.brief-sheet .pb-read{font-size:14px;line-height:1.55;font-weight:600;margin-bottom:11px}
.brief-sheet .pb-do,.brief-sheet .pb-dont{font-size:13px;line-height:1.5;padding:5px 0;color:var(--ink)}
.brief-sheet .pb-do b{color:var(--success-dk)}.brief-sheet .pb-dont b{color:var(--danger-dk)}
.brief-sheet .pb-need{font-size:13px;color:var(--muted);line-height:1.55;padding-bottom:12px;margin-bottom:4px;border-bottom:1px solid var(--bg)}
.brief-sheet .pb-need b{color:var(--ink)}
.brief-sheet .fb{padding:10px 0;border-bottom:1px solid var(--bg)}
.brief-sheet .fb:last-of-type{border-bottom:none}
.brief-sheet .fb-f{font-size:13.5px;font-weight:700}
.brief-sheet .fb-b{font-size:12.5px;color:var(--muted);line-height:1.5;margin-top:2px}
.brief-sheet .warn{background:var(--danger-tint);border-radius:12px;padding:13px 16px;margin-bottom:12px}
.brief-sheet .warn-l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--danger-dk);margin-bottom:5px}
.brief-sheet .warn p{font-size:13px;color:var(--danger-dk);line-height:1.5}
.brief-sheet .foot{text-align:center;font-size:11px;color:var(--faint);margin-top:16px}
@media print{.brief-sheet .card,.brief-sheet .call,.brief-sheet .pb{box-shadow:none;border:1px solid var(--line)}}
/* Grey backdrop behind the cards, bleeding to the modal-body edges, so it reads like
   the standalone emailed brief (cards floating on var(--bg)) rather than white-on-white. */
#briefPrintArea:has(.brief-sheet){background:var(--bg);margin:-20px;padding:20px 14px}
.brief-line{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--bg)}
.brief-line:last-child{border-bottom:none}
.brief-line .bl-name{font-weight:700}
.brief-line .bl-meta{color:var(--muted);font-size:12px;text-align:right;flex-shrink:0}
.brief-empty{color:var(--faint);font-size:12px}
@media print{
  body 
  #briefPrintArea,#briefPrintArea *{visibility:visible}
  #briefPrintArea{position:absolute;left:0;top:0;width:100%;padding:24px}
  .brief-noprint{display:none !important}
}
.am-table td,.am-table th{white-space:normal}
.tier-pill{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;margin-right:3px}

.qual-tier-badge{display:inline-flex;align-items:center;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700}
.qt-strategic{background:var(--accent-tint);color:var(--accent-deep)}
.qt-highvalue{background:var(--hue-blue-tint);color:var(--hue-blue)}
.qt-standard{background:var(--line-soft);color:var(--muted)}
.qt-transactional{background:var(--amber-tint);color:var(--amber)}
.qt-lowpriority{background:var(--danger-tint);color:var(--danger)}
.lead-status-pill{display:inline-flex;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:600;background:var(--line-soft);color:var(--ink)}
.lead-status-Won{background:var(--success-tint);color:var(--success)}
.lead-status-Dead{background:var(--danger-tint);color:var(--faint)}
.lead-status-Qualified{background:var(--hue-blue-tint);color:var(--hue-blue)}
.lead-status-Contacted{background:var(--hue-violet-tint);color:var(--hue-violet)}
.lead-status-AMNotified{background:var(--amber-tint);color:var(--amber)}
.lead-status-Researching{background:var(--hue-sky-tint);color:var(--hue-sky)}

/* --- Lead funnel ------------------------------------------------------------ */
.funnel{display:flex;align-items:stretch;gap:6px;flex-wrap:nowrap;margin-bottom:14px}
.funnel-stage{position:relative;flex:1 1 0;min-width:0;border:none;cursor:pointer;padding:10px 8px 11px;
  border-radius:12px;background:var(--card);box-shadow:0 1px 2px rgba(16,24,40,.05);
  transition:transform .14s ease,box-shadow .14s ease,background .14s ease;
  text-align:left;font-family:inherit;overflow:hidden}
.funnel-stage:hover{transform:translateY(-2px);box-shadow:0 6px 14px rgba(16,24,40,.10)}
.funnel-stage.is-active{box-shadow:0 6px 16px rgba(16,24,40,.14);transform:translateY(-2px)}
.funnel-stage.is-active::after{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--fnl,var(--faint))}
.funnel-stage.is-empty{opacity:.5}
.funnel-stage .fnl-top{display:flex;align-items:baseline;justify-content:space-between;gap:6px}
.funnel-stage .fnl-name{font-size:10.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;
  color:var(--fnl,var(--muted));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.funnel-stage .fnl-pct{font-size:10px;font-weight:600;color:var(--faint);flex:0 0 auto}
.funnel-stage .fnl-count{font-size:22px;font-weight:700;color:var(--ink);line-height:1.15;margin-top:1px}
.funnel-stage .fnl-bar{height:5px;border-radius:99px;background:var(--line-soft);margin-top:7px;overflow:hidden}
.funnel-stage .fnl-fill{height:100%;border-radius:99px;background:var(--fnl,var(--faint));
  transition:width .45s cubic-bezier(.22,1,.36,1)}
.funnel-stage .fnl-sub{font-size:10.5px;color:var(--faint);margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.funnel-chev{flex:0 0 auto;align-self:center;color:var(--line);font-size:11px;user-select:none;line-height:1}
.funnel-all{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.funnel-all .fnl-hint{font-size:11.5px;color:var(--faint)}
@media(max-width:1100px){
  .funnel{flex-wrap:wrap}
  .funnel-stage{flex:1 1 120px}
  .funnel-chev{display:none}
}

/* --- Customizable dashboard grid -------------------------------------------- */
/* Styled to match the emailed Lead Brief: 16px radius, soft shadow, uppercase
   micro-labels with wide tracking, pill badges, and the same tier colour language. */
/* No \`dense\` packing: it silently reflows cards to backfill gaps, which is exactly
   the "I put it here and it jumped" behaviour. Plain row flow keeps every card in
   the order the user dragged it to, even if that leaves a half-width gap. */
.dash-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start;
  grid-auto-flow:row}

.dash-card{grid-column:span 1;position:relative;border-radius:14px;
  box-shadow:0 1px 3px rgba(16,24,40,.07);
  transition:box-shadow .15s ease,opacity .15s ease,transform .15s ease}
.dash-card:hover{box-shadow:0 4px 14px rgba(16,24,40,.10)}
/* Denser dashboard cards: tighter header + body than the app-wide default so the
   whole board reads as a compact widget grid rather than a long scroll. */
.dash-card .card-hd{padding:11px 16px 10px}
.dash-card .card-bd{padding:12px 16px}
.dash-card .card-bd .help{margin-bottom:8px;font-size:11.5px;line-height:1.45}
/* Width follows position (see reflowDashWidths). Default is a full row; a card
   paired beside a neighbour gets .w-half. .w-full is kept as an explicit full-row
   marker so the reflow can set it directly. */
.dash-card{grid-column:span 2}
.dash-card.w-half{grid-column:span 1}
.dash-card.w-full{grid-column:span 2}
.dash-card.is-hidden{display:none}
.dash-card.dragging{opacity:.35;transform:scale(.99)}
.dash-card.drag-over{box-shadow:0 0 0 2px var(--accent),0 6px 18px rgba(16,24,40,.12)}
.dash-card.drag-side{box-shadow:0 0 0 2px var(--accent),inset 0 0 0 9999px rgba(27,93,171,.04)}
.dash-card .card-hd{user-select:none;align-items:center}
.dash-card .card-hd h3{font-size:13px;font-weight:800;letter-spacing:.02em}
.dash-card.dragging .card-hd{cursor:grabbing}
.dash-tools{display:flex;gap:2px;align-items:center;margin-left:auto}
.dash-tool{border:none;background:none;cursor:pointer;padding:4px 6px;border-radius:6px;
  color:var(--faint);font-size:12px;line-height:1;font-family:inherit;transition:all .12s ease}
.dash-tool:hover{background:var(--bg);color:var(--ink)}
.dash-grip{color:var(--line);font-size:14px;margin-right:8px;flex:0 0 auto;cursor:grab;line-height:1}
.dash-grip:hover{color:var(--faint)}
.dash-bar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.dash-bar .spacer{flex:1}
.dash-hidden-list{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.dash-chip{font-size:11.5px;font-weight:600;padding:4px 10px;border-radius:99px;background:var(--bg);
  color:var(--faint);border:1px dashed var(--line);cursor:pointer;font-family:inherit}
.dash-chip:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-tint)}
@media(max-width:900px){
  .dash-grid{grid-template-columns:1fr}
  .dash-card,.dash-card.w-full,.dash-card.w-half{grid-column:span 1}
}

/* --- report internals (brief-styled) ---------------------------------------- */
/* Micro-label: the uppercase wide-tracked header used throughout the brief. */
.rep-l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;
  color:var(--faint);margin-bottom:10px}

/* Headline stat, mirroring the brief's score dial. */
.rep-hero{display:flex;align-items:baseline;gap:9px;margin-bottom:12px;flex-wrap:wrap;
  padding-bottom:12px;border-bottom:1px solid var(--bg)}
.rep-hero-n{font-size:26px;font-weight:800;letter-spacing:-.02em;line-height:1}
.rep-hero-s{font-size:12px;color:var(--faint);font-weight:500}

.rep-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--bg);
  font-size:13px}
.rep-row:last-child{border-bottom:none}
.rep-name{flex:1;min-width:0;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  cursor:pointer;font-size:13.5px}
.rep-name:hover{color:var(--accent)}
.rep-sub{font-size:11.5px;color:var(--faint);font-weight:400;margin-top:2px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.rep-val{flex:0 0 auto;font-weight:800;text-align:right;font-size:14px}
.rep-pill{flex:0 0 auto;font-size:9px;font-weight:800;padding:3px 8px;border-radius:99px;
  text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
.rep-red{background:var(--danger-tint);color:var(--danger-dk)}
.rep-amber{background:var(--amber-tint);color:var(--amber)}
.rep-green{background:var(--success-tint);color:var(--success-dk)}
.rep-gray{background:var(--line-soft);color:var(--muted)}

/* bar chart */
.rep-bars{display:flex;align-items:flex-end;gap:10px;height:158px;padding-top:8px}
.rep-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:7px;min-width:0}
.rep-bar{width:100%;max-width:56px;border-radius:8px 8px 0 0;
  background:var(--accent);
  transition:height .5s cubic-bezier(.22,1,.36,1);min-height:3px}
.rep-bar.dim{background:var(--line)}
.rep-bar-lbl{font-size:11px;color:var(--faint);font-weight:700}
.rep-bar-val{font-size:10.5px;color:var(--muted);font-weight:700}
.rep-delta{font-size:12px;font-weight:800;flex:0 0 auto}
.rep-up{color:var(--success-dk)}.rep-dn{color:var(--danger-dk)}
.rep-legend{font-size:11px;color:var(--faint);margin-top:11px;line-height:1.5}

/* roles editor */
.role-box{border:1px solid var(--line-soft);border-radius:12px;padding:14px;margin-bottom:10px;background:var(--footer-bg)}
.role-hd{display:flex;align-items:center;gap:6px;margin-bottom:10px}
.role-sec{padding:9px 0;border-top:1px solid var(--bg)}
.role-l{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);margin-bottom:6px}
.role-opts{display:flex;flex-wrap:wrap;gap:6px 14px}
.role-chk{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;color:var(--ink);cursor:pointer}
.role-chk input{cursor:pointer}
body.read-only .btn-green,body.read-only .btn-red{display:none !important}

/* --- AM leaderboard --------------------------------------------------------- */
.lb-row{display:flex;align-items:center;gap:12px;padding:9px 10px;border-radius:10px;
  transition:background .12s ease}
.lb-row:hover{background:var(--head-bg)}
.lb-row + .lb-row{border-top:1px solid var(--bg)}
.lb-rank{flex:0 0 26px;text-align:center;font-size:13px;font-weight:700;color:var(--faint)}
.lb-row.lb-1 .lb-rank,.lb-row.lb-2 .lb-rank,.lb-row.lb-3 .lb-rank{font-size:15px;color:inherit}
.lb-av{flex:0 0 30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;color:var(--card);letter-spacing:.02em}
.lb-main{flex:1 1 auto;min-width:0}
.lb-name{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lb-sub{font-size:11px;color:var(--faint);margin-top:1px}
.lb-bar{height:4px;border-radius:99px;background:var(--line-soft);margin-top:5px;overflow:hidden;max-width:260px}
.lb-fill{height:100%;border-radius:99px;transition:width .5s cubic-bezier(.22,1,.36,1)}
.lb-stat{flex:0 0 auto;text-align:right;min-width:56px}
.lb-val{font-size:17px;font-weight:700;line-height:1.1}
.lb-lbl{font-size:9.5px;color:var(--faint);text-transform:uppercase;letter-spacing:.05em;margin-top:1px}
.lb-badges{flex:0 0 auto;display:flex;gap:4px}
.lb-badge{font-size:9.5px;font-weight:700;padding:2px 7px;border-radius:99px;white-space:nowrap;
  text-transform:uppercase;letter-spacing:.03em}
.lb-hot{background:var(--danger-tint);color:var(--danger-dk)}
.lb-streak{background:var(--amber-tint);color:var(--amber)}
.lb-clean{background:var(--success-tint);color:var(--success-dk)}
.lb-cold{background:var(--line-soft);color:var(--faint)}
.lb-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
.lb-metric{display:flex;gap:3px;background:var(--bg);padding:3px;border-radius:99px}
.lb-metric button{border:none;background:none;font-family:inherit;font-size:11.5px;font-weight:600;
  color:var(--faint);padding:4px 12px;border-radius:99px;cursor:pointer;transition:all .12s ease}
.lb-metric button.on{background:var(--card);color:var(--ink);box-shadow:0 1px 2px rgba(16,24,40,.08)}
@media(max-width:760px){.lb-badges{display:none}.lb-bar{max-width:120px}}

/* --- Account Managers (merged leaderboard + workload) ----------------------- */
.amp-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.amp-tb-lbl{font-size:11px;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:.04em}
.amp-sort{display:flex;gap:3px;background:var(--bg);padding:3px;border-radius:99px;flex-wrap:wrap}
.amp-sort button{border:none;background:none;font-family:inherit;font-size:11.5px;font-weight:600;
  color:var(--faint);padding:4px 12px;border-radius:99px;cursor:pointer;transition:all .12s ease}
.amp-sort button.on{background:var(--card);color:var(--ink);box-shadow:0 1px 2px rgba(16,24,40,.08)}
.amp-sort button:disabled{opacity:.4;cursor:not-allowed}
.amp-row{display:flex;align-items:flex-start;gap:12px;padding:11px 10px;border-radius:12px;transition:background .12s ease}
.amp-row:hover{background:var(--head-bg)}
.amp-row + .amp-row{border-top:1px solid var(--bg)}
.amp-unassigned{opacity:.85}
.amp-rank{flex:0 0 24px;text-align:center;font-size:14px;font-weight:700;color:var(--faint);padding-top:4px}
.amp-av{flex:0 0 32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;
  font-size:11.5px;font-weight:700;color:var(--card);letter-spacing:.02em;margin-top:1px}
.amp-main{flex:1 1 auto;min-width:0}
.amp-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.amp-name{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.amp-badges{display:flex;gap:4px}
.amp-chips{display:flex;flex-wrap:wrap;gap:5px 8px;margin-top:4px}
.amp-chip{font-size:11.5px;color:var(--muted)}
.amp-chip b{color:var(--ink);font-weight:700}
.amp-chip-warn{color:var(--amber)}
.amp-chip-warn b{color:var(--amber)}
.amp-tiers{display:flex;flex-wrap:wrap;gap:3px;margin-top:5px}
.amp-tier{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:700;background:var(--line-soft)}
.amp-loadline{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.amp-load-zero{font-size:11px;color:var(--faint)}
.amp-bar{height:4px;border-radius:99px;background:var(--line-soft);margin-top:7px;overflow:hidden;max-width:320px}
.amp-fill{height:100%;border-radius:99px;transition:width .5s cubic-bezier(.22,1,.36,1)}
.amp-right{flex:0 0 auto;text-align:right;min-width:64px;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.amp-val{font-size:17px;font-weight:800;line-height:1.05;color:var(--ink)}
.amp-vlbl{font-size:9px;color:var(--faint);text-transform:uppercase;letter-spacing:.05em}
.amp-brief{margin-top:2px}
@media(max-width:760px){.amp-bar{max-width:160px}.amp-badges{display:none}}
.lead-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.lead-form-grid .wide{grid-column:1/-1}
.qual-section{margin-bottom:16px}
.qual-section h4{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:8px}
.qual-row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid var(--line-soft);gap:12px}
.qual-row span:first-child{color:var(--muted);text-transform:capitalize}
.qual-row span:last-child{text-align:right}
.qual-score-total{font-size:32px;font-weight:700;letter-spacing:-1px}
.qual-spinner{display:inline-block;width:12px;height:12px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:qualspin .7s linear infinite}
@keyframes qualspin{to{transform:rotate(360deg)}}
/* Login gate */









#appRoot{display:none}
/* Tab visibility panel */
.tab-toggle-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line-soft)}
.tab-toggle-row:last-child{border-bottom:none}
.tab-toggle-row span{font-size:14px;font-weight:500}
.switch{position:relative;width:40px;height:22px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:var(--line);border-radius:22px;cursor:pointer;transition:.15s}
.slider::before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;background:var(--card);border-radius:50%;transition:.15s}
.switch input:checked+.slider{background:var(--success)}
.switch input:checked+.slider::before{transform:translateX(18px)}
.admin-lock{text-align:center;padding:40px 20px}
.scoring-legend-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:20px 28px;align-items:start}
.scoring-legend-col{min-width:0}
.scoring-legend-col>div:first-child{padding-bottom:5px;border-bottom:1px solid var(--line-soft);margin-bottom:6px}
.scan-card-bar{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.scan-card-status{font-size:12px;color:var(--muted)}
.scan-card-status.err{color:var(--danger)}
.scan-card-status.ok{color:var(--green)}
.admin-lock input{width:240px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:14px;font-family:inherit;margin:12px 8px 0 0}


.contact-tag {
  display: inline-block; font-size: 11px; font-weight: 600;
  padding: 2px 8px; border-radius: 999px; white-space: nowrap; cursor: default;
}
.contact-tag.ct-both  { color: var(--hue-forest); background: var(--hue-forest-tint); }
.contact-tag.ct-email { color: var(--hue-blue); background: var(--hue-blue-tint); }
.contact-tag.ct-phone { color: var(--amber); background: var(--amber-tint); }
.contact-tag.ct-none  { color: var(--hue-clay); background: var(--hue-clay-tint); }
.lead-no-contact-banner {
  display: flex; flex-direction: column; gap: 3px;
  background: var(--hue-clay-tint); border: 1px solid var(--hue-clay-line); border-left: 4px solid var(--hue-clay);
  border-radius: 10px; padding: 10px 14px; margin-bottom: 14px;
}
.lead-no-contact-banner strong { color: var(--hue-clay); font-size: 13px; }
.lead-no-contact-banner span { color: var(--hue-clay); font-size: 12px; line-height: 1.45; }
.bulk-status-group {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 10px 4px 12px; background: var(--card);
  border: 1px solid var(--line); border-radius: 999px;
}
.bulk-status-group .field-lbl { font-size: 11px; color: var(--muted); white-space: nowrap; }
.bulk-status-group select.field { padding: 5px 8px; font-size: 12px; }
`;
