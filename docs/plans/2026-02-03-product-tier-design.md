# DirtySats — Product & Tier Design

## Overview

DirtySats is a Bitcoin mining fleet management dashboard available as a free open-source self-hosted tool and a mobile app (iOS + Android) with a freemium model. The free tier is genuinely useful for monitoring, manual control, and analytics. The premium tier unlocks automation, intelligence, and advanced tooling.

## Pricing

| Plan | Price | Effective Monthly |
|------|-------|-------------------|
| Free | $0 | — |
| Premium Monthly | $2.99/mo | $2.99 |
| Premium Yearly | $19.99/yr | $1.67 |
| Premium Lifetime | $34.99 | — |

No miner limits on any tier.

## Distribution

| Channel | Tiers Available | Notes |
|---------|----------------|-------|
| GitHub (public repo) | Free only | Self-host on Pi, desktop, Linux. Open source for community contributions and forks. |
| iOS App Store | Free + Premium | In-app purchase for upgrade |
| Android Google Play | Free + Premium | In-app purchase for upgrade |
| Umbrel / Start9 / node OS | Free initially | Premium via account linking later |

## Competitive Positioning

- HashWatcher is the closest competitor at $2.99/mo, $19.99/yr, $39.99 lifetime
- DirtySats free tier exceeds HashWatcher's free tier (charts, earnings calculations, break-even price, Telegram alerts, energy configuration)
- DirtySats premium tier significantly deeper (strategy optimizer, automation, pool directory, batch operations, seasonal energy, data export)
- DirtySats lifetime at $34.99 undercuts HashWatcher's $39.99

---

## Free Tier — "Monitor & Mine"

### Fleet Monitoring
- Miner discovery and auto-detection (all device types — BitAxe, CGMiner, Avalon, Antminer, Whatsminer)
- Real-time stats: hashrate, temperature, fan speed, power, shares
- Miner status indicators (online / offline / overheating)
- Miner naming
- Unlimited miners

### Manual Control
- Frequency adjustment per miner
- Fan speed control per miner
- Voltage control per miner
- Miner restart
- Pool URL configuration per miner

### Energy Configuration
- Manual energy rate entry (flat rate or time-of-use)
- Energy rate presets (pre-configured profiles for quick setup)
- Peak / off-peak time configuration
- Current rate and period display
- Daily energy cost display

### Charts & Analytics
- Fleet performance chart (hashrate + temperature, all time ranges)
- Power consumption history chart
- Profitability trend chart
- Efficiency (J/TH) history chart
- Shares accepted vs rejected chart
- All time range selectors (6hr, 24hr, 7 day, 30 day)

### Earnings Visibility
- Sats earned tracker (daily / weekly / all-time)
- Revenue, energy cost, and net profit calculations
- Break-even BTC price
- Bitcoin halving countdown (block height, blocks/days until halving, current subsidy)
- Solo mining odds calculator
- Fleet efficiency (J/TH) display
- Miner specifications database (detailed specs for all supported device types)

### Telegram Bot
- Full setup and validation
- Miner offline / online notifications
- Temperature warning and critical alerts
- Low hashrate threshold alerts (configurable % drop detection)
- Daily fleet summary report (with manual trigger)
- Quiet hours configuration

---

## Premium Tier — "Optimize & Earn"

### Remote Monitoring (Pool API Integration)
- No additional hardware or software required — the phone is all the user needs
- Cloud polls user's mining pool API every 5 minutes for real-time remote data
- Live remote data: worker online/offline status, hashrate, earnings, balance, payouts
- Cached remote data: temperature, fan speed, power consumption (synced from phone while on home WiFi)
- Push notifications: miner offline, hashrate drop, earnings milestones (via Firebase)
- Setup: select pool from list → enter wallet address (Ocean, Public Pool, Solo CK) or API key (Braiins, F2Pool, Luxor, etc.) → done
- Supports 15+ major pools at launch (see business plan Section 5a for full list)

### Automation & Optimization
- Auto-optimize (thermal-based frequency tuning per miner)
- Fleet-wide auto-optimization toggle
- Automated peak / off-peak mining schedules
- Profitability guard (auto-pause when unprofitable)
- BTC price floor (pause mining below threshold)
- Rate threshold emergency override
- 24-hour mining timeline visualization

### Strategy Optimizer
- 3 personalized strategy recommendations from real fleet data
- Max Profit / Max Hashrate / Balanced comparisons
- Projected daily / weekly / monthly revenue per strategy
- One-click strategy apply

### Advanced Energy
- Seasonal rate configuration (summer / winter with date ranges)
- 99% accuracy integrated energy tracking
- Projected daily energy cost with hourly TOU breakdown
- Actual energy consumption tracking with historical TOU cost analysis
- Energy consumption history with cost overlay

### Fleet Intelligence
- Miner health monitor (status detection across fleet)
- Power efficiency matrix (W/TH ranking)
- Pool performance comparator
- Predictive revenue model (7 / 30 / 90 day projections)
- Best / worst miner ranking
- Estimated PPLNS scoring shares (fleet-wide and per-miner, exponential decay formula)

### Pool Directory & Comparison
- Full directory (50+ pools with detailed specs)
- Search and filter (No KYC, Lightning, Low Fee, Solo, FPPS, PPLNS)
- Side-by-side pool comparison modal
- Pool signup links
- Home miner suitability ratings

### Batch Operations & Groups
- Multi-select miners
- Batch restart, frequency, fan speed apply
- Miner groups with filtering
- Group management

### Data Export
- CSV / JSON export for miners, history, profitability

### Per-Miner Advanced Detail
- Performance tab with extended metrics
- History tab with historical data
- Frequency history tracking (per-miner changes over time)
- Advanced tuning controls
- Force frequency override (manual thermal override)
- Thermal reset (clear thermal history and frequency adjustments)

---

## Implementation Notes

### Architecture
- **Free tier:** Phone communicates directly with miners on home WiFi. All data stored locally on the phone (SQLite, 30-day rolling window). No cloud account required. No additional hardware needed.
- **Premium tier:** Same local functionality as free + cloud account + pool API remote monitoring + phone-synced data in cloud + push notifications. No additional hardware needed — phone is all the user needs.
- **No Docker agent, no Raspberry Pi, no always-on device required for any tier.**

### Data Architecture
- Phone local DB: miners, stats (30-day rolling), config, pool_links, sync_log
- Cloud DB: users, user_miners, stats_history, pool_connections, pool_snapshots, push_tokens, alerts_sent
- Phone syncs locally-collected stats (temp, power, fan) to cloud while on home WiFi (premium)
- Cloud polls mining pool APIs every 5 minutes for live remote data (premium)

### Remote Monitoring Data Sources

| Data | Remote Source | Freshness |
|------|-------------|-----------|
| Worker online/offline | Pool API | Live (5-min polling) |
| Hashrate | Pool API | Live (5-min polling) |
| Earnings / balance | Pool API | Live (5-min polling) |
| Temperature | Phone cache → cloud | Last time app was open on home WiFi |
| Fan speed | Phone cache → cloud | Last time app was open on home WiFi |
| Power consumption | Phone cache → cloud | Last time app was open on home WiFi |

### Away-from-Home UX (Free Users)
- Last known data displayed with "Last updated: X minutes ago" banner
- All locally-stored history and charts still accessible
- Data is not blank — it's stale but visible
- Soft prompt: "Connect to your home WiFi for live data, or upgrade to Premium for remote monitoring"

### Tier Enforcement
- The GitHub public repo contains only the free tier codebase
- The mobile app includes both tiers with premium features gated behind subscription verification
- Premium features should degrade gracefully — show a lock icon or "Premium" badge with upgrade prompt, not broken UI
- Account creation is not required for free tier — prompted when user wants remote features

### Subscription Management
- iOS: StoreKit 2 for in-app purchases
- Android: Google Play Billing Library
- Lifetime purchase should be treated as a non-renewing subscription
- Receipt validation server-side to prevent piracy

### Migration Path
- Existing self-hosted users who upgrade to the app should be able to import their fleet.db
- Premium features activated instantly on purchase, no restart required
