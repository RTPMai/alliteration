/**
 * BackBone — markup.
 *
 * The six pages and five modals, lifted from the standalone app.
 *
 * REMOVED, because the shell owns them now:
 *   - #authGate, the login card. One sign-in covers every app.
 *   - .hdr, the header: logo, the six nav buttons, and the logout link. The
 *     rail carries navigation; the shell header carries identity.
 *   - The Users and Roles cards inside Settings. Accounts are shell-level, so
 *     managing them from inside one app would imply that app owns them.
 *
 * KEPT in Settings, because they are BackBone's own data operations and belong
 * to it: the Printavo sync, distance calculation, and
 * the reset-to-seed.
 */

export default `

  <div id="page-inbox" class="page">
    <div class="kpi-grid" id="inboxKpiGrid"></div>
    <div class="card">
      <div class="card-hd">
        <h3>Inquiry inbox</h3>
        <div style="display:flex;gap:8px;align-items:center">
          <select class="field" id="inboxFilter" style="width:auto;padding:6px 10px">
            <option value="open">Needs action</option>
            <option value="all">All</option>
            <option value="new">New</option>
            <option value="attached_to_client">Attached to client</option>
            <option value="converted_lead">Converted to lead</option>
            <option value="dismissed">Dismissed</option>
          </select>
          <button class="btn btn-gray btn-sm" id="inboxRefreshBtn">Refresh</button>
        </div>
      </div>
      <div class="card-bd">
        <div class="help">
          Submissions from the public intake form (<code>intake.html</code> &rarr; <code>/api/intake</code>).
          Existing-client inquiries attach to a Roster record so activity shows up next to the
          Scorecard judgment fields. New-client inquiries convert into a Lead, pre-filled and ready
          for free chat qualification.
        </div>
        <div id="inboxList"></div>
      </div>
    </div>
  </div>

  <div id="page-leads" class="page">
    <div class="kpi-grid" id="leadsKpiGrid"></div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-hd"><h3>New lead</h3></div>
      <div class="card-bd">
        <div class="help">
          Front door for prospects that haven't transacted yet. Add what you know, then run
          AI qualification — it researches the company via web search and scores it against
          the same industry/AM logic the Roster uses. "Promote to Roster" adds it as a
          $0 / 0-invoice prospect record you can track alongside real clients.
        </div>
        <div class="scan-card-bar">
          <button class="btn btn-gray" id="scanCardBtn" type="button">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 15h4"/><circle cx="17" cy="10" r="2"/><path d="M15 15c0-1.1.9-2 2-2s2 .9 2 2"/></svg>
            Scan business card
          </button>
          <input type="file" id="scanCardInput" accept="image/*" capture="environment" style="display:none"/>
          <span id="scanCardStatus" class="scan-card-status"></span>
        </div>
        <div class="lead-form-grid">
          <div>
            <label class="field-lbl">Company name *</label>
            <input class="field" id="leadCompanyName"/>
          </div>
          <div>
            <label class="field-lbl">Website URL</label>
            <input class="field" id="leadWebsite" placeholder="https://"/>
          </div>
          <div>
            <label class="field-lbl">Contact first name</label>
            <input class="field" id="leadContactFirst"/>
          </div>
          <div>
            <label class="field-lbl">Contact last name</label>
            <input class="field" id="leadContactLast"/>
          </div>
          <div>
            <label class="field-lbl">Contact email</label>
            <input class="field" id="leadContactEmail" placeholder="name@company.com"/>
          </div>
          <div>
            <label class="field-lbl">Contact phone</label>
            <input class="field" id="leadContactPhone"/>
          </div>
          <div>
            <label class="field-lbl">Source type</label>
            <select class="field" id="leadSourceType">
              <option value="">Not set</option>
              <option>Inbound quote request</option>
              <option>Website form</option>
              <option>Outbound prospecting</option>
              <option>Trade show</option>
              <option>Event</option>
              <option>Referral</option>
              <option>Existing account expansion</option>
            </select>
          </div>
          <div>
            <label class="field-lbl">Event of origin (if from an event)</label>
            <input class="field" id="leadSourceEvent" placeholder="e.g. Catch Des Moines expo, June 2026"/>
          </div>
          <div>
            <label class="field-lbl">Marketing initiative</label>
            <select class="field" id="leadMarketingInitiative"></select>
          </div>
          <div>
            <label class="field-lbl">Industry (if known — the agent will verify)</label>
            <select class="field" id="leadIndustry"></select>
          </div>
          <div class="wide">
            <label class="field-lbl">Inquiry notes</label>
            <textarea class="field" id="leadInquiryNotes"></textarea>
          </div>
          <div class="wide">
            <label class="field-lbl">Existing CRM notes</label>
            <textarea class="field" id="leadCrmNotes"></textarea>
          </div>
        </div>
        <button class="btn btn-green" id="addLeadBtn">Add lead</button>
        <span id="addLeadErr" style="color:var(--danger);font-size:12px;margin-left:10px"></span>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-hd"><h3>Create lead from qualification JSON</h3></div>
      <div class="card-bd">
        <div class="help">
          Already have a qualification JSON from a Claude chat? Paste it here and it'll create the
          lead <em>and</em> attach the qualification in one step — no need to add the lead first.
          Company name, website, contact, and industry are pulled from the JSON automatically.
        </div>
        <textarea class="field" id="newLeadJsonBox" style="width:100%;min-height:160px;font-family:monospace;font-size:11px" placeholder="Paste the full qualification JSON object here"></textarea>
        <div style="margin-top:10px">
          <button class="btn btn-green" id="newLeadJsonBtn">Create lead from JSON</button>
          <button class="btn btn-gray btn-sm" id="newLeadJsonClearBtn" style="margin-left:6px">Clear</button>
          <span id="newLeadJsonErr" style="color:var(--danger);font-size:12px;margin-left:10px"></span>
          <span id="newLeadJsonOk" style="color:var(--success);font-size:12px;margin-left:10px"></span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-hd"><h3>Pipeline</h3></div>
      <div class="card-bd">
        <div class="funnel-all">
          <div class="fnl-hint">Click a stage to filter the pipeline. Click it again to show everything.</div>
          <button class="btn btn-gray btn-sm" id="funnelClearBtn" style="display:none">Show all stages</button>
        </div>
        <div class="funnel" id="leadsFunnel"></div>
        <div class="toolbar">
          <input class="search" id="leadsSearchBox" placeholder="Search company name"/>
          <button class="btn btn-gray btn-sm" id="myLeadsBtn" title="Show only leads routed to you, hiding everyone else's assignments. Click again to show all.">My leads</button>
          <span id="leadsFilterNote" class="help" style="margin:0 0 0 10px"></span>
        </div>
        <div id="leadsTableWrap"></div>
      </div>
    </div>
  </div>

  <div id="page-roster" class="page">
    <div class="kpi-grid">
      <div class="kpi">
        <div class="kpi-lbl">Total customers</div>
        <div class="kpi-val" id="kpiTotal">—</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">Enriched</div>
        <div class="kpi-val" id="kpiEnriched">—</div>
      </div>
      <div class="kpi">
        <div class="kpi-lbl">Data source</div>
        <div class="kpi-val" style="font-size:15px">Printavo (live)</div>
        <div class="kpi-s">Auto-sync · paid-only revenue</div>
        <div class="kpi-s" id="lastUpdated"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-hd">
        <h3>Customer roster</h3>
      </div>
      <div class="card-bd">
        <div class="help">
          Amber "Suggested" pills are a best guess from the company name alone (e.g. "Dance Studio" → Dance,
          "CSD"/"High School" → K-12). Click one to accept it — nothing is auto-applied without a click,
          since name-based guessing can misfire (a "Fire Protection" contractor isn't a fire department).
          Always sanity-check before accepting.
        </div>
        <div class="toolbar">
          <input class="search" id="searchBox" placeholder="Search company name"/>
        </div>
        <div id="tableWrap"></div>
        <div class="help" style="margin-top:10px">Click any column header to sort — click again to reverse.</div>
      </div>
    </div>
  </div>

  <div id="page-scorecard" class="page">
    <div class="kpi-grid" id="tierKpiGrid"></div>

    <div class="card">
      <div class="card-hd">
        <h3>Client tiering &amp; weighted scorecard</h3>
      </div>
      <div class="card-bd">
        <div class="help">
          Score = weighted average across 11 criteria (1–5 each). Revenue, invoice count, and average
          invoice are computed automatically from synced data. The eight judgment criteria — Employees,
          Growth, Communication, CSR, Order Frequency, Specialty Billing, Contact, and Distance — are
          set inside each company: click a row to open it and edit them there. Distance auto-fills from
          the client's ZIP. Missing criteria are excluded and the remaining weights are re-normalized,
          so a partial score is still comparable to a complete one.
        </div>
        <div class="toolbar" style="justify-content:space-between">
          <input class="search" id="scoreSearchBox" placeholder="Search company name"/>
          <div style="display:inline-flex;align-items:center;gap:12px">
            <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);white-space:nowrap">
              <input type="checkbox" id="scoreHideContract"/> Hide contract clients
            </label>
            <div style="display:inline-flex;align-items:center;gap:6px">
              <label style="font-size:12px;color:var(--muted)">Show</label>
              <select class="search" id="scorePageSize" style="min-width:76px;padding:6px 8px">
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="all">All</option>
              </select>
            </div>
            <div class="sort-group" style="display:inline-flex;background:var(--line-soft);border-radius:6px;padding:2px">
              <button class="sort-btn active" id="scoreBasisAll" data-basis="all">All time</button>
              <button class="sort-btn" id="scoreBasisYtd" data-basis="ytd">2026 YTD</button>
            </div>
          </div>
        </div>
        <div class="help" id="scoreBasisNote" style="margin-bottom:10px"></div>
        <div id="scoringLegendWrap" style="margin-bottom:14px"></div>
        <div id="scoreTableWrap"></div>
        <div id="scorePagerWrap" style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;gap:12px"></div>
        <div class="help" style="margin-top:10px">Click any column header to sort — click again to reverse.</div>
      </div>
    </div>
  </div>

  <div id="page-dashboard" class="page active">
    <div class="dash-bar">
      <label style="font-size:13px;color:var(--ink);font-weight:600">Year</label>
      <select class="search" id="dashYearSelect" style="min-width:130px"></select>
      <div class="spacer"></div>
      <div class="dash-hidden-list" id="dashHiddenList"></div>
      <button class="btn btn-gray btn-sm" id="dashResetLayout">Reset layout</button>
    </div>
    <div class="help" id="dashYearNote" style="margin:0 0 12px"></div>

    <div class="kpi-grid" id="dashPortfolioKpiGrid"></div>

    <div class="dash-grid" id="dashGrid">
      <div class="card dash-card w-full" data-card="salesgoal">
        <div class="card-hd"><span class="dash-grip">⠿</span><h3>YTD sales vs goal</h3></div>
        <div class="card-bd">
          <div class="help">Cash collected per month this year against the $280k/month target, any order age. Needs the Printavo ops sync.</div>
          <div id="dashSalesGoalWrap"></div>
        </div>
      </div>

      <div class="card dash-card w-half" data-card="top10">
        <div class="card-hd"><span class="dash-grip">⠿</span><h3>Top 20% of clients</h3></div>
        <div class="card-bd">
          <div class="help">Whichever clients, ranked by how much they spend with us, add up to the top 20% of total revenue. Usually a small handful of your biggest spenders. Uses the Year filter above (all time, a specific year, or the current year for YTD). Click any client to open its record.</div>
          <div id="dashConcentrationWrap"></div>
        </div>
      </div>

      <div class="card dash-card w-half" data-card="industry">
        <div class="card-hd"><span class="dash-grip">⠿</span><h3>By industry</h3></div>
        <div class="card-bd">
          <div class="help">Roster split by industry. Toggle to sort by number of clients or by revenue.</div>
          <div class="mix-sort" id="dashIndustrySort">
            <button data-isort="count" class="on">By # clients</button>
            <button data-isort="revenue">By $ spent</button>
          </div>
          <div id="dashIndustryWrap"></div>
        </div>
      </div>

      <div class="card dash-card w-full" data-card="revtrend">
        <div class="card-hd"><span class="dash-grip">⠿</span><h3>Revenue trend by year</h3></div>
        <div class="card-bd">
          <div class="help">Roster-wide revenue per year, from each client's year buckets. Ignores the Year filter above — this card is the whole timeline.</div>
          <div id="dashRevTrendWrap"></div>
        </div>
      </div>

      <div class="card dash-card w-half" data-card="outstanding">
        <div class="card-hd"><span class="dash-grip">⠿</span><h3>Outstanding for payment</h3></div>
        <div class="card-bd">
          <div class="help">Open invoices with a balance still owed, largest first. Needs the Printavo ops sync.</div>
          <div id="dashOutstandingWrap"></div>
        </div>
      </div>

      <div class="card dash-card w-half" data-card="dormant">
        <div class="card-hd"><span class="dash-grip">⠿</span><h3>Dormant &amp; at risk</h3></div>
        <div class="card-bd">
          <div class="help">No order in 6+ months on an <b>absolute</b> clock, ranked by revenue at stake. This is "have they gone quiet, period" — regardless of how often they used to order. Mark a row resolved if the silence has a known reason (rebrand, acquisition, closure).</div>
          <div id="dashDormantWrap"></div>
        </div>
      </div>

      <div class="card dash-card w-half" data-card="cadence">
        <div class="card-hd"><span class="dash-grip">⠿</span><h3>Overdue to reorder</h3></div>
        <div class="card-bd">
          <div class="help">Past due against <em>their own</em> ordering rhythm — a monthly buyer who's 3 months quiet, not a fixed date. This catches clients slipping <b>relative to their normal cadence</b>, before they'd ever show as dormant.</div>
          <div id="dashCadenceWrap"></div>
        </div>
      </div>

      <div class="card dash-card w-half" data-card="tiermove">
        <div class="card-hd"><span class="dash-grip">⠿</span><h3>Tier movement</h3></div>
        <div class="card-bd">
          <div class="help">Score recomputed on last year's numbers vs this year's, to see who moved.</div>
          <div id="dashTierMoveWrap"></div>
        </div>
      </div>

      <div class="card dash-card w-full" data-card="amload">
        <div class="card-hd"><span class="dash-grip">⠿</span><h3>Account Managers</h3></div>
        <div class="card-bd">
          <div class="help">Every AM ranked on one line: leads (wins, pipeline, hot), roster (clients, revenue, tier mix), and live open-quote load — all in one place. Toggle what the ranking sorts by. Click <b>Brief</b> for a sendable rundown.</div>
          <div id="dashAmWrap"></div>
        </div>
      </div>

      <div class="card dash-card w-full" data-card="alerts">
        <div class="card-hd"><span class="dash-grip">⠿</span><h3>Needs assignment</h3></div>
        <div class="card-bd">
          <div class="help">Clients with no industry or AM set, or two industries picked — largest revenue first. Click a company to open its record. (At-risk & dormant accounts have their own card above.)</div>
          <div id="dashAlertsWrap"></div>
        </div>
      </div>
    </div>

    <!-- Capacity: coming soon. Deliberately OUTSIDE #dashGrid so the drag /
         hide / reset-layout machinery never has to know about it. Static
         placeholder; replace with the real Capacity view when it ships.
         It will grow out of the Account Managers card above, adding
         PTO-weighted availability once CrewCore exists to ask. -->
    <div class="card" id="dashCapacitySoon" style="margin-top:12px">
      <div class="card-hd">
        <h3>Capacity <span class="badge badge-amber" style="margin-left:8px">Coming soon</span></h3>
      </div>
      <div class="card-bd">
        <div class="help">
          Who has room for the next job: open jobs and open-quote value per
          account manager, at a glance. Builds on the Account Managers card
          above, and once CrewCore ships it can weight availability by PTO
          — someone out Thursday and Friday has less capacity that week.
        </div>
      </div>
    </div>
  </div>

  <div id="page-settings" class="page">
    <!-- Users and Roles used to live here. Accounts are SHELL-level now (one
         login covers every app), so they moved to the shell's Settings screen.
         Managing them from inside BackBone would imply BackBone owns them. -->
    <!-- The "Refresh from Apparelytics" paste-import card was removed in Aug
         2026. The Printavo sync computes invoice_count, total_revenue,
         last_invoice_date, median_gap_days, revenue_by_year and
         invoices_by_year itself, so the paste was redundant. It was also
         destructive: handleImport() replaced the whole roster with whatever
         was pasted, so a five-field paste stripped the per-year and cadence
         fields the sync had built. "Reconcile roster from Printavo" below is
         the supported way to rebuild the roster. -->
    <!-- Reorder timing moved here from MailMe in Aug 2026. "When is a customer
         late to reorder" is a fact about the customer, not about email, so it
         belongs where the roster and the order history live. MailMe still
         reads these values to build audiences; it no longer owns them. -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-hd"><h3>Reorder timing</h3></div>
      <div class="card-bd">
        <div class="help">
          These decide when a customer counts as Due, Overdue or Lapsed. They are
          <b>multiples of that customer's own median gap</b> between orders, not fixed
          day counts. A school ordering twice a year isn't late at day 90; a contractor
          ordering every two weeks very much is. One threshold can't describe both,
          which is why these are ratios.
          <br/><br/>
          Changing them changes what everyone sees on every screen at once, so saving
          is limited to admins. MailMe reads these same numbers when it builds an
          audience of clients who are due to reorder.
        </div>
        <div id="reorderErr"></div>
        <div class="reorder-grid" id="reorderFields">
          <label>Due at
            <input type="number" step="0.1" min="0.1" id="reorderDue">
            <span class="reorder-hint">At their normal gap</span>
          </label>
          <label>Overdue at
            <input type="number" step="0.1" min="0.1" id="reorderOverdue">
            <span class="reorder-hint">Half again past it</span>
          </label>
          <label>Lapsed at
            <input type="number" step="0.1" min="0.1" id="reorderLapsed">
            <span class="reorder-hint">Probably lost, not late</span>
          </label>
          <label>Minimum orders to judge
            <input type="number" min="1" id="reorderMinOrders">
            <span class="reorder-hint">Below this, a median isn't a pattern</span>
          </label>
          <label>Shortest gap to trust (days)
            <input type="number" min="0" id="reorderMinGap">
            <span class="reorder-hint">Ignores same-week clusters as noise</span>
          </label>
        </div>
        <button class="btn btn-green" id="reorderSaveBtn">Save reorder timing</button>
        <button class="btn" id="reorderResetBtn">Reset to defaults</button>
        <span class="save-status" id="reorderStatus" style="margin-left:10px"></span>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-hd"><h3>Sync from Printavo</h3></div>
      <div class="card-bd">
        <div class="help">
          Rebuilds the roster directly from Printavo's full invoice history &mdash; every
          real customer's invoice count, total revenue, and last invoice date recomputed
          from scratch. Use this to pull in the full client base, or any time you want to
          be sure the roster is exactly in step with Printavo.
          <br/><br/>
          Enrichment fields and Leads/prospect rows are never touched. Runs in the background
          in chunks and can take a couple of minutes on the full history &mdash; leave this tab
          open until it finishes. The nightly automatic reconcile does the same thing, so day
          to day you shouldn't need this button.
        </div>
        <div id="reconcileErr"></div>
        <button class="btn btn-green" id="reconcileBtn">Reconcile roster from Printavo</button>
        <span class="save-status" id="reconcileStatus" style="margin-left:10px"></span>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-hd"><h3>Calculate distances</h3></div>
      <div class="card-bd">
        <div class="help">
          Computes straight-line ("as the crow flies") distance from the shop (Ankeny, ZIP 50021)
          to each client and auto-fills the Distance score on the Scorecard (closer = higher).
          Needs a ZIP on the client &mdash; entered in the client's detail panel, or pulled in
          automatically from Printavo's shipping address on the next reconcile. A manually chosen
          Distance value always overrides the auto result. Only clients missing a cached distance
          are calculated unless you force a full recalculation.
          <br/><br/>
          Runs entirely in your browser from a built-in ZIP table &mdash; no API key, no external
          service, no cost. Accuracy is a few miles, which is well within the score bands.
        </div>
        <div id="calcDistErr"></div>
        <button class="btn btn-green" id="calcDistBtn">Calculate missing distances</button>
        <button class="btn" id="calcDistForceBtn" style="margin-left:8px">Recalculate all</button>
        <span class="save-status" id="calcDistStatus" style="margin-left:10px"></span>
      </div>
    </div>
    <div class="card">
      <div class="card-hd"><h3>Reset</h3></div>
      <div class="card-bd">
        <div class="help">Clears synced data and reverts to the built-in seed set. Enrichment data is not affected.</div>
        <button class="btn btn-gray" id="resetBtn">Reset synced data to seed</button>
      </div>
    </div>
    </div><!-- /adminContent -->
  </div>

</div>
  </div>

<div class="modal-overlay" id="detailOverlay">
  <div class="modal">
    <div class="modal-hd">
      <h3 id="detailTitle"></h3>
      <div style="display:flex;align-items:center;gap:8px;margin-left:auto">
        <button class="am-brief-btn" id="detailBriefBtn" style="display:none">At-risk brief</button>
        <button class="modal-close" id="detailClose">&times;</button>
      </div>
    </div>
    <div class="modal-bd">
      <div class="section-lbl">Synced from Printavo</div>
      <div class="synced-grid" id="syncedGrid"></div>

      <div id="detailInquiries" style="display:none"></div>

      <div class="section-lbl">Manual / enrichment fields</div>
      <div class="help">These never get overwritten by a refresh import.</div>
      <div class="enrich-grid" id="enrichGrid"></div>
    </div>
    <div class="modal-ft">
      <button class="btn btn-green" id="saveEnrichBtn">Save</button>
      <span class="save-status" id="saveStatus"></span>
    </div>
  </div>
</div>

<div class="modal-overlay" id="inboxDetailOverlay">
  <div class="modal" style="max-width:640px">
    <div class="modal-hd">
      <h3 id="inboxDetailTitle"></h3>
      <button class="modal-close" id="inboxDetailClose">&times;</button>
    </div>
    <div class="modal-bd" id="inboxDetailBody"></div>
  </div>
</div>

<div class="modal-overlay" id="handoffOverlay">
  <div class="modal" style="max-width:600px">
    <div class="modal-hd">
      <h3 id="handoffTitle">Email leads to AM</h3>
      <button class="modal-close" id="handoffClose">&times;</button>
    </div>
    <div class="modal-bd" id="handoffBody"></div>
    <div class="modal-ft">
      <button class="btn btn-green" id="handoffOpenAll">Open all drafts</button>
      <button class="btn btn-gray" id="handoffCopyAll">Copy all to clipboard</button>
      <span id="handoffHint" class="help" style="margin-left:auto;font-size:12px"></span>
    </div>
  </div>
</div>

<div class="modal-overlay" id="amBriefOverlay">
  <div class="modal" style="max-width:680px">
    <div class="modal-hd brief-noprint">
      <h3 id="briefModalTitle">Account Manager Brief</h3>
      <button class="modal-close" onclick="BackBone.closeAmBrief()">&times;</button>
    </div>
    <div class="modal-bd">
      <div id="briefPrintArea"></div>
    </div>
    <div class="modal-ft brief-noprint">
      <a class="btn btn-green" id="briefMailBtn" href="#">Email to AM</a>
      <button class="btn btn-gray" id="briefCopyBtn">Copy text</button>
      <button class="btn btn-gray" onclick="window.print()">Print / PDF</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="leadDetailOverlay">
  <div class="modal" style="max-width:640px">
    <div class="modal-hd">
      <h3 id="leadDetailTitle"></h3>
      <button class="modal-close" id="leadDetailClose">&times;</button>
    </div>
    <div class="modal-bd" id="leadDetailBody"></div>
    <details style="border-top:1px solid var(--line);padding:14px 20px">
      <summary style="cursor:pointer;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)">
        Paste qualification JSON (no API key needed — ask Claude in a chat)
      </summary>
      <div class="help" style="margin-top:10px">
        Give Claude the lead's info in a normal chat and ask it to research and qualify the
        company using the BackBone lead-qualification schema — Claude will use web search under
        your Pro subscription instead of a billed API call. Paste the JSON it returns below.
      </div>
      <textarea class="field" id="pasteQualBox" style="width:100%;min-height:120px;font-family:monospace;font-size:11px" placeholder="Paste the JSON object here"></textarea>
      <button class="btn btn-gray btn-sm" id="pasteQualBtn" style="margin-top:8px">Save pasted qualification</button>
      <span id="pasteQualErr" style="color:var(--danger);font-size:12px;margin-left:8px"></span>
    </details>
    <div class="modal-ft" style="justify-content:space-between;flex-wrap:wrap;gap:10px">
      <div style="display:flex;gap:10px;align-items:center">
        <label class="field-lbl" style="margin:0">Status</label>
        <select class="field" id="leadStatusSelect" style="width:auto"></select>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-danger btn-sm" id="deleteLeadBtn">Delete lead</button>
        <button class="btn btn-gray btn-sm" id="rerunQualBtn">Run / re-run AI qualification (API)</button>
        <button class="btn btn-green btn-sm" id="promoteLeadBtn">Promote to Roster</button>
      </div>
    </div>
  </div>
</div>
`;
