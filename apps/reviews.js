// PUT IN: apps/reviews.js
/**
 * apps/reviews.js: RaveReviews (PROVISIONAL NAME).
 *
 * The Google review request that goes to a customer three days after their
 * order is picked up or shipped. Replaces two Printavo automations feeding a
 * Zapier zap. The id is `reviews` so the name can change without touching
 * storage keys, routes or saved links.
 *
 * Three views:
 *   requests   every request: waiting, sent, skipped (with the reason),
 *              cancelled, failed. Cancel, Restore, Send now, Left a review.
 *   reviewed   customers who have left a review. They are never asked again.
 *   settings   the on/off switch, the email text, and two checks: a test
 *              email to yourself, and "what would Printavo give us right now".
 *
 * Admin only, enforced in api/reviews/*.js on the Admin flag. Every call goes
 * through ctx.api and ENDPOINTS, and tokens.css owns every colour.
 */

import { ENDPOINTS } from '../js/api.js';
import { DEFAULT_SETTINGS, PLACEHOLDERS, renderEmail } from '../lib/reviews/schema.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function day(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

const STATUS_LABEL = {
  queued: 'Waiting', sent: 'Sent', skipped: 'Skipped', cancelled: 'Cancelled', failed: 'Failed'
};

export default {
  id: 'reviews',

  styles: `
  .rv-wrap{max-width:1180px}
  .rv-hd{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:16px}
  .rv-hd h1{font-size:24px;font-weight:800;letter-spacing:-.02em;margin:0}
  .rv-hd .sub{font-size:13px;color:var(--muted);margin-top:3px;max-width:64ch}
  .rv-pane[hidden]{display:none}

  .rv-btn{border:1px solid var(--line);background:var(--card);color:var(--ink);font-family:inherit;
    font-size:12.5px;font-weight:600;padding:7px 12px;border-radius:var(--radius-sm);cursor:pointer}
  .rv-btn:hover{border-color:var(--muted)}
  .rv-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
  .rv-btn.primary:hover{background:var(--accent-deep)}
  .rv-btn.danger{color:var(--danger);border-color:var(--danger-line)}
  .rv-btn.small{padding:4px 9px;font-size:11.5px}
  .rv-btn:disabled{opacity:.5;cursor:default}

  .rv-msg{font-size:12.5px;border-radius:var(--radius-sm);padding:9px 11px;margin-bottom:14px}
  .rv-msg.err{background:var(--danger-tint);color:var(--danger)}
  .rv-msg.ok{background:var(--success-tint);color:var(--success-dk)}
  .rv-msg.warn{background:var(--warn-tint);color:var(--warn-dk)}

  .rv-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:16px}
  .rv-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);padding:11px 13px}
  .rv-card .k{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
  .rv-card .v{font-size:14px;font-weight:700;margin-top:3px}
  .rv-card .d{font-size:12px;color:var(--muted);margin-top:2px}
  .rv-on{color:var(--success-dk)}
  .rv-off{color:var(--warn-dk)}
  .rv-bad{color:var(--danger)}

  .rv-bar{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}
  .rv-chip{border:1px solid var(--line);background:var(--card);color:var(--muted);font-family:inherit;
    font-size:11.5px;font-weight:600;padding:5px 11px;border-radius:999px;cursor:pointer}
  .rv-chip[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
  .rv-chip .ct{opacity:.75;margin-left:5px;font-weight:500}

  .rv-tablewrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm)}
  table.rv-t{width:100%;border-collapse:collapse;font-size:13px}
  .rv-t th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);
    padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
  .rv-t td{padding:9px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top}
  .rv-t tr:last-child td{border-bottom:0}
  .rv-t .muted{color:var(--muted);font-size:12px}
  .rv-t .acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
  .rv-empty{padding:28px;text-align:center;color:var(--muted)}

  .rv-pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;
    background:var(--line-soft);color:var(--muted)}
  .rv-pill.queued{background:var(--accent-tint);color:var(--accent-deep)}
  .rv-pill.sent{background:var(--success-tint);color:var(--success-dk)}
  .rv-pill.failed{background:var(--danger-tint);color:var(--danger)}
  .rv-pill.skipped{background:var(--warn-tint);color:var(--warn-dk)}

  .rv-form{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);padding:16px;margin-bottom:16px}
  .rv-form h2{font-size:15px;margin:0 0 10px}
  .rv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
  .rv-field label{display:block;font-size:12px;font-weight:600;margin-bottom:4px}
  .rv-field .hint{font-size:11.5px;color:var(--muted);margin-top:3px}
  .rv-field input[type="text"],.rv-field input[type="email"],.rv-field input[type="number"],.rv-field textarea{
    width:100%;box-sizing:border-box;font-family:inherit;font-size:13px;padding:7px 9px;
    border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card);color:var(--ink)}
  .rv-field textarea{min-height:320px;line-height:1.5}
  .rv-field textarea.short{min-height:60px}
  .rv-switch{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:700}
  .rv-switch input{width:18px;height:18px}
  .rv-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
  .rv-preview{white-space:pre-wrap;font-size:13px;line-height:1.5;background:var(--line-soft);
    border-radius:var(--radius-sm);padding:12px;margin-top:8px}
  .rv-preview .subj{font-weight:700;margin-bottom:8px}
  .rv-code{font-family:ui-monospace,Menlo,monospace;font-size:12px}
  `,

  template: `
    <div class="rv-wrap">
      <div class="rv-hd">
        <div>
          <h1>RaveReviews</h1>
          <div class="sub">The Google review request that goes out after an order is picked up or shipped. Customers who have left a review are never asked again.</div>
        </div>
      </div>
      <div id="rvMsg"></div>

      <section class="rv-pane" data-pane="requests">
        <div class="rv-strip" id="rvStrip"></div>
        <div class="rv-bar" id="rvBar"></div>
        <div class="rv-tablewrap" id="rvTable"><div class="rv-empty">Loading…</div></div>
      </section>

      <section class="rv-pane" data-pane="reviewed" hidden>
        <div class="rv-form">
          <h2>Mark a customer as reviewed</h2>
          <div class="rv-row" style="margin-top:0">
            <input type="email" id="rvRevEmail" placeholder="customer@example.com" class="rv-code" />
            <button class="rv-btn primary" id="rvRevAdd">Add</button>
          </div>
          <div class="muted" style="margin-top:8px;font-size:12px">Google does not tell us who left a review, only a display name, so this list is kept by hand. You can also mark someone from a Sent row on Requests.</div>
        </div>
        <div class="rv-tablewrap" id="rvRevTable"><div class="rv-empty">Loading…</div></div>
      </section>

      <section class="rv-pane" data-pane="settings" hidden>
        <div id="rvSettings"><div class="rv-empty">Loading…</div></div>
      </section>
    </div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);
    const api = ctx.api;

    let records = [];
    let filter = 'queued';
    let listMeta = {};
    let settingsData = null;
    let current = 'requests';

    function flash(text, kind) {
      const el = $('#rvMsg');
      if (!text) { el.innerHTML = ''; return; }
      el.innerHTML = `<div class="rv-msg ${kind || 'ok'}">${esc(text)}</div>`;
    }

    const errText = (e) => (e && e.message) || String(e);

    /* ---------------- requests ---------------- */

    async function loadRequests() {
      try {
        const r = await api.get(ENDPOINTS.rvRequests);
        records = (r && r.records) || [];
        listMeta = r || {};
        renderStrip();
        renderBar();
        renderTable();
      } catch (e) {
        $('#rvTable').innerHTML = `<div class="rv-empty">${esc(errText(e))}</div>`;
      }
    }

    function renderStrip() {
      const m = listMeta;
      const c = m.lastCheck;
      const s = m.lastSend;
      const checkLine = !c ? '<div class="v">Not run yet</div><div class="d">Runs four times a day during business hours</div>'
        : c.error ? `<div class="v rv-bad">Failed</div><div class="d">${esc(when(c.at))}: ${esc(c.error)}</div>`
        : `<div class="v">${esc(when(c.at))}</div><div class="d">${c.found} at those statuses, ${c.queued} newly queued${c.complete ? '' : ', still working through the list'}${(c.missingStatuses || []).length ? '. Not found in Printavo: ' + esc(c.missingStatuses.join(', ')) : ''}</div>`;
      const sendLine = !s ? '<div class="v">Nothing sent yet</div>'
        : s.error ? `<div class="v rv-bad">Failed</div><div class="d">${esc(when(s.at))}: ${esc(s.error)}</div>`
        : !s.enabled ? `<div class="v">${esc(when(s.at))}</div><div class="d">Sending was off</div>`
        : `<div class="v">${esc(when(s.at))}</div><div class="d">${s.sent} sent, ${s.skipped} skipped${s.errors && s.errors.length ? ', ' + s.errors.length + ' errors' : ''}</div>`;
      $('#rvStrip').innerHTML = `
        <div class="rv-card"><div class="k">Sending</div>
          <div class="v ${m.enabled ? 'rv-on' : 'rv-off'}">${m.enabled ? 'On' : 'Off'}</div>
          <div class="d">${m.enabled ? 'Emails go out when they are due' : 'Orders still get queued. Turn it on in Settings.'}</div></div>
        <div class="rv-card"><div class="k">Last Printavo check</div>${checkLine}</div>
        <div class="rv-card"><div class="k">Last send</div>${sendLine}</div>
        ${m.seeded ? '' : '<div class="rv-card"><div class="k">First run</div><div class="v rv-off">Not finished</div><div class="d">The first check records orders already at pickup so nobody gets a late duplicate. Nothing is queued until it finishes.</div></div>'}
      `;
    }

    function renderBar() {
      const counts = listMeta.counts || {};
      const chips = [['queued', 'Waiting'], ['sent', 'Sent'], ['skipped', 'Skipped'], ['cancelled', 'Cancelled'], ['failed', 'Failed'], ['all', 'All']];
      $('#rvBar').innerHTML = chips.map(([k, label]) =>
        `<button class="rv-chip" data-filter="${k}" aria-pressed="${filter === k}">${label}<span class="ct">${counts[k] || 0}</span></button>`
      ).join('');
    }

    function rowActions(r) {
      const b = [];
      if (r.status === 'queued' || r.status === 'failed') {
        b.push(`<button class="rv-btn small primary" data-act="send" data-id="${esc(r.id)}">Send now</button>`);
        b.push(`<button class="rv-btn small danger" data-act="cancel" data-id="${esc(r.id)}">Cancel</button>`);
      }
      if (r.status === 'skipped' || r.status === 'cancelled') {
        b.push(`<button class="rv-btn small" data-act="restore" data-id="${esc(r.id)}">Put back in line</button>`);
        b.push(`<button class="rv-btn small" data-act="send" data-id="${esc(r.id)}">Send now</button>`);
      }
      if (r.email && !r.customer_reviewed && r.status !== 'queued') {
        b.push(`<button class="rv-btn small" data-act="reviewed" data-email="${esc(r.email)}" data-invoice="${esc(r.invoice_id)}">Left a review</button>`);
      }
      return b.join('');
    }

    function renderTable() {
      const list = filter === 'all' ? records : records.filter((r) => r.status === filter);
      if (!list.length) {
        const empty = {
          queued: 'Nothing waiting. Orders show up here after the next Printavo check finds them at pickup or shipped.',
          sent: 'Nothing sent yet.', skipped: 'Nothing skipped.', cancelled: 'Nothing cancelled.', failed: 'No failures.', all: 'No requests yet.'
        };
        $('#rvTable').innerHTML = `<div class="rv-empty">${esc(empty[filter] || 'Nothing here.')}</div>`;
        return;
      }
      const rows = list.map((r) => {
        const whenCol = r.status === 'sent' ? `Sent ${esc(when(r.sent_at))}`
          : r.status === 'queued' ? `Sends ${esc(day(r.send_after))}`
          : r.status === 'skipped' ? `Skipped ${esc(when(r.skipped_at))}`
          : r.status === 'cancelled' ? `Cancelled ${esc(when(r.cancelled_at))}${r.cancelled_by ? ' by ' + esc(r.cancelled_by) : ''}`
          : esc(when(r.detected_at));
        const reason = r.status === 'skipped' ? r.skip_reason
          : (r.status === 'failed' || (r.status === 'queued' && r.last_error)) ? r.last_error : '';
        return `<tr>
          <td><strong>#${esc(r.visual_id)}</strong><div class="muted">${esc(r.order_nickname)}</div></td>
          <td>${esc(r.customer_name || r.first_name || '')}<div class="muted rv-code">${esc(r.email || r.email_raw || 'no email')}</div>
            ${r.customer_reviewed ? '<div class="muted">Has left a review</div>' : ''}</td>
          <td><div class="muted">${esc(r.trigger_status)}</div><div class="muted">Found ${esc(when(r.detected_at))}</div></td>
          <td><span class="rv-pill ${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span>
            <div class="muted">${whenCol}</div>${reason ? `<div class="muted">${esc(reason)}</div>` : ''}</td>
          <td><div class="acts">${rowActions(r)}</div></td>
        </tr>`;
      }).join('');
      $('#rvTable').innerHTML = `<table class="rv-t"><thead><tr>
        <th>Order</th><th>Customer</th><th>Trigger</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    $('#rvBar').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-filter]');
      if (!b) return;
      filter = b.dataset.filter;
      renderBar();
      renderTable();
    });

    async function act(body, btn) {
      if (btn) btn.disabled = true;
      try {
        await api.post(ENDPOINTS.rvRequests, body);
        return { ok: true };
      } catch (e) {
        return { ok: false, err: e };
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    $('#rvTable').addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const a = btn.dataset.act;
      flash('');

      if (a === 'send') {
        let r = await act({ action: 'send', id: btn.dataset.id }, btn);
        // A 409 arrives as a thrown error, so the question is read off the
        // error body, not a response.
        const body = r.err && r.err.body;
        if (!r.ok && body && body.needsConfirm) {
          if (!window.confirm(`This one would normally be skipped: ${body.reason}.\n\nSend it anyway?`)) return;
          r = await act({ action: 'send', id: btn.dataset.id, force: true }, btn);
        }
        if (r.ok) flash('Sent.');
        else flash(errText(r.err), 'err');
      } else if (a === 'cancel') {
        const r = await act({ action: 'cancel', id: btn.dataset.id }, btn);
        if (!r.ok) flash(errText(r.err), 'err');
      } else if (a === 'restore') {
        const r = await act({ action: 'restore', id: btn.dataset.id }, btn);
        if (r.ok) flash('Back in line. It sends on its original date, or at the next run if that has passed.');
        else flash(errText(r.err), 'err');
      } else if (a === 'reviewed') {
        const r = await act({ action: 'reviewed', email: btn.dataset.email, invoiceId: btn.dataset.invoice }, btn);
        if (r.ok) flash(`${btn.dataset.email} will not be asked again.`);
        else flash(errText(r.err), 'err');
      }
      loadRequests();
    });

    /* ---------------- reviewed ---------------- */

    async function loadReviewed() {
      try {
        const r = await api.get(ENDPOINTS.rvRequests, { kind: 'reviewed' });
        const list = (r && r.reviewed) || [];
        if (!list.length) {
          $('#rvRevTable').innerHTML = '<div class="rv-empty">Nobody marked yet.</div>';
          return;
        }
        $('#rvRevTable').innerHTML = `<table class="rv-t"><thead><tr><th>Customer email</th><th>Marked</th><th></th></tr></thead><tbody>${
          list.map((x) => `<tr><td class="rv-code">${esc(x.email)}</td>
            <td class="muted">${esc(when(x.at))}${x.by ? ' by ' + esc(x.by) : ''}</td>
            <td><div class="acts"><button class="rv-btn small" data-unrev="${esc(x.email)}">Remove</button></div></td></tr>`).join('')
        }</tbody></table>`;
      } catch (e) {
        $('#rvRevTable').innerHTML = `<div class="rv-empty">${esc(errText(e))}</div>`;
      }
    }

    $('#rvRevAdd').addEventListener('click', async () => {
      const email = $('#rvRevEmail').value.trim();
      if (!email) return;
      const r = await act({ action: 'reviewed', email }, $('#rvRevAdd'));
      if (r.ok) { $('#rvRevEmail').value = ''; flash(`${email} will not be asked again.`); }
      else flash(errText(r.err), 'err');
      loadReviewed();
    });

    $('#rvRevTable').addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-unrev]');
      if (!b) return;
      const r = await act({ action: 'unreviewed', email: b.dataset.unrev }, b);
      if (!r.ok) flash(errText(r.err), 'err');
      loadReviewed();
    });

    /* ---------------- settings ---------------- */

    async function loadSettings() {
      try {
        settingsData = await api.get(ENDPOINTS.rvSettings);
        renderSettings();
      } catch (e) {
        $('#rvSettings').innerHTML = `<div class="rv-empty">${esc(errText(e))}</div>`;
      }
    }

    function formValues() {
      const v = (id) => $('#' + id).value;
      return {
        enabled: $('#rvEnabled').checked,
        fromName: v('rvFromName'), fromEmail: v('rvFromEmail'), replyTo: v('rvReplyTo'),
        subject: v('rvSubject'), body: v('rvBody'),
        statuses: v('rvStatuses').split('\n').map((x) => x.trim()).filter(Boolean),
        delayDays: Number(v('rvDelay')), repeatGapDays: Number(v('rvGap')),
        lookbackDays: Number(v('rvLookback')), maxPerRun: Number(v('rvMax')),
      };
    }

    function renderPreview() {
      const msg = renderEmail(Object.assign({}, DEFAULT_SETTINGS, formValues()),
        { first_name: 'Tony', visual_id: '54781', order_nickname: 'Sample order' });
      $('#rvPreview').innerHTML = `<div class="subj">${esc(msg.subject)}</div>${esc(msg.text)}`;
    }

    function renderSettings() {
      const s = (settingsData && settingsData.settings) || DEFAULT_SETTINGS;
      const cfg = (settingsData && settingsData.configured) || {};
      const missing = [];
      if (!cfg.resend) missing.push('RESEND_API_KEY');
      if (!cfg.printavo) missing.push('PRINTAVO_API_TOKEN / PRINTAVO_EMAIL');
      if (!cfg.cronSecret) missing.push('CRON_SECRET');

      $('#rvSettings').innerHTML = `
        ${missing.length ? `<div class="rv-msg err">Missing in Vercel: ${esc(missing.join(', '))}</div>` : ''}
        <div class="rv-form">
          <label class="rv-switch"><input type="checkbox" id="rvEnabled" ${s.enabled ? 'checked' : ''} /> Send review requests automatically</label>
          <div class="muted" style="font-size:12px;margin-top:6px">Off still finds and queues orders, so you can see what would go out. Turn the Printavo "ZAP&gt;" automations off before turning this on, or customers get two emails.</div>
        </div>

        <div class="rv-form">
          <h2>The email</h2>
          <div class="rv-grid">
            <div class="rv-field"><label for="rvFromName">From name</label><input type="text" id="rvFromName" value="${esc(s.fromName)}" /></div>
            <div class="rv-field"><label for="rvFromEmail">From address</label><input type="email" id="rvFromEmail" class="rv-code" value="${esc(s.fromEmail)}" />
              <div class="hint">Must be on pmapparel.com</div></div>
            <div class="rv-field"><label for="rvReplyTo">Replies go to</label><input type="email" id="rvReplyTo" class="rv-code" value="${esc(s.replyTo)}" /></div>
          </div>
          <div class="rv-field" style="margin-top:12px"><label for="rvSubject">Subject</label><input type="text" id="rvSubject" value="${esc(s.subject)}" /></div>
          <div class="rv-field" style="margin-top:12px"><label for="rvBody">Text</label><textarea id="rvBody">${esc(s.body)}</textarea>
            <div class="hint">Fill-ins: ${PLACEHOLDERS.map((p) => `<span class="rv-code">${esc(p.key)}</span> ${esc(p.label)}`).join(' · ')}</div></div>
          <div class="rv-field" style="margin-top:12px"><label>Preview</label><div class="rv-preview" id="rvPreview"></div></div>
          <div class="rv-row">
            <input type="email" id="rvTestTo" class="rv-code" placeholder="send a test to…" />
            <button class="rv-btn" id="rvTest">Send test</button>
          </div>
        </div>

        <div class="rv-form">
          <h2>Timing and rules</h2>
          <div class="rv-grid">
            <div class="rv-field"><label for="rvDelay">Days to wait after pickup</label><input type="number" id="rvDelay" min="0" max="60" value="${esc(s.delayDays)}" /></div>
            <div class="rv-field"><label for="rvGap">Days before the same address can be asked again</label><input type="number" id="rvGap" min="0" max="365" value="${esc(s.repeatGapDays)}" />
              <div class="hint">Stops two emails when a customer has two orders picked up close together. 0 turns it off.</div></div>
            <div class="rv-field"><label for="rvMax">Emails per run, at most</label><input type="number" id="rvMax" min="1" max="100" value="${esc(s.maxPerRun)}" />
              <div class="hint">Four runs a day. Resend's free plan allows 100 a day across every app.</div></div>
            <div class="rv-field"><label for="rvLookback">Days back to look in Printavo</label><input type="number" id="rvLookback" min="7" max="365" value="${esc(s.lookbackDays)}" />
              <div class="hint">By production date.</div></div>
          </div>
          <div class="rv-field" style="margin-top:12px"><label for="rvStatuses">Printavo statuses that trigger the email, one per line</label>
            <textarea id="rvStatuses" class="short rv-code">${esc((s.statuses || []).join('\n'))}</textarea>
            <div class="hint">Emoji and capitals do not matter.</div></div>
          <div class="rv-row">
            <button class="rv-btn primary" id="rvSave">Save settings</button>
            <button class="rv-btn" id="rvCheck">Check Printavo</button>
            <button class="rv-btn" id="rvRun">Run now</button>
          </div>
          <div id="rvCheckOut"></div>
        </div>
      `;
      renderPreview();
      ['rvSubject', 'rvBody', 'rvFromName'].forEach((id) => $('#' + id).addEventListener('input', renderPreview));

      $('#rvSave').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        try {
          const r = await api.put(ENDPOINTS.rvSettings, formValues());
          settingsData.settings = r.settings;
          flash('Settings saved.');
        } catch (e) { flash(errText(e), 'err'); }
        finally { btn.disabled = false; }
      });

      $('#rvTest').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        const to = $('#rvTestTo').value.trim();
        if (!to) { flash('Enter an address for the test.', 'warn'); return; }
        btn.disabled = true;
        try {
          const r = await api.post(ENDPOINTS.rvSettings, { action: 'test', to, settings: formValues() });
          flash(`Test sent to ${r.to}. Nothing was queued or counted.`);
        } catch (e) { flash(errText(e), 'err'); }
        finally { btn.disabled = false; }
      });

      $('#rvCheck').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        $('#rvCheckOut').innerHTML = '<div class="rv-msg warn" style="margin-top:12px">Asking Printavo. This can take up to a minute.</div>';
        try {
          const r = await api.post(ENDPOINTS.rvSettings, { action: 'check' });
          const sample = (r.sample || []).map((o) =>
            `#${esc(o.visualId)} ${esc(o.nickname)} · ${esc(o.status)} · ${o.firstName ? esc(o.firstName) : 'no first name'} · ${o.hasEmail ? 'has email' : 'NO EMAIL'}`).join('<br>');
          $('#rvCheckOut').innerHTML = `<div class="rv-msg ${r.missingStatuses && r.missingStatuses.length ? 'warn' : 'ok'}" style="margin-top:12px">
            Found ${r.found} order${r.found === 1 ? '' : 's'} at ${esc((r.matchedStatuses || []).join(', ') || 'those statuses')} in the last ${esc(formValues().lookbackDays)} days, ${r.notYetSeen} not seen before.
            ${r.complete ? '' : 'Stopped before the end of the list; the scheduled run carries on where it stops.'}
            ${r.missingStatuses && r.missingStatuses.length ? '<br>Not found in Printavo: ' + esc(r.missingStatuses.join(', ')) : ''}
            <br><span class="muted">Method: ${r.mode === 'statusIds' ? 'filtered by status' : 'scanned by production date'}. Nothing was saved.</span>
            ${sample ? '<br><br>' + sample : ''}</div>`;
        } catch (e) {
          $('#rvCheckOut').innerHTML = `<div class="rv-msg err" style="margin-top:12px">${esc(errText(e))}</div>`;
        } finally { btn.disabled = false; }
      });

      $('#rvRun').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        flash('Running. This can take up to a minute.', 'warn');
        try {
          const r = await api.post(ENDPOINTS.rvSettings, { action: 'run' });
          const c = r.check || {};
          const s = r.send || {};
          const parts = [];
          parts.push(c.error ? `Printavo check failed: ${c.error}` : `Printavo: ${c.found} found, ${c.queued} newly queued${c.baseline ? ', ' + c.baseline + ' recorded as already handled' : ''}`);
          parts.push(s.error ? `Sending failed: ${s.error}` : !s.enabled ? 'Sending is off' : `${s.sent} sent, ${s.skipped} skipped`);
          flash(parts.join('. ') + '.', c.error || s.error ? 'err' : 'ok');
        } catch (e) { flash(errText(e), 'err'); }
        finally { btn.disabled = false; }
      });
    }

    this._show = (view) => {
      current = ['requests', 'reviewed', 'settings'].includes(view) ? view : 'requests';
      root.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== current; });
      flash('');
      if (current === 'requests') loadRequests();
      if (current === 'reviewed') loadReviewed();
      if (current === 'settings') loadSettings();
    };
    this._show(current);
  },

  showView(view) {
    if (typeof this._show === 'function') this._show(view);
  }
};
