/**
 * apps/stickies.js — StickySituations (Site Work section).
 *
 * Named Sticky Notes until Sep 2026. The id stays `stickies`: it is baked into
 * saved links and the KV keyspace, and nobody reads a key.
 *
 * The digital version of the post-it wall on Ryan's desk: what still needs
 * building in Alliteration itself. Deliberately NOT Notifications. That list
 * is the team's hand-offs, has assignees and history, and belongs to running
 * the business. This one has no assignee, no due date, no history log. It is
 * paper. Anything here that becomes real assigned work gets retyped into
 * Notifications, and having to retype it is the point: it is the moment the
 * idea graduated.
 *
 * Superuser only, gated in js/registry.js canAccess() for the rail and again
 * in api/sitework.js for the data. The rail check alone is not access control.
 *
 * Layout is a masonry-ish column flow rather than a grid, so a note with three
 * lines of detail does not force every note beside it to reserve the same
 * height. Same problem BackBone's dashboard solved with explicit row spans;
 * CSS columns are enough here because nothing needs to line up in rows.
 */

import { ENDPOINTS } from '../js/api.js';
import { APPS } from '../js/registry.js';
import { SIZE_LABELS, noteText, boardText } from '../lib/sitework/schema.js';

const COLORS = [
  ['yellow', 'Yellow'],
  ['green', 'Green'],
  ['blue', 'Blue'],
  ['pink', 'Pink'],
  ['grey', 'Grey'],
];

// Display order, not the schema's order: "No idea" is first because it is the
// answer for a note somebody just thought of, and the first option is what a
// new note gets. The labels come from the schema so a size is called the same
// thing on the board, in the dropdown and in a copied note.
const SIZES = ['unknown', 'small', 'medium', 'large'].map((v) => [v, SIZE_LABELS[v]]);

const SIZE_LABEL = SIZE_LABELS;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export default {
  id: 'stickies',

  styles: `
  .sk-wrap{max-width:1180px}
  .sk-hd{margin-bottom:18px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .sk-hd h1{font-size:24px;font-weight:800;letter-spacing:-.02em}
  .sk-hd .sub{font-size:13px;color:var(--muted);margin-top:3px;max-width:60ch}

  .sk-btn{
    border:1px solid var(--line);background:var(--card);color:var(--ink);
    font-family:inherit;font-size:12.5px;font-weight:600;padding:7px 12px;
    border-radius:var(--radius-sm);cursor:pointer;
  }
  .sk-btn:hover{border-color:var(--muted)}
  .sk-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
  .sk-btn.primary:hover{background:var(--accent-deep)}
  .sk-btn.danger{color:var(--danger);border-color:var(--danger-line)}
  .sk-btn.danger:hover{background:var(--danger-tint)}
  .sk-btn.small{padding:4px 9px;font-size:11.5px}
  .sk-btn:disabled{opacity:.5;cursor:default}

  .sk-msg{font-size:12.5px;border-radius:var(--radius-sm);padding:9px 11px;margin-bottom:14px}
  .sk-msg.err{background:var(--danger-tint);color:var(--danger)}
  .sk-msg.ok{background:var(--success-tint);color:var(--success-dk)}

  /* ---- filter bar ---- */
  .sk-bar{
    display:flex;gap:7px;flex-wrap:wrap;align-items:center;
    padding-bottom:14px;margin-bottom:16px;border-bottom:1px solid var(--line);
  }
  .sk-chip{
    border:1px solid var(--line);background:var(--card);color:var(--muted);
    font-family:inherit;font-size:11.5px;font-weight:600;padding:5px 11px;
    border-radius:999px;cursor:pointer;
  }
  .sk-chip:hover{border-color:var(--muted);color:var(--ink)}
  .sk-chip[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
  .sk-chip .ct{opacity:.7;margin-left:5px;font-weight:500}
  .sk-spacer{flex:1}

  .sk-showdone{
    display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);
    cursor:pointer;user-select:none;
  }
  .sk-showdone input{width:auto;margin:0}

  /* ---- the board ---- */
  .sk-board{columns:4;column-gap:14px}
  @media(max-width:1080px){.sk-board{columns:3}}
  @media(max-width:800px){.sk-board{columns:2}}
  @media(max-width:520px){.sk-board{columns:1}}

  /* The whole card used to be draggable="true", which is why you could not
     select the words on a note: the browser starts a drag instead of a
     selection. Dragging now belongs to the grip alone, so the text is text. */
  .sk-note{
    break-inside:avoid;-webkit-column-break-inside:avoid;
    display:inline-block;width:100%;margin:0 0 14px;
    background:var(--paper);color:var(--sticky-ink);
    border:1px solid var(--paper-edge);
    border-radius:3px;padding:12px 13px 10px;
    box-shadow:var(--shadow-card);
    cursor:default;user-select:text;-webkit-user-select:text;
  }
  .sk-note[draggable="true"]{cursor:grabbing}
  .sk-grip{
    flex:none;border:0;background:none;padding:0 2px;margin-top:1px;
    color:inherit;opacity:.35;font-size:13px;line-height:1;cursor:grab;
    font-family:inherit;
  }
  .sk-grip:hover{opacity:.75}
  .sk-note.dragging{opacity:.4}
  .sk-note.drop-before{box-shadow:-4px 0 0 var(--accent),var(--shadow-card)}
  .sk-note.drop-after{box-shadow:4px 0 0 var(--accent),var(--shadow-card)}
  .sk-note.done{opacity:.55}
  .sk-note.done .sk-title{text-decoration:line-through}

  .sk-note[data-color="yellow"]{--paper:var(--sticky-yellow);--paper-edge:var(--sticky-yellow-edge)}
  .sk-note[data-color="green"]{--paper:var(--sticky-green);--paper-edge:var(--sticky-green-edge)}
  .sk-note[data-color="blue"]{--paper:var(--sticky-blue);--paper-edge:var(--sticky-blue-edge)}
  .sk-note[data-color="pink"]{--paper:var(--sticky-pink);--paper-edge:var(--sticky-pink-edge)}
  .sk-note[data-color="grey"]{--paper:var(--sticky-grey);--paper-edge:var(--sticky-grey-edge)}

  .sk-top{display:flex;align-items:flex-start;gap:8px}
  .sk-check{margin:2px 0 0;flex:none;width:auto;cursor:pointer}
  .sk-title{font-size:14px;font-weight:700;line-height:1.3;flex:1;word-break:break-word}
  .sk-detail{font-size:12.5px;line-height:1.45;margin-top:6px;white-space:pre-wrap;word-break:break-word}

  .sk-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:9px;align-items:center}
  .sk-tag{
    display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;
    letter-spacing:.02em;padding:2px 7px;border-radius:999px;
    background:rgba(255,255,255,.55);
  }
  .sk-tag .sq{width:6px;height:6px;border-radius:2px;background:var(--c);flex:none}
  .sk-id{font-size:10.5px;opacity:.55;margin-left:auto;font-variant-numeric:tabular-nums}

  .sk-acts{display:flex;gap:6px;margin-top:9px}
  .sk-acts button{
    border:1px solid rgba(0,0,0,.14);background:rgba(255,255,255,.45);
    color:inherit;font-family:inherit;font-size:11px;font-weight:600;
    padding:3px 8px;border-radius:var(--radius-sm);cursor:pointer;
  }
  .sk-acts button:hover{background:rgba(255,255,255,.85)}

  /* ---- form ---- */
  .sk-form{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
    padding:16px 18px;margin-bottom:16px;box-shadow:var(--shadow-card);
  }
  .sk-field{margin-bottom:12px}
  .sk-field label{
    display:block;font-size:11px;font-weight:700;letter-spacing:.05em;
    text-transform:uppercase;color:var(--muted);margin-bottom:5px;
  }
  .sk-field input,.sk-field select,.sk-field textarea{
    width:100%;border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:9px 11px;font-family:inherit;font-size:13.5px;color:var(--ink);
    background:var(--card);
  }
  .sk-field textarea{resize:vertical;min-height:56px}
  .sk-field input:focus,.sk-field select:focus,.sk-field textarea:focus{
    outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-tint);
  }
  .sk-row{display:flex;gap:12px;flex-wrap:wrap}
  .sk-row .sk-field{flex:1;min-width:150px}

  .sk-swatches{display:flex;gap:7px}
  .sk-swatch{
    width:28px;height:28px;border-radius:4px;cursor:pointer;
    border:2px solid transparent;padding:0;
  }
  .sk-swatch[aria-pressed="true"]{border-color:var(--ink)}
  .sk-swatch[data-color="yellow"]{background:var(--sticky-yellow)}
  .sk-swatch[data-color="green"]{background:var(--sticky-green)}
  .sk-swatch[data-color="blue"]{background:var(--sticky-blue)}
  .sk-swatch[data-color="pink"]{background:var(--sticky-pink)}
  .sk-swatch[data-color="grey"]{background:var(--sticky-grey)}

  .sk-empty{
    border:1px dashed var(--line);border-radius:var(--radius);
    padding:30px 20px;text-align:center;color:var(--muted);font-size:13.5px;
  }
  `,

  template: `
    <div class="sk-wrap">
      <div class="sk-hd">
        <div>
          <h1>StickySituations</h1>
          <div class="sub">What still needs building in Alliteration. Not team work: hand-offs and assignments live in Notifications.</div>
        </div>
        <button class="sk-btn primary" id="skNewBtn">Add a note</button>
      </div>

      <div id="skMsg"></div>
      <div id="skForm" style="display:none"></div>
      <div class="sk-bar" id="skBar"></div>
      <div class="sk-board" id="skBoard"><div class="sk-empty">Loading…</div></div>
    </div>
  `,

  async mount(ctx) {
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);

    let notes = [];
    let filterApp = 'all';
    let showDone = false;
    let editing = null;      // note id currently open in the form, or null
    let formColor = 'yellow';
    let dragId = null;

    // App tag options come from the registry so a new app appears here without
    // a second list to remember. Blank is allowed and common: plenty of these
    // notes are about the shell, not about one app.
    const APP_OPTIONS = APPS.map((a) => ({ id: a.id, name: a.name, accent: a.accent }));
    const appMeta = (id) => APP_OPTIONS.find((a) => a.id === id) || null;

    function msg(text, kind) {
      $('#skMsg').innerHTML = text
        ? '<div class="sk-msg ' + (kind || 'ok') + '">' + esc(text) + '</div>'
        : '';
    }

    async function load() {
      try {
        const res = await ctx.api.get(ENDPOINTS.sitework);
        notes = (res && res.notes) || [];
        render();
      } catch (e) {
        // A failed load must not render an empty board: an empty board and a
        // broken board look identical, and one of them is a lie.
        $('#skBoard').innerHTML =
          '<div class="sk-empty">Could not load the board. ' + esc(e.message || 'Unknown error') + '</div>';
      }
    }

    /* ---- filter bar ---------------------------------------------------- */

    function renderBar() {
      const live = notes.filter((n) => showDone || n.status !== 'done');
      const countFor = (id) => notes.filter((n) => (id === 'all' || n.appId === id) && (showDone || n.status !== 'done')).length;
      const used = [...new Set(notes.map((n) => n.appId).filter(Boolean))];

      let html = '<button class="sk-chip" data-filter="all" aria-pressed="' + (filterApp === 'all') + '">' +
        'Everything<span class="ct">' + live.length + '</span></button>';

      used.forEach((id) => {
        const a = appMeta(id);
        if (!a) return;
        html += '<button class="sk-chip" data-filter="' + esc(id) + '" aria-pressed="' + (filterApp === id) + '">' +
          esc(a.name) + '<span class="ct">' + countFor(id) + '</span></button>';
      });

      if (notes.some((n) => !n.appId)) {
        html += '<button class="sk-chip" data-filter="none" aria-pressed="' + (filterApp === 'none') + '">' +
          'No app<span class="ct">' + notes.filter((n) => !n.appId && (showDone || n.status !== 'done')).length + '</span></button>';
      }

      html += '<div class="sk-spacer"></div>' +
        '<button class="sk-chip" id="skCopyAll">Copy showing</button>' +
        '<label class="sk-showdone"><input type="checkbox" id="skShowDone"' + (showDone ? ' checked' : '') + '> Show done</label>';

      $('#skBar').innerHTML = html;

      $('#skBar').querySelectorAll('[data-filter]').forEach((b) => {
        b.addEventListener('click', () => { filterApp = b.dataset.filter; render(); });
      });
      const sd = $('#skShowDone');
      if (sd) sd.addEventListener('change', () => { showDone = sd.checked; render(); });

      // Whatever is on screen under the current filter, as one block of text.
      // Copies what you can see rather than the whole board, because the
      // filter is how you already said which notes you meant.
      const ca = $('#skCopyAll');
      if (ca) ca.addEventListener('click', async () => {
        const list = visibleNotes();
        if (!list.length) { msg('Nothing showing to copy.', 'err'); return; }
        const ok = await copyText(boardText(list, appNameFor));
        msg(ok
          ? 'Copied ' + list.length + ' note' + (list.length === 1 ? '' : 's') + '.'
          : 'The browser would not let me reach the clipboard.', ok ? 'ok' : 'err');
      });
    }

    /* ---- copying ------------------------------------------------------- */

    // noteText() and boardText() live in lib/sitework/schema.js so the tests
    // can call them for real. All this layer supplies is the app's name, which
    // is registry data the schema must not reach for.
    const appNameFor = (n) => {
      const a = n && n.appId ? appMeta(n.appId) : null;
      return a ? a.name : '';
    };

    // navigator.clipboard needs a secure context and can be refused outright,
    // so the old textarea trick stays as the fallback. Returning false rather
    // than throwing lets the caller say "could not copy" instead of nothing
    // happening for no visible reason.
    async function copyText(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* fall through to the textarea */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return !!ok;
      } catch (e) {
        return false;
      }
    }

    /* ---- board --------------------------------------------------------- */

    function noteHtml(n) {
      const a = n.appId ? appMeta(n.appId) : null;
      const done = n.status === 'done';
      const tags =
        (a ? '<span class="sk-tag" style="--c:' + esc(a.accent) + '"><span class="sq"></span>' + esc(a.name) + '</span>' : '') +
        (n.size && n.size !== 'unknown' ? '<span class="sk-tag">' + esc(SIZE_LABEL[n.size] || n.size) + '</span>' : '') +
        '<span class="sk-id">' + esc(n.id) + '</span>';

      return '' +
        '<div class="sk-note' + (done ? ' done' : '') + '" data-id="' + esc(n.id) + '" data-color="' + esc(n.color || 'yellow') + '" draggable="false">' +
          '<div class="sk-top">' +
            '<input type="checkbox" class="sk-check" data-toggle="' + esc(n.id) + '"' + (done ? ' checked' : '') +
              ' title="' + (done ? 'Put it back' : 'Mark done') + '">' +
            '<div class="sk-title">' + esc(n.title) + '</div>' +
            '<button class="sk-grip" data-grip="' + esc(n.id) + '" title="Drag to reorder" ' +
              'aria-label="Drag to reorder">\u283F</button>' +
          '</div>' +
          (n.detail ? '<div class="sk-detail">' + esc(n.detail) + '</div>' : '') +
          '<div class="sk-tags">' + tags + '</div>' +
          '<div class="sk-acts">' +
            '<button data-edit="' + esc(n.id) + '">Edit</button>' +
            '<button data-copy="' + esc(n.id) + '">Copy</button>' +
            '<button data-del="' + esc(n.id) + '">Delete</button>' +
          '</div>' +
        '</div>';
    }

    function visibleNotes() {
      return notes.filter((n) => {
        if (!showDone && n.status === 'done') return false;
        if (filterApp === 'all') return true;
        if (filterApp === 'none') return !n.appId;
        return n.appId === filterApp;
      });
    }

    function render() {
      renderBar();
      const list = visibleNotes();
      $('#skBoard').innerHTML = list.length
        ? list.map(noteHtml).join('')
        : '<div class="sk-empty">' +
            (notes.length ? 'Nothing under that filter.' : 'Empty board. Add the first note.') +
          '</div>';
      wireBoard();
    }

    function wireBoard() {
      const board = $('#skBoard');

      board.querySelectorAll('[data-toggle]').forEach((cb) => {
        cb.addEventListener('change', async () => {
          const id = cb.dataset.toggle;
          const n = notes.find((x) => x.id === id);
          if (!n) return;
          const next = cb.checked ? 'done' : 'open';
          try {
            await ctx.api.patch(ENDPOINTS.sitework, { status: next }, { query: { id } });
            n.status = next;
            render();
          } catch (e) {
            cb.checked = !cb.checked;
            msg('Could not update that note. ' + (e.message || ''), 'err');
          }
        });
      });

      board.querySelectorAll('[data-edit]').forEach((b) => {
        b.addEventListener('click', () => openForm(b.dataset.edit));
      });

      board.querySelectorAll('[data-copy]').forEach((b) => {
        b.addEventListener('click', async () => {
          const n = notes.find((x) => x.id === b.dataset.copy);
          if (!n) return;
          const ok = await copyText(noteText(n, appNameFor(n)));
          const was = b.textContent;
          b.textContent = ok ? 'Copied' : 'Could not copy';
          setTimeout(() => { b.textContent = was; }, 1400);
        });
      });

      board.querySelectorAll('[data-del]').forEach((b) => {
        b.addEventListener('click', async () => {
          const id = b.dataset.del;
          const n = notes.find((x) => x.id === id);
          if (!confirm('Delete "' + (n ? n.title : id) + '"? This cannot be undone.')) return;
          try {
            await ctx.api.del(ENDPOINTS.sitework, { query: { id } });
            notes = notes.filter((x) => x.id !== id);
            render();
          } catch (e) {
            msg('Could not delete that note. ' + (e.message || ''), 'err');
          }
        });
      });

      // Drag to reorder. Position is saved for the whole board in one PATCH
      // rather than one per card, so a single gesture is a single write.
      // Dragging is armed by the grip and disarmed the moment it ends, so the
      // rest of the card stays selectable text the whole time.
      board.querySelectorAll('[data-grip]').forEach((g) => {
        const card = g.closest('.sk-note');
        if (!card) return;
        const arm = () => card.setAttribute('draggable', 'true');
        const disarm = () => card.setAttribute('draggable', 'false');
        g.addEventListener('mousedown', arm);
        g.addEventListener('touchstart', arm, { passive: true });
        g.addEventListener('mouseup', disarm);
        card.addEventListener('dragend', disarm);
      });

      board.querySelectorAll('.sk-note').forEach((el) => {
        el.addEventListener('dragstart', (e) => {
          dragId = el.dataset.id;
          el.classList.add('dragging');
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
        el.addEventListener('dragend', () => {
          dragId = null;
          board.querySelectorAll('.sk-note').forEach((x) =>
            x.classList.remove('dragging', 'drop-before', 'drop-after'));
        });
        el.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (!dragId || el.dataset.id === dragId) return;
          const box = el.getBoundingClientRect();
          const after = (e.clientY - box.top) > box.height / 2;
          el.classList.toggle('drop-before', !after);
          el.classList.toggle('drop-after', after);
        });
        el.addEventListener('dragleave', () => {
          el.classList.remove('drop-before', 'drop-after');
        });
        el.addEventListener('drop', async (e) => {
          e.preventDefault();
          const targetId = el.dataset.id;
          if (!dragId || targetId === dragId) return;
          const box = el.getBoundingClientRect();
          const after = (e.clientY - box.top) > box.height / 2;

          const from = notes.findIndex((n) => n.id === dragId);
          if (from < 0) return;
          const moved = notes.splice(from, 1)[0];
          let to = notes.findIndex((n) => n.id === targetId);
          if (to < 0) to = notes.length;
          notes.splice(after ? to + 1 : to, 0, moved);

          notes.forEach((n, i) => { n.order = i; });
          render();
          try {
            await ctx.api.patch(ENDPOINTS.sitework, {
              order: notes.map((n, i) => ({ id: n.id, order: i })),
            });
          } catch (err) {
            msg('The new order did not save. It will snap back on reload. ' + (err.message || ''), 'err');
          }
        });
      });
    }

    /* ---- form ---------------------------------------------------------- */

    function openForm(id) {
      editing = id || null;
      const n = id ? notes.find((x) => x.id === id) : null;
      formColor = n ? (n.color || 'yellow') : 'yellow';

      $('#skForm').innerHTML =
        '<div class="sk-form">' +
          '<div class="sk-field"><label>Note</label>' +
            '<input id="sk-title" maxlength="200" placeholder="What needs doing" value="' + esc(n ? n.title : '') + '"></div>' +
          '<div class="sk-field"><label>Detail (optional)</label>' +
            '<textarea id="sk-detail" maxlength="2000" placeholder="Anything you will not remember in three weeks">' + esc(n ? n.detail : '') + '</textarea></div>' +
          '<div class="sk-row">' +
            '<div class="sk-field"><label>App (optional)</label><select id="sk-app">' +
              '<option value="">Not app specific</option>' +
              APP_OPTIONS.map((a) =>
                '<option value="' + esc(a.id) + '"' + (n && n.appId === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('') +
            '</select></div>' +
            '<div class="sk-field"><label>Size</label><select id="sk-size">' +
              SIZES.map(([v, l]) =>
                '<option value="' + v + '"' + (n && n.size === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') +
            '</select></div>' +
          '</div>' +
          '<div class="sk-field"><label>Colour</label><div class="sk-swatches" id="skSwatches">' +
            COLORS.map(([v, l]) =>
              '<button type="button" class="sk-swatch" data-color="' + v + '" title="' + esc(l) + '" ' +
                'aria-pressed="' + (formColor === v) + '"></button>').join('') +
          '</div></div>' +
          '<button class="sk-btn primary" id="sk-save">' + (n ? 'Save' : 'Add note') + '</button> ' +
          '<button class="sk-btn" id="sk-cancel">Cancel</button>' +
        '</div>';

      $('#skForm').style.display = 'block';
      $('#sk-title').focus();

      $('#skSwatches').querySelectorAll('.sk-swatch').forEach((b) => {
        b.addEventListener('click', () => {
          formColor = b.dataset.color;
          $('#skSwatches').querySelectorAll('.sk-swatch').forEach((x) =>
            x.setAttribute('aria-pressed', x.dataset.color === formColor));
        });
      });

      $('#sk-cancel').addEventListener('click', closeForm);
      $('#sk-save').addEventListener('click', save);
      $('#sk-title').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
      });
    }

    function closeForm() {
      editing = null;
      $('#skForm').style.display = 'none';
      $('#skForm').innerHTML = '';
    }

    async function save() {
      const title = $('#sk-title').value.trim();
      if (!title) { msg('A note needs something written on it.', 'err'); return; }

      const body = {
        title,
        detail: $('#sk-detail').value.trim(),
        appId: $('#sk-app').value,
        size: $('#sk-size').value,
        color: formColor,
      };

      const btn = $('#sk-save');
      btn.disabled = true;
      try {
        if (editing) {
          const res = await ctx.api.patch(ENDPOINTS.sitework, body, { query: { id: editing } });
          const i = notes.findIndex((x) => x.id === editing);
          if (i >= 0 && res && res.note) notes[i] = res.note;
        } else {
          const res = await ctx.api.post(ENDPOINTS.sitework, body);
          if (res && res.note) notes.push(res.note);
        }
        msg('');
        closeForm();
        render();
      } catch (e) {
        btn.disabled = false;
        msg('Could not save that note. ' + (e.message || ''), 'err');
      }
    }

    $('#skNewBtn').addEventListener('click', () => {
      const isOpen = $('#skForm').style.display !== 'none';
      if (isOpen && !editing) closeForm();
      else openForm(null);
    });

    await load();
  },
};
