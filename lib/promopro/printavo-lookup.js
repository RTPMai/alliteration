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

  const groups = nodesOf(inv.lineItemGroups);
  const lines = [];

  groups.forEach((g) => {
    const groupName = textOf(firstOf(g, ["name", "description"]));
    nodesOf(g.lineItems).forEach((li) => {
      const description = textOf(firstOf(li, ["description", "product", "style", "name"]));
      // The supplier's catalogue number, which is what the vendor keys off.
      // Printavo calls this different things depending on how the account
      // was set up, so take the first that exists rather than assuming.
      const itemNumber = textOf(firstOf(li, ["styleNumber", "itemNumber", "sku", "style", "productNumber"]));
      const qty = Number(firstOf(li, ["quantity", "qty", "itemQuantity"])) || 0;
      const color = textOf(firstOf(li, ["color", "colour"]));
      const sizes = textOf(firstOf(li, ["sizes", "size"]));
      const category = textOf(firstOf(li, ["category"]));

      const detailBits = [color, sizes].filter(Boolean);
      lines.push({
        printavoLineId: li && li.id ? String(li.id) : null,
        // Never let the item number duplicate the description: when Printavo
        // has no style field, "style" falls through to the same text as the
        // description, and two identical columns on a PO is noise.
        itemNumber: itemNumber && itemNumber !== description ? itemNumber : "",
        description: description || groupName || "Item",
        qty,
        // Deliberately zero. See the note above: this is OUR cost, which
        // Printavo does not know.
        unitCost: 0,
        detail: detailBits.join(" / "),
        imprint: groupName && groupName !== description ? groupName : "",
        category,
      });
    });
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
    lines,
  };
}

/* ------------------------------------------------------------------ *
 * QUERIES
 * ------------------------------------------------------------------ */

// Selecting the leaf fields by name. If an account calls them something else
// the read degrades to a blank description rather than throwing, and the
// buyer types over it. Worth revisiting with a probe if that ever happens.
const LINE_SELECTION = `
  lineItemGroups {
    nodes {
      id
      lineItems {
        nodes { id description quantity color sizes styleNumber category { name } }
      }
    }
  }
`;

const INVOICE_SELECTION = `
  id
  visualId
  total
  customerDueAt
  status { id name }
  contact { fullName email }
  ${LINE_SELECTION}
`;

/**
 * Search by invoice number or customer name. Printavo's `invoices` query
 * takes a free-text `query` argument, which covers both, so the front end
 * does not have to decide which kind of search this is.
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
  // Search results are the light shape: no line items, since nobody needs
  // them until one result is chosen.
  return nodes.map((inv) => ({
    id: inv.id ? String(inv.id) : null,
    invoiceNumber: inv.visualId != null ? String(inv.visualId) : null,
    customerName: textOf(firstOf(inv.contact || {}, ["fullName", "name"])),
    dueDate: inv.customerDueAt ? String(inv.customerDueAt).slice(0, 10) : null,
    status: textOf(firstOf(inv.status || {}, ["name"])),
    total: Number(inv.total) || 0,
  }));
}

/** One invoice, WITH line items. This is what autofill actually calls. */
export async function getInvoice(id) {
  const q = `
    query PromoProInvoice($id: ID!) {
      invoice(id: $id) { ${INVOICE_SELECTION} }
    }
  `;
  const data = await gql(q, { id: String(id) });
  return normalizeInvoice(data && data.invoice);
}
