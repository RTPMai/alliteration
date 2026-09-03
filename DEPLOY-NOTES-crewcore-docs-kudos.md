# CrewCore: employee documentation, and kudos

Written Sep 3, 2026, from a fresh clone of RTPMai/alliteration (commit 5a68347,
Sep 2). Eleven files, no new environment variables, no data migration.

**Suite: GREEN. 1,889 checks, up from 1,822.** It was green before this too.

Verified two ways from a clean clone: the files copied in, and the patch applied
with `git am`. Both green.

`apps/crewcore.js` is 160KB, so this goes through git clone-and-push, never the
web uploader.

---

## 1. DOCUMENTATION

A place to write up an issue or a problem with somebody. It sits on the Reviews
screen as a second tab next to the review history, and nobody but an
administrator can read it, including the person it is about.

Each entry holds a date, what it was about (attendance, performance, conduct,
safety, quality, customer issue, policy, other), how formal it is (a note, a
verbal warning, a written warning, a final warning, a performance plan), one
line saying what happened, the full write-up, what was done about it, who else
was present, and a follow-up date.

The what and the how-formal are two separate fields on purpose. One list trying
to hold both ends up needing a row for every pairing, and "attendance" and
"written warning" are answers to different questions. The levels read in
escalation order, so a person's file read newest first makes a pattern obvious.

A warning shows a red chip in the list; a note shows a grey one.

### It is not a review with a private flag on it, and that was the main call

The reviews route already answers an employee with their own review history.
Storing documentation in the same place would make that answer depend on a
filter remembering to strip it. Forever. In every future edit to that route, in
the dashboard card that reads the newest review, and in anything that reports on
reviews later. One forgotten filter and a written warning is on the screen of
the person it was written about.

So documentation is its own record type under its own storage key, behind its
own endpoint, and that endpoint refuses anybody without the Admin flag on every
method including GET, before it reads anything at all. There is no filter to
forget.

It is also deliberately **not a view in the rail**. It is a tab drawn inside
Reviews, only for an admin, which means it cannot appear in anybody's rail even
if a role were mis-ticked in Settings.

### Two smaller rules worth knowing

A correction cannot move an entry onto a different person. Moving a write-up
from one file to another is not a correction, it is a delete and a re-write, and
the server pins the field regardless of what the browser sends. It also cannot
rewrite who first wrote it or when.

The one-line heading cannot be emptied by a correction. A list of entries with
no headings is a list nobody can scan, which defeats the point of keeping it.

## 2. KUDOS

Credit handed out in public. Anybody with CrewCore can give it, to anybody else
on the roster, and everybody reads the same feed. This is the one screen in the
app a self-serve employee can write to.

Three tabs: Everyone, For me, I gave. A kudos carries an optional label
(teamwork, went the extra mile, quality work, customer save, safety, attitude,
training someone) and a short message, capped at 600 characters.

- **Nobody can give themselves kudos.** Refused by the server, not just left out
  of the picker.
- **There is no editing one.** A kudos is two lines about a colleague; an edit
  trail on it would be heavier than the record. If it is wrong it gets removed
  and written again.
- **The author or an admin can remove one. The recipient cannot.** Somebody
  being thanked in front of the shop should not be able to quietly delete the
  record of it, and an unwanted one is a conversation with you rather than a
  delete button.
- **Somebody who has left is not in the picker** but is still resolvable in the
  feed, so an old kudos reads as their name rather than an id.

### Why the kudos endpoint hands back names

An employee cannot open the Roster (admin only since August), so without a name
list they would have nobody to pick. What comes back is ids and names only, of
people who have not been terminated, and never the department, rate, stipend,
notes or anything else on an employee record. A test asserts that shape field by
field, so a future edit widening it turns the suite red.

## 3. Dashboards

Your dashboard gained a "Kudos this month" card, which is a month rather than a
year on purpose: the question it answers is whether the thing is being used, and
a year-to-date figure in November says yes long after everybody stopped. It taps
through to the feed.

An employee's dashboard gained a Kudos card: how many they have had this year
and who the latest was from. It loads in its own try like every other card
there, so a bad day on one endpoint costs one card rather than the screen.

---

## FILES

**Changed**

    apps/crewcore.js            the Reviews tab strip, documentation screens,
                                the kudos feed and form, both dashboard cards
    js/api.js                   two endpoints plus their offline shapes
    js/registry.js              the Kudos view, and kudos inside the
                                self-serve ceiling
    lib/users.js                kudos on the employee role and in the ceiling
    lib/help/content.js         the help bot's CrewCore entry: nine screens,
                                kudos, and who can read documentation
    lib/crewcore/schema.js      both record shapes, the filters, the delete rule
    lib/crewcore/store.js       storage for both

**New**

    api/crewcore/docs.js        admin only, every method
    api/crewcore/kudos.js       read and write for anybody with the app
    test/crewcore-docs.test.cjs   28 checks
    test/crewcore-kudos.test.cjs  35 checks

## First lines, check before uploading

| Save as | Line 1 starts |
|---|---|
| `apps/crewcore.js` | `/**` then ` * CrewCore — employee management for the whole team.` |
| `js/api.js` | `// PUT IN: js/api.js` |
| `js/registry.js` | `/**` then ` * alliteration. — app registry` |
| `lib/users.js` | `// lib/users.js — THE ONE GUEST LIST.` |
| `lib/help/content.js` | `// lib/help/content.js — the knowledge the help bot is allowed` |
| `lib/crewcore/schema.js` | `// lib/crewcore/schema.js — CrewCore data schema (v2).` |
| `lib/crewcore/store.js` | `// lib/crewcore/store.js — CrewCore's Upstash access layer.` |
| `api/crewcore/docs.js` | `// api/crewcore/docs.js — employee documentation: issues and problems.` |
| `api/crewcore/kudos.js` | `// api/crewcore/kudos.js — kudos: credit handed out across the shop.` |
| `test/crewcore-docs.test.cjs` | `/**` then ` * CrewCore documentation (Sep 2026).` |
| `test/crewcore-kudos.test.cjs` | `/**` then ` * CrewCore kudos (Sep 2026).` |

## To deploy

Either the patch:

    git clone https://github.com/RTPMai/alliteration.git
    cd alliteration
    git am ../crewcore-docs-kudos.patch
    bash test/run.sh        # must say SUITE GREEN
    git push

Or the zip, if you would rather see the files:

    git clone https://github.com/RTPMai/alliteration.git
    # copy the eleven files in over the top, keeping their paths
    bash test/run.sh        # must say SUITE GREEN
    git add -A && git commit -m "CrewCore: employee documentation and kudos" && git push

## Check after deploy

1. **CrewCore, Reviews.** There are two tabs now, Review history and
   Documentation, each with a count. Documentation opens on the amber
   administrators-only banner.
2. **Add documentation** on somebody. The header button changes with the tab, so
   on the Documentation tab it says Add documentation, not Log a review. Save
   it, click the row, read it back, edit it, save again.
3. **The important one.** Have somebody without the Admin flag (Amanda, or any
   self-serve account) sign out, sign back in, and open CrewCore, Reviews. They
   should see their own review history, one screen, **no tab strip at all**.
4. **Kudos** is a new rail entry between Samples and Reviews. Give somebody
   kudos. It appears for everybody, with your name on it.
5. **Have an employee give another employee kudos.** That is the half that
   needed the new grant. If the tab is missing from their rail, it is because
   permissions are issued at sign-in: sign out and back in.
6. **Try to give yourself kudos.** Your own name is not in the picker. If you
   ever get there another way, the server refuses it.
7. **The remove button.** It shows on kudos you wrote, and on everybody's for
   you as an admin. It does not show to somebody on one written about them.
8. **Your dashboard** shows Kudos this month; an employee's shows their own
   count and who the latest was from.

## NO NEW ENVIRONMENT VARIABLES, NO MIGRATION

Both features start empty. Nothing existing is read differently, and no stored
record changes shape.

---

## Two things that are not about this change

**The suite counts 1,889 checks in 56 test files.** Worth writing down since the
number moves constantly and no document should be trusted over a live run.

**Documentation and the handbook are unrelated despite both being "documents".**
If anybody asks the help bot about documentation it now answers about this
feature, so the wording in `lib/help/content.js` distinguishes the two on
purpose.
