/**
 * CrewCore — STUB.
 *
 * Planned: employee management for the whole team. Roster (role, start date,
 * hourly rate, apparel stipend), PTO balances and requests, one-on-one review
 * history, and a dashboard of anniversaries and upcoming time off.
 *
 * This is the most sensitive app in the shell: rates and review notes live
 * here. Access stays locked to admin/superuser accounts until the permissions
 * story is finalized. Do not grant 'crewcore' to a role casually.
 *
 * Like the TravelTrack stub, this file exists to prove the app contract and
 * keep the switcher honest. The shell short-circuits on `stub: true`, so this
 * module is not mounted yet; it is here so the real build fills in these same
 * four members instead of starting from nothing.
 */

export default {
  id: 'crewcore',

  styles: `
    .cc-stub { padding: 40px 20px; text-align: center; color: var(--muted); }
    .cc-stub h2 { color: var(--ink); font-size: 17px; margin: 0 0 8px; }
    .cc-stub .badge {
      display: inline-block; margin-bottom: 14px; padding: 3px 9px;
      border-radius: var(--radius-pill); background: var(--accent-tint);
      color: var(--accent-deep); font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em;
    }
    .cc-stub p { max-width: 420px; margin: 0 auto; line-height: 1.6; }
  `,

  template: `
    <div class="cc-stub">
      <span class="badge">Not yet built</span>
      <h2>CrewCore</h2>
      <p>
        Employee management for the whole team. Planned views: Dashboard
        (anniversaries, upcoming PTO), Roster (role, start date, rate,
        stipend), PTO (balances and requests), and Reviews (one-on-one
        history). Admin access only.
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
