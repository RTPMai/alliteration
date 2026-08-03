/**
 * MailMe — STUB.
 *
 * Planned: email marketing. Contact list management (likely nested near or
 * pulling from the BackBone roster rather than a separate contact store),
 * sending through a third-party provider (Postmark/Resend/SendGrid, TBD) as
 * the delivery layer, and a webhook receiver that stores opens, per-link
 * click tracking, unsubscribes/suppression, and bounces/spam complaints
 * against contacts.
 *
 * Needs before the real build: a sending domain authenticated with
 * SPF/DKIM/DMARC, and a CAN-SPAM compliant unsubscribe flow. Unsubscribe
 * REASON capture is not provider-native, so it needs its own small page
 * (redirect target after the provider's unsubscribe link) rather than
 * arriving on the webhook.
 *
 * Like the CrewCore and (former) TravelTrack stubs, this file exists to
 * prove the app contract and keep the switcher honest. The shell
 * short-circuits on `stub: true`, so this module is not mounted yet; it is
 * here so the real build fills in these same four members instead of
 * starting from nothing.
 */

export default {
  id: 'mailme',

  styles: `
    .mm-stub { padding: 40px 20px; text-align: center; color: var(--muted); }
    .mm-stub h2 { color: var(--ink); font-size: 17px; margin: 0 0 8px; }
    .mm-stub .badge {
      display: inline-block; margin-bottom: 14px; padding: 3px 9px;
      border-radius: var(--radius-pill); background: var(--accent-tint);
      color: var(--accent-deep); font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em;
    }
    .mm-stub p { max-width: 420px; margin: 0 auto; line-height: 1.6; }
  `,

  template: `
    <div class="mm-stub">
      <span class="badge">Not yet built</span>
      <h2>MailMe</h2>
      <p>
        Email marketing. Planned: contact lists sortable by tag/segment,
        campaign sends through a provider (Postmark/Resend/SendGrid),
        per-contact and per-link open/click tracking, and unsubscribe
        handling with a captured reason.
      </p>
    </div>
  `,

  async mount(ctx) {
    // Nothing to load. A real app fetches here via ctx.api, never fetch().
    void ctx;
  },

  showView() {
    // Single view; nothing to switch.
  }
};
