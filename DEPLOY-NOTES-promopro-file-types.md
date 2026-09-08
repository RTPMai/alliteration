# PromoPro: CSV, Excel and Word on a purchase order

Sep 8, 2026. Fresh clone of RTPMai/alliteration (commit 79d8cee), re-cloned
before packaging, HEAD unchanged. Five files, one of them new, no new env
vars, no data migration.

**Suite: GREEN. 65 files, 2,175 checks, 0 failures.** It was green before at
2,159, so this adds 16.

---

## What you can attach now that you could not

CSV, Excel (.xls, .xlsx, .xlsm) and Word (.doc, .docx). Also .txt, and two
image formats that were quietly being refused:

- **.heic**, a photo taken on an iPhone. The picker has always offered these,
  because it said "any image", and the server had never heard of the type.
  Choosable, then refused, with nothing on screen explaining why.
- **.bmp**, same story.

Nothing that worked before stopped working. The catch-all that carries .dst,
.indd, .cdr and every other format a browser cannot name is still there and is
covered by a test that fails if anyone removes it.

## The part that is not just a longer list

There were **three** lists of accepted file types and they did not agree:

1. the `accept` string on the two file pickers in `apps/promopro.js`, which
   decides what the Open dialog offers,
2. `ALLOWED_TYPES` in `api/promopro/art-upload.js`, which decides what the
   server will sign an upload token for,
3. `guessType()` in `art-reconcile.js`, which names a file already in storage.

List 1 had `.indd` and `.cdr`. List 3 had never heard of either. List 1 said
"any image", list 2 had never heard of an iPhone photo. Adding three document
types to one of three lists would have left the same trap set for the next
person.

All three now read from **`lib/promopro/art-types.js`**, which is new. Adding
a file type is one line in one place. Same pattern as `poHealth()` in
PromoPro and `isOverStipend()` in CrewCore.

## One thing worth knowing about how browsers name files

The browser, not us, decides what type a chosen file reports, and it decides
differently on different machines. **A .csv is `text/csv` on a Mac,
`application/vnd.ms-excel` on a Windows box with Excel installed, and
`text/plain` on a machine with neither.** All three are accepted, or the same
file would upload from Hannah's desk and fail from Margo's. There is a test
for each.

## Two judgement calls, said plainly

**Macro-enabled workbooks (.xlsm) are accepted.** Blocking them while allowing
.xls would be arbitrary, since a .xls carries macros too. But be aware that
plenty of vendor mail filters quarantine or strip a macro-enabled workbook,
so if you are sending a size run to a vendor, **.csv or .xlsx will arrive and
.xlsm might not**. Nothing in the app can fix that end.

**Executables and video are still refused**, and there is a test that fails if
that ever stops being true.

## What this does NOT change

- 20 MB per file, 12 files per purchase order, unchanged.
- 25 MB of artwork total on a vendor email before the extras become expiring
  links, unchanged.
- Files are still served with `Content-Disposition: attachment`, so a
  spreadsheet downloads rather than rendering in a tab. That is what keeps an
  SVG (already accepted, long before this change) from being a problem.
- The security work from Aug 28 is untouched: a token still cannot be signed
  for a path outside the order's own folder.

---

## FILES

New: `lib/promopro/art-types.js`, `test/promopro-art-types.test.cjs`.
Changed: `api/promopro/art-upload.js`, `lib/promopro/art-reconcile.js`,
`apps/promopro.js`.

`apps/promopro.js` is 165 KB, so **this goes through git clone-and-push, never
the web uploader.**

Check the first line of each file after downloading, before it goes in:

| Save as | First line |
|---|---|
| `lib/promopro/art-types.js` | `// PUT IN: lib/promopro/art-types.js` |
| `apps/promopro.js` | `// PUT IN: apps/promopro.js` |
| `test/promopro-art-types.test.cjs` | `// test/promopro-art-types.test.cjs` |
| `api/promopro/art-upload.js` | `// api/promopro/art-upload.js — hand the browser a one-file upload token.` |
| `lib/promopro/art-reconcile.js` | `// lib/promopro/art-reconcile.js — storage is the truth about what artwork` |

## To deploy

Either copy the five files in over the top, keeping their paths, or apply the
patch, which is the same change and skips the renaming step:

    git clone https://github.com/RTPMai/alliteration.git
    cd alliteration
    git apply /path/to/promopro-file-types.patch
    bash test/run.sh        # must say SUITE GREEN
    git add -A && git commit -m "PromoPro: accept CSV, Excel and Word" && git push

Both routes were verified against a clean clone this session.

## Check after deploy

1. Open any purchase order, press **Attach artwork**. The dialog should now
   offer spreadsheets and documents without switching it to "All files."
2. Attach a **.csv** and a **.docx**. Both should upload and appear in the
   list with their real sizes.
3. Click the .csv in the list. It should download and open in Excel, not open
   as gibberish in a browser tab.
4. Attach a **photo straight off your phone**. This is the one that used to
   fail silently.
5. The hint line under the button should now name what is accepted before you
   press it.
6. Attach an artwork file the way you always have, .ai or .pdf. Unchanged.

## NO NEW ENVIRONMENT VARIABLES
