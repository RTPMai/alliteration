# Deploy: BackBone lead lifecycle (S-0001, S-0002, S-0003, S-0004)

Sep 4, 2026. Built from a fresh clone of RTPMai/alliteration (commit c22dfa5).
Thirteen files, two new API routes, no new environment variables, no data
migration.

**Suite: GREEN. 62 files, 2,094 checks, 0 failures.** It was green on arrival
too (60 files, 2,025 checks), so all 69 new checks are this work.

Re-cloned immediately before packaging. No drift on any shared file
(`js/api.js`, `js/registry.js`, `js/shell.js`, `css/tokens.css`, `vercel.json`).

`apps/backbone/main.js` is 703 KB, so **this goes through git clone-and-push,
never the web uploader.**

---

## THE ONE DECISION EVERYTHING ELSE HANGS OFF

Archive is a flag sitting **beside** the lead's status, not a status of its own.

The card said Archive was a stage after Death Call, and on screen it reads that
way. It is not stored that way, for three reasons:

The lead keeps the stage it was standing in and its whole history, so restoring
puts it back exactly there rather than guessing. Won, Lost and Reach Back Out
stay the real exits, so the funnel percentages keep meaning what they say. And
the same mechanism covers **clients**, which have no lead status at all, which
is what lets S-0004 be one screen instead of two that drift apart.

---

## 1. ARCHIVE WITH A REQUIRED REASON (S-0001)

Archiving is offered from three places: a lead's own panel, the selection
toolbar on the pipeline for a batch, and a client's panel on the roster.

All three open the same reason dialog, which will not proceed without a reason
off the list. `api/leads-save.js` refuses to store an archived lead with a blank
reason, and `api/archived-clients.js` refuses an off-list reason outright, so
the list is not merely a suggestion the browser makes.

**Two things about editing the list later.**

Removing a reason does **not** rewrite records already archived under it. The
reason is copied onto the record when it happens, so the forty leads filed under
"Not a fit" stay readable after you delete that line. It just stops being
choosable.

And `leads-save.js` deliberately does not re-check old reasons against the live
list. If it did, retiring a reason would make every future save of every lead
archived under it fail, which turns a settings edit into an outage.

**The list, seeded with eight, editable in BackBone Settings:** Disqualified,
Not a fit, No response after Death Call, Went with another supplier, Out of
business or closed, Duplicate record, Bad or fake inquiry, Too small to pursue.
Editing is admin only. Tell me what to add or cut and I will change the seed;
after deploy it is a Settings edit either way, not a deploy.

The admin gate is the per-account Admin flag or the protected admin role. It is
deliberately **not** `data_scope === "all"`, which defaults to "all" on any newly
created role. That is the trap CrewCore hit in August.

## 2. EVERY LEAD HAS A NUMBER (S-0002)

Format `L-00042`, matching EE and the PO numbers. New column on the pipeline,
on the lead's panel title, and searchable on the Archived screen.

**Numbers are issued by the server, never by the browser.** Two people with the
pipeline open would each work out the same "next" number and the second save
would quietly take the first one's. Only `api/leads-save.js` sees the whole list
at once. There is a test that fails if number-issuing logic ever appears in
`main.js`.

The backfill numbers oldest first, so L-00001 is genuinely the first lead we
ever got rather than whichever record happened to sit first in the array. A
number once issued is never reissued or renumbered, including across a gap: if
L-00002 gets deleted, the next lead is not L-00002 again.

**On deploy this runs once, automatically.** The first time anyone opens Leads,
the app notices nothing is numbered and does one save to number the whole
pipeline, then reloads. It is a single extra save and then it never happens
again. If it fails, nothing breaks: the Lead # column shows dashes until the
next save.

## 3. DISQUALIFYING TAKES THE LEAD OFF THE LIST (S-0003)

Disqualifying is archiving with the reason already filled in.

The bigger half is automatic. A research run that scores a lead **Disqualified**
now archives it on the spot, whether that comes from the API button, a pasted
qualification, or a bulk v2 batch. That was the actual complaint: a disqualified
lead sitting on the working list is a lead every AM has to decide about again
every week.

**It always says so.** A single lead pops a message and closes the panel; a
batch import reports "4 came back Disqualified and went straight to Archived" in
its summary. An archive nobody was told about looks like a lead that vanished.

If an admin removes "Disqualified" from the reason list, the automatic path
stops rather than writing a reason the team has deliberately retired.

## 4. ARCHIVED MANAGER (S-0004)

New screen in the rail, between Scorecard and Settings. Tabs for Leads and
Clients, one search box across company, lead number, reason and note, plus a
reason filter. Two counts at the top.

Each row shows the reason, the note, who archived it and when, and for a lead
the stage it was standing in. Restore is one click.

Every archive and restore is kept as a trail on the record, so a lead archived
and restored three times reads as exactly that.

**A client stamp whose customer is no longer in the Printavo roster is shown,
not hidden**, flagged "not on roster". Dropping it silently would leave a record
nobody could see or restore.

## Client archives survive the sync

Worth knowing, because it is the part that would have quietly broken.

The roster is rebuilt from Printavo every morning. A flag written onto a synced
customer row lasts until the next reconcile and then undoes itself overnight. So
client archives are stored in their own record and folded onto the roster when
it is read. Same pattern merged clients already use, for the same reason.

The roster's "Total customers" tile now counts the same rows the table shows.
Two numbers on one screen disagreeing is how people stop trusting both.

---

## FILES

**New**

    lib/backbone/archive.js              the shared logic, browser and server
    lib/backbone/archive-store.js        KV for the reason list and client stamps
    api/archive-reasons.js               GET the list, PUT to replace it (admin)
    api/archived-clients.js              GET stamps, POST to archive or restore
    test/backbone-archive.test.cjs       26 checks on the logic
    test/backbone-archive-wiring.test.cjs 23 checks on the wiring

**Changed**

    api/leads-save.js       issues lead numbers, refuses a blank archive reason
    js/api.js               two endpoints, both in LIVE_PREFIXES
    js/registry.js          the Archived view
    lib/help/content.js     BackBone doc: seven screens, numbering, archiving
    apps/backbone/main.js   the archive module, filters, the new screen
    apps/backbone/template.js  the Archived page, the reason modal, Settings card
    apps/backbone/styles.js    archive styles, tokens only, no hex

`lead-lifecycle.patch` is the whole thing as one patch if you prefer `git am`
over copying files.

## To deploy

    git clone https://github.com/RTPMai/alliteration.git
    cd alliteration
    # copy the thirteen files in over the top, keeping their paths
    bash test/run.sh        # must say SUITE GREEN
    git add -A && git commit -m "BackBone: lead numbers, archiving, disqualify, Archived Manager" && git push

Verified two ways from a clean clone: files copied in, and the patch applied.
Both green.

## Check after deploy

1. Open Leads. Every lead should have a number within a few seconds of the page
   settling. Refresh once if the column shows dashes.
2. Open any lead, Archive, pick a reason. It disappears from the pipeline and
   the funnel gains an "Archived" tile.
3. Archived screen, Leads tab: it is there with its reason and its old stage.
   Restore it. It comes back at that exact stage, not at New.
4. Tick three leads on the pipeline and use Archive on the toolbar. All three
   take the same reason.
5. Paste a qualification with a Disqualified tier. You should get a message
   saying it was archived, and the lead should not be on the pipeline.
6. Roster: open a client, Archive client, pick a reason. They leave the roster
   and the Total customers tile drops by one. Restore from the Archived screen's
   Clients tab.
7. BackBone Settings, Archive reasons: edit the list, save, then open the
   archive dialog again and confirm the new list is what it offers. Anything
   already archived under a reason you removed still reads correctly on the
   Archived screen.

## Two things to decide

**The reason list.** Eight seeded, listed above. Say the word and I will change
the seed; otherwise edit it in Settings after deploy.

**Who can archive a client.** Currently admin only, because it hides a customer
from every AM at once. Archiving a *lead* is open to anyone who can edit leads.
If you want AMs able to archive clients too, that is a one-line change.

## Not touched

S-0006 referral tracking, S-0007 social links and S-0008 Capacity Manager are
untouched. S-0005 is still missing from the Site Work board, and I do not know
what it says.
