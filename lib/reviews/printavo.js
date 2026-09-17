// PUT IN: lib/reviews/printavo.js
// lib/reviews/printavo.js: find orders sitting at a trigger status.
//
// PRINTAVO DOES NOT SAY WHEN A STATUS CHANGED. It stores the current status
// and nothing about the moment it moved. So this file answers a narrower
// question, "which invoices are at PICKED-UP or ORDER SHIPPED right now", and
// lib/reviews/engine.js remembers what it has already seen. The first check
// that finds an order there is its pickup moment, to within a few hours.
//
// Field and argument names are ASKED of Printavo's schema, never assumed, the
// same way api/printavo-sync.js and lib/promopro/printavo-lookup.js work.
// Guessed names have already cost this repo round trips (`styleNumber`,
// `name` on Imprint, CREATED_AT_DESC).
//
// TWO WAYS TO FIND THEM, best first:
//   statusIds   invoices(statusIds: [...]) returns only the orders at those
//               statuses. A few calls.
//   scan        no such argument: page every invoice in the production-date
//               window and compare status names here. Slower, same answer.
// Neither is chosen silently: the result says which one ran, and a status
// name that matches nothing in Printavo is reported by name.
//
// `gql` is passed in so the tests drive a fake Printavo. The real one comes
// from lib/promopro/printavo-lookup.js, which already handles 429 retries.
//
// ESM. Do NOT convert to module.exports.

import { normStatus, isTriggerStatus } from "./schema.js";

const PAGE = 25;
const PAUSE_MS = 700;   // Printavo allows 10 requests per 5 seconds per email

function named(t) {
  let x = t;
  while (x && !x.name && x.ofType) x = x.ofType;
  return x ? x.name : null;
}

async function typeFields(gql, name) {
  const d = await gql(`query{__type(name:"${name}"){fields{name args{name type{name kind ofType{name kind}}} type{name kind ofType{name kind ofType{name kind}}}}}}`);
  const out = {};
  ((d && d.__type && d.__type.fields) || []).forEach((f) => {
    out[f.name] = { type: named(f.type), args: (f.args || []).map((a) => a.name), argTypes: f.args || [] };
  });
  return out;
}

const pick = (fields, candidates) => candidates.find((c) => fields[c]) || null;

/** What this account's schema supports. Cached per warm function. */
let _plan = null;
let _planAt = 0;
export function _resetPlan() { _plan = null; _planAt = 0; }

export async function discoverPlan(gql) {
  if (_plan && Date.now() - _planAt < 30 * 60 * 1000) return _plan;
  const root = await typeFields(gql, "Query");
  if (!root.invoices) throw new Error("Printavo has no invoices query on this account");
  const inv = await typeFields(gql, "Invoice");
  const contactType = inv.contact && inv.contact.type;
  const contact = contactType ? await typeFields(gql, contactType) : {};

  const plan = {
    invoiceArgs: root.invoices.args,
    hasStatusIds: root.invoices.args.includes("statusIds"),
    hasWindow: root.invoices.args.includes("inProductionAfter"),
    hasStatusesRoot: !!root.statuses,
    statusesArgs: root.statuses ? root.statuses.argTypes : [],
    nickname: pick(inv, ["nickname", "orderNickname", "name"]),
    hasStatus: !!inv.status,
    hasContact: !!inv.contact,
    firstName: pick(contact, ["firstName", "first_name"]),
    fullName: pick(contact, ["fullName", "name"]),
    email: pick(contact, ["email", "emailAddress", "primaryEmail"]),
  };
  if (!plan.hasStatus) throw new Error("Printavo invoices carry no status field on this account");
  _plan = plan;
  _planAt = Date.now();
  return plan;
}

/** Every status name and id Printavo has, merged across status types. */
export async function listStatuses(gql, plan) {
  if (!plan.hasStatusesRoot) return [];
  const byId = new Map();
  const walk = async (extraArg) => {
    let after = null;
    for (let i = 0; i < 20; i++) {
      const a = after ? `,after:"${after}"` : "";
      const d = await gql(`query{statuses(first:${PAGE}${extraArg}${a}){nodes{id name} pageInfo{hasNextPage endCursor}}}`);
      const conn = d && d.statuses;
      ((conn && conn.nodes) || []).forEach((n) => { if (n && n.id) byId.set(String(n.id), { id: String(n.id), name: n.name }); });
      if (!conn || !conn.pageInfo || !conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  };
  try {
    await walk("");
  } catch (e) {
    // Some schemas require a status TYPE. Ask which values exist and walk each.
    const typeArg = (plan.statusesArgs || []).find((x) => x.name === "type");
    const enumName = typeArg && named(typeArg.type);
    if (!enumName) throw e;
    const d = await gql(`query{__type(name:"${enumName}"){enumValues{name}}}`);
    const values = ((d && d.__type && d.__type.enumValues) || []).map((v) => v.name);
    if (!values.length) throw e;
    for (const v of values) await walk(`,type:${v}`);
  }
  return Array.from(byId.values());
}

function selection(plan) {
  const contactBits = [plan.firstName, plan.fullName, plan.email].filter(Boolean).join(" ");
  const contact = plan.hasContact && contactBits ? ` contact{${contactBits}}` : "";
  const nick = plan.nickname ? ` ${plan.nickname}` : "";
  return `nodes{id visualId${nick} status{id name}${contact}} pageInfo{hasNextPage endCursor}`;
}

function toOrder(node, plan) {
  const c = (node && node.contact) || {};
  return {
    invoiceId: String(node.id),
    visualId: node.visualId != null ? String(node.visualId) : "",
    nickname: plan.nickname ? (node[plan.nickname] || "") : "",
    statusName: (node.status && node.status.name) || "",
    firstName: plan.firstName ? (c[plan.firstName] || "") : "",
    fullName: plan.fullName ? (c[plan.fullName] || "") : "",
    email: plan.email ? (c[plan.email] || "") : "",
  };
}

/**
 * Walk the orders at a trigger status, handing each page to onPage as it
 * arrives so progress is saved even when time runs out mid-walk.
 *
 * opts: { gql, statuses, lookbackDays, cursor, deadline (ms), now (ms),
 *         onPage(orders), pauseMs }
 * Returns { complete, cursor, mode, pages, found, matchedStatuses,
 *           missingStatuses }
 */
export async function walkTriggerOrders(opts) {
  const o = opts || {};
  const gql = o.gql;
  const pause = o.pauseMs == null ? PAUSE_MS : o.pauseMs;
  const now = o.now || Date.now();
  const plan = await discoverPlan(gql);

  const wanted = (o.statuses || []).filter((s) => normStatus(s));
  const all = await listStatuses(gql, plan);
  const matched = all.filter((st) => isTriggerStatus(st.name, wanted));
  const missing = wanted.filter((w) => !all.some((st) => normStatus(st.name) === normStatus(w)));

  let mode;
  if (plan.hasStatusIds && matched.length) mode = "statusIds";
  else if (plan.hasWindow) mode = "scan";
  else {
    throw new Error("Printavo cannot filter invoices by status or by production date on this account, so there is no bounded way to find picked up orders");
  }
  // Nothing in Printavo carries any of these names, and we could list them:
  // a statusIds walk would return nothing and look like a quiet week.
  if (plan.hasStatusesRoot && all.length && !matched.length) {
    throw new Error(`None of these statuses exist in Printavo: ${wanted.join(", ")}`);
  }

  const since = new Date(now - (Number(o.lookbackDays) || 45) * 86400000).toISOString();
  const statusArg = mode === "statusIds" ? `,statusIds:[${matched.map((m) => JSON.stringify(m.id)).join(",")}]` : "";
  const windowArg = plan.hasWindow ? `,inProductionAfter:"${since}"` : "";
  const sel = selection(plan);

  let cursor = o.cursor || null;
  let pages = 0;
  let found = 0;
  const deadline = o.deadline || (now + 45000);

  for (;;) {
    if (Date.now() >= deadline) {
      return { complete: false, cursor, mode, pages, found, matchedStatuses: matched, missingStatuses: missing };
    }
    const after = cursor ? `,after:"${cursor}"` : "";
    const d = await gql(`query{invoices(first:${PAGE}${statusArg}${windowArg}${after}){${sel}}}`);
    const conn = d && d.invoices;
    const nodes = (conn && conn.nodes) || [];
    pages++;
    const orders = nodes
      .filter((n) => n && n.id && n.status && isTriggerStatus(n.status.name, wanted))
      .map((n) => toOrder(n, plan));
    found += orders.length;
    if (o.onPage && orders.length) await o.onPage(orders);

    if (!conn || !conn.pageInfo || !conn.pageInfo.hasNextPage) {
      return { complete: true, cursor: null, mode, pages, found, matchedStatuses: matched, missingStatuses: missing };
    }
    cursor = conn.pageInfo.endCursor;
    if (pause) await new Promise((r) => setTimeout(r, pause));
  }
}
