# Pool Configuration Guide

## Universal Pool Support

DirtySats supports **all Bitcoin mining pools** including:
- Public pools (Braiins, Ocean, F2Pool, AntPool, etc.)
- Private pools (Foundry USA, MARA Pool, custom enterprise pools)
- Solo mining (Public Pool, Solo CKPool, localhost)
- Custom/unknown pools

---

## Automatic Pool Detection

The system automatically detects and configures pools on startup.

### Supported Pools (Auto-Detected)

| Pool | Fee | Type | Notes |
|------|-----|------|-------|
| **Braiins Pool** | 2.5% | FPPS+ | Includes tx fees |
| **Ocean** | 0% | TIDES | Bitcoin Core templates |
| **Public Pool** | 0% | SOLO | Solo mining option |
| **F2Pool** | 2.5% | PPS+ | Large pool |
| **AntPool** | 2.5% | FPPS | Bitmain pool |
| **Slush Pool** | 2.0% | Score | Oldest pool |
| **ViaBTC** | 2.0% | FPPS | Multiple coins |
| **Poolin** | 2.5% | FPPS | Large pool |
| **Luxor** | Varies | FPPS | Enterprise focus |
| **BTC.com** | 1.5% | FPPS | Low fees |
| **Binance Pool** | 2.5% | FPPS | Exchange pool |
| **Solo CKPool** | 0.5% | SOLO | Solo mining |
| **Localhost** | 0% | SOLO | Self-hosted node |
| **Foundry USA** | Private | FPPS | Enterprise only |
| **MARA Pool** | Private | FPPS | Enterprise only |

---

## Pool Types Explained

### FPPS (Full Pay Per Share)
- Most predictable earnings
- Pay for block subsidy only (no tx fees)
- **Confidence:** 90%

### FPPS+ (Full Pay Per Share Plus)
- Includes transaction fees
- Most common for public pools
- Higher earnings than PPS
- **Confidence:** 90%

### PPS (Pay Per Share)
- Standard calculation
- Block subsidy only
- **Confidence:** 90%

### PPLNS (Pay Per Last N Shares)
- Variance-based
- Depends on pool luck
- Can be +/- 30% from expected
- **Confidence:** 50% (high variance)

### SOLO Mining
- Only paid when you find a block
- Shares don't translate directly to sats
- Track blocks found instead
- **Confidence:** 0% (shares don't count)

### TIDES (Ocean)
- Transparent Index of Distinct Extended Shares
- Uses Bitcoin Core block templates
- Similar to FPPS+
- **Confidence:** 90%

---

## Configuring Unknown/Custom Pools

If your pool isn't auto-detected, you can configure it manually.

### Method 1: API Configuration

```bash
# Configure custom pool
curl -X POST http://localhost:5001/api/pool-config \
  -H "Content-Type: application/json" \
  -d '{
    "miner_ip": "192.168.1.100",
    "pool_name": "My Custom Pool",
    "pool_url": "stratum+tcp://custom-pool.example.com:3333",
    "pool_port": 3333,
    "fee_percent": 2.5,
    "pool_type": "FPPS",
    "pool_difficulty": 5000
  }'
```

### Method 2: Direct Database Update

```python
from database.db import Database

db = Database('fleet.db')
db.add_pool_config(
    miner_ip='192.168.1.100',
    pool_index=0,
    pool_name='My Custom Pool',
    pool_url='stratum+tcp://custom-pool.example.com:3333',
    pool_port=3333,
    fee_percent=2.5,  # Your pool's fee
    pool_type='FPPS',  # Your pool's type
    pool_difficulty=5000  # Typical value
)
```

### Pool Configuration Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `miner_ip` | ✅ Yes | - | Miner's IP address |
| `pool_name` | ✅ Yes | - | Display name for pool |
| `pool_url` | No | - | Full stratum URL |
| `pool_port` | No | 3333 | Pool port number |
| `pool_index` | No | 0 | 0=primary, 1/2=failover |
| `fee_percent` | No | 2.5 | Pool fee (0-100) |
| `pool_type` | No | PPS | FPPS, FPPS+, PPS, PPLNS, SOLO |
| `pool_difficulty` | No | 5000 | Pool's share difficulty |

---

## Finding Your Pool's Information

### Pool Fee
Check your pool's website or dashboard:
- Braiins Pool: 2.5% (FPPS+)
- Ocean: 0% (TIDES)
- F2Pool: 2.5% (PPS+)
- Most pools: 1.5% - 3%
- Solo: 0% - 0.5%

### Pool Type
Common types by pool:
- **FPPS/FPPS+:** Most large pools (AntPool, ViaBTC, Braiins)
- **PPS/PPS+:** F2Pool, BTC.com
- **PPLNS:** Smaller pools, some p2pool
- **SOLO:** Public Pool, Solo CKPool, localhost

### Pool Difficulty
This is usually displayed in your pool dashboard:
- Typical range: 1,000 - 100,000
- Higher difficulty = fewer shares but higher value per share
- Lower difficulty = more shares but lower value per share
- **Default:** 5,000 (good estimate if unknown)

---

## API Endpoints

### Get Pool Configurations
```bash
# Get all pool configs
GET /api/pool-config

# Get configs for specific miner
GET /api/pool-config?miner_ip=192.168.1.100

# Get configs for specific pool
GET /api/pool-config?pool_name=Braiins Pool
```

### Update Pool Configuration
```bash
POST /api/pool-config
Content-Type: application/json

{
  "miner_ip": "192.168.1.100",
  "pool_name": "Custom Pool",
  "fee_percent": 2.0,
  "pool_type": "FPPS",
  "pool_difficulty": 8000
}
```

### Trigger Pool Detection
```bash
# Detect pools from all miners
POST /api/pool-config/detect

# Force re-detection (update existing)
POST /api/pool-config/detect?force=true
```

---

## Earnings Calculation Accuracy

| Configuration | Accuracy | Notes |
|---------------|----------|-------|
| **Known pool + detected config** | ~95% | Best case without API |
| **Custom pool + manual config** | ~90% | Depends on config accuracy |
| **Unknown pool + defaults** | ~70% | Uses generic 2.5% fee, PPS |
| **PPLNS pool** | ~50% | High variance by design |
| **Solo mining** | 0% | Only blocks count, not shares |
| **With pool API** | 100% | Future enhancement |

---

## Troubleshooting

### Pool Not Detected
1. Check miner is online: `GET /api/miners`
2. Manually trigger detection: `POST /api/pool-config/detect?force=true`
3. Check pool URL format in miner settings
4. Configure manually if still not detected

### Inaccurate Earnings
1. Verify pool fee: Check pool website
2. Verify pool type: FPPS vs PPS makes big difference
3. Update pool difficulty: Get from pool dashboard
4. Check pool's reported earnings vs dashboard

### Solo Mining Shows Zero Earnings
This is correct! Solo mining earnings only come from blocks found.
The dashboard will only show sats earned when you actually find a block.

### PPLNS Pool Highly Variable
This is normal. PPLNS depends on pool luck and can vary ±30% from expected.
The dashboard shows expected value, but actual will fluctuate.

---

## Examples

### Example 1: Configure Braiins Pool (Manual)
```json
{
  "miner_ip": "192.168.1.100",
  "pool_name": "Braiins Pool",
  "pool_url": "stratum+tcp://stratum.braiins.com:3333",
  "fee_percent": 2.5,
  "pool_type": "FPPS+",
  "pool_difficulty": 5000
}
```

### Example 2: Configure Ocean
```json
{
  "miner_ip": "192.168.1.101",
  "pool_name": "Ocean",
  "pool_url": "stratum+tcp://pool.ocean.xyz:3334",
  "fee_percent": 0.0,
  "pool_type": "TIDES",
  "pool_difficulty": 8000
}
```

### Example 3: Configure Solo Mining
```json
{
  "miner_ip": "192.168.1.102",
  "pool_name": "Solo CKPool",
  "pool_url": "stratum+tcp://solo.ckpool.org:3333",
  "fee_percent": 0.5,
  "pool_type": "SOLO",
  "pool_difficulty": 1000
}
```

### Example 4: Configure Custom Enterprise Pool
```json
{
  "miner_ip": "192.168.1.103",
  "pool_name": "My Company Pool",
  "pool_url": "stratum+tcp://pool.mycompany.com:3333",
  "fee_percent": 1.0,
  "pool_type": "FPPS",
  "pool_difficulty": 10000
}
```

---

## Best Practices

1. **Always verify pool configuration** after auto-detection
2. **Check accuracy** by comparing dashboard vs pool website
3. **Update pool difficulty** monthly (pools adjust this)
4. **Use FPPS/FPPS+ when possible** for most accurate calculations
5. **Understand variance** with PPLNS pools
6. **Track blocks found** for solo mining, not shares

---

## Future Enhancements

### Pool API Integration (Phase D)
When pool APIs are available, the system can achieve 100% accuracy by:
- Fetching earnings directly from pool
- Comparing calculated vs actual
- Tracking variance automatically
- Alerting on discrepancies

Currently supported without API access: **~95% accuracy** for FPPS/PPS pools.

---

*Last updated: February 2, 2026*
