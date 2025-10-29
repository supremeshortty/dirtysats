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
