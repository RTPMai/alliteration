// PUT IN: js/return-to.js
/**
 * alliteration. — return-to
 *
 * Carries a deep link through the sign-in screen.
 *
 * WHY THIS EXISTS
 * A QR code on a printed PO opens #/promopro/orders/<id>. If the phone is not
 * signed in, the shell sends it to login.html. The part after # never reaches
 * the server and was not passed along, so after signing in the person landed
 * on the home screen with the PO number still in their hand. Same for any
 * bookmark or emailed link into the shell.
 *
 * THE RULE
 * Only a hash route of this app is ever accepted as a destination: "#/" then
 * plain route characters. Never a full URL, never another host, never a path.
 * A login page that bounces to whatever ?next= says is an open redirect,
 * which is how phishing links get a trustworthy-looking address.
 *
 * Pure functions, no DOM, so the tests call them directly.
 */

const MAX_LEN = 300;
// Letters, digits, and the characters a route or an encoded PO id can hold.
// No ':' (schemes), no '\' , no whitespace, no quotes, no '<' '>'.
const SAFE_ROUTE = /^#\/[A-Za-z0-9\-_.~%/]*$/;

/**
 * A hash worth coming back to, or '' if it is not one.
 * '' and '#/' alone are not worth carrying: that is just the home screen.
 */
export function safeReturnHash(hash) {
  const h = String(hash || '').trim();
  if (!h || h.length > MAX_LEN) return '';
  if (!SAFE_ROUTE.test(h)) return '';
  if (h === '#/' || h.includes('//')) return '';
  return h;
}

/** Where the shell sends a signed-out visitor, remembering where they were. */
export function loginUrlFor(hash) {
  const h = safeReturnHash(hash);
  return h ? 'login.html?next=' + encodeURIComponent(h) : 'login.html';
}

/** Where login.html goes after a successful sign-in. Always this site. */
export function afterLoginUrl(search) {
  let next = '';
  try {
    next = new URLSearchParams(String(search || '')).get('next') || '';
  } catch (e) {
    next = '';
  }
  const h = safeReturnHash(next);
  return h ? '/' + h : '/';
}
