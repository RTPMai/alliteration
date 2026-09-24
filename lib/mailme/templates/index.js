// PUT IN: lib/mailme/templates/index.js
// lib/mailme/templates/index.js: the designed email templates MailMe offers.
//
// A campaign is either FREEFORM (the text box with markdown-lite, rendered by
// lib/mailme/send.js as it always has been) or one of these. A template
// campaign keeps its content in `templateData`, a structured object the
// composer edits through a form, and the template turns that into the email.
// `body` is unused for a template campaign.
//
// Each template module exports:
//   KEY, LABEL, DESCRIPTION
//   defaults()                 starting content for a new email
//   normalize(data)            clean browser input into the stored shape; never throws
//   problems(data)             plain-English list of what blocks a send
//   renderHtml(data, ctx)      the whole email document
//   renderText(data, ctx)      the plain-text part (send.js adds the footer)
//   defaultPreheader(data)?    optional
//
// ESM. Do NOT convert to module.exports.

import * as pwp from "./pwp.js";
import * as promo from "./promo.js";

export const FREEFORM = "freeform";

export const TEMPLATES = { [pwp.KEY]: pwp, [promo.KEY]: promo };

export const TEMPLATE_KEYS = [FREEFORM, ...Object.keys(TEMPLATES)];

/** The template module for a campaign, or null for a freeform one. */
export function templateFor(campaign) {
  const key = campaign && campaign.template;
  return key && TEMPLATES[key] ? TEMPLATES[key] : null;
}

/** For the composer's picker. */
export function templateChoices() {
  return [
    { key: FREEFORM, label: "Freeform", description: "Write it yourself. Text, links, bullets and images." },
    ...Object.values(TEMPLATES).map((t) => ({ key: t.KEY, label: t.LABEL, description: t.DESCRIPTION })),
  ];
}

// A stored templateData object is capped so one campaign cannot grow without
// bound. Generous: the largest real email (12 promo products, every field
// full) is about a third of this. Kept modest because every campaign lives in one
// storage key (lib/mailme/store.js), so this is multiplied by the campaign count.
export const MAX_TEMPLATE_DATA_BYTES = 32 * 1024;
