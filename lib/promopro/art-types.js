// PUT IN: lib/promopro/art-types.js
// lib/promopro/art-types.js — the one list of what a purchase order accepts.
//
// WHY THIS FILE EXISTS
// There were three lists of file types and they did not agree:
//
//   1. the `accept` string on the two file pickers in apps/promopro.js,
//      which decides what the Open dialog offers you,
//   2. ALLOWED_TYPES in api/promopro/art-upload.js, which decides what the
//      server will sign an upload token for,
//   3. guessType() in art-reconcile.js, which names the type of a file
//      already sitting in storage.
//
// A file type in list 1 but not list 2 can be picked and then refused, which
// is what happened with a phone photo: the picker said `image/*`, the server
// had never heard of image/heic. A type in 2 but not 1 works only if you know
// to switch the dialog to "All files". So all three now read from here, and a
// new type is one line in one place.
//
// HOW A BROWSER NAMES A FILE, WHICH IS THE WHOLE PROBLEM
// The browser, not us, decides what content type a chosen file reports, and
// it decides differently on different machines. A .csv is text/csv on a Mac
// and application/vnd.ms-excel on a Windows box with Excel installed, and
// text/plain on a machine with neither. So each extension below lists every
// name it is known to arrive under. Refusing one of them is refusing the same
// file on somebody else's desk.
//
// application/octet-stream stays allowed on purpose. It is what a browser
// reports when it has no idea, which is how .indd, .cdr, .dst and every other
// production format gets through. Dropping it would break files that work
// today.
//
// ESM. Do NOT convert to module.exports.

/**
 * Every extension we accept, with the content types it is known to arrive as.
 *
 * `label` groups them for the file dialog and for anything that wants to
 * explain the list to a person.
 */
export const ART_KINDS = [
  // Design and production files. These are the originals.
  { ext: "ai", label: "design", types: ["application/illustrator", "application/postscript", "application/pdf"] },
  { ext: "eps", label: "design", types: ["application/postscript"] },
  { ext: "svg", label: "design", types: ["image/svg+xml"] },
  { ext: "psd", label: "design", types: ["image/vnd.adobe.photoshop", "application/x-photoshop"] },
  { ext: "pdf", label: "design", types: ["application/pdf"] },
  { ext: "indd", label: "design", types: ["application/x-indesign"] },
  { ext: "cdr", label: "design", types: ["application/x-coreldraw", "application/coreldraw"] },

  // Pictures. `image/*` on the picker means anything here can be chosen, so
  // anything the picker will offer has to be a type the server knows.
  { ext: "png", label: "image", types: ["image/png"] },
  { ext: "jpg", label: "image", types: ["image/jpeg", "image/jpg"] },
  { ext: "jpeg", label: "image", types: ["image/jpeg", "image/jpg"] },
  { ext: "gif", label: "image", types: ["image/gif"] },
  { ext: "webp", label: "image", types: ["image/webp"] },
  { ext: "bmp", label: "image", types: ["image/bmp", "image/x-ms-bmp"] },
  { ext: "tif", label: "image", types: ["image/tiff"] },
  { ext: "tiff", label: "image", types: ["image/tiff"] },
  // A photo taken on an iPhone. The picker has always offered these and the
  // server has always refused them.
  { ext: "heic", label: "image", types: ["image/heic", "image/heif"] },
  { ext: "heif", label: "image", types: ["image/heic", "image/heif"] },

  // Spreadsheets and documents. Size runs, name-and-number lists, a spec
  // sheet a customer sent as a Word file.
  { ext: "csv", label: "document", types: ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"] },
  { ext: "xls", label: "document", types: ["application/vnd.ms-excel"] },
  { ext: "xlsx", label: "document", types: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] },
  { ext: "xlsm", label: "document", types: ["application/vnd.ms-excel.sheet.macroEnabled.12"] },
  { ext: "doc", label: "document", types: ["application/msword"] },
  { ext: "docx", label: "document", types: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"] },
  { ext: "txt", label: "document", types: ["text/plain"] },

  // A folder of the above, which is how a customer usually sends more than
  // two files.
  { ext: "zip", label: "archive", types: ["application/zip", "application/x-zip-compressed", "multipart/x-zip"] },
];

/**
 * What the server will sign an upload token for.
 *
 * Built from ART_KINDS so it cannot fall behind the picker, plus the
 * catch-all. Order does not matter; the SDK does an exact match.
 */
export const ART_ALLOWED_TYPES = (() => {
  const seen = new Set();
  for (const k of ART_KINDS) for (const t of k.types) seen.add(t);
  // Anything a browser cannot name. This is what carries .dst, .emb, .indd
  // and every other format nobody has taught a browser about.
  seen.add("application/octet-stream");
  return Array.from(seen);
})();

/**
 * The same list, lowercased, for comparing against.
 *
 * Not the same as ART_ALLOWED_TYPES. The SDK's allowedContentTypes wants the
 * registered spelling, and one of these is genuinely mixed case:
 * application/vnd.ms-excel.sheet.macroEnabled.12, which is a macro-enabled
 * .xlsm. Lowercasing the incoming type and comparing it to the registered
 * spelling would refuse every one of those.
 */
const ART_ALLOWED_LOWER = new Set(ART_ALLOWED_TYPES.map((t) => t.toLowerCase()));

/** Is this something we will take? */
export function isAllowedArtType(contentType) {
  if (typeof contentType !== "string") return false;
  // Browsers append a charset on text types: "text/csv;charset=utf-8".
  const bare = contentType.split(";")[0].trim().toLowerCase();
  return ART_ALLOWED_LOWER.has(bare);
}

/**
 * The `accept` attribute for a file input.
 *
 * Extensions first so the dialog's own filter is precise, then `image/*` so
 * a phone offers its camera roll rather than a file browser. Every type
 * `image/*` can produce is in ART_ALLOWED_TYPES above, so the picker never
 * offers something the server then turns away.
 */
export const ART_ACCEPT = ART_KINDS
  .map((k) => "." + k.ext)
  .concat(["image/*", "application/pdf"])
  .join(",");

/**
 * What type is a file already in storage?
 *
 * Used when reconciling against the blob store, where the recorded type may
 * be missing. Falls back to the catch-all rather than guessing, because a
 * wrong Content-Type on the way back out is worse than an honest unknown:
 * the browser saves the file either way, and a wrong one makes it open in
 * the wrong program.
 */
export function artContentType(filename) {
  const ext = String(filename || "").toLowerCase().split(".").pop();
  const kind = ART_KINDS.find((k) => k.ext === ext);
  return kind ? kind.types[0] : "application/octet-stream";
}

/**
 * A short, readable version of the list for on-screen help.
 * Not the enforcement, just the explanation.
 */
export function artAcceptSummary() {
  return "Design files, images, PDFs, Word, Excel, CSV and ZIP archives.";
}
