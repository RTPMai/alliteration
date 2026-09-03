/**
 * CrewCore — employee management for the whole team.
 *
 * v2, Aug 2026. No standalone to port from: the closest prior art was the
 * P&M internal Wix site (ryan7339.wixsite.com/pminternal), specifically
 * Company Structure (org chart) and Contact List (roster seed).
 *
 * PTO REMOVED this version — Ryan's call. Time off tracking stays in
 * QuickBooks, not duplicated here. There is no 'pto' view anymore; it isn't
 * hidden, it's gone, along with api/crewcore/pto.js.
 *
 * ADDED this version: apparel STIPEND tracking (an allotment per employee,
 * defaulted by department per the Handbook's Dress Code policy — $250
 * Front Office, $150 Production — plus a spend log an admin maintains), and
 * a read-only HANDBOOK view sourced from lib/crewcore/handbook-content.js,
 * itself sourced from the real Employee_Handbook.docx.
 *
 * SELF-SERVE, decided Aug 3 2026: an "employee" role (data_scope "own") can
 * see their own record (minus hourly rate and admin notes), their own
 * stipend allotment and spend history, their own review history read-only,
 * and the full Handbook (open to everyone with CrewCore access, not scoped).
 * Everyone else with the app granted (the admin role, or any account with
 * the elevated Admin flag) gets the full admin views. The split is enforced
 * server-side in api/crewcore/*.js — this file adapts what it RENDERS based
 * on ctx.perms, but never trusts the client to be the actual gate.
 *
 * THREE CHANGES, Aug 28 2026, all Ryan's calls:
 *
 *   1. ROSTER IS ADMIN-ONLY. It lists the whole team; that is not a screen
 *      everyone with a login should open. The self-serve profile card that
 *      used to be the employee's version of Roster moved to the DASHBOARD,
 *      which now has an employee half: their profile plus their own stipend
 *      balance, hours this pay week, next review and handbook status. An
 *      employee asking for 'roster' is sent there rather than shown a wall.
 *   2. TIME CLOCK is only for people who punch. permsFor() in lib/users.js
 *      strips the grant for anyone whose record has clock_enabled false, and
 *      _canClock() below is the guard behind that.
 *   3. REVIEWS OPEN. A row is a click into the whole review — summary,
 *      strengths, growth areas, dates. An admin can edit or delete from
 *      there; an employee reads their own and can do neither.
 *
 * TWO ADDITIONS, Sep 2026, both Ryan's calls, and they are opposites:
 *
 *   DOCUMENTATION. A place to write up an issue or a problem with somebody,
 *   sitting inside the Reviews screen because that is where anyone would
 *   look for it, and NOT VISIBLE TO THE PERSON IT IS ABOUT. It is not a
 *   view of its own: it is a tab inside Reviews, drawn only for an admin,
 *   over its own endpoint and its own storage. api/crewcore/docs.js refuses
 *   a non-admin caller on every method including GET, before it reads
 *   anything, so there is no filter anywhere that has to remember to keep
 *   an entry away from the employee. See the note above validateDoc() in
 *   lib/crewcore/schema.js for why it is not a flag on a review.
 *
 *   KUDOS. A way to hand out credit, from a manager or between employees,
 *   and the one screen in this app that a self-serve account can WRITE to.
 *   Shop-wide: everybody with CrewCore reads the same feed, because praise
 *   only two people can see is a private message. Nobody can give
 *   themselves kudos (refused on the server), there is no edit, and only
 *   the author or an admin can remove one — never the recipient.
 *
 * Nine views: Dashboard (admin: anniversaries + headline numbers;
 * self-serve: your profile and where you stand), Roster (admin only; full
 * list + add/edit), Time Clock (admin: whole team, correctable; self-serve:
 * your own hours, read-only, and only if you punch), Stipend (both: your
 * allotment, spend log, and remaining balance; admin also logs new spend
 * entries for anyone), Samples (SanMar sample drops and picks), Kudos
 * (everyone; read and write), Reviews (admin: full history + add/edit/delete
 * plus the documentation tab; self-serve: read-only own history), Handbook
 * (everyone; read-only), Settings (admin only; hidden from self-serve rails
 * by lib/users.js's per-view tabs).
 */

import { ENDPOINTS } from '../js/api.js';
// The stipend year math is shared with the API route and the store so a
// balance is never computed twice in two places. lib/crewcore/schema.js has
// no imports of its own, so it is safe to pull into the browser.
import { spendsFor, stipendBalance, stipendYears, spendLabel, isOverStipend, isCrewCoreAdmin,
  DOC_CATEGORIES, DOC_LEVELS, docsFor, isFormalDoc,
  KUDOS_TAGS, KUDOS_MAX_LENGTH, kudosFor, canDeleteKudos } from '../lib/crewcore/schema.js';

const DEPARTMENTS = ['Screen Printing', 'Embroidery', 'Sales', 'Art', 'Office'];
const STIPEND_CATEGORIES = ['apparel', 'other'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Days until the next work anniversary, and WHICH anniversary it is.
 *
 * `years` is the milestone being reached on that date, already: somebody who
 * started Feb 14 2022, asked in Aug 2026, is 169 days from their FIFTH.
 * Both dashboards used to print `years + 1` and so aged everybody by a year
 * — Amanda's dashboard said 6 years on the first deploy of the self-serve
 * screen (Aug 28 2026), which is how the off-by-one was finally spotted.
 */
function daysUntilAnniversary(startDate) {
  if (!startDate) return null;
  const start = new Date(startDate + 'T00:00:00');
  if (Number.isNaN(start.getTime())) return null;
  const now = new Date();
  const next = new Date(now.getFullYear(), start.getMonth(), start.getDate());
  if (next < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
    next.setFullYear(next.getFullYear() + 1);
  }
  const days = Math.round((next - now) / 86400000);
  const years = next.getFullYear() - start.getFullYear();
  return { days, years };
}

export default {
  id: 'crewcore',

  styles: `
  .cc-wrap{padding:24px 32px 60px;max-width:1200px}
  .cc-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px}
  .cc-hd h1{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .cc-hd .sub{font-size:13px;color:var(--muted);margin-top:2px}

  .cc-btn{
    background:var(--accent);color:var(--on-accent);border:none;border-radius:var(--radius-sm);
    padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;
  }
  .cc-btn:hover{filter:brightness(0.95)}
  .cc-btn.ghost{background:var(--card);color:var(--ink);border:1px solid var(--line)}
  .cc-btn.sm{padding:6px 11px;font-size:12px}
  .cc-btn:disabled{opacity:.5;cursor:not-allowed}

  .cc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin-bottom:22px}
  .cc-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:16px 18px;position:relative}
  .cc-card h3{font-size:12.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}
  .cc-card .big{font-size:26px;font-weight:800;letter-spacing:-.01em}
  .cc-card .note{font-size:12px;color:var(--muted);margin-top:4px}
  .cc-card.tap{cursor:pointer;transition:border-color .12s ease,transform .12s ease}
  .cc-card.tap:hover{border-color:var(--accent);transform:translateY(-1px)}
  .cc-card .cardhd{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
  .cc-card .cardhd h3{margin-bottom:0}

  /* Over the stipend. The card keeps its normal frame and picks up one red
     mark in the top right, so a grid of people reads at a glance and the
     flag is the only red thing on it. The card gets room on the right so a
     long name runs into the padding instead of under the mark. */
  .cc-card.over{padding-right:44px}
  .cc-flag{
    position:absolute;top:12px;right:12px;
    width:20px;height:20px;border-radius:50%;
    display:inline-grid;place-items:center;
    background:var(--danger);color:var(--on-accent);
    font-size:13px;font-weight:800;line-height:1;
  }
  .cc-card .note.over{color:var(--danger);font-weight:600}
  .cc-back{display:flex;align-items:center;gap:10px;margin-bottom:16px}
  .cc-rowacts{display:flex;align-items:center;gap:8px;flex-shrink:0}

  .cc-section{margin-bottom:26px}
  .cc-section h2{font-size:15px;font-weight:700;margin-bottom:10px}

  .cc-list{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden}
  .cc-row{
    display:flex;align-items:center;justify-content:space-between;gap:12px;
    padding:12px 16px;border-bottom:1px solid var(--line);
  }
  .cc-row:last-child{border-bottom:none}
  .cc-row .who{font-weight:600;font-size:13.5px}
  .cc-row .meta{font-size:12px;color:var(--muted)}
  .cc-empty{padding:30px;text-align:center;color:var(--muted);font-size:13px}

  /* A row that opens something. Matches .cc-table tr.clickable so a list and
     a table read the same way. */
  .cc-row.tap{cursor:pointer;transition:background .12s ease}
  .cc-row.tap:hover{background:var(--line-soft)}
  .cc-chev{color:var(--muted);font-size:18px;line-height:1}

  /* One line of a review's summary in the list. The whole thing is on the
     detail screen; the list is for finding the right one. */
  .cc-clamp{
    display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;
    overflow:hidden;max-width:640px;
  }

  /* Written-up text, line breaks intact. */
  .cc-prose{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);
    padding:14px 16px;font-size:13.5px;line-height:1.6;white-space:pre-wrap;max-width:760px;
  }

  .cc-btn.ghost.danger{color:var(--danger);border-color:var(--danger-tint)}
  .cc-btn.ghost.danger:hover{border-color:var(--danger)}

  .chip{display:inline-flex;align-items:center;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:600;background:var(--line-soft);color:var(--ink)}
  .chip.terminated{background:var(--danger-tint);color:var(--danger)}
  .chip.on_leave{background:var(--line-soft);color:var(--muted)}

  .cc-table{width:100%;border-collapse:collapse;font-size:13px}
  .cc-table th{text-align:left;color:var(--muted);font-weight:600;padding:9px 14px;border-bottom:1px solid var(--line);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em}
  .cc-table td{padding:11px 14px;border-bottom:1px solid var(--line)}
  .cc-table tr:last-child td{border-bottom:none}
  .cc-table tr.clickable{cursor:pointer}
  .cc-table tr.clickable:hover{background:var(--line-soft)}

  .cc-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
  .cc-toolbar .lbl{font-size:12px;color:var(--muted);font-weight:600}
  .cc-search{
    flex:1 1 200px;border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:8px 12px;font-size:13px;font-family:inherit;background:var(--card);color:var(--ink);
  }
  .cc-filt{
    border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card);
    padding:8px 10px;font-size:13px;font-family:inherit;color:var(--ink);
  }

  .cc-profile{max-width:560px}
  .cc-profile-hd{display:flex;align-items:center;gap:14px;margin-bottom:18px}
  .cc-avatar{
    width:56px;height:56px;border-radius:50%;background:var(--accent-tint);color:var(--accent-deep);
    display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;flex-shrink:0;
  }
  .cc-profile-hd h2{font-size:19px;font-weight:800}
  .cc-profile-hd .sub{font-size:13px;color:var(--muted)}
  .cc-field-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 20px}
  .cc-field{padding:10px 0;border-bottom:1px solid var(--line-soft)}
  .cc-field label{display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin-bottom:3px}
  .cc-field .v{font-size:14px;font-weight:600}

  .cc-form{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:18px 20px;margin-bottom:18px}
  .cc-form h3{font-size:14px;font-weight:700;margin-bottom:12px}
  .cc-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
  .cc-form-grid label{display:block;font-size:11.5px;font-weight:600;color:var(--muted);margin-bottom:4px}
  .cc-form-grid input,.cc-form-grid select,.cc-form-grid textarea{
    width:100%;border:1px solid var(--line);border-radius:var(--radius-sm);padding:8px 10px;
    font-size:13px;font-family:inherit;background:var(--bg);color:var(--ink);box-sizing:border-box;
  }
  .cc-form-grid .full{grid-column:1/-1}
  .cc-form-actions{display:flex;gap:8px;margin-top:14px;justify-content:flex-end}
  .cc-err{color:var(--danger);font-size:12.5px;margin-top:8px}

  .cc-locked{padding:60px 20px;text-align:center;color:var(--muted)}
  .cc-locked h2{color:var(--ink);font-size:17px;margin-bottom:8px}

  .cc-balance-bar{
    height:8px;border-radius:99px;background:var(--line-soft);overflow:hidden;margin-top:6px;
  }
  .cc-balance-bar .fill{height:100%;background:var(--accent);border-radius:99px}
  .cc-balance-bar.over .fill{background:var(--danger)}

  .cc-hb-cover{
    text-align:center;padding:36px 20px 30px;margin-bottom:28px;
    border-bottom:1px solid var(--line);
  }
  .cc-hb-cover-mark{font-size:28px;font-weight:800;letter-spacing:-.02em;margin-bottom:14px}
  .cc-hb-cover-mark .w1{color:var(--accent)}
  .cc-hb-cover-mark .w2{color:var(--wordmark-ink)}
  .cc-hb-cover-mark .dot{color:var(--accent)}
  .cc-hb-cover-title{font-size:26px;font-weight:800;letter-spacing:-.015em;margin-bottom:8px}
  .cc-hb-cover-sub{font-size:12.5px;color:var(--muted);font-weight:600;letter-spacing:.02em}

  .cc-hb-nav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid var(--line)}
  .cc-hb-navbtn{
    display:inline-flex;align-items:center;gap:7px;
    border:1px solid var(--line);background:var(--card);border-radius:var(--radius-pill);
    padding:5px 12px 5px 8px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit;
    transition:border-color .15s,color .15s;
  }
  .cc-hb-navbtn:hover{color:var(--ink);border-color:var(--accent)}
  .cc-hb-navbtn-story{padding-left:12px}
  .cc-hb-navnum{
    display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;
    background:var(--accent-tint);color:var(--accent-deep);font-size:9.5px;font-weight:800;flex-shrink:0;
  }

  .cc-hb-story-rule{
    display:flex;align-items:center;gap:12px;margin:0 0 20px;
    font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-deep);
  }
  .cc-hb-story-rule::before{content:'';flex:1 1 auto;height:1px;background:var(--line)}
  .cc-hb-story-rule::after{content:'';flex:1 1 auto;height:1px;background:var(--line)}

  .cc-hb-story{
    background:var(--accent-tint);border-radius:var(--radius-md);
    padding:8px 24px 4px;margin-bottom:36px;
  }
  .cc-hb-story .cc-hb-story-rule{color:var(--accent-deep);padding-top:16px}
  .cc-hb-story .cc-hb-story-rule::before,.cc-hb-story .cc-hb-story-rule::after{background:var(--accent-deep);opacity:.25}
  .cc-hb-story-section h2{color:var(--accent-deep)}

  .cc-hb-section{margin-bottom:36px;scroll-margin-top:16px;position:relative}
  .cc-hb-chapnum{
    font-size:34px;font-weight:800;color:var(--accent-tint);line-height:1;
    position:absolute;top:-4px;right:0;letter-spacing:-.02em;user-select:none;
    -webkit-text-stroke:1px var(--accent);
  }
  .cc-hb-section h2{
    font-size:19px;font-weight:800;margin-bottom:14px;letter-spacing:-.015em;
    padding-bottom:10px;border-bottom:2px solid var(--accent);display:inline-block;
  }
  .cc-hb-section h3{font-size:13.5px;font-weight:700;margin:18px 0 6px;color:var(--accent-deep)}
  .cc-hb-section p{font-size:13.5px;line-height:1.7;color:var(--ink);margin-bottom:10px;max-width:640px}
  .cc-hb-section ul{margin:0 0 10px 20px;padding:0;max-width:640px}
  .cc-hb-section li{font-size:13.5px;line-height:1.7;margin-bottom:5px}
  .cc-hb-updated{font-size:12px;color:var(--muted);margin-top:10px}

  .cc-hb-ack{
    display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;
    border-radius:var(--radius-md);padding:16px 20px;margin-bottom:28px;
  }
  .cc-hb-ack-pending{background:var(--accent-tint);border:1px solid var(--accent)}
  .cc-hb-ack-done{background:var(--success-tint);border:1px solid var(--success)}
  .cc-hb-ack-text{font-size:13px;line-height:1.5;color:var(--ink)}
  .cc-hb-ack-text strong{display:block;font-size:14px;margin-bottom:2px}
  .cc-hb-ack-pending .cc-hb-ack-text strong{color:var(--accent-deep)}
  .cc-hb-ack-done .cc-hb-ack-text strong{color:var(--success-dk)}
  .cc-hb-ack-bottom{margin-top:8px;margin-bottom:0}

  /* ---- Time Clock ---- */
  .tc-weeknav{display:flex;align-items:center;gap:8px}
  .tc-weeklabel{font-size:13px;font-weight:700;min-width:190px;text-align:center}
  .tc-spacer{flex:1 1 auto}

  .tc-now{
    display:flex;flex-wrap:wrap;gap:8px;align-items:center;
    background:var(--success-tint);border:1px solid var(--success);
    border-radius:var(--radius-md);padding:11px 14px;margin-bottom:16px;
  }
  .tc-now .lbl{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--success-dk);margin-right:4px}
  .tc-now .pill{
    display:inline-flex;align-items:center;gap:6px;background:var(--card);
    border-radius:var(--radius-pill);padding:4px 11px;font-size:12.5px;font-weight:600;
  }
  .tc-now .pill .t{color:var(--muted);font-weight:600}

  .tc-alert{
    background:var(--warn-tint);border:1px solid var(--warn);
    border-radius:var(--radius-md);padding:11px 14px;margin-bottom:16px;font-size:12.5px;
  }
  .tc-alert strong{display:block;font-size:13px;margin-bottom:3px;color:var(--warn-dk)}
  .tc-alert ul{margin:4px 0 0 18px;padding:0}
  .tc-alert li{margin-bottom:2px}

  .tc-grid{width:100%;border-collapse:collapse;font-size:13px;background:var(--card)}
  .tc-grid th{
    text-align:right;color:var(--muted);font-weight:600;padding:9px 10px;
    border-bottom:1px solid var(--line);font-size:11px;text-transform:uppercase;letter-spacing:.03em;
  }
  .tc-grid th.who,.tc-grid td.who{text-align:left}
  .tc-grid th .dnum{display:block;font-size:10px;font-weight:600;color:var(--muted);text-transform:none;letter-spacing:0}
  .tc-grid td{padding:10px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums}
  .tc-grid tbody tr{cursor:pointer}
  .tc-grid tbody tr.emprow:hover{background:var(--line-soft)}
  .tc-grid td.who{font-weight:600}
  .tc-grid td.who .dept{display:block;font-size:11.5px;color:var(--muted);font-weight:500}
  .tc-grid td.zero{color:var(--line)}
  .tc-grid td.total{font-weight:800}
  .tc-grid td.ot{color:var(--warn-dk);font-weight:700}
  .tc-grid tr.today-col td{background:var(--accent-tint)}
  .tc-grid tfoot td{font-weight:800;border-top:2px solid var(--line);border-bottom:none;padding-top:12px}
  .tc-flagdot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--warn);margin-left:6px;vertical-align:middle}

  .tc-detail{background:var(--bg)}
  .tc-detail td{padding:0;text-align:left}
  .tc-shifts{padding:10px 14px 14px}
  .tc-shift{
    display:flex;align-items:center;gap:10px;flex-wrap:wrap;
    padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:12.5px;
  }
  .tc-shift:last-child{border-bottom:none}
  .tc-shift .d{font-weight:700;min-width:104px}
  .tc-shift .times{font-variant-numeric:tabular-nums}
  .tc-shift .h{font-weight:700;min-width:56px;text-align:right;font-variant-numeric:tabular-nums}
  .tc-shift .grow{flex:1 1 auto}
  .tc-shift .note{color:var(--muted);font-style:italic}
  .tc-miss{color:var(--danger);font-weight:700}

  .tc-mine{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;margin-bottom:20px}
  .tc-day{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);
    padding:10px 8px;text-align:center;
  }
  .tc-day.today{border-color:var(--accent);background:var(--accent-tint)}
  .tc-day .dl{font-size:10.5px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .tc-day .dn{font-size:11px;color:var(--muted);margin-bottom:5px}
  .tc-day .dh{font-size:17px;font-weight:800;font-variant-numeric:tabular-nums}
  .tc-day .dh.none{color:var(--line)}
  @media (max-width:720px){.tc-mine{grid-template-columns:repeat(4,1fr)}}

  .tc-kiosk{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);
    padding:14px 16px;margin-bottom:18px;font-size:12.5px;color:var(--muted);
  }
  .tc-kiosk code{
    display:inline-block;background:var(--line-soft);border-radius:var(--radius-sm);
    padding:3px 8px;font-size:12.5px;color:var(--ink);font-weight:600;
  }
  /* Shift editor opens in a modal, matching MailMe. Prepending a form to the
     top of the body pushed the whole week grid down, so the row you were
     correcting jumped off screen the moment you clicked Fix.
     Carries MailMe's two hard-won constraints verbatim:
     z-index must clear the shell header (200), and the backdrop is attached
     to <body> rather than the app root, because .view runs a transform
     animation and a transformed ancestor makes position:fixed resolve
     against IT, pinning the modal under the header. */
  .cc-modal-back{position:fixed;inset:0;background:rgba(15,20,28,.55);
    z-index:400;overflow-y:auto;padding:40px 16px}
  /* Centred with auto margins, not flex: a flex item taller than its
     container gets its overflowing top clipped and unreachable by scroll. */
  .cc-modal{background:var(--card);border-radius:12px;width:100%;
    max-width:560px;margin:0 auto;box-shadow:0 18px 50px rgba(0,0,0,.3);
    position:relative}
  .cc-modal .cc-form{border:0;margin:0}
  .cc-modal-x{position:absolute;top:12px;right:14px;border:0;background:transparent;
    font-size:22px;line-height:1;cursor:pointer;color:var(--muted);padding:4px 8px;
    font-family:inherit}
  .cc-modal-x:hover{color:var(--ink)}

  /* Samples (SanMar sample drops) */
  .cc-note{background:var(--line-soft);border:1px solid var(--line);border-radius:var(--radius-md);padding:12px 14px;margin-bottom:16px;font-size:13.5px}
  .cc-note.over{border-color:var(--danger);color:var(--danger)}
  .cc-note .note{font-size:12px;color:var(--muted);margin-top:3px}
  .cc-note .cc-balance-bar{margin-top:8px}
  .cc-pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;background:var(--line-soft);color:var(--muted);border:1px solid var(--line)}
  .cc-pill.on{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
  .cc-sec{margin-top:26px}
  .cc-sec h3{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:8px}
  .cc-sec h3 .note{text-transform:none;letter-spacing:0;font-weight:500;margin-left:8px}
  .cc-rows{border:1px solid var(--line);border-radius:var(--radius-md);background:var(--card)}
  .cc-rows .cc-row{display:flex;align-items:center;gap:12px;padding:10px 14px}
  .cc-rows .cc-row .grow{flex:1;min-width:0}
  .cc-rows .cc-row .amt{font-weight:700;font-variant-numeric:tabular-nums}
  .cc-rows .cc-row .sw{width:26px;height:26px;border-radius:4px;overflow:hidden;border:1px solid var(--line);flex:none}
  .cc-rows .cc-row .sw img{width:100%;height:100%;object-fit:cover}
  .cc-btn.sm{padding:4px 10px;font-size:12px}
  .cc-cat{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px}
  .cc-tile{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden}
  .cc-tile .shot{aspect-ratio:3/4;background:var(--line-soft);display:flex;align-items:center;justify-content:center}
  .cc-tile .shot img{width:100%;height:100%;object-fit:contain}
  .cc-tile-b{padding:10px 12px}
  .cc-tile-b .s{font-size:12.5px;font-weight:700;display:flex;align-items:center;gap:6px;justify-content:space-between}
  .cc-tile-b .t{font-size:12.5px;margin-top:3px;line-height:1.3}
  .cc-style{display:grid;grid-template-columns:minmax(180px,280px) 1fr;gap:22px;margin-top:14px}
  .cc-style .shot.big{aspect-ratio:3/4;background:var(--line-soft);border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden}
  .cc-style .shot.big img{width:100%;height:100%;object-fit:contain}
  .cc-style h3{font-size:16px;font-weight:700}
  .cc-style .note.lbl{margin-top:14px;font-weight:600;color:var(--muted)}
  .cc-swatches{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
  .cc-swatch{width:30px;height:30px;border-radius:5px;border:2px solid var(--line);overflow:hidden;padding:0;background:var(--line-soft);cursor:pointer;font-size:10px}
  .cc-swatch.on{border-color:var(--accent)}
  .cc-swatch img{width:100%;height:100%;object-fit:cover;display:block}
  .cc-sizes{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
  .cc-size{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:56px;padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--card);cursor:pointer;font-size:12.5px;font-weight:700}
  .cc-size:hover{border-color:var(--accent)}
  .cc-size .p{font-weight:500;color:var(--muted);font-size:11.5px}
  .cc-form .hint{font-size:12.5px;color:var(--muted);line-height:1.5;margin-bottom:12px}
  .cc-form textarea{width:100%;font-family:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--line);border-radius:var(--radius-md);background:var(--card);color:inherit}
  @media (max-width:720px){ .cc-style{grid-template-columns:1fr} }
  .tc-pinstate{font-size:11.5px;font-weight:700;margin-top:5px}
  .tc-pinstate.set{color:var(--success-dk)}
  .tc-pinstate.unset{color:var(--warn-dk)}

  /* Tabs WITHIN one view. Reviews holds two different files on one screen
     (the review history and the documentation of issues), which is where
     anybody would look for either. The rail has one Reviews button; this is
     the switch once you are inside it. */
  .cc-tabs{display:flex;gap:4px;margin-bottom:18px;border-bottom:1px solid var(--line)}
  .cc-tab{
    background:transparent;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;
    padding:9px 13px;font-family:inherit;font-size:13px;font-weight:700;
    color:var(--muted);cursor:pointer;
  }
  .cc-tab:hover{color:var(--ink)}
  .cc-tab.on{color:var(--ink);border-bottom-color:var(--accent)}
  .cc-tab .n{font-weight:600;color:var(--faint);margin-left:6px}

  /* Documentation. The banner is not decoration: it is the one line that
     says out loud who can read this, on the screen where somebody is about
     to write something they would not say in front of the person. */
  .cc-doc-warn{
    background:var(--warn-tint);border:1px solid var(--warn);border-radius:var(--radius-md);
    padding:11px 14px;margin-bottom:16px;font-size:12.5px;line-height:1.55;color:var(--ink);
  }
  .chip.formal{background:var(--danger-tint);color:var(--danger-dk)}
  .chip.note{background:var(--line-soft);color:var(--muted)}

  /* Kudos */
  .cc-kudos{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px}
  .cc-kudo{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);
    padding:15px 17px;position:relative;
  }
  .cc-kudo.mine{border-color:var(--accent)}
  .cc-kudo .to{font-size:14.5px;font-weight:800;letter-spacing:-.01em;padding-right:22px}
  .cc-kudo .msg{font-size:13.5px;line-height:1.55;margin:9px 0 11px;white-space:pre-wrap}
  .cc-kudo .from{font-size:12px;color:var(--muted)}
  .cc-kudo-x{
    position:absolute;top:11px;right:12px;border:0;background:transparent;
    color:var(--faint);cursor:pointer;font-size:16px;line-height:1;font-family:inherit;
  }
  .cc-kudo-x:hover{color:var(--danger)}
  .cc-tag{
    display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:99px;
    background:var(--accent-tint);color:var(--accent-deep);
  }
  .cc-count{font-size:12px;color:var(--muted);margin-bottom:12px}
  `,

  template: `
    <div class="cc-wrap">
      <div class="cc-hd">
        <div>
          <h1 id="ccTitle">CrewCore.</h1>
          <div class="sub" id="ccSub"></div>
        </div>
        <div id="ccHdActions"></div>
      </div>
      <div id="ccBody"></div>
    </div>
  `,

  async mount(ctx) {
    this._root = ctx.root;
    this._ctx = ctx;
    // Superuser flag or the protected admin role, NOT data_scope. A new role
    // created in Settings defaults to data_scope "all", which used to make any
    // custom role a full CrewCore admin the moment CrewCore was ticked for it.
    // See isCrewCoreAdmin() in lib/crewcore/schema.js. The server enforces the
    // same rule; this only decides what gets drawn.
    const isAdmin = isCrewCoreAdmin({
      superuser: ctx.perms && ctx.perms.superuser,
      roleName: ctx.perms && ctx.perms.role,
    });
    this._isAdmin = isAdmin;

    // Employees list (admin) or own record (self-serve) — same endpoint,
    // server decides the shape.
    const empPayload = await ctx.api.get(ENDPOINTS.ccEmployees);
    this._employees = isAdmin ? (empPayload.employees || []) : [];
    this._own = isAdmin ? null : (empPayload.employee || null);

    this._stipendSpends = [];
    this._stipendBalance = null;
    // The stipend re-ups every Jan 1, so every figure on that screen is
    // scoped to a year. Default to the one we are standing in.
    this._stipendYear = new Date().getFullYear();
    this._stipendDetailId = null;
    this._reviews = [];
    // Which review is open, if any. Reviews are a list until a row is
    // clicked; the same key drives the admin and the self-serve detail.
    this._reviewDetailId = null;

    // The Reviews screen holds two files for an admin: the review history
    // and the documentation of issues. 'reviews' or 'docs', and it is only
    // ever anything but 'reviews' for an admin — a self-serve caller has no
    // second tab to switch to and no endpoint behind it if they tried.
    this._reviewTab = 'reviews';
    this._docs = [];
    this._docDetailId = null;
    this._docPerson = '';        // '' means everybody

    this._kudos = [];
    this._kudosPeople = [];      // names only, from the kudos endpoint
    this._kudosNames = {};       // id -> name, for resolving the feed
    this._kudosMe = null;        // { username, employee_id, is_admin }
    this._kudosFilter = 'all';   // all | mine | given
    this._handbook = null;
    // Figures for the self-serve Dashboard, each loaded independently so one
    // failing fetch costs one card rather than the whole screen.
    this._selfCards = null;

    // Self-serve callers with a linked employee record need to know their
    // acknowledgment status up front, before routing to any view — that's
    // what the showView() gate below checks. Admins and unlinked self-serve
    // callers (no employee record yet) skip this: an admin isn't gated, and
    // an unlinked caller already sees the "ask an admin to link you" screen
    // on Roster, which takes priority over a handbook prompt they can't
    // meaningfully act on differently.
    if (!isAdmin && this._own) {
      await this._loadHandbook();
    }
  },

  async _loadStipend() {
    // The year matters to the server only for the self-serve balance; an
    // admin gets the whole log and the screen does its own filtering, so a
    // year change never costs an admin a round trip.
    const payload = await this._ctx.api.get(ENDPOINTS.ccStipend, { year: this._stipendYear });
    this._stipendSpends = payload.spends || [];
    this._stipendBalance = payload.balance || null;
  },

  async _loadReviews() {
    const payload = await this._ctx.api.get(ENDPOINTS.ccReviews);
    this._reviews = payload.reviews || [];
  },

  /**
   * Documentation. Admin only, and the fetch is guarded here as well as on
   * the server: a self-serve caller has no reason to make a request that can
   * only ever come back 403, and an unexplained red line in their console is
   * a support question waiting to happen.
   */
  async _loadDocs() {
    if (!this._isAdmin) { this._docs = []; return; }
    const payload = await this._ctx.api.get(ENDPOINTS.ccDocs);
    this._docs = payload.docs || [];
  },

  async _loadKudos() {
    const payload = await this._ctx.api.get(ENDPOINTS.ccKudos);
    this._kudos = payload.kudos || [];
    this._kudosPeople = payload.people || [];
    this._kudosNames = payload.names || {};
    this._kudosMe = payload.me || null;
  },

  async _loadHandbook() {
    if (this._handbook) return; // static content, fetch once per mount
    const payload = await this._ctx.api.get(ENDPOINTS.ccHandbook);
    this._handbook = payload;
  },

  async _loadSettings() {
    const payload = await this._ctx.api.get(ENDPOINTS.ccSettings);
    this._settings = payload.settings || {
      default_stipend_front_office: 250, default_stipend_production: 150, self_serve_enabled: true
    };
  },

  async showView(view) {
    const root = this._root;
    if (!root) return;
    const $ = (sel) => root.querySelector(sel);
    const title = $('#ccTitle');
    const sub = $('#ccSub');
    const actions = $('#ccHdActions');
    const body = $('#ccBody');
    const isAdmin = this._isAdmin;

    actions.innerHTML = '';

    // GATE: a self-serve caller with a linked record who hasn't agreed to
    // the CURRENT handbook version gets sent here regardless of which view
    // they asked for, with one deliberate exception — 'handbook' itself,
    // since they need to be able to read it in order to agree to it. This
    // mirrors the "unlinked record" screen's precedent (apps/crewcore.js
    // _renderProfileSelf): block, but don't leave the person stuck with no
    // path forward.
    if (!isAdmin && this._own && this._handbook && this._handbook.acknowledged === false && view !== 'handbook') {
      view = 'handbook';
    }

    // ROSTER IS ADMIN-ONLY (Aug 2026). A self-serve caller reaching it — a
    // bookmark, a stored last-view, a hand-typed hash — goes to the
    // Dashboard, which is where their own profile card lives now. A redirect
    // rather than a locked screen: there is nothing here they are missing
    // out on, the thing they wanted is one view over.
    if (!isAdmin && view === 'roster') {
      view = 'dashboard';
    }

    if (view === 'dashboard') {
      title.textContent = 'Dashboard.';
      if (isAdmin) {
        sub.textContent = 'Anniversaries and headline numbers.';
        // Kudos in its own try, like every card on the self-serve dashboard:
        // one endpoint having a bad day costs one number, not the screen.
        try { await this._loadKudos(); }
        catch (e) { console.error('CrewCore dashboard: kudos', e); this._kudos = []; }
        body.innerHTML = this._renderDashboard();
        this._wireDashboardAdmin();
        return;
      }
      sub.textContent = 'Your profile and where you stand.';
      await this._loadSelfDashboard();
      body.innerHTML = this._renderDashboardSelf();
      this._wireDashboardSelf();
      return;
    }

    if (view === 'roster') {
      title.textContent = 'Roster.';
      if (!isAdmin) {
        // Not reachable through the rail (the employee role has no
        // crewcore:roster grant) and the redirect above catches the rest.
        // Kept as the same belt-and-braces guard every other admin view has.
        sub.textContent = '';
        body.innerHTML = `<div class="cc-locked"><h2>Admin access required</h2>
          <p>The roster is the whole team's records. Your own profile is on the Dashboard.</p></div>`;
        return;
      }
      sub.textContent = this._employees.length + ' ' + (this._employees.length === 1 ? 'person' : 'people');
      actions.innerHTML = `<button class="cc-btn" id="ccAddBtn">Add employee</button>`;
      const addBtn = $('#ccAddBtn');
      if (addBtn) addBtn.onclick = () => this._openEmployeeForm(null);
      body.innerHTML = this._renderRosterAdmin();
      this._wireRosterAdmin();
      return;
    }

    if (view === 'timeclock') {
      // Only for people who punch. permsFor() keeps the tab out of a
      // salaried employee's rail; this is the guard behind that, for a
      // stored view key or a typed hash.
      if (!isAdmin && !this._canClock()) {
        title.textContent = 'Time Clock.';
        sub.textContent = '';
        body.innerHTML = `<div class="cc-locked"><h2>Nothing to show here</h2>
          <p>You're not set up to clock in and out, so there are no hours on file for you.</p></div>`;
        return;
      }
      title.textContent = 'Time Clock.';
      sub.textContent = isAdmin ? 'Hours by employee and pay week.' : 'Your hours.';
      if (!this._tcWeek) this._tcWeek = '';   // '' means "whatever week today is in"
      await this._loadTimecards();
      if (isAdmin) {
        actions.innerHTML = `
          <button class="cc-btn ghost" id="tcExport">Export CSV</button>
          <button class="cc-btn" id="tcAdd">Add a shift</button>`;
        const ex = $('#tcExport');
        if (ex) ex.onclick = () => this._exportTimecards();
        const add = $('#tcAdd');
        if (add) add.onclick = () => this._openShiftForm(null);
        body.innerHTML = this._renderTimeclockAdmin();
        this._wireTimeclockAdmin();
      } else {
        body.innerHTML = this._renderTimeclockSelf();
        this._wireTimeclockSelf();
      }
      return;
    }

    if (view === 'stipend') {
      title.textContent = 'Stipend.';
      sub.textContent = isAdmin ? 'Apparel allotments and spend across the team.' : 'Your apparel allotment and spend.';
      // Entering the view from the rail always lands on the grid. Coming in
      // from the rail while a person's detail is open should be a way out of
      // it, not a no-op. In-place refreshes go through _refreshStipend(),
      // which deliberately keeps whoever is open.
      this._stipendDetailId = null;
      await this._loadStipend();
      body.innerHTML = this._renderStipend();
      this._syncStipendActions();
      this._wireStipend();
      return;
    }

    if (view === 'samples') {
      title.textContent = 'Samples.';
      sub.textContent = isAdmin
        ? 'SanMar sample drops, picks and the sheet that goes back to them.'
        : 'Pick your SanMar samples.';
      // Entering from the rail always lands on the catalog, never on whatever
      // style was open last time, the same rule the stipend detail follows.
      this._sampleStyleOpen = null;
      await this._loadSamples();
      if (this._sampleDropId) await this._loadSampleDrop();
      body.innerHTML = this._renderSamples();
      this._syncSampleActions();
      this._wireSamples();
      return;
    }

    if (view === 'reviews') {
      title.textContent = 'Reviews.';
      sub.textContent = isAdmin ? 'One-on-one review history for the team.' : 'Your review history.';
      // Coming in from the rail always lands on the list, the same rule the
      // stipend detail follows. In-place refreshes go through
      // _refreshReviews(), which keeps whichever review is open.
      this._reviewDetailId = null;
      this._docDetailId = null;
      // And always on the review history rather than whichever tab was open
      // last time. Documentation is the more sensitive half; a stale tab is
      // not the thing to leave on screen.
      this._reviewTab = 'reviews';
      await this._loadReviews();
      // Documentation loads alongside, admin only, so the tab can carry its
      // count without a second wait when it is clicked. Its own try: a
      // failure there must not cost the review history, which is the half
      // everybody opens this screen for.
      if (isAdmin) {
        try { await this._loadDocs(); }
        catch (e) { console.error('CrewCore: documentation', e); this._docs = []; }
      }
      this._paintReviewScreen();
      return;
    }

    if (view === 'kudos') {
      title.textContent = 'Kudos.';
      sub.textContent = 'Credit where it is due, from anybody to anybody.';
      this._kudosFilter = 'all';
      await this._loadKudos();
      actions.innerHTML = `<button class="cc-btn" id="ccAddKudosBtn">Give kudos</button>`;
      const kb = $('#ccAddKudosBtn');
      if (kb) kb.onclick = () => this._openKudosForm();
      body.innerHTML = this._renderKudos();
      this._wireKudos();
      return;
    }

    if (view === 'handbook') {
      title.textContent = 'Handbook.';
      sub.textContent = 'P&M Apparel Employee Handbook.';
      await this._loadHandbook();
      body.innerHTML = this._renderHandbook();
      this._wireHandbook();
      return;
    }

    if (view === 'settings') {
      // Not reachable by a self-serve caller — allowedViews() in
      // js/registry.js scopes the "employee" role to dashboard/roster/
      // stipend/reviews/handbook only, so this view never appears in their
      // rail. Still guard here rather than trust the rail alone, same as
      // every other app.
      if (!isAdmin) {
        title.textContent = 'Settings.';
        sub.textContent = '';
        body.innerHTML = `<div class="cc-locked"><h2>Admin access required</h2></div>`;
        return;
      }
      title.textContent = 'Settings.';
      sub.textContent = 'Shop-wide CrewCore defaults.';
      await this._loadSettings();
      body.innerHTML = this._renderSettings();
      this._wireSettings();
      return;
    }
  },

  /* ---------------- Dashboard (admin) ---------------- */

  _renderDashboard() {
    const upcoming = this._employees
      .map((e) => ({ e, ann: daysUntilAnniversary(e.start_date) }))
      .filter((x) => x.ann && x.ann.days <= 60)
      .sort((a, b) => a.ann.days - b.ann.days);

    const active = this._employees.filter((e) => e.status === 'active');
    const totalStipendAllotted = active.reduce((sum, e) => sum + (Number(e.apparel_stipend) || 0), 0);

    // Kudos handed out this calendar month. A month rather than a year
    // because the question this card answers is whether the thing is being
    // used, and a year-to-date figure in November says yes long after
    // everybody stopped.
    const thisMonth = new Date().toISOString().slice(0, 7);
    const kudosThisMonth = (this._kudos || [])
      .filter((k) => String(k.created_at || '').slice(0, 7) === thisMonth).length;

    return `
      <div class="cc-grid" id="ccAdminCards">
        <div class="cc-card">
          <h3>Team</h3>
          <div class="big">${active.length}</div>
          <div class="note">active employees</div>
        </div>
        <div class="cc-card tap" data-go="kudos">
          <h3>Kudos this month</h3>
          <div class="big">${kudosThisMonth}</div>
          <div class="note">${kudosThisMonth ? 'handed out so far' : 'nothing yet this month'}</div>
        </div>
        <div class="cc-card">
          <h3>Apparel stipends</h3>
          <div class="big">${fmtMoney(totalStipendAllotted)}</div>
          <div class="note">total allotted this year</div>
        </div>
        <div class="cc-card">
          <h3>Upcoming anniversaries</h3>
          <div class="big">${upcoming.length}</div>
          <div class="note">within 60 days</div>
        </div>
      </div>

      <div class="cc-section">
        <h2>Upcoming anniversaries</h2>
        <div class="cc-list">
          ${upcoming.length ? upcoming.map((x) => `
            <div class="cc-row">
              <div>
                <div class="who">${esc(x.e.name)}</div>
                <div class="meta">${esc(x.e.title || x.e.department || '')}</div>
              </div>
              <div class="meta">${x.ann.years} ${x.ann.years === 1 ? 'year' : 'years'} · ${x.ann.days === 0 ? 'today' : x.ann.days + 'd'}</div>
            </div>
          `).join('') : `<div class="cc-empty">Nothing in the next 60 days.</div>`}
        </div>
      </div>
    `;
  },

  /* ---------------- Dashboard (self-serve) ----------------
   *
   * What an employee lands on since Roster went admin-only. The profile card
   * is the same one that used to BE their Roster view, so nothing they could
   * see before was taken away — it moved, and picked up the three numbers
   * they otherwise had to open three tabs to find.
   */

  /**
   * Does this person punch a clock? clock_enabled defaults ON for a new
   * record (see lib/crewcore/schema.js), so anything but an explicit false
   * counts. An unlinked caller has no record and therefore no hours.
   */
  _canClock() {
    return !!(this._own && this._own.clock_enabled !== false);
  },

  /**
   * Four independent fetches, each in its own try. A dashboard is the worst
   * place for an all-or-nothing load: one endpoint having a bad day would
   * otherwise blank the screen an employee opens the app on, with no clue
   * which of four things broke. A failed card is simply not drawn.
   */
  async _loadSelfDashboard() {
    const cards = { stipend: null, hours: null, overtime: 0, nextReview: null, lastReview: null, handbook: null, kudos: null, lastKudos: null };
    this._selfCards = cards;
    if (!this._own) return;

    try {
      await this._loadStipend();
      cards.stipend = this._stipendBalance;
    } catch (e) { console.error('CrewCore dashboard: stipend', e); }

    if (this._canClock()) {
      try {
        if (!this._tcWeek) this._tcWeek = '';
        await this._loadTimecards();
        const row = ((this._tc && this._tc.rows) || [])[0];
        if (row && row.summary) {
          cards.hours = Number(row.summary.total_hours) || 0;
          cards.overtime = Number(row.summary.overtime_hours) || 0;
        }
      } catch (e) { console.error('CrewCore dashboard: timecards', e); }
    }

    try {
      await this._loadReviews();
      const byDate = this._reviews.slice()
        .sort((a, b) => String(b.review_date || '').localeCompare(String(a.review_date || '')));
      cards.lastReview = byDate[0] || null;
      // The SOONEST date still ahead of today, not the newest review's date:
      // a review logged last week can name a date further out than one
      // logged a month ago, and the next thing on the calendar is the
      // question this card answers.
      const today = new Date().toISOString().slice(0, 10);
      cards.nextReview = this._reviews
        .map((r) => r.next_review_date)
        .filter((d) => d && d >= today)
        .sort()[0] || null;
    } catch (e) { console.error('CrewCore dashboard: reviews', e); }

    try {
      await this._loadHandbook();
      cards.handbook = this._handbook;
    } catch (e) { console.error('CrewCore dashboard: handbook', e); }

    try {
      await this._loadKudos();
      // Counted for the year, not for all time: a running lifetime total
      // turns into a length-of-service number rather than a recent one, and
      // the stipend card next to it is already a this-year figure.
      const mine = kudosFor(this._kudos, { to: this._own.id, year: new Date().getFullYear() });
      cards.kudos = mine.length;
      cards.lastKudos = mine[0] || null;   // the feed arrives newest first
    } catch (e) { console.error('CrewCore dashboard: kudos', e); }
  },

  _renderDashboardSelf() {
    // No linked employee record: the "ask an admin to link you" screen is
    // the whole dashboard, same as it used to be the whole Roster view.
    if (!this._own) return this._renderProfileSelf();

    const c = this._selfCards || {};
    const bal = c.stipend;
    const ann = daysUntilAnniversary(this._own.start_date);
    const cards = [];

    if (bal) {
      const pct = bal.allotted > 0 ? Math.min(100, Math.round((bal.used / bal.allotted) * 100)) : 0;
      const over = isOverStipend(bal);
      cards.push(`
        <div class="cc-card tap${over ? ' over' : ''}" data-go="stipend">
          ${over ? `<span class="cc-flag" title="Over the allotment">!</span>` : ''}
          <h3>Stipend left</h3>
          <div class="big">${fmtMoney(bal.remaining)}</div>
          <div class="note${over ? ' over' : ''}">${bal.allotted > 0
            ? (bal.over ? 'over by ' + fmtMoney(bal.over) : 'of ' + fmtMoney(bal.allotted) + ' in ' + bal.year)
            : 'no stipend set'}</div>
          <div class="cc-balance-bar${over ? ' over' : ''}"><div class="fill" style="width:${pct}%"></div></div>
        </div>`);
    }

    if (this._canClock() && c.hours !== null && c.hours !== undefined) {
      cards.push(`
        <div class="cc-card tap" data-go="timeclock">
          <h3>Hours this week</h3>
          <div class="big">${c.hours.toFixed(2)}</div>
          <div class="note">${c.overtime ? c.overtime.toFixed(2) + ' of it overtime' : esc(this._tcWeekLabel())}</div>
        </div>`);
    }

    cards.push(`
      <div class="cc-card tap" data-go="reviews">
        <h3>Next review</h3>
        <div class="big">${c.nextReview ? fmtDate(c.nextReview) : '—'}</div>
        <div class="note">${c.lastReview
          ? 'last one ' + fmtDate(c.lastReview.review_date)
          : 'nothing on the calendar'}</div>
      </div>`);

    if (c.kudos !== null && c.kudos !== undefined) {
      cards.push(`
        <div class="cc-card tap" data-go="kudos">
          <h3>Kudos</h3>
          <div class="big">${c.kudos}</div>
          <div class="note">${c.lastKudos
            ? 'latest from ' + esc(c.lastKudos.from_name || 'a colleague')
            : 'none yet this year'}</div>
        </div>`);
    }

    if (c.handbook) {
      const ok = c.handbook.acknowledged === true;
      cards.push(`
        <div class="cc-card tap" data-go="handbook">
          <h3>Handbook</h3>
          <div class="big">${ok ? 'Agreed' : 'Unread'}</div>
          <div class="note">${ok ? 'version of ' + esc(c.handbook.updated || '') : 'needs your agreement'}</div>
        </div>`);
    }

    return `
      ${this._renderProfileSelf()}
      <div class="cc-grid" id="ccSelfCards" style="margin-top:22px">${cards.join('')}</div>
      ${ann ? `<p style="font-size:12.5px;color:var(--muted)">
        ${ann.days === 0
          ? `Today is ${ann.years} ${ann.years === 1 ? 'year' : 'years'} at P&amp;M. Thank you.`
          : `${ann.years} ${ann.years === 1 ? 'year' : 'years'} at P&amp;M in ${ann.days} ${ann.days === 1 ? 'day' : 'days'}.`}
      </p>` : ''}
    `;
  },

  /**
   * Same shortcut behaviour the self-serve cards have. Kept as its own
   * function rather than folded into _wireDashboardSelf(): the two
   * dashboards are two different screens that happen to share a card
   * component, and one wiring function reaching into both grids would tie
   * them together for no reason.
   */
  _wireDashboardAdmin() {
    const grid = this._root.querySelector('#ccAdminCards');
    if (!grid) return;
    grid.querySelectorAll('[data-go]').forEach((card) => {
      card.onclick = () => {
        const view = card.dataset.go;
        if (this._ctx && typeof this._ctx.go === 'function') this._ctx.go(view);
        else this.showView(view);
      };
    });
  },

  _wireDashboardSelf() {
    const grid = this._root.querySelector('#ccSelfCards');
    if (!grid) return;
    // Each card is a shortcut to the view it summarises. ctx.go() routes
    // through the shell rather than calling showView() directly, so the rail
    // highlight and the URL hash stay in step — clicking a card and clicking
    // the rail have to land in the same place.
    grid.querySelectorAll('[data-go]').forEach((card) => {
      card.onclick = () => {
        const view = card.dataset.go;
        if (this._ctx && typeof this._ctx.go === 'function') this._ctx.go(view);
        else this.showView(view);
      };
    });
  },

  /* ---------------- Roster: admin list ---------------- */

  _renderRosterAdmin() {
    return `
      <div class="cc-toolbar">
        <input class="cc-search" id="ccSearch" type="text" placeholder="Search by name...">
        <select class="cc-filt" id="ccDeptFilter">
          <option value="">All departments</option>
          ${DEPARTMENTS.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}
        </select>
      </div>
      <div class="cc-list" id="ccRosterList"></div>
    `;
  },

  _wireRosterAdmin() {
    const root = this._root;
    const $ = (sel) => root.querySelector(sel);
    const search = $('#ccSearch');
    const deptFilter = $('#ccDeptFilter');

    const render = () => {
      const q = (search.value || '').trim().toLowerCase();
      const dept = deptFilter.value;
      const rows = this._employees.filter((e) => {
        if (dept && e.department !== dept) return false;
        if (q && !String(e.name || '').toLowerCase().includes(q)) return false;
        return true;
      });
      const list = $('#ccRosterList');
      if (!rows.length) {
        list.innerHTML = `<div class="cc-empty">No employees match.</div>`;
        return;
      }
      list.innerHTML = `
        <table class="cc-table">
          <thead><tr><th>Name</th><th>Department</th><th>Title</th><th>Start</th><th>Status</th><th>Rate</th><th>Stipend</th><th>Kiosk</th></tr></thead>
          <tbody>
            ${rows.map((e) => `
              <tr class="clickable" data-id="${esc(e.id)}">
                <td>${esc(e.name)}</td>
                <td>${esc(e.department || '')}</td>
                <td>${esc(e.title || '')}</td>
                <td>${fmtDate(e.start_date)}</td>
                <td><span class="chip ${esc(e.status)}">${esc(e.status)}</span></td>
                <td>${e.hourly_rate != null ? fmtMoney(e.hourly_rate) + '/hr' : '—'}</td>
                <td>${fmtMoney(e.apparel_stipend)}/yr</td>
                <td>${e.clock_enabled === false ? '<span class="chip on_leave">salary</span>'
                  : (e.has_clock_pin ? '<span class="chip">set</span>' : '<span class="chip terminated">no code</span>')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      list.querySelectorAll('tr.clickable').forEach((tr) => {
        tr.onclick = () => {
          const emp = this._employees.find((e) => e.id === tr.dataset.id);
          if (emp) this._openEmployeeForm(emp);
        };
      });
    };

    search.oninput = render;
    deptFilter.onchange = render;
    render();
  },

  _openEmployeeForm(emp) {
    const root = this._root;
    const body = root.querySelector('#ccBody');
    const isEdit = !!emp;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="cc-form">
        <h3>${isEdit ? 'Edit ' + esc(emp.name) : 'Add employee'}</h3>
        <div class="cc-form-grid">
          <div><label>Name</label><input id="fName" value="${esc(emp ? emp.name : '')}"></div>
          <div><label>Department</label>
            <select id="fDept">${DEPARTMENTS.map((d) => `<option value="${esc(d)}" ${emp && emp.department === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select>
          </div>
          <div><label>Reports to</label>
            <select id="fReportsTo">
              <option value="">Nobody</option>
              ${(this._employees || [])
                .filter((x) => !emp || x.id !== emp.id)
                .map((x) => `<option value="${esc(x.id)}" ${emp && emp.reports_to === x.id ? 'selected' : ''}>${esc(x.name)}</option>`)
                .join('')}
            </select>
          </div>
          <div><label>Title</label><input id="fTitle" value="${esc(emp ? emp.title : '')}"></div>
          <div><label>Start date</label><input id="fStart" type="date" value="${esc(emp ? emp.start_date : '')}"></div>
          <div><label>Status</label>
            <select id="fStatus">
              <option value="active" ${emp && emp.status === 'active' ? 'selected' : ''}>Active</option>
              <option value="on_leave" ${emp && emp.status === 'on_leave' ? 'selected' : ''}>On leave</option>
              <option value="terminated" ${emp && emp.status === 'terminated' ? 'selected' : ''}>Terminated</option>
            </select>
          </div>
          <div><label>Phone</label><input id="fPhone" value="${esc(emp ? emp.phone : '')}"></div>
          <div><label>Email</label><input id="fEmail" value="${esc(emp ? emp.email : '')}"></div>
          <div><label>Shell username (optional)</label><input id="fUsername" value="${esc(emp && emp.username ? emp.username : '')}" placeholder="links self-serve login"></div>
          <div><label>Hourly rate</label><input id="fRate" type="number" step="0.01" value="${emp && emp.hourly_rate != null ? emp.hourly_rate : ''}"></div>
          <div>
            <label>Apparel stipend / year</label>
            <input id="fStipend" type="number" step="0.01" value="${emp && emp.apparel_stipend != null ? emp.apparel_stipend : ''}" placeholder="defaults by department">
          </div>
          <div>
            <label>Pay type</label>
            <select id="fClockOn">
              <option value="true" ${!emp || emp.clock_enabled !== false ? 'selected' : ''}>Hourly, punches the clock</option>
              <option value="false" ${emp && emp.clock_enabled === false ? 'selected' : ''}>Salary, does not punch</option>
            </select>
          </div>
          <div>
            <label>Kiosk passcode</label>
            <input id="fPin" type="text" inputmode="numeric" autocomplete="off" maxlength="6"
                   placeholder="${isEdit && emp.has_clock_pin ? 'leave blank to keep current' : '4 to 6 digits'}">
            <div class="tc-pinstate ${isEdit && emp.has_clock_pin ? 'set' : 'unset'}">
              ${isEdit && emp.has_clock_pin
                ? 'Passcode is set. Type a new one to replace it, or type CLEAR to remove it.'
                : 'No passcode yet. Without one this person cannot use the clock kiosk.'}
            </div>
          </div>
          <div class="full"><label>Notes</label><textarea id="fNotes" rows="2">${esc(emp ? emp.notes : '')}</textarea></div>
        </div>
        <div class="cc-err" id="fErr" hidden></div>
        <div class="cc-form-actions">
          ${isEdit ? '<button class="cc-btn ghost" id="fDelete">Delete</button>' : ''}
          <button class="cc-btn ghost" id="fCancel">Cancel</button>
          <button class="cc-btn" id="fSave">Save</button>
        </div>
      </div>
    `;
    body.prepend(wrap);
    const $ = (sel) => wrap.querySelector(sel);
    const err = $('#fErr');

    $('#fCancel').onclick = () => wrap.remove();

    if (isEdit) {
      $('#fDelete').onclick = async () => {
        if (!confirm('Delete ' + emp.name + '? This cannot be undone.')) return;
        try {
          await this._ctx.api.request(ENDPOINTS.ccEmployees + '?id=' + encodeURIComponent(emp.id), { method: 'DELETE' });
          this._employees = this._employees.filter((e) => e.id !== emp.id);
          wrap.remove();
          this.showView('roster');
        } catch (e) {
          err.hidden = false; err.textContent = e.message || 'Could not delete.';
        }
      };
    }

    $('#fSave').onclick = async () => {
      const stipendRaw = $('#fStipend').value;
      const payload = {
        name: $('#fName').value,
        department: $('#fDept').value,
        // Empty means nobody, which is a real answer (the owner reports to
        // no one), so this is sent as null rather than left off the payload.
        reports_to: $('#fReportsTo').value || null,
        title: $('#fTitle').value,
        start_date: $('#fStart').value,
        status: $('#fStatus').value,
        phone: $('#fPhone').value,
        email: $('#fEmail').value,
        username: $('#fUsername').value || null,
        hourly_rate: $('#fRate').value === '' ? null : Number($('#fRate').value),
        notes: $('#fNotes').value
      };
      payload.clock_enabled = $('#fClockOn').value === 'true';

      // The passcode field is write-only and blank by default. Blank means
      // "leave whatever is stored alone", which is why it is only added to
      // the payload when something was actually typed. The literal word
      // CLEAR is the explicit way to remove a code, so that clearing is
      // never something an empty field does by accident.
      const pinRaw = ($('#fPin').value || '').trim();
      if (pinRaw) payload.clock_pin = /^clear$/i.test(pinRaw) ? '' : pinRaw;

      // Only send apparel_stipend if the admin actually typed something —
      // leaving it blank on a NEW employee lets the server apply the
      // department default (see lib/crewcore/store.js saveEmployee); on an
      // EDIT, omitting it here means "leave whatever is already stored."
      if (stipendRaw !== '') payload.apparel_stipend = Number(stipendRaw);

      try {
        if (isEdit) {
          const out = await this._ctx.api.request(ENDPOINTS.ccEmployees + '?id=' + encodeURIComponent(emp.id), { method: 'PATCH', body: payload });
          const idx = this._employees.findIndex((e) => e.id === emp.id);
          if (idx >= 0) this._employees[idx] = out.employee;
        } else {
          const out = await this._ctx.api.request(ENDPOINTS.ccEmployees, { method: 'POST', body: payload });
          this._employees.push(out.employee);
        }
        wrap.remove();
        this.showView('roster');
      } catch (e) {
        err.hidden = false; err.textContent = (e.body && e.body.details && e.body.details.join(', ')) || e.message || 'Could not save.';
      }
    };
  },

  /* ---------------- Roster: self-serve profile ---------------- */

  _renderProfileSelf() {
    const e = this._own;
    if (!e) {
      return `
        <div class="cc-locked">
          <h2>No profile linked yet</h2>
          <p>Your login isn't linked to an employee record. Ask an admin to add your username in CrewCore's Roster.</p>
        </div>
      `;
    }
    const initials = String(e.name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
    return `
      <div class="cc-profile">
        <div class="cc-profile-hd">
          <div class="cc-avatar">${esc(initials)}</div>
          <div>
            <h2>${esc(e.name)}</h2>
            <div class="sub">${esc(e.title || '')}${e.title && e.department ? ' · ' : ''}${esc(e.department || '')}</div>
          </div>
        </div>
        <div class="cc-field-grid">
          <div class="cc-field"><label>Start date</label><div class="v">${fmtDate(e.start_date)}</div></div>
          <div class="cc-field"><label>Status</label><div class="v"><span class="chip ${esc(e.status)}">${esc(e.status)}</span></div></div>
          <div class="cc-field"><label>Phone</label><div class="v">${esc(e.phone || '—')}</div></div>
          <div class="cc-field"><label>Email</label><div class="v">${esc(e.email || '—')}</div></div>
        </div>
      </div>
    `;
  },

  /* ---------------- Stipend ---------------- */
  //
  // Two surfaces. The grid shows one card per person for the selected year;
  // clicking a card opens that person's detail, which carries their own spend
  // log. showView('stipend') always lands on the grid, so the rail is always a
  // way back out. _refreshStipend() keeps whichever surface you are on, so
  // correcting an entry re-renders in place instead of throwing you to the top.
  //
  // Everything here is scoped to a calendar year because the allotment re-ups
  // every Jan 1. A balance with no year attached does not mean anything.

  /**
   * Years worth offering in the picker: every year that actually has an
   * entry, plus the current one so a fresh January is selectable before
   * anybody has logged anything into it.
   */
  _stipendYears() {
    return stipendYears(this._stipendSpends);
  },

  /** Entries for one person (or everyone, if id is falsy) in one year. */
  _spendsFor(employeeId, year) {
    return spendsFor(this._stipendSpends, employeeId, year);
  },

  /** Allotment, applied and remaining for one person in one year. */
  _balanceFor(employee, year) {
    return stipendBalance(employee.apparel_stipend, this._spendsFor(employee.id, null), year);
  },

  /**
   * The red mark for a person who has gone past their allotment. Returns an
   * empty string when they have not, so a caller can drop it into any card
   * without a conditional of its own. The hover title carries the amount,
   * because a bare exclamation point says something is wrong without saying
   * what.
   */
  _overFlag(bal, year) {
    if (!isOverStipend(bal)) return '';
    const msg = 'Over the ' + (bal.year || year) + ' stipend by ' + fmtMoney(bal.over);
    return `<span class="cc-flag" title="${esc(msg)}" role="img" aria-label="${esc(msg)}">!</span>`;
  },

  _stipendYearPicker() {
    const years = this._stipendYears();
    return `
      <div class="cc-toolbar">
        <span class="lbl">Stipend year</span>
        <select class="cc-filt" id="ccStipYear">
          ${years.map((y) => `<option value="${y}"${y === this._stipendYear ? ' selected' : ''}>${y}</option>`).join('')}
        </select>
      </div>
    `;
  },

  /**
   * One line in a spend log. The name is never shown: every log left in the
   * app now sits inside one person's own screen, where the name is already
   * the heading. The all-team log that needed it is gone.
   */
  _stipendRow(s) {
    const { title, parts } = spendLabel(s, null);
    const bits = [fmtDate(s.date)].concat(parts);
    return `
      <div class="cc-row" data-id="${esc(s.id)}">
        <div>
          <div class="who">${esc(title)}</div>
          <div class="meta">${bits.map((b) => esc(b)).join(' · ')}</div>
        </div>
        <div class="cc-rowacts">
          <span class="meta">${fmtMoney(s.amount)}</span>
          <button class="cc-btn sm ghost" data-act="edit">Edit</button>
          <button class="cc-btn sm ghost" data-act="delete">Remove</button>
        </div>
      </div>
    `;
  },

  _stipendLog(rows, emptyMsg) {
    return `
      <div class="cc-list">
        ${rows.length
          ? rows.map((s) => this._stipendRow(s)).join('')
          : `<div class="cc-empty">${esc(emptyMsg)}</div>`}
      </div>
    `;
  },

  // ---- Samples (SanMar sample drops) --------------------------------------
  //
  // Twice a year SanMar discounts New Arrivals samples. Everyone picks their
  // own; a pick draws their apparel stipend the moment it is made, which is
  // why the remaining balance sits at the top of the screen the whole time
  // somebody is choosing.

  async _loadSamples() {
    const out = await this._ctx.api.request(ENDPOINTS.ccSamples + '?resource=drops');
    this._sampleDrops = out.drops || [];
    this._sampleCanPick = out.can_pick !== false;
    if (this._sampleDropId && !this._sampleDrops.some((d) => d.id === this._sampleDropId)) {
      this._sampleDropId = null;
    }
    // One open drop and nothing chosen: go straight into it. Nobody opens
    // this screen to look at a list of one.
    if (!this._sampleDropId) {
      const open = this._sampleDrops.filter((d) => d.status === 'open');
      if (open.length === 1) this._sampleDropId = open[0].id;
    }
  },

  async _loadSampleDrop() {
    if (!this._sampleDropId) return;
    const id = encodeURIComponent(this._sampleDropId);
    const [drop, picks] = await Promise.all([
      this._ctx.api.request(ENDPOINTS.ccSamples + '?resource=drop&id=' + id),
      this._ctx.api.request(ENDPOINTS.ccSamples + '?resource=picks&drop_id=' + id),
    ]);
    this._sampleDrop = drop.drop;
    this._sampleCatalog = drop.catalog || [];
    this._sampleImport = drop.import || null;
    this._samplePicks = picks.picks || [];
    this._sampleBalance = picks.balance || null;
    this._samplePeople = picks.people || [];
    this._sampleMeId = picks.me_employee_id || null;
    this._sampleEmployees = picks.employees || [];
  },

  _renderSamples() {
    if (!this._sampleDropId) return this._renderSampleDrops();
    return this._renderSampleDrop();
  },

  _renderSampleDrops() {
    if (!this._sampleDrops.length) {
      return `<div class="cc-empty">${this._isAdmin
        ? 'No sample drops yet. Start one when SanMar opens the season.'
        : 'No sample drops are open right now.'}</div>`;
    }
    const cards = this._sampleDrops.map((d) => `
      <div class="cc-card tap" data-drop="${esc(d.id)}" role="button" tabindex="0">
        <div class="cardhd"><h3>${esc(d.name)}</h3>
          <span class="cc-pill${d.status === 'open' ? ' on' : ''}">${d.status === 'open' ? 'Open' : 'Closed'}</span>
        </div>
        <div class="big">${d.catalog_count}</div>
        <div class="note">${d.catalog_count === 1 ? 'style' : 'styles'} in the catalog</div>
        ${d.due_date ? `<div class="note">Picks due ${esc(d.due_date)}</div>` : ''}
      </div>`).join('');
    return `<div class="cc-grid">${cards}</div>`;
  },

  _renderSampleDrop() {
    const d = this._sampleDrop || {};
    const imp = this._sampleImport;
    const bal = this._sampleBalance;
    const closed = d.status === 'closed';

    // An import in flight owns the screen. Showing a half-built catalog
    // underneath a progress bar invites somebody to pick off it.
    if (imp && imp.running) {
      const pct = imp.total ? Math.round((imp.done / imp.total) * 100) : 0;
      return `
        <div class="cc-note">
          <strong>Importing the catalog.</strong>
          <div class="note">Style ${imp.done} of ${imp.total}. This keeps going on its own.</div>
          <div class="cc-balance-bar"><div class="fill" style="width:${pct}%"></div></div>
          ${imp.errors && imp.errors.length
            ? `<div class="note">${imp.errors.length} could not be read so far.</div>` : ''}
        </div>`;
    }

    const balStrip = bal ? `
      <div class="cc-note${isOverStipend(bal) ? ' over' : ''}">
        <strong>${fmtMoney(bal.remaining)}</strong> of ${bal.allotted > 0 ? fmtMoney(bal.allotted) : 'no stipend set'}
        ${bal.allotted > 0 ? 'left this year' : ''}${bal.over ? ' · over by ' + fmtMoney(bal.over) : ''}.
        <span class="note">A pick comes off this straight away.</span>
      </div>` : '';

    const errs = imp && imp.errors && imp.errors.length ? `
      <div class="cc-note">
        <strong>${imp.errors.length} ${imp.errors.length === 1 ? 'style' : 'styles'} could not be read.</strong>
        <div class="note">${imp.errors.map((e) => esc(e.style) + ' (' + esc(e.error) + ')').join(', ')}</div>
      </div>` : '';

    const catalog = this._sampleCatalog.length
      ? `<div class="cc-cat">${this._sampleCatalog.map((c) => this._sampleTile(c)).join('')}</div>`
      : `<div class="cc-empty">${this._isAdmin
          ? 'No catalog yet. Import one from the style lists on SanMar\u2019s order form.'
          : 'The catalog for this drop has not been imported yet.'}</div>`;

    return `
      ${balStrip}
      ${errs}
      ${closed ? '<div class="cc-note">This drop is closed. Picks can no longer be changed.</div>' : ''}
      ${this._sampleStyleOpen ? this._renderSampleStyle() : catalog}
      ${this._renderSamplePicks()}
      ${this._isAdmin ? this._renderSamplePeople() : ''}
    `;
  },

  _sampleTile(c) {
    const price = c.from_price == null ? '' :
      (c.split_pricing ? 'from ' + fmtMoney(c.from_price) : fmtMoney(c.from_price));
    return `
      <div class="cc-tile tap" data-style="${esc(c.style)}" role="button" tabindex="0">
        <div class="shot">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : ''}</div>
        <div class="cc-tile-b">
          <div class="s">${esc(c.style)} <span class="cc-pill">${c.tier}% off</span></div>
          <div class="t">${esc(c.title || '')}</div>
          <div class="note">${price}${c.color_count ? ' · ' + c.color_count + ' colours' : ''}</div>
        </div>
      </div>`;
  },

  _renderSampleStyle() {
    const s = this._sampleStyleOpen;
    const colorName = this._sampleColor || (s.colors[0] && s.colors[0].name);
    const color = s.colors.find((c) => c.name === colorName) || s.colors[0];
    const chips = s.colors.map((c) => `
      <button class="cc-swatch${c.name === color.name ? ' on' : ''}" data-color="${esc(c.name)}"
        title="${esc(c.name)}">${c.swatch
          ? `<img src="${esc(c.swatch)}" alt="${esc(c.name)}">`
          : `<span>${esc(c.name.slice(0, 2))}</span>`}</button>`).join('');

    const sizes = color.sizes.map((z) => `
      <button class="cc-size" data-size="${esc(z.size)}">
        <span>${esc(z.size)}</span>
        <span class="p">${z.price == null ? '\u2014' : fmtMoney(z.price)}</span>
      </button>`).join('');

    return `
      <div class="cc-detail">
        <button class="cc-btn ghost" id="sBack">Back to the catalog</button>
        <div class="cc-style">
          <div class="shot big">${color.image ? `<img src="${esc(color.image)}" alt="">` : ''}</div>
          <div>
            <h3>${esc(s.title || s.style)}</h3>
            <div class="note">${esc(s.style)} · ${esc(s.brand || '')} · ${s.tier}% off
              ${s.on_sale ? ' · <span title="Sample pricing always comes off the regular case price">on sale at SanMar</span>' : ''}</div>
            <div class="note lbl">Colour: <strong>${esc(color.name)}</strong></div>
            <div class="cc-swatches">${chips}</div>
            <div class="note lbl">Size</div>
            <div class="cc-sizes">${sizes}</div>
            ${s.spec_sheet ? `<div class="note"><a href="${esc(s.spec_sheet)}" target="_blank" rel="noopener">Spec sheet</a></div>` : ''}
          </div>
        </div>
      </div>`;
  },

  _renderSamplePicks() {
    const mine = this._samplePicks.filter((p) => this._isAdmin
      ? p.employee_id === this._sampleMineId()
      : true);
    const rows = (this._isAdmin && this._sampleShowAll ? this._samplePicks : mine);
    if (!rows.length) {
      return `<div class="cc-sec"><h3>${this._isAdmin && this._sampleShowAll ? 'All picks' : 'Your picks'}</h3>
        <div class="cc-empty">Nothing picked yet.</div></div>`;
    }
    const total = rows.reduce((sum, p) => sum + Number(p.price || 0), 0);
    const closed = (this._sampleDrop || {}).status === 'closed';
    const nameFor = (id) => {
      const e = this._sampleEmployees.find((x) => x.id === id);
      return e ? e.name : '';
    };
    return `
      <div class="cc-sec">
        <h3>${this._isAdmin && this._sampleShowAll ? 'All picks' : 'Your picks'}
          <span class="note">${rows.length} · ${fmtMoney(total)}</span></h3>
        <div class="cc-rows">
          ${rows.map((p) => `
            <div class="cc-row">
              <div class="sw">${p.swatch ? `<img src="${esc(p.swatch)}" alt="">` : ''}</div>
              <div class="grow">
                <strong>${esc(p.style)} ${esc(p.color)} ${esc(p.size)}</strong>
                <div class="note">${esc(p.title || '')}${this._isAdmin && this._sampleShowAll
                  ? ' · ' + esc(nameFor(p.employee_id)) : ''}${p.received ? ' · received' : ''}</div>
              </div>
              <div class="amt">${fmtMoney(p.price)}</div>
              ${this._isAdmin ? `<button class="cc-btn ghost sm" data-recv="${esc(p.id)}">${p.received ? 'Undo' : 'Received'}</button>` : ''}
              ${(!closed || this._isAdmin) ? `<button class="cc-btn ghost sm" data-drop-pick="${esc(p.id)}">Remove</button>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
  },

  _renderSamplePeople() {
    if (!this._samplePeople.length) return '';
    return `
      <div class="cc-sec">
        <h3>By person <span class="note">${this._samplePeople.length}</span></h3>
        <div class="cc-rows">
          ${this._samplePeople.map((p) => `
            <div class="cc-row">
              <div class="grow"><strong>${esc(p.name || p.employee_id)}</strong>
                <div class="note">${p.count} ${p.count === 1 ? 'item' : 'items'}</div></div>
              <div class="amt">${fmtMoney(p.total)}</div>
            </div>`).join('')}
        </div>
      </div>`;
  },

  _sampleMineId() {
    // The server tells us which employee record this login is, rather than
    // the screen guessing from a name. A login with no linked record has
    // none, which is a real state: it is what Alexis hit on the handbook.
    return this._sampleMeId || null;
  },

  _wireSamples() {
    const root = this._root;
    const $$ = (s) => Array.from(root.querySelectorAll(s));

    $$('[data-drop]').forEach((el) => {
      const go = () => { this._sampleDropId = el.dataset.drop; this._sampleStyleOpen = null; this._refreshSamples(); };
      el.onclick = go;
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });

    $$('[data-style]').forEach((el) => {
      const go = async () => {
        try {
          const out = await this._ctx.api.request(ENDPOINTS.ccSamples +
            '?resource=style&drop_id=' + encodeURIComponent(this._sampleDropId) +
            '&style=' + encodeURIComponent(el.dataset.style));
          this._sampleStyleOpen = out.style;
          this._sampleColor = null;
          this._paintSamples();
        } catch (e) { this._sampleError(e); }
      };
      el.onclick = go;
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });

    const back = root.querySelector('#sBack');
    if (back) back.onclick = () => { this._sampleStyleOpen = null; this._paintSamples(); };

    $$('[data-color]').forEach((el) => {
      el.onclick = () => { this._sampleColor = el.dataset.color; this._paintSamples(); };
    });

    $$('[data-size]').forEach((el) => {
      el.onclick = () => this._addSamplePick(el.dataset.size);
    });

    $$('[data-drop-pick]').forEach((el) => {
      el.onclick = () => this._removeSamplePick(el.dataset.dropPick);
    });

    $$('[data-recv]').forEach((el) => {
      el.onclick = () => this._toggleSampleReceived(el.dataset.recv);
    });
  },

  async _addSamplePick(size) {
    const s = this._sampleStyleOpen;
    if (!s) return;
    const color = this._sampleColor || (s.colors[0] && s.colors[0].name);
    try {
      await this._ctx.api.request(ENDPOINTS.ccSamples + '?resource=picks', {
        method: 'POST',
        body: { drop_id: this._sampleDropId, style: s.style, color, size },
      });
      await this._refreshSamples({ keepStyle: true });
    } catch (e) { this._sampleError(e); }
  },

  async _removeSamplePick(id) {
    try {
      await this._ctx.api.request(ENDPOINTS.ccSamples + '?resource=picks&id=' + encodeURIComponent(id),
        { method: 'DELETE' });
      await this._refreshSamples({ keepStyle: true });
    } catch (e) { this._sampleError(e); }
  },

  async _toggleSampleReceived(id) {
    const pick = this._samplePicks.find((p) => p.id === id);
    if (!pick) return;
    try {
      await this._ctx.api.request(ENDPOINTS.ccSamples + '?resource=picks&id=' + encodeURIComponent(id),
        { method: 'PATCH', body: { received: !pick.received } });
      await this._refreshSamples({ keepStyle: true });
    } catch (e) { this._sampleError(e); }
  },

  _sampleError(e) {
    const msg = (e && e.body && e.body.error) || (e && e.message) || 'Something went wrong.';
    const box = this._root.querySelector('#ccBody');
    const note = document.createElement('div');
    note.className = 'cc-note over';
    note.textContent = msg;
    if (box) box.prepend(note);
    setTimeout(() => note.remove(), 6000);
  },

  async _refreshSamples(opts = {}) {
    const keep = opts.keepStyle ? this._sampleStyleOpen : null;
    await this._loadSamples();
    if (this._sampleDropId) await this._loadSampleDrop();
    this._sampleStyleOpen = keep;
    this._paintSamples();
  },

  _paintSamples() {
    const body = this._root.querySelector('#ccBody');
    if (!body) return;
    body.innerHTML = this._renderSamples();
    this._syncSampleActions();
    this._wireSamples();
  },

  _syncSampleActions() {
    const actions = this._root.querySelector('#ccHdActions');
    if (!actions) return;
    const inDrop = !!this._sampleDropId;
    const closed = (this._sampleDrop || {}).status === 'closed';
    const bits = [];
    if (inDrop && this._sampleDrops.length > 1) bits.push(`<button class="cc-btn ghost" id="sAll">All drops</button>`);
    if (inDrop && this._isAdmin) {
      bits.push(`<button class="cc-btn ghost" id="sToggle">${this._sampleShowAll ? 'Just mine' : 'Everyone'}</button>`);
      bits.push(`<button class="cc-btn ghost" id="sImport">Import catalog</button>`);
      bits.push(`<button class="cc-btn ghost" id="sExport">Export CSV</button>`);
      bits.push(`<button class="cc-btn ghost" id="sClose">${closed ? 'Reopen' : 'Close'}</button>`);
    }
    if (!inDrop && this._isAdmin) bits.push(`<button class="cc-btn" id="sNew">New drop</button>`);
    actions.innerHTML = bits.join('');

    const on = (id, fn) => { const el = actions.querySelector(id); if (el) el.onclick = fn; };
    on('#sAll', () => { this._sampleDropId = null; this._sampleStyleOpen = null; this._refreshSamples(); });
    on('#sToggle', () => { this._sampleShowAll = !this._sampleShowAll; this._paintSamples(); });
    on('#sNew', () => this._openSampleDropForm());
    on('#sImport', () => this._openSampleImport());
    on('#sExport', () => {
      window.open(ENDPOINTS.ccSamples + '?resource=export&drop_id=' +
        encodeURIComponent(this._sampleDropId), '_blank');
    });
    on('#sClose', async () => {
      try {
        await this._ctx.api.request(ENDPOINTS.ccSamples + '?resource=drops&id=' +
          encodeURIComponent(this._sampleDropId), {
          method: 'PATCH', body: { status: closed ? 'open' : 'closed' },
        });
        await this._refreshSamples();
      } catch (e) { this._sampleError(e); }
    });
  },

  _openSampleDropForm() {
    const body = this._root.querySelector('#ccBody');
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="cc-form">
        <h3>New sample drop</h3>
        <div class="cc-form-grid">
          <div><label>Name</label><input id="dName" placeholder="Fall 2026"></div>
          <div><label>Picks due</label><input id="dDue" type="date"></div>
          <div class="full"><label>Notes</label><input id="dNotes" placeholder="optional"></div>
        </div>
        <div class="cc-err" id="dErr" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn ghost" id="dCancel">Cancel</button>
          <button class="cc-btn" id="dSave">Create</button>
        </div>
      </div>`;
    body.prepend(wrap);
    const $ = (s) => wrap.querySelector(s);
    $('#dCancel').onclick = () => wrap.remove();
    $('#dSave').onclick = async () => {
      try {
        const out = await this._ctx.api.request(ENDPOINTS.ccSamples + '?resource=drops', {
          method: 'POST',
          body: { name: $('#dName').value, due_date: $('#dDue').value, notes: $('#dNotes').value },
        });
        wrap.remove();
        this._sampleDropId = out.drop.id;
        await this._refreshSamples();
      } catch (e) {
        const err = $('#dErr');
        err.hidden = false;
        err.textContent = (e.body && e.body.error) || e.message || 'Could not create the drop.';
      }
    };
  },

  _openSampleImport() {
    const body = this._root.querySelector('#ccBody');
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="cc-form">
        <h3>Import catalog</h3>
        <p class="hint">
          Paste the style lists off the back of SanMar\u2019s order form, one style per line.
          A full line like &ldquo;F180 Port Authority Therma-Tek Fleece Jacket&rdquo; works, and so
          does a bare style number. Colours, sizes, photos and prices come from SanMar
          directly, so there is no price list to attach.
          <strong>This replaces the current catalog.</strong>
        </p>
        <div class="cc-form-grid">
          <div class="full"><label>50% off styles</label><textarea id="iFifty" rows="8"></textarea></div>
          <div class="full"><label>25% off styles</label><textarea id="iTwentyFive" rows="6"></textarea></div>
        </div>
        <div class="cc-err" id="iErr" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn ghost" id="iCancel">Cancel</button>
          <button class="cc-btn" id="iGo">Import</button>
        </div>
      </div>`;
    body.prepend(wrap);
    const $ = (s) => wrap.querySelector(s);
    const fail = (msg) => {
      const err = $('#iErr');
      err.hidden = false;
      err.textContent = msg;
      $('#iGo').disabled = false;
    };
    $('#iCancel').onclick = () => wrap.remove();
    $('#iGo').onclick = async () => {
      $('#iGo').disabled = true;
      const drop = encodeURIComponent(this._sampleDropId);
      try {
        const q = await this._ctx.api.request(ENDPOINTS.ccSamples + '?resource=import&drop_id=' + drop, {
          method: 'POST',
          body: { fifty: $('#iFifty').value, twentyfive: $('#iTwentyFive').value },
        });
        if (q.error) return fail(q.error);
        wrap.remove();
        await this._runSampleImport(drop, q.queued);
      } catch (e) {
        fail((e.body && e.body.error) || e.message || 'Could not start the import.');
      }
    };
  },

  /**
   * Walk the import a few styles at a time.
   *
   * The server saves after every single style, so closing the tab half way
   * leaves a partly-built catalog rather than a broken one, and pressing
   * Import again picks up where it stopped. The loop is here rather than on
   * the server because a serverless function that calls itself trips Vercel's
   * loop guard, the same reason the ops sync leans on its cron.
   */
  async _runSampleImport(dropParam, queued) {
    this._sampleImport = { total: queued, done: 0, remaining: queued, errors: [], running: true };
    this._paintSamples();
    for (let guard = 0; guard < 400; guard += 1) {
      let out;
      try {
        out = await this._ctx.api.request(
          ENDPOINTS.ccSamples + '?resource=import-step&drop_id=' + dropParam, { method: 'POST' });
      } catch (e) {
        this._sampleError(e);
        break;
      }
      this._sampleImport = out.progress;
      this._paintSamples();
      if (out.done) break;
    }
    await this._refreshSamples();
  },

  _renderStipend() {
    if (!this._isAdmin) return this._renderStipendSelf();
    if (this._stipendDetailId) return this._renderStipendDetail();
    return this._renderStipendGrid();
  },

  _renderStipendGrid() {
    const year = this._stipendYear;

    if (!this._employees.length) {
      return `<div class="cc-empty">No employees on the roster yet.</div>`;
    }

    const cards = this._employees.map((e) => {
      const bal = this._balanceFor(e, year);
      const count = this._spendsFor(e.id, year).length;
      const pct = bal.allotted > 0 ? Math.min(100, Math.round((bal.used / bal.allotted) * 100)) : 0;
      const over = isOverStipend(bal);
      return `
        <div class="cc-card tap${over ? ' over' : ''}" data-emp="${esc(e.id)}" role="button" tabindex="0">
          ${this._overFlag(bal, year)}
          <div class="cardhd"><h3>${esc(e.name)}</h3></div>
          <div class="big">${fmtMoney(bal.remaining)}</div>
          <div class="note${over ? ' over' : ''}">${bal.allotted > 0
            ? 'of ' + fmtMoney(bal.allotted) + ' remaining' + (bal.over ? ' · over by ' + fmtMoney(bal.over) : '')
            : 'no stipend set'}</div>
          <div class="cc-balance-bar${over ? ' over' : ''}"><div class="fill" style="width:${pct}%"></div></div>
          <div class="note">${count} ${count === 1 ? 'purchase' : 'purchases'} in ${year}</div>
        </div>
      `;
    }).join('');

    // No all-team log under the grid. The purchases live on the person they
    // belong to, one click in. A combined list meant reading a name off every
    // line to work out whose shirt it was, and it sat under the cards saying
    // the same thing twice.
    return `
      ${this._stipendYearPicker()}
      <div class="cc-grid">${cards}</div>
    `;
  },

  _renderStipendDetail() {
    const year = this._stipendYear;
    const emp = this._employees.find((e) => e.id === this._stipendDetailId);
    if (!emp) {
      // The person went away underneath us (deleted, or the roster reloaded
      // without them). Fall back rather than render a blank card.
      this._stipendDetailId = null;
      return this._renderStipendGrid();
    }

    const rows = this._spendsFor(emp.id, year);
    const bal = this._balanceFor(emp, year);
    const pct = bal.allotted > 0 ? Math.min(100, Math.round((bal.used / bal.allotted) * 100)) : 0;
    const initials = String(emp.name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

    return `
      <div class="cc-back">
        <button class="cc-btn sm ghost" id="ccStipBack">Back to everyone</button>
      </div>
      <div class="cc-profile-hd">
        <div class="cc-avatar">${esc(initials)}</div>
        <div>
          <h2>${esc(emp.name)}</h2>
          <div class="sub">${esc([emp.title, emp.department].filter(Boolean).join(' · ')) || 'Apparel stipend'}</div>
        </div>
      </div>
      ${this._stipendYearPicker()}
      <div class="cc-grid">
        <div class="cc-card">
          <h3>Allotted (${year})</h3>
          <div class="big">${fmtMoney(bal.allotted)}</div>
        </div>
        <div class="cc-card">
          <h3>Applied</h3>
          <div class="big">${fmtMoney(bal.used)}</div>
          <div class="note">${rows.length} ${rows.length === 1 ? 'purchase' : 'purchases'}</div>
        </div>
        <div class="cc-card${isOverStipend(bal) ? ' over' : ''}">
          ${this._overFlag(bal, year)}
          <h3>Remaining</h3>
          <div class="big">${fmtMoney(bal.remaining)}</div>
          <div class="note${isOverStipend(bal) ? ' over' : ''}">${bal.allotted > 0
            ? (bal.over ? 'over by ' + fmtMoney(bal.over) : 'of ' + fmtMoney(bal.allotted))
            : 'no stipend set'}</div>
          <div class="cc-balance-bar${isOverStipend(bal) ? ' over' : ''}"><div class="fill" style="width:${pct}%"></div></div>
        </div>
      </div>
      <div class="cc-section">
        <h2>Spend log, ${year}</h2>
        ${this._stipendLog(rows, 'Nothing logged against ' + emp.name + ' in ' + year + '.')}
      </div>
    `;
  },

  _renderStipendSelf() {
    const year = this._stipendYear;
    const bal = this._stipendBalance;
    const rows = this._spendsFor(this._own ? this._own.id : null, year);
    const pct = bal && bal.allotted > 0 ? Math.min(100, Math.round((bal.used / bal.allotted) * 100)) : 0;

    return `
      ${this._stipendYearPicker()}
      <div class="cc-grid">
        <div class="cc-card">
          <h3>Allotted (${bal ? bal.year : year})</h3>
          <div class="big">${bal ? fmtMoney(bal.allotted) : '—'}</div>
        </div>
        <div class="cc-card">
          <h3>Used</h3>
          <div class="big">${bal ? fmtMoney(bal.used) : '—'}</div>
        </div>
        <div class="cc-card${isOverStipend(bal) ? ' over' : ''}">
          ${this._overFlag(bal, year)}
          <h3>Remaining</h3>
          <div class="big">${bal ? fmtMoney(bal.remaining) : '—'}</div>
          ${isOverStipend(bal) ? `<div class="note over">over by ${fmtMoney(bal.over)}</div>` : ''}
          ${bal ? `<div class="cc-balance-bar${isOverStipend(bal) ? ' over' : ''}"><div class="fill" style="width:${pct}%"></div></div>` : ''}
        </div>
      </div>
      <div class="cc-section">
        <h2>Your purchases, ${year}</h2>
        <div class="cc-list">
          ${rows.length ? rows.map((s) => {
            const { title, parts } = spendLabel(s, null);
            const bits = [fmtDate(s.date)].concat(parts);
            return `
            <div class="cc-row">
              <div>
                <div class="who">${esc(title)}</div>
                <div class="meta">${bits.map((b) => esc(b)).join(' · ')}</div>
              </div>
              <span class="meta">${fmtMoney(s.amount)}</span>
            </div>
          `; }).join('') : `<div class="cc-empty">Nothing logged in ${year}.</div>`}
        </div>
      </div>
    `;
  },

  /**
   * Sets the header button. In a person's detail it pre-selects them, so
   * logging three shirts for one person is not three trips through a
   * dropdown.
   */
  _syncStipendActions() {
    const actions = this._root.querySelector('#ccHdActions');
    if (!actions) return;
    if (!this._isAdmin) { actions.innerHTML = ''; return; }
    const emp = this._stipendDetailId
      ? this._employees.find((e) => e.id === this._stipendDetailId)
      : null;
    actions.innerHTML = `<button class="cc-btn" id="ccLogSpendBtn">${emp ? 'Log a purchase for ' + esc(emp.name.split(' ')[0]) : 'Log a purchase'}</button>`;
    const btn = actions.querySelector('#ccLogSpendBtn');
    if (btn) btn.onclick = () => this._openStipendForm(null, this._stipendDetailId);
  },

  /**
   * Re-reads the log and repaints the current surface, keeping the year and
   * the open person. Used after any add, edit or delete.
   */
  async _refreshStipend() {
    await this._loadStipend();
    const body = this._root.querySelector('#ccBody');
    body.innerHTML = this._renderStipend();
    this._syncStipendActions();
    this._wireStipend();
  },

  _wireStipend() {
    const root = this._root;
    const body = root.querySelector('#ccBody');

    const yearSel = body.querySelector('#ccStipYear');
    if (yearSel) {
      yearSel.onchange = async () => {
        this._stipendYear = parseInt(yearSel.value, 10) || new Date().getFullYear();
        await this._refreshStipend();
      };
    }

    if (!this._isAdmin) return;

    const back = body.querySelector('#ccStipBack');
    if (back) {
      back.onclick = () => {
        this._stipendDetailId = null;
        this._refreshStipend();
      };
    }

    body.querySelectorAll('.cc-card.tap').forEach((card) => {
      const open = () => {
        this._stipendDetailId = card.dataset.emp;
        this._refreshStipend();
      };
      card.onclick = open;
      card.onkeydown = (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      };
    });

    body.querySelectorAll('button[data-act="edit"]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.closest('.cc-row').dataset.id;
        const spend = this._stipendSpends.find((s) => s.id === id);
        if (spend) this._openStipendForm(spend);
      };
    });

    body.querySelectorAll('button[data-act="delete"]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.closest('.cc-row').dataset.id;
        if (!confirm('Remove this spend entry?')) return;
        try {
          await this._ctx.api.request(ENDPOINTS.ccStipend + '?id=' + encodeURIComponent(id), { method: 'DELETE' });
          await this._refreshStipend();
        } catch (e) {
          alert(e.message || 'Could not remove the entry.');
        }
      };
    });
  },

  /**
   * One form for both jobs. `spend` set means edit (PATCH, keeps the id and
   * the original created_at); `presetEmp` pre-selects a person when adding
   * from inside their detail.
   */
  _openStipendForm(spend, presetEmp) {
    const editing = !!spend;
    const root = this._root;
    const body = root.querySelector('#ccBody');
    const existing = body.querySelector('.cc-form');
    if (existing) existing.parentElement.remove();

    const selectedEmp = editing ? spend.employee_id : (presetEmp || '');
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="cc-form">
        <h3>${editing ? 'Edit purchase' : 'Log a purchase'}</h3>
        <div class="cc-form-grid">
          <div class="full"><label>Employee</label>
            <select id="fEmp">${this._employees.map((e) => `<option value="${esc(e.id)}"${e.id === selectedEmp ? ' selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
          </div>
          <div><label>Date</label><input id="fDate" type="date" value="${editing ? esc(String(spend.date || '').slice(0, 10)) : ''}"></div>
          <div><label>Amount</label><input id="fAmount" type="number" step="0.01" value="${editing && spend.amount != null ? esc(String(spend.amount)) : ''}"></div>
          <div><label>Category</label>
            <select id="fCategory">${STIPEND_CATEGORIES.map((c) => `<option value="${c}"${editing && spend.category === c ? ' selected' : ''}>${c}</option>`).join('')}</select>
          </div>
          <div class="full"><label>Description</label><input id="fDescription" placeholder="e.g. branded quarter-zip" value="${editing ? esc(spend.description || '') : ''}"></div>
        </div>
        <div class="cc-err" id="fErr" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn ghost" id="fCancel">Cancel</button>
          <button class="cc-btn" id="fSubmit">Save</button>
        </div>
      </div>
    `;
    body.prepend(wrap);
    const $ = (sel) => wrap.querySelector(sel);
    const err = $('#fErr');

    $('#fCancel').onclick = () => wrap.remove();
    $('#fSubmit').onclick = async () => {
      const payload = {
        employee_id: $('#fEmp').value,
        date: $('#fDate').value,
        amount: Number($('#fAmount').value),
        category: $('#fCategory').value,
        description: $('#fDescription').value
      };
      try {
        if (editing) {
          await this._ctx.api.request(ENDPOINTS.ccStipend + '?id=' + encodeURIComponent(spend.id), { method: 'PATCH', body: payload });
        } else {
          await this._ctx.api.request(ENDPOINTS.ccStipend, { method: 'POST', body: payload });
        }
        wrap.remove();
        // Jump the year to wherever the entry actually landed, so saving a
        // December purchase in January does not look like it vanished.
        const y = parseInt(String(payload.date || '').slice(0, 4), 10);
        if (Number.isFinite(y)) this._stipendYear = y;
        await this._refreshStipend();
      } catch (e) {
        err.hidden = false; err.textContent = (e.body && e.body.details && e.body.details.join(', ')) || e.message || 'Could not save.';
      }
    };
  },

  /* ---------------- Reviews ---------------- */

  /**
   * A list until a row is clicked, then the whole review. Same split the
   * stipend view uses (_stipendDetailId), and for the same reason: a review
   * is four paragraphs of writing, and a list that showed all of it would be
   * unreadable at ten reviews while a list that showed none of it was
   * useless. Which one is drawn is _reviewDetailId, and nothing else.
   */
  _renderReviews() {
    if (this._reviewDetailId) return this._renderReviewDetail();
    return this._renderReviewList();
  },

  _nameForEmployee(id) {
    const e = this._employees.find((x) => x.id === id);
    if (e) return e.name;
    // A self-serve caller has no roster to look names up in, and every
    // review they can see is their own anyway.
    if (this._own && this._own.id === id) return this._own.name;
    return id;
  },

  _renderReviewList() {
    const isAdmin = this._isAdmin;
    if (!this._reviews.length) {
      return `<div class="cc-empty">No reviews logged yet.</div>`;
    }
    // Newest first. The API returns them in index order, which is the order
    // they happened to be written, and nobody reads a review history oldest
    // first.
    const rows = this._reviews.slice()
      .sort((a, b) => String(b.review_date || '').localeCompare(String(a.review_date || '')));

    return `
      <div class="cc-list">
        ${rows.map((r) => `
          <div class="cc-row tap" data-review="${esc(r.id)}">
            <div>
              ${isAdmin ? `<div class="who">${esc(this._nameForEmployee(r.employee_id))}</div>` : ''}
              <div class="meta">${fmtDate(r.review_date)} · with ${esc(r.reviewer_name)}</div>
              ${r.summary ? `<div class="meta cc-clamp" style="margin-top:4px">${esc(r.summary)}</div>` : ''}
            </div>
            <div class="cc-rowacts"><span class="cc-chev">›</span></div>
          </div>
        `).join('')}
      </div>
    `;
  },

  _renderReviewDetail() {
    const r = this._reviews.find((x) => x.id === this._reviewDetailId);
    if (!r) {
      // Deleted, or the list reloaded without it. Fall back to the list
      // rather than render an empty shell.
      this._reviewDetailId = null;
      return this._renderReviewList();
    }
    const isAdmin = this._isAdmin;
    // A written block keeps its line breaks (cc-prose is white-space:
    // pre-wrap). A review is written in paragraphs and bullet-ish lines, and
    // flattening them into one run of text loses the shape of what was said.
    const block = (label, value) => (String(value || '').trim()
      ? `<div class="cc-section">
           <h2>${esc(label)}</h2>
           <div class="cc-prose">${esc(value)}</div>
         </div>`
      : '');

    return `
      <div class="cc-back">
        <button class="cc-btn sm ghost" id="ccRevBack">Back to reviews</button>
        <span class="grow" style="flex:1"></span>
        ${isAdmin ? `
          <button class="cc-btn sm ghost" id="ccRevEdit">Edit</button>
          <button class="cc-btn sm ghost danger" id="ccRevDelete">Delete</button>` : ''}
      </div>

      <div class="cc-profile-hd">
        <div class="cc-avatar">${esc(String(this._nameForEmployee(r.employee_id) || '?')
          .trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase())}</div>
        <div>
          <h2>${esc(this._nameForEmployee(r.employee_id))}</h2>
          <div class="sub">One-on-one, ${esc(fmtDate(r.review_date))}</div>
        </div>
      </div>

      <div class="cc-field-grid" style="margin-bottom:24px">
        <div class="cc-field"><label>Review date</label><div class="v">${fmtDate(r.review_date) || '—'}</div></div>
        <div class="cc-field"><label>Reviewer</label><div class="v">${esc(r.reviewer_name || '—')}</div></div>
        <div class="cc-field"><label>Next review</label><div class="v">${r.next_review_date ? fmtDate(r.next_review_date) : '—'}</div></div>
        <div class="cc-field"><label>Logged</label><div class="v">${r.created_at ? fmtDate(String(r.created_at).slice(0, 10)) : '—'}</div></div>
      </div>

      ${block('Summary', r.summary)}
      ${block('Strengths', r.strengths)}
      ${block('Growth areas', r.growth_areas)}
      ${!String(r.summary || '').trim() && !String(r.strengths || '').trim() && !String(r.growth_areas || '').trim()
        ? `<div class="cc-empty">Nothing was written up on this one.</div>` : ''}
      ${isAdmin ? '' : `<p style="font-size:12.5px;color:var(--muted)">
        This is your copy to read. Corrections go through whoever ran the review.</p>`}
    `;
  },

  _wireReviews() {
    const root = this._root;
    if (!root) return;

    // List: a row opens the review. No refetch — the list already holds
    // every field the detail draws.
    root.querySelectorAll('[data-review]').forEach((row) => {
      row.onclick = () => {
        this._reviewDetailId = row.dataset.review;
        this._paintReviews();
      };
    });

    const back = root.querySelector('#ccRevBack');
    if (back) back.onclick = () => { this._reviewDetailId = null; this._paintReviews(); };

    const edit = root.querySelector('#ccRevEdit');
    if (edit) edit.onclick = () => {
      const r = this._reviews.find((x) => x.id === this._reviewDetailId);
      if (r) this._openReviewForm(r);
    };

    const del = root.querySelector('#ccRevDelete');
    if (del) del.onclick = async () => {
      const r = this._reviews.find((x) => x.id === this._reviewDetailId);
      if (!r) return;
      if (!confirm('Delete this review of ' + this._nameForEmployee(r.employee_id) +
        ' from ' + fmtDate(r.review_date) + '? This cannot be undone.')) return;
      try {
        await this._ctx.api.request(ENDPOINTS.ccReviews + '?id=' + encodeURIComponent(r.id), { method: 'DELETE' });
        this._reviewDetailId = null;
        await this._refreshReviews();
      } catch (e) {
        alert((e.body && e.body.error) || e.message || 'Could not delete that review.');
      }
    };
  },

  /* ---------------- The Reviews screen: two files, one place ----------------
   *
   * An admin opens Reviews to two different things: the one-on-one history,
   * and the documentation of issues. They are separate records over separate
   * endpoints (see api/crewcore/docs.js for why), but they are the same
   * question asked about the same person, so putting them behind two rail
   * buttons would mean picking the wrong one half the time.
   *
   * A self-serve employee has no tab strip at all. There is nothing to
   * switch to: documentation is not theirs to read, and the endpoint behind
   * it refuses them anyway.
   */

  /** Draw the whole screen: tab strip, header button, and the active tab. */
  _paintReviewScreen() {
    const root = this._root;
    const body = root.querySelector('#ccBody');
    const actions = root.querySelector('#ccHdActions');
    if (!body) return;
    const isAdmin = this._isAdmin;
    const onDocs = isAdmin && this._reviewTab === 'docs';

    body.innerHTML = (isAdmin ? `
      <div class="cc-tabs">
        <button class="cc-tab${onDocs ? '' : ' on'}" data-tab="reviews">
          Review history<span class="n">${this._reviews.length}</span>
        </button>
        <button class="cc-tab${onDocs ? ' on' : ''}" data-tab="docs">
          Documentation<span class="n">${this._docs.length}</span>
        </button>
      </div>` : '') + `<div id="ccTabBody"></div>`;

    // The header button follows the tab. One button that means two things
    // depending on what is showing underneath it is how somebody logs a
    // review into a person's documentation file by accident.
    if (actions) {
      actions.innerHTML = !isAdmin ? '' : (onDocs
        ? `<button class="cc-btn" id="ccAddDocBtn">Add documentation</button>`
        : `<button class="cc-btn" id="ccAddReviewBtn">Log a review</button>`);
      const rb = root.querySelector('#ccAddReviewBtn');
      if (rb) rb.onclick = () => this._openReviewForm();
      const db = root.querySelector('#ccAddDocBtn');
      if (db) db.onclick = () => this._openDocForm();
    }

    body.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.onclick = () => {
        this._reviewTab = btn.dataset.tab;
        // Switching tabs closes whatever was open on the other one, so
        // coming back lands on a list rather than on a record somebody
        // opened ten minutes ago.
        this._reviewDetailId = null;
        this._docDetailId = null;
        this._paintReviewScreen();
      };
    });

    this._paintReviewTab();
  },

  /** Redraw just the active tab's body from what is already loaded. */
  _paintReviewTab() {
    const holder = this._root.querySelector('#ccTabBody');
    if (!holder) return;
    if (this._isAdmin && this._reviewTab === 'docs') {
      holder.innerHTML = this._renderDocs();
      this._wireDocs();
      return;
    }
    holder.innerHTML = this._renderReviews();
    this._wireReviews();
  },

  /** Redraw the reviews body from what is already loaded. */
  _paintReviews() {
    this._paintReviewTab();
  },

  /**
   * Refetch, then redraw — keeping whichever review is open. The whole
   * screen is repainted rather than just the tab body, because a review
   * added or deleted changes the count printed on the tab itself.
   */
  async _refreshReviews() {
    await this._loadReviews();
    this._paintReviewScreen();
  },

  /* ---------------- Documentation ---------------- */

  /**
   * Issues and problems, admin only. Same list-then-detail shape as reviews
   * and the stipend log, for the same reason: an entry is several paragraphs
   * and a list showing all of it is unreadable at ten entries.
   */
  _renderDocs() {
    // Belt and braces. The tab is only drawn for an admin and the route
    // refuses anybody else, but this function must never render an entry to
    // a caller who should not have one.
    if (!this._isAdmin) {
      return `<div class="cc-locked"><h2>Admin access required</h2></div>`;
    }
    const warn = `
      <div class="cc-doc-warn">
        <strong>Administrators only.</strong>
        Nothing on this tab is visible to the person it is about, or to anybody
        else without the Admin flag. Employees see their review history and
        nothing else on this screen.
      </div>`;
    return warn + (this._docDetailId ? this._renderDocDetail() : this._renderDocList());
  },

  _renderDocList() {
    const people = this._employees.slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const rows = docsFor(this._docs, this._docPerson || null, null);

    const toolbar = `
      <div class="cc-toolbar">
        <select class="cc-filt" id="ccDocPerson">
          <option value="">Everybody</option>
          ${people.map((e) => {
            const n = docsFor(this._docs, e.id, null).length;
            return `<option value="${esc(e.id)}"${this._docPerson === e.id ? ' selected' : ''}>${esc(e.name)}${n ? ' (' + n + ')' : ''}</option>`;
          }).join('')}
        </select>
      </div>`;

    if (!rows.length) {
      return toolbar + `<div class="cc-empty">${this._docPerson
        ? 'Nothing on file for ' + esc(this._nameForEmployee(this._docPerson)) + '.'
        : 'Nothing documented yet.'}</div>`;
    }

    // Newest first. The store already sorts on date, but the screen holds
    // whatever a refresh last handed it, so the order is asserted here too.
    const sorted = rows.slice()
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    return toolbar + `
      <div class="cc-list">
        ${sorted.map((d) => `
          <div class="cc-row tap" data-doc="${esc(d.id)}">
            <div>
              <div class="who">${esc(this._nameForEmployee(d.employee_id))}</div>
              <div class="meta">
                ${fmtDate(d.date)}
                ${d.category ? ' · ' + esc(d.category) : ''}
                <span class="chip ${isFormalDoc(d) ? 'formal' : 'note'}" style="margin-left:6px">${esc(d.level || 'note')}</span>
              </div>
              ${d.summary ? `<div class="meta cc-clamp" style="margin-top:4px">${esc(d.summary)}</div>` : ''}
            </div>
            <div class="cc-rowacts"><span class="cc-chev">›</span></div>
          </div>
        `).join('')}
      </div>`;
  },

  _renderDocDetail() {
    const d = this._docs.find((x) => x.id === this._docDetailId);
    if (!d) {
      // Deleted, or a refresh came back without it. Fall back to the list
      // rather than draw an empty shell.
      this._docDetailId = null;
      return this._renderDocList();
    }
    const block = (label, value) => (String(value || '').trim()
      ? `<div class="cc-section">
           <h2>${esc(label)}</h2>
           <div class="cc-prose">${esc(value)}</div>
         </div>`
      : '');

    return `
      <div class="cc-back">
        <button class="cc-btn sm ghost" id="ccDocBack">Back to documentation</button>
        <span class="grow" style="flex:1"></span>
        <button class="cc-btn sm ghost" id="ccDocEdit">Edit</button>
        <button class="cc-btn sm ghost danger" id="ccDocDelete">Delete</button>
      </div>

      <div class="cc-profile-hd">
        <div class="cc-avatar">${esc(String(this._nameForEmployee(d.employee_id) || '?')
          .trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase())}</div>
        <div>
          <h2>${esc(this._nameForEmployee(d.employee_id))}</h2>
          <div class="sub">${esc(d.summary || 'Documentation')}</div>
        </div>
      </div>

      <div class="cc-field-grid" style="margin-bottom:24px">
        <div class="cc-field"><label>Date</label><div class="v">${fmtDate(d.date) || '—'}</div></div>
        <div class="cc-field"><label>What it is about</label><div class="v">${esc(d.category || '—')}</div></div>
        <div class="cc-field"><label>Level</label><div class="v">
          <span class="chip ${isFormalDoc(d) ? 'formal' : 'note'}">${esc(d.level || 'note')}</span></div></div>
        <div class="cc-field"><label>Follow up</label><div class="v">${d.follow_up_date ? fmtDate(d.follow_up_date) : '—'}</div></div>
        <div class="cc-field"><label>Others present</label><div class="v">${esc(d.others_present || '—')}</div></div>
        <div class="cc-field"><label>Written by</label><div class="v">${esc(d.created_by || '—')}${
          d.created_at ? ', ' + fmtDate(String(d.created_at).slice(0, 10)) : ''}</div></div>
      </div>

      ${block('What happened', d.details)}
      ${block('Action taken', d.action_taken)}
      ${!String(d.details || '').trim() && !String(d.action_taken || '').trim()
        ? `<div class="cc-empty">Only the one line above was written up on this one.</div>` : ''}
    `;
  },

  _wireDocs() {
    const root = this._root;
    if (!root) return;

    const person = root.querySelector('#ccDocPerson');
    if (person) person.onchange = () => {
      this._docPerson = person.value;
      this._paintReviewTab();
    };

    root.querySelectorAll('[data-doc]').forEach((row) => {
      row.onclick = () => {
        this._docDetailId = row.dataset.doc;
        this._paintReviewTab();
      };
    });

    const back = root.querySelector('#ccDocBack');
    if (back) back.onclick = () => { this._docDetailId = null; this._paintReviewTab(); };

    const edit = root.querySelector('#ccDocEdit');
    if (edit) edit.onclick = () => {
      const d = this._docs.find((x) => x.id === this._docDetailId);
      if (d) this._openDocForm(d);
    };

    const del = root.querySelector('#ccDocDelete');
    if (del) del.onclick = async () => {
      const d = this._docs.find((x) => x.id === this._docDetailId);
      if (!d) return;
      if (!confirm('Delete this documentation on ' + this._nameForEmployee(d.employee_id) +
        ' from ' + fmtDate(d.date) + '? This cannot be undone.')) return;
      try {
        await this._ctx.api.request(ENDPOINTS.ccDocs + '?id=' + encodeURIComponent(d.id), { method: 'DELETE' });
        this._docDetailId = null;
        await this._refreshDocs();
      } catch (e) {
        alert((e.body && e.body.error) || e.message || 'Could not delete that entry.');
      }
    };
  },

  /** Refetch documentation, then repaint the whole screen so the tab count moves. */
  async _refreshDocs() {
    await this._loadDocs();
    this._paintReviewScreen();
  },

  /**
   * Write a new entry, or correct one that exists. One form either way, the
   * same rule the review form follows.
   *
   * On edit the employee cannot be changed. Moving an entry from one
   * person's file to another's is not a correction, and the server pins the
   * field regardless of what the browser sends.
   */
  _openDocForm(doc) {
    const editing = !!(doc && doc.id);
    const root = this._root;
    const holder = root.querySelector('#ccTabBody') || root.querySelector('#ccBody');
    const wrap = document.createElement('div');
    const val = (k) => esc((doc && doc[k]) || '');
    const today = new Date().toISOString().slice(0, 10);

    wrap.innerHTML = `
      <div class="cc-form">
        <h3>${editing ? 'Edit documentation' : 'Add documentation'}</h3>
        <div class="hint">Only administrators can read this. The person it is about cannot.</div>
        <div class="cc-form-grid">
          <div class="full"><label>Employee</label>
            ${editing
              ? `<input value="${esc(this._nameForEmployee(doc.employee_id))}" disabled>`
              : `<select id="dEmp">${this._employees.slice()
                    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
                    .map((e) => `<option value="${esc(e.id)}"${this._docPerson === e.id ? ' selected' : ''}>${esc(e.name)}</option>`).join('')}</select>`}
          </div>
          <div><label>Date</label><input id="dDate" type="date" value="${editing ? val('date') : today}"></div>
          <div><label>What it is about</label>
            <select id="dCat">${DOC_CATEGORIES.map((c) =>
              `<option value="${esc(c)}"${(doc && doc.category) === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
          </div>
          <div><label>Level</label>
            <select id="dLevel">${DOC_LEVELS.map((l) =>
              `<option value="${esc(l)}"${(doc && doc.level) === l ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
          </div>
          <div><label>Follow up date</label><input id="dFollow" type="date" value="${val('follow_up_date')}"></div>
          <div class="full"><label>One line: what happened</label><input id="dSummary" value="${val('summary')}"></div>
          <div class="full"><label>The full write-up</label><textarea id="dDetails" rows="5">${val('details')}</textarea></div>
          <div><label>Action taken</label><textarea id="dAction" rows="3">${val('action_taken')}</textarea></div>
          <div><label>Others present</label><input id="dOthers" value="${val('others_present')}"></div>
        </div>
        <div class="cc-err" id="dErr" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn ghost" id="dCancel">Cancel</button>
          <button class="cc-btn" id="dSubmit">Save</button>
        </div>
      </div>
    `;
    holder.prepend(wrap);
    const $ = (sel) => wrap.querySelector(sel);
    const err = $('#dErr');

    $('#dCancel').onclick = () => wrap.remove();
    $('#dSubmit').onclick = async () => {
      const payload = {
        employee_id: editing ? doc.employee_id : ($('#dEmp') ? $('#dEmp').value : ''),
        date: $('#dDate').value,
        category: $('#dCat').value,
        level: $('#dLevel').value,
        summary: $('#dSummary').value,
        details: $('#dDetails').value,
        action_taken: $('#dAction').value,
        others_present: $('#dOthers').value,
        follow_up_date: $('#dFollow').value
      };
      try {
        if (editing) {
          await this._ctx.api.request(ENDPOINTS.ccDocs + '?id=' + encodeURIComponent(doc.id), { method: 'PATCH', body: payload });
          wrap.remove();
          // Stay on the entry that was just corrected, so the change shows
          // where it was made rather than back on a list.
          this._docDetailId = doc.id;
        } else {
          await this._ctx.api.request(ENDPOINTS.ccDocs, { method: 'POST', body: payload });
          wrap.remove();
          this._docDetailId = null;
        }
        await this._refreshDocs();
      } catch (e) {
        err.hidden = false;
        err.textContent = (e.body && e.body.details && e.body.details.join(', ')) || e.message || 'Could not save.';
      }
    };
  },

  /**
   * Log a new review, or edit one that exists. Same form either way: the
   * fields are identical, and two near-copies of a seven-field form is how
   * an edit screen quietly loses a field the add screen gained.
   *
   * On edit the employee cannot be changed. Moving a review from one
   * person's file to another's is not a correction, it is two operations
   * (delete, re-log) and should look like it.
   */
  _openReviewForm(review) {
    const editing = !!(review && review.id);
    const root = this._root;
    // Into the tab body, not #ccBody: prepending to the outer container
    // would put the form above the tab strip, which reads as belonging to
    // the screen rather than to the file being written into.
    const body = root.querySelector('#ccTabBody') || root.querySelector('#ccBody');
    const wrap = document.createElement('div');
    const val = (k) => esc((review && review[k]) || '');
    wrap.innerHTML = `
      <div class="cc-form">
        <h3>${editing ? 'Edit review' : 'Log a review'}</h3>
        <div class="cc-form-grid">
          <div class="full"><label>Employee</label>
            ${editing
              ? `<input value="${esc(this._nameForEmployee(review.employee_id))}" disabled>`
              : `<select id="fEmp">${this._employees.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}</select>`}
          </div>
          <div><label>Review date</label><input id="fDate" type="date" value="${val('review_date')}"></div>
          <div><label>Reviewer</label><input id="fReviewer" value="${editing ? val('reviewer_name') : esc(this._ctx.user ? this._ctx.user.name : '')}"></div>
          <div class="full"><label>Summary</label><textarea id="fSummary" rows="3">${val('summary')}</textarea></div>
          <div><label>Strengths</label><textarea id="fStrengths" rows="3">${val('strengths')}</textarea></div>
          <div><label>Growth areas</label><textarea id="fGrowth" rows="3">${val('growth_areas')}</textarea></div>
          <div><label>Next review date</label><input id="fNext" type="date" value="${val('next_review_date')}"></div>
        </div>
        <div class="cc-err" id="fErr" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn ghost" id="fCancel">Cancel</button>
          <button class="cc-btn" id="fSubmit">Save</button>
        </div>
      </div>
    `;
    body.prepend(wrap);
    const $ = (sel) => wrap.querySelector(sel);
    const err = $('#fErr');

    $('#fCancel').onclick = () => wrap.remove();
    $('#fSubmit').onclick = async () => {
      const payload = {
        employee_id: editing ? review.employee_id : $('#fEmp').value,
        review_date: $('#fDate').value,
        reviewer_name: $('#fReviewer').value,
        summary: $('#fSummary').value,
        strengths: $('#fStrengths').value,
        growth_areas: $('#fGrowth').value,
        next_review_date: $('#fNext').value
      };
      try {
        if (editing) {
          await this._ctx.api.request(ENDPOINTS.ccReviews + '?id=' + encodeURIComponent(review.id), { method: 'PATCH', body: payload });
          wrap.remove();
          // Stay on the review that was just edited, so the change is
          // visible where it was made rather than back on a list.
          this._reviewDetailId = review.id;
          await this._refreshReviews();
        } else {
          await this._ctx.api.request(ENDPOINTS.ccReviews, { method: 'POST', body: payload });
          wrap.remove();
          this.showView('reviews');
        }
      } catch (e) {
        err.hidden = false; err.textContent = (e.body && e.body.details && e.body.details.join(', ')) || e.message || 'Could not save.';
      }
    };
  },

  /* ---------------- Kudos ----------------
   *
   * The one screen in this app anybody can write to. A manager giving
   * credit and one employee thanking another are the same record, so there
   * is no admin half and no self-serve half here: everybody sees the same
   * feed and the same button.
   *
   * Names come from the kudos endpoint rather than from the roster, because
   * a self-serve employee cannot open the roster. What it hands back is ids
   * and names only.
   */

  _renderKudos() {
    const me = this._kudosMe || {};
    const mineId = me.employee_id || null;

    const all = this._kudos || [];
    const rows = this._kudosFilter === 'mine'
      ? kudosFor(all, { to: mineId })
      : (this._kudosFilter === 'given'
        ? all.filter((k) => String(k.from_username || '').toLowerCase() === String(me.username || '').toLowerCase())
        : all);

    // "For me" only appears for somebody with an employee record to receive
    // kudos against. An admin account with no record of its own would get a
    // tab that is always empty and always will be.
    const tabs = `
      <div class="cc-tabs">
        <button class="cc-tab${this._kudosFilter === 'all' ? ' on' : ''}" data-kfilter="all">
          Everyone<span class="n">${all.length}</span>
        </button>
        ${mineId ? `<button class="cc-tab${this._kudosFilter === 'mine' ? ' on' : ''}" data-kfilter="mine">
          For me<span class="n">${kudosFor(all, { to: mineId }).length}</span>
        </button>` : ''}
        <button class="cc-tab${this._kudosFilter === 'given' ? ' on' : ''}" data-kfilter="given">
          I gave
        </button>
      </div>`;

    if (!rows.length) {
      const empty = this._kudosFilter === 'mine'
        ? 'Nothing addressed to you yet.'
        : (this._kudosFilter === 'given'
          ? 'You have not given any kudos yet. The button up top is how.'
          : 'No kudos yet. Somebody has to go first.');
      return tabs + `<div class="cc-empty">${esc(empty)}</div>`;
    }

    return tabs + `
      <div class="cc-kudos">
        ${rows.map((k) => {
          // Prefer the live roster name, fall back to the name stored when
          // it was written. Somebody renamed on the roster should read as
          // their current name, and somebody no longer on it should still
          // read as a name rather than an id.
          const to = this._kudosNames[k.to_employee_id] || k.to_name || k.to_employee_id;
          const canDelete = canDeleteKudos(k, { username: me.username, isAdmin: me.is_admin === true });
          const forMe = mineId && k.to_employee_id === mineId;
          return `
            <div class="cc-kudo${forMe ? ' mine' : ''}">
              ${canDelete ? `<button class="cc-kudo-x" data-kdel="${esc(k.id)}" title="Remove this">×</button>` : ''}
              <div class="to">${esc(to)}</div>
              ${k.tag ? `<div style="margin-top:6px"><span class="cc-tag">${esc(k.tag)}</span></div>` : ''}
              <div class="msg">${esc(k.message || '')}</div>
              <div class="from">from ${esc(k.from_name || 'somebody')}${
                k.created_at ? ' · ' + fmtDate(String(k.created_at).slice(0, 10)) : ''}</div>
            </div>`;
        }).join('')}
      </div>`;
  },

  _wireKudos() {
    const root = this._root;
    if (!root) return;

    root.querySelectorAll('[data-kfilter]').forEach((btn) => {
      btn.onclick = () => {
        this._kudosFilter = btn.dataset.kfilter;
        this._paintKudos();
      };
    });

    root.querySelectorAll('[data-kdel]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Remove this kudos? It disappears for everybody.')) return;
        try {
          await this._ctx.api.request(ENDPOINTS.ccKudos + '?id=' + encodeURIComponent(btn.dataset.kdel), { method: 'DELETE' });
          await this._refreshKudos();
        } catch (e) {
          alert((e.body && e.body.error) || e.message || 'Could not remove that kudos.');
        }
      };
    });
  },

  _paintKudos() {
    const body = this._root.querySelector('#ccBody');
    if (!body) return;
    body.innerHTML = this._renderKudos();
    this._wireKudos();
  },

  async _refreshKudos() {
    await this._loadKudos();
    this._paintKudos();
  },

  /**
   * Give kudos. No edit form to share with, deliberately: a kudos is two
   * lines about a colleague, and if it is wrong it gets removed and written
   * again rather than carrying an edit trail heavier than the record.
   *
   * Your own name is not in the picker, because the endpoint hands back
   * everybody EXCEPT you. The server refuses a self-addressed one anyway;
   * this just means nobody has to be told no.
   */
  _openKudosForm() {
    const root = this._root;
    const body = root.querySelector('#ccBody');
    const people = this._kudosPeople || [];
    const wrap = document.createElement('div');

    if (!people.length) {
      wrap.innerHTML = `
        <div class="cc-form">
          <h3>Give kudos</h3>
          <div class="hint">There is nobody else on the roster yet, so there is
            nobody to give kudos to. An administrator adds people under Roster.</div>
          <div class="cc-form-actions">
            <button class="cc-btn ghost" id="kCancel">Close</button>
          </div>
        </div>`;
      body.prepend(wrap);
      wrap.querySelector('#kCancel').onclick = () => wrap.remove();
      return;
    }

    wrap.innerHTML = `
      <div class="cc-form">
        <h3>Give kudos</h3>
        <div class="hint">Everybody with CrewCore can read this, which is the point.
          It cannot be edited later, only removed.</div>
        <div class="cc-form-grid">
          <div><label>Who</label>
            <select id="kTo">${people.map((pp) =>
              `<option value="${esc(pp.id)}">${esc(pp.name)}</option>`).join('')}</select>
          </div>
          <div><label>What for (optional)</label>
            <select id="kTag">
              <option value="">No label</option>
              ${KUDOS_TAGS.map((tg) => `<option value="${esc(tg)}">${esc(tg)}</option>`).join('')}
            </select>
          </div>
          <div class="full"><label>What they did</label>
            <textarea id="kMsg" rows="4" maxlength="${KUDOS_MAX_LENGTH}"></textarea>
          </div>
        </div>
        <div class="cc-err" id="kErr" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn ghost" id="kCancel">Cancel</button>
          <button class="cc-btn" id="kSubmit">Post it</button>
        </div>
      </div>
    `;
    body.prepend(wrap);
    const $ = (sel) => wrap.querySelector(sel);
    const err = $('#kErr');

    $('#kCancel').onclick = () => wrap.remove();
    $('#kSubmit').onclick = async () => {
      const payload = {
        to_employee_id: $('#kTo').value,
        tag: $('#kTag').value,
        message: $('#kMsg').value
      };
      try {
        await this._ctx.api.request(ENDPOINTS.ccKudos, { method: 'POST', body: payload });
        wrap.remove();
        // Land on the whole feed, not on whichever tab was open: a kudos you
        // just gave somebody else would be invisible on "For me".
        this._kudosFilter = 'all';
        await this._refreshKudos();
      } catch (e) {
        err.hidden = false;
        err.textContent = (e.body && e.body.details && e.body.details.join(', ')) || (e.body && e.body.error) || e.message || 'Could not post that.';
      }
    };
  },

  /* ---------------- Handbook ---------------- */

  _renderHandbook() {
    const hb = this._handbook;
    if (!hb || !Array.isArray(hb.sections)) {
      return `<div class="cc-empty">Handbook content isn't available right now.</div>`;
    }
    const blockHtml = (b) => {
      if (b.h) return `<h3>${esc(b.h)}</h3>`;
      if (b.p) return `<p>${esc(b.p)}</p>`;
      if (b.list) return `<ul>${b.list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>`;
      return '';
    };

    // The handbook's own content has two different characters: the first
    // three sections are the founding story (About Us / Our Purpose / Our
    // Niche), everything after is policy. STORY_IDS below is how the split
    // is made without needing a new field on the content itself — if the
    // handbook content ever grows a real "kind" field this can read that
    // instead, but for now the three ids are stable (see
    // lib/crewcore/handbook-content.js).
    const STORY_IDS = new Set(['about-us', 'our-purpose', 'our-niche']);
    const story = hb.sections.filter((s) => STORY_IDS.has(s.id));
    const policy = hb.sections.filter((s) => !STORY_IDS.has(s.id));

    // Numbering only applies to the policy chapters. They ARE a sequence an
    // employee reads in order (basics, then pay, then conduct, then what
    // happens if it ends) — the story sections aren't a sequence, they're
    // one origin story told in three parts, so they don't get chapter
    // numbers.
    const policyNumbered = policy.map((s, i) => ({ ...s, num: i + 1 }));

    // Acknowledgment banner: only rendered for a self-serve caller (hb.
    // acknowledged is only ever present in the self-serve response shape —
    // see api/crewcore/handbook.js GET, which omits it entirely for admins).
    // Admins reading the handbook never see this at all.
    let ackHtml = '';
    if (hb.acknowledged === false) {
      ackHtml = `
        <div class="cc-hb-ack cc-hb-ack-pending">
          <div class="cc-hb-ack-text">
            <strong>Please read and agree to the handbook.</strong>
            You'll need to agree before you can use the rest of CrewCore.
          </div>
          <button class="cc-btn" id="ccHbAckBtn">I've read and agree</button>
        </div>
      `;
    } else if (hb.acknowledged === true) {
      const when = hb.ack_at ? new Date(hb.ack_at).toLocaleDateString() : '';
      ackHtml = `
        <div class="cc-hb-ack cc-hb-ack-done">
          <div class="cc-hb-ack-text">
            <strong>You're up to date.</strong>
            Agreed to this version${when ? ' on ' + esc(when) : ''}.
          </div>
        </div>
      `;
    }

    return `
      <div class="cc-hb-cover">
        <div class="cc-hb-cover-mark">
          <span class="w1">Crew</span><span class="w2">Core</span><span class="dot">.</span>
        </div>
        <h1 class="cc-hb-cover-title">Employee Handbook</h1>
        <div class="cc-hb-cover-sub">P&amp;M Apparel &middot; est. 1987 &middot; Polk City, Iowa</div>
        <div class="cc-hb-updated">Last updated ${esc(hb.updated || '')}</div>
      </div>

      ${ackHtml}

      <div class="cc-hb-nav">
        ${story.map((s) => `<button class="cc-hb-navbtn cc-hb-navbtn-story" data-jump="${esc(s.id)}">${esc(s.title)}</button>`).join('')}
        ${policyNumbered.map((s) => `<button class="cc-hb-navbtn" data-jump="${esc(s.id)}"><span class="cc-hb-navnum">${s.num}</span>${esc(s.title)}</button>`).join('')}
      </div>

      ${story.length ? `
        <div class="cc-hb-story">
          <div class="cc-hb-story-rule"><span>Our Story</span></div>
          ${story.map((s) => `
            <div class="cc-hb-section cc-hb-story-section" id="hb-${esc(s.id)}">
              <h2>${esc(s.title)}</h2>
              ${s.blocks.map(blockHtml).join('')}
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${policyNumbered.length ? `
        <div class="cc-hb-story-rule"><span>Policies &amp; Procedures</span></div>
        ${policyNumbered.map((s) => `
          <div class="cc-hb-section" id="hb-${esc(s.id)}">
            <div class="cc-hb-chapnum">${String(s.num).padStart(2, '0')}</div>
            <h2>${esc(s.title)}</h2>
            ${s.blocks.map(blockHtml).join('')}
          </div>
        `).join('')}
      ` : ''}

      ${hb.acknowledged === false ? `
        <div class="cc-hb-ack cc-hb-ack-pending cc-hb-ack-bottom">
          <div class="cc-hb-ack-text">
            <strong>That's the whole handbook.</strong>
            If you've read it, agree below to continue.
          </div>
          <button class="cc-btn" id="ccHbAckBtnBottom">I've read and agree</button>
        </div>
      ` : ''}
    `;
  },

  _wireHandbook() {
    const root = this._root;
    const body = root.querySelector('#ccBody');
    body.querySelectorAll('button[data-jump]').forEach((btn) => {
      btn.onclick = () => {
        const target = body.querySelector('#hb-' + btn.dataset.jump);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });

    const ackBtns = [body.querySelector('#ccHbAckBtn'), body.querySelector('#ccHbAckBtnBottom')].filter(Boolean);
    ackBtns.forEach((btn) => {
      btn.onclick = async () => {
        ackBtns.forEach((b) => { b.disabled = true; b.textContent = 'Saving\u2026'; });
        try {
          const out = await this._ctx.api.request(ENDPOINTS.ccHandbook, { method: 'POST', body: {} });
          this._handbook = {
            ...this._handbook,
            acknowledged: true,
            ack_version: out.ack_version,
            ack_at: out.ack_at,
          };
          // Re-render the handbook view in place so the banner flips to
          // "You're up to date" — the person stays right where they were
          // reading rather than being bounced anywhere.
          body.innerHTML = this._renderHandbook();
          this._wireHandbook();
        } catch (e) {
          ackBtns.forEach((b) => { b.disabled = false; b.textContent = "I've read and agree"; });
          alert('Could not save your agreement: ' + (e.message || 'unknown error') + '. Please try again.');
        }
      };
    });
  },

  /* ---------------- Settings (admin only) ---------------- */

  _renderSettings() {
    const s = this._settings || {};
    return `
      <div class="cc-form" style="max-width:480px">
        <h3>Apparel stipend defaults</h3>
        <div class="cc-form-grid">
          <div>
            <label>Front Office ($/year)</label>
            <input id="sFrontOffice" type="number" step="0.01" value="${s.default_stipend_front_office != null ? s.default_stipend_front_office : 250}">
          </div>
          <div>
            <label>Production ($/year)</label>
            <input id="sProduction" type="number" step="0.01" value="${s.default_stipend_production != null ? s.default_stipend_production : 150}">
          </div>
          <div class="full">
            <label>Self-serve</label>
            <select id="sSelfServe">
              <option value="true" ${s.self_serve_enabled !== false ? 'selected' : ''}>Enabled</option>
              <option value="false" ${s.self_serve_enabled === false ? 'selected' : ''}>Disabled (admin enters everything)</option>
            </select>
          </div>
        </div>
        <div class="cc-err" id="sErr" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn" id="sSave">Save</button>
        </div>
      </div>

      <div class="cc-form" style="max-width:480px">
        <h3>Time clock</h3>
        <div class="cc-form-grid">
          <div class="full">
            <label>Kiosk</label>
            <select id="sClockOn">
              <option value="true" ${s.clock_enabled !== false ? 'selected' : ''}>On</option>
              <option value="false" ${s.clock_enabled === false ? 'selected' : ''}>Off (nobody can punch)</option>
            </select>
          </div>
          <div>
            <label>Pay week starts</label>
            <select id="sWeekStart">
              ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
                .map((d, i) => `<option value="${i}" ${Number(s.week_start_day || 0) === i ? 'selected' : ''}>${d}</option>`).join('')}
            </select>
          </div>
          <div>
            <label>Overtime after (hours)</label>
            <input id="sOt" type="number" step="0.5" value="${s.overtime_after_hours != null ? s.overtime_after_hours : 40}">
          </div>
          <div>
            <label>Round totals to</label>
            <select id="sRound">
              ${[[0, 'Exact, no rounding'], [5, '5 minutes'], [6, '6 minutes (tenth of an hour)'], [10, '10 minutes'], [15, '15 minutes']]
                .map(([v, l]) => `<option value="${v}" ${Number(s.clock_round_minutes || 0) === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div>
            <label>Kiosk link word (optional)</label>
            <input id="sKioskToken" value="${esc(s.clock_kiosk_token || '')}" placeholder="blank = open link">
          </div>
        </div>
        <div class="cc-err" id="sErr2" hidden></div>
        <div class="cc-form-actions">
          <button class="cc-btn" id="sSaveClock">Save</button>
        </div>
      </div>
      <p style="font-size:12.5px;color:var(--muted);max-width:480px">
        The kiosk lives at <code>${esc(location.origin)}/clock</code>. Bookmark
        it on the shop tablet. Rounding only shapes the totals that get
        reported and exported, never the punch times themselves, so the
        record of what someone actually clocked stays exact. Setting a link
        word means the kiosk needs
        <code>${esc(location.origin)}/clock?k=YOURWORD</code> and the name
        list won't load without it.
      </p>
      <p style="font-size:12.5px;color:var(--muted);max-width:480px">
        These figures set the default when a NEW employee is added — they
        don't retroactively change anyone already on the roster. Per the
        Handbook's Dress Code policy, Sales and Office count as Front
        Office; Screen Printing, Embroidery, and Art count as Production.
        Disabling self-serve does not remove the "employee" role or revoke
        anyone's login, it's a soft switch for whether new self-serve
        behavior is expected to be on.
      </p>
    `;
  },

  _wireSettings() {
    const root = this._root;
    const body = root.querySelector('#ccBody');
    const $ = (sel) => body.querySelector(sel);
    const err = $('#sErr');

    $('#sSave').onclick = async () => {
      const payload = {
        default_stipend_front_office: Number($('#sFrontOffice').value),
        default_stipend_production: Number($('#sProduction').value),
        self_serve_enabled: $('#sSelfServe').value === 'true'
      };
      try {
        const out = await this._ctx.api.request(ENDPOINTS.ccSettings, { method: 'PATCH', body: payload });
        this._settings = out.settings;
        err.hidden = true;
      } catch (e) {
        err.hidden = false;
        err.textContent = (e.body && e.body.details && e.body.details.join(', ')) || e.message || 'Could not save.';
      }
    };

    const err2 = $('#sErr2');
    $('#sSaveClock').onclick = async () => {
      const payload = {
        clock_enabled: $('#sClockOn').value === 'true',
        week_start_day: Number($('#sWeekStart').value),
        overtime_after_hours: Number($('#sOt').value),
        clock_round_minutes: Number($('#sRound').value),
        clock_kiosk_token: $('#sKioskToken').value
      };
      try {
        const out = await this._ctx.api.request(ENDPOINTS.ccSettings, { method: 'PATCH', body: payload });
        this._settings = out.settings;
        err2.hidden = true;
      } catch (e) {
        err2.hidden = false;
        err2.textContent = (e.body && e.body.details && e.body.details.join(', ')) || e.message || 'Could not save.';
      }
    };
  },

  /* ---------------- Modal ----------------
   *
   * Same pattern as MailMe, including the two constraints its comments
   * document, because both were real bugs there and would be real here:
   *
   *   - The backdrop attaches to <body>, not the app root. The shell's
   *     .view runs a transform animation, and a transformed ancestor makes
   *     position:fixed resolve against IT rather than the viewport, which
   *     pins the overlay under the header and clips its top.
   *   - It is wrapped in a carrier div carrying data-app-root="crewcore",
   *     because js/app-host.js scopes every .cc-* rule to that selector. A
   *     bare body child would render completely unstyled.
   */

  _openModal(innerHtml) {
    this._closeModal();

    const back = document.createElement('div');
    back.className = 'cc-modal-back';
    back.innerHTML = `<div class="cc-modal" role="dialog" aria-modal="true">
      <button class="cc-modal-x" id="ccModalX" aria-label="Close">&times;</button>
      <div id="ccModalBody">${innerHtml}</div></div>`;

    // Clicking the backdrop closes, clicking inside must not.
    back.addEventListener('click', (ev) => { if (ev.target === back) this._closeModal(); });
    back.querySelector('#ccModalX').addEventListener('click', () => this._closeModal());

    this._escClose = (ev) => { if (ev.key === 'Escape') this._closeModal(); };
    document.addEventListener('keydown', this._escClose);

    const carrier = document.createElement('div');
    carrier.dataset.appRoot = 'crewcore';
    carrier.appendChild(back);
    document.body.appendChild(carrier);
    this._modalCarrier = carrier;

    // Stop the week grid behind the overlay scrolling with the wheel.
    document.body.style.overflow = 'hidden';
    return back;
  },

  _closeModal() {
    if (this._modalCarrier) {
      this._modalCarrier.remove();
      this._modalCarrier = null;
    }
    if (this._escClose) {
      document.removeEventListener('keydown', this._escClose);
      this._escClose = null;
    }
    document.body.style.overflow = '';
  },

  /* ---------------- Time Clock ----------------
   *
   * Rush build, Aug 2026, replacing the shop's broken clock in/out system.
   *
   * Nobody PUNCHES here. Punching happens on /clock, a public page outside
   * the shell, because most of production has no Alliteration login. This
   * view is the back side: read the week, spot a missed punch, fix it,
   * export it for payroll.
   *
   * Same adaptive split as Roster. An admin gets the whole team and every
   * write. A self-serve employee gets their own hours, read only — worth
   * having, since "what did I actually work" was the question the broken
   * system left nobody able to answer.
   */

  async _loadTimecards() {
    const q = [];
    if (this._tcWeek) q.push('week=' + encodeURIComponent(this._tcWeek));
    if (this._tcDept) q.push('dept=' + encodeURIComponent(this._tcDept));
    if (this._tcEmployee) q.push('employee_id=' + encodeURIComponent(this._tcEmployee));
    if (this._tcInactive) q.push('include_inactive=1');
    const url = ENDPOINTS.ccTimecards + (q.length ? '?' + q.join('&') : '');
    this._tc = await this._ctx.api.get(url);
    // Pin the resolved week so the Prev/Next buttons have something concrete
    // to step from, instead of re-resolving "today" on every click.
    if (this._tc && this._tc.week_key) this._tcWeek = this._tc.week_key;
  },

  _tcShiftWeek(n) {
    const base = this._tcWeek || (this._tc && this._tc.week_key);
    if (!base) return;
    const [y, m, d] = base.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (7 * n));
    const p = (x) => String(x).padStart(2, '0');
    this._tcWeek = `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
    this.showView('timeclock');
  },

  _tcWeekLabel() {
    const dates = (this._tc && this._tc.dates) || [];
    if (!dates.length) return '';
    return fmtDate(dates[0]) + ' to ' + fmtDate(dates[6]);
  },

  _tcDayHead(dateStr) {
    const DL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const [y, m, d] = dateStr.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return { label: DL[dow], num: m + '/' + d };
  },

  _tcHrs(n) {
    const v = Number(n) || 0;
    return v ? v.toFixed(2) : '';
  },

  _renderTcToolbar() {
    const emps = this._employees || [];
    return `
      <div class="cc-toolbar">
        <div class="tc-weeknav">
          <button class="cc-btn ghost sm" id="tcPrev">&lsaquo; Prev</button>
          <span class="tc-weeklabel" id="tcLabel">${esc(this._tcWeekLabel())}</span>
          <button class="cc-btn ghost sm" id="tcNext">Next &rsaquo;</button>
          <button class="cc-btn ghost sm" id="tcToday">This week</button>
        </div>
        <span class="tc-spacer"></span>
        <select class="cc-filt" id="tcDept">
          <option value="">All departments</option>
          ${DEPARTMENTS.map((d) => `<option value="${esc(d)}" ${this._tcDept === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
        </select>
        <select class="cc-filt" id="tcEmp">
          <option value="">Everyone</option>
          ${emps.map((e) => `<option value="${esc(e.id)}" ${this._tcEmployee === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
        </select>
      </div>
    `;
  },

  _renderTimeclockAdmin() {
    const tc = this._tc || {};
    const rows = tc.rows || [];
    const dates = tc.dates || [];
    const totals = tc.totals || { hours: 0, overtime: 0, flags: 0 };

    const nowIn = (tc.now_in || []).length
      ? `<div class="tc-now">
           <span class="lbl">On the clock now</span>
           ${tc.now_in.map((n) => `<span class="pill">${esc(n.name)} <span class="t">since ${esc(n.since_local)}</span></span>`).join('')}
         </div>`
      : '';

    // Every flag on one banner rather than buried in a row someone has to
    // think to expand. A missed clock-out is the whole reason this screen
    // gets looked at before payroll runs.
    const allFlags = [];
    rows.forEach((r) => {
      (r.summary.flags || []).forEach((f) => allFlags.push({ name: r.employee.name, ...f }));
    });
    const flagBanner = allFlags.length
      ? `<div class="tc-alert">
           <strong>${allFlags.length} shift${allFlags.length === 1 ? '' : 's'} need${allFlags.length === 1 ? 's' : ''} a look before payroll</strong>
           <ul>${allFlags.map((f) => `<li>${esc(f.name)}, ${fmtDate(f.date)}: ${esc(f.message)}</li>`).join('')}</ul>
         </div>`
      : '';

    const kiosk = `
      <div class="tc-kiosk">
        Kiosk page for the shop floor: <code>${esc(location.origin)}/clock</code>
        &nbsp;Employees pick a name and enter their passcode. No login.
        Set passcodes per person in Roster.
      </div>`;

    if (!rows.length) {
      return this._renderTcToolbar() + kiosk +
        `<div class="cc-empty">Nobody matches those filters.</div>`;
    }

    const cards = `
      <div class="cc-grid">
        <div class="cc-card"><h3>Hours this week</h3><div class="big">${(totals.hours || 0).toFixed(2)}</div>
          <div class="note">${rows.length} ${rows.length === 1 ? 'person' : 'people'}</div></div>
        <div class="cc-card"><h3>Overtime</h3><div class="big">${(totals.overtime || 0).toFixed(2)}</div>
          <div class="note">past ${tc.overtime_after || 40} hours</div></div>
        <div class="cc-card"><h3>On the clock</h3><div class="big">${(tc.now_in || []).length}</div>
          <div class="note">right now</div></div>
        ${totals.cost != null ? `<div class="cc-card"><h3>Estimated labor</h3><div class="big">${fmtMoney(totals.cost)}</div>
          <div class="note">base rate only, no OT multiplier</div></div>` : ''}
      </div>`;

    return this._renderTcToolbar() + nowIn + flagBanner + cards + kiosk + `
      <div class="cc-list">
        <table class="tc-grid">
          <thead>
            <tr>
              <th class="who">Employee</th>
              ${dates.map((d) => {
                const h = this._tcDayHead(d);
                return `<th>${h.label}<span class="dnum">${h.num}</span></th>`;
              }).join('')}
              <th>Total</th>
              <th>OT</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => `
              <tr class="emprow" data-id="${esc(r.employee.id)}">
                <td class="who">${esc(r.employee.name)}
                  <span class="dept">${esc(r.employee.department || '')}</span></td>
                ${dates.map((d) => {
                  const v = r.summary.days[d] || 0;
                  return `<td class="${v ? '' : 'zero'}">${v ? v.toFixed(2) : '·'}</td>`;
                }).join('')}
                <td class="total">${(r.summary.total_hours || 0).toFixed(2)}${(r.summary.flags || []).length ? '<span class="tc-flagdot"></span>' : ''}</td>
                <td class="${r.summary.overtime_hours ? 'ot' : 'zero'}">${r.summary.overtime_hours ? r.summary.overtime_hours.toFixed(2) : '·'}</td>
              </tr>
              <tr class="tc-detail" data-detail="${esc(r.employee.id)}" hidden>
                <td colspan="${dates.length + 3}">${this._renderShiftList(r)}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td class="who">Total</td>
              ${dates.map((d) => {
                const v = rows.reduce((s, r) => s + (r.summary.days[d] || 0), 0);
                return `<td>${v ? v.toFixed(2) : '·'}</td>`;
              }).join('')}
              <td>${(totals.hours || 0).toFixed(2)}</td>
              <td>${(totals.overtime || 0).toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  },

  _renderShiftList(row) {
    const shifts = row.shifts || [];
    if (!shifts.length) {
      return `<div class="tc-shifts"><div class="tc-shift"><span class="note">No shifts recorded this week.</span>
        <span class="grow"></span>
        <button class="cc-btn ghost sm" data-addfor="${esc(row.employee.id)}">Add a shift</button></div></div>`;
    }
    return `
      <div class="tc-shifts">
        ${shifts.map((s) => `
          <div class="tc-shift">
            <span class="d">${fmtDate(s.date)}</span>
            <span class="times">${esc(s.in_time)} to ${s.out_time ? esc(s.out_time) : '<span class="tc-miss">no clock-out</span>'}</span>
            ${s.source === 'manual' ? '<span class="chip">edited</span>' : ''}
            ${s.note ? `<span class="note">${esc(s.note)}</span>` : ''}
            <span class="grow"></span>
            <span class="h">${s.hours != null ? s.hours.toFixed(2) : '—'}</span>
            ${this._isAdmin ? `<button class="cc-btn ghost sm" data-edit="${esc(s.id)}" data-emp="${esc(row.employee.id)}" data-week="${esc(s.week_key)}">Fix</button>` : ''}
          </div>
        `).join('')}
        ${this._isAdmin ? `<div class="tc-shift"><span class="grow"></span>
          <button class="cc-btn ghost sm" data-addfor="${esc(row.employee.id)}">Add a shift</button></div>` : ''}
      </div>
    `;
  },

  _wireTimeclockAdmin() {
    const body = this._root.querySelector('#ccBody');
    const $ = (sel) => body.querySelector(sel);

    const prev = $('#tcPrev'); if (prev) prev.onclick = () => this._tcShiftWeek(-1);
    const next = $('#tcNext'); if (next) next.onclick = () => this._tcShiftWeek(1);
    const today = $('#tcToday'); if (today) today.onclick = () => { this._tcWeek = ''; this.showView('timeclock'); };

    const dept = $('#tcDept');
    if (dept) dept.onchange = () => { this._tcDept = dept.value; this.showView('timeclock'); };
    const emp = $('#tcEmp');
    if (emp) emp.onchange = () => { this._tcEmployee = emp.value; this.showView('timeclock'); };

    body.querySelectorAll('tr.emprow').forEach((tr) => {
      tr.onclick = () => {
        const det = body.querySelector(`tr[data-detail="${tr.dataset.id}"]`);
        if (det) det.hidden = !det.hidden;
      };
    });

    body.querySelectorAll('[data-addfor]').forEach((btn) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        this._openShiftForm(null, btn.dataset.addfor);
      };
    });

    body.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        const row = (this._tc.rows || []).find((r) => r.employee.id === btn.dataset.emp);
        const shift = row && row.shifts.find((s) => s.id === btn.dataset.edit);
        if (shift) this._openShiftForm({ ...shift, employee_id: btn.dataset.emp });
      };
    });
  },

  /**
   * Add or fix one shift. Times are entered as the wall clock the person
   * actually worked, not a timestamp — the server converts, so a correction
   * typed on a daylight saving changeover day still lands on the right hour.
   */
  _openShiftForm(shift, presetEmployeeId) {
    const isEdit = !!shift;
    const emps = this._employees || [];
    const empId = shift ? shift.employee_id : (presetEmployeeId || '');

    const formHtml = `
      <div class="cc-form">
        <h3>${isEdit ? 'Fix a shift' : 'Add a shift'}</h3>
        <div class="cc-form-grid">
          <div><label>Employee</label>
            <select id="tsEmp" ${isEdit ? 'disabled' : ''}>
              <option value="">Pick someone</option>
              ${emps.map((e) => `<option value="${esc(e.id)}" ${empId === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
            </select>
          </div>
          <div><label>Date</label><input id="tsDate" type="date" value="${esc(shift ? shift.date : '')}"></div>
          <div><label>Clocked in</label><input id="tsIn" type="time" value="${esc(shift ? shift.in_time : '')}"></div>
          <div><label>Clocked out</label><input id="tsOut" type="time" value="${esc(shift && shift.out_time ? shift.out_time : '')}"></div>
          <div class="full"><label>Note (why this was entered by hand)</label>
            <input id="tsNote" value="${esc(shift ? shift.note : '')}" placeholder="forgot to punch out, tablet was down, etc"></div>
        </div>
        <div class="cc-err" id="tsErr" hidden></div>
        <div class="cc-form-actions">
          ${isEdit ? '<button class="cc-btn ghost" id="tsDelete">Delete</button>' : ''}
          <button class="cc-btn ghost" id="tsCancel">Cancel</button>
          <button class="cc-btn" id="tsSave">Save</button>
        </div>
        <p style="font-size:12px;color:var(--muted);margin-top:10px">
          Leaving the clock-out time blank records an open shift, the same as
          somebody standing at the tablet right now. An out time earlier than
          the in time is read as crossing midnight.
        </p>
      </div>
    `;

    const wrap = this._openModal(formHtml);
    const $ = (sel) => wrap.querySelector(sel);
    const err = $('#tsErr');
    const fail = (m) => { err.hidden = false; err.textContent = m; };

    $('#tsCancel').onclick = () => this._closeModal();

    if (isEdit) {
      $('#tsDelete').onclick = async () => {
        if (!confirm('Delete this shift? This cannot be undone.')) return;
        try {
          await this._ctx.api.request(
            ENDPOINTS.ccTimecards + '?employee_id=' + encodeURIComponent(shift.employee_id) +
            '&week=' + encodeURIComponent(shift.week_key) + '&id=' + encodeURIComponent(shift.id),
            { method: 'DELETE' }
          );
          this._closeModal();
          this.showView('timeclock');
        } catch (e) {
          fail((e.body && e.body.error) || e.message || 'Could not delete.');
        }
      };
    }

    $('#tsSave').onclick = async () => {
      const payload = {
        employee_id: isEdit ? shift.employee_id : $('#tsEmp').value,
        date: $('#tsDate').value,
        in_time: $('#tsIn').value,
        out_time: $('#tsOut').value,
        note: $('#tsNote').value
      };
      if (!payload.employee_id) return fail('Pick an employee.');
      if (!payload.date || !payload.in_time) return fail('Date and clock-in time are both required.');

      try {
        if (isEdit) {
          await this._ctx.api.request(
            ENDPOINTS.ccTimecards + '?employee_id=' + encodeURIComponent(shift.employee_id) +
            '&week=' + encodeURIComponent(shift.week_key) + '&id=' + encodeURIComponent(shift.id),
            { method: 'PATCH', body: payload }
          );
        } else {
          await this._ctx.api.request(ENDPOINTS.ccTimecards, { method: 'POST', body: payload });
        }
        this._closeModal();
        this.showView('timeclock');
      } catch (e) {
        fail((e.body && e.body.details && e.body.details.join(', ')) || (e.body && e.body.error) || e.message || 'Could not save.');
      }
    };
  },

  /**
   * Payroll handoff. Built client side from the week already on screen, the
   * same way TravelTrack and ShopStock export, so what lands in the
   * spreadsheet is exactly the numbers being looked at and there is no
   * second round trip that could disagree with them.
   */
  _exportTimecards() {
    const tc = this._tc || {};
    const rows = tc.rows || [];
    const cell = (v) => {
      const str = String(v == null ? '' : v);
      return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const lines = [['Employee', 'Department', 'Date', 'Clock in', 'Clock out', 'Hours', 'Source', 'Note'].map(cell).join(',')];
    rows.forEach((r) => {
      r.shifts.forEach((sh) => {
        lines.push([
          r.employee.name, r.employee.department, sh.date, sh.in_time,
          sh.out_time || 'MISSING CLOCK-OUT',
          sh.hours == null ? '' : sh.hours, sh.source, sh.note
        ].map(cell).join(','));
      });
      lines.push([r.employee.name, '', '', '', 'WEEK TOTAL', r.summary.total_hours, '', ''].map(cell).join(','));
    });

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = 'timecards-' + (tc.week_key || 'week') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  },

  /* ---- Time Clock: self-serve ---- */

  _renderTimeclockSelf() {
    const tc = this._tc || {};
    const row = (tc.rows || [])[0];

    if (!row) {
      return `
        <div class="cc-locked">
          <h2>No timecard yet</h2>
          <p>${esc(tc.error_hint || "Nothing recorded for you this week.")}</p>
        </div>
      `;
    }

    const dates = tc.dates || [];
    const todayStr = new Date().toISOString().slice(0, 10);

    return `
      ${this._renderTcSelfNav()}
      <div class="cc-grid">
        <div class="cc-card"><h3>Hours this week</h3><div class="big">${(row.summary.total_hours || 0).toFixed(2)}</div>
          <div class="note">${esc(this._tcWeekLabel())}</div></div>
        ${row.summary.overtime_hours ? `<div class="cc-card"><h3>Overtime</h3><div class="big">${row.summary.overtime_hours.toFixed(2)}</div>
          <div class="note">past ${tc.overtime_after || 40} hours</div></div>` : ''}
      </div>
      <div class="tc-mine">
        ${dates.map((d) => {
          const h = this._tcDayHead(d);
          const v = row.summary.days[d] || 0;
          return `<div class="tc-day ${d === todayStr ? 'today' : ''}">
            <div class="dl">${h.label}</div><div class="dn">${h.num}</div>
            <div class="dh ${v ? '' : 'none'}">${v ? v.toFixed(2) : '·'}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="cc-section">
        <h2>Your shifts</h2>
        <div class="cc-list">${this._renderShiftList(row)}</div>
      </div>
      <p style="font-size:12.5px;color:var(--muted)">
        Something wrong here? Tell a manager. Timecards can only be corrected
        by an admin, on purpose.
      </p>
    `;
  },

  _renderTcSelfNav() {
    return `
      <div class="cc-toolbar">
        <div class="tc-weeknav">
          <button class="cc-btn ghost sm" id="tcPrev">&lsaquo; Prev</button>
          <span class="tc-weeklabel">${esc(this._tcWeekLabel())}</span>
          <button class="cc-btn ghost sm" id="tcNext">Next &rsaquo;</button>
          <button class="cc-btn ghost sm" id="tcToday">This week</button>
        </div>
      </div>
    `;
  },

  _wireTimeclockSelf() {
    const body = this._root.querySelector('#ccBody');
    const prev = body.querySelector('#tcPrev'); if (prev) prev.onclick = () => this._tcShiftWeek(-1);
    const next = body.querySelector('#tcNext'); if (next) next.onclick = () => this._tcShiftWeek(1);
    const today = body.querySelector('#tcToday');
    if (today) today.onclick = () => { this._tcWeek = ''; this.showView('timeclock'); };
  },

  unmount() {
    // Tear the modal down explicitly. Its Escape handler is registered on
    // document, so leaving it attached would keep firing against a detached
    // root after the person navigates away, and body overflow would stay
    // locked with no overlay on screen to explain why nothing scrolls.
    this._closeModal();
    this._root = null;
    this._ctx = null;
  }
};
