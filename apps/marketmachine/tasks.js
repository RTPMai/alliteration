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
 * line saying why it exists, when it is due, and a box. Anything waiting on
 * somebody else is set aside under its own heading rather than listed as due,
 * because a list that tells you to do things you cannot start is a list people
 * stop opening.
 */

import { ENDPOINTS } from '../../js/api.js';
import { groupTasks } from '../../lib/marketmachine/tasks.js';
import { esc, fmtDate, msgBox } from './format.js';

export default function makeTasks(app) {
  const { state, api, root, ui } = app;
  const $ = (sel) => root.querySelector(sel);

  function taskRow(t) {
    const saving = state.taskSaving === t.campaignId + ':' + t.key;
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
          </div>
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

  return { renderTasks, tickTask };
}
