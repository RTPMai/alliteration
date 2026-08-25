// js/help.js — the help bubble, bottom right, on every screen.
//
// Ryan's ask, Aug 25 2026. A floating button that opens a panel OVER the
// current app rather than navigating away, so you can read the answer while
// looking at the thing you asked about. That is the whole reason it is not a
// rail screen.
//
// It also means the panel knows which app and view you are on and passes that
// along, so "how is this calculated" works without you naming anything.
//
// Colors are tokens only. No hex here; css/tokens.css owns theming.
//
// Talks to the server through js/api.js, the seam, same as everything else.

import { ENDPOINTS, post } from './api.js';

const STYLE_ID = 'helpBubbleStyles';

// Sits clear of the mobile rail toggle, which is bottom left, and above the
// iOS home indicator via env(safe-area-inset-bottom).
const CSS = `
.help-fab{
  position:fixed;right:18px;bottom:calc(18px + env(safe-area-inset-bottom,0px));
  width:48px;height:48px;border-radius:50%;border:none;
  background:var(--accent);color:var(--on-accent);
  font-family:inherit;font-size:20px;font-weight:700;line-height:1;
  cursor:pointer;box-shadow:var(--shadow-card);z-index:60;
  display:flex;align-items:center;justify-content:center;
}
.help-fab:hover{background:var(--accent-deep)}
.help-fab[aria-expanded="true"]{background:var(--accent-deep)}

.help-panel{
  position:fixed;right:18px;bottom:calc(76px + env(safe-area-inset-bottom,0px));
  width:min(380px, calc(100vw - 36px));max-height:min(560px, calc(100vh - 140px));
  background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow-card);z-index:60;display:flex;flex-direction:column;
}
.help-panel[hidden]{display:none}
.help-hd{
  padding:12px 14px;border-bottom:1px solid var(--line);
  display:flex;align-items:flex-start;justify-content:space-between;gap:10px;
}
.help-hd h2{font-size:14px;font-weight:800;letter-spacing:-.01em;color:var(--ink)}
.help-hd .sub{font-size:11.5px;color:var(--muted);margin-top:2px}
.help-x{
  border:none;background:none;color:var(--muted);cursor:pointer;
  font-family:inherit;font-size:17px;line-height:1;padding:2px 4px;flex:none;
}
.help-body{padding:12px 14px;overflow-y:auto;flex:1}
.help-ask{padding:10px 14px 12px;border-top:1px solid var(--line);display:flex;gap:6px}
.help-ask textarea{
  flex:1;resize:none;min-height:38px;max-height:110px;
  border:1px solid var(--line);border-radius:var(--radius-sm);
  padding:9px 10px;font-family:inherit;font-size:13px;color:var(--ink);
  background:var(--card);
}
.help-ask textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-tint)}
.help-send{
  border:1px solid var(--accent);background:var(--accent);color:var(--on-accent);
  font-family:inherit;font-size:12.5px;font-weight:700;padding:0 13px;
  border-radius:var(--radius-sm);cursor:pointer;flex:none;
}
.help-send:disabled{opacity:.5;cursor:default}

.help-intro{font-size:12.5px;color:var(--muted);line-height:1.55}
.help-intro b{color:var(--ink)}
.help-eg{
  display:block;width:100%;text-align:left;margin-top:7px;
  border:1px solid var(--line);background:var(--card);color:var(--ink);
  border-radius:var(--radius-sm);padding:7px 10px;font-family:inherit;
  font-size:12.5px;cursor:pointer;
}
.help-eg:hover{border-color:var(--accent);color:var(--accent-deep)}

.help-turn{margin-bottom:14px}
.help-q{
  font-size:12.5px;font-weight:700;color:var(--ink);
  background:var(--bg);border-radius:var(--radius-sm);padding:8px 10px;
}
.help-a{font-size:13px;color:var(--ink);line-height:1.6;margin-top:8px;white-space:pre-wrap}
.help-src{font-size:11px;color:var(--faint);margin-top:7px}
.help-err{font-size:12.5px;color:var(--danger);background:var(--danger-tint);
  border-radius:var(--radius-sm);padding:8px 10px;margin-top:8px}
.help-wait{font-size:12.5px;color:var(--muted);margin-top:8px}
`;

const EXAMPLES = [
  'How is the sales goal number calculated?',
  'Where does BackBone data come from?',
  'Why did someone not get an email?',
];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

/**
 * @param {function} getContext returns { app, view, appName, viewName } for
 *        whatever is on screen right now. A function rather than a value
 *        because the panel outlives any one route.
 */
export function initHelp(getContext) {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);

  const fab = document.createElement('button');
  fab.className = 'help-fab';
  fab.type = 'button';
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-label', 'Help');
  fab.title = 'Help';
  fab.textContent = '?';

  const panel = document.createElement('div');
  panel.className = 'help-panel';
  panel.hidden = true;
  panel.innerHTML =
    '<div class="help-hd">' +
      '<div><h2>Help</h2><div class="sub">How the apps work. No live numbers.</div></div>' +
      '<button class="help-x" type="button" aria-label="Close">\u00d7</button>' +
    '</div>' +
    '<div class="help-body" id="helpBody"></div>' +
    '<div class="help-ask">' +
      '<textarea id="helpQ" rows="1" maxlength="500" placeholder="Ask about an app, a number, or how to do something"></textarea>' +
      '<button class="help-send" id="helpSend" type="button">Ask</button>' +
    '</div>';

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  const body = panel.querySelector('#helpBody');
  const input = panel.querySelector('#helpQ');
  const sendBtn = panel.querySelector('#helpSend');

  // Turns are kept in memory for the session only. Each question is answered
  // on its own; there is no conversation history sent to the server, so the
  // retrieval for one question is never skewed by the last one.
  const turns = [];
  let busy = false;

  function renderIntro() {
    const ctx = getContext ? getContext() : {};
    return '<div class="help-intro">' +
      'Ask how something works, how a number is calculated, or where data ' +
      'comes from. I explain the apps. <b>I cannot look up live numbers, ' +
      'customers or orders</b>, so for a figure I will point you at the ' +
      'screen that has it.' +
      (ctx && ctx.appName
        ? '<div style="margin-top:8px">You are on <b>' + esc(ctx.appName) + '</b>' +
          (ctx.viewName ? ', ' + esc(ctx.viewName) : '') +
          ', so "how is this calculated" will work without naming it.</div>'
        : '') +
      '</div>' +
      EXAMPLES.map((q) => '<button class="help-eg" type="button" data-eg="' + esc(q) + '">' + esc(q) + '</button>').join('');
  }

  function render() {
    if (!turns.length) { body.innerHTML = renderIntro(); return; }
    body.innerHTML = turns.map((t) =>
      '<div class="help-turn">' +
        '<div class="help-q">' + esc(t.q) + '</div>' +
        (t.error
          ? '<div class="help-err">' + esc(t.error) + '</div>'
          : t.pending
            ? '<div class="help-wait">Looking that up\u2026</div>'
            : '<div class="help-a">' + esc(t.a) + '</div>' +
              (t.sources && t.sources.length
                ? '<div class="help-src">From: ' + esc(t.sources.join(', ')) + '</div>'
                : '')) +
      '</div>').join('');
    body.scrollTop = body.scrollHeight;
  }

  async function ask(question) {
    const q = String(question || '').trim();
    if (!q || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = '';
    const turn = { q, a: '', sources: [], pending: true, error: '' };
    turns.push(turn);
    render();

    const ctx = (getContext ? getContext() : {}) || {};
    try {
      const out = await post(ENDPOINTS.help, {
        question: q,
        app: ctx.app || null,
        view: ctx.view || null,
        appName: ctx.appName || null,
        viewName: ctx.viewName || null,
      });
      turn.a = out.answer || '';
      turn.sources = out.sources || [];
    } catch (e) {
      turn.error = e && e.message ? e.message : 'Help did not answer. Try again.';
    }
    turn.pending = false;
    busy = false;
    sendBtn.disabled = false;
    render();
    input.focus();
  }

  function open() {
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    render();
    input.focus();
  }

  function close() {
    panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
  }

  fab.addEventListener('click', () => (panel.hidden ? open() : close()));
  panel.querySelector('.help-x').addEventListener('click', close);
  sendBtn.addEventListener('click', () => ask(input.value));

  panel.addEventListener('click', (e) => {
    const eg = e.target.closest('[data-eg]');
    if (eg) ask(eg.dataset.eg);
  });

  input.addEventListener('keydown', (e) => {
    // Enter sends, shift-enter is a newline. Questions are one line far more
    // often than not.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) close();
  });
}
