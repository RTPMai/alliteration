// PUT IN: apps/marketmachine/tasks.js
/**
 * My tasks: the simple way into MarketMachine.
 *
 * Phase 5, Sept 2026. This screen exists because the campaign page is right
 * for the person running a campaign and wrong for everyone else. A Try On Day
 * is 19 steps; somebody who owes it one of them should see one line.
 *
 * WHAT IS DELIBERATELY NOT HERE: stages, formulas, the scorecard, connections,
 * other people's steps, budgets, history, filters, and any second page. A
 * person opens this, reads a few lines, ticks what they did, and leaves.
 *
 * WHAT IS HERE, because Ryan asked for task plus a short why: the step, one
 * line saying why it exists, when it is due, and a box.
 *
 * DETAILS (Sept 24 2026). Ryan: the list did not link to the campaign or show
 * anything to see details. Each row now has a Details button that opens, in
 * place, the step's full help, its notes and files, and the campaign's date,
 * Account Manager and audience (see taskDetails in lib/marketmachine/tasks.js
 * for exactly what, and what is kept out). Admins also get "Open the
 * campaign", which goes to the full campaign page at its own address. Staff
 * do not, because that page is admin only and the button would only refuse. Anything waiting on
 * somebody else is set aside under its own heading rather than listed as due,
 * because a list that tells you to do things you cannot start is a list people
 * stop opening.
 */

import { ENDPOINTS } from '../../js/api.js';
import { groupTasks } from '../../lib/marketmachine/tasks.js';
import { esc, fmtDate, msgBox } from './format.js';

/** Which task's details are open, as one string, so only one opens at a time. */
export const taskId = (t) => t.campaignId + ':' + t.key;

export default function makeTasks(app) {
  const { state, api, root, ui } = app;
  const $ = (sel) => root.querySelector(sel);

  function details(t) {
    const d = t.details || {};
    const facts = [
      [d.dateLabel || 'Campaign date', d.date ? fmtDate(d.date) : 'Not set yet'],
      ['Account Manager', d.accountManager || 'Not assigned'],
      d.audience ? ['Who it is for', d.audience] : null,
      t.waitingOn ? ['Waiting on', t.waitingOn] : null,
    ].filter(Boolean);
    return `
      <div class="mk-task-more" id="mkTaskMore-${esc(taskId(t))}">
        ${d.help ? `<p class="help">${esc(d.help)}</p>` : ''}
        <dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        ${d.notes ? `<div class="sec">Notes</div><div class="notes">${esc(d.notes)}</div>` : ''}
        ${(d.links || []).length ? `<div class="sec">Files and links</div><div class="links">${d.links.map((l) =>
          `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || l.url)}</a>`).join('')}</div>` : ''}
        ${state.taskFull ? `<button class="mk-btn sm" data-task-campaign="${esc(t.campaignId)}">Open the campaign</button>` : ''}
      </div>`;
  }

  function taskRow(t) {
    const saving = state.taskSaving === taskId(t);
    const open = state.taskOpen === taskId(t);
    return `
      <li class="mk-task${t.overdue ? ' late' : ''}">
        <input type="checkbox" class="mk-check" data-task-done="${esc(t.campaignId)}" data-task-step="${esc(t.key)}"
          aria-label="Done: ${esc(t.label)}"${saving ? ' disabled' : ''}>
        <div>
          <div class="what">${esc(t.label)}</div>
          <div class="why">${esc(t.why)}</div>
          <div class="meta">
            <span>${esc(t.campaignName)}</span>
            ${t.due ? `<span class="${t.overdue ? 'late' : ''}">${t.overdue ? 'Was due ' : 'Due '}${esc(fmtDate(t.due))}</span>` : '<span>No date</span>'}
            ${t.approval ? '<span>Your approval</span>' : ''}
            ${t.blocked ? `<span class="late">Blocked: ${esc(t.blocked)}</span>` : ''}
            <button class="mk-task-toggle" data-task-more="${esc(taskId(t))}" aria-expanded="${open ? 'true' : 'false'}"
              aria-controls="mkTaskMore-${esc(taskId(t))}">${open ? 'Hide details' : 'Details'}</button>
          </div>
          ${open ? details(t) : ''}
        </div>
      </li>`;
  }

  function renderTasks() {
    const pane = $('#mkTasksBody');
    if (!pane) return;
    const tasks = state.tasks || [];
    const g = groupTasks(tasks, state.today);

    const block = (title, list, note) => list.length ? `
      <section class="mk-task-block">
        <h2>${esc(title)}<span>${list.length}</span></h2>
        ${note ? `<div class="note">${esc(note)}</div>` : ''}
        <ul>${list.map(taskRow).join('')}</ul>
      </section>` : '';

    pane.innerHTML = `
      <div class="mk-hd">
        <div>
          <h1>My tasks<span class="dot">.</span></h1>
          <div class="sub">${tasks.length
            ? 'Everything with your name on it, soonest first. Tick what you have done.'
            : 'Nothing is waiting on you right now.'}</div>
        </div>
        <div class="mk-actions"><button class="mk-btn ghost sm" data-act="tasks-refresh">Refresh</button></div>
      </div>
      ${msgBox(state.taskMsg)}
      ${state.taskError ? `<div class="mk-err">${esc(state.taskError)}</div>` : ''}
      ${tasks.length ? `
        ${block('Overdue', g.overdue)}
        ${block('This week', g.soon)}
        ${block('Later', g.later)}
        ${block('Waiting on someone else', g.waiting, 'Nothing to do yet. These open up when the step before them is finished.')}
      ` : `
        <div class="mk-card"><div class="mk-empty">
          <h4>You are all caught up</h4>
          Steps show up here when a campaign reaches something with your name on it.
        </div></div>`}`;
  }

  async function tickTask(campaignId, stepKey, done) {
    state.taskSaving = campaignId + ':' + stepKey;
    renderTasks();
    try {
      await api.patch(ENDPOINTS.mkCampaigns, { done }, { query: { id: campaignId, step: stepKey, mine: 1 } });
      state.taskMsg = { cls: 'ok', text: done ? 'Marked done.' : 'Put back.' };
    } catch (e) {
      state.taskMsg = { cls: 'err', text: e.message || 'That did not save.' };
    }
    state.taskSaving = null;
    await ui.loadTasks();
    renderTasks();
  }

  function toggleTask(id) {
    state.taskOpen = state.taskOpen === id ? null : id;
    renderTasks();
  }

  return { renderTasks, tickTask, toggleTask };
}
