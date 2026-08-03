/**
 * WebsiteWidget — STUB.
 *
 * Planned: web analytics for PMApparel.com. Visitors, page views, and
 * sessions; traffic source; which content converts; and overall site
 * performance and trends.
 *
 * Like the CrewCore, MailMe, and TeleTally stubs, this file exists to prove
 * the app contract and keep the switcher honest. The shell short-circuits on
 * `stub: true`, so this module is not mounted yet; it is here so the real
 * build fills in these same four members instead of starting from nothing.
 */

export default {
  id: 'websitewidget',

  styles: `
    .ww-stub { padding: 40px 20px; text-align: center; color: var(--muted); }
    .ww-stub h2 { color: var(--ink); font-size: 17px; margin: 0 0 8px; }
    .ww-stub .badge {
      display: inline-block; margin-bottom: 14px; padding: 3px 9px;
      border-radius: var(--radius-pill); background: var(--accent-tint);
      color: var(--accent-deep); font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em;
    }
    .ww-stub p { max-width: 420px; margin: 0 auto; line-height: 1.6; }
  `,

  template: `
    <div class="ww-stub">
      <span class="badge">Not yet built</span>
      <h2>WebsiteWidget</h2>
      <p>
        Web analytics for PMApparel.com. Planned: visitors, page views, and
        sessions, traffic source, which content converts, and overall site
        performance and trends.
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
