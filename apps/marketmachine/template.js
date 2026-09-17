// PUT IN: apps/marketmachine/template.js
/**
 * The three screens: Campaigns (which holds the list, the new-campaign form
 * and one campaign's page), Timeline, and Settings. Every screen's contents
 * are rendered into these by the view modules.
 */

export default `
    <div class="mk-page">
      <section id="mkCampaignsView" hidden>
        <div id="mkListPane"></div>
        <div id="mkNewPane" hidden></div>
        <div id="mkDetailPane" hidden></div>
      </section>
      <section id="mkCalendarView" hidden>
        <div class="mk-hd">
          <div>
            <h1>Timeline<span class="dot">.</span></h1>
            <div class="sub">Launch dates and review dates across every campaign, by month, quarter, or year.</div>
          </div>
        </div>
        <div id="mkTimelineBody"></div>
      </section>
      <section id="mkSettingsView" hidden>
        <div class="mk-hd">
          <div>
            <h1>Settings<span class="dot">.</span></h1>
            <div class="sub">The campaign types and their steps, the BackBone lead list, and old sample data.</div>
          </div>
        </div>
        <div id="mkSettingsBody"></div>
      </section>
    </div>
`;
