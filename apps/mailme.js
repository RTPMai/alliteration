/**
 * MailMe — email marketing.
 *
 * RESTRUCTURED Aug 2026. The app worked, but doing anything in it took too
 * many steps and too much knowledge of where things hid. Four things changed,
 * and each one removes a question the person shouldn't have had to answer:
 *
 *   1. SENDING MOVED OUT OF "RESULTS". You used to write a draft in a modal,
 *      close it, find the row, open a panel called Results, and send from
 *      there. Sending from the analytics screen is backwards. The Send button
 *      now lives at the top of the campaign you are looking at, the whole
 *      time, and Reports is where you go AFTER a send.
 *
 *   2. ONE AUDIENCE CONTROL, NOT THREE. Audience, list and free-text tags
 *      used to sit side by side with a hidden precedence rule ("tags are
 *      ignored when a list is chosen"). Now there is one "Send to" picker.
 *      Segments live in lists, where they can be reused, named and counted.
 *
 *   3. THE COMPOSER IS A PAGE. Writing the email is the longest work in the
 *      app and it happened in a popup you couldn't set aside. It's a full
 *      screen now, with a live inbox preview beside the editor rendered by
 *      the same markdown-lite rules the sender uses, so what you see is what
 *      actually arrives.
 *
 *   4. FOUR TABS, NOT SIX. Campaigns, Audience, Reports, Settings. Contacts
 *      and Lists were two views of the same people, so they merged. Import is
 *      a button on that screen rather than a permanent tab for a task done a
 *      few times a year. The old Dashboard was mostly an explanatory essay;
 *      its live parts (deliverability warnings, list health) moved to a strip
 *      on Campaigns where they are actually acted on.
 *
 * TWO CONTACT SOURCES:
 *   client   — the BackBone roster, resolved live server-side, never stored
 *              here. Fix an email in BackBone and it is fixed here.
 *   prospect — imported cold-outreach records that MailMe owns, because
 *              nothing else in the shell knows about them.
 *
 * The two are kept apart for a concrete reason, not tidiness: cold outreach
 * bounces and draws spam complaints at rates a customer list never does, and
 * mailbox providers score sender reputation per DOMAIN. Mixing the streams
 * would put quotes and invoices at risk of landing in customers' spam. Each
 * source therefore sends from its own domain, and the composer now picks the
 * right one for you instead of warning you after the fact.
 *
 * REORDER TIMING IS NOT SET HERE any more. It describes the customer, not the
 * email, so BackBone owns it (Settings -> Reorder timing). MailMe reads it.
 *
 * SENDING is wired through Resend. A draft is never one accidental status
 * edit away from going out: the ordinary save path can only ever produce a
 * draft, and every real send re-checks compliance, domain verification and
 * suppression itself right before dispatch. Anyone with MailMe edit access
 * can send — the safety property is the pre-send checks, not who can click.
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

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString();
}

function pct(n) { return (Math.round(n * 10) / 10) + '%'; }

// Status presentation, kept as one table so the pill, the tiles and the
// filters can never disagree about what a status is called.
const STATUS_META = {
  subscribed:   { label: 'Subscribed',   cls: 'ok' },
  unsubscribed: { label: 'Unsubscribed', cls: 'warn' },
  bounced:      { label: 'Bounced',      cls: 'bad' },
  complained:   { label: 'Complained',   cls: 'bad' }
};

const SUPPRESSED = ['unsubscribed', 'bounced', 'complained'];

// Where a view's refresh feedback goes.
const MSG_TARGET = {
  campaigns: '#mmCampaignMsg',
  audience: '#mmAudienceMsg',
  reports: '#mmReportsMsg',
  settings: '#mmSettingsMsg'
};

const SOURCE_META = {
  client:   { label: 'Client',   note: 'From the BackBone roster' },
  lead:     { label: 'Lead',     note: "From BackBone's qualified pipeline" },
  giving:   { label: 'Giving',   note: 'Asked P&M for a donation or sponsorship' },
  prospect: { label: 'Prospect', note: 'Imported for cold outreach' }
};

// Only imported prospects are genuinely cold. Leads and giving contacts were
// already in conversation with the shop, so they send from the warm domain.
const COLD_SOURCES = ['prospect'];

const REORDER_META = {
  'not-due': { label: 'On schedule', cls: 'mute' },
  due:       { label: 'Due',         cls: 'ok' },
  overdue:   { label: 'Overdue',     cls: 'warn' },
  lapsed:    { label: 'Lapsed',      cls: 'bad' },
  unknown:   { label: '',            cls: 'mute' }
};

// THE ONE AUDIENCE CONTROL. Every option a campaign can target, in one
// ordered list: the standing audiences first, then the person's own saved
// lists. Picking one of these sets `source`; picking a list sets `listId`.
// Nothing else in the composer decides who gets the email, which is the
// whole point of the rewrite.
const QUICK_AUDIENCES = [
  { value: 'src:client',   source: 'client',   label: 'All clients',
    note: 'Everyone on the BackBone roster with an email' },
  { value: 'src:lead',     source: 'lead',     label: 'Leads',
    note: "BackBone's qualified pipeline" },
  { value: 'src:giving',   source: 'giving',   label: 'Giving contacts',
    note: 'People who asked for a donation or sponsorship' },
  { value: 'src:prospect', source: 'prospect', label: 'Prospects (cold)',
    note: 'Imported for cold outreach. Sends from the cold domain.' },
  { value: 'src:all',      source: 'all',      label: 'Everyone',
    note: 'Clients and prospects together. Needs a cold-marked domain.' }
];

/* ---------------- inbox preview ----------------
 *
 * A DELIBERATE SECOND COPY of the sender's formatter. Normally two
 * implementations of one rule is exactly the thing to avoid, and everywhere
 * else in this app the server is the single source of truth (recipient
 * counts, list membership, eligibility). Here it is the right trade:
 *
 *   - The preview has to update on every keystroke. A round trip per
 *     character is not a preview, it is a lag.
 *   - Being wrong is cheap and visible. If these drift, the preview looks
 *     slightly off and someone notices; nothing is sent incorrectly, because
 *     the SERVER still builds every real email from lib/mailme/send.js.
 *
 * Kept deliberately line-for-line with renderMarkdownLiteHtml/renderInline in
 * lib/mailme/send.js so a change there is easy to mirror. If you touch one,
 * touch both.
 */

function escapeAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

function previewInline(escapedText) {
  let out = escapedText.replace(/\*\*([^\n*]+)\*\*/g, '<strong>$1</strong>');

  // Explicit [text](url) first, so its URL is already inside an href by the
  // time bare-URL autolinking runs and cannot be matched a second time.
  const linked = [];
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, url) => {
    linked.push(`<a href="${escapeAttr(url)}">${text}</a>`);
    return `\u0000LINK${linked.length - 1}\u0000`;
  });

  // Bare URLs, and "www." addresses with no scheme. A bare domain with
  // neither is deliberately NOT matched: it cannot be told apart from an
  // abbreviation, and linking "etc.co" by accident is worse than asking for
  // a www. Trailing punctuation is excluded so a URL ending a sentence does
  // not swallow the full stop.
  out = out.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<>"']+)/gi, (m, before, url) => {
    let tail = '';
    const trailing = url.match(/[.,;:!?)\]]+$/);
    if (trailing) { tail = trailing[0]; url = url.slice(0, -tail.length); }
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return `${before}<a href="${escapeAttr(href)}">${url}</a>${tail}`;
  });

  return out.replace(/\u0000LINK(\d+)\u0000/g, (m, i) => linked[Number(i)]);
}

function previewBody(text) {
  const paragraphs = String(text || '').split(/\n{2,}/);
  return paragraphs.map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const isBulletBlock = lines.length > 0 && lines.every((l) => /^-\s+/.test(l));
    if (isBulletBlock) {
      const items = lines
        .map((l) => `<li>${previewInline(esc(l.replace(/^-\s+/, '')))}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    }
    return `<p>${previewInline(esc(block)).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
}

// Mirrors personalize() in lib/mailme/send.js, including the "there" fallback
// so an empty preview does not read as a bug when a contact has no name.
function previewPersonalize(text, contact) {
  const full = String((contact && contact.contact_name) || '').trim();
  const first = full ? full.split(/\s+/)[0] : '';
  return String(text || '')
    .replace(/\{\{\s*first_name\s*\}\}/gi, first || 'there')
    .replace(/\{\{\s*company_name\s*\}\}/gi, (contact && contact.company_name) || '');
}

export default {
  id: 'mailme',

  styles: `
  .mm-page{padding:24px 32px 60px}
  .mm-hd{display:flex;justify-content:space-between;align-items:flex-start;
    margin-bottom:20px;flex-wrap:wrap;gap:12px}
  .mm-hd h1{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .mm-hd .sub{font-size:13px;color:var(--muted);margin-top:3px}

  .mm-notice{background:var(--warn-tint);border:1px solid var(--warn-tint);
    border-left:3px solid var(--warn);border-radius:var(--radius-sm);
    padding:11px 14px;font-size:12.5px;color:var(--warn-dk);
    line-height:1.55;margin-bottom:18px}
  .mm-notice b{font-weight:700}
  .mm-notice.danger{background:var(--danger-tint);border-color:var(--danger-line);
    border-left-color:var(--danger);color:var(--danger-dk)}
  .mm-notice.good{background:var(--success-tint);border-color:var(--success-tint);
    border-left-color:var(--success);color:var(--success-dk)}

  /* Health strip. Replaces the old Dashboard tab: the same numbers, but sat
     above the campaign list where a bad one actually changes what you do
     next, rather than on a screen you had to remember to visit. */
  .mm-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));
    gap:10px;margin-bottom:18px}
  .mm-chip-stat{background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-md);padding:11px 13px}
  .mm-chip-stat .v{font-size:20px;font-weight:800;letter-spacing:-.02em;line-height:1.15}
  .mm-chip-stat .l{font-size:11.5px;color:var(--muted);margin-top:3px;font-weight:600}
  .mm-chip-stat.ok .v{color:var(--success-dk)}
  .mm-chip-stat.warn .v{color:var(--warn-dk)}
  .mm-chip-stat.bad .v{color:var(--danger-dk)}

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
  .mm-sep{width:1px;height:22px;background:var(--line);margin:0 4px}
  .mm-search{flex:1;min-width:170px;max-width:300px;padding:7px 11px;
    border:1px solid var(--line);border-radius:var(--radius-sm);
    font-family:inherit;font-size:13px;color:var(--ink);background:var(--card)}
  .mm-search:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}

  /* The list rail on Audience. Lists used to be a separate tab, which made
     "my contacts" and "a saved slice of my contacts" feel like different
     things to learn. They are the same table with a different filter. */
  .mm-listrail{display:flex;gap:8px;flex-wrap:wrap;align-items:center;
    margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--line-soft)}
  .mm-listrail .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.05em;
    color:var(--faint);font-weight:700;margin-right:2px}

  .mm-table{width:100%;border-collapse:collapse;font-size:13px}
  .mm-table th{text-align:left;font-size:11px;text-transform:uppercase;
    letter-spacing:.05em;color:var(--muted);font-weight:700;padding:9px 12px;
    background:var(--head-bg);border-bottom:1px solid var(--line);white-space:nowrap}
  .mm-table th.sortable{cursor:pointer;user-select:none}
  .mm-table th.sortable:hover{color:var(--ink)}
  .mm-table th .arrow{opacity:.4;margin-left:4px}
  .mm-table th[aria-sort] .arrow{opacity:1;color:var(--accent-deep)}
  .mm-table td{padding:10px 12px;border-bottom:1px solid var(--line-soft);vertical-align:middle}
  .mm-table tr:hover td{background:var(--row-hover)}
  .mm-table .co{font-weight:600;color:var(--ink)}
  .mm-table .em{color:var(--muted);font-size:12.5px}
  .mm-table .who{color:var(--faint);font-size:12px}
  .mm-table td.num{text-align:right;font-variant-numeric:tabular-nums}
  .mm-table tr.clickable{cursor:pointer}

  .pill{display:inline-block;padding:2px 9px;border-radius:var(--radius-pill);
    font-size:11px;font-weight:700;white-space:nowrap}
  .pill.ok{background:var(--success-tint);color:var(--success-dk)}
  .pill.warn{background:var(--warn-tint);color:var(--warn-dk)}
  .pill.bad{background:var(--danger-tint);color:var(--danger-dk)}
  .pill.src{background:var(--accent-tint);color:var(--accent-deep)}
  .pill.mute{background:var(--line-soft);color:var(--muted)}

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
  .mm-btn.danger{background:var(--danger);border-color:var(--danger)}
  .mm-btn.danger:hover{background:var(--danger-dk);border-color:var(--danger-dk)}

  .mm-linklike{background:none;border:none;padding:0;margin:0;font:inherit;
    color:var(--accent-deep);font-weight:600;cursor:pointer;text-align:left}
  .mm-linklike:hover{text-decoration:underline}
  .mm-linklike:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

  .mm-card{background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-md);margin-bottom:18px;overflow:hidden}
  .mm-card-hd{display:flex;justify-content:space-between;align-items:center;
    padding:14px 18px;border-bottom:1px solid var(--line-soft);gap:12px;flex-wrap:wrap}
  .mm-card-hd h3{font-size:14px;font-weight:700}
  .mm-card-hd .meta{font-size:12px;color:var(--muted)}
  .mm-card-bd{padding:18px}
  .mm-card-bd.flush{padding:0}

  .mm-hint{font-size:12.5px;color:var(--muted);line-height:1.5}
  .mm-add-row{display:flex;gap:10px;align-items:center;padding:12px 16px;
    border-bottom:1px solid var(--line)}
  .mm-add-row input{flex:1;padding:9px 11px;border:1px solid var(--line);
    border-radius:var(--radius-sm);font-size:13px;font-family:inherit;background:var(--card)}
  .mm-add-row input:focus{outline:2px solid var(--accent);outline-offset:1px}

  .mm-edit-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .mm-edit-grid .mm-field.full{grid-column:1/-1}

  .mm-field{margin-bottom:14px}
  .mm-field label{display:block;font-size:11px;text-transform:uppercase;
    letter-spacing:.05em;color:var(--muted);font-weight:700;margin-bottom:5px}
  .mm-field input,.mm-field textarea,.mm-field select{width:100%;padding:9px 11px;
    border:1px solid var(--line);border-radius:var(--radius-sm);
    font-family:inherit;font-size:13px;color:var(--ink);background:var(--card)}
  .mm-field textarea{min-height:150px;resize:vertical;line-height:1.6}
  .mm-field textarea.csv{min-height:200px;font-family:var(--font-mono);font-size:12px}
  .mm-field input:focus,.mm-field textarea:focus,.mm-field select:focus{
    outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
  .mm-field .hint{font-size:11.5px;color:var(--faint);margin-top:4px;line-height:1.5}
  .mm-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}

  .mm-recip{background:var(--accent-tint);border-radius:var(--radius-sm);
    padding:11px 14px;font-size:12.5px;color:var(--accent-deep);
    font-weight:600;margin-bottom:14px;line-height:1.5}
  .mm-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .mm-refresh{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .mm-refresh .stamp{font-size:11.5px;color:var(--faint);white-space:nowrap}

  .mm-empty{text-align:center;padding:34px 20px;color:var(--muted);font-size:13px;line-height:1.6}
  .mm-empty h4{font-size:14px;color:var(--ink);margin-bottom:6px;font-weight:700}
  .mm-err{background:var(--danger-tint);border:1px solid var(--danger-line);
    border-radius:var(--radius-sm);padding:11px 14px;font-size:12.5px;
    color:var(--danger-dk);margin-bottom:14px;line-height:1.5}
  .mm-ok{background:var(--success-tint);border-radius:var(--radius-sm);
    padding:11px 14px;font-size:12.5px;color:var(--success-dk);
    margin-bottom:14px;font-weight:600}

  .mm-stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));
    gap:12px;margin-bottom:16px}
  .mm-stat{background:var(--head-bg);border-radius:var(--radius-sm);padding:12px 14px}
  .mm-stat .v{font-size:20px;font-weight:800;letter-spacing:-.02em}
  .mm-stat .l{font-size:11px;color:var(--muted);margin-top:3px;font-weight:600}

  /* ---- the campaign workspace ----
     A page, not a modal. The send bar is sticky because the one question
     you keep asking while writing is "can this actually go out yet", and
     the answer used to live on a different screen. */
  .mm-sendbar{position:sticky;top:0;z-index:5;background:var(--card);
    border:1px solid var(--line);border-radius:var(--radius-md);
    padding:12px 16px;margin-bottom:16px;display:flex;gap:12px;
    align-items:center;justify-content:space-between;flex-wrap:wrap}
  .mm-sendbar .who{font-size:12px;color:var(--faint)}
  .mm-sendbar h2{font-size:16px;font-weight:700;letter-spacing:-.01em;
    margin:0;line-height:1.3}
  .mm-sendbar .count{font-size:12.5px;color:var(--muted);font-weight:600;
    white-space:nowrap}

  /* Each step carries its own state marker. A checklist you can see the
     bottom of is the difference between "four things to do" and "an
     unknown number of things I might be missing". */
  .mm-step{background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-md);margin-bottom:12px;overflow:hidden}
  .mm-step-hd{display:flex;align-items:center;gap:11px;padding:13px 16px}
  .mm-step-hd .mark{width:20px;height:20px;border-radius:var(--radius-pill);
    display:flex;align-items:center;justify-content:center;flex:0 0 auto;
    font-size:11px;font-weight:800;background:var(--line-soft);color:var(--muted)}
  .mm-step-hd .mark.done{background:var(--success-tint);color:var(--success-dk)}
  .mm-step-hd .mark.todo{background:var(--warn-tint);color:var(--warn-dk)}
  .mm-step-hd .t{flex:1;min-width:0}
  .mm-step-hd .t .n{font-size:13.5px;font-weight:700}
  .mm-step-hd .t .d{font-size:12px;color:var(--muted);margin-top:2px;line-height:1.45}
  .mm-step-bd{padding:0 16px 16px}

  /* Editor and preview side by side. Collapses to stacked under 900px:
     two 300px columns is worse than one readable one. */
  .mm-split{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media (max-width:900px){.mm-split{grid-template-columns:1fr}}
  .mm-preview{border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:14px 16px;background:var(--head-bg);font-size:13px;line-height:1.6;
    color:var(--ink);overflow-wrap:anywhere}
  .mm-preview .phd{font-size:11px;text-transform:uppercase;letter-spacing:.05em;
    color:var(--faint);font-weight:700;border-bottom:1px solid var(--line);
    padding-bottom:7px;margin-bottom:10px}
  .mm-preview .psubj{font-weight:700;font-size:14px;margin-bottom:2px}
  .mm-preview .ppre{font-size:12px;color:var(--muted);margin-bottom:12px}
  .mm-preview p{margin:0 0 11px}
  .mm-preview ul{margin:0 0 11px 20px;padding:0}
  .mm-preview li{margin-bottom:4px}
  .mm-preview a{color:var(--accent-deep)}
  .mm-preview .pfoot{margin-top:18px;padding-top:10px;
    border-top:1px solid var(--line);font-size:11px;color:var(--faint);
    white-space:pre-wrap}

  /* Insert-at-cursor buttons instead of a paragraph explaining syntax. */
  .mm-tools{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
  .mm-tool{background:var(--card);border:1px solid var(--line);
    border-radius:var(--radius-sm);padding:3px 9px;font-size:11.5px;
    font-weight:600;color:var(--muted);cursor:pointer;font-family:inherit}
  .mm-tool:hover{color:var(--ink);border-color:var(--line-strong)}
  .mm-tool:focus-visible{outline:2px solid var(--accent);outline-offset:1px}

  .mm-tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:18px;
    border-bottom:1px solid var(--line)}
  .mm-tab{background:none;border:0;border-bottom:2px solid transparent;
    padding:8px 14px;font-size:13px;font-weight:600;color:var(--muted);
    cursor:pointer;font-family:inherit;margin-bottom:-1px}
  .mm-tab:hover{color:var(--ink)}
  .mm-tab[aria-selected="true"]{color:var(--accent-deep);border-bottom-color:var(--accent)}
  .mm-tab:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

  /* Modals survive for the short, bounded editors (a list rule, a CSV
     import, a member roll). Those are glance-and-close; the composer was
     not, which is why it stopped being one. */
  .mm-modal-back{position:fixed;inset:0;background:rgba(15,20,28,.55);
    z-index:400;overflow-y:auto;padding:40px 16px}
  .mm-modal{background:var(--card);border-radius:12px;width:100%;
    max-width:860px;margin:0 auto;box-shadow:0 18px 50px rgba(0,0,0,.3);
    position:relative}
  .mm-modal .mm-card{border:0;box-shadow:none;margin:0}
  .mm-modal-x{position:absolute;top:12px;right:14px;border:0;background:transparent;
    font-size:22px;line-height:1;cursor:pointer;color:var(--muted);padding:4px 8px}
  .mm-modal-x:hover{color:var(--ink)}
  `,

  template: `
    <div class="mm-page">
      <div id="mmContactEditor" hidden></div>

      <!-- ===== Campaigns (default). Holds two panes: the list, and the
           workspace for whichever campaign is open. They are the same tab
           because "my campaigns" and "this campaign" are one job, and
           splitting them into two nav items is what made sending feel like
           it lived somewhere else. ===== -->
      <section id="mmCampaignsView" hidden>

        <div id="mmCampaignListPane">
          <div class="mm-hd">
            <div>
              <h1>Campaigns<span class="dot">.</span></h1>
              <div class="sub">Write it, check who gets it, send it.</div>
            </div>
            <div class="mm-refresh">
              <span class="stamp" data-mm-stamp></span>
              <button class="mm-btn ghost sm" data-mm-refresh="campaigns">Refresh</button>
              <button class="mm-btn" id="mmNewCampaign">New campaign</button>
            </div>
          </div>
          <div id="mmCampaignMsg"></div>
          <div id="mmHealth"></div>
          <div class="mm-strip" id="mmStrip"></div>
          <div class="mm-card">
            <div class="mm-card-hd">
              <h3>All campaigns</h3><span class="meta" id="mmCampaignCount"></span>
            </div>
            <div class="mm-card-bd flush"><div id="mmCampaignList"></div></div>
          </div>
        </div>

        <!-- The workspace. Rendered in full by renderComposer(); left empty
             here so there is exactly one place that decides what it says. -->
        <div id="mmComposeView" hidden></div>
      </section>

      <!-- ===== Audience. Contacts, Lists and Import were three tabs looking
           at one set of people. Lists are now a filter rail over the same
           table, and Import is a button, because it happens a few times a
           year and did not earn permanent space. ===== -->
      <section id="mmAudienceView" hidden>
        <div class="mm-hd">
          <div>
            <h1>Audience<span class="dot">.</span></h1>
            <div class="sub" id="mmAudienceSub"></div>
          </div>
          <div class="mm-refresh">
            <span class="stamp" data-mm-stamp></span>
            <button class="mm-btn ghost sm" data-mm-refresh="audience">Refresh</button>
            <button class="mm-btn ghost" id="mmImportBtn">Import CSV</button>
            <button class="mm-btn ghost" id="mmSaveAsList">Save this view as a list</button>
            <button class="mm-btn" id="mmNewList">New list</button>
          </div>
        </div>
        <div id="mmAudienceMsg"></div>
        <div class="mm-listrail" id="mmListRail"></div>
        <div class="mm-filters" id="mmContactFilters"></div>
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3 id="mmTableTitle">All contacts</h3>
            <span class="meta" id="mmTableMeta"></span>
          </div>
          <div class="mm-card-bd flush"><div id="mmContactsTable"></div></div>
        </div>
      </section>

      <!-- ===== Reports. What used to be the "Results" modal, which was also
           where sending happened. Now it is only reporting: a campaign that
           has never sent has nothing to report and does not appear. ===== -->
      <section id="mmReportsView" hidden>
        <div class="mm-hd">
          <div>
            <h1>Reports<span class="dot">.</span></h1>
            <div class="sub">How campaigns actually performed once they went out.</div>
          </div>
          <div class="mm-refresh">
            <span class="stamp" data-mm-stamp></span>
            <button class="mm-btn ghost sm" data-mm-refresh="reports">Refresh</button>
          </div>
        </div>
        <div id="mmReportsMsg"></div>
        <div id="mmReportsBody"></div>
      </section>

      <!-- ===== Settings. Three tabs instead of one form of two dozen fields
           covering four unrelated subjects. ===== -->
      <section id="mmSettingsView" hidden>
        <div class="mm-hd">
          <div>
            <h1>Settings<span class="dot">.</span></h1>
            <div class="sub">Who you send as, what the law requires, and how fast.</div>
          </div>
          <div class="mm-refresh">
            <span class="stamp" data-mm-stamp></span>
            <button class="mm-btn ghost sm" data-mm-refresh="settings">Refresh</button>
          </div>
        </div>
        <div id="mmSettingsMsg"></div>
        <div id="mmBlockers"></div>
        <div class="mm-tabs" id="mmSettingsTabs"></div>
        <div id="mmSettingsForm"></div>
      </section>
    </div>
  `,

  async mount(ctx) {
    const root = ctx.root;

    // The open modal, if any. Declared up here because $ consults it: a modal
    // is attached to <body>, outside ctx.root, so a root-only lookup would
    // miss every field inside one.
    let modalCarrier = null;
    let modalKind = null;

    const $ = (sel) =>
      (modalCarrier && modalCarrier.querySelector(sel)) || root.querySelector(sel);
    const api = ctx.api;
    this._root = root;

    const state = {
      contacts: [], counts: {}, tags: [],
      lists: [], campaigns: [],
      source: 'all', status: 'all', search: '',
      sort: 'company_name', dir: 'asc',
      // Which list the Audience table is showing, or null for everyone. This
      // is a FILTER over the same table, not a separate screen.
      activeListId: null, activeListMembers: null, activeList: null,
      editingList: null, editingContact: null, listMemberIds: [],
      // The campaign open in the workspace, plus the server's verdict on it.
      // `composerDetail` is the same payload the old Results modal used: it
      // carries recipientCount, held reasons, sendPlan and sendBlockers.
      editingCampaign: null, composerDetail: null, composerLoading: false,
      // Which campaign Reports is showing, or null for the picker.
      reportId: null,
      importPreview: null, importCsv: '',
      settings: null, blockers: [], footerPreview: '', coldCapToday: 0,
      domains: null,
      settingsTab: 'brands'
    };
    this._state = state;
    state.lastLoaded = null;
    state.refreshing = false;

    const msg = (sel, html, cls) => {
      const el = $(sel);
      if (el) el.innerHTML = html ? `<div class="${cls}">${html}</div>` : '';
    };

    // Errors raised while a modal is open must land inside it. The page's own
    // message strip sits behind the overlay, so a validation failure there is
    // invisible and the Save button just looks dead.
    const listEditorMsg = (html, cls) => msg(modalCarrier ? '#mmModalMsg' : '#mmAudienceMsg', html, cls);
    const composerMsg = (html, cls) => msg('#mmComposeMsg', html, cls);

    const canEditUI = () =>
      !!(ctx.perms && (ctx.perms.superuser === true || ctx.perms.can_edit !== false));

    /* ---------------- data ---------------- */

    async function loadContacts() {
      // Filtering and sorting are done SERVER-side so this view and a send
      // agree on the same rule. The client re-sorting locally would be a
      // second implementation to keep in step.
      const q = { sort: state.sort, dir: state.dir };
      if (state.source !== 'all') q.source = state.source;
      if (state.status !== 'all') q.status = state.status;
      if (state.search.trim()) q.q = state.search.trim();

      const d = await api.get(ENDPOINTS.mmContacts, q);
      state.contacts = Array.isArray(d && d.contacts) ? d.contacts : [];
      state.counts = (d && d.counts) || {};
      state.tags = Array.isArray(d && d.tags) ? d.tags : [];
    }

    async function loadLists() {
      const d = await api.get(ENDPOINTS.mmLists);
      state.lists = Array.isArray(d && d.lists) ? d.lists : [];
    }

    async function loadCampaigns() {
      const d = await api.get(ENDPOINTS.mmCampaigns);
      state.campaigns = Array.isArray(d && d.campaigns) ? d.campaigns : [];
    }

    async function loadSettings() {
      const d = await api.get(ENDPOINTS.mmSettings);
      state.settings = (d && d.settings) || null;
      state.blockers = (d && d.blockers) || [];
      state.footerPreview = (d && d.footerPreview) || '';
      state.coldCapToday = (d && d.coldCapToday) || 0;
      try {
        state.domains = await api.get(ENDPOINTS.mmDomains);
      } catch (e) {
        state.domains = null;
      }
    }

    // The server's full verdict on one campaign: who it would reach, who is
    // held and why, what stands between it and a send. Fetched whenever the
    // workspace opens a SAVED campaign, and again after every save, because
    // changing the audience changes every one of those answers.
    async function loadComposerDetail(id) {
      if (!id) { state.composerDetail = null; return; }
      try {
        state.composerDetail = await api.get(ENDPOINTS.mmCampaigns, { id });
      } catch (e) {
        state.composerDetail = null;
        composerMsg('Could not check this campaign: ' + esc(e.message), 'mm-err');
      }
    }

    /* ---------------- health strip ---------------- */

    // Was the Dashboard tab. Same numbers, moved above the campaign list,
    // because a 3% bounce rate is only useful at the moment you are about to
    // send something, not on a screen you have to remember to open.
    function renderHealth() {
      const c = state.counts;
      const bounced = c.bounced || 0;
      const complained = c.complained || 0;
      const totalOnce = (c.total || 0) || 1;

      const warn = [];
      if (bounced / totalOnce >= 0.02) {
        warn.push('Bounced addresses are over 2% of your list. Clean them out before the next send: ' +
          'mailbox providers start throttling senders at that level.');
      }
      if (complained > 0) {
        warn.push(complained + ' contact' + (complained === 1 ? ' has' : 's have') +
          ' marked your mail as spam. Complaints above 0.1% of a send get a sender filtered.');
      }
      const box = $('#mmHealth');
      if (box) {
        box.innerHTML = warn.length
          ? '<div class="mm-notice danger"><b>Deliverability.</b> ' + warn.map(esc).join(' ') + '</div>'
          : '';
      }

      // Reorder-due clients are the highest-value audience in the app: they
      // already buy, and they are past their own normal cadence. The
      // thresholds behind this live in BackBone now (Settings -> Reorder
      // timing); MailMe only reads them.
      const dueNow = state.contacts.filter((x) =>
        x.source === 'client' && x.reorder && x.reorder.confident &&
        (x.reorder.state === 'due' || x.reorder.state === 'overdue')).length;

      const tiles = [
        { v: dueNow, l: 'Due to reorder', cls: dueNow ? 'ok' : '' },
        { v: c.mailable || 0, l: 'Mailable', cls: 'ok' },
        { v: (c.lead || 0) + (c.giving || 0), l: 'Leads and giving', cls: '' },
        { v: c.prospect || 0, l: 'Prospects', cls: '' },
        { v: c.unsubscribed || 0, l: 'Unsubscribed', cls: (c.unsubscribed ? 'warn' : '') },
        { v: bounced + complained, l: 'Bounced / spam', cls: ((bounced + complained) ? 'bad' : '') }
      ];
      const strip = $('#mmStrip');
      if (strip) {
        strip.innerHTML = tiles.map((t) => `
          <div class="mm-chip-stat ${t.cls}">
            <div class="v">${esc(t.v)}</div>
            <div class="l">${esc(t.l)}</div>
          </div>`).join('');
      }
    }

    /* ---------------- campaign list ---------------- */

    const STATUS_PILL = {
      draft:     { label: 'Draft',     cls: 'mute' },
      scheduled: { label: 'Scheduled', cls: 'src' },
      sending:   { label: 'Sending',   cls: 'warn' },
      sent:      { label: 'Sent',      cls: 'ok' }
    };

    // What a campaign targets, in words, for the list row. Reads the same
    // three fields the composer writes, so a row can never describe an
    // audience the workspace would disagree with.
    function audienceLabel(c) {
      if (c.listId) {
        const l = state.lists.find((x) => x.id === c.listId);
        return l ? l.name : 'a list that no longer exists';
      }
      const q = QUICK_AUDIENCES.find((a) => a.source === c.source);
      const base = q ? q.label : (SOURCE_META[c.source] ? SOURCE_META[c.source].label + 's' : c.source);
      // Legacy drafts may still carry free-text tags from before the audience
      // controls were collapsed into one. Say so rather than showing a
      // recipient count that silently disagrees with the label.
      return (c.segmentTags && c.segmentTags.length)
        ? base + ' tagged ' + c.segmentTags.join(', ')
        : base;
    }

    function renderCampaignList() {
      const counts = { draft: 0, scheduled: 0, sending: 0, sent: 0 };
      state.campaigns.forEach((c) => { if (counts[c.status] != null) counts[c.status]++; });
      const el = $('#mmCampaignCount');
      if (el) {
        el.textContent = Object.keys(counts)
          .filter((k) => counts[k])
          .map((k) => counts[k] + ' ' + k)
          .join(' \u00b7 ') || 'none yet';
      }

      const box = $('#mmCampaignList');
      if (!box) return;

      if (!state.campaigns.length) {
        box.innerHTML =
          '<div class="mm-empty"><h4>No campaigns yet</h4>' +
          '<div>Start one to work out the wording and who it goes to. ' +
          'Nothing sends until you press Send on it.</div></div>';
        return;
      }

      box.innerHTML = `
        <table class="mm-table">
          <thead><tr><th>Subject</th><th>Status</th><th>Goes to</th>
            <th class="num">Recipients</th><th>Updated</th>
            <th style="text-align:right"></th></tr></thead>
          <tbody>
            ${state.campaigns.map((c) => {
              const st = STATUS_PILL[c.status] || { label: c.status, cls: 'mute' };
              // A scheduled campaign's whole point is WHEN, so the row says
              // when rather than just repeating the word "scheduled".
              const detail = c.status === 'scheduled' && c.scheduledAt
                ? fmtDateTime(c.scheduledAt)
                : c.status === 'sending' && c.sendState && c.sendState.queue
                  ? c.sendState.queue.length + ' left to go'
                  : c.status === 'sent' && c.sentAt ? fmtDate(c.sentAt) : '';
              const done = c.status === 'sent' || c.status === 'sending';
              return `
              <tr class="clickable" data-open="${esc(c.id)}">
                <td><div class="co">${esc(c.subject || '(no subject yet)')}</div>
                    <div class="who">${esc(c.id)}</div></td>
                <td><span class="pill ${st.cls}">${esc(st.label)}</span>
                    ${detail ? `<div class="who" style="margin-top:3px">${esc(detail)}</div>` : ''}</td>
                <td class="em">${esc(audienceLabel(c))}</td>
                <td class="num">${c.recipientCount != null ? c.recipientCount : '\u2014'}</td>
                <td class="em">${esc(fmtDate(c.updatedAt))}</td>
                <td style="text-align:right;white-space:nowrap">
                  ${done ? `<button class="mm-btn ghost sm" data-report="${esc(c.id)}">Report</button>` : ''}
                  <button class="mm-btn ghost sm" data-open="${esc(c.id)}">${done ? 'View' : 'Open'}</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;

      box.querySelectorAll('[data-report]').forEach((b) => {
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          state.reportId = b.dataset.report;
          ctx.go('reports');
        });
      });
      // The whole row opens the campaign. A table of things you work on
      // should not need you to find the small button on the right.
      box.querySelectorAll('[data-open]').forEach((el2) => {
        el2.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openCampaign(el2.dataset.open);
        });
      });
    }

    async function openCampaign(id) {
      const c = state.campaigns.find((x) => x.id === id);
      if (!c) return;
      state.editingCampaign = { ...c, segmentTags: c.segmentTags || [] };
      state.composerDetail = null;
      state.composerLoading = true;
      renderComposer();
      await loadComposerDetail(id);
      state.composerLoading = false;
      renderComposer();
    }

    function closeCampaign() {
      state.editingCampaign = null;
      state.composerDetail = null;
      renderComposer();
      renderCampaignList();
    }

    /* ---------------- the campaign workspace ---------------- */

    // Which of the one-and-only audience picker's options this campaign is
    // currently on. Lists win over sources, matching what the server does.
    function currentAudienceValue(d) {
      if (d.listId) return 'list:' + d.listId;
      return 'src:' + (d.source || 'client');
    }

    function audienceIsCold(d) {
      if (d.listId) {
        const l = state.lists.find((x) => x.id === d.listId);
        const src = l && l.rule && l.rule.source;
        return src ? COLD_SOURCES.includes(src) : false;
      }
      return COLD_SOURCES.includes(d.source) || d.source === 'all';
    }

    // WHY THIS PICKS FOR YOU. The old composer let you choose an audience and
    // a sending brand independently, then warned you afterwards if the pair
    // was wrong. Cold traffic on the domain that also carries quotes and
    // invoices is the one mistake in this app that damages something you
    // cannot repair quickly, so the safe brand is now selected by default and
    // you override it deliberately rather than stumbling into it.
    function defaultIdentityFor(d) {
      const idents = (state.settings && state.settings.identities) || [];
      if (!idents.length) return null;
      const cold = audienceIsCold(d);
      const match = cold ? idents.find((i) => i.cold) : idents.find((i) => !i.cold && i.default)
        || idents.find((i) => !i.cold);
      return (match || idents.find((i) => i.default) || idents[0]).key;
    }

    // The four steps, each reporting its own readiness. Returns the marker
    // and the one-line summary shown when the step is collapsed, so the
    // header can always answer "is this bit done" without expanding it.
    function stepState(d, detail) {
      const idents = (state.settings && state.settings.identities) || [];
      const ident = idents.find((i) => i.key === d.identityKey);
      const recips = detail ? detail.recipientCount : null;

      const who = d.listId || d.source
        ? {
            done: recips == null ? null : recips > 0,
            text: recips == null
              ? audienceLabel(d)
              : `${audienceLabel(d)} \u00b7 ${recips} recipient${recips === 1 ? '' : 's'}` +
                (detail && detail.heldCount ? `, ${detail.heldCount} held back` : '')
          }
        : { done: false, text: 'Nobody chosen yet' };

      const domainStatus = (key) => {
        const list = (state.domains && Array.isArray(state.domains.domains)) ? state.domains.domains : null;
        const found = list ? list.find((x) => x.key === key) : null;
        return found ? found.status : null;
      };

      const from = ident
        ? {
            done: domainStatus(ident.key) === 'verified' && !!(ident.fromAddress || '').trim(),
            text: `${ident.label || ident.domain}` +
              (domainStatus(ident.key) === 'verified'
                ? ' \u00b7 verified'
                : ' \u00b7 not verified in Resend yet')
          }
        : { done: false, text: 'No sending brand chosen' };

      const hasSubject = !!String(d.subject || '').trim();
      const hasBody = !!String(d.body || '').trim();
      const write = {
        done: hasSubject && hasBody,
        text: !hasSubject && !hasBody ? 'Nothing written yet'
          : !hasSubject ? 'Body written, still needs a subject'
          : !hasBody ? 'Subject written, still needs a body'
          : `"${String(d.subject).slice(0, 60)}"`
      };

      return { who, from, write };
    }

    function stepMark(done) {
      // Three states, not two. `null` means "the server has not answered
      // yet", which is different from "not done" and must not show a warning
      // marker that resolves itself a moment later.
      if (done === null) return '<span class="mark">\u00b7</span>';
      return done
        ? '<span class="mark done">\u2713</span>'
        : '<span class="mark todo">!</span>';
    }

    function stepHtml(name, marker, summary, body) {
      return `
        <div class="mm-step">
          <div class="mm-step-hd">
            ${marker}
            <div class="t"><div class="n">${esc(name)}</div>
              <div class="d">${summary}</div></div>
          </div>
          <div class="mm-step-bd">${body}</div>
        </div>`;
    }

    function renderComposer() {
      const listPane = $('#mmCampaignListPane');
      const pane = $('#mmComposeView');
      if (!pane || !listPane) return;

      const d = state.editingCampaign;
      if (!d) {
        pane.hidden = true; pane.innerHTML = '';
        listPane.hidden = false;
        return;
      }
      listPane.hidden = true;
      pane.hidden = false;

      const detail = state.composerDetail;
      const steps = stepState(d, detail);
      const idents = (state.settings && state.settings.identities) || [];
      const readOnly = !canEditUI();
      const sent = d.status === 'sent';

      /* ---- step 1: who ---- */
      // ONE control. Standing audiences and saved lists in a single picker,
      // because "clients" and "the list I made of clients" are answers to the
      // same question and used to be two separate dropdowns plus a tag box.
      const legacyTags = (d.segmentTags && d.segmentTags.length && !d.listId)
        ? `<div class="mm-notice"><b>This campaign still uses tags.</b>
             It targets ${esc(d.segmentTags.join(', '))}, from before audiences and
             tags were merged. It still sends correctly. To make it easier to reuse,
             build a list on those tags in Audience and pick it above; the tags are
             dropped the moment you choose something else here.</div>`
        : '';

      const whoBody = `
        <div class="mm-field">
          <label for="mmAudience">Send to</label>
          <select id="mmAudience"${readOnly || sent ? ' disabled' : ''}>
            <optgroup label="Everyone in a group">
              ${QUICK_AUDIENCES.map((a) => `
                <option value="${esc(a.value)}"${currentAudienceValue(d) === a.value ? ' selected' : ''}
                  >${esc(a.label)}</option>`).join('')}
            </optgroup>
            ${state.lists.length ? `<optgroup label="Your saved lists">
              ${state.lists.map((l) => `
                <option value="list:${esc(l.id)}"${currentAudienceValue(d) === 'list:' + l.id ? ' selected' : ''}
                  >${esc(l.name)}${l.mailableCount != null ? ` (${l.mailableCount})` : ''}</option>`).join('')}
            </optgroup>` : ''}
          </select>
          <div class="hint" id="mmAudienceHint"></div>
        </div>
        ${legacyTags}
        ${detail && detail.heldCount ? `
          <details>
            <summary style="cursor:pointer;font-size:12.5px;color:var(--muted);font-weight:600">
              ${detail.heldCount} contact${detail.heldCount === 1 ? '' : 's'} held back, and why
            </summary>
            <div class="hint" style="margin:8px 0">
              A recipient count lower than your list size is always explainable. Reasons:
              the audience does not match, the same mailbox is already on the send, an
              unsubscribe, the frequency cap, or an open quote an account manager is
              mid-deal on.
            </div>
            <table class="mm-table">
              <thead><tr><th>Company</th><th>Why held</th></tr></thead>
              <tbody>${(detail.held || []).map((h) => `<tr>
                <td>${esc(h.company_name || h.email)}</td>
                <td class="em">${esc(h.heldReason || '')}</td></tr>`).join('')}</tbody>
            </table>
          </details>` : ''}`;

      /* ---- step 2: from ---- */
      const fromBody = idents.length ? `
        <div class="mm-field">
          <label for="mmIdentity">Sending brand</label>
          <select id="mmIdentity"${readOnly || sent ? ' disabled' : ''}>
            ${idents.map((i) => `
              <option value="${esc(i.key)}"${d.identityKey === i.key ? ' selected' : ''}
                >${esc(i.label)} (${esc(i.domain)})${i.cold ? ' \u00b7 cold outreach' : ''}</option>`).join('')}
          </select>
          <div class="hint" id="mmIdentityHint"></div>
        </div>
        ${detail && detail.identityWarning
          ? `<div class="mm-notice"><b>Check the sending domain.</b> ${esc(detail.identityWarning)}</div>` : ''}`
        : `<div class="mm-notice danger"><b>No sending brands set up.</b>
             Add one in Settings before this can go anywhere.</div>`;

      /* ---- step 3: write ---- */
      const writeBody = `
        <div class="mm-split">
          <div>
            <div class="mm-field">
              <label for="mmSubject">Subject</label>
              <input id="mmSubject" type="text" value="${esc(d.subject || '')}"
                     placeholder="Fall order deadlines are coming up"${readOnly || sent ? ' disabled' : ''}>
            </div>
            <div class="mm-field">
              <label for="mmPreheader">Preheader</label>
              <input id="mmPreheader" type="text" value="${esc(d.preheader || '')}"
                     placeholder="The short line inboxes show next to the subject"${readOnly || sent ? ' disabled' : ''}>
            </div>
            <div class="mm-field" style="margin-bottom:0">
              <label for="mmBody">Body</label>
              <div class="mm-tools">
                <button class="mm-tool" data-ins="bold" type="button">Bold</button>
                <button class="mm-tool" data-ins="link" type="button">Link</button>
                <button class="mm-tool" data-ins="bullet" type="button">Bullets</button>
                <button class="mm-tool" data-ins="first" type="button">First name</button>
                <button class="mm-tool" data-ins="company" type="button">Company</button>
              </div>
              <textarea id="mmBody" placeholder="Write the email here."${readOnly || sent ? ' disabled' : ''}>${esc(d.body || '')}</textarea>
            </div>
          </div>
          <div>
            <div class="mm-preview" id="mmPreview"></div>
          </div>
        </div>`;

      pane.innerHTML = `
        <div class="mm-sendbar">
          <div style="min-width:0">
            <div class="who">${esc(d.id || 'New campaign')}${d.status ? ' \u00b7 ' + esc(d.status) : ''}</div>
            <h2>${esc(d.subject || 'Untitled campaign')}</h2>
          </div>
          <div class="mm-actions">
            <span class="count" id="mmSendCount"></span>
            <button class="mm-btn ghost" id="mmBackToList">Back</button>
            ${sent || readOnly ? '' : '<button class="mm-btn ghost" id="mmSaveCampaign">Save</button>'}
            ${sent || readOnly ? '' : '<button class="mm-btn ghost" id="mmSendTest">Send test</button>'}
            ${sent || readOnly ? '' : '<button class="mm-btn ghost" id="mmScheduleCampaign">Schedule</button>'}
            ${sent || readOnly ? '' : '<button class="mm-btn" id="mmSendCampaign" disabled>Send</button>'}
          </div>
        </div>
        <div id="mmComposeMsg"></div>
        ${sent ? `<div class="mm-notice good"><b>This campaign has already been sent.</b>
          It is shown read-only so the record of what went out stays accurate. Its
          numbers are on the Reports tab.</div>` : ''}
        ${stepHtml('Who gets it', stepMark(steps.who.done), esc(steps.who.text), whoBody)}
        ${stepHtml('Who it comes from', stepMark(steps.from.done), esc(steps.from.text), fromBody)}
        ${stepHtml('What it says', stepMark(steps.write.done), esc(steps.write.text), writeBody)}
        <div id="mmReadyBlock"></div>
        ${sent || readOnly ? '' : `<div class="mm-actions" style="margin-top:6px">
          <button class="mm-btn ghost" id="mmDeleteCampaign">Delete this campaign</button>
        </div>`}`;

      wireComposer();
      renderPreview();
      renderReadyBlock();
    }

    // Everything standing between this campaign and a real send, or the
    // button to fire it. `sendBlockers` is the full set computed fresh by the
    // server on every load: provider, domain verification, from-address AND
    // the CAN-SPAM basics. It is deliberately not trusted from a cached
    // draft, because a domain can stop being verified while a draft sits.
    function renderReadyBlock() {
      const box = $('#mmReadyBlock');
      const btn = $('#mmSendCampaign');
      const countEl = $('#mmSendCount');
      if (!box) return;

      const d = state.editingCampaign;
      const detail = state.composerDetail;

      if (!d) return;
      if (d.status === 'sent') { box.innerHTML = ''; return; }

      if (!d.id) {
        box.innerHTML = `<div class="mm-notice">
          <b>Not saved yet.</b> Press Save and this fills in with exactly who would
          receive it and anything standing in the way.</div>`;
        if (countEl) countEl.textContent = '';
        return;
      }
      if (state.composerLoading || !detail) {
        box.innerHTML = '<div class="mm-notice">Checking who this would reach...</div>';
        if (countEl) countEl.textContent = '';
        return;
      }

      const plan = detail.sendPlan || {};
      const blockers = detail.sendBlockers || [];
      const n = detail.recipientCount || 0;

      if (countEl) {
        countEl.textContent = n
          ? n + ' recipient' + (n === 1 ? '' : 's')
          : 'nobody eligible';
      }

      if (detail.conflict) {
        box.innerHTML = `<div class="mm-notice danger"><b>Cannot send.</b> ${esc(detail.conflict)}</div>`;
        return;
      }
      if (detail.missingList) {
        box.innerHTML = `<div class="mm-notice danger"><b>Cannot send.</b> The list this
          campaign points at no longer exists. Pick another audience above.</div>`;
        return;
      }
      if (blockers.length) {
        box.innerHTML = `<div class="mm-notice danger">
          <b>Not ready to send.</b><ul style="margin:8px 0 0 18px">
          ${blockers.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul></div>`;
        return;
      }
      if (!n) {
        box.innerHTML = `<div class="mm-notice">There is nobody eligible to send this to
          right now. Everyone in this audience is either suppressed, capped, or held
          for one of the reasons listed under step 1.</div>`;
        return;
      }

      const multiDay = plan.days > 1 || (plan.queueRemaining && plan.queueRemaining > 0);
      const rampNote = multiDay ? `<div class="mm-notice">
        <b>This send takes more than one batch.</b> The ${plan.isCold ? 'cold' : 'client'}
        daily cap is ${plan.dailyCap}${plan.isCold ? ` (day ${plan.rampDay} of the warm-up)` : ''}.
        Once started it continues on its own: a check every 15 minutes picks up where it
        left off, so nobody needs to keep pressing Send. Pressing it yourself just pushes
        the next batch out immediately.</div>` : '';

      const scheduled = d.status === 'scheduled' && d.scheduledAt
        ? `<div class="mm-notice"><b>Scheduled for ${esc(fmtDateTime(d.scheduledAt))}.</b>
             It goes out automatically then, whether or not anyone is signed in.
             <button class="mm-btn ghost sm" id="mmUnschedule" style="margin-left:8px">Cancel schedule</button>
           </div>` : '';

      if (!canEditUI()) {
        box.innerHTML = `${scheduled}${rampNote}<div class="mm-notice">
          <b>Ready to send.</b> Your MailMe role is read-only, so you can't press Send.</div>`;
        return;
      }

      box.innerHTML = `${scheduled}${rampNote}
        <div class="mm-notice good"><b>Ready to send</b> to ${n} recipient${n === 1 ? '' : 's'}
          from ${esc((detail.identity && detail.identity.domain) || '')}.
          ${plan.queueRemaining ? `${plan.queueRemaining} still queued from the last run.` : ''}
        </div>`;

      const un = $('#mmUnschedule');
      if (un) un.addEventListener('click', () => unscheduleCampaign(d.id));

      if (btn) {
        btn.disabled = false;
        btn.textContent = plan.queueRemaining ? 'Send next batch' : 'Send now';
      }
    }

    // Live inbox preview. Renders against a REAL recipient where one is
    // available, so {{first_name}} shows an actual name rather than a
    // placeholder that reads fine and then goes out blank.
    function renderPreview() {
      const box = $('#mmPreview');
      const d = state.editingCampaign;
      if (!box || !d) return;

      const sample = state.contacts.find((c) =>
        !SUPPRESSED.includes(c.status) && (d.source ? c.source === d.source : true)) ||
        state.contacts[0] || null;

      const st = state.settings || {};
      const a = st.postalAddress || {};
      const addr = [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(', '), a.postalCode]
        .filter((x) => String(x || '').trim()).join(', ');
      const who = st.companyName || st.fromName || '';
      const footer = [who, addr].filter(Boolean).join(' \u00b7 ');

      const subject = previewPersonalize(d.subject || '', sample);
      const pre = previewPersonalize(d.preheader || '', sample);

      box.innerHTML = `
        <div class="phd">Inbox preview${sample ? ' \u00b7 as ' + esc(sample.company_name || sample.email) : ''}</div>
        <div class="psubj">${esc(subject) || '<span style="color:var(--faint)">(no subject)</span>'}</div>
        ${pre ? `<div class="ppre">${esc(pre)}</div>` : ''}
        ${previewBody(previewPersonalize(d.body || '', sample)) ||
          '<p style="color:var(--faint)">Start typing and it appears here.</p>'}
        <div class="pfoot">${esc(footer)}${footer ? '\n' : ''}Unsubscribe</div>`;
    }

    /* ---------------- composer wiring ---------------- */

    // Reads what is on screen into the in-memory campaign. Called on every
    // input so the preview, the step markers and the sticky title all move
    // together. Nothing here touches the server.
    function syncComposerFromDom() {
      const d = state.editingCampaign;
      if (!d) return;
      const subj = $('#mmSubject');
      const pre = $('#mmPreheader');
      const body = $('#mmBody');
      if (subj) d.subject = subj.value;
      if (pre) d.preheader = pre.value;
      if (body) d.body = body.value;
    }

    function wireComposer() {
      const back = $('#mmBackToList');
      if (back) back.addEventListener('click', closeCampaign);

      const aud = $('#mmAudience');
      if (aud) {
        aud.addEventListener('change', async () => {
          const d = state.editingCampaign;
          syncComposerFromDom();
          const v = aud.value;
          if (v.startsWith('list:')) {
            d.listId = v.slice(5);
            const l = state.lists.find((x) => x.id === d.listId);
            d.source = (l && l.rule && l.rule.source) || 'client';
          } else {
            d.listId = null;
            d.source = v.slice(4);
          }
          // Choosing a new audience retires any legacy tag targeting rather
          // than leaving two rules fighting over the same campaign.
          d.segmentTags = [];
          // The safe brand for the new audience, unless a cold-safe choice is
          // already in place. See defaultIdentityFor.
          d.identityKey = defaultIdentityFor(d);
          renderComposer();
          if (d.id) { await saveCampaign({ silent: true }); }
        });
      }

      const ident = $('#mmIdentity');
      if (ident) {
        ident.addEventListener('change', () => {
          syncComposerFromDom();
          state.editingCampaign.identityKey = ident.value;
          renderComposer();
        });
      }

      ['#mmSubject', '#mmPreheader', '#mmBody'].forEach((sel) => {
        const el = $(sel);
        if (!el) return;
        el.addEventListener('input', () => {
          syncComposerFromDom();
          renderPreview();
          const title = root.querySelector('.mm-sendbar h2');
          if (title) title.textContent = state.editingCampaign.subject || 'Untitled campaign';
        });
      });

      // Insert-at-cursor beats a paragraph of syntax instructions. The
      // markdown-lite rules still apply if someone types them by hand.
      root.querySelectorAll('[data-ins]').forEach((b) => {
        b.addEventListener('click', () => insertToken(b.dataset.ins));
      });

      const wire = (sel, fn) => { const b = $(sel); if (b) b.addEventListener('click', fn); };
      wire('#mmSaveCampaign', () => saveCampaign({}));
      wire('#mmSendTest', sendTest);
      wire('#mmScheduleCampaign', scheduleCampaign);
      wire('#mmSendCampaign', triggerSend);
      wire('#mmDeleteCampaign', deleteCampaign);

      paintAudienceHints();
    }

    function paintAudienceHints() {
      const d = state.editingCampaign;
      if (!d) return;
      const aHint = $('#mmAudienceHint');
      if (aHint) {
        const q = QUICK_AUDIENCES.find((x) => x.value === currentAudienceValue(d));
        aHint.textContent = q ? q.note
          : 'A saved list. Edit who is on it from the Audience tab.';
      }
      const iHint = $('#mmIdentityHint');
      if (iHint) {
        const idents = (state.settings && state.settings.identities) || [];
        const chosen = idents.find((i) => i.key === d.identityKey);
        const cold = audienceIsCold(d);
        if (!chosen) {
          iHint.textContent = 'Pick which brand this sends as.';
        } else if (cold && !chosen.cold) {
          iHint.textContent = `${chosen.label} is not marked for cold outreach. Complaints ` +
            'on this domain can push your quotes and invoices into customers\u2019 spam.';
        } else if (cold) {
          iHint.textContent = `Cold outreach, kept on ${chosen.domain} so complaints ` +
            'cannot hurt client mail.';
        } else {
          iHint.textContent = `Sends from ${chosen.domain}.`;
        }
      }
    }

    function insertToken(kind) {
      const ta = $('#mmBody');
      if (!ta || ta.disabled) return;
      const map = {
        bold: ['**', '**', 'bold text'],
        link: ['[', '](https://)', 'link text'],
        bullet: ['\n- ', '', 'first item'],
        first: ['{{first_name}}', '', ''],
        company: ['{{company_name}}', '', '']
      };
      const [open, close, placeholder] = map[kind] || ['', '', ''];
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = ta.value.slice(start, end) || placeholder;
      const inserted = open + selected + close;
      ta.value = ta.value.slice(0, start) + inserted + ta.value.slice(end);
      // Land the cursor on the text you are meant to replace, not after it.
      const selStart = start + open.length;
      ta.focus();
      ta.setSelectionRange(selStart, selStart + selected.length);
      syncComposerFromDom();
      renderPreview();
    }

    /* ---------------- campaign actions ---------------- */

    // ONE save path, and it can only ever produce a draft. Every action that
    // needs a saved id (test send, schedule, send) routes through here first,
    // so what goes out is always exactly what is on screen rather than the
    // last version someone remembered to press Save on.
    async function saveCampaign(opts) {
      const d = state.editingCampaign;
      if (!d) return { ok: false, error: 'Nothing open' };
      syncComposerFromDom();

      const payload = {
        subject: d.subject || '',
        preheader: d.preheader || '',
        body: d.body || '',
        source: d.source || 'client',
        listId: d.listId || null,
        segmentTags: d.segmentTags || [],
        identityKey: d.identityKey || null
      };

      if (!payload.subject.trim() || !payload.body.trim()) {
        const error = 'A campaign needs both a subject and a body before it can be saved.';
        if (!(opts && opts.silent)) composerMsg(esc(error), 'mm-err');
        return { ok: false, error };
      }

      try {
        const res = d.id
          ? await api.patch(ENDPOINTS.mmCampaigns, { id: d.id, ...payload })
          : await api.post(ENDPOINTS.mmCampaigns, payload);
        const saved = res.campaign;
        state.editingCampaign = { ...saved, segmentTags: saved.segmentTags || [] };
        await loadCampaigns();
        // The audience changed what the server would do, so its verdict is
        // refetched rather than reused.
        state.composerLoading = true;
        renderComposer();
        await loadComposerDetail(saved.id);
        state.composerLoading = false;
        renderComposer();
        renderCampaignList();
        if (!(opts && opts.silent)) composerMsg('Saved.', 'mm-ok');
        return { ok: true, campaign: saved };
      } catch (e) {
        if (!(opts && opts.silent)) composerMsg('Could not save: ' + esc(e.message), 'mm-err');
        return { ok: false, error: e.message };
      }
    }

    async function sendTest() {
      const result = await saveCampaign({ silent: true });
      if (!result.ok) { composerMsg(esc(result.error), 'mm-err'); return; }

      const to = window.prompt('Send a test copy to which email address?', '');
      if (!to || !to.trim()) return;

      try {
        await api.post(ENDPOINTS.mmCampaigns, {},
          { query: { id: result.campaign.id, action: 'test', to: to.trim() } });
        composerMsg(`Test sent to ${esc(to.trim())}. Check that inbox, and the spam folder, ` +
          'in a minute. This touched no stats and nobody else received anything.', 'mm-ok');
      } catch (e) {
        composerMsg('Could not send test: ' + esc(e.message), 'mm-err');
      }
    }

    async function scheduleCampaign() {
      const when = window.prompt(
        'Schedule this send.\n\nEnter a date and time, e.g. 2026-09-12 08:00', '');
      if (when === null) return;
      const dt = new Date(String(when).replace(' ', 'T'));
      if (isNaN(dt.getTime()) || dt.getTime() <= Date.now()) {
        composerMsg('That has to be a real date and time in the future.', 'mm-err');
        return;
      }

      const result = await saveCampaign({ silent: true });
      if (!result.ok) { composerMsg(esc(result.error), 'mm-err'); return; }

      try {
        await api.post(ENDPOINTS.mmCampaigns, { scheduledAt: dt.toISOString() },
          { query: { id: result.campaign.id, action: 'schedule' } });
        await loadCampaigns();
        await openCampaign(result.campaign.id);
        composerMsg(`Scheduled for ${esc(fmtDateTime(dt.toISOString()))}. Nobody needs to ` +
          'be signed in when it goes.', 'mm-ok');
      } catch (e) {
        composerMsg('Could not schedule: ' + esc(e.message), 'mm-err');
      }
    }

    async function unscheduleCampaign(id) {
      if (!window.confirm('Cancel this scheduled send and go back to editing it as a draft?')) return;
      try {
        await api.post(ENDPOINTS.mmCampaigns, {}, { query: { id, action: 'unschedule' } });
        await loadCampaigns();
        await openCampaign(id);
        composerMsg('Schedule cancelled. Back to a draft.', 'mm-ok');
      } catch (e) {
        composerMsg('Could not cancel the schedule: ' + esc(e.message), 'mm-err');
      }
    }

    async function triggerSend() {
      const d = state.editingCampaign;
      const detail = state.composerDetail;
      if (!d || !d.id || !detail) return;

      // Save first, so a last edit made after the readiness check still goes
      // out. The server re-runs every pre-send check itself regardless.
      const saved = await saveCampaign({ silent: true });
      if (!saved.ok) { composerMsg(esc(saved.error), 'mm-err'); return; }

      const isContinuation = !!(detail.sendPlan && detail.sendPlan.queueRemaining);
      const n = state.composerDetail ? state.composerDetail.recipientCount : detail.recipientCount;
      const label = isContinuation
        ? 'Send the next batch of this campaign now, rather than waiting for it to continue automatically?'
        : `Send this campaign for real, to ${n} recipient${n === 1 ? '' : 's'}? This cannot be taken back.`;
      if (!window.confirm(label)) return;

      try {
        const result = await api.post(ENDPOINTS.mmCampaigns, {},
          { query: { id: d.id, action: 'send' } });
        await loadCampaigns();
        await openCampaign(d.id);
        composerMsg(
          result.done
            ? `Sent. ${result.sentThisRun} email${result.sentThisRun === 1 ? '' : 's'} handed to Resend. ` +
              'Opens and clicks appear on the Reports tab as they come in.'
            : `Sent this batch: ${result.sentThisRun} email${result.sentThisRun === 1 ? '' : 's'}. ` +
              `${result.remaining} left. It continues on its own within about 15 minutes, or ` +
              'press Send again to push the next batch out now.',
          'mm-ok');
        if (result.failedThisRun) {
          composerMsg(
            `${result.failedThisRun} email${result.failedThisRun === 1 ? '' : 's'} failed to send: ` +
            esc((result.providerErrors || []).join('; ')), 'mm-err');
        }
      } catch (e) {
        composerMsg('Could not send: ' + esc(e.message), 'mm-err');
      }
    }

    async function deleteCampaign() {
      const d = state.editingCampaign;
      if (!d || !d.id) { closeCampaign(); return; }
      if (!window.confirm('Delete this campaign? This cannot be undone.')) return;
      try {
        await api.del(ENDPOINTS.mmCampaigns, { query: { id: d.id } });
        await loadCampaigns();
        closeCampaign();
        msg('#mmCampaignMsg', 'Campaign deleted.', 'mm-ok');
      } catch (e) {
        composerMsg('Could not delete: ' + esc(e.message), 'mm-err');
      }
    }

    /* ---------------- audience: the list rail ---------------- */

    // Lists as a filter over one table, rather than a separate tab. "My
    // contacts" and "a saved slice of my contacts" are the same people, and
    // making them two screens meant two mental models for one idea.
    function renderListRail() {
      const rail = $('#mmListRail');
      if (!rail) return;

      rail.innerHTML =
        '<span class="lbl">Lists</span>' +
        `<button class="mm-filt" data-list="" aria-pressed="${!state.activeListId}">
           Everyone<span class="n">${state.counts.total || 0}</span></button>` +
        state.lists.map((l) => `
          <button class="mm-filt" data-list="${esc(l.id)}" aria-pressed="${state.activeListId === l.id}">
            ${esc(l.name)}<span class="n">${l.mailableCount != null ? l.mailableCount : '?'}</span>
          </button>`).join('') +
        (state.lists.length ? '' : '<span class="mm-hint">None yet. Filter below and press ' +
          '"Save this view as a list".</span>');

      rail.querySelectorAll('[data-list]').forEach((b) => {
        b.addEventListener('click', () => selectList(b.dataset.list || null));
      });
    }

    // Membership is resolved SERVER-side (GET /api/mailme/lists?id=), the
    // same call the send path uses. Re-deriving it here from the rule would
    // be a second implementation to keep in step, and a static list's members
    // are stored ids that the client has no way to expand anyway.
    async function selectList(listId) {
      state.activeListId = listId || null;
      if (!listId) {
        state.activeList = null;
        state.activeListMembers = null;
        renderListRail(); renderContactsTable();
        return;
      }
      try {
        const d = await api.get(ENDPOINTS.mmLists, { id: listId });
        state.activeList = d.list || null;
        state.activeListMembers = d.members || [];
        state.listMemberIds = (d.members || []).map((m) => String(m.id));
      } catch (e) {
        state.activeList = null;
        state.activeListMembers = [];
        msg('#mmAudienceMsg', 'Could not load that list: ' + esc(e.message), 'mm-err');
      }
      renderListRail(); renderContactsTable();
    }

    /* ---------------- audience: filters ---------------- */

    function renderFilters() {
      const c = state.counts;
      const srcOpts = [
        ['all', 'All sources', c.total || 0],
        ['client', 'Clients', c.client || 0],
        ['lead', 'Leads', c.lead || 0],
        ['giving', 'Giving', c.giving || 0],
        ['prospect', 'Prospects', c.prospect || 0]
      ];
      const statOpts = [
        ['all', 'Any status', null],
        ['mailable', 'Mailable', c.mailable || 0],
        ['unsubscribed', 'Unsubscribed', c.unsubscribed || 0],
        ['bounced', 'Bounced', c.bounced || 0]
      ];

      const box = $('#mmContactFilters');
      if (!box) return;

      box.innerHTML =
        srcOpts.map(([k, label, n]) =>
          `<button class="mm-filt" data-src="${k}" aria-pressed="${state.source === k}">
             ${esc(label)}<span class="n">${n}</span></button>`).join('') +
        '<span class="mm-sep"></span>' +
        statOpts.map(([k, label, n]) =>
          `<button class="mm-filt" data-stat="${k}" aria-pressed="${state.status === k}">
             ${esc(label)}${n === null ? '' : `<span class="n">${n}</span>`}</button>`).join('') +
        `<input class="mm-search" id="mmSearch" type="search"
                placeholder="Search company, email, title or tag" value="${esc(state.search)}">`;

      box.querySelectorAll('[data-src]').forEach((b) => {
        b.addEventListener('click', async () => {
          state.source = b.dataset.src;
          // Filtering by source while a list is selected is two rules at
          // once. The list wins as the container, so leaving it is the
          // honest move rather than showing an intersection nothing else
          // in the app can express.
          state.activeListId = null; state.activeList = null; state.activeListMembers = null;
          await loadContacts(); renderFilters(); renderListRail(); renderContactsTable();
        });
      });
      box.querySelectorAll('[data-stat]').forEach((b) => {
        b.addEventListener('click', async () => {
          state.status = b.dataset.stat;
          await loadContacts(); renderFilters(); renderContactsTable();
        });
      });

      // Debounced so typing does not fire a request per keystroke.
      const search = $('#mmSearch');
      let timer = null;
      if (search) {
        search.addEventListener('input', (e) => {
          state.search = e.target.value;
          clearTimeout(timer);
          timer = setTimeout(async () => {
            await loadContacts(); renderContactsTable();
          }, 250);
        });
      }
    }

    const COLUMNS = [
      ['company_name', 'Company'],
      ['contact_name', 'Contact'],
      ['email', 'Email'],
      ['source', 'Source'],
      ['status', 'Status'],
      ['reorder', 'Reorder'],
      ['tags', 'Tags']
    ];

    async function setSort(key) {
      // Third click on the same column does not cycle back to unsorted: a
      // table with no order is not a useful state to land on by accident.
      if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      else { state.sort = key; state.dir = 'asc'; }
      await loadContacts();
      renderContactsTable();
    }

    // Reorder timing only means anything for clients, and only when they have
    // enough order history for a median gap to be a real pattern. The
    // thresholds are BackBone's (Settings -> Reorder timing).
    function reorderCell(ct) {
      const r = ct.reorder;
      if (!r || !r.confident || r.state === 'unknown') {
        return ct.source === 'client'
          ? '<span class="who">not enough history</span>' : '';
      }
      const m = REORDER_META[r.state] || REORDER_META.unknown;
      const detail = r.daysSince != null && r.expectedGap
        ? `${r.daysSince}d since, usually ${Math.round(r.expectedGap)}d` : '';
      return `<span class="pill ${m.cls}">${esc(m.label)}</span>` +
        (detail ? `<div class="who" style="margin-top:3px">${esc(detail)}</div>` : '');
    }

    /* ---------------- audience: the table ---------------- */

    // ONE table renderer for both modes. When a list is selected it shows
    // that list's resolved members; otherwise it shows the filtered roster.
    // Same columns, same row actions, so nothing has to be relearned when
    // you click a list.
    function renderContactsTable() {
      const c = state.counts;
      const listMode = !!state.activeListId && Array.isArray(state.activeListMembers);
      const rows = listMode ? state.activeListMembers : state.contacts;

      const title = $('#mmTableTitle');
      const meta = $('#mmTableMeta');
      const sub = $('#mmAudienceSub');

      if (title) {
        title.textContent = listMode && state.activeList
          ? state.activeList.name : 'All contacts';
      }
      if (meta) {
        if (listMode && state.activeList) {
          const l = state.activeList;
          meta.textContent =
            `${rows.length} member${rows.length === 1 ? '' : 's'}` +
            (l.mailableCount != null ? `, ${l.mailableCount} mailable` : '') +
            ` \u00b7 ${l.kind === 'static' ? 'fixed set' : 'a rule, re-checked every time'}`;
        } else {
          meta.textContent = rows.length + ' shown';
        }
      }
      if (sub) {
        const srcSummary = Object.keys(SOURCE_META).map((k) => (c[k] || 0) + ' ' + k).join(', ');
        sub.textContent = (c.total || 0) + ' contacts \u00b7 ' + srcSummary +
          (c.customersWithoutEmail
            ? ' \u00b7 ' + c.customersWithoutEmail + ' roster customers with no email' : '');
      }

      const box = $('#mmContactsTable');
      if (!box) return;

      // A selected list gets its own add-by-email row and an Edit-the-rule
      // button, so the whole of the old Lists tab is reachable from here.
      const listTools = listMode && state.activeList ? `
        <div class="mm-add-row">
          <input id="mmAddMemberEmail" type="text" placeholder="Add someone by email, e.g. name@example.com">
          <button class="mm-btn sm" id="mmAddMemberBtn">Add to list</button>
          <button class="mm-btn ghost sm" id="mmEditListBtn">Edit the rule</button>
          <button class="mm-btn ghost sm" id="mmDeleteListBtn">Delete list</button>
        </div>
        ${state.activeList.kind === 'dynamic' && !usesTagMechanism(state.activeList) ? `
          <div class="mm-hint" style="padding:0 16px 10px">
            Adding or removing someone here is kept as an exception to this list's rule.
            The rule still runs and still picks up new matches around them.
          </div>` : ''}
        <div id="mmListMembersMsg"></div>` : '';

      if (!rows.length) {
        box.innerHTML = listTools +
          '<div class="mm-empty"><h4>' +
          (listMode ? 'Nobody on this list yet' : 'Nothing matches') + '</h4><div>' +
          (listMode
            ? (state.activeList && state.activeList.kind === 'static'
              ? 'This list has no contacts saved to it.'
              : 'No contact currently matches this list\u2019s rule.')
            : 'Try a different filter or search.') +
          '</div></div>';
        if (listMode) wireListTools();
        return;
      }

      const head = COLUMNS.map(([key, label]) => {
        const active = !listMode && state.sort === key;
        // Literal glyphs, not HTML entities: an entity like &#9650; matches
        // the repo's hex-color test regex and fails the no-hex rule.
        const arrow = active ? (state.dir === 'asc' ? '\u25B2' : '\u25BC') : '\u25C6';
        // Sorting is a server round trip against the roster query, which a
        // resolved list membership is not part of. Headers stay inert in
        // list mode rather than looking clickable and doing nothing.
        return listMode
          ? `<th>${esc(label)}</th>`
          : `<th class="sortable" data-sort="${key}"${active ? ` aria-sort="${state.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>
               ${esc(label)}<span class="arrow">${arrow}</span></th>`;
      }).join('');

      box.innerHTML = listTools + `
        <table class="mm-table">
          <thead><tr>${head}<th style="text-align:right">Actions</th></tr></thead>
          <tbody>
            ${rows.map((ct) => {
              const m = STATUS_META[ct.status] || STATUS_META.subscribed;
              const src = SOURCE_META[ct.source] || SOURCE_META.client;
              const locked = ct.status === 'bounced' || ct.status === 'complained';
              return `
              <tr>
                <td><div class="co">${esc(ct.company_name || '(no company)')}</div>
                    ${ct.city ? `<div class="who">${esc([ct.city, ct.state].filter(Boolean).join(', '))}</div>` : ''}</td>
                <td>${esc(ct.contact_name || '')}
                    ${ct.title ? `<div class="who">${esc(ct.title)}</div>` : ''}</td>
                <td class="em">${esc(ct.email)}</td>
                <td><span class="pill src" title="${esc(src.note)}">${esc(src.label)}</span></td>
                <td><span class="pill ${m.cls}">${esc(m.label)}</span>
                    ${ct.reason ? `<div class="who" style="margin-top:3px">${esc(ct.reason)}</div>` : ''}
                    ${ct.verification === 'invalid' ? '<div class="who">Failed verification</div>' : ''}</td>
                <td>${reorderCell(ct)}</td>
                <td>${ct.tags && ct.tags.length
                  ? ct.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')
                  : '<span class="tag-none">none</span>'}</td>
                <td style="text-align:right;white-space:nowrap">
                  ${locked ? '<span class="who">provider-set</span>'
                    : `<button class="mm-btn ghost sm" data-toggle="${esc(ct.id)}">${
                        ct.status === 'unsubscribed' ? 'Resubscribe' : 'Unsubscribe'}</button>`}
                  <button class="mm-btn ghost sm" data-tags="${esc(ct.id)}">Tags</button>
                  <button class="mm-btn ghost sm" data-editct="${esc(ct.id)}">Edit</button>
                  ${listMode
                    ? `<button class="mm-btn ghost sm" data-removemember="${esc(ct.id)}">Remove</button>`
                    : (ct.source === 'prospect'
                      ? `<button class="mm-btn ghost sm" data-del="${esc(ct.id)}">Delete</button>` : '')}
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;

      box.querySelectorAll('[data-sort]').forEach((th) => {
        th.addEventListener('click', () => setSort(th.dataset.sort));
      });
      box.querySelectorAll('[data-toggle]').forEach((b) => {
        b.addEventListener('click', () => toggleSub(b.dataset.toggle));
      });
      box.querySelectorAll('[data-tags]').forEach((b) => {
        b.addEventListener('click', () => editTags(b.dataset.tags));
      });
      box.querySelectorAll('[data-editct]').forEach((b) => {
        b.addEventListener('click', () => {
          const ct = rows.find((x) => x.id === b.dataset.editct);
          if (ct) openContactEditor(ct);
        });
      });
      box.querySelectorAll('[data-del]').forEach((b) => {
        b.addEventListener('click', () => deleteProspect(b.dataset.del));
      });
      box.querySelectorAll('[data-removemember]').forEach((b) => {
        b.addEventListener('click', () => {
          const m2 = rows.find((x) => x.id === b.dataset.removemember);
          if (m2) removeListMember(state.activeList, m2);
        });
      });

      if (listMode) wireListTools();
    }

    function wireListTools() {
      const l = state.activeList;
      if (!l) return;
      const addBtn = $('#mmAddMemberBtn');
      const addInput = $('#mmAddMemberEmail');
      if (addBtn && addInput) {
        addBtn.addEventListener('click', () => addListMemberByEmail(l, addInput.value));
        addInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') addListMemberByEmail(l, addInput.value);
        });
      }
      const editBtn = $('#mmEditListBtn');
      if (editBtn) {
        editBtn.addEventListener('click', () => {
          state.editingList = { ...l };
          renderListEditor();
        });
      }
      const delBtn = $('#mmDeleteListBtn');
      if (delBtn) delBtn.addEventListener('click', () => removeList(l.id));
    }

    async function toggleSub(id) {
      const pool = state.activeListMembers || state.contacts;
      const ct = pool.find((x) => x.id === id) || state.contacts.find((x) => x.id === id);
      if (!ct) return;
      let payload;
      if (ct.status === 'unsubscribed') {
        payload = { id, status: 'subscribed' };
      } else {
        // Capturing WHY is the reason MailMe keeps a reason field at all:
        // providers report the unsubscribe but never the cause.
        const reason = window.prompt(
          'Unsubscribe ' + (ct.company_name || ct.email) +
          '.\n\nReason (optional, for your own reporting):', '');
        if (reason === null) return;
        payload = { id, status: 'unsubscribed', reason };
      }
      try {
        await api.patch(ENDPOINTS.mmContacts, payload);
        await refreshAudience();
        msg('#mmAudienceMsg', 'Updated ' + esc(ct.company_name || ct.email) + '.', 'mm-ok');
      } catch (e) {
        msg('#mmAudienceMsg', 'Could not update: ' + esc(e.message), 'mm-err');
      }
    }

    async function editTags(id) {
      const pool = state.activeListMembers || state.contacts;
      const ct = pool.find((x) => x.id === id) || state.contacts.find((x) => x.id === id);
      if (!ct) return;
      const next = window.prompt(
        'Tags for ' + (ct.company_name || ct.email) +
        '.\n\nComma separated. These are how you build a list later.', (ct.tags || []).join(', '));
      if (next === null) return;
      const tags = next.split(',').map((t) => t.trim()).filter(Boolean);
      try {
        await api.patch(ENDPOINTS.mmContacts, { id, tags });
        await refreshAudience();
        msg('#mmAudienceMsg', 'Tags updated.', 'mm-ok');
      } catch (e) {
        msg('#mmAudienceMsg', 'Could not update tags: ' + esc(e.message), 'mm-err');
      }
    }

    async function deleteProspect(id) {
      const ct = state.contacts.find((x) => x.id === id);
      if (!ct) return;
      if (!window.confirm('Delete ' + (ct.company_name || ct.email) + ' from prospects?\n\n' +
        'If they ever unsubscribed, that stays on record: deleting and re-importing ' +
        'will not start mailing them again.')) return;
      try {
        await api.del(ENDPOINTS.mmContacts, { query: { id } });
        await refreshAudience();
        msg('#mmAudienceMsg', 'Prospect deleted.', 'mm-ok');
      } catch (e) {
        msg('#mmAudienceMsg', 'Could not delete: ' + esc(e.message), 'mm-err');
      }
    }

    // One reload path for the whole screen, so a change made from a list row
    // and the same change made from the roster leave the app in the same
    // state rather than one of them going stale.
    async function refreshAudience() {
      await Promise.all([loadContacts(), loadLists()]);
      if (state.activeListId) await selectList(state.activeListId);
      renderFilters(); renderListRail(); renderContactsTable(); renderHealth();
    }

    /* ---------------- contact detail editor ----------------
     *
     * Works on any source. For a prospect this edits MailMe's own record. For
     * client/lead/giving contacts it writes a MailMe-local correction layered
     * on top of whatever BackBone or GivingGauge resolved. The owning app's
     * real record is never touched, so this cannot drift from or fight with a
     * future sync from there.
     */

    function openContactEditor(ct) {
      if (!ct) return;
      state.editingContact = {
        id: ct.id,
        source: ct.source,
        company_name: ct.company_name || '',
        contact_name: ct.contact_name || '',
        title: ct.title || '',
        phone: ct.phone || '',
        city: ct.city || '',
        state: ct.state || '',
      };
      renderContactEditor();
    }

    function closeContactEditor() {
      state.editingContact = null;
      renderContactEditor();
    }

    function renderContactEditor() {
      const box = $('#mmContactEditor');
      if (!box) return;
      const e = state.editingContact;
      if (!e) { box.hidden = true; box.innerHTML = ''; return; }
      box.hidden = false;
      const overlayNote = e.source && e.source !== 'prospect'
        ? `<div class="mm-hint" style="margin-bottom:14px">
             This contact's info is normally set by ${
               e.source === 'client' ? 'the BackBone roster'
                 : e.source === 'lead' ? "BackBone's leads pipeline"
                 : 'GivingGauge'
             }. Saving here only corrects what MailMe shows and mails to. It does not
             change the original record there.
           </div>` : '';
      box.innerHTML = `
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>Edit contact</h3><span class="meta">${esc(e.id)}</span>
          </div>
          <div class="mm-card-bd">
            <div id="mmContactEditorMsg"></div>
            ${overlayNote}
            <div class="mm-edit-grid">
              <div class="mm-field full">
                <label for="mmEditCompany">Company</label>
                <input id="mmEditCompany" type="text" value="${esc(e.company_name)}">
              </div>
              <div class="mm-field">
                <label for="mmEditContactName">Contact name</label>
                <input id="mmEditContactName" type="text" value="${esc(e.contact_name)}">
              </div>
              <div class="mm-field">
                <label for="mmEditTitle">Title</label>
                <input id="mmEditTitle" type="text" value="${esc(e.title)}">
              </div>
              <div class="mm-field">
                <label for="mmEditPhone">Phone</label>
                <input id="mmEditPhone" type="text" value="${esc(e.phone)}">
              </div>
              <div class="mm-field">
                <label for="mmEditCity">City</label>
                <input id="mmEditCity" type="text" value="${esc(e.city)}">
              </div>
              <div class="mm-field">
                <label for="mmEditState">State</label>
                <input id="mmEditState" type="text" value="${esc(e.state)}">
              </div>
            </div>
            <div class="mm-actions">
              <button class="mm-btn" id="mmSaveContactEdit">Save</button>
              <button class="mm-btn ghost" id="mmCancelContactEdit">Cancel</button>
            </div>
          </div>
        </div>`;

      $('#mmSaveContactEdit').addEventListener('click', saveContactEditor);
      $('#mmCancelContactEdit').addEventListener('click', closeContactEditor);
    }

    async function saveContactEditor() {
      const e = state.editingContact;
      if (!e) return;
      const payload = {
        id: e.id,
        company_name: $('#mmEditCompany').value,
        contact_name: $('#mmEditContactName').value,
        title: $('#mmEditTitle').value,
        phone: $('#mmEditPhone').value,
        city: $('#mmEditCity').value,
        state: $('#mmEditState').value,
      };
      try {
        await api.patch(ENDPOINTS.mmContacts, payload);
        closeContactEditor();
        await refreshAudience();
        msg('#mmAudienceMsg', 'Contact updated.', 'mm-ok');
      } catch (err) {
        msg('#mmContactEditorMsg', 'Could not save: ' + esc(err.message), 'mm-err');
      }
    }

    /* ---------------- lists ---------------- */

    // The list RULE stays a modal. It is a short, bounded thing you set once
    // and close, unlike the composer, which is why that one became a page and
    // this one did not.
    function renderListEditor() {
      const l = state.editingList;
      if (!l) { closeModalIf('list'); return; }

      const rule = l.rule || { source: '', statuses: [], tags: [], tagMatch: 'any', search: '' };
      openModal(`
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>${l.id ? 'Edit ' + esc(l.name || l.id) : 'New list'}</h3>
            <span class="meta">${l.kind === 'static' ? 'Fixed set' : 'A rule, re-checked every time'}</span>
          </div>
          <div class="mm-card-bd">
            <div class="mm-field">
              <label for="mmListName">Name</label>
              <input id="mmListName" type="text" value="${esc(l.name || '')}"
                     placeholder="Cold prospects, central Iowa schools">
            </div>
            ${l.kind === 'static' ? `
              <div class="mm-recip">${(l.members || []).length} contacts, fixed at the time it was saved.</div>
            ` : `
              <div class="mm-row">
                <div class="mm-field">
                  <label for="mmRuleSource">Source</label>
                  <select id="mmRuleSource">
                    <option value=""${!rule.source ? ' selected' : ''}>Any source</option>
                    <option value="client"${rule.source === 'client' ? ' selected' : ''}>Clients only</option>
                    <option value="lead"${rule.source === 'lead' ? ' selected' : ''}>Leads only</option>
                    <option value="giving"${rule.source === 'giving' ? ' selected' : ''}>Giving contacts only</option>
                    <option value="prospect"${rule.source === 'prospect' ? ' selected' : ''}>Prospects only</option>
                  </select>
                </div>
                <div class="mm-field">
                  <label for="mmRuleTagMatch">Tag match</label>
                  <select id="mmRuleTagMatch">
                    <option value="any"${rule.tagMatch !== 'all' ? ' selected' : ''}>Any of these tags</option>
                    <option value="all"${rule.tagMatch === 'all' ? ' selected' : ''}>All of these tags</option>
                  </select>
                </div>
              </div>
              <div class="mm-field">
                <label for="mmRuleTags">Tags</label>
                <input id="mmRuleTags" type="text" value="${esc((rule.tags || []).join(', '))}"
                       placeholder="Leave blank for no tag filter">
                <div class="hint">${state.tags.length
                  ? 'Tags in use: ' + esc(state.tags.join(', ')) : 'No tags created yet.'}</div>
              </div>
              <div class="mm-field">
                <label for="mmRuleSearch">Text match</label>
                <input id="mmRuleSearch" type="text" value="${esc(rule.search || '')}"
                       placeholder="Matches company, name, email or title">
              </div>
            `}
            <div class="mm-actions">
              <button class="mm-btn" id="mmSaveList">Save list</button>
              <button class="mm-btn ghost" id="mmCancelList">Cancel</button>
              ${l.id ? '<button class="mm-btn ghost" id="mmDeleteList">Delete</button>' : ''}
            </div>
          </div>
        </div>`, 'list');

      $('#mmSaveList').addEventListener('click', saveList);
      $('#mmCancelList').addEventListener('click', () => { state.editingList = null; renderListEditor(); });
      const del = $('#mmDeleteList');
      if (del) del.addEventListener('click', () => removeList(l.id));
    }

    async function saveList() {
      const l = state.editingList;
      const payload = { name: $('#mmListName').value, kind: l.kind };

      if (l.kind === 'static') {
        payload.members = l.members || [];
      } else {
        payload.rule = {
          source: $('#mmRuleSource').value || null,
          statuses: [],
          tags: $('#mmRuleTags').value.split(',').map((t) => t.trim()).filter(Boolean),
          tagMatch: $('#mmRuleTagMatch').value,
          search: $('#mmRuleSearch').value
        };
      }

      if (!payload.name.trim()) {
        listEditorMsg('A list needs a name.', 'mm-err');
        return;
      }
      try {
        const res = l.id
          ? await api.patch(ENDPOINTS.mmLists, { id: l.id, ...payload })
          : await api.post(ENDPOINTS.mmLists, payload);
        state.editingList = null;
        closeModalIf('list');
        await loadLists();
        // Land on the list that was just saved. Making something and then
        // having to go find it is the sort of small tax that adds up.
        const newId = (res && res.list && res.list.id) || l.id;
        if (newId) await selectList(newId);
        else { renderListRail(); renderContactsTable(); }
        msg('#mmAudienceMsg', 'List saved.', 'mm-ok');
      } catch (e) {
        listEditorMsg('Could not save: ' + esc(e.message), 'mm-err');
      }
    }

    async function removeList(id) {
      if (!window.confirm('Delete this list? The contacts on it are not affected.')) return;
      try {
        await api.del(ENDPOINTS.mmLists, { query: { id } });
        state.editingList = null;
        closeModalIf('list');
        state.activeListId = null; state.activeList = null; state.activeListMembers = null;
        await loadLists();
        renderListRail(); renderContactsTable();
        msg('#mmAudienceMsg', 'List deleted.', 'mm-ok');
      } catch (e) {
        msg('#mmAudienceMsg', 'Could not delete: ' + esc(e.message), 'mm-err');
      }
    }

    // A tag-based dynamic rule adds/removes the rule's tags, because that
    // keeps the contact and the rule telling the same story. Any other
    // dynamic rule records the change as an override on the list itself,
    // which is what makes source-only and search-only lists editable at all.
    function listRuleTags(list) {
      if (!list || list.kind !== 'dynamic') return [];
      const tags = (list.rule && Array.isArray(list.rule.tags)) ? list.rule.tags : [];
      return tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    }

    function usesTagMechanism(list) {
      return list && list.kind === 'dynamic' && listRuleTags(list).length > 0;
    }

    async function removeListMember(list, member) {
      if (!list) return;
      try {
        const mid = String(member.id);
        if (list.kind === 'static') {
          const members = (list.members || []).filter((id) => String(id) !== mid);
          await api.patch(ENDPOINTS.mmLists, { id: list.id, members });
        } else if (usesTagMechanism(list)) {
          const ruleTags = listRuleTags(list);
          const tags = (member.tags || []).filter(
            (t) => !ruleTags.includes(String(t).trim().toLowerCase())
          );
          await api.patch(ENDPOINTS.mmContacts, { id: member.id, tags });
        } else {
          // Record the removal against the list. Dropping them from
          // extraMembers alone is not enough: if the rule still matches them
          // they would reappear on the next render.
          const excludedMembers = [...new Set([...(list.excludedMembers || []).map(String), mid])];
          const extraMembers = (list.extraMembers || []).map(String).filter((x) => x !== mid);
          await api.patch(ENDPOINTS.mmLists, { id: list.id, excludedMembers, extraMembers });
        }
        await refreshAudience();
      } catch (e) {
        msg('#mmListMembersMsg', 'Could not remove: ' + esc(e.message), 'mm-err');
      }
    }

    async function addListMemberByEmail(list, rawEmail) {
      if (!list) return;
      const email = String(rawEmail || '').trim().toLowerCase();
      if (!email) return msg('#mmListMembersMsg', 'Enter an email address.', 'mm-err');

      // Find-or-create. An address already in MailMe keeps whatever it
      // already is; an unknown one becomes a prospect. The server does the
      // matching, so an address that exists under a source not currently
      // loaded here is still recognised instead of being duplicated.
      let candidate = state.contacts.find((c) => String(c.email || '').trim().toLowerCase() === email);
      let createdNew = false;
      if (!candidate) {
        try {
          const res = await api.post(ENDPOINTS.mmContacts, { email });
          candidate = res.contact;
          createdNew = !!res.created;
          if (createdNew) await loadContacts();
        } catch (e) {
          return msg('#mmListMembersMsg', esc(e.message), 'mm-err');
        }
      }
      if (!candidate) return msg('#mmListMembersMsg', 'Could not add that address.', 'mm-err');

      const cid = String(candidate.id);
      if ((state.listMemberIds || []).includes(cid)) {
        return msg('#mmListMembersMsg', esc(candidate.email) + ' is already on this list.', 'mm-err');
      }

      try {
        if (list.kind === 'static') {
          const members = [...new Set([...(list.members || []).map(String), cid])];
          await api.patch(ENDPOINTS.mmLists, { id: list.id, members });
        } else if (usesTagMechanism(list)) {
          const ruleTags = listRuleTags(list);
          const tags = [...new Set([
            ...(candidate.tags || []).map((t) => String(t).trim().toLowerCase()),
            ...ruleTags,
          ])];
          await api.patch(ENDPOINTS.mmContacts, { id: candidate.id, tags });
        } else {
          // No tag to set, so the addition is recorded on the list. Also drop
          // any prior exclusion, or the override would cancel itself.
          const extraMembers = [...new Set([...(list.extraMembers || []).map(String), cid])];
          const excludedMembers = (list.excludedMembers || []).map(String).filter((x) => x !== cid);
          await api.patch(ENDPOINTS.mmLists, { id: list.id, extraMembers, excludedMembers });
        }
        await refreshAudience();
        msg('#mmListMembersMsg', createdNew
          ? `Added ${esc(candidate.email)} as a new prospect.`
          : `Added ${esc(candidate.email)} (existing ${esc(candidate.source || 'contact')}).`,
          'mm-ok');
      } catch (e) {
        msg('#mmListMembersMsg', 'Could not add: ' + esc(e.message), 'mm-err');
      }
    }

    /* ---------------- import ----------------
     *
     * Was a permanent tab. It is a task done a few times a year, so it is a
     * button on Audience now, opening a modal. Nothing about the two-step
     * preview-then-commit flow changed: reading the file in the browser keeps
     * a large CSV off the network until it has been parsed and looked at.
     */

    function openImport() {
      openModal(`
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>Import prospects from a CSV</h3>
            <span class="meta">Preview first, import second</span>
          </div>
          <div class="mm-card-bd">
            <div id="mmImportMsg"></div>
            <div class="mm-field">
              <label for="mmCsvFile">CSV file</label>
              <input type="file" id="mmCsvFile" accept=".csv,text/csv">
              <div class="hint">
                Needs an email column. Company, Name, Title, Phone, City and State are
                picked up automatically if present, under most common column names.
              </div>
            </div>
            <div class="mm-field">
              <label for="mmCsvText">Or paste the rows</label>
              <textarea id="mmCsvText" class="csv" placeholder="Email,Company,Name,Title"></textarea>
            </div>
            <div class="mm-field">
              <label for="mmImportTags">Tag this batch</label>
              <input id="mmImportTags" type="text" placeholder="cold-2026-q3, school-districts">
              <div class="hint">
                Comma separated, applied to every imported row. This is how a cold batch
                stays segmentable later, so it is worth filling in.
              </div>
            </div>
            <div class="mm-actions">
              <button class="mm-btn" id="mmPreviewImport">Preview</button>
              <button class="mm-btn" id="mmCommitImport" hidden>Import them</button>
              <button class="mm-btn ghost" id="mmClearImport">Clear</button>
            </div>
            <div id="mmImportPreview"></div>
          </div>
        </div>`, 'import');

      $('#mmCsvFile').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          $('#mmCsvText').value = String(reader.result || '');
          msg('#mmImportMsg', 'Loaded ' + esc(file.name) + '. Preview it before importing.', 'mm-ok');
        };
        reader.onerror = () => msg('#mmImportMsg', 'Could not read that file.', 'mm-err');
        reader.readAsText(file);
      });

      $('#mmClearImport').addEventListener('click', () => {
        $('#mmCsvText').value = '';
        $('#mmCsvFile').value = '';
        $('#mmImportTags').value = '';
        state.importPreview = null;
        $('#mmImportPreview').innerHTML = '';
        $('#mmCommitImport').hidden = true;
        msg('#mmImportMsg', '', '');
      });

      $('#mmPreviewImport').addEventListener('click', previewImport);
      $('#mmCommitImport').addEventListener('click', commitImport);
    }

    const importTags = () =>
      $('#mmImportTags').value.split(',').map((t) => t.trim()).filter(Boolean);

    async function previewImport() {
      const csv = $('#mmCsvText').value;
      if (!csv.trim()) {
        msg('#mmImportMsg', 'Paste some rows or choose a file first.', 'mm-err');
        return;
      }
      msg('#mmImportMsg', 'Checking the file...', 'mm-ok');
      try {
        const d = await api.post(ENDPOINTS.mmImport, { csv, tags: importTags() });
        state.importPreview = d;
        state.importCsv = csv;
        renderImportPreview();
        msg('#mmImportMsg', '', '');
      } catch (e) {
        state.importPreview = null;
        $('#mmImportPreview').innerHTML = '';
        $('#mmCommitImport').hidden = true;
        msg('#mmImportMsg', esc(e.message), 'mm-err');
      }
    }

    async function commitImport() {
      if (!state.importPreview) return;
      const n = state.importPreview.summary.importable;
      if (!window.confirm('Import ' + n + ' new prospect' + (n === 1 ? '' : 's') + '?')) return;
      try {
        const d = await api.post(ENDPOINTS.mmImport, {
          csv: state.importCsv, tags: importTags(), commit: true
        });
        state.importPreview = null;
        closeModalIf('import');
        await refreshAudience();
        msg('#mmAudienceMsg',
          'Imported ' + d.imported + ' prospect' + (d.imported === 1 ? '' : 's') +
          '. Batch ' + esc(d.batchId) + '.', 'mm-ok');
      } catch (e) {
        msg('#mmImportMsg', 'Import failed: ' + esc(e.message), 'mm-err');
      }
    }

    function rejectTable(title, rows, tone) {
      if (!rows || !rows.length) return '';
      return `
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>${esc(title)}</h3><span class="meta">${rows.length} shown</span>
          </div>
          <div class="mm-card-bd flush">
            <table class="mm-table">
              <thead><tr><th>Line</th><th>Email</th><th>Company</th><th>Why</th></tr></thead>
              <tbody>${rows.map((r) => `
                <tr>
                  <td class="who">${esc(r.lineNumber)}</td>
                  <td class="em">${esc(r.email || '(blank)')}</td>
                  <td>${esc(r.company_name || '')}</td>
                  <td><span class="pill ${tone}">${esc(r.problem || '')}</span></td>
                </tr>`).join('')}</tbody>
            </table>
          </div>
        </div>`;
    }

    function renderImportPreview() {
      const d = state.importPreview;
      const box = $('#mmImportPreview');
      if (!box) return;
      if (!d) { box.innerHTML = ''; return; }
      const s = d.summary;
      const rej = d.rejected || {};

      $('#mmCommitImport').hidden = !s.importable;

      const unmapped = (s.unmappedColumns || []).length
        ? `<div class="mm-notice"><b>Columns not recognized:</b> ${esc(s.unmappedColumns.join(', '))}.
             These are ignored. If one of them holds the company or contact name, rename it
             and preview again.</div>` : '';

      // A cold batch dominated by one domain is usually a scrape of a single
      // directory, and is worth a second look before it goes out.
      const domains = (s.topDomains || []).length
        ? `<div class="mm-field"><label>Top domains in this batch</label>
             <div>${s.topDomains.map((t) =>
               `<span class="tag">${esc(t.domain)} \u00D7${t.count}</span>`).join('')}</div>
             <div class="hint">A batch heavily weighted to one domain is often a scrape of a
               single directory. Worth a look before sending.</div></div>` : '';

      box.innerHTML = `
        ${unmapped}
        <div class="mm-stat-row" style="margin-top:14px">
          <div class="mm-stat"><div class="v">${s.parsed}</div><div class="l">Rows read</div></div>
          <div class="mm-stat"><div class="v">${s.importable}</div><div class="l">Importable</div></div>
          <div class="mm-stat"><div class="v">${s.duplicate}</div><div class="l">Duplicates</div></div>
          <div class="mm-stat"><div class="v">${s.existingClients}</div><div class="l">Already clients</div></div>
          <div class="mm-stat"><div class="v">${s.suppressed}</div><div class="l">Opted out before</div></div>
          <div class="mm-stat"><div class="v">${s.invalid}</div><div class="l">Invalid</div></div>
        </div>
        ${domains}
        ${(s.tags || []).length
          ? `<div class="mm-field"><label>Tags to apply</label>
               <div>${s.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>`
          : `<div class="hint" style="margin-bottom:14px">No batch tags set. Adding one now
               makes this batch far easier to turn into a list later.</div>`}
        ${(d.preview || []).length ? `
        <div class="mm-card">
          <div class="mm-card-hd"><h3>Will be imported</h3>
            <span class="meta">first ${Math.min(25, d.preview.length)} of ${s.importable}</span></div>
          <div class="mm-card-bd flush">
            <table class="mm-table">
              <thead><tr><th>Email</th><th>Company</th><th>Contact</th><th>Title</th></tr></thead>
              <tbody>${d.preview.map((r) => `
                <tr><td class="em">${esc(r.email)}</td><td>${esc(r.company_name || '')}</td>
                    <td>${esc(r.contact_name || '')}</td><td class="who">${esc(r.title || '')}</td></tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>` : ''}
        ${rejectTable('Already opted out, will not be imported', rej.suppressed, 'bad')}
        ${rejectTable('Already clients in BackBone', rej.existingClients, 'warn')}
        ${rejectTable('Duplicates', rej.duplicate, 'mute')}
        ${rejectTable('Invalid rows', rej.invalid, 'bad')}`;
    }

    /* ---------------- modal machinery ---------------- */

    // Created on demand and appended to <body>, not left in the markup, so it
    // overlays the page instead of pushing it around.
    function openModal(innerHtml, kind) {
      closeModal();
      const back = document.createElement('div');
      back.className = 'mm-modal-back';
      back.id = 'mmModalBack';
      back.innerHTML = `<div class="mm-modal" role="dialog" aria-modal="true">
        <button class="mm-modal-x" id="mmModalX" aria-label="Close">&times;</button>
        <div id="mmModalMsg"></div>
        <div id="mmModalBody">${innerHtml}</div></div>`;
      // Clicking the backdrop closes; clicking inside must not.
      back.addEventListener('click', (ev) => { if (ev.target === back) dismissModal(); });
      back.querySelector('#mmModalX').addEventListener('click', dismissModal);
      document.addEventListener('keydown', escClose);
      // App styles are scoped to [data-app-root="mailme"], so a bare body
      // child would render unstyled. The backdrop is wrapped in a carrier div
      // holding that attribute, which keeps every .mm-* rule matching while
      // still escaping the app root's transformed ancestor.
      const carrier = document.createElement('div');
      carrier.dataset.appRoot = 'mailme';
      carrier.appendChild(back);
      document.body.appendChild(carrier);
      modalCarrier = carrier;
      modalKind = kind || null;
      document.body.style.overflow = 'hidden';
      return back;
    }

    function escClose(ev) { if (ev.key === 'Escape') dismissModal(); }

    // Closing by X, backdrop or Escape must also drop the editing session.
    // Otherwise state still holds something nobody is looking at, and the next
    // repaint sees "an editor is open" and skips rendering.
    function dismissModal() {
      if (modalKind === 'list') state.editingList = null;
      if (modalKind === 'import') state.importPreview = null;
      closeModal();
    }
    // Held on the instance so unmount() can tear down the document-level
    // Escape listener, which would otherwise keep firing against a detached
    // root.
    this._closeModal = closeModal;

    function closeModal() {
      if (modalCarrier) { modalCarrier.remove(); modalCarrier = null; }
      modalKind = null;
      document.removeEventListener('keydown', escClose);
      document.body.style.overflow = '';
    }

    // Close only if the thing on screen is what the caller thinks it is.
    // Without this, a background repaint that clears one editor would also
    // tear down an unrelated modal someone is actively reading.
    function closeModalIf(kind) {
      if (modalKind === kind) closeModal();
    }

    /* ---------------- reports ----------------
     *
     * Reporting only. Sending used to happen here, which is why the old panel
     * was called Results and had a Send button on it. A campaign that has
     * never gone out has nothing to report, so it does not appear: an empty
     * stats table for a draft was noise that made the real ones harder to
     * read.
     */

    function reportableCampaigns() {
      return state.campaigns.filter((c) => c.status === 'sent' || c.status === 'sending');
    }

    function renderReports() {
      const box = $('#mmReportsBody');
      if (!box) return;

      const sent = reportableCampaigns();
      if (!sent.length) {
        box.innerHTML = '<div class="mm-card"><div class="mm-card-bd">' +
          '<div class="mm-empty"><h4>Nothing has been sent yet</h4>' +
          '<div>Once a campaign goes out, its opens, clicks, bounces and unsubscribes ' +
          'show up here.</div></div></div></div>';
        return;
      }

      // A picker plus one open report, rather than a modal per campaign. The
      // point of this screen is comparing sends, which a modal actively works
      // against.
      const picker = `
        <div class="mm-filters">
          ${sent.map((c) => `
            <button class="mm-filt" data-report="${esc(c.id)}"
              aria-pressed="${state.reportId === c.id}">${esc(c.subject || c.id)}</button>`).join('')}
        </div>`;

      box.innerHTML = picker + '<div id="mmReportDetail"></div>';
      box.querySelectorAll('[data-report]').forEach((b) => {
        b.addEventListener('click', () => showReport(b.dataset.report));
      });

      // Default to the most recent send rather than making someone pick
      // before they can see anything.
      const want = state.reportId && sent.some((c) => c.id === state.reportId)
        ? state.reportId : sent[0].id;
      showReport(want);
    }

    async function showReport(id) {
      state.reportId = id;
      const box = $('#mmReportDetail');
      if (!box) return;
      box.innerHTML = '<div class="mm-card"><div class="mm-card-bd">Loading...</div></div>';
      root.querySelectorAll('[data-report]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.report === id));
      });

      let d;
      try {
        d = await api.get(ENDPOINTS.mmCampaigns, { id });
      } catch (e) {
        box.innerHTML = `<div class="mm-card"><div class="mm-card-bd">
          <div class="mm-err">Could not load this report: ${esc(e.message)}</div></div></div>`;
        return;
      }

      const r = d.results || {};
      const s = r.stats || {};
      const rates = r.rates || {};
      const warnings = r.warnings || [];
      const c = d.campaign || {};

      box.innerHTML = `
        <div class="mm-card">
          <div class="mm-card-hd">
            <h3>${esc(c.subject || '')}</h3>
            <span class="meta">${esc(c.id)} \u00b7 ${
              c.status === 'sent' ? 'sent ' + esc(fmtDate(c.sentAt))
                : `sending, ${d.sendPlan && d.sendPlan.queueRemaining != null
                    ? d.sendPlan.queueRemaining : '?'} left`}</span>
          </div>
          <div class="mm-card-bd">
            ${warnings.map((w) =>
              `<div class="mm-notice ${w.level === 'danger' ? 'danger' : ''}">${esc(w.text)}</div>`).join('')}
            <div class="mm-stat-row">
              <div class="mm-stat"><div class="v">${d.recipientCount}</div><div class="l">Recipients</div></div>
              <div class="mm-stat"><div class="v">${s.delivered || 0}</div><div class="l">Delivered</div></div>
              <div class="mm-stat"><div class="v">${s.replies || 0}</div><div class="l">Replies</div></div>
              <div class="mm-stat"><div class="v">${s.uniqueClicks || 0}</div><div class="l">Clicked (${pct(rates.clickRate || 0)})</div></div>
              <div class="mm-stat"><div class="v">${s.bounces || 0}</div><div class="l">Bounced (${pct(rates.bounceRate || 0)})</div></div>
              <div class="mm-stat"><div class="v">${s.complaints || 0}</div><div class="l">Complaints</div></div>
              <div class="mm-stat"><div class="v">${s.unsubscribes || 0}</div><div class="l">Unsubscribes</div></div>
            </div>
            <div class="hint" style="margin-bottom:14px;font-size:12px;color:var(--faint)">
              Replies and clicks lead here on purpose. Rates use UNIQUE people over
              delivered, so ${s.clicks || 0} total clicks from ${s.uniqueClicks || 0}
              people cannot inflate the figure.
            </div>
            <details style="margin-bottom:14px">
              <summary style="cursor:pointer;font-size:12.5px;color:var(--muted);font-weight:600">
                Opens (${s.uniqueOpens || 0}, ${pct(rates.openRate || 0)}), and why these are unreliable
              </summary>
              <div class="hint" style="margin-top:8px">${esc(r.openRateCaveat || '')}</div>
            </details>
            ${(r.links || []).length ? `
              <h3 style="font-size:13px;font-weight:700;margin-bottom:8px">Links</h3>
              <table class="mm-table">
                <thead><tr><th>URL</th><th class="num">Clicks</th><th class="num">Unique</th></tr></thead>
                <tbody>${r.links.map((l) => `
                  <tr><td class="em">${esc(l.url)}</td>
                      <td class="num">${l.clicks}</td>
                      <td class="num">${l.uniqueClicks}</td></tr>`).join('')}</tbody>
              </table>` : ''}
          </div>
        </div>`;
    }

    /* ---------------- settings ----------------
     *
     * Three tabs instead of one form of two dozen fields covering four
     * unrelated subjects. Reorder timing is no longer here at all: it moved
     * to BackBone, because it describes the customer rather than the email.
     */

    const SETTINGS_TABS = [
      ['brands', 'Brands and sending'],
      ['compliance', 'Legal and identity'],
      ['limits', 'Limits and pacing']
    ];

    function renderSettingsTabs() {
      const box = $('#mmSettingsTabs');
      if (!box) return;
      box.innerHTML = SETTINGS_TABS.map(([k, label]) => `
        <button class="mm-tab" data-settab="${k}" role="tab"
          aria-selected="${state.settingsTab === k}">${esc(label)}</button>`).join('');
      box.querySelectorAll('[data-settab]').forEach((b) => {
        b.addEventListener('click', () => {
          // Read what is on screen before switching, so half-typed edits in
          // one tab are not lost by looking at another.
          collectSettingsInto(state.settings);
          state.settingsTab = b.dataset.settab;
          renderSettingsTabs(); renderSettings();
        });
      });
    }

    function renderBlockers() {
      const box = $('#mmBlockers');
      if (!box) return;
      if (!state.blockers || !state.blockers.length) {
        // Report ACTUAL readiness rather than a standing reminder. Once a
        // domain verifies and its from-address is filled in there is nothing
        // left to do, and a notice that still says otherwise is worse than no
        // notice: it makes a working setup look broken.
        const idents = (state.settings && state.settings.identities) || [];
        const statusFor = (key) => {
          const d = (state.domains && Array.isArray(state.domains.domains))
            ? state.domains.domains.find((x) => x.key === key) : null;
          return d ? d.status : null;
        };
        const ready = idents.filter((i) => (i.fromAddress || '').trim() && statusFor(i.key) === 'verified');
        const notReady = idents.filter((i) => !ready.includes(i));

        if (ready.length) {
          box.innerHTML = '<div class="mm-notice good"><b>Ready to send.</b> ' +
            esc(ready.map((i) => `${i.label} (${i.domain})`).join(', ')) +
            (ready.length === 1 ? ' is verified with a from-address set.' : ' are verified with from-addresses set.') +
            (notReady.length
              ? ' Still waiting on: ' + esc(notReady.map((i) => i.label || i.domain).join(', ')) + '.'
              : '') + '</div>';
        } else {
          box.innerHTML = '<div class="mm-notice"><b>CAN-SPAM basics look complete.</b> ' +
            'No brand is ready yet: each one needs a from-address and a verified domain ' +
            'in Resend. See Brands and sending.</div>';
        }
        return;
      }
      // Hard blockers, not suggestions. CAN-SPAM requires a real postal
      // address and a working opt-out in every commercial message.
      box.innerHTML = '<div class="mm-notice danger"><b>Not legal to send yet.</b> ' +
        'Every commercial email needs these, and they are missing:<ul style="margin:8px 0 0 18px">' +
        state.blockers.map((b) => `<li>${esc(b.text)}</li>`).join('') + '</ul></div>';
    }

    // Live Resend lookup, so status reflects real DNS rather than something
    // the app cached.
    function renderWebhookStatus() {
      const d = state.domains || {};
      const hb = d.webhook;

      if (!d.webhookConfigured) {
        return `<div class="mm-notice danger">
          <b>Delivery and open tracking is off.</b> MAILME_WEBHOOK_SECRET is not set in
          Vercel, so every callback from Resend is rejected. Reports will stay at zero
          even on a send that worked.</div>`;
      }
      if (!hb) {
        return `<div class="mm-notice danger">
          <b>No webhook call has ever been received.</b> Nothing has reached this app at
          all, not even a rejected call.
          <br><span class="mm-hint">Test it yourself: open your webhook URL
          (<code>/api/mailme/webhook?secret=YOUR_SECRET</code>) in a browser tab. If it
          answers "reachable", the URL and secret are right and the provider is the
          problem. If it does not, the URL or the secret is wrong.</span></div>`;
      }
      // A passing browser test proves the endpoint works but says nothing
      // about whether the provider is calling it, so it must not read as
      // success.
      if (hb.test && hb.ok) {
        return `<div class="mm-notice">
          <b>Endpoint reachable, but no provider events yet.</b> Your browser test at
          ${esc(fmtDateTime(hb.at))} passed, so the URL and secret are correct. Resend
          still has not sent a real event. Check the webhook is Enabled in Resend and
          subscribed to email.delivered, then send a test.</div>`;
      }
      if (hb.ok === false) {
        return `<div class="mm-notice danger">
          <b>Webhook calls are being rejected.</b> ${esc(hb.reason || 'The secret did not match.')}
          <br><span class="mm-hint">Last attempt ${esc(fmtDateTime(hb.at))}.</span></div>`;
      }
      const detail = hb.reason
        ? `<br><span class="mm-hint">${esc(hb.reason)}</span>`
        : `<br><span class="mm-hint">${hb.stored} event${hb.stored === 1 ? '' : 's'} recorded${
            (hb.types && hb.types.length) ? ': ' + esc(hb.types.join(', ')) : ''}.</span>`;
      return `<div class="mm-notice good">
        <b>Webhook working.</b> Last call ${esc(fmtDateTime(hb.at))}.${detail}</div>`;
    }

    function renderIdentityRow(identity, idx) {
      const byKey = (state.domains && Array.isArray(state.domains.domains))
        ? state.domains.domains.find((d) => d.key === identity.key) : null;
      const status = byKey && byKey.status
        ? byKey.status
        : (state.domains && state.domains.configured ? 'not_added' : 'unknown');
      const meta = {
        verified:    { cls: 'ok',   text: 'Verified, ready to send' },
        pending:     { cls: 'warn', text: 'Pending, waiting on DNS propagation' },
        not_started: { cls: 'warn', text: 'Added in Resend, DNS not yet added' },
        not_added:   { cls: 'bad',  text: 'Not added to Resend yet' },
        failed:      { cls: 'bad',  text: 'Verification failed, check the DNS records' },
        unknown:     { cls: 'mute', text: 'Connect a provider to check status' }
      }[status] || { cls: 'mute', text: status };

      return `
        <div class="mm-ident" data-ident-idx="${idx}"
             style="border:1px solid var(--line-soft);border-radius:8px;padding:12px;margin-bottom:10px">
          <div class="mm-row">
            <div class="mm-field"><label>Name</label>
              <input data-ident="label" type="text" value="${esc(identity.label || '')}"
                     placeholder="PM Apparel"></div>
            <div class="mm-field"><label>Domain</label>
              <input data-ident="domain" type="text" value="${esc(identity.domain || '')}"
                     placeholder="pmapparel.com"></div>
          </div>
          <div class="mm-field"><label>From-address</label>
            <input data-ident="fromAddress" type="text" value="${esc(identity.fromAddress || '')}"
                   placeholder="PM Apparel &lt;hello@${esc(identity.domain || 'example.com')}&gt;">
            <div class="hint">Must be an address at this domain. A bare address is fine:
              the name above is used as the sender name.</div></div>
          <div class="mm-row" style="align-items:center">
            <div class="mm-field">
              <label style="font-weight:400">
                <input data-ident="default" type="radio" name="mmIdentDefault"${identity.default ? ' checked' : ''}>
                Default for new campaigns</label>
              <label style="font-weight:400">
                <input data-ident="cold" type="checkbox"${identity.cold ? ' checked' : ''}>
                Use for cold outreach</label>
            </div>
            <div class="mm-field" style="max-width:280px;text-align:right">
              <span class="pill ${meta.cls}">${esc(meta.text)}</span><br>
              <button class="mm-btn ghost sm" data-ident-remove="${idx}" style="margin-top:6px">Remove</button>
            </div>
          </div>
        </div>`;
    }

    function renderSettings() {
      const box = $('#mmSettingsForm');
      if (!box) return;
      const st = state.settings;
      if (!st) { box.innerHTML = '<div class="mm-empty">Could not load settings.</div>'; return; }

      const a = st.postalAddress || {};
      const p = st.policy || {};

      if (state.settingsTab === 'brands') {
        box.innerHTML = `
          <div class="mm-card">
            <div class="mm-card-hd"><h3>Sending brands</h3>
              <span class="meta">One per business</span></div>
            <div class="mm-card-bd">
              <div class="mm-hint" style="margin-bottom:12px">
                Each business sends as itself. A brand needs a from-address AND a verified
                domain in Resend before it can send. Status below is checked against Resend
                directly, so it reflects real DNS rather than a guess. Campaigns pick their
                brand automatically from the audience, and you can override it.
              </div>
              <div id="mmIdentityList">
                ${(st.identities || []).map((i, idx) => renderIdentityRow(i, idx)).join('')}
              </div>
              <div class="mm-actions" style="margin-bottom:14px">
                <button class="mm-btn ghost sm" id="mmAddIdentity">Add another brand</button>
              </div>
              ${!state.domains || !state.domains.configured ? `<div class="mm-notice danger">
                <b>No provider connected yet.</b> RESEND_API_KEY needs to be set in Vercel
                before anything can send, regardless of what is filled in above.</div>` : ''}
              ${renderWebhookStatus()}
              ${(st.identities || []).some((i) => i.cold) ? '' : `<div class="mm-notice">
                <b>No brand is marked for cold outreach.</b> Campaigns to imported prospects
                will warn until one is. Cold email draws complaints at rates a customer list
                never does, and reputation is scored per domain, so it is worth keeping cold
                traffic off a domain that also sends quotes and invoices.</div>`}
              <div class="mm-actions">
                <button class="mm-btn" id="mmSaveSettings">Save</button>
              </div>
            </div>
          </div>`;
      } else if (state.settingsTab === 'compliance') {
        box.innerHTML = `
          <div class="mm-card">
            <div class="mm-card-hd"><h3>Who the email is from</h3>
              <span class="meta">Shown in the inbox</span></div>
            <div class="mm-card-bd">
              <div class="mm-row">
                <div class="mm-field"><label for="setCompany">Company name</label>
                  <input id="setCompany" type="text" value="${esc(st.companyName || '')}"></div>
                <div class="mm-field"><label for="setFromName">From name</label>
                  <input id="setFromName" type="text" value="${esc(st.fromName || '')}"
                    placeholder="P&amp;M Apparel">
                  <div class="hint">A person's name beside the shop's usually outperforms
                    the shop alone.</div></div>
              </div>
              <div class="mm-row">
                <div class="mm-field"><label for="setReplyMode">Replies go to</label>
                  <select id="setReplyMode">
                    <option value="account-manager"${st.replyToMode === 'account-manager' ? ' selected' : ''}>The account manager</option>
                    <option value="fixed"${st.replyToMode === 'fixed' ? ' selected' : ''}>One fixed address</option>
                  </select>
                  <div class="hint">BackBone already knows who owns each account, so replies
                    can land with the right person automatically.</div></div>
                <div class="mm-field"><label style="font-weight:400">
                    <input id="setFromAM" type="checkbox"${st.fromNameIncludesAM !== false ? ' checked' : ''}>
                    Add the account manager's name to the sender name</label>
                  <div class="hint">Shows as "P&amp;M Apparel - Alexis" in the inbox. Contacts
                    with no account manager just see the brand name. The email address itself
                    never changes.</div></div>
              </div>
              <div class="mm-row">
                <div class="mm-field"><label for="setReplyDomain">Account manager email domain</label>
                  <input id="setReplyDomain" type="text" value="${esc(st.replyToDomain || '')}"
                         placeholder="pmapparel.com">
                  <div class="hint">Replies go to firstname@ this domain, taken from the
                    account manager on each contact.</div></div>
                <div class="mm-field"><label for="setReplyFixed">Fixed reply-to</label>
                  <input id="setReplyFixed" type="text" value="${esc(st.replyToFixed || '')}"
                    placeholder="hello@pmapparel.com">
                  <div class="hint">Used when the mode above is fixed, or when an account has
                    no manager. Must be a monitored inbox: cold outreach gets replies.</div></div>
              </div>
            </div>
          </div>

          <div class="mm-card">
            <div class="mm-card-hd"><h3>What the law requires</h3>
              <span class="meta">Nothing sends until these are filled in</span></div>
            <div class="mm-card-bd">
              <div class="mm-field"><label for="setUnsub">Unsubscribe page URL</label>
                <input id="setUnsub" type="text" value="${esc(st.unsubscribeUrl || '')}"
                  placeholder="https://alliteration-eight.vercel.app/unsubscribe.html">
                <div class="hint">The public page, already built and deployed at
                  /unsubscribe.html. Paste its full address here.</div></div>
              <div class="mm-hint" style="margin-bottom:10px">
                A real postal address is required by CAN-SPAM in every commercial email.
                It is the most commonly missed requirement, which is why nothing can send
                until it is here.
              </div>
              <div class="mm-row">
                <div class="mm-field"><label for="setLine1">Street</label>
                  <input id="setLine1" type="text" value="${esc(a.line1 || '')}"></div>
                <div class="mm-field"><label for="setLine2">Suite / unit</label>
                  <input id="setLine2" type="text" value="${esc(a.line2 || '')}"></div>
              </div>
              <div class="mm-row">
                <div class="mm-field"><label for="setCity">City</label>
                  <input id="setCity" type="text" value="${esc(a.city || '')}"></div>
                <div class="mm-field"><label for="setState">State</label>
                  <input id="setState" type="text" value="${esc(a.state || '')}"></div>
              </div>
              <div class="mm-field" style="max-width:220px"><label for="setZip">ZIP</label>
                <input id="setZip" type="text" value="${esc(a.postalCode || '')}"></div>
              ${state.footerPreview ? `<div class="mm-field"><label>Footer preview</label>
                <div class="mm-recip" style="white-space:pre-wrap">${esc(state.footerPreview)}</div></div>` : ''}
              <div class="mm-actions">
                <button class="mm-btn" id="mmSaveSettings">Save</button>
              </div>
            </div>
          </div>`;
      } else {
        box.innerHTML = `
          <div class="mm-card">
            <div class="mm-card-hd"><h3>Limits and pacing</h3>
              <span class="meta">Protects the sending domains</span></div>
            <div class="mm-card-bd">
              <div class="mm-hint" style="margin-bottom:12px">
                A new sending domain going from zero to hundreds of cold emails a day is
                itself a spam signal, so the cold cap climbs over the ramp period.
                Today's cold cap: <b>${state.coldCapToday}</b>.
              </div>
              <div class="mm-row">
                <div class="mm-field"><label for="setFreq">Days between emails to one person</label>
                  <input id="setFreq" type="number" min="0" value="${p.minDaysBetweenEmails}">
                  <div class="hint">Stops the same contact getting three campaigns in a week
                    because they match three lists.</div></div>
                <div class="mm-field"><label for="setClientCap">Client daily cap</label>
                  <input id="setClientCap" type="number" min="1" value="${p.clientDailyCap}"></div>
              </div>
              <div class="mm-row">
                <div class="mm-field"><label for="setColdStart">Cold cap, day one</label>
                  <input id="setColdStart" type="number" min="1" value="${p.coldDailyCapStart}"></div>
                <div class="mm-field"><label for="setColdMax">Cold cap, maximum</label>
                  <input id="setColdMax" type="number" min="1" value="${p.coldDailyCapMax}"></div>
              </div>
              <div class="mm-field" style="max-width:260px"><label for="setRamp">Ramp length (days)</label>
                <input id="setRamp" type="number" min="1" value="${p.coldRampDays}"></div>
              <div class="mm-field">
                <label style="font-weight:400"><input type="checkbox" id="setSkipQuotes"
                  style="width:auto;margin-right:8px"${p.skipOpenQuotes ? ' checked' : ''}>Skip accounts with an open quote</label>
                <div class="hint">Cold-blasting someone an account manager is mid-deal with
                  can cost the deal.</div>
              </div>
              <div class="mm-field">
                <label style="font-weight:400"><input type="checkbox" id="setSkipInvalid"
                  style="width:auto;margin-right:8px"${p.skipInvalidVerification ? ' checked' : ''}>Skip addresses that failed verification</label>
                <div class="hint">Bought lists run 10 to 20% undeliverable, and providers
                  throttle a sender at 2% bounce.</div>
              </div>
              <div class="mm-actions">
                <button class="mm-btn" id="mmSaveSettings">Save</button>
              </div>
            </div>
          </div>

          <div class="mm-card">
            <div class="mm-card-hd"><h3>Reorder timing</h3>
              <span class="meta">Moved to BackBone</span></div>
            <div class="mm-card-bd">
              <div class="mm-hint">
                When a customer counts as due, overdue or lapsed is now set in
                <b>BackBone, under Settings</b>. It describes the customer relationship
                rather than the email, and BackBone is where the roster and the order
                history live. MailMe reads those numbers to build the "due to reorder"
                audience; changing them there changes them here.
              </div>
            </div>
          </div>`;
      }

      const saveBtn = $('#mmSaveSettings');
      if (saveBtn) saveBtn.addEventListener('click', saveSettings);

      const addBtn = $('#mmAddIdentity');
      if (addBtn) addBtn.addEventListener('click', () => {
        // Read what is on screen first so half-typed edits are not lost when
        // the list re-renders with the new blank row appended.
        state.settings.identities = collectIdentities();
        state.settings.identities.push({
          key: 'brand' + Date.now().toString(36),
          label: '', domain: '', fromAddress: '', cold: false, default: false
        });
        renderSettings();
      });

      box.querySelectorAll('[data-ident-remove]').forEach((b) => {
        b.addEventListener('click', () => {
          const idx = Number(b.getAttribute('data-ident-remove'));
          const list = collectIdentities();
          if (list.length <= 1) {
            msg('#mmSettingsMsg', 'You need at least one sending brand.', 'mm-err');
            return;
          }
          list.splice(idx, 1);
          if (!list.some((i) => i.default)) list[0].default = true;
          state.settings.identities = list;
          renderSettings();
        });
      });
    }

    // Reads the identity rows straight out of the DOM. Keys are preserved
    // from the rendered row rather than regenerated, so a campaign pointing
    // at a brand keeps pointing at it across an edit.
    function collectIdentities() {
      const rows = Array.from(root.querySelectorAll('.mm-ident'));
      const existing = (state.settings && state.settings.identities) || [];
      if (!rows.length) return existing;
      return rows.map((row, idx) => {
        const get = (name) => row.querySelector('[data-ident="' + name + '"]');
        const prior = existing[idx] || {};
        const label = (get('label').value || '').trim();
        const domain = (get('domain').value || '').trim().toLowerCase();
        return {
          key: prior.key || ('brand' + idx),
          label: label || domain || prior.key || ('Brand ' + (idx + 1)),
          domain,
          fromAddress: (get('fromAddress').value || '').trim(),
          cold: !!get('cold').checked,
          default: !!get('default').checked
        };
      }).filter((i) => i.domain);
    }

    // Settings are split across tabs now, so a save must only send the fields
    // actually on screen. Sending an absent field as undefined would blank it
    // server-side, which is exactly how a tabbed form quietly eats data.
    function collectSettingsInto(target) {
      if (!target) return target;
      const val = (id) => { const el = $('#' + id); return el ? el.value : undefined; };
      const chk = (id) => { const el = $('#' + id); return el ? el.checked : undefined; };
      const numv = (id) => { const el = $('#' + id); return el ? Number(el.value) : undefined; };

      if ($('#mmIdentityList')) target.identities = collectIdentities();

      if ($('#setCompany')) {
        target.companyName = val('setCompany');
        target.fromName = val('setFromName');
        target.replyToMode = val('setReplyMode');
        target.replyToFixed = val('setReplyFixed');
        target.replyToDomain = val('setReplyDomain');
        target.fromNameIncludesAM = chk('setFromAM');
        target.unsubscribeUrl = val('setUnsub');
        target.postalAddress = {
          line1: val('setLine1'), line2: val('setLine2'), city: val('setCity'),
          state: val('setState'), postalCode: val('setZip')
        };
      }

      if ($('#setFreq')) {
        target.policy = {
          ...(target.policy || {}),
          minDaysBetweenEmails: numv('setFreq'),
          clientDailyCap: numv('setClientCap'),
          coldDailyCapStart: numv('setColdStart'),
          coldDailyCapMax: numv('setColdMax'),
          coldRampDays: numv('setRamp'),
          skipOpenQuotes: chk('setSkipQuotes'),
          skipInvalidVerification: chk('setSkipInvalid')
        };
      }
      return target;
    }

    async function saveSettings() {
      const payload = collectSettingsInto({});
      try {
        const d = await api.patch(ENDPOINTS.mmSettings, payload);
        state.settings = d.settings;
        state.blockers = d.blockers || [];
        state.footerPreview = d.footerPreview || '';
        renderBlockers(); renderSettings();
        msg('#mmSettingsMsg', 'Settings saved.', 'mm-ok');
      } catch (e) {
        msg('#mmSettingsMsg', 'Could not save: ' + esc(e.message), 'mm-err');
      }
    }

    /* ---------------- refresh ----------------
     *
     * WHY THIS EXISTS. mount() runs once; showView() runs on every visit. If
     * the view renders only repaint whatever mount() loaded, the numbers rot:
     * tag a contact, come back to a list, and it still shows its old member
     * count. Worse, a list created on Audience would be missing from the
     * campaign audience picker until the whole app was remounted, which looks
     * like the save silently failed.
     *
     * So each view REFETCHES what it shows on entry, and there is a manual
     * Refresh alongside a stamp saying how current the numbers are. Same
     * reasoning as BackBone's "Data through" stamp: a number with no
     * freshness indicator gets trusted long after it stopped being true.
     */

    const VIEW_LOADERS = {
      // The audience picker is built from lists, and the readiness check
      // needs settings, so a campaign screen needs all four.
      campaigns: [loadContacts, loadLists, loadCampaigns, loadSettings],
      audience: [loadContacts, loadLists],
      reports: [loadCampaigns],
      settings: [loadSettings]
    };

    function stampText() {
      if (!state.lastLoaded) return '';
      const secs = Math.round((Date.now() - state.lastLoaded) / 1000);
      if (secs < 45) return 'Updated just now';
      const mins = Math.round(secs / 60);
      if (mins < 60) return 'Updated ' + mins + ' min ago';
      return 'Updated ' + new Date(state.lastLoaded).toLocaleTimeString();
    }

    function paintStamps() {
      root.querySelectorAll('[data-mm-stamp]').forEach((el) => {
        el.textContent = state.refreshing ? 'Refreshing...' : stampText();
      });
      root.querySelectorAll('[data-mm-refresh]').forEach((b) => {
        b.disabled = state.refreshing;
      });
    }

    // Repaint a view from whatever is already in state, without fetching.
    const REPAINT = {
      campaigns: () => {
        renderHealth();
        renderCampaignList();
        // Do NOT rebuild the workspace while someone is typing in it: it
        // rebuilds its inputs from state and would move the cursor.
        if (!state.editingCampaign) renderComposer();
      },
      audience: () => {
        renderFilters(); renderListRail(); renderContactsTable();
      },
      reports: () => renderReports(),
      settings: () => { renderBlockers(); renderSettingsTabs(); renderSettings(); }
    };

    async function refreshView(view, opts) {
      const loaders = VIEW_LOADERS[view] || [];
      // Repaint immediately so switching views feels instant, then update
      // once the fetch lands.
      if (REPAINT[view]) REPAINT[view]();

      if (!loaders.length || state.refreshing) { paintStamps(); return; }

      state.refreshing = true;
      paintStamps();
      try {
        await Promise.all(loaders.map((fn) => fn()));
        state.lastLoaded = Date.now();
        if (REPAINT[view]) REPAINT[view]();
        if (opts && opts.announce) msg(opts.announce, 'Refreshed.', 'mm-ok');
      } catch (e) {
        // A failed refresh must not blank the screen: the previous numbers
        // are stale but still better than nothing, and the stamp says so.
        if (opts && opts.announce) {
          msg(opts.announce, 'Could not refresh: ' + esc(e.message), 'mm-err');
        }
      } finally {
        state.refreshing = false;
        paintStamps();
      }
    }
    this._refreshView = refreshView;

    /* ---------------- wiring that lives on the page ---------------- */

    $('#mmNewCampaign').addEventListener('click', () => {
      const d = {
        subject: '', preheader: '', body: '',
        source: 'client', listId: null, segmentTags: [], status: 'draft'
      };
      d.identityKey = defaultIdentityFor(d);
      state.editingCampaign = d;
      state.composerDetail = null;
      renderComposer();
      msg('#mmCampaignMsg', '', '');
    });

    $('#mmNewList').addEventListener('click', () => {
      state.editingList = {
        name: '', kind: 'dynamic',
        rule: { source: '', tags: [], tagMatch: 'any', search: '' }
      };
      renderListEditor();
      msg('#mmAudienceMsg', '', '');
    });

    // The current filters ARE a rule, so making someone re-enter them in the
    // list editor would be asking twice for the same thing.
    $('#mmSaveAsList').addEventListener('click', () => {
      state.editingList = {
        name: '',
        kind: 'dynamic',
        rule: {
          source: state.source === 'all' ? '' : state.source,
          tags: [],
          tagMatch: 'any',
          search: state.search.trim()
        }
      };
      renderListEditor();
    });

    $('#mmImportBtn').addEventListener('click', openImport);

    root.querySelectorAll('[data-mm-refresh]').forEach((b) => {
      b.addEventListener('click', () => {
        const view = b.dataset.mmRefresh;
        refreshView(view, { announce: MSG_TARGET[view] });
      });
    });

    /* ---------------- boot ---------------- */

    try {
      await Promise.all([loadContacts(), loadLists(), loadCampaigns(), loadSettings()]);
    } catch (e) {
      msg('#mmCampaignMsg', 'Could not load MailMe: ' + esc(e.message), 'mm-err');
    }

    renderHealth();
    renderCampaignList();
    renderComposer();
    renderFilters();
    renderListRail();
    renderContactsTable();
    renderSettingsTabs();
    renderBlockers();
    renderSettings();

    // Keep the stamp honest while someone sits on a screen: the text is
    // relative ("2 min ago"), so it has to tick even when nothing refetches.
    this._stampTimer = setInterval(paintStamps, 30000);

    state.lastLoaded = Date.now();
    paintStamps();

    // Exposed so showView() can refresh and repaint a pane on each visit
    // without re-running mount(), matching TravelTrack's pattern.
    this._renders = {
      campaigns: () => refreshView('campaigns'),
      audience: () => refreshView('audience'),
      reports: () => refreshView('reports'),
      settings: () => refreshView('settings')
    };
  },

  showView(view) {
    const root = this._root;
    if (!root) return;
    // Modals are attached to <body>, so they do not disappear on their own
    // when the view changes. Closing one here stops an overlay being
    // stranded over a screen it has nothing to do with.
    if (this._closeModal) this._closeModal();
    const ids = {
      campaigns: 'mmCampaignsView',
      audience: 'mmAudienceView',
      reports: 'mmReportsView',
      settings: 'mmSettingsView'
    };
    Object.entries(ids).forEach(([v, id]) => {
      const el = root.querySelector('#' + id);
      if (el) el.hidden = v !== view;
    });
    if (this._renders && this._renders[view]) this._renders[view]();
  },

  unmount() {
    // The stamp ticker is a real interval and would keep firing against a
    // detached root forever.
    if (this._stampTimer) {
      clearInterval(this._stampTimer);
      this._stampTimer = null;
    }
    // A modal registers a document-level Escape handler. Closing it removes
    // that listener as well as the node.
    if (this._closeModal) {
      this._closeModal();
      this._closeModal = null;
    }
  }
};
