// api/scan-status.js — PUBLIC BY DESIGN. No-login QR scan endpoint for ShopStock.
//
// Scanning an item's QR code should flip its status with no sign-in step,
// even for people who don't have an alliteration. account (Ryan's call,
// Aug 2026). This endpoint is intentionally public: it is keyed by item id
// alone, the same id already printed on every label, old and new.
//
// This is a NARROWER surface than api/items.js on purpose:
//   - GET only returns { id, name, status } — never price, supplier, notes,
//     or anything else in the item record.
//   - POST only accepts one of the three fixed statuses below. It cannot
//     rename, delete, or edit any other field.
// A scan cannot do anything api/items.js's own staff shortcut (the PUT
// "Needs Ordered" / "In Stock" flip for non-admins) doesn't already allow a
// signed-in user to do. It just removes the login step.
//
// Trade-off, on the record: since the id is the only key and ids are not
// secret, anyone who learns or guesses a valid item id could flip its status
// from outside the shop. Ryan chose this over reprinting every label with a
// secret token. If that ever needs tightening, add a token column to the
// item record and require it here without touching item ids or old labels.
//
// Rate limited per IP as a light guard against a script scanning through IDs
// (GET, to harvest the item list) or flooding status flips (POST). Limits
// are generous on purpose: real scanning, even a fast warehouse session
// scanning dozens of labels back to back, should never come close.

import { isRateLimited } from "../lib/rate-limit.js";

const SCAN_GET_MAX_PER_IP = 300;
const SCAN_POST_MAX_PER_IP = 120;
const SCAN_WINDOW_SECONDS = 60 * 60;

function clientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: "Upstash not configured" });

  // These must match the STORED values in items.js/shopstock.js exactly.
  // "Ordered" is the stored value; "On Order" is only the display label.
  const ALLOWED_STATUSES = ["Needs Ordered", "Ordered", "In Stock"];

  async function kvGet(key) {
    const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    const j = await r.json();
    if (!j.result) return null;
    let val = j.result;
    for (let i = 0; i < 3; i++) {
      if (typeof val === "string") { try { val = JSON.parse(val); } catch (e) { break; } }
      else break;
    }
    return val;
  }

  async function kvSet(key, value) {
    await fetch(`${kvUrl}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kvToken}`, "Content-Type": "application/json" },
      body: JSON.stringify([["SET", key, JSON.stringify(value)]])
    });
  }

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing id" });

  const ip = clientIp(req);
  if (req.method === "GET") {
    if (await isRateLimited("scan-status:get:" + ip, SCAN_GET_MAX_PER_IP, SCAN_WINDOW_SECONDS)) {
      return res.status(429).json({ error: "Too many requests, try again shortly." });
    }
  }
  if (req.method === "POST") {
    if (await isRateLimited("scan-status:post:" + ip, SCAN_POST_MAX_PER_IP, SCAN_WINDOW_SECONDS)) {
      return res.status(429).json({ error: "Too many requests, try again shortly." });
    }
  }

  const item = await kvGet(`supply_item_${id}`);
  if (!item) return res.status(404).json({ error: "Item not found" });

  if (req.method === "GET") {
    return res.status(200).json({ id: item.id, name: item.name, status: item.status });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body && typeof body === "object" ? body : {};

    const status = body.status;
    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ error: "status must be one of: " + ALLOWED_STATUSES.join(", ") });
    }

    const prevStatus = item.status;
    item.status = status;
    if (status === "Needs Ordered" && prevStatus !== "Needs Ordered") item.needsOrderedAt = new Date().toISOString();
    if (status === "Ordered") item.lastOrdered = new Date().toISOString();
    if (status === "In Stock" && prevStatus === "Ordered") item.timesOrderedYTD = (item.timesOrderedYTD || 0) + 1;

    await kvSet(`supply_item_${item.id}`, item);
    return res.status(200).json({ id: item.id, name: item.name, status: item.status });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
