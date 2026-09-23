// PUT IN: js/route-access.js
/**
 * alliteration. — route-access
 *
 * What to show when a link opens an app this account cannot use.
 *
 * WHY THIS EXISTS
 * A QR code on a printed PO opens PromoPro. Scanned by somebody without
 * PromoPro access, the shell used to quietly drop them into the first app
 * they DO have (ShopStock, for most of the shop floor). From the phone that
 * looks exactly like a broken QR code. Saying "you don't have PromoPro" turns
 * a mystery into a one-checkbox fix in Settings.
 *
 * Only for apps that exist. An unknown app id is a typo or a retired app,
 * and falling back quietly is still right for those.
 *
 * Pure, no DOM, so the tests call it directly.
 */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * @param {string} appName  the app they tried to open, e.g. 'PromoPro'
 * @param {{id:string,name:string,defaultView?:string}|null} home  first app they can open
 * @returns {{title:string, body:string}}  body is safe HTML
 */
export function noAccessMessage(appName, home) {
  const name = esc(appName || 'this app');
  let body = 'Your account does not have access to ' + name +
    '. An admin can turn it on in Settings, under Accounts.';
  if (home && home.id) {
    const href = '#/' + encodeURIComponent(home.id) +
      (home.defaultView ? '/' + encodeURIComponent(home.defaultView) : '');
    body += ' <a href="' + esc(href) + '">Go to ' + esc(home.name || home.id) + '</a>';
  }
  return { title: 'No access to ' + (appName || 'this app'), body };
}
