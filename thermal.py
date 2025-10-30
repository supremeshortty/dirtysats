"""
Thermal Management & Auto-Tuning Module

Intelligent temperature-based frequency optimization for Bitcoin miners.
Prevents overheating while maximizing hashrate through real-time adjustments.
"""
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
import config

logger = logging.getLogger(__name__)


@dataclass
class FrequencyProfile:
    """Frequency and temperature profile for a miner type"""
    min_freq: int          # Minimum safe frequency (MHz)
    max_freq: int          # Maximum safe frequency (MHz)
    default_freq: int      # Default/conservative frequency (MHz)
    optimal_temp: float    # Target optimal temperature (°C)
    warning_temp: float    # Start aggressive cooling (°C)
    critical_temp: float   # Emergency shutdown temperature (°C)
    max_chip_temp: float   # Absolute maximum chip temperature (°C)
    temp_hysteresis: float # Temperature change threshold for adjustment (°C)
    freq_step: int         # Frequency adjustment step size (MHz)


# Miner-specific profiles based on research
MINER_PROFILES = {
    'Bitaxe': FrequencyProfile(
        min_freq=400,
        max_freq=600,      # Conservative max for 24/7 operation
        default_freq=490,   # Stock frequency
        optimal_temp=60.0,  # Target temperature
        warning_temp=65.0,  # Start backing off
        critical_temp=68.0, # Emergency shutdown (conservative for small miners)
        max_chip_temp=75.0, # Absolute max before damage risk
        temp_hysteresis=2.0,
        freq_step=10
    ),
    'Antminer': FrequencyProfile(
        min_freq=400,
        max_freq=650,      # Conservative for S9/S17 series
        default_freq=550,
        optimal_temp=65.0,
        warning_temp=75.0,
        critical_temp=80.0, # S9i max board temp is 85°C, be conservative
        max_chip_temp=85.0,
        temp_hysteresis=3.0,
        freq_step=25
    ),
    'Whatsminer': FrequencyProfile(
        min_freq=400,
        max_freq=650,
        default_freq=550,
        optimal_temp=65.0,
        warning_temp=75.0,
        critical_temp=80.0,
        max_chip_temp=85.0,
        temp_hysteresis=3.0,
        freq_step=25
    ),
    'Avalon': FrequencyProfile(
        min_freq=400,
        max_freq=650,
        default_freq=550,
        optimal_temp=65.0,
        warning_temp=75.0,
        critical_temp=80.0,
        max_chip_temp=85.0,
        temp_hysteresis=3.0,
        freq_step=25
    ),
    'Unknown': FrequencyProfile(
        min_freq=400,
        max_freq=500,  # Very conservative for unknown miners
        default_freq=450,
        optimal_temp=60.0,
        warning_temp=65.0,
        critical_temp=70.0,
        max_chip_temp=75.0,
        temp_hysteresis=2.0,
        freq_step=10
    )
}


class ThermalState:
    """Track thermal state of a miner"""
    def __init__(self, miner_ip: str, miner_type: str):
        self.miner_ip = miner_ip
        self.miner_type = miner_type
        self.profile = MINER_PROFILES.get(miner_type, MINER_PROFILES['Unknown'])

        self.current_freq = self.profile.default_freq
        self.current_temp = 0.0
        self.last_temp = 0.0
        self.temp_trend = 0.0  # Positive = heating, negative = cooling

        # Emergency shutdown tracking
        self.in_emergency_cooldown = False
        self.cooldown_started = None
        self.cooldown_duration = timedelta(minutes=10)

        # Auto-tuning state
        self.auto_tune_enabled = True
        self.last_adjustment = None
        self.adjustment_interval = timedelta(seconds=30)  # Don't adjust too frequently

        # Performance tracking
        self.hashrate_history = []
        self.temp_history = []

    def update_temperature(self, temp: float):
        """Update current temperature and calculate trend"""
        self.last_temp = self.current_temp
        self.current_temp = temp

        # Calculate temperature trend (simple derivative)
        if self.last_temp > 0:
            self.temp_trend = temp - self.last_temp

        # Track history
        self.temp_history.append({
            'timestamp': datetime.now(),
            'temp': temp,
            'freq': self.current_freq
        })

        # Keep only last hour of history
        cutoff = datetime.now() - timedelta(hours=1)
        self.temp_history = [h for h in self.temp_history if h['timestamp'] > cutoff]

    def update_hashrate(self, hashrate: float):
        """Track hashrate for performance optimization"""
        self.hashrate_history.append({
            'timestamp': datetime.now(),
            'hashrate': hashrate,
            'freq': self.current_freq,
            'temp': self.current_temp
        })

        # Keep only last hour
        cutoff = datetime.now() - timedelta(hours=1)
        self.hashrate_history = [h for h in self.hashrate_history if h['timestamp'] > cutoff]

    def check_emergency_cooldown(self) -> bool:
        """Check if miner is in emergency cooldown period"""
        if not self.in_emergency_cooldown:
            return False

        elapsed = datetime.now() - self.cooldown_started
        if elapsed >= self.cooldown_duration:
            # Cooldown complete
            self.in_emergency_cooldown = False
            self.cooldown_started = None
            logger.info(f"Emergency cooldown complete for {self.miner_ip}")
            return False

        remaining = (self.cooldown_duration - elapsed).total_seconds()
        logger.debug(f"{self.miner_ip} cooling down, {remaining:.0f}s remaining")
        return True

    def trigger_emergency_shutdown(self):
        """Trigger emergency shutdown and cooldown"""
        logger.warning(f"EMERGENCY SHUTDOWN triggered for {self.miner_ip} " +
                      f"(temp: {self.current_temp:.1f}°C, critical: {self.profile.critical_temp}°C)")

        self.in_emergency_cooldown = True
        self.cooldown_started = datetime.now()
        self.current_freq = 0  # Shut down completely

    def can_adjust_frequency(self) -> bool:
        """Check if enough time has passed since last adjustment"""
        if self.last_adjustment is None:
            return True

        elapsed = datetime.now() - self.last_adjustment
        return elapsed >= self.adjustment_interval

    def get_average_temp(self, minutes: int = 5) -> Optional[float]:
        """Get average temperature over last N minutes"""
        if not self.temp_history:
            return None

        cutoff = datetime.now() - timedelta(minutes=minutes)
        recent = [h['temp'] for h in self.temp_history if h['timestamp'] > cutoff]

        if not recent:
            return None

        return sum(recent) / len(recent)

    def get_hashrate_per_watt_efficiency(self) -> Optional[float]:
        """Calculate current efficiency (hashrate per watt)"""
        if not self.hashrate_history:
            return None

        # Use most recent data point
        recent = self.hashrate_history[-1]
        # This would need power data - placeholder for now
        return None


class ThermalManager:
    """Manage thermal state and auto-tuning for all miners"""

    def __init__(self, db):
        self.db = db
        self.thermal_states: Dict[str, ThermalState] = {}
        self.global_auto_tune_enabled = True

    def register_miner(self, miner_ip: str, miner_type: str):
        """Register a miner for thermal management"""
        if miner_ip not in self.thermal_states:
            self.thermal_states[miner_ip] = ThermalState(miner_ip, miner_type)
            logger.info(f"Registered {miner_ip} ({miner_type}) for thermal management")

    def update_miner_stats(self, miner_ip: str, temperature: float, hashrate: float = None):
        """Update miner statistics for thermal tracking"""
        if miner_ip not in self.thermal_states:
            logger.warning(f"Miner {miner_ip} not registered for thermal management")
            return

        state = self.thermal_states[miner_ip]
        state.update_temperature(temperature)

        if hashrate is not None:
            state.update_hashrate(hashrate)

    def calculate_optimal_frequency(self, miner_ip: str) -> Tuple[int, str]:
        """
        Calculate optimal frequency based on temperature

        Returns:
            (target_frequency, reason)
        """
        if miner_ip not in self.thermal_states:
            return (0, "Miner not registered")

        state = self.thermal_states[miner_ip]
        profile = state.profile

        # Check emergency cooldown
        if state.check_emergency_cooldown():
            return (0, "Emergency cooldown in progress")

        # Check for critical temperature - EMERGENCY SHUTDOWN
        if state.current_temp >= profile.critical_temp:
            state.trigger_emergency_shutdown()
            return (0, f"EMERGENCY: Critical temp {state.current_temp:.1f}°C >= {profile.critical_temp}°C")

        # Check if auto-tune is disabled
        if not state.auto_tune_enabled or not self.global_auto_tune_enabled:
            return (state.current_freq, "Auto-tune disabled")

        # Check if we can adjust (rate limiting)
        if not state.can_adjust_frequency():
            return (state.current_freq, "Too soon since last adjustment")

        current_freq = state.current_freq
        current_temp = state.current_temp
        target_freq = current_freq
        reason = "No change"

        # Temperature-based frequency adjustment
        if current_temp >= profile.warning_temp:
            # Too hot - reduce frequency aggressively
            reduction = profile.freq_step * 2  # Double step for warning temp
            target_freq = max(profile.min_freq, current_freq - reduction)
            reason = f"Too hot ({current_temp:.1f}°C), reducing frequency"

        elif current_temp > profile.optimal_temp + profile.temp_hysteresis:
            # Above optimal - reduce frequency
            target_freq = max(profile.min_freq, current_freq - profile.freq_step)
            reason = f"Above optimal ({current_temp:.1f}°C > {profile.optimal_temp}°C), reducing"

        elif current_temp < profile.optimal_temp - profile.temp_hysteresis:
            # Below optimal and cooling - can increase frequency
            # But only if we're not trending up rapidly
            if state.temp_trend <= 1.0:  # Not heating up too fast
                target_freq = min(profile.max_freq, current_freq + profile.freq_step)
                reason = f"Below optimal ({current_temp:.1f}°C < {profile.optimal_temp}°C), increasing"
            else:
                reason = f"Below optimal but temp rising ({state.temp_trend:.1f}°C/cycle), holding"

        else:
            # In optimal range - maintain current frequency
            reason = f"In optimal range ({current_temp:.1f}°C ≈ {profile.optimal_temp}°C)"

        # Update state if frequency changed
        if target_freq != current_freq:
            state.last_adjustment = datetime.now()
            state.current_freq = target_freq

            # Log adjustment to database
            self._log_thermal_adjustment(
                miner_ip=miner_ip,
                old_freq=current_freq,
                new_freq=target_freq,
                temperature=current_temp,
                reason=reason
            )

        return (target_freq, reason)

    def _log_thermal_adjustment(self, miner_ip: str, old_freq: int, new_freq: int,
                                temperature: float, reason: str):
        """Log frequency adjustment to database"""
        try:
            # This would go to a thermal_adjustments table
            logger.info(f"Thermal adjustment for {miner_ip}: {old_freq}MHz → {new_freq}MHz " +
                       f"(temp: {temperature:.1f}°C, reason: {reason})")
        except Exception as e:
            logger.error(f"Error logging thermal adjustment: {e}")

    def get_thermal_status(self, miner_ip: str) -> Optional[Dict]:
        """Get current thermal status for a miner"""
        if miner_ip not in self.thermal_states:
            return None

        state = self.thermal_states[miner_ip]
        profile = state.profile

        return {
            'miner_ip': miner_ip,
            'miner_type': state.miner_type,
            'current_temp': state.current_temp,
            'current_freq': state.current_freq,
            'optimal_temp': profile.optimal_temp,
            'critical_temp': profile.critical_temp,
            'temp_trend': state.temp_trend,
            'auto_tune_enabled': state.auto_tune_enabled,
            'in_cooldown': state.in_emergency_cooldown,
            'avg_temp_5min': state.get_average_temp(5),
            'freq_range': {
                'min': profile.min_freq,
                'max': profile.max_freq,
                'default': profile.default_freq
            }
        }

    def get_all_thermal_status(self) -> Dict[str, Dict]:
        """Get thermal status for all miners"""
        return {
            ip: self.get_thermal_status(ip)
            for ip in self.thermal_states.keys()
        }

    def set_auto_tune(self, miner_ip: str, enabled: bool):
        """Enable/disable auto-tune for specific miner"""
        if miner_ip in self.thermal_states:
            self.thermal_states[miner_ip].auto_tune_enabled = enabled
            logger.info(f"Auto-tune {'enabled' if enabled else 'disabled'} for {miner_ip}")

    def set_global_auto_tune(self, enabled: bool):
        """Enable/disable auto-tune globally"""
        self.global_auto_tune_enabled = enabled
        logger.info(f"Global auto-tune {'enabled' if enabled else 'disabled'}")

    def force_frequency(self, miner_ip: str, frequency: int) -> bool:
        """Force specific frequency (disables auto-tune for this miner)"""
        if miner_ip not in self.thermal_states:
            return False

        state = self.thermal_states[miner_ip]
        profile = state.profile

        # Clamp to safe range
        frequency = max(profile.min_freq, min(profile.max_freq, frequency))

        state.current_freq = frequency
        state.auto_tune_enabled = False
        logger.info(f"Forced {miner_ip} to {frequency}MHz (auto-tune disabled)")

        return True

    def reset_miner(self, miner_ip: str):
        """Reset miner to default frequency and re-enable auto-tune"""
        if miner_ip not in self.thermal_states:
            return

        state = self.thermal_states[miner_ip]
        state.current_freq = state.profile.default_freq
        state.auto_tune_enabled = True
        state.in_emergency_cooldown = False
        state.cooldown_started = None
        logger.info(f"Reset {miner_ip} to default settings")

    def get_frequency_history(self, miner_ip: str, hours: int = 24) -> List[Dict]:
        """
        Get frequency adjustment history for a miner

        Note: Currently returns current state only.
        TODO: Add frequency column to stats table to track historical frequency changes
        """
        if miner_ip not in self.thermal_states:
            return []

        state = self.thermal_states[miner_ip]

        # Return current state as a single data point
        # In production, this would query historical frequency data from database
        return [{
            'timestamp': datetime.now().isoformat(),
            'frequency': state.current_freq,
            'temperature': state.current_temp,
            'auto_tune_enabled': state.auto_tune_enabled,
            'in_emergency_cooldown': state.in_emergency_cooldown
        }]
