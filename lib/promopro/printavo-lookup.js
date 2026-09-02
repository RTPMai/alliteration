// lib/promopro/printavo-lookup.js — read ONE Printavo quote/invoice, with its
// real line items, so PromoPro can autofill a PO from it.
//
// WHY THIS EXISTS RATHER THAN READING BACKBONE'S SYNC:
// api/printavo-sync.js already walks line items, but it deliberately selects
// ONLY the category name and stores nothing but a per-invoice category
// histogram (row._categories -> top_categories). That is because it pages
// thousands of invoices at once and Printavo scores query complexity: pulling
// category AND product across a full reconcile blew past their 25k ceiling.
//
// PromoPro has the opposite shape. It reads ONE invoice, on demand, when
// somebody is looking at it. Complexity is a non-issue at n=1, so it can ask
// for the full detail the sync cannot afford: description, quantity, price,
// sizes, colors.
//
// lib/ never imports from api/, so the GraphQL call is re-implemented here
// rather than shared. It is a dozen lines and the two have genuinely
// different needs.
//
// ESM. Do NOT convert to module.exports.

const PRINTAVO_URL = "https://www.printavo.com/api/v2";

export function isConfigured() {
  return !!(process.env.PRINTAVO_API_TOKEN && process.env.PRINTAVO_EMAIL);
}

/**
 * One GraphQL call. Retries a 429 the same way the sync does, because
 * Printavo rate limits per email at 10 requests per 5 seconds and a user
 * clicking through search results will hit it.
 */
export async function gql(query, variables, _attempt = 0) {
  const token = process.env.PRINTAVO_API_TOKEN;
  const email = process.env.PRINTAVO_EMAIL;
  if (!token || !email) throw new Error("Printavo is not configured (PRINTAVO_API_TOKEN / PRINTAVO_EMAIL)");

  const r = await fetch(PRINTAVO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", email, token },
    body: JSON.stringify({ query, variables: variables || {} }),
  });

  if (r.status === 429) {
    if (_attempt >= 4) throw new Error("Printavo is rate limiting (429) after several retries");
    const retryAfter = parseInt(r.headers.get("retry-after") || "", 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(8000, 1500 * Math.pow(2, _attempt));
    await new Promise((res) => setTimeout(res, waitMs));
    return gql(query, variables, _attempt + 1);
  }

  if (!r.ok) throw new Error(`Printavo HTTP ${r.status}`);
  const json = await r.json();
  if (json.errors) {
    const msg = json.errors.map((e) => e.message).join(", ");
    if (/timeout/i.test(msg) && _attempt < 3) {
      await new Promise((res) => setTimeout(res, 1500 * Math.pow(2, _attempt)));
      return gql(query, variables, _attempt + 1);
    }
    throw new Error(msg);
  }
  return json.data;
}

/* ------------------------------------------------------------------ *
 * A QUOTE IS NOT AN INVOICE
 *
 * Printavo keeps the two as separate types with separate root queries. This
 * file only ever asked `invoices`, so a job that had not been invoiced yet
 * could not be found AT ALL: searching 66290 answered "Nothing matched"
 * while the quote sat open in Printavo. The form has always said "Find the
 * Printavo quote or invoice" and only half of it was true. Worse, the same
 * search starts working by itself the day the quote gets invoiced, which
 * makes it look intermittent rather than missing.
 *
 * Rather than swap one guess for another, ask the schema once and cache it.
 * One introspection call answers which roots exist, which arguments they
 * take, and which fields each type carries, so a quote is queried with the
 * fields a quote has instead of the ones an invoice has. Guessed field names
 * have already cost this app two round trips (`styleNumber`, `name` on
 * Imprint).
 *
 * If introspection fails, or answers something unrecognisable, NOTHING is
 * assumed: every root is attempted and a field error just skips that rung,
 * which is how the rest of this file already behaves.
 * ------------------------------------------------------------------ */

const SCHEMA_TTL_MS = 10 * 60 * 1000;
let _schema = null;
let _schemaAt = 0;
let _schemaInFlight = null;

/** Tests call this so one fake account cannot leak into the next. */
export function _resetSchemaCache() {
  _schema = null;
  _schemaAt = 0;
  _schemaInFlight = null;
}

function fieldNamesOf(t) {
  return ((t && t.fields) || []).map((f) => f && f.name).filter(Boolean);
}

export async function discoverSchema() {
  if (_schema && Date.now() - _schemaAt < SCHEMA_TTL_MS) return _schema;
  // One request even if six lookups start at once on a cold function.
  if (_schemaInFlight) return _schemaInFlight;

  _schemaInFlight = (async () => {
    const q = `
      query PromoProRoots {
        root: __type(name: "Query") { fields { name args { name } } }
        quote: __type(name: "Quote") { fields { name } }
        invoice: __type(name: "Invoice") { fields { name } }
      }
    `;
    let out;
    try {
      const data = await gql(q);
      const fields = (data && data.root && data.root.fields) || [];
      if (!fields.length) {
        // A well-formed answer carrying nothing tells us nothing. Unknown,
        // not "this account has no root queries": the second reading would
        // refuse to search anything at all.
        out = { known: false, reason: "introspection returned no root fields", roots: null, typeFields: {} };
      } else {
        const roots = {};
        fields.forEach((f) => {
          roots[f.name] = ((f && f.args) || []).map((a) => a && a.name).filter(Boolean);
        });
        out = {
          known: true,
          roots,
          typeFields: {
            quote: fieldNamesOf(data && data.quote),
            invoice: fieldNamesOf(data && data.invoice),
          },
        };
      }
    } catch (e) {
      out = { known: false, reason: e.message, roots: null, typeFields: {} };
    }
    _schema = out;
    _schemaAt = Date.now();
    _schemaInFlight = null;
    return out;
  })();

  return _schemaInFlight;
}

/**
 * Is this root worth asking? Unknown means YES. Attempting it costs one
 * request and a field error is already handled; skipping it is how a whole
 * class of job went missing in the first place.
 */
function rootAvailable(schema, name, needsArg) {
  if (!schema || !schema.known || !schema.roots) return true;
  const args = schema.roots[name];
  if (!args) return false;
  return !needsArg || args.includes(needsArg);
}

/** Does this type carry this field? Unknown means yes, same reasoning. */
function typeHas(schema, kind, field) {
  const known = schema && schema.typeFields && schema.typeFields[kind];
  if (!Array.isArray(known) || !known.length) return true;
  return known.includes(field);
}

/** Has the schema actually told us about this type, or are we guessing? */
function typeKnown(schema, kind) {
  const known = schema && schema.typeFields && schema.typeFields[kind];
  return Array.isArray(known) && known.length > 0;
}

/**
 * The header fields a PO needs off a quote or an invoice, asked for only
 * when the type really has them. GraphQL validates the whole query first, so
 * one field a Quote does not carry would fail the lookup completely and send
 * somebody back to typing the order in by hand.
 */
function headerSelection(schema, kind) {
  const parts = ["id", "__typename"];
  ["visualId", "total", "customerDueAt"].forEach((f) => {
    if (typeHas(schema, kind, f)) parts.push(f);
  });
  if (typeHas(schema, kind, "status")) parts.push("status { id name }");
  return parts.join(" ");
}

/**
 * A GraphQL complaint about an ARGUMENT rather than a field. `quotes` might
 * not take the same free-text `query` argument `invoices` does, and that
 * reads as a different message, so it needs its own test or the ladder would
 * treat a fixable difference as a real outage.
 */
function isArgError(message) {
  return /unknown argument|argument .{0,40}(is not defined|does not exist|not supported)|is not defined by/i
    .test(String(message || ""));
}

function isSchemaError(message) {
  return isFieldError(message) || isArgError(message);
}

/* ------------------------------------------------------------------ *
 * NORMALIZING
 *
 * Printavo's line items live at
 *   invoice.lineItemGroups.nodes[].lineItems.nodes[]
 * (confirmed by the sync's probe-lineitems mode). Field names on the leaf
 * vary by account configuration, so every read is defensive: take the first
 * field that exists rather than assuming one name. A missing price is 0, not
 * a crash, because a quote line with no cost yet is normal.
 * ------------------------------------------------------------------ */

function firstOf(obj, names) {
  if (!obj || typeof obj !== "object") return null;
  for (const n of names) {
    const v = obj[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function nodesOf(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (Array.isArray(v.nodes)) return v.nodes;
  if (Array.isArray(v.edges)) return v.edges.map((e) => e && e.node).filter(Boolean);
  return [];
}

function textOf(v) {
  if (v == null) return "";
  if (typeof v === "object") return String(firstOf(v, ["name", "description", "title"]) || "");
  return String(v);
}

/**
 * Turn a Printavo invoice into the shape PromoPro's PO form wants.
 *
 * Note what this does NOT do: it does not copy the customer's PRICE onto the
 * PO. Printavo holds what we charge; a PO holds what the vendor charges us.
 * Copying the sell price into a cost field would look filled-in and be wrong,
 * which is worse than blank. unitCost comes back 0 and the buyer types it.
 */
export function normalizeInvoice(inv) {
  if (!inv) return null;

  const groups = nodesOf(inv.lineItemGroups).map((g, i) => {
    const lines = nodesOf(g.lineItems).map((li) => {
      const description = textOf(firstOf(li, ["description", "product", "style", "name"]));
      // Confirmed field name on this account.
      const itemNumber = textOf(firstOf(li, ["itemNumber", "styleNumber", "sku", "productNumber"]));
      // `items` first: that is what this account calls the quantity. The
      // others are fallbacks for a differently configured Printavo.
      const qty = Number(firstOf(li, ["items", "quantity", "qty", "itemQuantity"])) || 0;
      const color = textOf(firstOf(li, ["color", "colour"]));
      const category = textOf(firstOf(li, ["category"]));

      return {
        printavoLineId: li && li.id ? String(li.id) : null,
        itemNumber: itemNumber && itemNumber !== description ? itemNumber : "",
        description: description || "Item",
        qty,
        // Deliberately zero. Printavo holds what we CHARGE; a PO holds what
        // the vendor charges US. A filled-in wrong number is worse than a
        // blank one, because nobody re-checks a field that looks answered.
        unitCost: 0,
        detail: color,
        imprint: "",
        category,
        merch: li && li.merch === true,
      };
    });

    // The imprint's number on the job. `position` is Printavo's own ordering
    // for the group; falling back to the array index keeps a number available
    // even if position is absent, but position is what the PO suffix should
    // use.
    const position = Number(firstOf(g, ["position"]));
    const imprintNumber = Number.isFinite(position) && position > 0 ? position : i + 1;

    // Distinct categories present in this imprint. This is what tells promo
    // apart from garments, and it is surfaced rather than filtered on here:
    // which categories count as promo is a shop decision that belongs in
    // Settings, not a guess baked into a lookup.
    const categories = [];
    lines.forEach((l) => {
      if (l.category && !categories.includes(l.category)) categories.push(l.category);
    });

    return {
      id: g && g.id ? String(g.id) : `group-${i + 1}`,
      imprintNumber,
      categories,
      anyMerch: lines.some((l) => l.merch),
      lines,
    };
  });

  // WHO THE JOB IS FOR, kept as two separate facts.
  //
  // Printavo hangs an invoice off a CONTACT, a person, and that person hangs
  // off a CUSTOMER, the company. Asking only for the contact is how "Jill
  // Stevents" ended up on a pipeline card and an emailed purchase order where
  // "Hy-Vee" belonged. A vendor reading a PO needs to know which company the
  // goods are for; the buyer's own name is the smaller fact.
  //
  // `customerName` stays as the ONE name to show, company first, so every
  // screen that already reads it starts showing the company without being
  // touched. It falls back to the person, because a genuine individual buyer
  // has no company and a blank name is worse than a personal one.
  const company = textOf(firstOf((inv.contact && inv.contact.customer) || inv.customer || {}, ["companyName", "company", "name"]));
  const person = textOf(firstOf(inv.contact || {}, ["fullName", "name"]));

  return {
    id: inv.id ? String(inv.id) : null,
    // Which of the two this is. A PO raised off a quote and one raised off
    // an invoice are the same document to a vendor, but the screen has to be
    // able to SAY which, because "66290 is only a quote" is a real answer to
    // "why can I not find it".
    kind: String(inv.__typename || "").toLowerCase() === "quote" ? "quote" : "invoice",
    invoiceNumber: inv.visualId != null ? String(inv.visualId) : null,
    companyName: company,
    contactName: person,
    customerName: company || person || "",
    dueDate: inv.customerDueAt ? String(inv.customerDueAt).slice(0, 10) : null,
    status: textOf(firstOf(inv.status || {}, ["name"])),
    total: Number(inv.total) || 0,
    groups,
    // Every category on the invoice, so the Settings screen can offer them
    // as ticks rather than asking anyone to type a category name exactly.
    categories: groups.reduce((acc, g) => {
      g.categories.forEach((c) => { if (!acc.includes(c)) acc.push(c); });
      return acc;
    }, []),
    // Kept flat as well, so nothing that already reads inv.lines breaks.
    lines: groups.reduce((acc, g) => acc.concat(g.lines), []),
  };
}

/**
 * Which imprints on this invoice are promo, according to the shop's own
 * category list. Returns every group when nothing has been configured yet,
 * because showing everything with a "tell me which of these are promo"
 * prompt beats showing an empty list and looking broken.
 */
export function promoGroups(invoice, promoCategories) {
  const groups = (invoice && invoice.groups) || [];
  const wanted = (promoCategories || []).map((c) => String(c).toLowerCase());
  if (!wanted.length) return { groups, matched: false };
  const hit = groups.filter((g) => g.categories.some((c) => wanted.includes(String(c).toLowerCase())));
  return { groups: hit, matched: true };
}

/* ------------------------------------------------------------------ *
 * QUERIES
 * ------------------------------------------------------------------ */

// LINE-ITEM FIELD SETS, MOST DETAILED FIRST.
//
// GraphQL validates the whole query before running it: ONE field name this
// Printavo account does not have makes the entire request fail, and the
// invoice comes back null. Line-item leaf names vary by how an account was
// configured, and there is no way to know from here which ones exist.
//
// So rather than guess once and fail completely, try the richest selection
// and step down on a validation error until one works. Worst case the buyer
// gets descriptions and quantities and types the rest, which is still far
// better than a button that does nothing.
//
// The set that succeeded is reported back as `via`, so the first real lookup
// tells us this account's actual shape and the guessing can stop.
// CONFIRMED against pmapparel's account by the schema probe, Aug 2026.
// Do not add a field to this list without probing first: GraphQL validates
// the whole query before running it, so one name this account does not have
// makes the entire request fail and the invoice comes back empty. That is
// exactly what `styleNumber` did.
//
// Two things worth knowing, both surprising:
//   - There is NO `quantity` field. The quantity is `items`.
//   - The item number is `itemNumber`, not `styleNumber` or `sku`.
//
// The ladder stays as insurance, but the top rung is now real rather than a
// guess, so it should never need to step down here.
const LINE_FIELD_SETS = [
  { name: "full",    fields: "id description itemNumber items color position price merch category { id name }" },
  { name: "basic",   fields: "id description itemNumber items" },
  { name: "minimal", fields: "id description" },
];

// WHO THE JOB IS FOR, AS A LADDER OF ITS OWN.
//
// The company name is not on the invoice. It is on the Customer that the
// invoice's Contact belongs to, and that nesting has NOT been probed on this
// account the way the line-item fields were. GraphQL validates the whole
// query before running it, so one wrong name here would not degrade the
// company name, it would return no invoice at all and break autofill
// completely. That is exactly what `styleNumber` did to the line items.
//
// So the same trick the line fields already use: ask for the richest shape,
// step down on a validation error. The LAST rung is the query as it stood
// before any of this, which makes the worst case "no company name, same as
// yesterday" rather than a broken lookup.
//
// Which rung worked comes back as `partyVia`, so the first real lookup after
// deploy settles the shape and the ladder can be trimmed to the true one.
const PARTY_FIELD_SETS = [
  { name: "company",      fields: "contact { fullName email customer { id companyName } }" },
  { name: "company-name", fields: "contact { fullName email customer { id name } }" },
  { name: "contact-only", fields: "contact { fullName email }" },
];

function orderQuery(root, header, lineFields, partyFields) {
  return `
    query PromoProOrder($id: ID!) {
      ${root}(id: $id) {
        ${header}
        ${partyFields}
        lineItemGroups {
          nodes {
            id
            position
            lineItems { nodes { ${lineFields} } }
          }
        }
      }
    }
  `;
}

/**
 * A GraphQL error that means "that field does not exist here", as opposed to
 * a real failure like a bad id or an outage. Only the former is worth
 * retrying with fewer fields; retrying an auth error five times just wastes
 * five requests and hits the rate limiter.
 */
function isFieldError(message) {
  return /doesn't exist|does not exist|Cannot query field|undefinedField|no field/i.test(String(message || ""));
}

// WHO THE JOB IS FOR, IN THE PICKER TOO.
//
// Same reasoning as the detail ladder, smaller: the picker lists jobs by who
// they are for, and listing them by contact is what sends somebody hunting
// for a company name that is not on screen. The last rung is the query as it
// stood before any of this, so an account without the nesting still searches.
const SEARCH_PARTY_SETS = [
  "contact { fullName customer { id companyName } }",
  "contact { fullName customer { id name } }",
  "contact { fullName }",
];

// BOTH ROOTS. `quotes` is the one that was missing: a job that has not been
// invoiced yet exists only there, which is why 66290 could not be found.
const SEARCH_ROOTS = [
  { root: "invoices", kind: "invoice" },
  { root: "quotes", kind: "quote" },
];

/** One picker row, from either root. */
function searchRow(row, kind) {
  const company = textOf(firstOf((row.contact && row.contact.customer) || {}, ["companyName", "company", "name"]));
  const person = textOf(firstOf(row.contact || {}, ["fullName", "name"]));
  const typed = String(row.__typename || "").toLowerCase();
  return {
    id: row.id ? String(row.id) : null,
    // Printavo's own word for it when it says one, our root when it does not.
    kind: typed === "quote" || typed === "invoice" ? typed : kind,
    invoiceNumber: row.visualId != null ? String(row.visualId) : null,
    companyName: company,
    contactName: person,
    customerName: company || person || "",
    dueDate: row.customerDueAt ? String(row.customerDueAt).slice(0, 10) : null,
    status: textOf(firstOf(row.status || {}, ["name"])),
    total: Number(row.total) || 0,
  };
}

/**
 * One root, asked as richly as the schema allows. With the schema in hand
 * this is a single request; without it, step down the same way every other
 * read in this file does.
 */
async function searchOneRoot(schema, spec, term, first) {
  const headers = typeKnown(schema, spec.kind)
    ? [headerSelection(schema, spec.kind)]
    : [
        headerSelection(null, spec.kind),
        "id __typename visualId total status { id name }",
        "id __typename visualId",
      ];

  let lastError = null;
  for (const header of headers) {
    for (const party of SEARCH_PARTY_SETS) {
      const q = `
        query PromoProSearch($q: String, $first: Int) {
          ${spec.root}(query: $q, first: $first) {
            nodes { ${header} ${party} }
          }
        }
      `;
      try {
        const data = await gql(q, { q: term, first });
        return { results: nodesOf(data && data[spec.root]).map((row) => searchRow(row, spec.kind)) };
      } catch (e) {
        lastError = e;
        // A real failure (auth, outage, rate limit) is not something to retry
        // with fewer fields: it spends requests to learn what the first one
        // already said.
        if (!isSchemaError(e.message)) return { error: e.message };
      }
    }
  }
  return { error: (lastError && lastError.message) || "search failed" };
}

/**
 * Search quotes AND invoices by number or customer name. Printavo's `query`
 * argument is free text, so the front end does not have to decide which kind
 * of search this is, or which kind of document the number belongs to.
 *
 * Returns { results, searched, unavailable } rather than a bare array: an
 * empty list means opposite things depending on whether both roots answered,
 * and the screen has to be able to tell "Printavo has no such job" apart
 * from "half of Printavo did not answer".
 *
 * Deliberately asks for NO line-item fields. A picker row only needs enough
 * to choose from, and every extra field is another chance for one unknown
 * name to fail the whole query. Detail comes later, in getOrder.
 */
export async function searchOrders(term, limit) {
  const text = String(term || "").trim();
  const first = Math.min(Number(limit) || 10, 25);
  if (!text) return { results: [], searched: [], unavailable: [] };

  const schema = await discoverSchema();
  const searched = [];
  const unavailable = [];
  const wanted = [];

  SEARCH_ROOTS.forEach((spec) => {
    if (rootAvailable(schema, spec.root, "query")) wanted.push(spec);
    else unavailable.push({ root: spec.root, reason: "this Printavo account has no " + spec.root + " search" });
  });

  // Independent, so one root having a bad day costs its own results and not
  // the other's. Invoice results that came back are still worth showing when
  // the quote search is down; answering "nothing matched" instead is how
  // somebody comes to trust a wrong answer.
  const settled = await Promise.all(wanted.map(async (spec) => {
    try {
      return { spec, out: await searchOneRoot(schema, spec, text, first) };
    } catch (e) {
      return { spec, out: { error: e.message } };
    }
  }));

  const results = [];
  const seen = new Set();
  settled.forEach(({ spec, out }) => {
    if (out.error) {
      unavailable.push({ root: spec.root, reason: out.error });
      return;
    }
    searched.push(spec.root);
    out.results.forEach((r) => {
      const key = r.id || r.kind + ":" + r.invoiceNumber;
      if (seen.has(key)) return;
      seen.add(key);
      results.push(r);
    });
  });

  // Nothing answered at all is a FAILURE, not an empty result. The two call
  // for opposite next steps and must never be shown the same way.
  if (!searched.length) {
    throw new Error(unavailable.map((u) => u.root + ": " + u.reason).join("; ") || "Printavo search failed");
  }

  // The number somebody typed is nearly always the one they want, so an exact
  // match on the job number leads whichever root it came from.
  results.sort((a, b) => {
    const ax = a.invoiceNumber === text ? 0 : 1;
    const bx = b.invoiceNumber === text ? 0 : 1;
    if (ax !== bx) return ax - bx;
    return (Number(b.invoiceNumber) || 0) - (Number(a.invoiceNumber) || 0);
  });

  return { results, searched, unavailable };
}

/* ------------------------------------------------------------------ *
 * IMPRINTS
 *
 * Printavo shows an imprint as a labelled block: "IMPRINT #66608-9" with the
 * work underneath, e.g. "Laser Engraved // 023-185". That text is what the
 * vendor needs on the PO, and it also confirms the numbering: Printavo's own
 * label for that imprint is 66608-9.
 *
 * Fetched in a SEPARATE request from the line items, deliberately. One
 * unknown field name fails an entire GraphQL query, and the Imprint type's
 * fields have not been probed on this account. Keeping it apart means a
 * miss costs the imprint text and nothing else: the lines, quantities and
 * item numbers still come through.
 * ------------------------------------------------------------------ */

// CONFIRMED by probe, Aug 2026. Imprint on this account has `details`
// (String) and `typeOfWork` (an OBJECT, so it needs a sub-selection). There
// is NO `name` field, which is what my first guess asked for: every rung of
// the old ladder named it, so all of them failed and the last rung, `id`
// alone, "succeeded" while carrying no text at all. A fallback that lands on
// a rung with nothing useful on it is not a fallback.
const IMPRINT_FIELD_SETS = [
  { name: "full",    fields: "id details typeOfWork { id name }" },
  { name: "typed",   fields: "id details typeOfWork { name }" },
  { name: "details", fields: "id details" },
];

/** One readable line from whatever the imprint carries. */
function imprintText(im) {
  const bits = [];
  // typeOfWork is an object; textOf pulls its name. This is the "Laser
  // Engraved" half of what Printavo shows.
  const type = textOf(firstOf(im, ["typeOfWork", "type"]));
  const details = textOf(firstOf(im, ["details", "description", "notes"]));
  [type, details].forEach((b) => {
    if (b && !bits.includes(b)) bits.push(b);
  });
  return bits.join(" // ");
}

/**
 * Imprint text per line-item group, keyed by group id. Never throws: an
 * empty map just means the PO carries no imprint description, which is a
 * degraded result rather than a failure.
 */
export async function getImprints(id, root) {
  const from = root || "invoice";
  for (const set of IMPRINT_FIELD_SETS) {
    const q = `
      query PromoProImprints($id: ID!) {
        ${from}(id: $id) {
          id
          lineItemGroups { nodes { id imprints { nodes { ${set.fields} } } } }
        }
      }
    `;
    try {
      const data = await gql(q, { id: String(id) });
      const out = {};
      nodesOf(data && data[from] && data[from].lineItemGroups).forEach((g) => {
        const texts = nodesOf(g.imprints).map(imprintText).filter(Boolean);
        if (texts.length) out[String(g.id)] = texts.join(" / ");
      });
      return { imprints: out, via: set.name };
    } catch (e) {
      if (!isFieldError(e.message)) return { imprints: {}, via: null, error: e.message };
    }
  }
  return { imprints: {}, via: null };
}

// The two roots that hand back one document by id, invoices first: most POs
// are raised off an invoiced job, and a search result says which it is
// anyway.
const DETAIL_ROOTS = [
  { root: "invoice", kind: "invoice" },
  { root: "quote", kind: "quote" },
];

/**
 * One root, both ladders. Answers the finished result, a stop (a real
 * failure worth reporting rather than working around), or null meaning
 * "not this one, try the other".
 */
async function getFromRoot(schema, spec, id, tried) {
  const header = headerSelection(schema, spec.kind);

  // Two ladders, party outside lines. A field error cannot say WHICH part of
  // the query it objected to, so the inner ladder is exhausted before blaming
  // the outer one. Normally the top rung of each works and this is one
  // request.
  for (const party of PARTY_FIELD_SETS) {
    for (const set of LINE_FIELD_SETS) {
      try {
        const data = await gql(orderQuery(spec.root, header, set.fields, party.fields), { id: String(id) });
        const raw = data && data[spec.root];
        if (!raw) {
          // A quote id asked of `invoice` comes back empty. That is the normal
          // way to learn which of the two it is, so it moves on to the other
          // root instead of reporting a dead end the way it used to.
          tried.push({ root: spec.root, set: set.name, party: party.name, error: "Printavo returned no " + spec.root + " for that id" });
          return null;
        }

        const invoice = normalizeInvoice(raw);
        if (!raw.__typename) invoice.kind = spec.kind;

        // Best effort. No imprint text is a smaller loss than no order.
        const im = await getImprints(id, spec.root);
        invoice.groups.forEach((g) => {
          const text = im.imprints[g.id] || "";
          g.imprintText = text;
          g.lines.forEach((l) => { l.imprint = text; });
        });

        return { invoice, kind: invoice.kind, via: set.name, partyVia: party.name, imprintVia: im.via, tried };
      } catch (e) {
        tried.push({ root: spec.root, set: set.name, party: party.name, error: e.message });
        // Anything other than an unknown field is a real problem. Stop
        // everything, not just this rung: retrying an auth error six times
        // spends six requests to learn what the first one said.
        if (!isSchemaError(e.message)) return { invoice: null, via: null, partyVia: null, tried };
      }
    }
  }
  return null;
}

/**
 * One order, quote or invoice, WITH line items. This is what autofill calls.
 *
 * `kind` is the hint off the search result, so the right root is asked first
 * and the other is only a fallback. Getting it wrong costs one extra request,
 * not a failure.
 *
 * Returns { invoice, kind, via, tried } so a caller can say WHY nothing came
 * back instead of just handing over a null.
 */
export async function getOrder(id, kind) {
  const tried = [];
  const schema = await discoverSchema();

  let roots = DETAIL_ROOTS.filter((r) => rootAvailable(schema, r.root, "id"));
  if (String(kind || "").toLowerCase() === "quote") {
    roots = roots.slice().sort((a, b) => (a.kind === "quote" ? -1 : b.kind === "quote" ? 1 : 0));
  }
  if (!roots.length) {
    return { invoice: null, via: null, partyVia: null, tried: [{ error: "This Printavo account exposes neither an invoice nor a quote by id" }] };
  }

  for (const spec of roots) {
    const res = await getFromRoot(schema, spec, id, tried);
    if (res) return res;
  }

  return { invoice: null, via: null, partyVia: null, tried };
}

/* ------------------------------------------------------------------ *
 * SCHEMA PROBE
 *
 * Read-only. Answers three questions that cannot be guessed from here:
 *   1. what a line item on THIS account is actually called field by field
 *      (so the item number stops being a guess)
 *   2. what a line item GROUP carries (so imprints can be numbered)
 *   3. what the real data looks like for one invoice
 *
 * Same __type introspection api/printavo-sync.js already uses for its
 * probe-* modes. Nothing here writes anything.
 * ------------------------------------------------------------------ */

const SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID", "ISO8601DateTime"]);

// Types worth expanding one level when they appear as a field. Anything not
// listed is skipped rather than guessed at.
const PROBE_TYPES = [
  "LineItem", "LineItemGroup", "Category", "Product",
  "LineItemSizeCount", "Imprint", "ImprintConnection", "TypeOfWork", "Personalization",
];

export async function probeTypes(names) {
  const out = {};
  for (const typeName of (names || PROBE_TYPES)) {
    try {
      const data = await gql(`query{__type(name:"${typeName}"){fields{name type{name kind ofType{name kind ofType{name kind}}}}}}`);
      const t = data && data.__type;
      if (!t) { out[typeName] = { error: "type not found" }; continue; }
      out[typeName] = (t.fields || []).map((f) => {
        // Unwrap NON_NULL / LIST wrappers to find the real type name.
        let ty = f.type;
        let depth = 0;
        while (ty && !ty.name && ty.ofType && depth < 3) { ty = ty.ofType; depth++; }
        return { name: f.name, type: (ty && ty.name) || (f.type && f.type.kind) || "?" };
      });
    } catch (e) {
      out[typeName] = { error: e.message };
    }
  }
  return out;
}

/** Scalar field names for a probed type. */
function scalarsOf(types, typeName) {
  const fields = (types && types[typeName]) || [];
  if (!Array.isArray(fields)) return [];
  return fields.filter((f) => SCALARS.has(f.type)).map((f) => f.name);
}

/**
 * Build a selection for a type using only fields the probe confirmed, and
 * expand a known object field one level using ITS scalars.
 *
 * This is why the first probe failed: it asked for `sizes` and
 * `enabledColumns` bare, and GraphQL refuses an object field with no
 * sub-selection. Building the query FROM the schema rather than from a guess
 * means that cannot happen again.
 */
function selectionFor(types, typeName, expand) {
  const fields = (types && types[typeName]) || [];
  if (!Array.isArray(fields)) return "id";
  const parts = [];
  fields.forEach((f) => {
    if (SCALARS.has(f.type)) { parts.push(f.name); return; }
    if (expand && expand[f.name]) {
      const sub = scalarsOf(types, f.type);
      if (sub.length) parts.push(`${f.name} { ${sub.join(" ")} }`);
    }
  });
  return parts.length ? parts.join(" ") : "id";
}

/**
 * Everything on one invoice, using ONLY confirmed field names, with object
 * fields expanded one level. Read-only.
 */
export async function probeInvoice(id, types) {
  const itemSel = selectionFor(types, "LineItem", {
    category: true, product: true, sizes: true,
  });
  const groupSel = selectionFor(types, "LineItemGroup", {});
  const imprintScalars = scalarsOf(types, "Imprint");
  const imprintSel = imprintScalars.length
    ? ` imprints { nodes { ${imprintScalars.join(" ")} } }`
    : "";

  const q = `
    query PromoProProbe($id: ID!) {
      invoice(id: $id) {
        id
        visualId
        lineItemGroups {
          nodes {
            ${groupSel}${imprintSel}
            lineItems { nodes { ${itemSel} } }
          }
        }
      }
    }
  `;
  const data = await gql(q, { id: String(id) });
  return { invoice: data && data.invoice, query: q };
}
