// PUT IN: api/mailme/am.js
// api/mailme/am.js — "Email Hannah" from a MailMe email, counted.
//
// PUBLIC BY DESIGN. The person clicking is a customer reading an email, not
// a P&M staff member with a login. It does one harmless thing: opens a new
// email to one of our own account managers.
//
// WHY IT EXISTS (Oct 1 2026). The Seasonal design can show every account
// manager as a button so the reader picks theirs. A mailto: link cannot be
// counted (Resend only tracks web links), so the button points here instead,
// Resend counts the click on the way, and this page opens the email.
//
// NOT AN OPEN REDIRECT. Only a first name comes in. The domain is MailMe's
// own reply-to domain from Settings, never from the URL, so this can only
// ever open firstname@pmapparel.com. Anything else gets a plain error page.
//
// GET ?to=<first name>&s=<subject>
//
// ESM handler.

import { getSettings } from "../../lib/mailme/store.js";
import { amMailto } from "../../lib/mailme/schema.js";

function page(title, body) {
  // No colors beyond black and white: css/tokens.css does not reach a page
  // opened from an email, and the repo forbids hex codes outside it.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{margin:0;font-family:Arial,Helvetica,sans-serif;background:white;color:black}
main{max-width:460px;margin:12vh auto;padding:0 22px;text-align:center}
h1{font-family:"Arial Black",Arial,sans-serif;font-size:24px;text-transform:lowercase;margin:0 0 14px}
a.btn{display:inline-block;margin-top:14px;padding:14px 22px;background:black;color:white;
text-decoration:none;font-family:"Arial Black",Arial,sans-serif;text-transform:lowercase}
p{line-height:1.5}</style></head><body><main>${body}</main></body></html>`;
}

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send(page("Not allowed", "<h1>not allowed.</h1>"));
  }

  let settings = {};
  try { settings = await getSettings(); } catch (e) { settings = {}; }
  const q = req.query || {};
  const target = amMailto(q.to, q.s, settings.replyToDomain);

  if (!target) {
    return res.status(400).send(page("P&M Apparel",
      `<h1>that link didn't work.</h1><p>Call us at <a href="tel:+15159847740">515.984.7740</a>
       or visit <a href="https://www.pmapparel.com/">pmapparel.com</a>.</p>`));
  }

  // Straight to the email app. The page underneath is the fallback for the
  // apps that will not follow a redirect into mailto:, and says the address
  // out loud so it can be copied.
  const href = esc(target.href);
  return res.status(200).send(page(`Email ${esc(target.name)}`,
    `<h1>emailing ${esc(target.name)}.</h1>
     <p>Your email app should open with a new message to
       <b>${esc(target.email)}</b>.</p>
     <a class="btn" href="${href}">open email.</a>
     <p style="margin-top:22px;font-size:13px">Nothing opened? Copy the address above
       into a new email.</p>
     <script>location.replace(${JSON.stringify(target.href).replace(/</g, "\\u003c")});</script>`));
}
