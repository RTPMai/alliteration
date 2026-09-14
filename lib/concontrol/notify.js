// lib/concontrol/notify.js — raise a notification when something arrives from
// the website.
//
// A form submission that lands as a record and tells nobody is a quieter
// version of the email it replaced. This is what makes the inbound side worth
// having.
//
// WHO IT GOES TO is a setting, not a guess. Empty means no notification is
// raised, and the Settings screen says so in words rather than leaving it as a
// silent nothing.
//
// FAILS SOFT, ALWAYS. If the notification cannot be created, the sponsor
// inquiry has still been recorded and the caller still gets its 201. Losing a
// real inquiry because a nudge failed would be the wrong trade, and the public
// routes are the last place to start throwing.
//
// ESM. Do NOT convert to module.exports.

import { nextNotificationId, saveNotification } from "../notifications/store.js";

export async function notifyInbound({ to, title, detail, by }) {
  const assignedTo = String(to || "").trim().toLowerCase();
  if (!assignedTo) return { raised: false, why: "nobody is set to receive these" };

  try {
    const id = await nextNotificationId();
    const now = new Date().toISOString();
    // Same field set api/notifications.js writes when a person creates one,
    // so these read and behave identically in the inbox. createdBy is the app
    // rather than a username, because nobody pressed a button: the website
    // did.
    await saveNotification({
      id,
      title: String(title || "").slice(0, 200),
      // The detail rides in the title-adjacent body the inbox already shows.
      detail: String(detail || "").slice(0, 2000),
      types: ["need"],
      appIds: ["concontrol"],
      assignedTo,
      assignedToName: assignedTo,
      status: "open",
      visibility: "team",
      dueDate: null,
      link: null,
      createdBy: "concontrol",
      createdByName: by || "Event website",
      createdAt: now,
      doneAt: null,
      doneBy: null,
      doneByName: null,
      history: [{ at: now, by: "concontrol", byName: by || "Event website", what: "created" }],
    });
    return { raised: true, id };
  } catch (e) {
    console.error("[concontrol] notification failed, the record was still saved:", e.message);
    return { raised: false, why: e.message };
  }
}
