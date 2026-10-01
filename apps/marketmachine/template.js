// PUT IN: apps/marketmachine/template.js
/**
 * The three screens: Campaigns (which holds the list, the new-campaign form
 * and one campaign's page), Timeline, and Settings. Every screen's contents
 * are rendered into these by the view modules.
 */

export default `
    <div class="mk-page">
      <section id="mkTasksView" hidden>
        <div id="mkTasksBody"></div>
      </section>
      <section id="mkCampaignsView" hidden>
        <div id="mkListPane"></div>
        <div id="mkNewPane" hidden></div>
        <div id="mkDetailPane" hidden></div>
      </section>
      <section id="mkEmailView" hidden>
        <div class="mk-hd">
          <div>
            <h1>Email<span class="dot">.</span></h1>
            <div class="sub">Who you can email, every email that went out, and how they did. Emails are written on a campaign: New email starts one.</div>
          </div>
          <div class="mk-actions"><button class="mk-btn" data-act="new-email">New email</button></div>
        </div>
        <div class="mk-actions" style="margin-bottom:14px">
          <button class="mk-btn ghost sm" data-act="hub-tab" data-tab="audience">People and lists</button>
          <button class="mk-btn ghost sm" data-act="hub-tab" data-tab="campaigns">Every email</button>
          <button class="mk-btn ghost sm" data-act="hub-tab" data-tab="reports">Results</button>
        </div>
        <div id="mkEmailHubSlot"></div>
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
        <div id="mkEmailSettingsWrap" hidden>
          <h2 style="font-size:17px;font-weight:800;margin:26px 0 10px">email settings.</h2>
          <div id="mkEmailSettingsSlot"></div>
        </div>
      </section>
    </div>
`;
