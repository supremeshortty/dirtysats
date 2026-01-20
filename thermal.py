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
    stock_freq: int        # Factory default frequency (MHz) - applied on connect/reboot
    optimal_temp: float    # Target optimal temperature (°C)
    warning_temp: float    # Start aggressive cooling (°C)
    critical_temp: float   # Emergency shutdown temperature (°C)
    max_chip_temp: float   # Absolute maximum chip temperature (°C)
    temp_hysteresis: float # Temperature change threshold for adjustment (°C)
    freq_step: int         # Frequency adjustment step size (MHz)


# Miner-specific thermal profiles based on comprehensive research
# Sources: solosatoshi.com, d-central.tech, mineshop.eu, zeusbtc.com, bitmain.com
#
# Key findings:
# - All BitAxe/ESP-Miner chips: safe 40-70°C, throttle at 75°C, danger >90°C
# - Smaller devices = less cooling capacity = lower optimal temp targets
# - Multi-chip devices with better cooling can sustain slightly higher temps
# - Traditional ASIC miners measure board temp, not chip temp (different scale)
#
MINER_PROFILES = {
    # =========================================================================
    # SINGLE-CHIP ESP-MINER DEVICES (BitAxe family)
    # Small 40mm heatsink + tiny fan = limited cooling capacity
    # Research: safe 40-65°C, optimal 50-70°C, throttle 75°C
    # =========================================================================

    # BitAxe (generic/original) - BM1397 from Antminer S17
    # Oldest chip, ~30 J/TH efficiency
    'BitAxe': FrequencyProfile(
        min_freq=400,
        max_freq=600,       # BM1397 is older, more conservative
        stock_freq=485,
        optimal_temp=55.0,  # Small cooler = target lower temp
        warning_temp=62.0,
        critical_temp=68.0,
        max_chip_temp=75.0,
        temp_hysteresis=2.0,
        freq_step=15
    ),

    # BitAxe Max - BM1397 from Antminer S17
    # ~30 J/TH, 400-500 GH/s stock
    'BitAxeMax': FrequencyProfile(
        min_freq=400,
        max_freq=600,
        stock_freq=485,
        optimal_temp=55.0,
        warning_temp=62.0,
        critical_temp=68.0,
        max_chip_temp=75.0,
        temp_hysteresis=2.0,
        freq_step=15
    ),

    # BitAxe Ultra - BM1366 from Antminer S19 XP
    # ~19 J/TH, 500 GH/s stock, up to 650 GH/s OC
    'BitAxeUltra': FrequencyProfile(
        min_freq=400,
        max_freq=650,
        stock_freq=490,
        optimal_temp=55.0,
        warning_temp=62.0,
        critical_temp=68.0,
        max_chip_temp=75.0,
        temp_hysteresis=2.0,
        freq_step=15
    ),

    # BitAxe Supra - BM1368 from Antminer S21
    # ~17.5 J/TH, 580 GH/s stock, up to 700 GH/s OC
    # Research: improved heat dissipation vs BM1366
    'BitAxeSupra': FrequencyProfile(
        min_freq=400,
        max_freq=700,
        stock_freq=490,
        optimal_temp=55.0,
        warning_temp=63.0,  # Slightly better heat dissipation
        critical_temp=69.0,
        max_chip_temp=75.0,
        temp_hysteresis=2.0,
        freq_step=15
    ),

    # BitAxe Gamma - BM1370 from Antminer S21 Pro
    # Most efficient at ~15 J/TH, 1.2 TH/s stock, up to 2 TH/s OC
    # Research: generates less heat per TH than older chips
    'BitAxeGamma': FrequencyProfile(
        min_freq=400,
        max_freq=750,       # Can push higher due to efficiency
        stock_freq=525,
        optimal_temp=55.0,
        warning_temp=63.0,
        critical_temp=70.0,
        max_chip_temp=75.0,
        temp_hysteresis=2.0,
        freq_step=15
    ),

    # =========================================================================
    # SINGLE-CHIP NERDAXE
    # Similar to BitAxe single-chip form factor
    # =========================================================================

    # NerdAxe - Single BM1366, similar to BitAxe Ultra
    'NerdAxe': FrequencyProfile(
        min_freq=400,
        max_freq=650,
        stock_freq=490,
        optimal_temp=55.0,
        warning_temp=62.0,
        critical_temp=68.0,
        max_chip_temp=75.0,
        temp_hysteresis=2.0,
        freq_step=15
    ),

    # =========================================================================
    # MULTI-CHIP ESP-MINER DEVICES
    # Better cooling infrastructure than single-chip devices
    # =========================================================================

    # BitAxe Hex - 6x BM1366, 3+ TH/s
    # Research: 45-55°C optimal for efficiency, better cooling than single
    'BitAxeHex': FrequencyProfile(
        min_freq=400,
        max_freq=625,
        stock_freq=500,
        optimal_temp=52.0,  # Research: 45-55°C for max efficiency
        warning_temp=60.0,
        critical_temp=68.0,
        max_chip_temp=75.0,
        temp_hysteresis=2.0,
        freq_step=15
    ),

    # NerdQAxe+ - 4x BM1366, ~2.4 TH/s
    # Research: target 48-60°C, shutdown at 75°C
    'NerdQAxe': FrequencyProfile(
        min_freq=400,
        max_freq=625,
        stock_freq=485,
        optimal_temp=55.0,  # Research: 48-60°C range
        warning_temp=63.0,
        critical_temp=70.0,
        max_chip_temp=75.0,
        temp_hysteresis=2.0,
        freq_step=15
    ),

    # NerdQAxe++ - 4x BM1370, ~4.8 TH/s
    # Research: VREG temps critical, 48°C chip with 38-40°C VR when cooled
    'NerdQAxePP': FrequencyProfile(
        min_freq=400,
        max_freq=650,
        stock_freq=490,
        optimal_temp=55.0,
        warning_temp=63.0,
        critical_temp=70.0,
        max_chip_temp=75.0,
        temp_hysteresis=2.0,
        freq_step=15
    ),

    # NerdOctaxe - 8x BM1370, ~9.6 TH/s
    # Research: stabilizes at 55°C, dual 120mm fans = best cooling
    'NerdOctaxe': FrequencyProfile(
        min_freq=400,
        max_freq=625,
        stock_freq=500,
        optimal_temp=55.0,  # Research: stabilizes at 55°C with good cooling
        warning_temp=62.0,
        critical_temp=68.0,
        max_chip_temp=70.0,
        temp_hysteresis=2.0,
        freq_step=15
    ),

    # =========================================================================
    # LUCKYMINER
    # Similar to BitAxe, ESP-Miner based
    # Research: ambient 5-45°C, optimal <30°C ambient
    # =========================================================================

    'LuckyMiner': FrequencyProfile(
        min_freq=400,
        max_freq=650,
        stock_freq=490,
        optimal_temp=55.0,
        warning_temp=62.0,
        critical_temp=68.0,
        max_chip_temp=75.0,
        temp_hysteresis=2.0,
        freq_step=15
    ),

    # =========================================================================
    # TRADITIONAL ASIC MINERS
    # NOTE: These measure PCB/board temperature, not chip junction temp
    # Much higher temp thresholds than ESP-Miner devices
    # Research: ambient 15-35°C recommended, PCB temps can be much higher
    # =========================================================================

    # Antminer S9 series - BM1387
    # Research: PCB max 85-95°C (S9i: 85°C, S9: 90°C, S9j: 95°C)
    'Antminer': FrequencyProfile(
        min_freq=550,
        max_freq=700,
        stock_freq=650,
        optimal_temp=70.0,  # PCB temp, not chip temp
        warning_temp=80.0,
        critical_temp=85.0,
        max_chip_temp=95.0,
        temp_hysteresis=3.0,
        freq_step=25
    ),

    # Whatsminer M30S/M50 series
    # Research: ambient 5-45°C, prefer <30°C, warning at 80°C
    'Whatsminer': FrequencyProfile(
        min_freq=400,
        max_freq=650,
        stock_freq=550,
        optimal_temp=65.0,  # Board temp
        warning_temp=75.0,
        critical_temp=80.0,
        max_chip_temp=85.0,
        temp_hysteresis=3.0,
        freq_step=25
    ),

    # Canaan Avalon series
    # Research: ambient -5 to 35°C, some models to 45°C
    'Avalon': FrequencyProfile(
        min_freq=400,
        max_freq=650,
        stock_freq=550,
        optimal_temp=65.0,
        warning_temp=75.0,
        critical_temp=80.0,
        max_chip_temp=85.0,
        temp_hysteresis=3.0,
        freq_step=25
    ),

    # =========================================================================
    # UNKNOWN/DEFAULT
    # Conservative settings for unidentified miners
    # =========================================================================

    'Unknown': FrequencyProfile(
        min_freq=400,
        max_freq=550,
        stock_freq=475,
        optimal_temp=55.0,
        warning_temp=62.0,
        critical_temp=68.0,
        max_chip_temp=75.0,
        temp_hysteresis=2.0,
        freq_step=10
    ),
    # Traditional ASIC miners
    'Antminer': FrequencyProfile(
        min_freq=400,
        max_freq=650,      # Conservative for S9/S17 series
        stock_freq=550,
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
        stock_freq=550,
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
        stock_freq=550,
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
        stock_freq=450,
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
        # Use config helper to map detailed type to thermal profile key
        profile_key = config.get_thermal_profile_key(miner_type)
        self.profile = MINER_PROFILES.get(profile_key, MINER_PROFILES['Unknown'])

        self.current_freq = self.profile.stock_freq
        self.current_temp = 0.0
        self.last_temp = 0.0
        self.temp_trend = 0.0  # Positive = heating, negative = cooling

        # Fan speed tracking
        self.current_fan_speed = 50  # Default 50%
        self.min_fan_speed = 20  # Minimum fan speed
        self.max_fan_speed = 100  # Maximum fan speed
        self.fan_step = 10  # Fan speed adjustment step

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

    def update_fan_speed(self, fan_speed: int):
        """Update current fan speed"""
        self.current_fan_speed = fan_speed

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

    def _get_profile(self, miner_type: str) -> FrequencyProfile:
        """Get the frequency profile for a miner type"""
        profile_key = config.get_thermal_profile_key(miner_type)
        return MINER_PROFILES.get(profile_key, MINER_PROFILES['Unknown'])

    def register_miner(self, miner_ip: str, miner_type: str):
        """Register a miner for thermal management"""
        if miner_ip not in self.thermal_states:
            self.thermal_states[miner_ip] = ThermalState(miner_ip, miner_type)
            logger.info(f"Registered {miner_ip} ({miner_type}) for thermal management")

    def get_stock_frequency(self, miner_type: str) -> int:
        """Get the stock/factory default frequency for a miner type"""
        profile = self._get_profile(miner_type)
        return profile.stock_freq

    def get_stock_settings(self, miner_type: str) -> dict:
        """
        Get stock/factory settings for a miner type.
        Returns settings dict that can be applied to the miner via apply_settings().
        """
        profile = self._get_profile(miner_type)
        return {
            'frequency': profile.stock_freq
        }

    def update_miner_stats(self, miner_ip: str, temperature: float, hashrate: float = None, fan_speed: int = None, frequency: int = None):
        """Update miner statistics for thermal tracking"""
        if miner_ip not in self.thermal_states:
            logger.warning(f"Miner {miner_ip} not registered for thermal management")
            return

        state = self.thermal_states[miner_ip]
        state.update_temperature(temperature)

        if hashrate is not None:
            state.update_hashrate(hashrate)

        # Sync actual miner frequency with thermal state
        # This ensures we don't try to "increase" frequency when already at max
        if frequency is not None and frequency > 0:
            state.current_freq = frequency

        if fan_speed is not None:
            state.update_fan_speed(fan_speed)

    def calculate_optimal_frequency(self, miner_ip: str) -> Tuple[int, Optional[int], str]:
        """
        Calculate optimal frequency and fan speed based on temperature.

        THERMAL MANAGEMENT PRIORITY:
        1. First, adjust fan speed to control temperature
        2. Only reduce frequency if fan is already at maximum
        3. This preserves hashrate while maintaining safe temperatures

        Returns:
            (target_frequency, target_fan_speed, reason)
        """
        if miner_ip not in self.thermal_states:
            return (0, None, "Miner not registered")

        state = self.thermal_states[miner_ip]
        profile = state.profile

        # Check emergency cooldown
        if state.check_emergency_cooldown():
            return (0, 100, "Emergency cooldown in progress")

        # Check for critical temperature - EMERGENCY SHUTDOWN
        if state.current_temp >= profile.critical_temp:
            state.trigger_emergency_shutdown()
            return (0, 100, f"EMERGENCY: Critical temp {state.current_temp:.1f}°C >= {profile.critical_temp}°C")

        # Check if auto-tune is disabled
        if not state.auto_tune_enabled or not self.global_auto_tune_enabled:
            return (state.current_freq, None, "Auto-tune disabled")

        # Check if we can adjust (rate limiting)
        if not state.can_adjust_frequency():
            return (state.current_freq, None, "Too soon since last adjustment")

        current_freq = state.current_freq
        current_temp = state.current_temp
        current_fan = state.current_fan_speed
        target_freq = current_freq
        target_fan = current_fan
        reason = "No change"

        # Temperature-based adjustment with FAN PRIORITY
        if current_temp >= profile.warning_temp:
            # WARNING: Very hot - max fan AND reduce frequency
            target_fan = state.max_fan_speed
            reduction = profile.freq_step * 2  # Double step for warning temp
            target_freq = max(profile.min_freq, current_freq - reduction)
            reason = f"WARNING: {current_temp:.1f}°C - max fan + reducing frequency"

        elif current_temp > profile.optimal_temp + profile.temp_hysteresis:
            # Above optimal - try increasing fan first, only reduce freq if fan maxed
            if current_fan < state.max_fan_speed:
                # Fan has room to increase - boost fan speed
                target_fan = min(state.max_fan_speed, current_fan + state.fan_step)
                reason = f"Above optimal ({current_temp:.1f}°C), increasing fan to {target_fan}%"
            else:
                # Fan already at max - must reduce frequency
                target_freq = max(profile.min_freq, current_freq - profile.freq_step)
                reason = f"Above optimal ({current_temp:.1f}°C), fan at max, reducing frequency"

        elif current_temp < profile.optimal_temp - profile.temp_hysteresis:
            # Below optimal - can reduce fan or increase frequency
            if state.temp_trend <= 1.0:  # Not heating up too fast
                if current_fan > state.min_fan_speed + 10:
                    # Can reduce fan first (keep some headroom above min)
                    target_fan = max(state.min_fan_speed, current_fan - state.fan_step)
                    reason = f"Below optimal ({current_temp:.1f}°C), reducing fan to {target_fan}%"
                elif current_freq < profile.max_freq:
                    # Fan already low and not at max frequency, can increase frequency
                    target_freq = min(profile.max_freq, current_freq + profile.freq_step)
                    reason = f"Below optimal ({current_temp:.1f}°C), increasing frequency to {target_freq}MHz"
                else:
                    # Already at max frequency and fan is low - optimal state
                    reason = f"Below optimal ({current_temp:.1f}°C), already at max frequency ({profile.max_freq}MHz)"
            else:
                reason = f"Below optimal but temp rising ({state.temp_trend:.1f}°C/cycle), holding"

        else:
            # In optimal range - maintain current settings
            reason = f"In optimal range ({current_temp:.1f}°C ≈ {profile.optimal_temp}°C)"

        # Update state if anything changed
        changed = False
        if target_freq != current_freq:
            state.current_freq = target_freq
            changed = True
        if target_fan != current_fan:
            state.current_fan_speed = target_fan
            changed = True

        if changed:
            state.last_adjustment = datetime.now()
            # Log adjustment to database
            self._log_thermal_adjustment(
                miner_ip=miner_ip,
                old_freq=current_freq,
                new_freq=target_freq,
                temperature=current_temp,
                reason=reason
            )

        return (target_freq, target_fan if target_fan != current_fan else None, reason)

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
                'stock': profile.stock_freq
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
        state.current_freq = state.profile.stock_freq
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
