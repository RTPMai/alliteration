// PUT IN: lib/promopro/printavo-lookup.js (REPLACES the current one)
// (this banner line is for verification only, delete it after checking the path)

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
const LINE_FIELD_SETS = [
  { name: "full",     fields: "id description quantity color sizes styleNumber category { name }" },
  { name: "styled",   fields: "id description quantity color sizes style category { name }" },
  { name: "colored",  fields: "id description quantity color sizes" },
  { name: "basic",    fields: "id description quantity" },
  { name: "minimal",  fields: "id description" },
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
