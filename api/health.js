// api/health.js — "why is it broken?" in plain language.
//
// A crashing function returns Vercel's generic 500, which tells you nothing.
// This route is deliberately dependency-free: it imports nothing that could
// itself throw, so it answers even when everything else is failing.
//
// Open /api/health in a browser to see what is and isn't configured.
//
// SAFE TO EXPOSE: reports only whether each variable is SET, never its value.

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const env = process.env;

  const sessionSecret = !!env.SESSION_SECRET;
  const kvUrl   = !!(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL);
  const kvToken = !!(env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN);

  const missing = [];
  if (!sessionSecret) missing.push("SESSION_SECRET");
  if (!kvUrl)   missing.push("KV_REST_API_URL (or UPSTASH_REDIS_REST_URL)");
  if (!kvToken) missing.push("KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_TOKEN)");

  const ready = missing.length === 0;

  res.status(200).json({
    ready,
    node: process.version,
    configured: {
      SESSION_SECRET: sessionSecret,
      KV_REST_API_URL: kvUrl,
      KV_REST_API_TOKEN: kvToken,
    },
    missing,
    next: ready
      ? "Configuration looks complete. Open /login.html to create the first account."
      : "Add the missing variables in Vercel > Settings > Environment Variables, then redeploy.",
  });
}
