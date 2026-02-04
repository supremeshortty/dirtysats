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
- DirtySats premium tier significantly deeper (strategy optimizer, automation, pool directory, batch operations, seasonal energy, weather, data export)
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
- Solo mining odds calculator
- Fleet efficiency (J/TH) display

### Telegram Bot
- Full setup and validation
- Miner offline / online notifications
- Temperature warning and critical alerts
- Daily fleet summary report
- Quiet hours configuration

---

## Premium Tier — "Optimize & Earn"

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
- OpenEI utility database search (1000+ US utilities)
- Seasonal rate configuration (summer / winter with date ranges)
- 99% accuracy integrated energy tracking
- Energy consumption history with cost overlay

### Fleet Intelligence
- Miner health monitor (status detection across fleet)
- Power efficiency matrix (W/TH ranking)
- Pool performance comparator
- Predictive revenue model (7 / 30 / 90 day projections)
- Best / worst miner ranking

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

### Weather Integration
- Weather-aware mining predictions
- Optimal mining hours forecast

### Per-Miner Advanced Detail
- Performance tab with extended metrics
- History tab with historical data
- Advanced tuning controls

---

## Implementation Notes

### Tier Enforcement
- The GitHub public repo contains only the free tier codebase
- The mobile app includes both tiers with premium features gated behind subscription verification
- Premium features should degrade gracefully — show a lock icon or "Premium" badge with upgrade prompt, not broken UI

### Subscription Management
- iOS: StoreKit 2 for in-app purchases
- Android: Google Play Billing Library
- Lifetime purchase should be treated as a non-renewing subscription
- Receipt validation server-side to prevent piracy

### Migration Path
- Existing self-hosted users who upgrade to the app should be able to import their fleet.db
- Premium features activated instantly on purchase, no restart required
