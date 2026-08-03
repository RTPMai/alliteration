/**
 * TeleTally — STUB.
 *
 * Planned: call tracking. Connects to the shop's phone system to track call
 * activity, answering performance, and team usage — total calls, duration,
 * and volume; who is answering vs. missing calls; talk time and response
 * time; and performance comparison across the team.
 *
 * Like the CrewCore and MailMe stubs, this file exists to prove the app
 * contract and keep the switcher honest. The shell short-circuits on
 * `stub: true`, so this module is not mounted yet; it is here so the real
 * build fills in these same four members instead of starting from nothing.
 */

export default {
  id: 'teletally',

  styles: `
    .tt2-stub { padding: 40px 20px; text-align: center; color: var(--muted); }
    .tt2-stub h2 { color: var(--ink); font-size: 17px; margin: 0 0 8px; }
    .tt2-stub .badge {
      display: inline-block; margin-bottom: 14px; padding: 3px 9px;
      border-radius: var(--radius-pill); background: var(--accent-tint);
      color: var(--accent-deep); font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em;
    }
    .tt2-stub p { max-width: 420px; margin: 0 auto; line-height: 1.6; }
  `,

  template: `
    <div class="tt2-stub">
      <span class="badge">Not yet built</span>
      <h2>TeleTally</h2>
      <p>
        Call tracking connected to the shop phones. Planned: total calls,
        duration, and volume, who is answering vs. missing calls, talk time
        and response time, and performance comparison across the team.
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
