// PUT IN: lib/reviews/deps.js
// lib/reviews/deps.js: the real storage, Printavo, Resend and suppression
// list, wired together for the api/ routes. The engine never imports these
// itself, which is what lets the tests hand it fakes instead.
//
// ESM. Do NOT convert to module.exports.

import { defaultStore } from "./store.js";
import { gql, isConfigured as printavoConfigured } from "../promopro/printavo-lookup.js";
import { sendOne as resendSendOne, resendConfigured } from "../mailme/resend-client.js";
import { getSuppression } from "../mailme/store.js";

export function realDeps() {
  return {
    store: defaultStore(),
    gql,
    send: (message) => resendSendOne(message),
    // MailMe's do not email list. Bounces and complaints from these emails
    // land there too, through MailMe's Resend webhook, so a bad address stops
    // being asked without anybody doing anything.
    getSuppression: async () => {
      try { return await getSuppression(); }
      catch (e) {
        // Unreadable is not the same as empty. Refuse to send rather than
        // email somebody who unsubscribed because a storage call blinked.
        throw new Error("Could not read MailMe's do not email list, so nothing was sent: " + ((e && e.message) || e));
      }
    },
  };
}

export function configuration() {
  return {
    printavo: printavoConfigured(),
    resend: resendConfigured(),
    cronSecret: !!process.env.CRON_SECRET,
  };
}
