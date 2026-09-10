// PUT IN: test/crewcore-sample-pdf.test.cjs
//
// CrewCore samples: reading SanMar's offer PDF.
//
// Every check calls the real exported function. Nothing here greps source
// text: a grep proves the letters are in the file, not that the code runs.

const t = require("./harness.cjs");

(async () => {
  const pdf = await import("../lib/crewcore/sample-pdf.js");
  const {
    MAX_PDF_BYTES, stripDataUrl, base64Bytes, looksLikePdf, rejectReason,
    buildPrompt, parseExtraction, extractionSummary,
  } = pdf;

  const b64 = (str) => Buffer.from(str, "latin1").toString("base64");
  const realPdf = b64("%PDF-1.7\n%\xE2\xE3\xCF\xD3\nrest of a file");
  const notPdf = b64("PK\x03\x04 this is a zip pretending");

  // ---- The file itself ----------------------------------------------------

  t.test("a data URL wrapper is stripped", () => {
    t.equal(stripDataUrl("data:application/pdf;base64,AAAA"), "AAAA");
    t.equal(stripDataUrl("AAAA"), "AAAA", "bare base64 passes through");
  });

  t.test("base64Bytes reports the real file size", () => {
    t.equal(base64Bytes(b64("abc")), 3);
    t.equal(base64Bytes(b64("ab")), 2, "one pad char");
    t.equal(base64Bytes(b64("a")), 1, "two pad chars");
    t.equal(base64Bytes(""), 0);
  });

  t.test("a PDF is judged on its own first bytes, not its name", () => {
    t.assert(looksLikePdf(realPdf), "%PDF- header is accepted");
    t.assert(!looksLikePdf(notPdf), "a renamed zip is refused");
    t.assert(looksLikePdf("data:application/pdf;base64," + realPdf),
      "the header check sees through a data URL");
  });

  t.test("a non-PDF is refused before any call is made", () => {
    const why = rejectReason(notPdf);
    t.assert(why, "refused");
    t.assert(/not a PDF/i.test(why), "says what is wrong: " + why);
    t.assert(/paste/i.test(why), "offers the manual path");
  });

  t.test("an empty attachment is refused", () => {
    t.assert(rejectReason(""), "nothing to read is refused");
  });

  t.test("an oversized PDF is refused with its size", () => {
    // A real header followed by enough filler to pass the cap.
    const big = "%PDF-1.7\n" + "x".repeat(MAX_PDF_BYTES + 1024);
    const why = rejectReason(b64(big));
    t.assert(why, "refused");
    t.assert(/MB/.test(why), "names the size: " + why);
  });

  t.test("a good PDF under the cap is accepted", () => {
    t.equal(rejectReason(realPdf), null);
  });

  // ---- The instruction ----------------------------------------------------

  t.test("the prompt asks for unsure rather than a guess", () => {
    const p = buildPrompt();
    t.assert(/unsure/.test(p), "an unsure bucket is requested");
    t.assert(/Do not guess/i.test(p), "guessing is refused");
    t.assert(/Never invent/i.test(p), "inventing a style is refused");
  });

  // ---- The reply ----------------------------------------------------------

  t.test("a clean reply becomes two lists", () => {
    const r = parseExtraction(JSON.stringify({
      fifty: ["PC61", "DT6105"], twentyfive: ["NF0A8JEV"], unsure: [], note: "",
    }));
    t.assert(r.ok, "parsed");
    t.equal(r.fifty.join(","), "PC61,DT6105");
    t.equal(r.twentyfive.join(","), "NF0A8JEV");
    t.equal(r.unsure.length, 0);
  });

  t.test("markdown fences do not break it", () => {
    const r = parseExtraction('```json\n{"fifty":["PC61"],"twentyfive":[]}\n```');
    t.assert(r.ok, "fences stripped");
    t.equal(r.fifty.join(","), "PC61");
  });

  t.test("style numbers are cleaned and deduped, headings dropped", () => {
    const r = parseExtraction(JSON.stringify({
      fifty: [" pc61 ", "PC61", "FLEECE", "K500LS", "", null, "DT6105."],
      twentyfive: [],
    }));
    t.assert(r.ok, "parsed");
    t.equal(r.fifty.join(","), "PC61,K500LS,DT6105",
      "uppercased, deduped, punctuation stripped, a digitless heading dropped");
  });

  t.test("a style claimed at both tiers lands in neither box", () => {
    const r = parseExtraction(JSON.stringify({
      fifty: ["PC61", "DT6105"], twentyfive: ["DT6105", "NF0A8JEV"],
    }));
    t.assert(r.ok, "parsed");
    t.assert(!r.fifty.includes("DT6105"), "not left in the 50% list");
    t.assert(!r.twentyfive.includes("DT6105"), "not left in the 25% list");
    t.assert(r.unsure.includes("DT6105"), "moved to unsure");
    t.equal(r.conflicts.join(","), "DT6105", "named as a conflict");
    t.equal(r.fifty.join(","), "PC61", "the rest of the list survives");
    t.equal(r.twentyfive.join(","), "NF0A8JEV");
  });

  t.test("a conflicted style is listed once, not twice", () => {
    const r = parseExtraction(JSON.stringify({
      fifty: ["DT6105"], twentyfive: ["DT6105"], unsure: ["DT6105"],
    }));
    t.assert(r.ok, "parsed");
    t.equal(r.unsure.filter((s) => s === "DT6105").length, 1);
  });

  t.test("an unreadable reply is refused, not returned empty", () => {
    const r = parseExtraction("Sorry, I could not read that file.");
    t.assert(!r.ok, "refused");
    t.assert(/not readable/i.test(r.error), r.error);
  });

  t.test("an empty reply is refused", () => {
    t.assert(!parseExtraction("").ok, "nothing back is refused");
    t.assert(!parseExtraction("   ").ok, "whitespace is refused");
  });

  t.test("a JSON array is not mistaken for a result", () => {
    t.assert(!parseExtraction('["PC61"]').ok, "a bare array is refused");
  });

  t.test("zero styles found is a refusal, not a success with empty boxes", () => {
    const r = parseExtraction(JSON.stringify({ fifty: [], twentyfive: [], unsure: [] }));
    t.assert(!r.ok, "refused");
    t.assert(/No style numbers were found/i.test(r.error), r.error);
  });

  // ---- The sentence under the button --------------------------------------

  t.test("the summary counts both tiers and never claims it is done", () => {
    const r = parseExtraction(JSON.stringify({
      fifty: ["PC61", "K500LS"], twentyfive: ["NF0A8JEV"],
    }));
    const line = extractionSummary(r);
    t.assert(/2 at 50%/.test(line), line);
    t.assert(/1 at 25%/.test(line), line);
    t.assert(/Check both boxes/i.test(line), "tells you to read it: " + line);
  });

  t.test("the summary spells out conflicts and unsure styles by name", () => {
    const r = parseExtraction(JSON.stringify({
      fifty: ["PC61", "DT6105"], twentyfive: ["DT6105"], unsure: ["BP45"],
    }));
    const line = extractionSummary(r);
    t.assert(/DT6105/.test(line), "conflict named: " + line);
    t.assert(/BP45/.test(line), "unsure named: " + line);
  });

  t.test("a failed read summarises as its own error", () => {
    const line = extractionSummary({ ok: false, error: "That file is not a PDF." });
    t.equal(line, "That file is not a PDF.");
  });

  process.exit(t.report());
})();
