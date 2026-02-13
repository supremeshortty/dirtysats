"""
DirtySats Metrics - Real-time tracking and analytics for mining profitability
"""
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from database import Database

logger = logging.getLogger(__name__)

# Temporary database adapter until full migration
def execute_db_query(db, query, params=()):
    """Adapter function for database queries"""
    try:
        with db._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, params)
            return cursor.fetchall()
    except Exception as e:
        logger.error(f"Database query failed: {e}")
        return []


class SatsEarnedTracker:
    """
    Tracks satoshi earnings with real-time, daily, weekly, and all-time metrics.
    Pulls from pool APIs and calculates actual sats earned.
    """

    def __init__(self, db: Database, pool_manager=None):
        self.db = db
        self.pool_manager = pool_manager

    def get_sats_earned(self, hours: int = None) -> Dict:
        """
        Get sats earned in a time period.
        
        Args:
            hours: None for all-time, or specific hours (24, 168, etc)
        
        Returns:
            {
                'sats_today': 12500,
                'sats_this_week': 85000,
                'sats_all_time': 5000000,
                'rate_sats_per_hour': 520,
                'trending': 'up',  # up, stable, down
                'chart_data': [(timestamp, sats_earned), ...]
            }
        """
        now = datetime.utcnow()

        # Get share data for all miners
        with self.db._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT timestamp, shares_accepted FROM stats WHERE timestamp > ?",
                ((now - timedelta(days=30)).timestamp(),)
            )
            all_shares = cursor.fetchall()

        sats_today = self._calculate_sats_for_period(
            now - timedelta(hours=24), now
        )
        sats_this_week = self._calculate_sats_for_period(
            now - timedelta(days=7), now
        )
        sats_all_time = self._calculate_sats_for_period(None, now)

        # Calculate trend
        sats_yesterday = self._calculate_sats_for_period(
            now - timedelta(days=2), now - timedelta(days=1)
        )
        trend = "up" if sats_today > sats_yesterday else ("down" if sats_today < sats_yesterday else "stable")

        # Get hourly rates for chart
        chart_data = self._get_hourly_sats_chart(now)

        rate = sats_today / 24 if sats_today > 0 else 0

        return {
            "sats_today": sats_today,
            "sats_this_week": sats_this_week,
            "sats_all_time": sats_all_time,
            "rate_sats_per_hour": round(rate, 2),
            "trending": trend,
            "chart_data": chart_data,
            "timestamp": now.isoformat(),
        }

    def _calculate_sats_for_period(self, start: Optional[datetime], end: datetime) -> float:
        """Calculate total sats earned in a period based on shares accepted"""
        # Each accepted share on mainnet = ~6.25 BTC / 630000 shares per block
        # = ~0.00000992 BTC = ~992 sats (varies with difficulty)

        # stats.shares_accepted is typically cumulative, so use per-miner deltas.
        if start:
            result = execute_db_query(
                self.db,
                """
                SELECT COALESCE(SUM(shares_delta), 0) AS total_shares
                FROM (
                    SELECT
                        miner_id,
                        MAX(COALESCE(shares_accepted, 0)) - MIN(COALESCE(shares_accepted, 0)) AS shares_delta
                    FROM stats
                    WHERE timestamp BETWEEN ? AND ?
                    GROUP BY miner_id
                )
                """,
                (start, end),
            )
        else:
            result = execute_db_query(
                self.db,
                """
                SELECT COALESCE(SUM(shares_delta), 0) AS total_shares
                FROM (
                    SELECT
                        miner_id,
                        MAX(COALESCE(shares_accepted, 0)) - MIN(COALESCE(shares_accepted, 0)) AS shares_delta
                    FROM stats
                    WHERE timestamp <= ?
                    GROUP BY miner_id
                )
                """,
                (end,),
            )

        total_shares = result[0][0] if result and result[0][0] else 0

        # Pool difficulty average = 1 share per ~992 sats at current difficulty
        # Adjust multiplier as needed based on pool/solo
        sats_per_share = 992
        return total_shares * sats_per_share

    def _get_hourly_sats_chart(self, end_time: datetime, hours: int = 24) -> List:
        """Get hourly sats earned for chart"""
        chart = []
        for i in range(hours, 0, -1):
            hour_start = end_time - timedelta(hours=i)
            hour_end = hour_start + timedelta(hours=1)
            sats = self._calculate_sats_for_period(hour_start, hour_end)
            chart.append({
                "timestamp": hour_start.isoformat(),
                "sats": round(sats, 0),
            })
        return chart


class MinerHealthMonitor:
    """
    Tracks miner health with alert conditions and recovery metrics.
    """

    def __init__(self, db: Database):
        self.db = db
        # Alert thresholds
        self.TEMP_WARNING = 70
        self.TEMP_CRITICAL = 85
        self.HASHRATE_DROP_THRESHOLD = 0.2  # 20% drop
        self.OFFLINE_THRESHOLD_SECONDS = 120

    def get_fleet_health(self) -> Dict:
        """
        Get overall fleet health status with detailed breakdown.
        
        Returns:
            {
                'status': 'healthy' | 'warning' | 'critical',
                'total_miners': 6,
                'healthy': 5,
                'warning': 1,
                'critical': 0,
                'offline': 0,
                'issues': [
                    {
                        'miner_ip': '10.0.0.100',
                        'issue': 'high_temp',
                        'severity': 'warning',
                        'details': 'Temperature at 72°C (threshold: 70°C)',
                        'recommended_action': 'Check airflow or reduce frequency'
                    },
                    ...
                ],
                'recovery_opportunities': [...]
            }
        """
        miners = self.db.get_all_miners()
        health_status = {
            "status": "healthy",
            "total_miners": len(miners),
            "healthy": 0,
            "warning": 0,
            "critical": 0,
            "offline": 0,
            "issues": [],
            "recovery_opportunities": [],
        }

        for miner in miners:
            miner_health = self._check_miner_health(miner["ip"])
            health_status[miner_health["status"]] += 1

            if miner_health["issues"]:
                for issue in miner_health["issues"]:
                    health_status["issues"].append(issue)

        # Determine overall status
        if health_status["critical"] > 0:
            health_status["status"] = "critical"
        elif health_status["warning"] > 0:
            health_status["status"] = "warning"

        return health_status

    def _check_miner_health(self, miner_ip: str) -> Dict:
        """Check individual miner health"""
        latest = execute_db_query(
            self.db,
            """
            SELECT s.temperature, s.hashrate, s.shares_rejected
            FROM stats s
            JOIN miners m ON s.miner_id = m.id
            WHERE m.ip = ?
            ORDER BY s.timestamp DESC
            LIMIT 1
            """,
            (miner_ip,),
        )

        issues = []
        status = "healthy"

        if not latest:
            return {"status": "offline", "issues": [{"issue": "no_data", "severity": "critical"}]}

        temp, hashrate, shares_rejected = latest[0]

        # Check temperature
        if temp and temp > self.TEMP_CRITICAL:
            status = "critical"
            issues.append({
                "miner_ip": miner_ip,
                "issue": "critical_temperature",
                "severity": "critical",
                "details": f"Temperature at {temp}°C (critical: {self.TEMP_CRITICAL}°C)",
                "recommended_action": "Immediately reduce frequency or shutdown for cooling",
            })
        elif temp and temp > self.TEMP_WARNING:
            status = "warning"
            issues.append({
                "miner_ip": miner_ip,
                "issue": "high_temperature",
                "severity": "warning",
                "details": f"Temperature at {temp}°C (warning: {self.TEMP_WARNING}°C)",
                "recommended_action": "Check airflow, consider reducing frequency",
            })

        # Check for stale hashrate
        if hashrate and hashrate < 1:
            status = "warning" if status == "healthy" else status
            issues.append({
                "miner_ip": miner_ip,
                "issue": "low_hashrate",
                "severity": "warning",
                "details": f"Hashrate dropped to {hashrate} GH/s",
                "recommended_action": "Check miner connectivity or restart",
            })

        return {"status": status, "issues": issues}


class PowerEfficiencyMatrix:
    """
    Tracks W/TH efficiency for each miner and fleet average.
    Calculates cost per satoshi at current electricity rates.
    """

    def __init__(self, db: Database):
        self.db = db

    def get_efficiency_matrix(self, electricity_rate_per_kwh: float = 0.12) -> Dict:
        """
        Get power efficiency for all miners.
        
        Args:
            electricity_rate_per_kwh: Your electricity cost per kWh
        
        Returns:
            {
                'fleet_average_w_per_th': 0.45,
                'best_performer': {'ip': '10.0.0.100', 'w_per_th': 0.38},
                'worst_performer': {'ip': '10.0.0.101', 'w_per_th': 0.52},
                'miners': [
                    {
                        'ip': '10.0.0.100',
                        'model': 'BitAxe Gamma',
                        'hashrate_th': 1.2,
                        'power_w': 450,
                        'w_per_th': 0.375,
                        'cost_per_sat_usat': 0.00000042,
                        'estimated_daily_cost': 10.80,
                    },
                    ...
                ],
                'projected_monthly_cost': 324.00,
                'cost_optimization_potential': 'Reduce frequency on miner 10.0.0.101 by 10% to save $8.50/month'
            }
        """
        miners = self.db.get_all_miners()
        efficiency_data = []
        total_w_per_th = 0
        valid_miners = 0

        for miner in miners:
            latest = execute_db_query(
                self.db,
                """
                SELECT s.hashrate, s.power
                FROM stats s
                JOIN miners m ON s.miner_id = m.id
                WHERE m.ip = ?
                ORDER BY s.timestamp DESC
                LIMIT 1
                """,
                (miner["ip"],),
            )

            if not latest or not latest[0][0]:
                continue

            hashrate_gh, power_w = latest[0]
            hashrate_th = hashrate_gh / 1000 if hashrate_gh else 0

            if hashrate_th > 0:
                w_per_th = power_w / hashrate_th
                daily_kwh = (power_w / 1000) * 24
                daily_cost = daily_kwh * electricity_rate_per_kwh

                efficiency_data.append({
                    "ip": miner["ip"],
                    "custom_name": miner.get("custom_name", "Unknown"),
                    "hashrate_th": round(hashrate_th, 2),
                    "power_w": round(power_w, 0),
                    "w_per_th": round(w_per_th, 3),
                    "daily_cost_usd": round(daily_cost, 2),
                    "cost_per_sat_usat": round((daily_cost * 100000000) / (hashrate_gh * 0.1), 6),
                })
                total_w_per_th += w_per_th
                valid_miners += 1

        fleet_avg = total_w_per_th / valid_miners if valid_miners > 0 else 0

        # Sort and find best/worst
        efficiency_data.sort(key=lambda x: x["w_per_th"])
        best = efficiency_data[0] if efficiency_data else None
        worst = efficiency_data[-1] if efficiency_data else None

        # Calculate fleet cost
        total_daily_cost = sum(m["daily_cost_usd"] for m in efficiency_data)
        monthly_cost = total_daily_cost * 30

        return {
            "fleet_average_w_per_th": round(fleet_avg, 3),
            "best_performer": best,
            "worst_performer": worst,
            "miners": efficiency_data,
            "total_daily_cost_usd": round(total_daily_cost, 2),
            "projected_monthly_cost_usd": round(monthly_cost, 2),
            "electricity_rate_per_kwh": electricity_rate_per_kwh,
        }


class PoolPerformanceComparator:
    """
    Compares mining pool performance if running multiple pools.
    """

    def __init__(self, db: Database):
        self.db = db

    def get_pool_comparison(self) -> Dict:
        """
        Compare pools by shares, fees, and estimated earnings.
        
        Returns:
            {
                'pools': [
                    {
                        'pool_name': 'Braiins',
                        'miners_on_pool': 2,
                        'total_hashrate_th': 2.4,
                        'shares_accepted': 1250,
                        'shares_rejected': 12,
                        'reject_rate': 0.96,
                        'pool_fee_percent': 0.0,
                        'estimated_daily_sats': 5200,
                        'estimated_daily_value_usd': 1.56,
                        'efficiency_score': 94  # 0-100
                    },
                    ...
                ],
                'best_performing_pool': 'Braiins',
                'recommendation': 'Consider switching 10.0.0.101 to Ocean for better fee structure'
            }
        """
        # Get miner pool assignments from history
        pools_data = execute_db_query(
            self.db,
            "SELECT DISTINCT pool_name FROM pool_config WHERE active = 1 AND pool_name IS NOT NULL"
        )

        pools = {}
        for (pool_name,) in pools_data:
            if not pool_name:
                continue

            # Get stats for this pool
            miners_on_pool = execute_db_query(
                self.db,
                "SELECT COUNT(DISTINCT miner_ip) FROM pool_config WHERE active = 1 AND pool_name = ?",
                (pool_name,),
            )[0][0]

            # Get average metrics for miners on this pool (last 24h)
            metrics = execute_db_query(
                self.db,
                """
                SELECT 
                    AVG(s.hashrate),
                    SUM(COALESCE(s.shares_accepted, 0)),
                    SUM(COALESCE(s.shares_rejected, 0)),
                    AVG(pc.fee_percent)
                FROM stats s
                JOIN miners m ON s.miner_id = m.id
                JOIN pool_config pc ON pc.miner_ip = m.ip
                WHERE pc.active = 1
                AND pc.pool_name = ?
                AND s.timestamp > ?
                """,
                (pool_name, datetime.utcnow() - timedelta(hours=24)),
            )

            if metrics and metrics[0][0]:
                avg_hr, total_shares_acc, total_shares_rej, avg_fee = metrics[0]
                total_shares = (total_shares_acc or 0) + (total_shares_rej or 0)
                reject_rate = (total_shares_rej / total_shares * 100) if total_shares > 0 else 0

                pools[pool_name] = {
                    "pool_name": pool_name,
                    "miners_on_pool": miners_on_pool,
                    "total_hashrate_th": round(avg_hr / 1000, 2),
                    "shares_accepted": int(total_shares_acc or 0),
                    "shares_rejected": int(total_shares_rej or 0),
                    "reject_rate_percent": round(reject_rate, 2),
                    "pool_fee_percent": avg_fee or 0.0,
                    "estimated_daily_sats": int(total_shares_acc * 992 if total_shares_acc else 0),
                    "efficiency_score": max(0, 100 - (reject_rate * 2)),  # Simple scoring
                }

        pools_list = sorted(
            pools.values(), key=lambda x: x["efficiency_score"], reverse=True
        )

        best_pool = pools_list[0]["pool_name"] if pools_list else None

        return {
            "pools": pools_list,
            "best_performing_pool": best_pool,
            "pool_count": len(pools_list),
        }


class PredictiveRevenueModel:
    """
    Projects earnings based on current hashrate and difficulty trends.
    """

    def __init__(self, db: Database, btc_fetcher=None):
        self.db = db
        self.btc_fetcher = btc_fetcher

    def get_revenue_projection(
        self, target_sats: int = None, electricity_rate: float = 0.12
    ) -> Dict:
        """
        Project earnings and break-even analysis.
        
        Args:
            target_sats: Optional target satoshis to reach
            electricity_rate: Cost per kWh
        
        Returns:
            {
                'current_rate_sats_per_day': 12500,
                'current_rate_sats_per_month': 375000,
                'current_rate_sats_per_year': 4562500,
                'monthly_electricity_cost_usd': 324.00,
                'monthly_profit_loss_usd': 156.00,  # positive = profitable
                'breakeven_btc_price': 42150,
                'if_target_is_set': {
                    'target_sats': 1000000,
                    'days_to_reach': 80,
                    'date_target_reached': '2026-04-19'
                },
                'difficulty_trend': 'up',  # up, stable, down
                'projected_monthly_sats_90_days': 325000,  # accounting for difficulty increase
                'profitability_status': 'profitable' | 'marginal' | 'unprofitable'
            }
        """
        # Get current fleet stats
        latest_stats = execute_db_query(
            self.db,
            """
            SELECT 
                SUM(hashrate),
                AVG(power),
                MAX(timestamp)
            FROM stats
            WHERE timestamp > ?
            AND status IN ('online', 'overheating')
            """,
            (datetime.utcnow() - timedelta(hours=1),),
        )

        if not latest_stats or not latest_stats[0][0]:
            return {"error": "Insufficient data"}

        total_hashrate_gh, avg_power_w, _ = latest_stats[0]
        total_hashrate_th = total_hashrate_gh / 1000 if total_hashrate_gh else 0

        # Calculate daily earnings
        sats_per_day = total_hashrate_th * 10000 * 24  # Approximate based on current difficulty
        sats_per_month = sats_per_day * 30
        sats_per_year = sats_per_day * 365

        # Calculate costs
        daily_kwh = (avg_power_w / 1000) * 24 if avg_power_w else 0
        monthly_kwh = daily_kwh * 30
        monthly_cost_usd = monthly_kwh * electricity_rate

        # Get BTC price for profit calculation
        btc_price = 95000  # Default, would come from btc_fetcher
        if self.btc_fetcher:
            btc_price = self.btc_fetcher.get_btc_price()

        monthly_revenue_usd = (sats_per_month / 100000000) * btc_price
        monthly_profit_usd = monthly_revenue_usd - monthly_cost_usd

        # Determine profitability status
        if monthly_profit_usd > 0:
            profitability = "profitable"
        elif monthly_profit_usd < -50:
            profitability = "unprofitable"
        else:
            profitability = "marginal"

        # Breakeven BTC price
        breakeven_btc_price = (monthly_cost_usd * 100000000) / sats_per_month if sats_per_month > 0 else 0

        result = {
            "current_rate_sats_per_day": int(sats_per_day),
            "current_rate_sats_per_month": int(sats_per_month),
            "current_rate_sats_per_year": int(sats_per_year),
            "monthly_electricity_cost_usd": round(monthly_cost_usd, 2),
            "monthly_revenue_usd": round(monthly_revenue_usd, 2),
            "monthly_profit_loss_usd": round(monthly_profit_usd, 2),
            "breakeven_btc_price_usd": round(breakeven_btc_price, 0),
            "difficulty_trend": "stable",  # Would calculate from historical data
            "profitability_status": profitability,
            "btc_price_usd": btc_price,
        }

        # If target sats provided
        if target_sats:
            days_to_reach = target_sats / sats_per_day if sats_per_day > 0 else 999999
            target_date = datetime.utcnow() + timedelta(days=days_to_reach)
            result["target_analysis"] = {
                "target_sats": target_sats,
                "days_to_reach": round(days_to_reach, 1),
                "date_target_reached": target_date.strftime("%Y-%m-%d"),
                "on_track": days_to_reach <= 365,
            }

        return result
