// api/inquiry-brief.js — renders a BackBone Inbox inquiry as a standalone
// HTML page, uploads it to Vercel Blob, and returns a short link. This is
// the Inbox's equivalent of the Lead Brief (api/brief.js): mailto: has no
// attachment mechanism, so a hosted link is the one-click way to hand an
// AM everything about an inquiry without them needing to be signed into
// BackBone.
//
// Deliberately simpler than the Lead Brief — an inquiry has no AI
// qualification, score, tier, or playbook yet (that only exists once it's
// converted to a Lead). This is a clean readout of exactly what the
// prospect typed into the intake form: contact info, project details,
// vision board (including any uploaded art), and — if the Inbox flagged
// anything — a warnings section so the AM sees it too, not just BackBone.
//
// SHORT LINK: reuses the exact same mechanism as the Lead Brief on purpose.
// api/b.js already serves ANY code under the backbone_brief: KV prefix, so
// writing this brief's code into that same namespace means api/b.js needs
// no changes at all.

import { put } from "@vercel/blob";
import { requireAuth } from "../lib/session.js";

const BUILD = "inquiry-brief-v1";

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function dash(v) {
  const t = String(v == null ? "" : v).trim();
  return t ? esc(t) : "&mdash;";
}

const PROJECT_TYPE_LABELS = {
  live_activation: "Live Activation", just_a_few: "Just a Few Items", csg: "You Supply the Goods",
  bulk_promo: "Bulk Promo", bulk_merch: "Bulk Merch", online_store: "Online Store"
};
const GATE_LABELS = {
  yes: "Existing client", yes_new: "Existing \u00b7 new project", not_sure: "Not sure",
  no: "New client", manual: "Manual entry"
};

function renderInquiryBrief(s, am, warnings) {
  const co = s.company || {}, c = s.contact || {}, p = s.project || {}, det = p.details || {}, vis = s.vision;
  const gate = s.entry ? s.entry.existing_client : null;
  const company = co.name || "New inquiry";
  const submitted = s.submitted_at ? new Date(s.submitted_at).toLocaleString() : "";

  function row(label, value) {
    if (!value) return "";
    return '<div class="row"><span class="row-l">' + esc(label) + '</span><span class="row-v">' + esc(value) + '</span></div>';
  }

  // ---- Contact card: same tappable mailto:/tel: buttons as the Lead Brief ----
  const email = String(c.email || "").trim();
  const phone = String(c.phone || "").trim();
  const callHtml =
    '<div class="call-hd"><div class="call-name">' + dash(c.name || "Name not given") + '</div></div>' +
    (c.job_title ? '<div class="call-title">' + esc(c.job_title) + '</div>' : '') +
    '<div class="call-acts">' +
      (email
        ? '<a class="act act-primary" href="mailto:' + esc(email) + '"><span class="act-i">\u2709</span> Email ' + esc(email) + '</a>'
        : '<div class="act act-none">No email given</div>') +
      (phone
        ? '<a class="act act-secondary" href="tel:' + esc(phone.replace(/[^\d+]/g, "")) + '"><span class="act-i">\u2706</span> Call ' + esc(phone) + '</a>'
        : '') +
    '</div>' +
    (c.url ? '<a class="site-btn" href="' + esc(c.url) + '" target="_blank" rel="noopener"><span class="act-i">\u2197</span> ' + esc(c.url.replace(/^https?:\/\//, "")) + '</a>' : '');

  // ---- Project card ----
  const projectRows =
    row("Entry path", GATE_LABELS[gate] || gate) +
    row("Project name", p.name) +
    row("Type", PROJECT_TYPE_LABELS[p.type] || p.type) +
    row("Store kind", p.store_kind ? p.store_kind.replace(/_/g, "-") : "") +
    row("In-hands date", p.in_hands_date) +
    row("Description", p.description);
  const detailRows = Object.keys(det)
    .filter((k) => det[k] && k !== "csg_waiver_accepted_at")
    .map((k) => row(k.replace(/_/g, " "), typeof det[k] === "boolean" ? (det[k] ? "Yes" : "No") : det[k]))
    .join("");

  // ---- Vision board card ----
  let visionHtml = "";
  if (vis) {
    const artFiles = Array.isArray(vis.art_files) ? vis.art_files.filter((f) => f && f.url) : [];
    visionHtml =
      '<div class="card">' +
        '<div class="sec-l">Vision board</div>' +
        row("Colors", vis.colors) +
        row("Decoration", vis.deco_method) +
        row("Has art", vis.has_art ? "Yes" : "No") +
        (vis.art_url ? '<div class="row"><span class="row-l">Art link</span><span class="row-v"><a href="' + esc(vis.art_url) + '" target="_blank" rel="noopener">' + esc(vis.art_url) + '</a></span></div>' : '') +
        (artFiles.length
          ? '<div class="row"><span class="row-l">Uploaded art</span><span class="row-v">' +
              artFiles.map((f) => '<a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(f.filename || "file") + '</a>').join("<br>") +
            '</span></div>'
          : '') +
        row("Brand guide", vis.brand_guide_url) +
        row("Wants art meeting", vis.talk_to_art ? "Yes" : "") +
        row("Vision", vis.vision_description) +
        row("Inspiration", (vis.inspo || []).join(", ")) +
      '</div>';
  }

  // ---- Warnings (bot screening / address mismatch), passed in from the Inbox ----
  const warnHtml = (warnings && warnings.length)
    ? '<div class="warn"><div class="warn-l">Worth a second look</div>' +
        warnings.map((w) => '<p>' + esc(w) + '</p>').join("") +
      '</div>'
    : "";

  return '<!doctype html><html lang="en"><head>' +
'<meta charset="utf-8"/>' +
'<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
'<title>' + esc(company) + ' \u2014 Inquiry Brief</title>' +
'<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:Inter,-apple-system,system-ui,sans-serif;background:#F4F6F8;color:#111827;' +
  '-webkit-font-smoothing:antialiased;padding:20px 14px 44px;line-height:1.5}' +
'.sheet{max-width:520px;margin:0 auto}' +
'.card{background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(16,24,40,.07);padding:20px;margin-bottom:12px}' +
'.top{display:flex;align-items:center;gap:8px;margin-bottom:14px}' +
'.badge{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#3D9A5C,#2F7D48);' +
  'display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:12px}' +
'.top-t{font-weight:700;font-size:12px;letter-spacing:.02em;color:#6B7280}' +
'.top-am{margin-left:auto;font-size:11px;color:#B7BEC7}' +
'.hero{text-align:center;padding:22px 20px 20px}' +
'.gate-pill{display:inline-block;padding:4px 12px;border-radius:99px;font-size:11px;font-weight:700;' +
  'background:#EAF5EE;color:#1F6B3D;margin-bottom:10px}' +
'.co{font-size:25px;font-weight:800;letter-spacing:-.02em;line-height:1.2}' +
'.when{font-size:12px;color:#9CA3AF;margin-top:6px}' +
'.call{background:#fff;border-radius:16px;padding:20px;margin-bottom:12px;' +
  'box-shadow:0 2px 10px rgba(16,24,40,.10);border:2px solid #3D9A5C}' +
'.call-hd{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}' +
'.call-name{font-size:20px;font-weight:800;letter-spacing:-.01em}' +
'.call-title{font-size:13.5px;color:#6B7280;margin-top:1px}' +
'.call-acts{margin-top:14px;display:flex;flex-direction:column;gap:8px}' +
'.act{display:flex;align-items:center;gap:9px;padding:13px 15px;border-radius:11px;' +
  'font-size:14.5px;font-weight:600;text-decoration:none}' +
'.act-i{font-size:15px;opacity:.85}' +
'.act-primary{background:#3D9A5C;color:#fff}' +
'.act-secondary{background:#F4F6F8;color:#111827}' +
'.act-none{background:#FEF3C7;color:#92400E;font-size:13px;font-weight:600}' +
'.site-btn{display:inline-flex;align-items:center;gap:7px;margin-top:10px;padding:9px 14px;' +
  'border-radius:9px;background:#F4F6F8;color:#111827;font-size:12.5px;font-weight:600;text-decoration:none}' +
'.sec-l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#3D9A5C;margin-bottom:10px}' +
'.row{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid #F4F6F8;font-size:13px}' +
'.row:last-child{border-bottom:none}' +
'.row-l{flex:0 0 128px;color:#9CA3AF;text-transform:capitalize}' +
'.row-v{flex:1;color:#111827;font-weight:500;word-break:break-word}' +
'.row-v a{color:#3D9A5C}' +
'.warn{background:#FEF2F2;border-radius:12px;padding:13px 16px;margin-bottom:12px}' +
'.warn-l{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#B91C1C;margin-bottom:5px}' +
'.warn p{font-size:13px;color:#7F1D1D;line-height:1.5;margin-top:4px}' +
'.foot{text-align:center;font-size:11px;color:#C3C9D0;margin-top:16px}' +
'@media print{body{background:#fff}.card,.call{box-shadow:none;border:1px solid #E5E7EB}}' +
'</style></head><body><div class="sheet">' +

'<div class="top"><div class="badge">I</div><div class="top-t">INQUIRY BRIEF</div>' +
  '<div class="top-am">' + esc(am || "") + '</div></div>' +

'<div class="card hero">' +
  '<div class="gate-pill">' + esc(GATE_LABELS[gate] || "New inquiry") + '</div>' +
  '<div class="co">' + esc(company) + '</div>' +
  (submitted ? '<div class="when">Submitted ' + esc(submitted) + '</div>' : '') +
'</div>' +

warnHtml +

'<div class="call">' + callHtml + '</div>' +

'<div class="card"><div class="sec-l">Project</div>' + projectRows + detailRows + '</div>' +

visionHtml +

'<div class="foot">BackBone \u00b7 P&amp;M Apparel</div>' +
'</div></body></html>';
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const diag = {
    oidc: !!process.env.VERCEL_OIDC_TOKEN,
    storeId: !!process.env.BLOB_STORE_ID,
    rwToken: !!process.env.BLOB_READ_WRITE_TOKEN,
    build: BUILD
  };

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const s = body.submission;
    const am = body.am || "";
    const warnings = Array.isArray(body.warnings) ? body.warnings.slice(0, 20).map((w) => String(w).slice(0, 300)) : [];
    if (!s || !s.id) return res.status(400).json({ error: "Missing submission" });

    const html = renderInquiryBrief(s, am, warnings);

    const slug = String((s.company && s.company.name) || "inquiry")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "inquiry";

    let token = (process.env.BLOB_READ_WRITE_TOKEN || "").trim();
    token = token.replace(/^BLOB_READ_WRITE_TOKEN\s*=\s*/i, "").replace(/^["']|["']$/g, "").trim();

    const opts = { access: "public", contentType: "text/html; charset=utf-8", addRandomSuffix: true };
    if (token) opts.token = token;

    const blob = await put("briefs/inquiry-" + slug + "-" + s.id + ".html", html, opts);

    // Same short-link namespace as the Lead Brief — api/b.js reads any code
    // under backbone_brief: regardless of which endpoint wrote it.
    let shortUrl = null;
    try {
      if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
        const code = Array.from({ length: 8 }, () =>
          "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 32)]
        ).join("");
        const kv = await fetch(process.env.KV_REST_API_URL + "/pipeline", {
          method: "POST",
          headers: { Authorization: "Bearer " + process.env.KV_REST_API_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify([["SET", "backbone_brief:" + code, blob.url]])
        });
        if (kv.ok) {
          const proto = req.headers["x-forwarded-proto"] || "https";
          const host = req.headers["x-forwarded-host"] || req.headers.host;
          shortUrl = proto + "://" + host + "/api/b?c=" + code;
        }
      }
    } catch (e) {
      console.warn("inquiry brief short link failed, falling back to blob url:", e.message);
    }

    return res.status(200).json({
      url: shortUrl || blob.url,
      blobUrl: blob.url,
      shortened: !!shortUrl,
      id: s.id,
      build: BUILD
    });
  } catch (e) {
    console.error("inquiry-brief error:", e);
    return res.status(500).json({ error: e.message || "Failed to generate brief", diag: diag });
  }
}
