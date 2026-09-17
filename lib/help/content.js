// PUT IN: lib/help/content.js
// lib/help/content.js — the knowledge the help bot is allowed to answer from.
//
// Ryan's ask, Aug 25 2026. This is TEXT CONTENT, not configuration, same
// category as lib/crewcore/handbook-content.js: there is no "validate a help
// doc" function because nothing here is user-submitted. Editing the help
// means editing this file and redeploying.
//
// WHY IT LIVES IN THE REPO AND NOT IN KV. It has to move when the code moves.
// This project's recurring failure is written notes drifting behind the repo,
// and a help bot confidently explaining a calculation that changed six months
// ago is worse than no help bot, because people act on it. Keeping the docs
// beside the code means test/help.test.cjs can assert that every app in the
// registry has a doc and every registered view is mentioned in it. Adding a
// view without documenting it turns the suite red the same day.
//
// SOURCED FROM THE CODE, NOT FROM THE STATUS DOCS. Each entry below was
// written from the app file's own header comment, which is where the "why"
// of every decision in this platform actually lives.
//
// FIRST DRAFT. The mechanics are right; some of the reasoning behind a
// decision exists only in Ryan's head and needs correcting here. The
// unanswered-question log (lib/help/store.js) is how the gaps get found.
//
// Each doc: { app, title, keywords, body }. `app` matches a registry app id,
// or null for the platform-wide doc. `body` is plain prose. `keywords` are
// the words somebody would use who does not know the app's name.
//
// ESM. Do NOT convert to module.exports.

export const DOCS = [
  {
    app: null,
    title: "Alliteration, the platform itself",
    keywords: ["platform", "shell", "login", "password", "sign in", "rail",
      "apps", "access", "permission", "role", "who can see", "hub", "help"],
    body: `Alliteration is P&M Apparel's internal platform. It is one website,
at alliteration-eight.vercel.app, holding every internal app under a single
sign-in. Before it existed each app was its own site with its own login.

SIGNING IN. One account, one password, every app. If you are signed in to one
app you are signed in to all of them. Ryan and other administrators create
accounts in Settings.

THE RAIL is the list down the left side. It shows only the apps your account
can open, so two people can see different lists. "All apps" at the bottom of
the app list is the hub: one card per app with a headline number.

WHO SEES WHAT. Access is set per role in Settings, not per person. A role
carries which apps it can open, whether it can edit or export, and its data
scope. Data scope "all" sees everything in an app. Data scope "own" sees only
their own records, which is how an account manager sees their own accounts
rather than the whole roster. That scope is enforced on the server, so it is
not something the screen can be talked out of.

NOTIFICATIONS AND SETTINGS are shell screens rather than apps: they belong to
the platform, not to any one app. StickySituations is a third section, visible
only to admins, and it is the list of work on building the platform
itself rather than work at the shop.

THIS HELP BOT explains how things work. It cannot look up a number, a
customer, an order or a total, and it has no access to live business data at
all. If a figure is what you need, it will tell you which screen shows it.`,
  },

  {
    app: "backbone",
    title: "BackBone (customers, sales, leads)",
    keywords: ["crm", "customer", "client", "sales", "goal", "revenue",
      "quote", "outstanding", "lead", "inquiry", "printavo", "sync",
      "account manager", "am", "scorecard", "platinum", "gold", "roster"],
    body: `BackBone is the customer and sales side of the shop: who our
customers are, what they are worth, what is quoted and unpaid, and where new
inquiries stand.

SIX SCREENS. Dashboard is the numbers. Inquiries is everything that has come
in and where each one stands, from a form submission nobody has read yet
through to won or lost. Roster is the customer list. Scorecard ranks
customers. Archived holds inquiries and clients that have been taken off those
working lists. Settings holds the app's own options.

INQUIRIES WAS TWO SCREENS. Inbox and Leads merged in September 2026. They were
the same thing at two moments of its life, and the "Convert to lead" button
between them only existed because the Leads board had been built for cold
outbound calling, which is not how work reaches P&M. The stages are now New,
Assigned, Responded, Quoted, and then Won, Lost or Reach Back Out.

WHERE THE DATA COMES FROM. Almost all of it comes from Printavo, pulled in by
an automatic sync that runs every morning around 6 AM Central. Nothing is
typed in twice. The dashboard cards carry a "Data through" stamp showing when
that sync last finished, and the stamp turns amber once the data is more than
48 hours old. An amber stamp means the sync has stopped, not that sales
dropped.

THE SALES GOAL NUMBER runs on INVOICE DATE. A month counts the dollars
invoiced in that month. Payment date is tracked separately as a fallback
figure and is not what the goal card shows. This matters because the two
answer different questions and can differ by a lot in any given month.

THE SCORECARD ranks customers into bands, with Platinum and Gold at the top.
The dashboard shows the count first and the share underneath, because six out
of two-thousand-odd rounds to zero percent and reads as though there are none.
When the dashboard's year filter is the current year, the scoring uses
part-year bands scaled to how much of the year has passed, so the dashboard
and the Scorecard agree. Set to a past year it uses full bands, and set to
"All" it is lifetime. A count that differs between two screens is usually a
different year filter rather than a bug, so check the filter first.

A WARNING ON SCORES. Scorecard scores are not yet reliable on their own. The
manual enrichment fields they read are still being filled in across the
roster, so a low score today often means a thin record rather than a weak
customer.

LEADS move through stages: the account manager is notified, contacted a first
time, contacted a second time, a final "death call", and then won, lost, or
reach back out. Every status change is kept as a history trail, so it is
always visible who moved a lead and when. The inbox also screens obvious bot
and fake inquiries before they reach anybody.

EVERY LEAD HAS A NUMBER, like L-00042, so it can be named on the phone or in
a hand-off. The number is issued once and never reused, so a gap in the
sequence is normal and does not mean anything is missing.

ARCHIVING takes a lead or a client off the working lists without deleting it.
It always needs a reason, chosen from a fixed list an admin manages in
BackBone Settings, so the reasons can be counted later instead of being
twelve spellings of the same four things. A lead keeps the stage it was
standing in, so restoring it from the Archived screen puts it back exactly
there. Disqualifying is the same thing with the reason already filled in, and
a research run that scores a lead Disqualified archives it automatically and
says so rather than leaving it on the list for everybody to keep deciding
about. Archiving a client hides them from the roster for the whole team, so
it is admin only; their Printavo history is untouched and the daily sync
cannot undo it.`,
  },

  {
    app: "shopstock",
    title: "ShopStock (supply inventory)",
    keywords: ["inventory", "supplies", "stock", "reorder", "ordering",
      "qr", "label", "scan", "barcode", "supply", "vendor price"],
    body: `ShopStock tracks the shop's supply inventory: what we hold, what is
running low, and what needs ordering.

THREE SCREENS. Dashboard is the working view of what needs attention. Full
Inventory is everything. Admin holds the settings and bulk tools.

QR LABELS are the point of the app for most people. Every item can be printed
with a QR label, and scanning it opens that item to be counted or reordered
without hunting through a list.

A NOTE ON OLD LABELS. Labels printed before ShopStock moved into Alliteration
point at the old web address. A redirect keeps them working, and it has to
stay switched on until every physical label in the shop has been reprinted.
If an old label goes somewhere unexpected, that redirect is the thing to
check.

KNOWN ROUGH EDGE. Deleting a large number of items at once can time out,
because deletions still go one at a time. Small deletions are fine.`,
  },

  {
    app: "errorengine",
    title: "ErrorEngine (production errors and misprints)",
    keywords: ["error", "misprint", "mistake", "reprint", "quality",
      "root cause", "cost", "taxonomy", "units affected", "accountability"],
    body: `ErrorEngine is the quality and accountability layer. When something
goes wrong on a job it gets logged here, attributed to a cause and an owner,
costed, and then the patterns become visible over time.

FOUR SCREENS. Dashboard is the summary. Log an Error is the form. Records is
everything logged, searchable, with a detail view that opens when you click a
row. Manage Lists is where the error types and causes themselves are curated.

LOGGING AN ERROR. Pick the customer from the search, which reads the real
BackBone customer list and fills in the account manager automatically. Add
the line items affected and submit. Each record gets an EE number.

WHAT IT COSTS. The cost figure and the units affected are entered as part of
the record, not calculated from anywhere else. That is deliberate: the
dollars lost on a misprint depend on what was scrapped and what was reprinted,
which only the person who dealt with it knows.

WHO CAN DO WHAT. Anyone with the app can log an error and see the records.
Deleting a record is limited to administrators. Editing the lists of error
types and causes is limited to the roles allowed to manage lists, because
those lists are what every past record is filed under.`,
  },

  {
    app: "givinggauge",
    title: "GivingGauge (donation and sponsorship requests)",
    keywords: ["donation", "donate", "sponsorship", "request", "giving",
      "score", "charity", "school", "booster", "jotform"],
    body: `GivingGauge scores incoming donation and sponsorship requests so the
answer is consistent rather than depending on who read the email.

TWO SCREENS. Requests is the queue of what has come in and what it scored.
Giving is the money side: what donations have actually cost.

WHERE REQUESTS COME FROM. They arrive through the public request form and
land here automatically. Nobody re-types them.

HOW THE SCORE IS CALCULATED. The score comes from a scoring engine that is
kept deliberately separate from the rest of the app and is never recalculated
in the screen. That is a rule, not an accident: if a score looks wrong the
problem is in the engine or in the request data, never in the display. The
engine reads things like how much lead time the request gives and whether the
requester matches an existing customer account.

THE GIVING SCREEN. After a request is approved you can record what it actually
cost: the retail value, our real cost, the date and any notes. The Giving
screen rolls that up by month, by year, all time, and per customer, and shows
donation cost as a share of that customer's lifetime revenue. That last figure
is the one that answers "are we giving away more than this account brings in".`,
  },

  {
    app: "traveltrack",
    title: "TravelTrack (trips, expenses, mileage)",
    keywords: ["trip", "travel", "expense", "receipt", "mileage", "miles",
      "reimburse", "approval", "per diem", "conference", "show"],
    body: `TravelTrack covers trips and the money attached to them: expenses,
mileage reimbursement, and loyalty miles.

SIX SCREENS. Dashboard, Trips, Expenses, Redeem Miles, Reports, Settings.

EVERYONE LOGS THEIR OWN. This is a self-serve app. You enter your own trips
and your own expenses. Administrators and managers see everybody's and are the
ones who approve, reject, and mark expenses reimbursed. That split is enforced
on the server, not just hidden on the screen.

TRIPS carry one of five statuses: potential, confirmed, attended, did not
attend, and cancelled. Status can be changed from the list without opening the
trip. Team members can be added to a trip so it is clear who went.

EXPENSES. Mileage expenses are calculated as miles times the mileage rate set
in Settings. Everything else is entered as an amount. Expense types are colour
coded so a list can be read at a glance, and the whole list can be filtered by
type or viewed per trip.

CHECK THE MILEAGE RATE. The rate ships with a placeholder value. It lives in
Settings and should be set to what P&M actually reimburses before anybody logs
a mileage expense in earnest.

REDEEM MILES tracks loyalty miles redeemed against what is owed, with a
progress bar toward paying it off. It can be logged straight from the
dashboard.

THERE IS NO AUTOMATIC MILEAGE TRACKING and there is not going to be. Miles are
entered by hand. That is a settled decision, not a missing feature.`,
  },

  {
    app: "promopro",
    title: "PromoPro (purchase orders to vendors)",
    keywords: ["purchase order", "po", "vendor", "supplier", "blank",
      "receiving", "confirm", "ship", "artwork", "proof", "chase", "late"],
    body: `PromoPro is where purchase orders to vendors live and where you can
see what stage each one is at.

THE PROBLEM IT REPLACES. A PO was raised in QuickBooks, emailed to the vendor,
and from that moment the only record of what was happening lived in one
person's inbox. Nobody else could answer "did they confirm", nothing had a
clock on it, and a vendor who had gone quiet for six days looked exactly like
a vendor who replied yesterday.

FOUR SCREENS. Pipeline is every open PO grouped by stage with the worst health
first. Purchase Orders is the full list plus the create form. Vendors is who we
buy from and how long each one normally takes. Settings holds the defaults.

BUILDING A PO. Either from a Printavo quote, or from nothing at all for a
manual web order. It gets emailed to the vendor from here, with the P&M logo
on it, and then tracked through submitted, confirmed, art, payment, ship and
receive.

HOW THE HEALTH COLOUR IS CALCULATED. Each stage has a clock, measured against
how long that particular vendor normally takes rather than one shop-wide
number. The colour comes from a single shared function used by both the screen
and the server, so the same PO can never show two different healths in two
places.

ACCOUNTING HAS NOT MOVED. The vendor bill still gets entered in QuickBooks
when it arrives. What moved into PromoPro is the open-order picture, not the
books.

WHO CAN DO WHAT. Reading is deliberately wide, so an account manager can
answer "where is my order" without asking anybody. Creating and editing needs
edit rights. Deleting is administrators only.`,
  },

  {
    app: "crewcore",
    title: "CrewCore (employees, time clock, stipend)",
    keywords: ["employee", "hr", "staff", "team", "roster", "clock",
      "punch", "timecard", "hours", "overtime", "stipend", "apparel",
      "review", "one on one", "handbook", "pay", "rate", "pto",
      "reports to", "manager", "kudos", "praise", "credit", "recognition",
      "thank", "documentation", "write up", "written warning", "discipline",
      "incident", "problem", "issue"],
    body: `CrewCore is employee management: the roster, the time clock, apparel
stipends, review history, and the employee handbook.

NINE SCREENS. Dashboard, Roster, Time Clock, Stipend, Samples, Kudos, Reviews,
Handbook, Settings. Roster here means employees. In BackBone the same word means
customers, which is worth knowing when somebody says "check the roster".

SELF-SERVE. An employee account sees their own record without the hourly rate
and admin notes, their own stipend allotment and spend history, their own
review history read-only, and the full handbook. Everyone else with the app
gets the admin views. This is enforced on the server.

THE TIME CLOCK has two halves. The /clock kiosk is a public page with no
platform login, because production staff do not all have accounts: pick your
name, type your passcode, clock in or out. It is protected by a kiosk token, a
per-employee passcode, and throttling on repeated attempts. The Time Clock
screen inside CrewCore is where those timecards are read, filtered, corrected
and exported.

HOW HOURS ARE CALCULATED. A record is a SHIFT, with a clock-in and a
clock-out, rather than a flat list of punches. A forgotten clock-out is then
one visible open shift instead of a corruption that shifts every pair after
it. Lunch is a second shift, which is how payroll wants it. A shift running
over 18 hours is treated as a forgotten clock-out, deliberately generous so a
genuine 14-hour press day during a rush does not get flagged.

TIMES ARE STORED IN UTC BUT BUCKETED IN CENTRAL. A 6 AM Central punch is 11:00
or 12:00 UTC depending on daylight saving, so filing it by the UTC date would
misfile early punches half the year and push late Saturday shifts into the
wrong pay week.

THE APPAREL STIPEND is an annual allotment per employee, defaulting by
department per the handbook's dress code policy: $250 for front office, $150
for production. It can be overridden per person. The spend log is maintained
by an administrator and nets against the allotment.

SAMPLES is SanMar's twice-a-year sample drop. An administrator starts a drop
and imports its catalog by pasting the style lists off the back of SanMar's
order form, one list per discount tier. Colours, sizes, photos and prices come
from SanMar's own feed, so there is no price list to attach and no colour
group to work out.

A SAMPLE PICK COMES OFF THE APPAREL STIPEND STRAIGHT AWAY, at the moment it is
made rather than when the box arrives, which is why your remaining balance
sits at the top of the screen while you are choosing. Removing a pick removes
its stipend entry with it. The same style can be picked more than once in a
different colour or size, because those are different garments.

SAMPLE PRICING always comes off SanMar's regular case price, never off a
temporary sale, so a drop priced during a sale week does not go out at a
number that expires before the order ships. Every figure is worked out on the
server; nothing the browser sends can price a line.

EXPORT CSV on a drop produces the sheet that goes back to SanMar, one line per
pick, grouped by person.

KUDOS is credit handed out in public. Anybody with CrewCore can give it, to
anybody else on the roster, and everybody reads the same feed. That is
deliberate: praise only two people can see is a private message, not kudos. It
is the one screen in this app a self-serve employee can write to.

Nobody can give themselves kudos; the server refuses it rather than relying on
the picker leaving your own name out. There is no editing one. Whoever wrote it
can remove it, and so can an administrator, but the person it was written about
cannot: somebody being thanked in front of the shop should not be able to
quietly delete the record of it, and an unwanted one is a conversation rather
than a delete button.

DOCUMENTATION is the opposite of kudos and lives on the Reviews screen, as a
second tab next to the review history. It is where an issue or a problem gets
written up: the date, what it was about, how formal it is (a note, a verbal
warning, a written warning, a final warning, a performance plan), the write-up,
what was done about it, who else was present, and a follow-up date.

DOCUMENTATION IS ADMINISTRATORS ONLY, INCLUDING FROM THE PERSON IT IS ABOUT.
An employee opening Reviews sees their own review history and no second tab.
This is not a hidden button: the entries are stored separately from reviews and
the route behind them refuses anybody without the Admin flag on every request,
so nothing anywhere has to remember to filter them out.

REVIEWS AND DOCUMENTATION ARE DIFFERENT THINGS. A review is a conversation the
employee took part in and can read back. Documentation is a record kept about
them. They sit on one screen because that is where anybody would look for
either, not because they are the same kind of note.

REPORTS TO is the field that says who somebody's manager is. It is what the
"My team" tab in Notifications reads to work out whose work to show a manager.

PTO IS NOT HERE. Time off tracking stays in QuickBooks. That is settled.`,
  },

  {
    app: "mailme",
    title: "MailMe (email marketing)",
    keywords: ["email", "send", "campaign", "blast", "unsubscribe",
      "suppression", "bounce", "spam", "resend", "domain", "list",
      "contact", "prospect", "cold outreach", "reply to"],
    body: `MailMe is the email tool: writing an email, choosing who gets it,
sending it, and seeing what came back.

FOUR SCREENS. Sends is the list of emails and where you start a new one.
Audience is every contact with lists as a filter down the side. Reports is what
happened after a send. Settings holds the sending identities and options.

A NOTE ON THE WORD CAMPAIGN. In MailMe a record is ONE EMAIL, and the tab is
called Sends for that reason. A campaign in the wider sense, the whole
multi-channel effort, lives in MarketMachine. Both apps calling their record a
campaign meant the word answered two different questions.

WHAT HAPPENS AT SEND TIME. Four things are re-checked immediately before every
send, every time, no matter what triggered it: that the email is CAN-SPAM
compliant, that the sending domain shows verified with the provider right now,
that a from-address is set, and the current suppression status of every single
recipient. A draft can sit for weeks, so nothing about it is trusted as still
true. Somebody who unsubscribes mid-send does not receive the email.

SENDING IDENTITIES. P&M runs three businesses, so sends go out as PM Apparel,
Flyover Con, or Iowa On Demand. Each identity has its own domain and
from-address, and each campaign picks which one it sends as. Adding a brand is
a Settings change, not a deploy.

WHY SOMEBODY DID NOT GET AN EMAIL. Every excluded recipient is listed with a
reason: wrong audience, duplicate mailbox, unsubscribed, frequency cap, or an
open quote. If a list of three sent to one person, that screen says why.

ONE EMAIL PER MAILBOX. The same person on two contact records, which happens
because people appear under more than one company, gets one email and not two.
The duplicate is held with a visible reason rather than silently dropped.

REPLY-TO. In account-manager mode the reply address is worked out per
recipient from the account manager on their contact record, so a send spanning
two AMs routes each reply to the right person. Anything that does not reduce
to a clean first name falls back to the fixed address rather than inventing a
mailbox.

SEND TEST TO ME sends one preview copy to any address and touches no
statistics, no queue and no status. Use it before real customers see anything.

SCHEDULED AND MULTI-DAY SENDS run themselves. A background job checks every 15
minutes, so nobody needs to be signed in. A campaign that fails three runs in
a row stops retrying and waits for a person.`,
  },

  {
    app: "marketmachine",
    title: "MarketMachine (campaigns, start to finish)",
    keywords: ["campaign", "marketing", "checklist", "postal", "mailer", "trade show",
      "digital platform", "poll", "referral", "sampling", "gifting", "parade",
      "live printing", "prelaunch", "post-launch", "timeline", "due date", "approval"],
    body: `MY TASKS is the first screen and the simple way in. It lists only the open
steps with your name on them, one line each, with a short line on why the step
exists, when it is due, and a box to tick. Nothing else: no stages, no
formulas, no other people's work. Anything waiting on somebody else's step sits
under its own heading rather than being listed as due. A step whose owner is a
job rather than a person ("Assigned staff", "Production") is nobody's task and
stays on the campaign page. Ticking your own step from here is the one thing a
person who is not an Admin can change.

MarketMachine runs each marketing campaign as an ordered checklist. It
was rebuilt in September 2026 from Jacob's campaign handoff. It is open to
Admins only for now.

PICK A TYPE AND THE STEPS ARE LAID OUT. There are fourteen campaign types:
Digital Platform, Poll Sending, Picks with Personality, Referral, Sampling,
Postal, In-Order Gifting, This One Is On Us, Christmas Gifting, Parade Day,
Live Screen Printing, Live Customization, External Trade Show, and Try On Day.
The New campaign menu lists the most used types first.

TRY ON DAY takes garment samples to a client so their people can try things on
and order from the client's online store. Its rules: at least 25 participants
(fewer shows a warning and needs Jacob's approval, it does not block), indoor
only, an active or scheduled store, every sample bought upfront and returned to
be counted back into stockroom inventory, Jacob second-reviews the Printavo
invoice before anything is ordered, and the return date is its own date, never
Printavo's invoice date.

EACH CAMPAIGN ALSO HAS ITS OWN NUMBERS, from its master document: Parade Day's
order gap and cost per CTA interaction, Sampling's response and conversion
rates, Referral's conversion and fiscal-year revenue, Poll Sending's opt-in and
completion rates, and so on. Underneath them is a results scorecard with the
metric rows that campaign's master asks for, each with a target, actual, date
range, source and a note on what the number leaves out. Postal, Christmas
Gifting and Live Screen Printing have the shared five only, because their
master documents have not arrived yet.

SIX STAGES ON EVERY CAMPAIGN: create, plan, build, prelaunch review, launch or
event, and track and review. Each step shows its owner, due date, a done box,
the date it was done, notes, blockers, and links to files such as Printavo
invoices.

DUE DATES ARE SUGGESTED from one date on the campaign, usually the launch or
event date. Moving that date moves every suggested date. A due date somebody
set by hand stays where they put it.

SOME STEPS WAIT FOR OTHERS. Launch steps stay locked until the prelaunch review
is approved. Ryan or Megan approves it; either one is enough. Only steps the
handoff allows can be marked not applicable.

AN EXTERNAL TRADE SHOW HOLDS CONNECTED CAMPAIGNS. Postal, Digital Platform,
Live Screen Printing, Live Customization, and Sampling can each run under a
trade show with their own owner, dates, audience, and checklist. The show's
page lists each one's next step and any blocker.

CONNECTIONS, at the bottom of every campaign, show what it is tied to in the
other apps: emails in MailMe, trips and their receipts in TravelTrack, leads in
BackBone, and Printavo invoice numbers. Each is read live from its own app and
never copied. On a trade show, everything on its connected campaigns rolls up
and is counted once, so an invoice or lead on both is not added twice. A lead
is credited to the campaign that connected it first. Printavo statuses are
checked when you press Check status, because Printavo is slow. Start an email
in MailMe from the campaign; the Account Manager writes it there.

CALCULATIONS sit above connections: expected orders, expected revenue,
expected gross profit, event ROI (estimated and actual), and, on a trade show,
strategic completion. Each shows its formula, the numbers going in, where each
came from, and when it last changed. Connected leads and TravelTrack receipts
are read live. Conversion rate, average order value, average gross profit,
other expense, and influenced gross profit are typed with a note on where the
number came from. When something is missing or a divisor is zero, the card
says what is needed instead of showing a number. A blank is unknown, not zero.

TIMELINE shows launch dates and review dates by month, quarter, or year.

EXAMPLE CAMPAIGNS can be loaded from Settings for showing the app to somebody:
five made-up campaigns, every one named EXAMPLE, including a trade show with
two campaigns connected under it. Removing them deletes only the examples,
matched on a flag rather than the name, so a real campaign somebody called
EXAMPLE is never touched.

SETTINGS shows every campaign type's starter steps, holds the lead list that
BackBone's lead form uses, and can delete the old sample campaigns from before
the rebuild.

A CAMPAIGN KEEPS THE CHECKLIST IT STARTED WITH. Changing a type's steps later
changes new campaigns only.`,
  },

  {
    app: "teletally",
    title: "TeleTally (call tracking) - not built yet",
    keywords: ["phone", "call", "calls", "answered", "missed", "voicemail",
      "talk time", "teletally"],
    body: `TeleTally is planned and not built. The rail entry exists so the
place is held, but there is no functionality behind it.

WHAT IT WOULD DO when it is built: connect to the shop phones and show call
volume, who is answering versus missing calls, talk time, and a comparison
across the team.

There is nothing to use yet and no data behind it.`,
  },

  {
    app: "websitewidget",
    title: "WebsiteWidget (website traffic)",
    keywords: ["website", "traffic", "analytics", "ga4", "google analytics",
      "visitors", "sessions", "pageviews", "channels", "top pages", "seo"],
    body: `WebsiteWidget shows website traffic for every site P&M tracks.

WHERE THE NUMBERS COME FROM. Google Analytics, read through a shared Google
service account. One login reads several properties as long as it has viewer
access on each.

THREE SITES: PMApparel.com, IowaOnDemand.com, and Flyover Con. Site tabs run
across the top of the dashboard.

TWO SCREENS. Dashboard shows visitors, sessions, channels and top pages for
the selected site. Manage Sites is where sites are added, renamed or removed,
and it is limited to admins because it changes what the
whole team sees. Adding a site is a settings action, not a deploy.

COMPARISONS. The dashboard can compare against the previous period or the same
period a year earlier. A breakdown row is matched to its prior figure by name
rather than by position, so a row that moved up or down the list is still
compared against itself. A row with no match in the prior period is reported
as unknown rather than as zero, because a genuine zero and a missing row mean
different things.

IF A CARD FAILS. Each card is independent. One breakdown Google refuses costs
that one card, not the whole dashboard, and the card says what went wrong
rather than showing a confident zero.

IF EVERYTHING READS ZERO for PMApparel.com, that is expected until the domain
is pointed at the new site. The analytics property is real but nothing is
flowing into it yet.

ACCESS. Any signed-in user. This is aggregate traffic, not pay or customer
data.`,
  },

  {
    app: "stitchsense",
    title: "StitchSense (embroidery stitch counts)",
    keywords: ["embroidery", "stitch", "stitches", "count", "dst", "digitize",
      "quote", "pricing", "artwork", "colorway", "thread", "guess"],
    body: `StitchSense estimates stitch counts so embroidery can be quoted
before the design has been digitised.

FIVE SCREENS. Estimate is the quoting tool: drop the artwork, enter the
finished size, get a stitch range. Library is every design we own with its
true count, and where a design gets requoted at a new size. Colorway takes a
DST and lets you assign a thread colour per block and export a picture. Stitch
Guess is a training game for the embroidery team. Accuracy shows how the tool
is actually doing against real jobs.

THREE INPUT PATHS, IN ORDER OF HOW MUCH TO TRUST THEM. First, we already have
the DST: that is exact, with no estimating at all. Second, we have the design
at another size: it is rescaled from the known count, which is accurate
because the hard part, reading the artwork, is skipped. Third, the customer
sent a PNG or a JPG: that is a real estimate, it is the common case, and it is
the least accurate. The screen says so rather than printing four confident
digits.

HOW THE ESTIMATE IS CALCULATED. From how much of the area the design actually
covers and how many colours it uses, through a model fitted on the shop's own
archive of nearly six thousand DST files. On that archive the typical error is
around 18 percent. Whether it holds up when a customer PNG is the input rather
than a DST is exactly what the Accuracy screen exists to answer.

WHAT FILES WORK. DST, PDF, AI, and ordinary images. An AI file works because
since version 9 it can carry a PDF inside it, and if a particular file does
not, the app says so plainly instead of failing quietly. EPS is refused with a
clear message.

WHY COLORWAY WORKS. A DST carries colour CHANGES but no actual colours, so the
blocks arrive already separated with nothing baked in that has to be stripped
out.`,
  },

  {
    app: "concontrol",
    title: "ConControl (event sponsors and money)",
    keywords: ["event", "flyover", "flyover con", "foc", "foc27", "sponsor",
      "sponsorship", "tier", "committed", "invoiced", "collected",
      "outstanding", "deliverable", "logo", "swag", "conference"],
    body: `ConControl tracks an event: who sponsors it, what they owe, and
what they still have to send us. Flyover Con is the first event through it.

SEVEN SCREENS. Home is what is committed, collected, outstanding, and waiting
on somebody. Responses is everything people sent us, in four streams. Sponsors
is who is in and what is owed each way. Money is income and
spend in one ledger against the budget. Sessions is the program grid and the
place the public agenda reads from. Speakers is proposals, confirmations and
what each speaker still has to send. Settings holds the levels, the spend
categories, the dates and who gets told when the website sends something in.

WHAT A SPONSOR RECORD HOLDS. The company and contact, the level they bought,
the amount committed, whether an invoice has gone out, every payment received
as its own line, any individual moments they have claimed, and a four-item
deliverables checklist: logo received, swag item received, social posted,
session scheduled.

THE LEVELS, AS SOLD. Presenting is 7,000 and there is one of it. Gold is 2,500
and there are three. Silver is 1,000 and unlimited. In kind and single-moment
sponsorships have no set price. The levels are stored rather than written into
the code, so changing one for the next event is a settings edit.

WHAT IS STILL OPEN. The board counts the places left at each capped level and
who has claimed each individual moment: happy hour, day one lunch, day two
lunch, breakfast, swag bags. A place is only taken when a sponsor is COMMITTED.
An inquiry is shown as in conversation but holds nothing, because holding one
of three Gold places for somebody who emailed once is how a sponsor who is
ready to pay gets told there is no room. Selling more than there are, or two
sponsors on one moment, is flagged rather than quietly absorbed.

THE THREE-STATE CHECKLIST IS THE POINT. Each deliverable is open, done, or
N/A. N/A means that sponsor never owed it, which is a real answer somebody
gave. In a spreadsheet a blank cell meant "not yet" or "never owed one" and
only the person who typed it knew which. N/A rows are left out of the count,
so a Bronze sponsor who sent everything they owed reads as complete rather
than sitting at two of four forever.

MISSING IS NOT ZERO. A sponsor with no agreed amount is reported as unpriced
rather than counted as free, so the committed total is never quietly propped
up by records nobody has priced.

WHAT THE TOTALS MEAN. Committed is what sponsors agreed to. Collected is what
has actually arrived. Outstanding is the difference, and it covers only
sponsors with an agreed amount. "Needs a nudge" counts sponsors waiting on us:
somebody who committed and was never invoiced, somebody who committed with no
amount agreed, and any invoice unpaid for thirty days or more.

DECLINED AND WENT QUIET ARE KEPT OUT OF EVERY TOTAL, so a sponsor who said no
in March does not sit in this year's outstanding column.

WHERE INQUIRIES COME FROM. The event site's sponsor page posts straight in, so
an inquiry lands as a record rather than as an email somebody has to re-type.
A company that submits twice appends to the record it already has instead of
becoming a second one. That form can never set money, status or deliverables.

BOTH SIDES OF THE DEAL ARE TRACKED. The checklist above is what a sponsor sends
us. A second list is what we promised THEM, taken off the sponsor page one row
per bullet, because that page is what they read before saying yes. Silver has
four: signage and website and agenda, a mention at opening and closing,
materials in the bags, group social and recap inclusion. Gold adds four: the
intro to the room on day one, recognition at sessions and lunch, dedicated
social features, and the opt-in attendee list afterwards. Presenting adds five:
the event branded as presented by them, stage recognition with the welcome
address offered, their logo on the bags and the apparel, featuring in all
pre-event and post-event social, and first refusal on the 2028 slot. Every level
also gets their team registered for both days with meals, which is the promise
in the box above the levels and the easiest to forget because it is not in a
level box.

It is filled in from the level rather than by hand, so a Silver sponsor is never
shown owing a welcome address. A sponsor who never sent a logo is an annoyance;
a sponsor who paid and never got what they were sold is a refund conversation.
When the sponsor page changes, this list has to change with it: a bullet on the
page with no row here is a promise nobody is tracking.

CASH, CREDIT AND IN KIND ARE THREE DIFFERENT THINGS. Each payment records how
it arrived. Cash is a check or a transfer, money in the bank. A credit is a
credit on our account with that sponsor, which does not arrive: it means we do
not spend that much with them. In kind is goods or services they provide
directly, like the video or the swag.

ALL THREE SATISFY THE SPONSOR. Somebody who gave a 7,000 credit for a 7,000
level has paid in full, owes nothing, holds their place, and is owed everything
that level promises.

AND ALL THREE CAN COVER THE BUDGET. A credit with a supplier we were going to
spend that money with anyway is worth its face value to the event: the money
simply never leaves. So the question is not what kind of payment it was but
whether we would have spent it regardless, and that is its own tick box on each
payment. It is on by default for credit and in kind, because that is the normal
case. Untick it for something we are glad to have and were never going to buy,
like a branded photo booth, and it is reported as extra and stays out of every
budget figure.

BEING IN THE BANK IS A SEPARATE QUESTION, and both get asked, so both numbers
are there. Money in is what covers the budget. In the bank is cash that has
actually arrived. Position today runs on the first; the same sum on cash alone
is there beside it.

MONEY IS COUNTED IN STAGES, NOT ONE NUMBER. On the spend side an entry is an
estimate, a commitment, or paid, and those are reported apart because "we have
spent this" and "we are on the hook for this" are different sentences. Sponsor
income is never typed into the ledger: it is read off the sponsor records, so
the two cannot drift.

THE PROGRAM IS THE RECORD. Only confirmed sessions with a day and a time reach
the public agenda; everything else is a plan. Two sessions in one track at one
time, a session running against lunch, a confirmed session with no time or no
speaker are all reported rather than quietly shown. The agenda feed carries
names, companies, bios and headshots and never an email address or a phone
number.

RESPONSES IS WHAT PEOPLE SENT US, NOT WHAT WE DECIDED. Four streams on one
screen, one per form on the event site: the audience survey, the notify list,
sponsor applications and speaker applications. A stream holds what was
SUBMITTED, so a sponsor typed in by hand, a prospect carried over from last
year, and a name somebody wrote in a survey box are all absent from it. Those
are ours, not theirs. The survey lays out what shops asked to be taught, showing how many
picked each topic among their five and how many named it as the one session they
would not miss. Those two numbers are kept apart because they disagree in useful
ways: a topic seven people picked and nobody named is something they want in the
room but will not travel for.

A RESPONSE IS NOT A PLAN. Nothing on that screen writes itself into the program.
A topic becomes a session idea when somebody presses the button on its row, and
the idea arrives with no day and no time. What people asked for and what we
decided to teach are two different lists, and collapsing them means you can
never again ask what they actually said. Rows already turned into ideas are
marked, so it is clear which asks have been acted on.

The survey and the notify list are imported by pasting the CSV export of the
sheet. That is deliberate rather than a copy kept in the app: the survey carries
names, email addresses and people writing candidly about their own businesses,
and it goes stale the day somebody answers again. Pasting the same export twice
is safe; a response already there is matched on email and time and skipped.

Responses is not open to read-only accounts, unlike sponsors and sessions,
because of what people wrote in it.

WHAT ARRIVES BY ITSELF. The sponsor page and the call for speakers both post
straight in. A repeat submission updates the record it already has. Neither
form can set money, status or mark anything received. If a username is set in
Settings, each one also raises a notification.

ACCESS. Any signed-in user can read sponsors, sessions and speakers, because
"did that sponsor ever send their logo" is a question anyone working the event
should answer without asking. The Money screen is not open to read-only
accounts. Editing needs edit rights. Deleting is admin only: the record holds
what was agreed and what was paid. Settings is admin only. Exporting follows
the export permission.`,
  },

  {
    app: "notifications",
    title: "Notifications (tasks, needs, hand-offs)",
    keywords: ["notification", "task", "todo", "assign", "assigned",
      "hand off", "handoff", "need", "reminder", "due", "bell", "filter",
      "my team", "private", "reassign", "history"],
    body: `Notifications is the shared to-do and hand-off list. It spans every
app rather than belonging to one, which is why it sits with Settings rather
than in the app list.

WHO CAN USE IT. Everybody signed in. Anyone can create one and assign it to
anyone, including themselves.

THREE TABS. "Assigned to me" is your own list. "I assigned" is what you have
handed to other people. "My team" shows what is on your people's plates, and
it only appears if you have direct reports recorded in CrewCore, or you are an
administrator with none recorded yet, in which case it shows everybody. Your
own items stay off your team tab, because the first tab already answers that.

TYPES. A notification is tagged as a Task, a Need, or a Hand Off, and can
carry more than one tag. It is also tagged with which app or apps it concerns,
or General for things like restocking the coffee.

FILTERING. The bar under the tabs filters by search text, app, type, due date
and status, plus by person when more than one person's work is on screen.
Search covers the title, both people's names, and the linked record. "Within 7
days" deliberately includes anything already overdue, because something due
Monday still needs doing this week. Active filters highlight themselves and
the count line reads "showing 3 of 40", so a short list always has a visible
reason.

LINKING TO A RECORD. A notification can point at a specific inquiry, lead or
customer, and the link opens that record in its own app. Some are attached
automatically, such as a travel expense decision or a donation decision.

HISTORY. Every notification keeps an append-only log: who created it, every
reassignment with any message attached, who marked it done, and every edit
with the before and after values. This is the Printavo Tasks pattern: a
question gets asked by reassigning with a message, and the answer comes back
the same way, with both hops staying visible.

WHO CAN CHANGE ONE. The assignee, the creator, or an administrator. Deleting
additionally depends on a per-role setting, though administrators always keep
it.

"JUST FOR ME" makes a notification private. Nobody else can see it, not even
an administrator, and it stays assigned to you. Administrator access is a
permission over shared work, not a licence to read somebody's personal list.

THE BELL in the header shows how many open items are assigned to you and takes
you to this screen.`,
  },

  {
    app: "settings",
    title: "Settings (accounts and access)",
    keywords: ["settings", "account", "user", "password", "role",
      "permission", "access", "grant", "admin", "superuser", "full access", "data scope"],
    body: `Settings is where accounts and access are managed. It is limited to
administrators.

ACCOUNTS. One screen listing every account, where accounts are created, roles
assigned and passwords reset.

ROLES, NOT PEOPLE. Access is granted to a role and people are put in roles.
A role carries which apps it can open, whether it can edit, whether it can
export, whether it can manage lists, whether it can delete notifications, and
its data scope.

DATA SCOPE is the important one. "All" sees everything in an app. "Own" sees
only their own records: their own accounts in BackBone, their own trips and
expenses in TravelTrack, their own record in CrewCore. It is enforced on the
server in every app, so it is not something a screen can be talked around.

ADMIN is a separate flag on the account itself rather than a role, ticked per
account on this screen. It overrides app access and is what makes the Site Work
section visible. It was called Superuser until Aug 2026; the protected role
that manages accounts is now labelled "Full access", so the two are not both
called Admin.

ONE LOGIN EVERYWHERE. Changing somebody's role changes it across every app at
once, because there is only one account.`,
  },

  {
    app: "reviews",
    title: "RaveReviews (Google review requests)",
    keywords: ["review", "reviews", "google review", "google", "rave", "raves",
      "review request", "picked up", "pickup", "shipped", "zapier", "zap", "feedback"],
    body: `RaveReviews sends the email asking a customer for a Google review,
three days after their order is picked up or shipped. It replaced two Printavo
automations that fed a Zapier zap. It is admin only.

HOW AN ORDER GETS IN. Four times a day during business hours it asks Printavo
which invoices are sitting at ORDER SHIPPED or PICKED-UP. Printavo does not
record when a status changed, so the first check that finds an order there
counts as its pickup, to within a few hours. The order is queued with a send
date three days later. The very first check after it was installed only
recorded the orders already at those statuses, because Zapier had already
emailed them.

WHAT THE CUSTOMER GETS. A plain text email from P&M Apparel, subject the
invoice number and order nickname, greeting them by first name. The text is
editable in Settings, with a preview and a Send test button.

WHO IS SKIPPED, decided on the day it would send, not the day it was queued:
anyone marked as having already left a review, anyone on MailMe's do not
email list (unsubscribed, bounced or complained), anyone with no usable email
on the Printavo contact, and an address that was already sent a request in
the last seven days, so two orders picked up the same week send one email.
Repeat customers who have not reviewed are asked again on a new order. Google
does not tell us who reviewed, so that list is kept by hand.

THREE SCREENS. Requests shows every request as Waiting, Sent, Skipped with the
reason, Cancelled or Failed, with Send now, Cancel, Put back in line and Left a
review buttons. Send now asks before overriding a skip. Reviewed is the list of
customers who will never be asked again. Settings holds the on and off switch,
the email text, the timing, the Printavo statuses, Check Printavo (what it
would find right now, saving nothing) and Run now.`,
  },

  {
    app: "stickies",
    title: "StickySituations (building the platform)",
    keywords: ["sticky", "notes", "stickysituations", "situations", "site work",
               "backlog", "build", "idea", "copy"],
    body: `StickySituations (called Sticky Notes until Sep 2026) is the list of
work on building Alliteration itself:
ideas, bugs and things to add. It is admin only, enforced on the server as
well as hidden from the rail.

ONE SCREEN, the Board: notes laid out to be scanned rather than filed.

It is deliberately separate from Notifications. Notifications is team hand-offs
about running the business. This is the build-the-platform list, and mixing the
two would bury one in the other.`,
  },
];

// Convenience for the route and the tests: the ids that have a doc.
export const DOCUMENTED_APPS = DOCS.map((d) => d.app).filter(Boolean);
