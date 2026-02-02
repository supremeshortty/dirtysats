"""
Temporary metrics implementation for immediate dashboard functionality
"""
from datetime import datetime, timedelta
import random

class SatsEarnedTracker:
    def __init__(self, db):
        self.db = db
        
    def get_sats_earned(self, hours=24):
        """Return mock sats data for now"""
        base_sats = 12500
        return {
            'sats_today': base_sats + random.randint(-1000, 1000),
            'sats_this_week': base_sats * 7 + random.randint(-5000, 5000),
            'sats_all_time': 5000000 + random.randint(-50000, 50000),
            'rate_sats_per_hour': round(base_sats / 24 + random.randint(-50, 50), 1),
            'trending': random.choice(['up', 'stable', 'down']),
            'chart_data': [
                {'timestamp': (datetime.now() - timedelta(hours=h)).isoformat(), 'sats': 500 + random.randint(-100, 100)}
                for h in range(24, 0, -1)
            ]
        }

class MinerHealthMonitor:
    def __init__(self, db):
        self.db = db
        
    def get_health_status(self):
        """Return mock health data"""
        healthy = random.randint(4, 6)
        warning = random.randint(0, 2)
        critical = random.randint(0, 1)
        
        issues = []
        if critical > 0:
            issues.append("⚠️ 1 miner running hot (>85°C)")
        if warning > 0:
            issues.append("🟡 2 miners below target hashrate")
        
        overall_status = 'critical' if critical > 0 else 'warning' if warning > 0 else 'healthy'
        
        return {
            'summary': {'healthy': healthy, 'warning': warning, 'critical': critical},
            'overall_status': overall_status,
            'issues': issues if issues else ["All systems operational"]
        }

class PowerEfficiencyMatrix:
    def __init__(self, db):
        self.db = db
        
    def get_efficiency_data(self):
        """Return mock efficiency data"""
        return {
            'fleet_average': round(22.5 + random.uniform(-2, 2), 1),
            'best_efficiency': round(18.2 + random.uniform(-1, 1), 1),
            'worst_efficiency': round(35.8 + random.uniform(-3, 3), 1),
            'miner_efficiency_data': [
                {'hashrate': 14 + random.uniform(-2, 2), 'efficiency': 18 + random.uniform(-3, 3)},
                {'hashrate': 12 + random.uniform(-2, 2), 'efficiency': 22 + random.uniform(-3, 3)},
                {'hashrate': 11 + random.uniform(-2, 2), 'efficiency': 25 + random.uniform(-3, 3)},
                {'hashrate': 13 + random.uniform(-2, 2), 'efficiency': 20 + random.uniform(-3, 3)},
            ]
        }

class PoolPerformanceComparator:
    def __init__(self, db):
        self.db = db
        
    def get_pool_performance(self):
        """Return mock pool data"""
        pools = ['Ocean', 'Foundry', 'AntPool', 'F2Pool']
        return {
            'pools': [
                {'name': pool, 'relative_performance': round(95 + random.uniform(-10, 10), 1)}
                for pool in pools[:3]
            ],
            'recommendation': 'Ocean performing optimally'
        }

class PredictiveRevenueModel:
    def __init__(self, db, btc_fetcher=None):
        self.db = db
        self.btc_fetcher = btc_fetcher
        
    def get_revenue_projections(self):
        """Return mock revenue projections"""
        daily = 45.50 + random.uniform(-5, 5)
        return {
            'daily_revenue': round(daily, 2),
            'monthly_revenue': round(daily * 30, 0),
            'annual_revenue': round(daily * 365, 0),
            'breakeven_days': random.randint(180, 250)
        }