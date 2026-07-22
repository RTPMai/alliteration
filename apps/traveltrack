/**
 * TravelTrack — STUB.
 *
 * Confirmed for rebuild. Runs on Base44, so unlike the other four there is no
 * api/ folder to point at: the data model has to be rebuilt here, not
 * reconnected. Until that happens this file exists to prove the app contract
 * and to keep the switcher honest about what is and isn't wired up.
 *
 * It is also the smallest complete example of the contract. A real app fills
 * in the same four members with more inside them.
 */

export default {
  id: 'traveltrack',

  styles: `
    .tt-stub { padding: 40px 20px; text-align: center; color: var(--muted); }
    .tt-stub h2 { color: var(--ink); font-size: 17px; margin: 0 0 8px; }
    .tt-stub .badge {
      display: inline-block; margin-bottom: 14px; padding: 3px 9px;
      border-radius: var(--radius-pill); background: var(--accent-tint);
      color: var(--accent-deep); font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .04em;
    }
    .tt-stub p { max-width: 420px; margin: 0 auto; line-height: 1.6; }
  `,

  template: `
    <div class="tt-stub">
      <span class="badge">Not yet built</span>
      <h2>TravelTrack</h2>
      <p>
        Confirmed for rebuild. The data model gets rebuilt in the shell rather
        than reconnected, because the current version runs on Base44 and has no
        API surface to point at.
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
