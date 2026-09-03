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
the platform, not to any one app. Sticky Notes is a third section, visible
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

SIX SCREENS. Dashboard is the numbers. Inbox is new inquiries as they arrive.
Leads is the pipeline for chasing them. Roster is the customer list.
Scorecard ranks customers. Settings holds the app's own options.

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
and fake inquiries before they reach anybody.`,
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
    title: "MarketMachine (campaigns across every channel)",
    keywords: ["campaign", "marketing", "channel", "postcard", "mailer",
      "social", "paid", "ads", "reach", "spend", "roi", "initiative",
      "calendar", "data entry", "metric", "definition"],
    body: `MarketMachine owns the campaign of record: what a campaign is for,
when it runs, what it costs, which channels it uses, and what came back.

WHY IT IS SEPARATE FROM MAILME. A real campaign is rarely only email. A spring
school push might be a postcard drop, a booth at a conference, a paid social
run and an email, all aimed at the same people over the same weeks. Keeping
the campaign inside the email tool made every other channel invisible and made
"did that work" unanswerable, because only one sixth of it was being measured.
MailMe keeps email: composing, suppression, the cold ramp, domain reputation,
CAN-SPAM. None of that has an equivalent in a postcard drop.

HOW THE TWO APPS TALK. One pointer, and MailMe holds it. An email in MailMe
carries the id of the campaign it belongs to, and MarketMachine asks "which of
your emails say they belong to me". MarketMachine deliberately does not keep
its own list of email ids, because two copies of one fact drift the first time
an email is deleted, and that drift shows up as reach that never happened.

FIVE SCREENS. Campaigns, Calendar, Data Entry, Definitions, Settings.

NUMBERS ARE TYPED IN BY HAND for every channel except email, and that is by
design rather than a gap. A postcard drop genuinely has no API. A number
somebody wrote down beats a number nobody has.

MISSING IS NOT ZERO. A finished item with no reach entered is reported as a
gap, not folded into the total as a zero. A rollup that silently counts
unknowns as zero looks authoritative and is wrong.

DATA ENTRY IS ITS OWN SCREEN rather than a form buried inside each campaign,
because entering last week's numbers is a chore spanning several campaigns at
once, and making somebody open each one is how the numbers stop getting
entered at all.

DEFINITIONS is generated from the metric catalogue itself, so it cannot drift
from the maths. It exists to settle the "these numbers look low" argument
before it starts.

THE MARKETING INITIATIVE LIST, the one BackBone uses on leads, lives here in
Settings. Changing it is a settings edit, not a code change.`,
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
    app: "stickies",
    title: "Sticky Notes (building the platform)",
    keywords: ["sticky", "notes", "site work", "backlog", "build", "idea"],
    body: `Sticky Notes is the list of work on building Alliteration itself:
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
