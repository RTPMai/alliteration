// PUT IN: apps/marketmachine/styles.js
/**
 * MarketMachine styles. Tokens only, no hex: css/tokens.css owns every color
 * through data-app="marketmachine".
 *
 * The one deliberately strong element is the six-stage strip on a campaign
 * page (.mk-stages). It is a real sequence, so it is numbered, and it is the
 * thing a person should see first after the next step.
 */

export default `
  .mk-page{padding:24px 32px 60px;max-width:1280px}
  .mk-hd{display:flex;justify-content:space-between;align-items:flex-start;
    margin-bottom:18px;flex-wrap:wrap;gap:12px}
  .mk-hd h1{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .mk-hd .sub{font-size:13px;color:var(--muted);margin-top:3px;max-width:62ch}

  .mk-btn{background:var(--accent);color:var(--on-accent);border:1px solid var(--accent);
    border-radius:var(--radius-sm);padding:7px 14px;font-size:13px;font-weight:600;
    cursor:pointer;font-family:inherit;transition:var(--speed)}
  .mk-btn:hover{background:var(--accent-deep);border-color:var(--accent-deep)}
  .mk-btn:focus-visible,.mk-link:focus-visible,.mk-check:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .mk-btn[disabled]{opacity:.5;cursor:not-allowed}
  .mk-btn.ghost{background:transparent;color:var(--muted);border-color:var(--line)}
  .mk-btn.ghost:hover{color:var(--ink);background:var(--row-hover)}
  .mk-btn.sm{padding:4px 10px;font-size:12px}
  .mk-btn.danger{background:transparent;color:var(--danger-dk);border-color:var(--danger-line)}
  .mk-btn.danger:hover{background:var(--danger-tint)}
  .mk-link{background:none;border:0;padding:0;color:var(--accent-deep);font:inherit;
    cursor:pointer;text-decoration:underline;text-underline-offset:2px}

  .mk-card{background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-md);margin-bottom:18px;overflow:hidden}
  .mk-card-hd{display:flex;justify-content:space-between;align-items:center;
    padding:14px 18px;border-bottom:1px solid var(--line-soft);gap:12px;flex-wrap:wrap}
  .mk-card-hd h3{font-size:14px;font-weight:700}
  .mk-card-hd .meta{font-size:12px;color:var(--muted)}
  .mk-card-bd{padding:18px}
  .mk-card-bd.flush{padding:0}

  .pill{display:inline-block;padding:2px 9px;border-radius:var(--radius-pill);
    font-size:11px;font-weight:700;white-space:nowrap}
  .pill.ok{background:var(--success-tint);color:var(--success-dk)}
  .pill.warn{background:var(--warn-tint);color:var(--warn-dk)}
  .pill.bad{background:var(--danger-tint);color:var(--danger-dk)}
  .pill.src{background:var(--accent-tint);color:var(--accent-deep)}
  .pill.mute{background:var(--line-soft);color:var(--muted)}

  .mk-table{width:100%;border-collapse:collapse;font-size:13px}
  .mk-table th{text-align:left;font-size:12px;color:var(--muted);font-weight:700;padding:9px 12px;
    background:var(--head-bg);border-bottom:1px solid var(--line);white-space:nowrap}
  .mk-table td{padding:10px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top}
  .mk-table tr.clickable{cursor:pointer}
  .mk-table tr.clickable:hover td{background:var(--row-hover)}
  .mk-table .co{font-weight:600;color:var(--ink)}
  .mk-table .who{color:var(--faint);font-size:12px;margin-top:2px}
  .mk-table .late{color:var(--danger-dk);font-weight:600}
  .mk-wrap{overflow-x:auto}

  .mk-stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
    gap:12px;margin-bottom:16px}
  .mk-stat{background:var(--head-bg);border-radius:var(--radius-sm);padding:12px 14px}
  .mk-stat .v{font-size:20px;font-weight:800;letter-spacing:-.02em}
  .mk-stat .l{font-size:12px;color:var(--muted);margin-top:3px;font-weight:600}
  .mk-stat.bad .v{color:var(--danger-dk)}
  .mk-stat.warn .v{color:var(--warn-dk)}

  .mk-notice{background:var(--warn-tint);border-left:3px solid var(--warn);
    border-radius:var(--radius-sm);padding:11px 14px;font-size:13px;
    color:var(--warn-dk);line-height:1.55;margin-bottom:16px}
  .mk-err{background:var(--danger-tint);border:1px solid var(--danger-line);
    border-radius:var(--radius-sm);padding:11px 14px;font-size:13px;
    color:var(--danger-dk);margin-bottom:14px}
  .mk-ok{background:var(--success-tint);border-radius:var(--radius-sm);
    padding:11px 14px;font-size:13px;color:var(--success-dk);margin-bottom:14px;font-weight:600}

  .mk-filters{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
  .mk-filters label{display:block;font-size:12px;color:var(--muted);font-weight:700;margin-bottom:4px}
  .mk-filters select{padding:7px 9px;border:1px solid var(--line);border-radius:var(--radius-sm);
    font:inherit;font-size:13px;color:var(--ink);background:var(--card)}
  .mk-seg{display:inline-flex;border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden}
  .mk-seg button{background:var(--card);border:0;padding:7px 12px;font:inherit;font-size:13px;
    color:var(--muted);cursor:pointer}
  .mk-seg button+button{border-left:1px solid var(--line)}
  .mk-seg button[aria-pressed="true"]{background:var(--accent-tint);color:var(--accent-deep);font-weight:700}

  .mk-field{margin-bottom:14px}
  .mk-field label,.mk-field .lbl{display:block;font-size:12px;color:var(--muted);font-weight:700;margin-bottom:5px}
  .mk-field .hint{font-size:12px;color:var(--faint);margin:-2px 0 6px;line-height:1.5}
  .mk-field input[type=text],.mk-field input[type=date],.mk-field input[type=url],
  .mk-field textarea,.mk-field select{width:100%;padding:9px 11px;
    border:1px solid var(--line);border-radius:var(--radius-sm);
    font-family:inherit;font-size:13px;color:var(--ink);background:var(--card)}
  .mk-field textarea{min-height:72px;resize:vertical;line-height:1.6}
  .mk-field input:focus,.mk-field textarea:focus,.mk-field select:focus{
    outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
  .mk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0 16px}
  .mk-grid .full{grid-column:1/-1}
  .mk-radio{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;margin-bottom:8px}
  .mk-radio label{display:flex;gap:6px;align-items:center;font-weight:500;color:var(--ink);margin:0}

  .mk-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .mk-empty{text-align:center;padding:34px 20px;color:var(--muted);font-size:13px;line-height:1.6}
  .mk-empty h4{font-size:14px;color:var(--ink);margin-bottom:6px;font-weight:700}

  /* New campaign: type picker */
  .mk-types{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
  .mk-type{text-align:left;background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-sm);padding:12px 14px;cursor:pointer;font:inherit;color:var(--ink)}
  .mk-type:hover{border-color:var(--accent);background:var(--accent-tint)}
  .mk-type .n{font-weight:700;font-size:13.5px}
  .mk-type .s{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.45}
  .mk-type .u{font-size:11.5px;color:var(--faint);margin-top:6px}
  .mk-type-group{font-size:12px;font-weight:700;color:var(--muted);margin:16px 0 8px}

  /* Campaign header */
  .mk-head{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px 22px}
  .mk-head .k{font-size:12px;color:var(--muted);font-weight:700}
  .mk-head .v{font-size:13.5px;color:var(--ink);margin-top:2px}
  .mk-head .v.none{color:var(--faint);font-style:italic}

  .mk-now{border-left:4px solid var(--accent);background:var(--accent-tint);
    border-radius:var(--radius-sm);padding:14px 16px;margin-bottom:18px}
  .mk-now .k{font-size:12px;font-weight:700;color:var(--accent-deep)}
  .mk-now .step{font-size:16px;font-weight:700;color:var(--ink);margin:3px 0 6px}
  .mk-now .facts{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:var(--muted)}
  .mk-now .facts b{color:var(--ink)}
  .mk-now .late{color:var(--danger-dk);font-weight:700}
  .mk-now.done{border-left-color:var(--success);background:var(--success-tint)}

  /* The six stages: the one strong element on the page. It is a real
     sequence, so it is numbered. */
  .mk-stages{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0;
    margin-bottom:20px;border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden;background:var(--card)}
  .mk-stage-tab{position:relative;padding:12px 12px 12px 14px;text-align:left;background:var(--card);
    border:0;border-right:1px solid var(--line-soft);font:inherit;cursor:pointer;color:var(--ink)}
  .mk-stage-tab:last-child{border-right:0}
  .mk-stage-tab .num{font-size:22px;font-weight:800;letter-spacing:-.03em;color:var(--faint);line-height:1}
  .mk-stage-tab .nm{font-size:12.5px;font-weight:700;margin-top:6px}
  .mk-stage-tab .ct{font-size:12px;color:var(--muted);margin-top:2px}
  .mk-stage-tab .bar{position:absolute;left:0;right:0;bottom:0;height:4px;background:var(--line-soft)}
  .mk-stage-tab .bar i{display:block;height:100%;background:var(--accent)}
  .mk-stage-tab.done .num{color:var(--success)}
  .mk-stage-tab.done .bar i{background:var(--success)}
  .mk-stage-tab.current{background:var(--accent-tint)}
  .mk-stage-tab.current .num{color:var(--accent)}
  .mk-stage-tab:hover{background:var(--row-hover)}
  @media (max-width:860px){.mk-stages{grid-template-columns:repeat(3,minmax(0,1fr))}
    .mk-stage-tab:nth-child(3){border-right:0}.mk-stage-tab:nth-child(-n+3){border-bottom:1px solid var(--line-soft)}}
  @media (max-width:480px){.mk-stages{grid-template-columns:repeat(2,minmax(0,1fr))}}

  .mk-stage{margin-bottom:22px;scroll-margin-top:80px}
  .mk-stage-hd{display:flex;gap:12px;align-items:baseline;margin-bottom:4px}
  .mk-stage-hd h2{font-size:17px;font-weight:800;letter-spacing:-.01em}
  .mk-stage-hd .ct{font-size:12.5px;color:var(--muted)}
  .mk-stage .about{font-size:13px;color:var(--muted);margin-bottom:10px;max-width:72ch}
  .mk-stage .nothing{font-size:13px;color:var(--faint);font-style:italic;padding:6px 0 4px}

  .mk-step{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card);margin-bottom:8px}
  .mk-step.is-done{background:var(--head-bg)}
  .mk-step.is-done .lbl{color:var(--muted);text-decoration:line-through;text-decoration-color:var(--faint)}
  .mk-step.is-na .lbl{color:var(--faint)}
  .mk-step.is-late{border-color:var(--danger-line)}
  .mk-step-row{display:grid;grid-template-columns:28px 1fr auto;gap:10px;align-items:start;padding:11px 12px}
  .mk-check{width:20px;height:20px;margin:1px 0 0;accent-color:var(--accent);cursor:pointer}
  .mk-check[disabled]{cursor:not-allowed}
  .mk-step .lbl{font-size:13.5px;font-weight:600;color:var(--ink);line-height:1.4}
  .mk-step .help{font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.5;max-width:78ch}
  .mk-step .facts{display:flex;gap:6px 16px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin-top:6px}
  .mk-step .facts b{color:var(--ink);font-weight:600}
  .mk-step .facts .late{color:var(--danger-dk);font-weight:700}
  .mk-step .wait{font-size:12.5px;color:var(--warn-dk);margin-top:6px}
  .mk-step .blocker{font-size:12.5px;color:var(--danger-dk);margin-top:6px;font-weight:600}
  .mk-step .noted{font-size:12.5px;color:var(--ink);margin-top:6px;white-space:pre-wrap;
    background:var(--head-bg);border-radius:var(--radius-sm);padding:6px 9px}
  .mk-step-side{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
  .mk-step-more{border-top:1px solid var(--line-soft);padding:12px 12px 4px 50px}
  @media (max-width:640px){.mk-step-row{grid-template-columns:28px 1fr}.mk-step-side{grid-column:2;justify-content:flex-start}
    .mk-step-more{padding-left:12px}}

  .mk-history{font-size:12.5px;color:var(--muted);line-height:1.6;max-height:280px;overflow:auto}
  .mk-history div{padding:3px 0;border-bottom:1px solid var(--line-soft)}
  .mk-history b{color:var(--ink);font-weight:600}

  .mk-steps-ref{font-size:13px}
  .mk-steps-ref details{border:1px solid var(--line);border-radius:var(--radius-sm);margin-bottom:8px;background:var(--card)}
  .mk-steps-ref summary{padding:10px 14px;cursor:pointer;font-weight:700}
  .mk-steps-ref summary span{color:var(--muted);font-weight:500;margin-left:8px}
  .mk-steps-ref ol{margin:0;padding:4px 18px 12px 40px}
  .mk-steps-ref li{padding:3px 0;line-height:1.45}
  .mk-steps-ref .st{font-size:12px;font-weight:700;color:var(--muted);margin:10px 14px 2px}
  .mk-steps-ref .o{color:var(--muted);font-size:12px}

  .mk-conn-add{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;padding:12px 18px;
    border-top:1px solid var(--line-soft);background:var(--head-bg)}
  .mk-conn-add .mk-field{margin:0;min-width:240px;flex:1}
  .mk-conn-note{font-size:12.5px;color:var(--muted);padding:10px 18px 0;line-height:1.5}
  .mk-conn-stats{padding:14px 18px 0}
  .mk-conn-stats .mk-stat-row{margin-bottom:12px}
  .mk-scope{font-size:13px;color:var(--muted);margin:-6px 0 14px}

  .mk-calcs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-bottom:14px}
  .mk-calc{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:14px 16px}
  .mk-calc .t{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .mk-calc .t h4{font-size:13.5px;font-weight:700}
  .mk-calc .r{font-size:26px;font-weight:800;letter-spacing:-.02em;margin:6px 0 2px;font-variant-numeric:tabular-nums}
  .mk-calc .r.neg{color:var(--danger-dk)}
  .mk-calc .st{font-size:13.5px;font-weight:600;color:var(--warn-dk);margin:10px 0 6px;line-height:1.45}
  .mk-calc .f{font-size:12.5px;color:var(--muted);font-family:var(--mono, ui-monospace, monospace);margin-bottom:8px;line-height:1.5}
  .mk-calc table{width:100%;border-collapse:collapse;font-size:12.5px}
  .mk-calc td{padding:4px 0;border-top:1px solid var(--line-soft);vertical-align:top}
  .mk-calc td.v{text-align:right;font-weight:600;white-space:nowrap;padding-left:10px;font-variant-numeric:tabular-nums}
  .mk-calc .src{color:var(--faint);font-size:11.5px}
  .mk-calc .up{font-size:11.5px;color:var(--faint);margin-top:8px}
  .mk-inputs{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:4px 16px}

  .mk-tl-month{margin-bottom:18px}
  .mk-tl-month h3{font-size:14px;font-weight:800;margin-bottom:8px}
  .mk-tl-row{display:grid;grid-template-columns:110px 170px 1fr auto;gap:10px;align-items:baseline;
    padding:8px 12px;border-bottom:1px solid var(--line-soft);font-size:13px;cursor:pointer}
  .mk-tl-row:hover{background:var(--row-hover)}
  .mk-tl-row .d{font-variant-numeric:tabular-nums;color:var(--muted)}
  .mk-tl-row .w{font-weight:600;color:var(--accent-deep)}
  @media (max-width:640px){.mk-tl-row{grid-template-columns:1fr}}
`;
