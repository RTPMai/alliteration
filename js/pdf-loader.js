/* js/pdf-loader.js */
/**
 * alliteration. — PDF rendering library loader.
 *
 * StitchSense needs to measure thread coverage on whatever a customer sends,
 * and a good share of that is vector: a PDF from a designer, or an .ai file
 * straight out of Illustrator.
 *
 * Same on-demand pattern as js/qrcode-loader.js. pdf.js is roughly a megabyte,
 * and only one view in one app ever touches it, so index.html must not pull it
 * in for everybody on every page view. It loads the first time somebody
 * actually drops a PDF.
 *
 * Classic script, not an ES module: the build on cdnjs defines a global.
 *
 * WHY A PDF IS A BETTER INPUT THAN A JPEG, which is not obvious:
 * rendering happens onto a transparent canvas, so anything the file does not
 * draw stays transparent. Coverage is then read from the alpha channel and is
 * exact, instead of being guessed by comparing pixels against a background
 * colour sampled from the corners. A vector file measured this way is the most
 * accurate customer input the estimator can get.
 */

const VERSION = '3.11.174';
const SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${VERSION}/pdf.min.js`;
const WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${VERSION}/pdf.worker.min.js`;

let loading = null;

/** Resolves to the pdfjsLib global. Safe to call repeatedly. */
export function loadPdfJs() {
  if (typeof window.pdfjsLib !== 'undefined') return Promise.resolve(window.pdfjsLib);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    const ready = () => {
      if (typeof window.pdfjsLib === 'undefined') {
        return reject(new Error('PDF library loaded but window.pdfjsLib is undefined'));
      }
      // The worker has to be pointed at explicitly or pdf.js tries to guess a
      // path relative to the page and fails silently on the first render.
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;
      resolve(window.pdfjsLib);
    };

    const existing = document.querySelector('script[data-lib="pdfjs"]');
    if (existing) {
      existing.addEventListener('load', ready);
      existing.addEventListener('error', () => reject(new Error('PDF library failed to load')));
      return;
    }

    const s = document.createElement('script');
    s.src = SRC;
    s.dataset.lib = 'pdfjs';
    s.onload = ready;
    s.onerror = () => reject(new Error('PDF library failed to load: ' + SRC));
    document.head.appendChild(s);
  });

  return loading;
}

export default { loadPdfJs };
