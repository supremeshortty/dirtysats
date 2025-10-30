// Mining Fleet Manager Dashboard
const API_BASE = '';
const UPDATE_INTERVAL = 5000; // 5 seconds

let updateTimer = null;
let currentTab = 'fleet';

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
    initializeTabs();
    loadDashboard();
    startAutoRefresh();

    // Discovery button
    document.getElementById('discover-btn').addEventListener('click', discoverMiners);

    // Energy config form
    document.getElementById('energy-config-form').addEventListener('submit', applyEnergyPreset);

    // Mining schedule form
    document.getElementById('mining-schedule-form').addEventListener('submit', createMiningSchedule);
});

// Tab Management
function initializeTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.getAttribute('data-tab');
            switchTab(tab);
        });
    });
}

function switchTab(tabName) {
    // Update buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-tab') === tabName) {
            btn.classList.add('active');
        }
    });

    // Update content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');

    currentTab = tabName;

    // Load tab-specific data
    if (tabName === 'energy') {
        loadEnergyTab();
    } else if (tabName === 'charts') {
        loadChartsTab();
    } else if (tabName === 'alerts') {
        loadAlertsTab();
    } else if (tabName === 'weather') {
        loadWeatherTab();
    } else if (tabName === 'fleet') {
        loadDashboard();
    }
}

// Load all dashboard data
async function loadDashboard() {
    try {
        await Promise.all([
            loadStats(),
            loadMiners()
        ]);
        updateLastUpdateTime();
    } catch (error) {
        console.error('Error loading dashboard:', error);
        showAlert('Error loading dashboard data', 'error');
    }
}

// Load fleet statistics
async function loadStats() {
    try {
        const response = await fetch(`${API_BASE}/api/stats`);
        const data = await response.json();

        if (data.success) {
            const stats = data.stats;
            document.getElementById('total-miners').textContent = stats.total_miners;
            document.getElementById('online-miners').textContent = stats.online_miners;
            document.getElementById('offline-miners').textContent = stats.offline_miners;
            document.getElementById('total-hashrate').textContent = formatHashrate(stats.total_hashrate);
            document.getElementById('total-power').textContent = `${stats.total_power.toFixed(1)} W`;
            document.getElementById('avg-temp').textContent = `${stats.avg_temperature.toFixed(1)}°C`;
        }
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// Load miners list
async function loadMiners() {
    try {
        const response = await fetch(`${API_BASE}/api/miners`);
        const data = await response.json();

        if (data.success) {
            displayMiners(data.miners);
        }
    } catch (error) {
        console.error('Error loading miners:', error);
    }
}

// Display miners in grid
function displayMiners(miners) {
    const container = document.getElementById('miners-container');

    if (miners.length === 0) {
        container.innerHTML = '<p class="no-miners">No miners found. Click "Discover Miners" to scan your network.</p>';
        return;
    }

    const minersHTML = miners.map(miner => createMinerCard(miner)).join('');
    container.innerHTML = `<div class="miners-grid">${minersHTML}</div>`;

    // Attach event listeners for actions
    miners.forEach(miner => {
        const deleteBtn = document.getElementById(`delete-${miner.ip}`);
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => deleteMiner(miner.ip));
        }

        const restartBtn = document.getElementById(`restart-${miner.ip}`);
        if (restartBtn) {
            restartBtn.addEventListener('click', () => restartMiner(miner.ip));
        }
    });
}

// Create HTML for single miner card
function createMinerCard(miner) {
    const status = miner.last_status || {};
    const isOnline = status.status === 'online';
    const offlineClass = isOnline ? '' : 'offline';

    return `
        <div class="miner-card ${offlineClass}">
            <div class="miner-header">
                <div class="miner-title">${miner.model || miner.type}</div>
                <div class="miner-type">${miner.type}</div>
            </div>
            <div class="miner-ip">${miner.ip}</div>

            ${isOnline ? `
                <div class="miner-stats">
                    <div class="miner-stat">
                        <span class="miner-stat-label">Hashrate</span>
                        <span class="miner-stat-value">${formatHashrate(status.hashrate)}</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Temperature</span>
                        <span class="miner-stat-value">${status.temperature?.toFixed(1) || 'N/A'}°C</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Power</span>
                        <span class="miner-stat-value">${status.power?.toFixed(1) || 'N/A'} W</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Fan Speed</span>
                        <span class="miner-stat-value">${status.fan_speed || 'N/A'}</span>
                    </div>
                </div>
            ` : `
                <div class="status-offline" style="text-align: center; padding: 20px;">
                    ⚠️ Offline
                </div>
            `}

            <div class="miner-actions">
                <button id="restart-${miner.ip}" class="btn btn-primary" ${!isOnline ? 'disabled' : ''}>
                    Restart
                </button>
                <button id="delete-${miner.ip}" class="btn btn-danger">
                    Remove
                </button>
            </div>
        </div>
    `;
}

// Format hashrate to human-readable
function formatHashrate(hashrate) {
    if (!hashrate) return '0 H/s';

    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    let value = hashrate;
    let unitIndex = 0;

    while (value >= 1000 && unitIndex < units.length - 1) {
        value /= 1000;
        unitIndex++;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
}

// Discover miners
async function discoverMiners() {
    const btn = document.getElementById('discover-btn');
    btn.disabled = true;
    btn.textContent = 'Discovering...';

    showAlert('Scanning network for miners... This may take up to 60 seconds.', 'success');

    try {
        const response = await fetch(`${API_BASE}/api/discover`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (data.success) {
            showAlert(`Discovery complete! Found ${data.discovered} new miners.`, 'success');
            loadDashboard();
        } else {
            showAlert(`Discovery failed: ${data.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Discovery error: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Discover Miners';
    }
}

// Restart miner
async function restartMiner(ip) {
    if (!confirm(`Restart miner at ${ip}?`)) return;

    try {
        const response = await fetch(`${API_BASE}/api/miner/${ip}/restart`, {
            method: 'POST'
        });

        const data = await response.json();

        if (data.success) {
            showAlert(`Restart command sent to ${ip}`, 'success');
        } else {
            showAlert(`Failed to restart ${ip}: ${data.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error restarting ${ip}: ${error.message}`, 'error');
    }
}

// Delete miner
async function deleteMiner(ip) {
    if (!confirm(`Remove miner ${ip} from fleet?`)) return;

    try {
        const response = await fetch(`${API_BASE}/api/miner/${ip}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            showAlert(`Miner ${ip} removed`, 'success');
            loadDashboard();
        } else {
            showAlert(`Failed to remove ${ip}: ${data.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error removing ${ip}: ${error.message}`, 'error');
    }
}

// ========== ENERGY TAB FUNCTIONS ==========

async function loadEnergyTab() {
    await Promise.all([
        loadEnergyRates(),
        loadProfitability(),
        loadEnergyConsumption()
    ]);
}

// Apply energy preset
async function applyEnergyPreset(e) {
    e.preventDefault();

    const preset = document.getElementById('energy-company').value;
    const location = document.getElementById('location').value;

    if (!preset) {
        showAlert('Please select an energy company', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/energy/rates`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ preset: preset })
        });

        const data = await response.json();

        if (data.success) {
            showAlert(data.message, 'success');
            loadEnergyTab();
        } else {
            showAlert(`Error: ${data.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error applying preset: ${error.message}`, 'error');
    }
}

// Load energy rates
async function loadEnergyRates() {
    try {
        const response = await fetch(`${API_BASE}/api/energy/rates`);
        const data = await response.json();

        if (data.success) {
            document.getElementById('current-rate').textContent =
                `$${data.current_rate.toFixed(3)}/kWh`;

            // Display rate schedule
            displayRateSchedule(data.rates);
        }
    } catch (error) {
        console.error('Error loading energy rates:', error);
    }
}

// Display rate schedule
function displayRateSchedule(rates) {
    const container = document.getElementById('rate-schedule-container');

    if (rates.length === 0) {
        container.innerHTML = '<p class="loading">No rate schedule configured. Apply a preset above.</p>';
        return;
    }

    const tableHTML = `
        <div class="rate-table">
            <table>
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Rate</th>
                        <th>Type</th>
                    </tr>
                </thead>
                <tbody>
                    ${rates.map(rate => `
                        <tr>
                            <td>${rate.start_time} - ${rate.end_time}</td>
                            <td>$${rate.rate_per_kwh.toFixed(3)}/kWh</td>
                            <td><span class="rate-type ${rate.rate_type}">${rate.rate_type}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;

    container.innerHTML = tableHTML;
}

// Load profitability
async function loadProfitability() {
    try {
        const response = await fetch(`${API_BASE}/api/energy/profitability`);
        const data = await response.json();

        if (data.success) {
            displayProfitability(data.profitability);
        }
    } catch (error) {
        console.error('Error loading profitability:', error);
    }
}

// Display profitability
function displayProfitability(prof) {
    const container = document.getElementById('profitability-container');

    if (prof.error) {
        container.innerHTML = `<p class="loading">${prof.error}</p>`;
        return;
    }

    const isProfitable = prof.profit_per_day > 0;
    const profitClass = isProfitable ? 'positive' : 'negative';

    const html = `
        <div class="profitability-card">
            <div class="profitability-grid">
                <div class="profit-item">
                    <span class="profit-label">BTC Price</span>
                    <span class="profit-value">$${prof.btc_price.toLocaleString()}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">BTC Per Day</span>
                    <span class="profit-value">${prof.btc_per_day.toFixed(8)} BTC</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Revenue Per Day</span>
                    <span class="profit-value">$${prof.revenue_per_day.toFixed(2)}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Energy Cost Per Day</span>
                    <span class="profit-value">$${prof.energy_cost_per_day.toFixed(2)}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Profit Per Day</span>
                    <span class="profit-value ${profitClass}">$${prof.profit_per_day.toFixed(2)}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Profit Margin</span>
                    <span class="profit-value ${profitClass}">${prof.profit_margin.toFixed(1)}%</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Break-Even BTC Price</span>
                    <span class="profit-value">$${prof.break_even_btc_price.toLocaleString()}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Status</span>
                    <span class="profit-value ${profitClass}">
                        ${isProfitable ? '✓ Profitable' : '✗ Not Profitable'}
                    </span>
                </div>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

// Load energy consumption
async function loadEnergyConsumption() {
    try {
        const response = await fetch(`${API_BASE}/api/energy/consumption?hours=24`);
        const data = await response.json();

        if (data.success) {
            document.getElementById('energy-today').textContent =
                `${data.total_kwh.toFixed(2)} kWh`;
            document.getElementById('cost-today').textContent =
                `$${data.total_cost.toFixed(2)}`;
        }
    } catch (error) {
        console.error('Error loading energy consumption:', error);
    }
}

// Create mining schedule
async function createMiningSchedule(e) {
    e.preventDefault();

    const maxRate = parseFloat(document.getElementById('max-rate-threshold').value);
    const highRateFreq = parseInt(document.getElementById('high-rate-frequency').value);
    const lowRateFreq = parseInt(document.getElementById('low-rate-frequency').value);

    try {
        const response = await fetch(`${API_BASE}/api/energy/schedule`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                auto_from_rates: true,
                max_rate_threshold: maxRate,
                low_frequency: highRateFreq,
                high_frequency: lowRateFreq
            })
        });

        const data = await response.json();

        if (data.success) {
            showAlert(data.message, 'success');
        } else {
            showAlert(`Error: ${data.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error creating schedule: ${error.message}`, 'error');
    }
}

// Show alert message
function showAlert(message, type) {
    const alert = document.getElementById('alert-box');
    alert.textContent = message;
    alert.className = `alert ${type}`;
    alert.style.display = 'block';

    setTimeout(() => {
        alert.style.display = 'none';
    }, 5000);
}

// Auto-refresh
function startAutoRefresh() {
    updateTimer = setInterval(() => {
        if (currentTab === 'fleet') {
            loadDashboard();
        } else if (currentTab === 'energy') {
            loadEnergyTab();
        }
    }, UPDATE_INTERVAL);
}

function updateLastUpdateTime() {
    const now = new Date().toLocaleTimeString();
    document.getElementById('last-update').textContent = `Last update: ${now}`;
}

// ============================================================================
// PHASE 4: CHARTS, ALERTS, AND WEATHER
// ============================================================================

// Chart instances
let temperatureChart = null;
let hashrateChart = null;
let powerChart = null;
let profitabilityChart = null;

// Load Charts Tab
async function loadChartsTab() {
    const hours = parseInt(document.getElementById('chart-time-range').value);
    await loadTemperatureChart(hours);
    await loadHashrateChart(hours);
    await loadPowerChart(hours);
    await loadProfitabilityChart();
}

// Load Temperature Chart
async function loadTemperatureChart(hours = 24) {
    try {
        const response = await fetch(`${API_BASE}/api/history/temperature?hours=${hours}`);
        const result = await response.json();

        if (!result.success) {
            console.error('Error loading temperature history:', result.error);
            return;
        }

        const ctx = document.getElementById('temperature-chart').getContext('2d');

        // Group data by miner IP
        const minerData = {};
        result.data.forEach(point => {
            if (!minerData[point.miner_ip]) {
                minerData[point.miner_ip] = {
                    labels: [],
                    data: []
                };
            }
            minerData[point.miner_ip].labels.push(new Date(point.timestamp));
            minerData[point.miner_ip].data.push(point.temperature);
        });

        // Create datasets
        const datasets = Object.keys(minerData).map((ip, index) => {
            const colors = ['#4CAF50', '#2196F3', '#ff9800', '#f44336', '#9c27b0'];
            return {
                label: ip,
                data: minerData[ip].labels.map((time, i) => ({
                    x: time,
                    y: minerData[ip].data[i]
                })),
                borderColor: colors[index % colors.length],
                backgroundColor: colors[index % colors.length] + '20',
                tension: 0.4
            };
        });

        // Destroy existing chart
        if (temperatureChart) {
            temperatureChart.destroy();
        }

        // Create new chart
        temperatureChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: { color: '#fff' }
                    },
                    title: {
                        display: false
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: hours <= 24 ? 'hour' : 'day'
                        },
                        ticks: { color: '#888' },
                        grid: { color: '#333' }
                    },
                    y: {
                        beginAtZero: false,
                        title: {
                            display: true,
                            text: 'Temperature (°C)',
                            color: '#888'
                        },
                        ticks: { color: '#888' },
                        grid: { color: '#333' }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error loading temperature chart:', error);
    }
}

// Load Hashrate Chart
async function loadHashrateChart(hours = 24) {
    try {
        const response = await fetch(`${API_BASE}/api/history/hashrate?hours=${hours}`);
        const result = await response.json();

        if (!result.success) {
            console.error('Error loading hashrate history:', result.error);
            return;
        }

        const ctx = document.getElementById('hashrate-chart').getContext('2d');

        // Prepare data
        const labels = result.data.map(point => new Date(point.timestamp));
        const data = result.data.map(point => point.hashrate_ths);

        // Destroy existing chart
        if (hashrateChart) {
            hashrateChart.destroy();
        }

        // Create new chart
        hashrateChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Total Hashrate (TH/s)',
                    data,
                    borderColor: '#4CAF50',
                    backgroundColor: '#4CAF5020',
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: { color: '#fff' }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: hours <= 24 ? 'hour' : 'day'
                        },
                        ticks: { color: '#888' },
                        grid: { color: '#333' }
                    },
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Hashrate (TH/s)',
                            color: '#888'
                        },
                        ticks: { color: '#888' },
                        grid: { color: '#333' }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error loading hashrate chart:', error);
    }
}

// Load Power Chart
async function loadPowerChart(hours = 24) {
    try {
        const response = await fetch(`${API_BASE}/api/history/power?hours=${hours}`);
        const result = await response.json();

        if (!result.success) {
            console.error('Error loading power history:', result.error);
            return;
        }

        const ctx = document.getElementById('power-chart').getContext('2d');

        // Prepare data
        const labels = result.data.map(point => new Date(point.timestamp));
        const data = result.data.map(point => point.power);

        // Destroy existing chart
        if (powerChart) {
            powerChart.destroy();
        }

        // Create new chart
        powerChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Total Power (W)',
                    data,
                    borderColor: '#ff9800',
                    backgroundColor: '#ff980020',
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: { color: '#fff' }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: hours <= 24 ? 'hour' : 'day'
                        },
                        ticks: { color: '#888' },
                        grid: { color: '#333' }
                    },
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Power (W)',
                            color: '#888'
                        },
                        ticks: { color: '#888' },
                        grid: { color: '#333' }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error loading power chart:', error);
    }
}

// Load Profitability Chart
async function loadProfitabilityChart() {
    try {
        const response = await fetch(`${API_BASE}/api/energy/profitability/history?days=7`);
        const result = await response.json();

        if (!result.success) {
            console.error('Error loading profitability history:', result.error);
            return;
        }

        const ctx = document.getElementById('profitability-chart').getContext('2d');

        // Prepare data
        const labels = result.history.map(point => new Date(point.timestamp));
        const profitData = result.history.map(point => point.profit_per_day);

        // Destroy existing chart
        if (profitabilityChart) {
            profitabilityChart.destroy();
        }

        // Create new chart
        profitabilityChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Profit per Day (USD)',
                    data: profitData,
                    borderColor: '#4CAF50',
                    backgroundColor: '#4CAF5020',
                    fill: true,
                    tension: 0.4,
                    segment: {
                        borderColor: ctx => {
                            const value = ctx.p1.parsed.y;
                            return value >= 0 ? '#4CAF50' : '#f44336';
                        },
                        backgroundColor: ctx => {
                            const value = ctx.p1.parsed.y;
                            return value >= 0 ? '#4CAF5020' : '#f4433620';
                        }
                    }
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        labels: { color: '#fff' }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'day'
                        },
                        ticks: { color: '#888' },
                        grid: { color: '#333' }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Profit (USD/day)',
                            color: '#888'
                        },
                        ticks: { color: '#888' },
                        grid: { color: '#333' }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error loading profitability chart:', error);
    }
}

// Load Alerts Tab
async function loadAlertsTab() {
    await loadAlertHistory();
}

// Load Alert History
async function loadAlertHistory() {
    try {
        const response = await fetch(`${API_BASE}/api/alerts/history?hours=24`);
        const result = await response.json();

        const container = document.getElementById('alert-history-container');

        if (!result.success) {
            container.innerHTML = '<p class="loading">Error loading alert history</p>';
            return;
        }

        if (result.alerts.length === 0) {
            container.innerHTML = '<p class="loading">No recent alerts</p>';
            return;
        }

        let html = '';
        result.alerts.forEach(alert => {
            const time = new Date(alert.timestamp).toLocaleString();
            html += `
                <div class="alert-item ${alert.level}">
                    <div class="alert-item-header">
                        <div class="alert-item-title">${alert.title || 'Alert'}</div>
                        <div class="alert-item-time">${time}</div>
                    </div>
                    <div class="alert-item-message">${alert.message}</div>
                    <span class="alert-item-level ${alert.level}">${alert.level.toUpperCase()}</span>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (error) {
        console.error('Error loading alert history:', error);
    }
}

// Test Alert
async function testAlert() {
    try {
        const response = await fetch(`${API_BASE}/api/alerts/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        const result = await response.json();

        if (result.success) {
            showAlert('Test alert sent!', 'success');
        } else {
            showAlert(`Error: ${result.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error sending test alert: ${error.message}`, 'error');
    }
}

// Load Weather Tab
async function loadWeatherTab() {
    await loadCurrentWeather();
    await loadWeatherForecast();
    await loadThermalPrediction();
    await loadOptimalHours();
}

// Load Current Weather
async function loadCurrentWeather() {
    try {
        const response = await fetch(`${API_BASE}/api/weather/current`);
        const result = await response.json();

        const container = document.getElementById('current-weather-container');

        if (!result.success) {
            container.innerHTML = '<p class="loading">Weather not configured or unavailable</p>';
            return;
        }

        const weather = result.weather;
        container.innerHTML = `
            <div class="weather-card">
                <div class="weather-stat">
                    <div class="weather-stat-label">Temperature</div>
                    <div class="weather-stat-value">${weather.temp_f.toFixed(1)}°F</div>
                    <div class="weather-stat-description">${weather.temp_c.toFixed(1)}°C</div>
                </div>
                <div class="weather-stat">
                    <div class="weather-stat-label">Feels Like</div>
                    <div class="weather-stat-value">${weather.feels_like_f.toFixed(1)}°F</div>
                </div>
                <div class="weather-stat">
                    <div class="weather-stat-label">Humidity</div>
                    <div class="weather-stat-value">${weather.humidity}%</div>
                </div>
                <div class="weather-stat">
                    <div class="weather-stat-label">Conditions</div>
                    <div class="weather-stat-description">${weather.description}</div>
                </div>
            </div>
        `;
    } catch (error) {
        console.error('Error loading current weather:', error);
    }
}

// Load Weather Forecast
async function loadWeatherForecast() {
    try {
        const response = await fetch(`${API_BASE}/api/weather/forecast?hours=24`);
        const result = await response.json();

        const container = document.getElementById('weather-forecast-container');

        if (!result.success) {
            container.innerHTML = '<p class="loading">No forecast available</p>';
            return;
        }

        let html = '<div class="forecast-grid">';
        result.forecast.slice(0, 8).forEach(forecast => {
            const time = new Date(forecast.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            html += `
                <div class="forecast-item">
                    <div class="forecast-time">${time}</div>
                    <div class="forecast-temp">${forecast.temp_f.toFixed(0)}°F</div>
                    <div class="forecast-desc">${forecast.description}</div>
                </div>
            `;
        });
        html += '</div>';
        container.innerHTML = html;
    } catch (error) {
        console.error('Error loading weather forecast:', error);
    }
}

// Load Thermal Prediction
async function loadThermalPrediction() {
    try {
        const response = await fetch(`${API_BASE}/api/weather/prediction`);
        const result = await response.json();

        const container = document.getElementById('thermal-prediction-container');

        if (!result.success) {
            container.innerHTML = '<p class="loading">No prediction available</p>';
            return;
        }

        const pred = result.prediction;
        const levelClass = pred.critical ? 'critical' : (pred.warning ? 'warning' : '');

        let html = `
            <div class="prediction-card ${levelClass}">
                <div class="prediction-message">${pred.message}</div>
                <div class="prediction-details">
                    <div class="prediction-detail">
                        <div class="prediction-detail-label">Current Ambient</div>
                        <div class="prediction-detail-value">${pred.current_ambient_f.toFixed(1)}°F</div>
                    </div>
                    <div class="prediction-detail">
                        <div class="prediction-detail-label">Forecast Max</div>
                        <div class="prediction-detail-value">${pred.forecast_max_f.toFixed(1)}°F</div>
                    </div>
                    <div class="prediction-detail">
                        <div class="prediction-detail-label">Estimated Miner Temp</div>
                        <div class="prediction-detail-value">${pred.estimated_miner_temp_c.toFixed(1)}°C</div>
                    </div>
                </div>
        `;

        if (pred.recommendations && pred.recommendations.length > 0) {
            html += `
                <div class="recommendations-list">
                    <h4>Recommendations</h4>
                    <ul>
                        ${pred.recommendations.map(rec => `<li>${rec}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        html += '</div>';
        container.innerHTML = html;
    } catch (error) {
        console.error('Error loading thermal prediction:', error);
    }
}

// Load Optimal Hours
async function loadOptimalHours() {
    try {
        const response = await fetch(`${API_BASE}/api/weather/optimal-hours?hours=24&max_temp_f=80`);
        const result = await response.json();

        const container = document.getElementById('optimal-hours-container');

        if (!result.success || result.optimal_periods.length === 0) {
            container.innerHTML = '<p class="loading">No optimal periods found</p>';
            return;
        }

        let html = '<div class="optimal-hours-grid">';
        result.optimal_periods.forEach(period => {
            html += `
                <div class="optimal-period">
                    <div class="optimal-period-time">${period.start} - ${period.end}</div>
                    <div class="optimal-period-duration">${period.duration_hours} hours</div>
                    <div class="optimal-period-temp">Avg: ${period.avg_temp_f.toFixed(1)}°F</div>
                </div>
            `;
        });
        html += '</div>';
        container.innerHTML = html;
    } catch (error) {
        console.error('Error loading optimal hours:', error);
    }
}

// Event Listeners for Phase 4 features
document.getElementById('refresh-charts-btn')?.addEventListener('click', loadChartsTab);
document.getElementById('chart-time-range')?.addEventListener('change', loadChartsTab);
document.getElementById('test-email-btn')?.addEventListener('click', testAlert);
document.getElementById('test-discord-btn')?.addEventListener('click', testAlert);
document.getElementById('test-slack-btn')?.addEventListener('click', testAlert);
document.getElementById('test-telegram-btn')?.addEventListener('click', testAlert);

// Telegram configuration form
document.getElementById('telegram-alert-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const botToken = document.getElementById('telegram-bot-token').value;
    const chatId = document.getElementById('telegram-chat-id').value;

    try {
        const response = await fetch(`${API_BASE}/api/alerts/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                telegram: {
                    enabled: true,
                    bot_token: botToken,
                    chat_id: chatId
                }
            })
        });

        const result = await response.json();
        if (result.success) {
            showAlert('Telegram configuration saved!', 'success');
        } else {
            showAlert(`Error: ${result.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error saving Telegram config: ${error.message}`, 'error');
    }
});

// Update auto-refresh to include new tabs
const originalStartAutoRefresh = startAutoRefresh;
startAutoRefresh = function() {
    updateTimer = setInterval(() => {
        if (currentTab === 'fleet') {
            loadDashboard();
        } else if (currentTab === 'energy') {
            loadEnergyTab();
        } else if (currentTab === 'charts') {
            loadChartsTab();
        } else if (currentTab === 'alerts') {
            loadAlertsTab();
        } else if (currentTab === 'weather') {
            loadWeatherTab();
        }
    }, UPDATE_INTERVAL);
};
