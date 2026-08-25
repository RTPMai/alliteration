// api/help.js — the in-app help bot.
//
// Ryan's ask, Aug 25 2026. Answers questions about how the apps work, how a
// number is calculated, and where data comes from. EXPLANATIONS ONLY.
//
// IT CANNOT READ BUSINESS DATA, and that is a design decision rather than a
// missing feature. Two reasons. First, every app enforces its own data scope
// (an account manager on "own" sees only their accounts, CrewCore hides pay,
// a private notification is invisible even to an admin) and a bot that
// queried data would have to re-implement all of it correctly, where getting
// it wrong means somebody reads a figure they should not have. Second, a
// confidently wrong number is worse than no number: the apps already show
// these figures correctly, with a staleness stamp when a sync is behind, and
// a bot competing with that is a downgrade. If asked for a figure it says so
// and names the screen that has it.
//
// The only thing it is allowed to say comes from lib/help/content.js. There
// is no general-knowledge fallback. See buildPrompt() in lib/help/retrieve.js.
//
// POST -> { question, app?, view? } returns { answer, sources, answered }.
//         app/view are what the asker had open, used only to break scoring
//         ties so "how is this calculated" works without naming the app.
// GET  -> ?log=1 returns the question log, superuser only. This is how the
//         gaps in the knowledge pack get found.
//
// ESM handler. Do NOT wrap the handler; call requireAuth inside it.

import { requireAuth } from "../lib/session.js";
import { getUser, getRole } from "../lib/users.js";
import { DOCS } from "../lib/help/content.js";
import { pickDocs, buildPrompt } from "../lib/help/retrieve.js";
import { logQuestion, listQuestions } from "../lib/help/store.js";
import { APP_ACCESS_IDS } from "../lib/help/access.js";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 800;

function parseBody(req) {
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === "object" ? b : {};
}

// Which app docs this person is allowed to be told about. Mirrors the rail:
// no explanation of a screen they cannot open. Deliberately permissive about
// the shell screens (Notifications, Settings) and the platform doc, which
// explain the thing everybody is already looking at.
async function allowedAppsFor(sess) {
  const user = sess.username ? await getUser(sess.username) : null;
  if (user && user.superuser === true) return APP_ACCESS_IDS.slice();

  const role = await getRole(user ? user.role : sess.role);
  const granted = (role && Array.isArray(role.apps)) ? role.apps : [];
  const always = ["notifications"];
  if (role && role.data_scope === "all") always.push("settings");
  return APP_ACCESS_IDS.filter((id) => granted.includes(id) || always.includes(id));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  const sess = requireAuth(req, res);
  if (!sess) return;

  const me = String(sess.username || "").toLowerCase();

  try {
    if (req.method === "GET") {
      if (req.query && req.query.log === "1") {
        const user = me ? await getUser(me) : null;
        if (!user || user.superuser !== true) {
          return res.status(403).json({ error: "Superuser only" });
        }
        return res.status(200).json({ questions: await listQuestions() });
      }
      return res.status(400).json({ error: "Ask with POST" });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = parseBody(req);
    const question = String(body.question || "").trim().slice(0, 500);
    if (!question) return res.status(400).json({ error: "Ask a question" });

    const allowedApps = await allowedAppsFor(sess);
    const hits = pickDocs(DOCS, question, {
      allowedApps,
      currentApp: body.app,
    });

    // Nothing scored. Answering anyway means inventing, so this returns a
    // fixed sentence and never reaches the model. The log entry is the
    // valuable part: it is a documented gap.
    if (!hits.length) {
      await logQuestion({ by: me, question, app: body.app || null, sources: [], answered: false });
      return res.status(200).json({
        answered: false,
        sources: [],
        answer:
          "That is not something I have documentation for yet. I can only " +
          "explain how the apps work, and I have no access to live numbers, " +
          "customers or orders. Ryan can add this to my notes, and your " +
          "question has been logged so it does not get lost.",
      });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: "Help is not configured (ANTHROPIC_API_KEY missing)" });
    }

    const prompt = buildPrompt(hits, question, {
      appName: body.appName || null,
      viewName: body.viewName || null,
    });

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      }),
    });

    if (!apiRes.ok) {
      const detail = await apiRes.text();
      return res.status(502).json({ error: "Could not reach the help model", detail });
    }

    const data = await apiRes.json();
    const answer = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const sources = hits.map((h) => h.doc.title);
    await logQuestion({ by: me, question, app: body.app || null, sources, answered: true });

    return res.status(200).json({ answered: true, answer, sources });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Help failed" });
  }
}
