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

  return {
    id: inv.id ? String(inv.id) : null,
    invoiceNumber: inv.visualId != null ? String(inv.visualId) : null,
    customerName: textOf(firstOf(inv.contact || {}, ["fullName", "name"]))
      || textOf(firstOf(inv.customer || {}, ["companyName", "name"]))
      || "",
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

function invoiceQuery(lineFields) {
  return `
    query PromoProInvoice($id: ID!) {
      invoice(id: $id) {
        id
        visualId
        total
        customerDueAt
        status { id name }
        contact { fullName email }
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

/**
 * Search by invoice number or customer name. Printavo's `invoices` query
 * takes a free-text `query` argument, which covers both, so the front end
 * does not have to decide which kind of search this is.
 *
 * Deliberately asks for NO line-item fields. Search results only need enough
 * to pick the right job from a list, and every extra field is another chance
 * for one unknown name to fail the whole query. The detail comes later, in
 * getInvoice, where the fallback ladder can handle it.
 */
export async function searchInvoices(term, limit) {
  const q = `
    query PromoProSearch($q: String, $first: Int) {
      invoices(query: $q, first: $first) {
        nodes { id visualId total customerDueAt status { id name } contact { fullName } }
      }
    }
  `;
  const data = await gql(q, { q: String(term || "").trim(), first: Math.min(Number(limit) || 10, 25) });
  const nodes = nodesOf(data && data.invoices);
  return nodes.map((inv) => ({
    id: inv.id ? String(inv.id) : null,
    invoiceNumber: inv.visualId != null ? String(inv.visualId) : null,
    customerName: textOf(firstOf(inv.contact || {}, ["fullName", "name"])),
    dueDate: inv.customerDueAt ? String(inv.customerDueAt).slice(0, 10) : null,
    status: textOf(firstOf(inv.status || {}, ["name"])),
    total: Number(inv.total) || 0,
  }));
}

/**
 * One invoice, WITH line items. This is what autofill actually calls.
 *
 * Returns { invoice, via, tried } so a caller can say WHY nothing came back
 * instead of just handing over a null.
 */
export async function getInvoice(id) {
  const tried = [];

  for (const set of LINE_FIELD_SETS) {
    try {
      const data = await gql(invoiceQuery(set.fields), { id: String(id) });
      const invoice = normalizeInvoice(data && data.invoice);
      if (!invoice) {
        tried.push({ set: set.name, error: "Printavo returned no invoice for that id" });
        return { invoice: null, via: null, tried };
      }
      return { invoice, via: set.name, tried };
    } catch (e) {
      tried.push({ set: set.name, error: e.message });
      // Anything other than an unknown field is a real problem. Stop.
      if (!isFieldError(e.message)) break;
    }
  }

  return { invoice: null, via: null, tried };
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
  "LineItemSizeCount", "Imprint", "ImprintConnection", "Mockup",
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
