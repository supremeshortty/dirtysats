"""
Weather Integration Module

Predict thermal issues before they happen using weather forecasts.
Pre-cool miners before heat waves, adjust schedules based on temperature predictions.
"""
import logging
import requests
from datetime import datetime, timedelta
from typing import Dict, Optional, List
import config

logger = logging.getLogger(__name__)


class WeatherForecast:
    """Weather forecast data"""
    def __init__(self, timestamp: datetime, temp_f: float, temp_c: float,
                 humidity: float, description: str):
        self.timestamp = timestamp
        self.temp_f = temp_f
        self.temp_c = temp_c
        self.humidity = humidity
        self.description = description

    def to_dict(self):
        return {
            'timestamp': self.timestamp.isoformat(),
            'temp_f': self.temp_f,
            'temp_c': self.temp_c,
            'humidity': self.humidity,
            'description': self.description
        }


class WeatherManager:
    """Manage weather data and predictions"""

    def __init__(self, db):
        self.db = db
        self.api_key = None
        self.location = None
        self.latitude = None
        self.longitude = None

        # Cache
        self.current_weather = None
        self.forecast = []
        self.last_update = None
        self.cache_duration = timedelta(minutes=30)

        # Load configuration from database
        self._load_config_from_db()

    def _load_config_from_db(self):
        """Load weather configuration from database"""
        config = self.db.get_weather_config()
        if config:
            self.api_key = config.get('api_key')
            self.location = config.get('location')
            self.latitude = config.get('latitude')
            self.longitude = config.get('longitude')
            logger.info("Loaded weather configuration from database")

    def configure(self, api_key: str, location: str = None,
                  latitude: float = None, longitude: float = None):
        """
        Configure weather API

        Args:
            api_key: OpenWeatherMap API key (free tier available)
            location: City name (e.g., "San Francisco,US")
            latitude/longitude: Alternative to location
        """
        self.api_key = api_key
        self.location = location
        self.latitude = latitude
        self.longitude = longitude

        # Save to database for persistence
        self.db.save_weather_config(api_key, location, latitude, longitude)

        logger.info(f"Weather configured for {location or f'{latitude},{longitude}'}")

    def _should_update_cache(self) -> bool:
        """Check if cache should be updated"""
        if self.last_update is None:
            return True
        return datetime.now() - self.last_update > self.cache_duration

    def get_current_weather(self) -> Optional[Dict]:
        """Get current weather conditions"""
        if not self._should_update_cache() and self.current_weather:
            return self.current_weather

        if not self.api_key:
            logger.warning("Weather API key not configured")
            return None

        try:
            # OpenWeatherMap current weather API
            url = "https://api.openweathermap.org/data/2.5/weather"
            params = {'appid': self.api_key, 'units': 'imperial'}

            if self.latitude and self.longitude:
                params['lat'] = self.latitude
                params['lon'] = self.longitude
            elif self.location:
                params['q'] = self.location
            else:
                logger.error("No location configured for weather")
                return None

            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            data = response.json()

            # Extract relevant data
            self.current_weather = {
                'temp_f': data['main']['temp'],
                'temp_c': (data['main']['temp'] - 32) * 5/9,
                'feels_like_f': data['main']['feels_like'],
                'humidity': data['main']['humidity'],
                'description': data['weather'][0]['description'],
                'wind_speed': data['wind']['speed'],
                'timestamp': datetime.now().isoformat()
            }

            self.last_update = datetime.now()
            logger.info(f"Weather updated: {self.current_weather['temp_f']:.1f}°F, " +
                       f"{self.current_weather['description']}")

            return self.current_weather

        except Exception as e:
            logger.error(f"Error fetching weather: {e}")
            return self.current_weather  # Return cached if available

    def get_forecast(self, hours: int = 24) -> List[WeatherForecast]:
        """
        Get weather forecast

        Args:
            hours: Number of hours to forecast (default 24)

        Returns:
            List of WeatherForecast objects
        """
        if not self._should_update_cache() and self.forecast:
            return self.forecast[:hours//3]  # 3-hour intervals

        if not self.api_key:
            logger.warning("Weather API key not configured")
            return []

        try:
            # OpenWeatherMap forecast API (3-hour intervals, 5 days)
            url = "https://api.openweathermap.org/data/2.5/forecast"
            params = {'appid': self.api_key, 'units': 'imperial'}

            if self.latitude and self.longitude:
                params['lat'] = self.latitude
                params['lon'] = self.longitude
            elif self.location:
                params['q'] = self.location
            else:
                logger.error("No location configured for weather")
                return []

            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            data = response.json()

            # Parse forecast
            self.forecast = []
            for item in data['list']:
                timestamp = datetime.fromtimestamp(item['dt'])
                temp_f = item['main']['temp']
                temp_c = (temp_f - 32) * 5/9
                humidity = item['main']['humidity']
                description = item['weather'][0]['description']

                self.forecast.append(WeatherForecast(
                    timestamp=timestamp,
                    temp_f=temp_f,
                    temp_c=temp_c,
                    humidity=humidity,
                    description=description
                ))

            self.last_update = datetime.now()
            logger.info(f"Forecast updated: {len(self.forecast)} periods")

            return self.forecast[:hours//3]

        except Exception as e:
            logger.error(f"Error fetching forecast: {e}")
            return self.forecast[:hours//3] if self.forecast else []

    def predict_thermal_issues(self, current_ambient: float,
                               miner_temp_delta: float = 35.0) -> Dict:
        """
        Predict thermal issues based on weather forecast

        Args:
            current_ambient: Current ambient temperature (°F)
            miner_temp_delta: Typical delta from ambient to miner temp (°F)

        Returns:
            Prediction dict with warnings and recommendations
        """
        forecast = self.get_forecast(hours=24)

        if not forecast:
            return {'warning': False, 'message': 'No forecast available'}

        # Find max temperature in next 24 hours
        max_temp = max(f.temp_f for f in forecast)
        max_temp_time = next(f for f in forecast if f.temp_f == max_temp).timestamp

        # Estimate miner temperature at peak
        estimated_miner_temp_f = max_temp + miner_temp_delta
        estimated_miner_temp_c = (estimated_miner_temp_f - 32) * 5/9

        # Temperature thresholds
        warning_temp_f = 85  # Ambient temp that causes concern
        critical_temp_f = 95  # Ambient temp that will cause issues

        prediction = {
            'current_ambient_f': current_ambient,
            'forecast_max_f': max_temp,
            'forecast_max_time': max_temp_time.strftime('%Y-%m-%d %H:%M'),
            'estimated_miner_temp_f': estimated_miner_temp_f,
            'estimated_miner_temp_c': estimated_miner_temp_c,
            'warning': False,
            'critical': False,
            'message': '',
            'recommendations': []
        }

        if max_temp >= critical_temp_f:
            prediction['critical'] = True
            prediction['warning'] = True
            prediction['message'] = (
                f"CRITICAL: Forecast shows {max_temp:.1f}°F at " +
                f"{max_temp_time.strftime('%I:%M %p')}. " +
                f"Miners may reach {estimated_miner_temp_c:.1f}°C!"
            )
            prediction['recommendations'] = [
                "Consider stopping mining during peak heat",
                "Reduce frequency preemptively",
                "Improve cooling/ventilation NOW",
                "Monitor temperature closely"
            ]

        elif max_temp >= warning_temp_f:
            prediction['warning'] = True
            prediction['message'] = (
                f"WARNING: Forecast shows {max_temp:.1f}°F at " +
                f"{max_temp_time.strftime('%I:%M %p')}. " +
                f"Miners may reach {estimated_miner_temp_c:.1f}°C"
            )
            prediction['recommendations'] = [
                "Reduce frequency before peak heat",
                "Ensure adequate ventilation",
                "Monitor temperature during peak hours"
            ]

        else:
            prediction['message'] = (
                f"No thermal issues predicted. Max forecast: {max_temp:.1f}°F"
            )

        return prediction

    def get_optimal_mining_hours(self, hours: int = 24,
                                 max_ambient_f: float = 80.0) -> List[Dict]:
        """
        Find optimal mining hours based on temperature forecast

        Args:
            hours: Hours to analyze
            max_ambient_f: Maximum acceptable ambient temperature

        Returns:
            List of time periods suitable for mining
        """
        forecast = self.get_forecast(hours=hours)

        if not forecast:
            return []

        optimal_periods = []
        current_period = None

        for f in forecast:
            if f.temp_f <= max_ambient_f:
                if current_period is None:
                    # Start new period
                    current_period = {
                        'start': f.timestamp,
                        'end': f.timestamp,
                        'avg_temp_f': f.temp_f,
                        'count': 1
                    }
                else:
                    # Extend current period
                    current_period['end'] = f.timestamp
                    current_period['avg_temp_f'] = (
                        (current_period['avg_temp_f'] * current_period['count'] + f.temp_f) /
                        (current_period['count'] + 1)
                    )
                    current_period['count'] += 1
            else:
                if current_period is not None:
                    # End current period
                    optimal_periods.append({
                        'start': current_period['start'].strftime('%Y-%m-%d %H:%M'),
                        'end': current_period['end'].strftime('%Y-%m-%d %H:%M'),
                        'duration_hours': current_period['count'] * 3,
                        'avg_temp_f': current_period['avg_temp_f']
                    })
                    current_period = None

        # Add final period if exists
        if current_period is not None:
            optimal_periods.append({
                'start': current_period['start'].strftime('%Y-%m-%d %H:%M'),
                'end': current_period['end'].strftime('%Y-%m-%d %H:%M'),
                'duration_hours': current_period['count'] * 3,
                'avg_temp_f': current_period['avg_temp_f']
            })

        return optimal_periods

    def should_precool(self, current_temp_c: float, lookahead_hours: int = 6) -> bool:
        """
        Determine if miners should be pre-cooled before heat wave

        Args:
            current_temp_c: Current miner temperature (°C)
            lookahead_hours: How far ahead to look

        Returns:
            True if should reduce frequency to pre-cool
        """
        forecast = self.get_forecast(hours=lookahead_hours)

        if not forecast:
            return False

        # Check if temperature is rising significantly
        future_temps = [f.temp_f for f in forecast]
        current_ambient = self.get_current_weather()

        if not current_ambient:
            return False

        current_ambient_f = current_ambient['temp_f']
        max_future_f = max(future_temps)

        # If temp will rise >10°F in next period, pre-cool
        temp_rise = max_future_f - current_ambient_f

        if temp_rise > 10 and current_temp_c < 65:
            logger.info(f"Pre-cooling recommended: temp will rise {temp_rise:.1f}°F")
            return True

        return False
