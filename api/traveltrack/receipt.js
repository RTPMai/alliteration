// api/traveltrack/receipt.js — receipt photo upload + automatic field extraction.
//
// Two actions, both POST:
//   ?action=upload   body { data_url, filename } -> stores the image in Vercel
//                    Blob, returns { url }.
//   ?action=extract  body { data_url } -> sends the image to Claude and returns
//                    { fields: { date, amount, category, description } } for the
//                    expense form to prefill. Nothing is saved; the user still
//                    reviews and submits.
//
// WHY A DATA URL, NOT MULTIPART: the shell's seam (js/api.js) sends JSON and
// nothing else. A multipart upload would be the only place in the codebase
// bypassing it. Phone photos are a few MB as base64, which is within Vercel's
// body limit for this route's use.
//
// EXTRACTION IS ADVISORY. The model reads a photo of a crumpled receipt; it
// will sometimes get a total or a date wrong. Every extracted value lands in
// the form as an editable prefill, never a direct write, and the response
// says so. Do not "streamline" this into auto-submit.
//
// Env: BLOB_READ_WRITE_TOKEN (or a connected Blob store) for upload,
// ANTHROPIC_API_KEY for extraction. Both already exist in the project.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { put } from "@vercel/blob";
import { requireAuth } from "../../lib/session.js";
import { EXPENSE_CATEGORIES } from "../../lib/traveltrack/schema.js";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB of decoded image

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

// Split "data:image/jpeg;base64,AAAA..." into its parts. Returns null if the
// string isn't a data URL for a supported image type.
function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || "").trim());
  if (!m) return null;
  const mediaType = m[1] === "image/jpg" ? "image/jpeg" : m[1];
  const base64 = m[2];
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_BYTES) return null;
  return { mediaType, base64 };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = parseBody(req);
    const action = (req.query && req.query.action) || "upload";
    const parsed = parseDataUrl(body.data_url);
    if (!parsed) {
      return res.status(400).json({ error: "Expected a base64 image data URL under 8 MB (jpeg, png, webp or gif)" });
    }

    // ---- Store the image ------------------------------------------------
    if (action === "upload") {
      const safeName = String(body.filename || "receipt")
        .replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
      const ext = parsed.mediaType.split("/")[1].replace("jpeg", "jpg");
      const key = `traveltrack/receipts/${sess.username}/${Date.now()}-${safeName}.${ext}`;

      const blob = await put(key, Buffer.from(parsed.base64, "base64"), {
        access: "public",
        contentType: parsed.mediaType,
        addRandomSuffix: true,
      });
      return res.status(200).json({ ok: true, url: blob.url });
    }

    // ---- Read the image --------------------------------------------------
    if (action === "extract") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return res.status(503).json({ error: "Receipt reading is not configured (ANTHROPIC_API_KEY is not set)." });
      }

      const prompt = [
        "Read this receipt image and return ONLY a JSON object, no prose and no markdown fences, with these keys:",
        '  "date": the purchase date as YYYY-MM-DD, or "" if not legible',
        '  "amount": the FINAL TOTAL actually charged as a plain number (no currency symbol, no thousands separator). Not the subtotal, not the pre-tip line. "" if not legible.',
        '  "description": the merchant/vendor name, short. "" if not legible.',
        `  "category": the single best fit from this exact list: ${EXPENSE_CATEGORIES.join(", ")}`,
        "",
        "Rules: if a value is unclear or missing, use an empty string rather than guessing.",
        "Do not invent a merchant or a total. Return the JSON object and nothing else.",
      ].join("\n");

      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 400,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.base64 } },
              { type: "text", text: prompt },
            ],
          }],
        }),
      });

      if (!aiRes.ok) {
        const detail = await aiRes.text().catch(() => "");
        console.error("receipt extract failed:", aiRes.status, detail.slice(0, 400));
        return res.status(502).json({ error: `Could not read the receipt (upstream ${aiRes.status}). Enter the details manually.` });
      }

      const payload = await aiRes.json();
      const text = (payload.content || [])
        .filter((b) => b && b.type === "text")
        .map((b) => b.text)
        .join("")
        .replace(/```json|```/g, "")
        .trim();

      let fields;
      try {
        fields = JSON.parse(text);
      } catch (e) {
        console.error("receipt extract returned non-JSON:", text.slice(0, 300));
        return res.status(502).json({ error: "Could not read the receipt. Enter the details manually." });
      }

      // Sanitize before handing back — never trust the model's shape.
      const amount = Number(String(fields.amount ?? "").replace(/[^0-9.]/g, ""));
      const out = {
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(fields.date || "")) ? fields.date : "",
        amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : "",
        description: String(fields.description || "").trim().slice(0, 120),
        category: EXPENSE_CATEGORIES.includes(fields.category) ? fields.category : "",
      };

      return res.status(200).json({ ok: true, fields: out, advisory: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error("traveltrack/receipt route error:", e);
    return res.status(500).json({ error: e.message });
  }
}
