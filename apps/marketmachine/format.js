// PUT IN: apps/marketmachine/format.js
/**
 * Formatting and escaping. Pure: no state, no DOM, no network, so every view
 * module can import it without a context.
 */

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export function fmtDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function fmtStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const PARTICIPATION_LABEL = {
  exhibitor: 'Exhibitor', attendee: 'Attendee', hybrid: 'Hybrid', not_attending: 'Do not attend'
};

export function fmtMoney(n) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const TRIP_STATUS_LABEL = {
  potential: 'Potential', confirmed: 'Confirmed', attended: 'Attended',
  did_not_attend: 'Did not attend', cancelled: 'Cancelled'
};

export function statusClass(label) {
  if (label === 'Complete') return 'ok';
  if (label === 'Cancelled') return 'mute';
  if (label === 'Not started') return 'mute';
  if (label === 'Ready to close') return 'ok';
  if (label === 'In prelaunch review') return 'src';
  return 'warn';
}

/**
 * Read "name https://..." lines into links. A line with no web address comes
 * back with an empty url so the caller can say it was left out, rather than
 * dropping it silently.
 */
export function parseLinks(text) {
  return String(text || '').split('\n').map((line) => {
    const t = line.trim();
    if (!t) return null;
    const m = t.match(/(https?:\/\/\S+)\s*$/i);
    if (!m) return { label: t, url: '' };
    return { label: t.slice(0, m.index).trim(), url: m[1] };
  }).filter(Boolean);
}

/**
 * The green or red line a screen shows after saving. Lives here, imported by
 * every screen that shows one.
 *
 * It was a local in index.js until Sept 2026, when the app was split into a
 * folder and five screens were left calling a function that was no longer in
 * scope. Clicking a campaign type threw, and so did opening a campaign. The
 * lesson is in the tests now: every screen is rendered for real, not just
 * checked for the names it calls through `ui`.
 */
export function msgBox(m) {
  if (!m) return '';
  return `<div class="${m.cls === 'ok' ? 'mk-ok' : 'mk-err'}">${esc(m.text)}</div>`;
}
