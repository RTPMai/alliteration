// PUT IN: lib/sitework/done-notice.js
// lib/sitework/done-notice.js: tell the person who made a sticky that it got
// checked off.
//
// Ryan, Sep 28 2026: "when I check off a sticky, please notify the person who
// made the sticky. Not me for mine though." Applied to whoever checks one off,
// not just Ryan, with the same self rule for everybody: closing your own note
// raises nothing, because you already know.
//
// WHO SEES IT. The notification is PRIVATE to the person it is for. A team
// notification is readable by everyone signed in, and the board is gated to
// the Admin flag or an explicit "stickies" grant. Putting a sticky's title in
// a team notification would hand the build list to the whole shop through the
// back door. Private items are visible only to their createdBy (see
// api/notifications.js hidden()), so createdBy is the recipient and
// createdByName says where it really came from.
//
// Skipped, too, when the creator can no longer see the board (role changed,
// grant removed): the link would open a screen they are refused, and the
// title is exactly what they are no longer cleared for.
//
// FAILS SOFT, ALWAYS. The sticky is already saved as done. A nudge that could
// not be raised is logged, never turned into an error for the person who
// checked the box.
//
// ESM. lib/ never imports from api/.

import { getUser } from "../users.js";
import { canSeeBoard } from "./access.js";
import { nextNotificationId, saveNotification } from "../notifications/store.js";

const FROM = "stickies";
const FROM_NAME = "StickySituations";

/**
 * Who, if anyone, should hear that this note was just checked off.
 * Pure: the decision the route and the tests share. Returns a lowercase
 * username or null.
 *
 *   before  the note as it was
 *   after   the note as saved
 *   by      username of the person who checked it off
 */
export function doneRecipient(before, after, by) {
  if (!before || !after) return null;
  if (before.status === "done" || after.status !== "done") return null;   // not a check-off
  const maker = String(before.createdBy || "").trim().toLowerCase();
  const closer = String(by || "").trim().toLowerCase();
  if (!maker) return null;             // older notes may not know who made them
  if (maker === closer) return null;   // your own note: you already know
  return maker;
}

/** The notification record, built without touching the store. */
export function buildDoneNotice({ id, note, to, toName, by, byName, now }) {
  const at = now || new Date().toISOString();
  const title = String(note.title || note.id || "A sticky");
  return {
    id,
    title: `Sticky checked off: ${title}`.slice(0, 200),
    detail: `${byName || by} checked off your sticky "${title}".`.slice(0, 2000),
    types: ["task"],
    appIds: [FROM],
    assignedTo: to,
    assignedToName: toName || to,
    status: "open",
    visibility: "private",
    dueDate: null,
    link: { type: "sticky", id: note.id, label: title.slice(0, 200) },
    createdBy: to,
    createdByName: FROM_NAME,
    createdAt: at,
    doneAt: null, doneBy: null, doneByName: null,
    // Same shape api/notifications.js writes, so the inbox reads it as
    // "StickySituations created this, assigned to <name>".
    history: [{ at, by: FROM, byName: FROM_NAME, action: "created", to, toName: toName || to }],
  };
}

/**
 * Raise the notification if one is owed. Returns the notification id, or
 * null when none was owed or it could not be raised.
 */
export async function notifyStickyDone(before, after, by) {
  const to = doneRecipient(before, after, by);
  if (!to) return null;
  try {
    const maker = await getUser(to);
    if (!maker) return null;                          // account gone
    if (!(await canSeeBoard({ username: to }))) return null;
    const closer = await getUser(by);
    const id = await nextNotificationId();
    await saveNotification(buildDoneNotice({
      id,
      note: after,
      to,
      toName: maker.name || to,
      by: String(by || "").toLowerCase(),
      byName: (closer && closer.name) || by,
    }));
    return id;
  } catch (e) {
    console.error("[sitework] check-off notification failed, the note was still saved:", e.message);
    return null;
  }
}
