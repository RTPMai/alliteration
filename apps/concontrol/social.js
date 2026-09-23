// PUT IN: apps/concontrol/social.js
/**
 * ConControl, Social screen: the posting plan as a week-by-week calendar.
 *
 * Its own file because apps/concontrol.js is at the 100KB line, and a file
 * past that line cannot go through the web uploader. apps/concontrol.js
 * imports this and hands it the helpers it already has (the drawer, the
 * formatter, the error banner), so there is one drawer and one look.
 *
 * What it does: shows every post by week, lets a person edit the copy, mark a
 * post posted or skipped, answer the open decisions, and tick the real-world
 * conditions (a sponsor signed, a speaker confirmed) that conditional posts
 * wait on. What is stuck is also handed to Home, so the one blocked list on
 * Home stays the one place to look.
 *
 * All the rules about what is late, what is waiting and what a reload may
 * change live in lib/concontrol/social.js, which the route imports too.
 *
 * The seam: no fetch() in here. ctx.api.get/post/patch/del with ENDPOINTS.*.
 * The plan file is read with FileReader, which is the browser opening a file
 * the person picked, not a network call.
 */

import { ENDPOINTS } from '../../js/api.js';
import {
  POST_STATUSES, POST_STATUS_LABELS, DONE_STATUSES, CHANNELS, CHANNEL_LABELS,
  CTA_LABELS, postState, groupByWeek, phaseLabel, conditionLabel, splitDepends,
  copyWarnings, hasCopy, nextPost, todayCentral,
} from '../../lib/concontrol/social.js';

export const SOCIAL_STYLES = `
  .con-week { margin-bottom: 18px; }
  .con-week > h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 6px; }
  .con-post { display: grid; grid-template-columns: 92px 1fr auto; gap: 10px; align-items: center; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 9px 12px; margin-bottom: 6px; cursor: pointer; }
  .con-post:hover { border-color: var(--accent); }
  .con-post.done { opacity: .55; }
  .con-post.late { border-color: var(--danger); }
  .con-post .d { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .con-post .d b { display: block; color: var(--ink); font-size: 13px; }
  .con-post .t { font-weight: 600; font-size: 13px; color: var(--ink); line-height: 1.3; }
  .con-post .m { font-size: 12px; color: var(--muted); margin-top: 3px; }
  .con-post .m.bad { color: var(--danger); font-weight: 600; }
  .con-post .r { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .con-dec { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--ink); }
  .con-dec:last-child { border-bottom: 0; }
  .con-dec .m { font-size: 12px; color: var(--muted); }
  .con-dec .m.bad { color: var(--danger); font-weight: 600; }
  .con-rules { margin-bottom: 18px; }
  .con-rules summary { cursor: pointer; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 700; }
  .con-rules ul { margin: 8px 0 0; padding-left: 18px; font-size: 13px; color: var(--ink); line-height: 1.6; }
  .con-copy { white-space: pre-wrap; }
  .con-file { display: none; }
  @media (max-width: 640px) {
    .con-post { grid-template-columns: 1fr; }
    .con-post .r { justify-content: flex-start; }
  }
`;

const FILTERS = [
  ['upcoming', 'Coming up'],
  ['late', 'Late'],
  ['nocopy', 'Needs copy'],
  ['waiting', 'Waiting'],
  ['done', 'Posted'],
  ['all', 'All'],
];

export default function makeSocial(h) {
  const { getCtx, esc, prettyDate, showError, openDrawerHtml, closeDrawer, formError, trailHtml, onChange } = h;

  const S = {
    posts: [], decisions: [], meta: null, blockers: [], summary: null,
    today: todayCentral(), canEdit: false, canDelete: false, canImport: false,
    loaded: false, filter: 'upcoming', search: '', msg: null,
  };

  const $ = (sel) => getCtx().root.querySelector(sel);
  const conditions = () => (S.meta && S.meta.conditions) || {};
  const shortDate = (iso) => {
    const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /* ---------------- data ---------------- */

  async function load() {
    const ctx = getCtx();
    try {
      const data = await ctx.api.get(ENDPOINTS.conSocial);
      S.posts = Array.isArray(data.posts) ? data.posts : [];
      S.decisions = Array.isArray(data.decisions) ? data.decisions : [];
      S.meta = data.meta || null;
      S.blockers = Array.isArray(data.blockers) ? data.blockers : [];
      S.summary = data.summary || null;
      S.today = data.today || todayCentral();
      S.canEdit = !!data.canEdit;
      S.canDelete = !!data.canDelete;
      S.canImport = !!data.canImport;
      S.loaded = true;
    } catch (e) {
      showError(e.message || 'Could not load the social plan');
    }
    render();
    onChange();
  }

  async function patch(body) {
    const ctx = getCtx();
    await ctx.api.patch(ENDPOINTS.conSocial, body);
    await load();
  }

  function importFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      let plan;
      try { plan = JSON.parse(String(reader.result)); } catch (e) {
        S.msg = { bad: true, text: 'That file is not valid JSON. Is it the plan file?' };
        render();
        return;
      }
      try {
        const res = await getCtx().api.post(ENDPOINTS.conSocial, { what: 'import', plan });
        const c = res.counts || {};
        const bits = [];
        if (c.added) bits.push(`${plural(c.added, 'post')} added`);
        if (c.updated) bits.push(`${c.updated} updated from the file`);
        if (c.unchanged) bits.push(`${c.unchanged} unchanged`);
        if (c.kept) bits.push(`${c.kept} with your edits kept as they were`);
        if (c.decisionsAdded) bits.push(`${plural(c.decisionsAdded, 'decision')} added`);
        if (c.notInFile) bits.push(`${c.notInFile} stored posts are not in this file and were left alone`);
        if (res.skipped && res.skipped.length) bits.push(`${res.skipped.length} rows in the file could not be read`);
        S.msg = { bad: false, text: `Plan loaded. ${bits.join(', ')}.` };
      } catch (e) {
        S.msg = { bad: true, text: e.message || 'Could not load the plan' };
      }
      await load();
    };
    reader.readAsText(file);
  }

  /* ---------------- screen ---------------- */

  function matches(p) {
    const s = postState(p, S.decisions, conditions(), S.today);
    if (S.search) {
      const hay = `${p.title} ${p.id} ${p.type || ''} ${typeof p.copy === 'string' ? p.copy : JSON.stringify(p.copy || '')}`.toLowerCase();
      if (hay.indexOf(S.search) === -1) return false;
    }
    switch (S.filter) {
      case 'upcoming': return !s.done && !s.overdue;
      case 'late': return s.overdue;
      case 'nocopy': return s.needsCopy && !s.taskish;
      case 'waiting': return !s.done && !s.waiting.ready;
      case 'done': return s.done;
      default: return true;
    }
  }

  function render() {
    const host = $('#conSocialBody');
    if (!host) return;

    const bar = `
      <div class="con-bar">
        <input type="search" id="conSocSearch" placeholder="Search posts and copy" autocomplete="off" value="${esc(S.search)}">
        ${FILTERS.map(([k, label]) => `<button class="con-chip${S.filter === k ? ' on' : ''}" data-sfilter="${k}">${esc(label)}</button>`).join('')}
        <span class="con-spacer"></span>
        ${S.canImport ? `<button class="con-btn ${S.posts.length ? 'ghost' : ''}" id="conSocLoad">${S.posts.length ? 'Reload plan file' : 'Load plan file'}</button>
        <input type="file" accept=".json,application/json" class="con-file" id="conSocFile">` : ''}
      </div>`;

    const msg = S.msg ? `<div class="${S.msg.bad ? 'con-err' : 'con-ok'}">${esc(S.msg.text)}</div>` : '';

    if (!S.loaded) {
      host.innerHTML = `<div class="con-empty"><h3>Loading the plan</h3></div>`;
      return;
    }

    if (!S.posts.length) {
      host.innerHTML = `${msg}${bar}
        <div class="con-empty">
          <h3>No social plan loaded yet</h3>
          <div>${S.canImport ? 'Load the plan file (the .json) and every post, decision and rule in it lands here.' : 'An admin loads the plan file. Once they do, the posting calendar shows here.'}</div>
        </div>`;
      wire(host);
      return;
    }

    host.innerHTML = `${msg}
      <div class="con-totals">${totalsHtml()}</div>
      ${decisionsHtml()}
      ${rulesHtml()}
      ${bar}
      <div id="conSocWeeks">${weeksHtml()}</div>`;
    wire(host);
  }

  function totalsHtml() {
    const t = S.summary || {};
    const next = nextPost(S.posts, S.today);
    const cards = [
      { k: 'Posted', v: `${t.posted || 0} of ${t.total || 0}`, sub: t.skipped ? `${t.skipped} skipped` : '' },
      { k: 'Next up', v: next ? shortDate(next.date) : 'Nothing', sub: next ? next.title : 'The plan is finished' },
      { k: 'Late', v: String(t.overdue || 0), sub: 'Date passed, not posted', warn: t.overdue > 0 },
      { k: 'Needs copy', v: String(t.needsCopySoon || 0), sub: 'Going out in the next 2 weeks', warn: t.needsCopySoon > 0 },
      { k: 'Open decisions', v: String(t.openDecisions || 0), sub: 'Posts waiting on an answer', warn: t.openDecisions > 0 },
    ];
    return cards.map((c) => `
      <div class="con-tot${c.warn ? ' warn' : ''}">
        <div class="k">${esc(c.k)}</div>
        <div class="v">${esc(c.v)}</div>
        ${c.sub ? `<div class="sub">${esc(c.sub)}</div>` : ''}
      </div>`).join('');
  }

  function decisionsHtml() {
    const open = S.decisions.filter((d) => d.status !== 'decided');
    const decided = S.decisions.filter((d) => d.status === 'decided');
    if (!S.decisions.length) return '';
    const row = (d) => {
      const days = d.needed_by ? Math.round((Date.parse(d.needed_by + 'T12:00:00Z') - Date.parse(S.today + 'T12:00:00Z')) / 86400000) : null;
      const late = d.status !== 'decided' && days !== null && days < 0;
      const when = d.status === 'decided'
        ? `Decided: ${d.answer || 'yes'}`
        : d.needed_by ? `Needed by ${prettyDate(d.needed_by)}${late ? `, ${-days} days late` : days === 0 ? ', today' : ''}` : 'No date set';
      return `
        <div class="con-dec">
          <div>
            <div>${esc(d.question)}</div>
            <div class="m${late ? ' bad' : ''}">${esc(when)}${d.status !== 'decided' && d.placeholder ? ` · Working assumption: ${esc(d.placeholder)}` : ''}</div>
          </div>
          <button class="con-btn ghost" data-decision="${esc(d.id)}">${d.status === 'decided' ? 'View' : 'Decide'}</button>
        </div>`;
    };
    return `
      <div class="con-left">
        <h4>Decisions the plan is waiting on</h4>
        ${open.length ? open.map(row).join('') : '<div class="con-note">All decided.</div>'}
        ${decided.length ? `<details class="con-rules" style="margin:10px 0 0"><summary>${decided.length} decided</summary>${decided.map(row).join('')}</details>` : ''}
      </div>`;
  }

  function rulesHtml() {
    const m = S.meta || {};
    const rules = Array.isArray(m.rules) ? m.rules : [];
    const goals = Array.isArray(m.goals) ? m.goals : [];
    const triggers = Array.isArray(m.triggers) ? m.triggers : [];
    if (!rules.length && !goals.length) return '';
    return `
      <details class="con-rules con-left">
        <summary>Goals and posting rules${m.generated ? ` (plan dated ${esc(prettyDate(m.generated))})` : ''}</summary>
        ${goals.length ? `<ul>${goals.map((g) => `<li><strong>${esc(g.metric || g.id)}</strong>: ${esc(g.target)} by ${esc(/^\d{4}-\d{2}-\d{2}$/.test(String(g.deadline)) ? prettyDate(g.deadline) : g.deadline)}</li>`).join('')}</ul>` : ''}
        ${rules.length ? `<ul>${rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        ${triggers.length ? `<ul>${triggers.map((t) => `<li><strong>When ${esc(t.when)}:</strong> ${esc(t.do)}</li>`).join('')}</ul>` : ''}
      </details>`;
  }

  function weeksHtml() {
    const shown = S.posts.filter(matches);
    if (!shown.length) return `<div class="con-empty"><h3>Nothing here</h3><div>No posts match this filter.</div></div>`;
    return groupByWeek(shown).map((g) => `
      <div class="con-week">
        <h3>Week of ${esc(prettyDate(g.week))}</h3>
        ${g.posts.map(postRowHtml).join('')}
      </div>`).join('');
  }

  function postRowHtml(p) {
    const s = postState(p, S.decisions, conditions(), S.today);
    const bits = [];
    let bad = false;
    if (s.overdue) { bits.push(`Was due ${Math.abs(s.due)} day${Math.abs(s.due) === 1 ? '' : 's'} ago`); bad = true; }
    if (!s.done && !s.waiting.ready) {
      const on = s.waiting.decisions.map((x) => x.question).concat(s.waiting.conditions.map((x) => x.label));
      bits.push(`Waiting on: ${on.join('; ')}`);
    }
    if (s.needsCopy && !s.taskish && !s.overdue) bits.push('No copy yet');
    if (s.warnings.length) { bits.push(s.warnings[0]); bad = true; }
    if (p.status === 'posted' && p.postedAt) bits.push(`Posted ${prettyDate(p.postedAt)}${p.postedBy ? ' by ' + p.postedBy : ''}`);
    const channels = (p.channels || []).map((c) => CHANNEL_LABELS[c] || c).join(', ');
    return `
      <div class="con-post${s.done ? ' done' : ''}${s.overdue ? ' late' : ''}" data-post="${esc(p.id)}">
        <div class="d"><b>${esc(shortDate(p.date))}</b>${esc(p.type || '')}</div>
        <div>
          <div class="t">${esc(p.title)}</div>
          <div class="m">${esc(channels)}${p.cta ? ` · ${esc(CTA_LABELS[p.cta] || p.cta)}` : ''}</div>
          ${bits.length ? `<div class="m${bad ? ' bad' : ''}">${esc(bits.join(' · '))}</div>` : ''}
        </div>
        <div class="r">
          <span class="con-pip${s.done ? ' done' : ''}">${esc(POST_STATUS_LABELS[p.status] || p.status)}</span>
          ${S.canEdit && !s.done ? `<button class="con-btn ghost" data-posted="${esc(p.id)}">${s.taskish ? 'Mark done' : 'Mark posted'}</button>` : ''}
        </div>
      </div>`;
  }

  function wire(host) {
    const search = host.querySelector('#conSocSearch');
    if (search) search.addEventListener('input', (e) => {
      S.search = e.target.value.toLowerCase();
      const weeks = host.querySelector('#conSocWeeks');
      if (weeks) weeks.innerHTML = weeksHtml();
      wireRows(host);
    });
    host.querySelectorAll('[data-sfilter]').forEach((b) => b.addEventListener('click', () => {
      S.filter = b.dataset.sfilter;
      render();
    }));
    const loadBtn = host.querySelector('#conSocLoad');
    const fileIn = host.querySelector('#conSocFile');
    if (loadBtn && fileIn) {
      loadBtn.addEventListener('click', () => fileIn.click());
      fileIn.addEventListener('change', () => importFile(fileIn.files && fileIn.files[0]));
    }
    host.querySelectorAll('[data-decision]').forEach((b) => b.addEventListener('click', () => {
      const d = S.decisions.find((x) => x.id === b.dataset.decision);
      if (d) decisionDrawer(d);
    }));
    wireRows(host);
  }

  function wireRows(host) {
    host.querySelectorAll('[data-post]').forEach((row) => row.addEventListener('click', (e) => {
      if (e.target.closest('[data-posted]')) return;
      const p = S.posts.find((x) => x.id === row.dataset.post);
      if (p) postDrawer(p);
    }));
    host.querySelectorAll('[data-posted]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      b.disabled = true;
      try { await patch({ kind: 'post', id: b.dataset.posted, status: 'posted' }); }
      catch (err) { showError(err.message || 'Could not mark it posted'); b.disabled = false; }
    }));
  }

  /* ---------------- drawers ---------------- */

  function copyFieldsHtml(p) {
    const ro = S.canEdit ? '' : ' readonly';
    if (p.copy && typeof p.copy === 'object') {
      return Object.keys(p.copy).map((k) => `
        <div class="con-field">
          <label>Copy: ${esc(k.split('_').map((c) => CHANNEL_LABELS[c] || c).join(' and '))}</label>
          <textarea data-copykey="${esc(k)}" rows="7"${ro}>${esc(p.copy[k] || '')}</textarea>
        </div>`).join('');
    }
    return `
      <div class="con-field">
        <label>Copy</label>
        <textarea data-copykey="" rows="7"${ro} placeholder="Not written yet">${esc(p.copy || '')}</textarea>
      </div>`;
  }

  function readCopy(root, p) {
    const areas = Array.from(root.querySelectorAll('[data-copykey]'));
    if (p.copy && typeof p.copy === 'object') {
      const out = {};
      areas.forEach((a) => { out[a.dataset.copykey] = a.value; });
      return out;
    }
    return areas[0] ? areas[0].value : null;
  }

  function postDrawer(p) {
    const s = postState(p, S.decisions, conditions(), S.today);
    const { conditions: condKeys } = splitDepends(p.depends_on);
    const met = conditions();
    const ro = S.canEdit ? '' : ' disabled';

    const waitingHtml = (p.depends_on && p.depends_on.length) ? `
      <div class="con-sec">
        <h4>Only runs if</h4>
        ${splitDepends(p.depends_on).decisions.map((k) => {
          const d = S.decisions.find((x) => x.key === k);
          const done = d && d.status === 'decided';
          return `<div class="con-row"><span>${esc(d ? d.question : conditionLabel(k))}</span><span class="con-pip${done ? ' done' : ''}">${done ? 'Decided' : 'Open decision'}</span></div>`;
        }).join('')}
        ${condKeys.map((k) => `
          <div class="con-row">
            <span>${esc(conditionLabel(k))}</span>
            <span class="con-states">
              <button data-cond="${esc(k)}" data-met="0" class="${met[k] ? '' : 'on'}"${ro}>Not yet</button>
              <button data-cond="${esc(k)}" data-met="1" class="${met[k] ? 'on' : ''}"${ro}>Happened</button>
            </span>
          </div>`).join('')}
        <div class="con-note">${s.waiting.ready ? 'Everything it waits on is in place.' : 'Still waiting. If it never happens, mark the post skipped.'}</div>
      </div>` : '';

    const warn = copyWarnings(p.copy);
    openDrawerHtml(p.title, `${p.id} · ${phaseLabel(p.phase)}`, `
      ${warn.length ? `<div class="con-err">${esc(warn.join(' '))}</div>` : ''}
      <div class="con-two">
        <div class="con-field"><label>Goes out</label><input type="date" id="conSpDate" value="${esc(p.date)}"${ro}></div>
        <div class="con-field"><label>Status</label>
          <select id="conSpStatus"${ro}>${POST_STATUSES.map((st) => `<option value="${st}"${p.status === st ? ' selected' : ''}>${esc(POST_STATUS_LABELS[st])}</option>`).join('')}</select>
        </div>
      </div>
      <div class="con-field"><label>Title</label><input id="conSpTitle" value="${esc(p.title)}"${ro}></div>
      <div class="con-field"><label>Channels</label>
        <div class="con-states">${CHANNELS.map((c) => `<button type="button" data-chan="${c}" class="${(p.channels || []).includes(c) ? 'on' : ''}"${ro}>${esc(CHANNEL_LABELS[c])}</button>`).join('')}</div>
      </div>
      <div class="con-field"><label>Points people to</label>
        <select id="conSpCta"${ro}><option value="">Nothing</option>${Object.keys(CTA_LABELS).map((k) => `<option value="${k}"${p.cta === k ? ' selected' : ''}>${esc(CTA_LABELS[k])}</option>`).join('')}</select>
      </div>
      ${copyFieldsHtml(p)}
      ${hasCopy(p.copy) ? '<button class="con-btn ghost" id="conSpCopy" type="button">Copy text</button>' : ''}
      ${p.assets && p.assets.length ? `<div class="con-sec"><h4>Assets</h4>${p.assets.map((a) => `<div class="con-note">${esc(a)}</div>`).join('')}</div>` : ''}
      <div class="con-field" style="margin-top:12px"><label>Notes</label><textarea id="conSpNotes" rows="3"${ro}>${esc(p.notes || '')}</textarea></div>
      ${waitingHtml}
      ${S.canEdit ? `
        <div class="con-actions">
          <button class="con-btn" id="conSpSave">Save</button>
          ${!DONE_STATUSES.includes(p.status) ? '<button class="con-btn ghost" id="conSpPosted">Save and mark posted</button>' : ''}
          ${S.canDelete ? '<span class="con-spacer"></span><button class="con-btn ghost" id="conSpDelete">Delete</button>' : ''}
        </div>` : ''}
      ${trailHtml(p)}
    `);

    const root = getCtx().root;
    const drawer = root.querySelector('.con-drawer');
    drawer.querySelectorAll('[data-chan]').forEach((b) => b.addEventListener('click', () => b.classList.toggle('on')));

    drawer.querySelectorAll('[data-cond]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await getCtx().api.patch(ENDPOINTS.conSocial, { kind: 'condition', key: b.dataset.cond, met: b.dataset.met === '1' });
        await load();
        const fresh = S.posts.find((x) => x.id === p.id);
        if (fresh) postDrawer(fresh);
      } catch (e) { formError(e.message || 'Could not save that'); }
    }));

    const copyBtn = drawer.querySelector('#conSpCopy');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const c = readCopy(drawer, p);
      const text = typeof c === 'string' ? c : Object.values(c || {}).join('\n\n');
      try { await navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied'; }
      catch (e) { copyBtn.textContent = 'Select the text and copy it'; }
    });

    const collect = () => ({
      kind: 'post',
      id: p.id,
      date: drawer.querySelector('#conSpDate').value,
      status: drawer.querySelector('#conSpStatus').value,
      title: drawer.querySelector('#conSpTitle').value,
      cta: drawer.querySelector('#conSpCta').value || null,
      channels: Array.from(drawer.querySelectorAll('[data-chan].on')).map((b) => b.dataset.chan),
      copy: readCopy(drawer, p),
      notes: drawer.querySelector('#conSpNotes').value,
    });

    // Only send what changed, so saving a copy edit does not also mark the
    // date, title and channels as edited and freeze them against a reload.
    const changedOnly = (body) => {
      const out = { kind: 'post', id: p.id };
      const norm = (v) => JSON.stringify(v === undefined || v === '' ? null : v);
      ['date', 'status', 'title', 'cta', 'channels', 'copy', 'notes'].forEach((f) => {
        if (norm(body[f]) !== norm(p[f])) out[f] = body[f];
      });
      return out;
    };

    const save = async (extra) => {
      const body = { ...changedOnly(collect()), ...(extra || {}) };
      if (Object.keys(body).length <= 2) { closeDrawer(); return; }
      try { await patch(body); closeDrawer(); }
      catch (e) { formError(e.message || 'Could not save the post'); }
    };

    const saveBtn = drawer.querySelector('#conSpSave');
    if (saveBtn) saveBtn.addEventListener('click', () => save());
    const postedBtn = drawer.querySelector('#conSpPosted');
    if (postedBtn) postedBtn.addEventListener('click', () => save({ status: 'posted' }));
    const delBtn = drawer.querySelector('#conSpDelete');
    if (delBtn) delBtn.addEventListener('click', async () => {
      if (!window.confirm(`Delete ${p.id}? A reload of the plan file would bring it back. To drop a post for good, mark it skipped instead.`)) return;
      try {
        await getCtx().api.del(ENDPOINTS.conSocial, { query: { id: p.id } });
        closeDrawer();
        await load();
      } catch (e) { formError(e.message || 'Could not delete it'); }
    });
  }

  function decisionDrawer(d) {
    const ro = S.canEdit ? '' : ' disabled';
    const posts = S.posts.filter((p) => splitDepends(p.depends_on).decisions.includes(d.key));
    openDrawerHtml(d.question, d.needed_by ? `Needed by ${prettyDate(d.needed_by)}` : '', `
      ${d.placeholder ? `<div class="con-note" style="margin-top:8px">The plan is working from: ${esc(d.placeholder)}</div>` : ''}
      <div class="con-field" style="margin-top:12px"><label>What was decided</label>
        <textarea id="conDecAnswer" rows="4"${ro}>${esc(d.answer || '')}</textarea>
      </div>
      <div class="con-field"><label>Needed by</label><input type="date" id="conDecNeeded" value="${esc(d.needed_by || '')}"${ro}></div>
      ${posts.length ? `<div class="con-sec"><h4>Posts waiting on this</h4>${posts.map((p) => `<div class="con-row"><span>${esc(p.title)}</span><span class="con-note">${esc(shortDate(p.date))}</span></div>`).join('')}</div>` : ''}
      ${S.canEdit ? `
        <div class="con-actions">
          ${d.status === 'decided'
            ? '<button class="con-btn" id="conDecSave">Save</button><button class="con-btn ghost" id="conDecReopen">Reopen</button>'
            : '<button class="con-btn" id="conDecDecide">Mark decided</button><button class="con-btn ghost" id="conDecSave">Save for later</button>'}
        </div>` : ''}
      ${trailHtml(d)}
    `);

    const drawer = getCtx().root.querySelector('.con-drawer');
    const send = async (extra) => {
      const body = { kind: 'decision', id: d.id, ...(extra || {}) };
      const answer = drawer.querySelector('#conDecAnswer').value;
      const needed = drawer.querySelector('#conDecNeeded').value;
      if (answer !== (d.answer || '')) body.answer = answer;
      if (needed !== (d.needed_by || '')) body.needed_by = needed || null;
      if (body.status === 'decided') body.answer = answer;
      if (Object.keys(body).length <= 2) { closeDrawer(); return; }
      try { await patch(body); closeDrawer(); }
      catch (e) { formError(e.message || 'Could not save the decision'); }
    };
    const on = (sel, fn) => { const el = drawer.querySelector(sel); if (el) el.addEventListener('click', fn); };
    on('#conDecDecide', () => send({ status: 'decided' }));
    on('#conDecSave', () => send());
    on('#conDecReopen', () => send({ status: 'open' }));
  }

  /* ---------------- for Home ---------------- */

  /** Rows for Home's one blocked list. Same shape the other screens hand it. */
  function blockerRows() {
    return S.blockers.map((b) => {
      if (b.kind === 'decision') {
        const why = b.needed_by
          ? (b.late ? `Decision ${-b.days} days late` : `Decision needed by ${prettyDate(b.needed_by)}`)
          : 'Decision, no date set';
        return { what: b.question, why, go: 'social', id: b.id };
      }
      if (b.kind === 'post-overdue') return { what: b.title, why: `Post was due ${prettyDate(b.date)}`, go: 'social', id: b.id };
      if (b.kind === 'post-waiting') return { what: b.title, why: `Goes out ${prettyDate(b.date)}, waiting on ${b.on.join('; ')}`, go: 'social', id: b.id };
      return { what: b.title, why: `Goes out ${prettyDate(b.date)}, no copy yet`, go: 'social', id: b.id };
    });
  }

  /** The Home totals card, or null before a plan is loaded. */
  function homeCard() {
    if (!S.posts.length) return null;
    const next = nextPost(S.posts, S.today);
    return {
      k: 'Next post',
      v: next ? shortDate(next.date) : 'None left',
      sub: next ? next.title : '',
      warn: !!(S.summary && S.summary.overdue),
    };
  }

  return { load, render, blockerRows, homeCard, state: S };
}
