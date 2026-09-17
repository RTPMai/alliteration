# Deploy: RaveReviews (Google review requests)

Sep 17, 2026. Built on commit 992d12c. Re-cloned right before packaging: nothing
landed upstream since, so the shared files (registry, api.js, tokens.css,
vercel.json) are safe to drop in.

**Suite: GREEN on a clean clone with the patch applied. 2,639 checks.** It was
RED before this (three stale MarketMachine sample-route checks, fixed here).

No new environment variables. Uses RESEND_API_KEY, CRON_SECRET,
PRINTAVO_API_TOKEN, PRINTAVO_EMAIL, KV_REST_API_URL, KV_REST_API_TOKEN.

---

## Deploy it (patch, recommended)

Twenty files is a lot of manual uploads, and wrong-file shuffles have bitten
this repo four times. The patch does all of them in one step.

    git clone https://github.com/RTPMai/alliteration.git
    cd alliteration
    git am /path/to/rave-reviews.patch
    bash test/run.sh          # must say SUITE GREEN
    git push

## Or by hand

Every file is named with double underscores standing in for folder slashes.
`api__reviews__cron.js` goes to `api/reviews/cron.js`. None is over 100 KB.

New (11): `apps/reviews.js`, `api/reviews/cron.js`, `api/reviews/requests.js`,
`api/reviews/settings.js`, `lib/reviews/schema.js`, `lib/reviews/store.js`,
`lib/reviews/engine.js`, `lib/reviews/printavo.js`, `lib/reviews/deps.js`,
`lib/reviews/access.js`, `test/reviews.test.cjs`.

Replaced (9): `js/registry.js`, `js/api.js`, `css/tokens.css`, `vercel.json`,
`api/sitework.js`, `api/notifications.js`, `lib/help/access.js`,
`lib/help/content.js`, `test/marketmachine-samples.test.cjs`.

First line check: every new file starts with `// PUT IN: <its path>`.
`css/tokens.css` starts with `/* ====`, `vercel.json` with `{`,
`lib/help/access.js` with `// lib/help/access.js`,
`test/marketmachine-samples.test.cjs` with `// test/marketmachine-samples`.

---

## Switching over from Zapier, in this order

1. **Deploy.** Confirm Vercel's Crons page lists `/api/reviews/cron`.
2. **Open RaveReviews, Settings, press Run now.** The first run records every
   order already at ORDER SHIPPED or PICKED-UP and queues none of them, because
   Zapier already has those. Sending is off, so nothing goes out.
3. **Turn off both Printavo automations**, "ZAP> Order Shipped" and "ZAP> Order
   Ready for Pick Up". Do it the same day as step 2. Any Zapier runs already
   waiting their three days will finish on their own, and those orders are
   already recorded here, so nobody gets two.
4. **Press Check Printavo.** It should say it found orders at both statuses,
   filtered by status, with names and emails in the sample lines. If it says a
   status was not found, fix the spelling in Settings.
5. **Send a test to yourself.** Check the greeting, the link, the subject.
6. **Tick "Send review requests automatically" and Save.**
7. Turn off the Zap in Zapier once its waiting runs are done (about 3 days).

## Check after a few days

- Requests, Waiting: orders picked up since step 2, each with a send date.
- Requests, Sent: the first ones, three days after pickup.
- Press "Left a review" on anyone you know reviewed. They will not be asked
  again.

---

## How it works

- **Finding orders.** Four runs a day (9, noon, 3 and 6 Central in summer, an
  hour earlier in winter). Each asks Printavo which invoices are at the two
  statuses, within the last 45 days by production date. Printavo does not
  record when a status changed, so the first run that sees an order there
  counts as its pickup.
- **Sending.** Due emails go out on the same runs, through Resend, as
  "P&M Apparel <Ryan@pmapparel.com>", replies to you, plain text. At most 20
  per run, which keeps four runs under Resend's free 100 a day.
- **Skipped, decided on send day:** already left a review; unsubscribed,
  bounced or complained in MailMe; no usable email in Printavo; that address
  already got a request in the last 7 days.
- **Send now** asks before overriding a skip. It works even with automatic
  sending off.
- **A send that errors** retries on the next run, and after three tries it
  stops and shows as Failed. Hitting Resend's daily limit stops the run without
  counting against anyone.

## Decisions made without you (all changeable)

- **Name and color are provisional.** RaveReviews, olive. Neither is on the
  logo lineup sheet. The app id is `reviews`, so renaming is a label change in
  `js/registry.js` and colors in `css/tokens.css`, nothing else moves.
- **The 7-day same-address rule** is mine, to stop two identical emails when a
  customer has two orders picked up the same week. Settings, set to 0 to turn
  off.
- **Admin only**, on the Admin flag. Ticking the app on someone's account puts
  it in their rail, and every button answers "admin only".

## Not verified from here

- **Printavo's status filter.** The code asks Printavo's schema for the right
  names instead of guessing, and falls back to scanning by production date if
  the filter is not there. Check Printavo (step 4) is the real test.
- **Printavo contact fields** (first name, email) are found the same way. If
  sample lines in step 4 say "no first name" or "NO EMAIL" for everyone, tell
  me what Check Printavo showed.
- **A live send** has not happened. Step 5 covers it.

## Also in this drop

`test/marketmachine-samples.test.cjs`: removed three checks that read
`api/marketmachine/samples.js`, which you deleted this morning. That is what
had the suite red.
