# DirtySats Dashboard Comprehensive Overhaul

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix data accuracy issues, redesign UI components, add seasonal energy rates, fix OpenEI search, build real strategy optimizer, overhaul charts, expand miner specs, improve Telegram alerts, and expand mining pool directory.

**Architecture:** Flask backend (app.py, energy.py, alerts.py, metrics.py, pool_manager.py) + vanilla JS frontend (script.js, style.css, dashboard.html) + SQLite (database/db.py). All changes touch existing files. No new frameworks.

**Tech Stack:** Python/Flask, vanilla JavaScript, Chart.js, SQLite, Telegram Bot API, OpenEI API

---

## Phase 1: Data Accuracy & Historical Hashrate (Item 1)

### Task 1.1: Fix Fleet Hashrate Chart Data Mapping

The main fleet chart shows a flat line at ~18 TH/s even though the user has had overheating miners causing hashrate drops. The issue is in the hashrate history aggregation.

**Files:**
- Modify: `app.py:2822-2930` (hashrate history endpoint)
- Modify: `database/db.py` (ensure stats table stores per-reading hashrate correctly)
- Modify: `static/script.js:3034-3343` (fleet chart rendering)

**Step 1: Fix the /api/history/hashrate endpoint**

The current implementation at `app.py:2822` uses forward-fill logic that masks gaps when miners go offline or throttle. Fix to use actual recorded data points without forward-filling missing miners at full hashrate.

In `app.py`, find the forward-fill logic around lines 2901-2919 and replace it so that:
- When a miner has no data point at a timestamp, it contributes 0 to the total (not its last known value)
- When a miner reports reduced hashrate due to thermal throttling, the actual reduced value is used
- The "totals" array accurately reflects fleet-wide hashrate at each point in time

**Step 2: Fix chart data bucketing in script.js**

In `script.js:3062-3078`, the bucket aggregation currently groups by time intervals but may average across miners incorrectly. Fix to:
- Use the pre-aggregated `totals` array from the API when available
- Remove client-side EMA smoothing (lines 3085-3093) that further masks real data drops
- Display actual recorded data points, not smoothed approximations

**Step 3: Add longer time range options**

Add 30d option to the chart time selector. Currently supports 6h, 24h, 7d. The data is available (up to 720 hours in DB).

**Step 4: Verify chart renders real fluctuations**

Test by checking that the chart shows variability matching actual miner states (offline, throttled, normal).

---

## Phase 2: Homescreen Cards Redesign (Item 2)

### Task 2.1: Redesign Homescreen Metric Cards

Current cards (Sats Earned, Fleet Health, Power Efficiency, Pool Performance, Revenue Projector) show some irrelevant or redundant data. Redesign to show the most actionable information at a glance.

**Files:**
- Modify: `templates/dashboard.html:280-428` (card HTML)
- Modify: `static/script.js` (card data loading, around loadMetricsData)
- Modify: `static/style.css` (card styling)

**Step 1: Redesign card layout**

Replace current 5 cards with these focused cards:
1. **Fleet Overview** - Total hashrate (TH/s), number of miners online/total, uptime percentage
2. **Earnings** - Sats today, sats/hour rate, weekly total (with trend arrow)
3. **Fleet Health** - Healthy/Warning/Critical counts with color dots, most urgent issue
4. **Efficiency** - Fleet average J/TH (not W/TH), best performer, worst performer
5. **Profitability** - Daily revenue, daily cost, net profit/loss, current BTC price

**Step 2: Update data loading**

Update `loadMetricsData()` in the dashboard HTML inline script (lines 1997-2178) to populate the new card fields.

**Step 3: Fix efficiency display to J/TH**

Currently showing "W/TH" in the Power Efficiency card. Change ALL efficiency metrics across the dashboard to J/TH. In `metrics.py:411-474`, the `PowerEfficiencyMatrix` already calculates J/TH correctly - the issue is display-side.

Search and replace all "W/TH" labels with "J/TH" in dashboard.html and script.js.

---

## Phase 3: Share Statistics Pie Chart (Item 3)

### Task 3.1: Convert Ring to True Pie Chart

Currently the share statistics circle is a decorative gradient ring. Convert to actual Chart.js doughnut chart showing accepted vs rejected proportions.

**Files:**
- Modify: `static/script.js:4223-4360` (shares metrics function)
- Modify: `static/style.css` (ring styling)

**Step 1: Update the miner card share chart**

The per-miner card share display needs a real Chart.js doughnut chart. Find the miner card rendering code that shows the colorful ring (in the miner detail panel). Replace the CSS gradient ring with a small Chart.js doughnut where:
- Green segment = accepted shares proportion
- Red segment = rejected shares proportion
- Center text shows accept rate percentage
- Cutout at 70% for donut appearance

**Step 2: Ensure chart updates on data refresh**

When miner data refreshes every 5 seconds, update the chart data without destroying/recreating.

---

## Phase 4: Tuning Page Bug Fixes (Item 4)

### Task 4.1: Fix Tuning Page Data Mapping & Overrides

The tuning page has bugs where data doesn't map correctly or overrides other data incorrectly.

**Files:**
- Modify: `static/script.js:6397-6467` (applyFrequency)
- Modify: `static/script.js:6319-6371` (auto-tuning state)
- Modify: `static/script.js:5946-5953` (tuning section chip info)
- Modify: `app.py` (settings endpoint)
- Modify: `static/style.css` (tuning UI)

**Step 1: Audit tuning data flow**

Trace the full flow: user adjusts slider -> frequency value sent -> API endpoint -> miner API call -> response -> UI update. Identify where:
- Frequency slider bounds don't match miner specs
- Auto-tune state conflicts with manual frequency setting
- Preset buttons don't sync with slider value
- Temperature data shown in tuning doesn't match live data

**Step 2: Fix frequency slider bounds**

Use `device_specifications.json` to set correct min/max/step for each miner type. The slider should dynamically adjust based on the selected miner's profile.

**Step 3: Fix auto-tune vs manual frequency conflict**

When auto-tune is enabled, disable manual frequency controls. When manual frequency is set, show a warning if auto-tune is also on. Prevent both from trying to set frequency simultaneously.

**Step 4: Fix preset frequency buttons**

Ensure preset buttons (Low, Medium, High, Max) use device-specific values from `device_specifications.json`, not hardcoded values.

**Step 5: Polish tuning UI**

Style the tuning section to match the dashboard design language using the frontend-design skill.

---

## Phase 5: Energy Configuration Overhaul (Item 5)

### Task 5.1: Fix Time Picker Styling

**Files:**
- Modify: `templates/dashboard.html:670-675` (time inputs)
- Modify: `static/style.css` (input styling)

**Step 1: Style time picker inputs**

The native `<input type="time">` elements don't match the dark UI. Add custom CSS to style them consistently with the rest of the dashboard.

### Task 5.2: Fix OpenEI Utility Search

**Files:**
- Modify: `energy.py:52-166` (search_utilities method)
- Modify: `static/script.js:2120-2184` (searchUtilities function)
- Modify: `app.py` (the /api/utilities/search endpoint)

**Step 1: Debug OpenEI API calls**

The search always returns no results. Check:
- Is the API key being passed correctly?
- Is the endpoint URL correct? (OpenEI may have changed their API)
- Are the response fields being parsed correctly?
- Add logging to see raw API responses

**Step 2: Fix the API call parameters**

The OpenEI URDB API v7 may require different parameters. Verify by testing with curl. Fix parameter names and response parsing.

**Step 3: Add error details to frontend**

When search fails, show specific error messages (no API key, network error, no results for query, etc.) instead of just "no results".

### Task 5.3: Add Seasonal Rate Configuration

**Files:**
- Modify: `templates/dashboard.html` (add seasonal config UI)
- Modify: `static/script.js` (seasonal config handlers)
- Modify: `energy.py` (seasonal rate logic)
- Modify: `database/db.py` (seasonal config storage)
- Modify: `app.py` (seasonal config endpoints)

**Step 1: Add summer/winter rate sections**

Add UI sections where users can:
- Define summer rate: peak rate, off-peak rate, peak hours start/end
- Define winter rate: peak rate, off-peak rate, peak hours start/end
- Set season transition dates (e.g., summer starts June 1, winter starts Oct 1)
- Toggle between flat rate and seasonal TOU

**Step 2: Add season date configuration**

Store season start/end dates in the `seasonal_config` table. The backend already has a `seasonal_config` table and endpoints (`/api/energy/seasonal-config`). Wire up the frontend to use them.

**Step 3: Auto-apply seasonal rates**

The `MiningScheduler` should check current date against seasonal config and apply the correct rates automatically. This should happen in the monitoring loop.

---

## Phase 6: Automated Mining Control Enhancement (Item 6)

### Task 6.1: Expand Automated Mining Control

**Files:**
- Modify: `app.py` (mining schedule logic)
- Modify: `energy.py` (MiningScheduler class)
- Modify: `templates/dashboard.html` (control UI)
- Modify: `static/script.js` (control handlers)
- Modify: `static/style.css` (control UI styling)

**Step 1: Add profitability-based auto-control**

Add a mode where mining automatically pauses when unprofitable:
- Monitor real-time profitability (revenue vs energy cost)
- If profit margin drops below user-defined threshold, reduce frequency
- If profitability goes negative, pause mining until rates change
- Resume automatically when profitable again

**Step 2: Add temperature-weather integration**

Using the existing weather integration:
- Pre-emptively reduce frequency before forecasted heat waves
- Increase frequency during cooler periods
- Set ambient temperature thresholds that trigger automatic frequency adjustment

**Step 3: Add BTC price-based control**

- Allow users to set a BTC price floor below which mining pauses
- When BTC price recovers above threshold, resume mining
- Option to increase hashrate when BTC price spikes (maximize earnings)

**Step 4: Add difficulty adjustment awareness**

- Track network difficulty adjustments
- When difficulty increases significantly, reduce hashrate to maintain profitability
- When difficulty drops, increase hashrate to maximize earnings

**Step 5: Build visual schedule editor**

Create a weekly calendar grid where users can drag-to-select time blocks and assign frequencies. Visual like a Google Calendar week view. Each cell represents a 1-hour block, colored by frequency level.

---

## Phase 7: Strategy Optimizer Rebuild (Item 7)

### Task 7.1: Build Real Strategy Optimizer Algorithm

The current optimizer uses 4 hardcoded strategies. Replace with a real optimization algorithm that generates 3 personalized recommendations based on actual user data.

**Files:**
- Modify: `energy.py` (add StrategyOptimizer class)
- Modify: `app.py` (add strategy optimizer endpoint)
- Modify: `templates/dashboard.html` (strategy display)
- Modify: `static/script.js:2660-2829` (strategy UI)
- Modify: `static/style.css` (strategy cards)

**Step 1: Build the optimization algorithm**

Create a `StrategyOptimizer` class in `energy.py` that:

Inputs (all from actual user data):
- Energy rates (TOU schedule with peak/off-peak/shoulder)
- Seasonal rates (summer vs winter)
- Fleet hashrate range (min freq to max freq per miner, from device specs)
- Fleet power consumption at various frequencies
- Current BTC price (live)
- Current network difficulty (live)
- Miner efficiency (J/TH per device)
- Historical temperature data (thermal constraints)
- Weather forecast (optional)
- Hardware cost (optional, for ROI calculations)

Algorithm:
1. Calculate hourly profitability at each frequency level for each rate period
2. Find the frequency at each hour that maximizes profit (or minimizes loss)
3. Apply thermal constraints (don't set frequency that would cause overheating given ambient temp)
4. Apply miner-specific frequency bounds from device_specifications.json

Generate 3 strategies:
- **Maximum Profit**: Optimize every hour for maximum net profit. May turn off during expensive periods.
- **Maximum Hashrate**: Keep mining 24/7 at highest safe frequency. Shows projected cost/revenue.
- **Balanced**: Mine 24/7 but reduce during peak hours to balance cost vs accumulated sats.

Each strategy outputs:
- Weekly schedule (frequency per hour per day)
- Projected daily/weekly/monthly sats earned
- Projected daily/weekly/monthly energy cost
- Projected daily/weekly/monthly net profit
- Projected J/TH efficiency
- One-click apply button

**Step 2: Wire up the API endpoint**

Add `/api/strategy/optimize` endpoint that runs the optimizer and returns 3 strategies.

**Step 3: Build strategy comparison UI**

Display 3 strategy cards side by side with clear metrics. Highlight the recommended one. Each card has an "Apply" button that deploys the schedule to all miners.

---

## Phase 8: Charts Tab Overhaul (Item 8)

### Task 8.1: Redesign All Charts

**Files:**
- Modify: `static/script.js:3034-3343` and surrounding chart code
- Modify: `templates/dashboard.html:1097-1265` (charts tab HTML)
- Modify: `static/style.css` (chart styling)
- Modify: `app.py` (chart data endpoints)

**Step 1: Fix data accuracy for all charts**

Ensure each chart pulls real data:
- **Hashrate chart**: Use actual per-miner recorded hashrate, sum for fleet total. Show individual miner lines as optional overlay.
- **Temperature chart**: Plot real temperature readings per miner. Show average as bold line, individuals as faint lines.
- **Power chart**: Calculate from actual miner power consumption data. Sum for fleet total.
- **Profitability chart**: Use real profitability_log data. Plot revenue, cost, and net profit lines.
- **Efficiency chart**: Calculate J/TH from power/hashrate ratio over time.

**Step 2: Professional chart design**

For each chart:
- Clean axis labels (no excessive decimal places like "73.42291666666667°C")
- Proper units (TH/s, °C, W, $, J/TH)
- Responsive tooltip with formatted data
- Time range selector (6h, 24h, 7d, 30d)
- Refresh button
- Subtle grid lines
- Color-coded series with clear legend
- Smooth but accurate lines (light interpolation, no heavy smoothing)

**Step 3: Add chart for shares over time**

New chart showing accepted vs rejected shares over time as stacked area chart.

**Step 4: Add chart for earnings over time**

New chart showing sats earned per hour/day as bar chart.

---

## Phase 9: Performance Metrics Section (Item 9)

### Task 9.1: Move and Fix Performance Metrics

The "Current Performance Metrics" section at the bottom of the charts page shows 0 J/TH for efficiency and is poorly placed.

**Files:**
- Modify: `templates/dashboard.html` (move metrics section)
- Modify: `static/script.js` (fix efficiency calculation display)
- Modify: `static/style.css` (metrics styling)

**Step 1: Move metrics above charts**

Relocate the "Current Performance Metrics" bar to the top of the Charts tab, above all charts. This gives immediate context before viewing trends.

**Step 2: Fix efficiency display**

The efficiency shows "0 J/TH" because the calculation isn't wired up correctly. The `PowerEfficiencyMatrix` in `metrics.py` calculates correctly but the frontend doesn't call it for this display. Wire it up.

**Step 3: Expand metrics shown**

Add more relevant metrics:
- Fleet total hashrate (TH/s)
- Fleet total power (W)
- Fleet efficiency (J/TH)
- Accepted shares / Rejected shares
- Accept rate (%)
- Average temperature (°C)
- Current energy rate ($/kWh)
- Current profitability ($/day)

All formatted clearly with proper units.

---

## Phase 10: Telegram Notifications Overhaul (Item 10)

### Task 10.1: Build Comprehensive Miner Knowledge Base

**Files:**
- Create: `static/miner_knowledge/` directory with per-miner markdown files
- Modify: `device_specifications.json` (expand specs for ALL available miners)
- Modify: `alerts.py` (miner-aware alert thresholds)

**Step 1: Research and document every home miner**

Create comprehensive entries in `device_specifications.json` for every available home Bitcoin miner on the market. Each entry should include:
- Full specs (hashrate, power, efficiency, temp limits)
- Normal operating temperature range (Nano 3s runs great at 90°C)
- Warning vs critical thresholds specific to that device
- Overclocking limits
- Common issues and solutions
- Recommended settings

Miners to add/verify (if not already present):
- All BitAxe variants (Original, Max, Ultra, Supra, Gamma, Hex)
- All NerdQAxe variants (+, ++, Octaxe)
- Avalon Nano 3S, Nano 3S-L
- Antminer S21, S19 series, S17, S9
- Whatsminer M50, M30 series
- Bitmain Antminer Home series
- Heatbit
- Ember Mug Miner
- Canaan AvalonMiner Nano series
- Any other commercially available home miners

**Step 2: Update alert thresholds per device**

In `alerts.py` and `metrics.py`, use the device-specific temperature thresholds from `device_specifications.json` instead of generic defaults. The Nano 3S at 90°C should NOT trigger an alert - that's normal operation.

Currently `MinerHealthMonitor.MINER_TEMP_THRESHOLDS` in `metrics.py:297-311` has some thresholds but they're hardcoded. Wire them to `device_specifications.json`.

**Step 3: Make alert thresholds device-aware**

In the alert check flow in `app.py` (monitoring loop), when checking temperature:
1. Look up the miner's device type
2. Get its specific thresholds from `device_specifications.json`
3. Only alert if temp exceeds THAT device's warning/critical threshold

### Task 10.2: Improve Telegram Notification System

**Files:**
- Modify: `alerts.py` (expand alert types, add daily report)
- Modify: `app.py` (alert configuration, daily report scheduler)
- Modify: `templates/dashboard.html` (alert config UI)
- Modify: `static/script.js` (alert config handlers)

**Step 1: Add customizable alert categories**

Allow users to individually enable/disable each alert type via the dashboard:
- Miner offline/online
- High temperature (per-device-aware)
- Critical temperature
- Low hashrate
- Mining unprofitable
- Emergency shutdown
- Frequency adjusted
- Pool connection issues
- Daily fleet report
- Weekly earnings summary

**Step 2: Add daily fleet report**

Create a scheduled daily report sent via Telegram with:
- Total sats earned today
- Fleet uptime percentage
- Average efficiency (J/TH)
- Total energy cost
- Net profit/loss
- Any issues encountered
- BTC price and network difficulty

Schedule this to run once daily at a user-configurable time.

**Step 3: Add user-configurable alert time**

Let users set "quiet hours" where only emergency alerts are sent. Non-critical alerts are batched and sent after quiet hours end.

---

## Phase 11: Mining Pool Directory (Item 11)

### Task 11.1: Expand Pool Configuration Page

**Files:**
- Modify: `static/mining_pools.json` (ensure comprehensive)
- Modify: `static/script.js:4773-4912` (pool tab UI)
- Modify: `templates/dashboard.html` (pool tab HTML)
- Modify: `static/style.css` (pool directory styling)

**Step 1: Verify all pools are in mining_pools.json**

The file already has a comprehensive list. Verify it includes every active Bitcoin mining pool. Research and add any missing pools. Each pool entry should have:
- Name, website, fees, payout method, minimum payout
- Lightning support, KYC requirements
- Home miner suitability rating
- Stratum URLs
- Unique description

**Step 2: Build searchable pool directory UI**

At the top of the Pool Config tab, add a dropdown/searchable list of all pools with:
- Pool name and logo placeholder
- Quick summary (fee, payout method, min payout)
- "Good for home miners" badge
- Lightning support badge
- Link to sign up
- Expandable section with full details

**Step 3: Style the pool directory**

Use consistent dark theme styling. Each pool in a card format. Searchable and filterable by fee type, Lightning support, KYC requirement, etc.

---

## Execution Order

The tasks should be executed in this order (dependencies noted):

1. **Phase 1** (Data Accuracy) - Foundation for everything else
2. **Phase 9** (Performance Metrics) - Quick fix, improves charts tab
3. **Phase 8** (Charts Overhaul) - Depends on Phase 1 data fixes
4. **Phase 3** (Pie Chart) - Independent, small scope
5. **Phase 2** (Homescreen Cards) - Independent redesign
6. **Phase 5** (Energy Config) - Independent, fixes bugs
7. **Phase 4** (Tuning Fixes) - Independent, fixes bugs
8. **Phase 10.1** (Miner Knowledge Base) - Foundation for alerts
9. **Phase 10.2** (Telegram) - Depends on 10.1
10. **Phase 6** (Automated Control) - Depends on energy config working
11. **Phase 7** (Strategy Optimizer) - Depends on energy rates and auto control
12. **Phase 11** (Pool Directory) - Independent, can be done anytime

---

## Testing Strategy

After each phase:
1. Start the Flask app: `cd home-mining-fleet-manager-main && source venv/bin/activate && python app.py`
2. Open browser to http://localhost:5001
3. Verify the specific feature works correctly
4. Check browser console for JavaScript errors
5. Check Flask logs for backend errors
