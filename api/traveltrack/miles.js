// api/traveltrack/miles.js — loyalty accounts and redemptions (Redeem Miles).
//
// Loyalty numbers are personal, so this scopes exactly like trips/expenses:
// own accounts only, unless data_scope is "all".
//
// GET    -> list accounts (own, or everyone's for "all"), or ?id= for one.
// POST   -> create an account (always owned by the caller), or
//           ?id=<account>&action=redeem to log a redemption against it.
// PATCH  -> edit an account's details/balance. Owner or "all"+can_edit.
// DELETE -> owner or "all"+can_edit.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../../lib/session.js";
import { getUser, getRole } from "../../lib/users.js";
import { validateLoyaltyAccount, validateRedemption } from "../../lib/traveltrack/schema.js";
import {
  listLoyaltyAccounts, getLoyaltyAccount, saveLoyaltyAccount,
  updateLoyaltyAccount, deleteLoyaltyAccount, addRedemption,
} from "../../lib/traveltrack/store.js";

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

async function callerScope(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  const role = await getRole(user ? user.role : sess.role);
  return {
    scope: (role && role.data_scope) || "all",
    canEdit: role ? !!role.can_edit : true,
    name: (user && user.name) || sess.name || sess.username,
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  try {
    const { scope, canEdit, name } = await callerScope(sess);
    const mine = String(sess.username || "").trim().toLowerCase();

    if (req.method === "GET") {
      const id = req.query && req.query.id;
      if (id) {
        const account = await getLoyaltyAccount(id);
        if (!account) return res.status(404).json({ error: "Account not found" });
        if (scope !== "all" && String(account.username || "").toLowerCase() !== mine) {
          return res.status(403).json({ error: "Not your account" });
        }
        return res.status(200).json({ account });
      }
      let accounts = await listLoyaltyAccounts();
      if (scope !== "all") {
        accounts = accounts.filter((a) => String(a.username || "").toLowerCase() === mine);
      }
      return res.status(200).json({ accounts });
    }

    if (req.method === "POST") {
      const body = parseBody(req);
      const action = req.query && req.query.action;
      const id = req.query && req.query.id;

      if (action === "redeem") {
        if (!id) return res.status(400).json({ error: "Missing account id" });
        const existing = await getLoyaltyAccount(id);
        if (!existing) return res.status(404).json({ error: "Account not found" });
        const isOwner = String(existing.username || "").toLowerCase() === mine;
        if (!isOwner && !(scope === "all" && canEdit)) {
          return res.status(403).json({ error: "Not allowed to redeem from this account" });
        }
        const { ok, errors, record } = validateRedemption(body);
        if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
        record.redeemed_by = sess.username;
        const account = await addRedemption(id, record);
        return res.status(200).json({ ok: true, account });
      }

      const { ok, errors, record } = validateLoyaltyAccount(body);
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });

      let owner = sess.username, ownerName = name;
      if (scope === "all" && body.username) {
        owner = body.username; ownerName = body.owner_name || body.username;
      }
      record.username = owner;
      record.owner_name = ownerName;
      record.last_updated = new Date().toISOString();
      record.redemptions = [];

      const account = await saveLoyaltyAccount(record);
      return res.status(201).json({ ok: true, account });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);
      const id = (req.query && req.query.id) || body.id;
      if (!id) return res.status(400).json({ error: "Missing account id" });

      const existing = await getLoyaltyAccount(id);
      if (!existing) return res.status(404).json({ error: "Account not found" });

      const isOwner = String(existing.username || "").toLowerCase() === mine;
      if (!isOwner && !(scope === "all" && canEdit)) {
        return res.status(403).json({ error: "Not allowed to edit this account" });
      }

      const { ok, errors, record } = validateLoyaltyAccount(body, { partial: true });
      if (!ok) return res.status(400).json({ error: "Validation failed", details: errors });
      record.last_updated = new Date().toISOString();

      const account = await updateLoyaltyAccount(id, record);
      return res.status(200).json({ ok: true, account });
    }

    if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || parseBody(req).id;
      if (!id) return res.status(400).json({ error: "Missing account id" });

      const existing = await getLoyaltyAccount(id);
      if (!existing) return res.status(404).json({ error: "Account not found" });

      const isOwner = String(existing.username || "").toLowerCase() === mine;
      if (!isOwner && !(scope === "all" && canEdit)) {
        return res.status(403).json({ error: "Not allowed to delete this account" });
      }

      await deleteLoyaltyAccount(id);
      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("traveltrack/miles route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
