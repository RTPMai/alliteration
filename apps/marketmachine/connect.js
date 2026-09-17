// PUT IN: apps/marketmachine/connect.js
/**
 * The connections cards: MailMe emails, TravelTrack trips, BackBone leads and
 * Printavo invoices, each counted once across an event.
 *
 * A factory, not a module of loose functions: every screen needs the same
 * live state, api and root element, and passing them to each call would be
 * noise. `ui` is the shared object every module's functions are hung on, so
 * one screen can call another's without importing it and creating a loop.
 */

import { linksOf } from '../../lib/marketmachine/connections.js';
import { esc, fmtDate, fmtStamp, fmtMoney, TRIP_STATUS_LABEL } from './format.js';

export default function makeConnect(app) {
  const { state, api, root, ui } = app;
  const $ = (sel) => root.querySelector(sel);

    function scopeName(id, conn) {
      const hit = conn && Array.isArray(conn.scope) ? conn.scope.find((x) => x.id === id) : null;
      return hit ? hit.name : id;
    }

    function creditCell(row, c, conn) {
      if (!conn || !Array.isArray(conn.scope) || conn.scope.length < 2) return '';
      const primary = row.primary === c.id ? 'This event' : scopeName(row.primary, conn);
      const assisting = (row.assisting || []).map((id) => id === c.id ? 'this event' : scopeName(id, conn));
      return `<td>${esc(primary)}${assisting.length ? `<div class="who">Assisting: ${esc(assisting.join(', '))}</div>` : ''}</td>`;
    }

    function removable(c, kind, ref) {
      return c && linksOf(c)[kind].some((e) => e.ref === ref);
    }

    function addForm(kind) {
      if (state.connAdding !== kind) return '';
      const opts = state.connOptions;
      let field;
      if (kind === 'trips') {
        const list = opts && Array.isArray(opts.trips) ? opts.trips : null;
        field = list === null
          ? '<div class="mk-notice" style="margin:0">TravelTrack did not answer, so trips cannot be listed right now.</div>'
          : `<div class="mk-field"><label for="mkConnRef-trips">Trip</label>
              <select id="mkConnRef-trips"><option value="">Pick a trip</option>
                ${list.map((t) => `<option value="${esc(t.id)}">${esc(t.title || t.destination || t.id)}${t.start_date ? ', ' + esc(fmtDate(t.start_date)) : ''}</option>`).join('')}
              </select></div>`;
      } else if (kind === 'leads') {
        const list = opts && Array.isArray(opts.leads) ? opts.leads : null;
        field = list === null
          ? '<div class="mk-notice" style="margin:0">BackBone did not answer, so leads cannot be listed right now.</div>'
          : `<div class="mk-field"><label for="mkConnRef-leads">Lead</label>
              <div class="hint">Start typing a company or lead number.</div>
              <input type="text" id="mkConnRef-leads" list="mkLeadList" autocomplete="off">
              <datalist id="mkLeadList">${list.map((l) =>
                `<option value="${esc(l.ref)}">${esc([l.leadNo, l.company, l.status].filter(Boolean).join(', '))}</option>`).join('')}</datalist></div>`;
      } else {
        field = `<div class="mk-field"><label for="mkConnRef-invoices">Printavo invoice number</label>
            <div class="hint">The number on the invoice in Printavo, digits only.</div>
            <input type="text" id="mkConnRef-invoices" inputmode="numeric" maxlength="13"></div>`;
      }
      return `<div class="mk-conn-add">${field}
        <button class="mk-btn sm" data-conn-save="${kind}">Connect</button>
        <button class="mk-btn ghost sm" data-conn-cancel="1">Cancel</button></div>`;
    }

    function connectionsSection(c, meta, conn) {
      if (!conn) return '';
      const multi = Array.isArray(conn.scope) && conn.scope.length > 1;
      const credit = multi ? '<th>Credited to</th>' : '';
      const unavailable = (what) => `<div class="mk-card-bd"><div class="mk-notice" style="margin:0">${what} did not answer, so this cannot be shown right now. Nothing is lost.</div></div>`;

      // Email
      const em = conn.email || {};
      const emailBody = em.unavailable ? unavailable('MailMe') : `
        <div class="mk-conn-stats"><div class="mk-stat-row">
          <div class="mk-stat"><div class="v">${em.count || 0}</div><div class="l">Emails attached</div></div>
          <div class="mk-stat"><div class="v">${(em.delivered || 0).toLocaleString()}</div><div class="l">Delivered</div></div>
          <div class="mk-stat"><div class="v">${(em.uniqueClicks || 0).toLocaleString()}</div><div class="l">Unique clicks, per email</div></div>
          <div class="mk-stat"><div class="v">${em.uniqueClickRate == null ? '<span style="font-size:14px">' + esc(em.rateStatus || 'Nothing delivered yet') + '</span>' : esc(em.uniqueClickRate) + '%'}</div><div class="l">Unique click rate</div></div>
          <div class="mk-stat"><div class="v">${(em.uniqueOpens || 0).toLocaleString()}</div><div class="l">Opens, directional only</div></div>
        </div></div>
        ${(em.emails || []).length ? `<div class="mk-wrap"><table class="mk-table"><thead><tr>
            <th>Email</th>${multi ? '<th>Campaign</th>' : ''}<th>Status</th><th>Delivered</th><th>Unique clicks</th>
          </tr></thead><tbody>${em.emails.map((e) => `<tr>
            <td><div class="co">${esc(e.subject || 'No subject yet')}</div><div class="who">${esc(e.id)}${e.sentAt ? ', sent ' + esc(fmtStamp(e.sentAt)) : ''}</div></td>
            ${multi ? `<td>${esc(scopeName(e.campaignId, conn))}</td>` : ''}
            <td>${esc(e.status)}</td><td>${e.delivered}</td><td>${e.uniqueClicks}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="mk-conn-note" style="padding-bottom:14px">No emails yet. Start one here, or attach an existing email from its own screen in MailMe.</div>'}`;

      // Travel
      const tr = conn.travel || {};
      const travelBody = tr.unavailable ? unavailable('TravelTrack') : `
        ${(tr.trips || []).length ? `
          <div class="mk-conn-stats"><div class="mk-stat-row">
            <div class="mk-stat"><div class="v">${tr.trips.length}</div><div class="l">Trips</div></div>
            <div class="mk-stat"><div class="v">${fmtMoney(tr.total)}</div><div class="l">Spent, not counting rejected</div></div>
            <div class="mk-stat"><div class="v">${fmtMoney(tr.pending)}</div><div class="l">Waiting on approval</div></div>
            <div class="mk-stat"><div class="v">${fmtMoney(tr.reimbursed)}</div><div class="l">Reimbursed</div></div>
          </div></div>
          <div class="mk-wrap"><table class="mk-table"><thead><tr>
            <th>Trip</th><th>Dates</th><th>Status</th><th>Receipts</th><th>Spent</th>${credit}<th></th>
          </tr></thead><tbody>${tr.trips.map((t) => `<tr>
            <td><div class="co">${t.missing ? 'Trip no longer in TravelTrack' : esc(t.title || t.destination)}</div><div class="who">${esc(t.destination || t.ref)}</div></td>
            <td>${esc(fmtDate(t.start_date))}${t.end_date && t.end_date !== t.start_date ? ' to ' + esc(fmtDate(t.end_date)) : ''}</td>
            <td>${esc(TRIP_STATUS_LABEL[t.status] || t.status || '')}</td>
            <td>${t.receipts}</td><td>${fmtMoney(t.total)}</td>
            ${creditCell(t, c, conn)}
            <td>${removable(c, 'trips', t.ref) ? `<button class="mk-btn ghost sm" data-conn-remove="trips" data-ref="${esc(t.ref)}">Disconnect</button>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>`
          : '<div class="mk-conn-note" style="padding-bottom:14px">No trips connected. Money stays in TravelTrack; this shows it, it does not copy it.</div>'}`;

      // Leads
      const ld = conn.leads || {};
      const leadsBody = ld.unavailable ? unavailable('BackBone') : `
        ${(ld.leads || []).length ? `
          <div class="mk-conn-stats"><div class="mk-stat-row">
            <div class="mk-stat"><div class="v">${ld.count}</div><div class="l">Leads</div></div>
            <div class="mk-stat"><div class="v">${ld.won}</div><div class="l">Won</div></div>
          </div></div>
          <div class="mk-wrap"><table class="mk-table"><thead><tr>
            <th>Lead</th><th>Status</th><th>Account Manager</th>${credit}<th></th>
          </tr></thead><tbody>${ld.leads.map((l) => `<tr>
            <td><div class="co">${l.missing ? 'Lead no longer in BackBone' : esc(l.company)}</div><div class="who">${esc(l.leadNo || l.ref)}${l.contact ? ', ' + esc(l.contact) : ''}</div></td>
            <td>${esc(l.status)}</td><td>${esc(l.accountManager)}</td>
            ${creditCell(l, c, conn)}
            <td>${removable(c, 'leads', l.ref) ? `<button class="mk-btn ghost sm" data-conn-remove="leads" data-ref="${esc(l.ref)}">Disconnect</button>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>`
          : '<div class="mk-conn-note" style="padding-bottom:14px">No leads connected. A lead counts once, credited to the first campaign it was connected to.</div>'}`;

      // Invoices
      const inv = conn.invoices || { invoices: [] };
      const invoicesBody = (inv.invoices || []).length ? `
        <div class="mk-wrap"><table class="mk-table"><thead><tr>
          <th>Invoice</th><th>Printavo status</th><th>Customer</th><th>Total</th>${credit}<th></th>
        </tr></thead><tbody>${inv.invoices.map((x) => {
          const st = state.printavo[x.ref];
          const statusCell = !st ? '<span class="who">Not checked</span>'
            : st.unavailable ? '<span class="who">Printavo did not answer</span>'
              : !st.found ? '<span class="late">Not found in Printavo</span>'
                : `${esc(st.status || 'No status')}${st.kind === 'quote' ? ' <span class="pill mute">Quote</span>' : ''}`;
          return `<tr>
            <td class="co">#${esc(x.ref)}</td>
            <td>${statusCell}</td>
            <td>${st && st.found ? esc(st.customer) : ''}</td>
            <td>${st && st.found ? fmtMoney(st.total) : ''}</td>
            ${creditCell(x, c, conn)}
            <td>${removable(c, 'invoices', x.ref) ? `<button class="mk-btn ghost sm" data-conn-remove="invoices" data-ref="${esc(x.ref)}">Disconnect</button>` : ''}</td>
          </tr>`;
        }).join('')}</tbody></table></div>`
        : '<div class="mk-conn-note" style="padding-bottom:14px">No invoices connected. Create the invoice in Printavo, then connect its number here.</div>';

      const head = (title, meta2, actions) => `<div class="mk-card-hd"><h3>${title}</h3><div class="mk-actions">${meta2 ? `<span class="meta">${meta2}</span>` : ''}${actions || ''}</div></div>`;
      const connectBtn = (kind, label) => state.connAdding === kind ? '' : `<button class="mk-btn ghost sm" data-conn-add="${kind}">${label}</button>`;

      return `
        <h2 style="font-size:17px;font-weight:800;margin:26px 0 6px">connections.</h2>
        <div class="mk-scope">${multi
          ? `Counted once across this event and its ${conn.scope.length - 1} connected campaign${conn.scope.length === 2 ? '' : 's'}.`
          : 'Read live from each app. Nothing here is a copy.'}</div>
        ${msgBox(state.connMsg)}
        <div class="mk-card">
          ${head('Email, in MailMe', '', c.status === 'open' ? '<button class="mk-btn ghost sm" data-act="start-email">Start an email in MailMe</button>' : '')}
          ${emailBody}
        </div>
        <div class="mk-card">
          ${head('Travel, in TravelTrack', '', connectBtn('trips', 'Connect a trip'))}
          ${travelBody}
          ${addForm('trips')}
        </div>
        <div class="mk-card">
          ${head('Leads, in BackBone', '', connectBtn('leads', 'Connect a lead'))}
          ${leadsBody}
          ${addForm('leads')}
        </div>
        <div class="mk-card">
          ${head('Printavo invoices', '', ((inv.invoices || []).length ? `<button class="mk-btn ghost sm" data-act="check-printavo"${state.printavoChecking ? ' disabled' : ''}>${state.printavoChecking ? 'Checking Printavo' : 'Check status in Printavo'}</button>` : '') + connectBtn('invoices', 'Connect an invoice'))}
          ${invoicesBody}
          ${addForm('invoices')}
        </div>`;
    }

    /* ---------------- calculations ---------------- */

  return { scopeName, creditCell, removable, addForm, connectionsSection };
}
