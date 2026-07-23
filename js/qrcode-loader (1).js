/**
 * alliteration. — QR code library loader.
 *
 * ShopStock prints permanent QR labels, one per supply item, so a relabelled
 * bin still scans to the same record. That needs qrcodejs, which the standalone
 * app pulled in with a <script> tag in its <head>.
 *
 * The shell cannot do that: index.html would then load the library on every
 * page view for every user, including the four apps that never print a label.
 * So it loads on demand, the first time a QR is actually rendered.
 *
 * Same classic-script pattern as the engine and dial adapters: the library is
 * not an ES module, it defines a global.
 */

const SRC = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';

let loading = null;

/** Resolves to the QRCode constructor. Safe to call repeatedly. */
export function loadQRCode() {
  if (typeof window.QRCode !== 'undefined') return Promise.resolve(window.QRCode);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-lib="qrcode"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.QRCode));
      existing.addEventListener('error', () => reject(new Error('QR library failed to load')));
      return;
    }
    const s = document.createElement('script');
    s.src = SRC;
    s.dataset.lib = 'qrcode';
    s.onload = () => {
      if (typeof window.QRCode === 'undefined') {
        return reject(new Error('QR library loaded but window.QRCode is undefined'));
      }
      resolve(window.QRCode);
    };
    s.onerror = () => reject(new Error('QR library failed to load: ' + SRC));
    document.head.appendChild(s);
  });

  return loading;
}

export default { loadQRCode };
