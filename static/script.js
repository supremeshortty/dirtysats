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

    // Fleet page time range selectors
    document.getElementById('shares-timerange').addEventListener('change', loadStats);
    document.getElementById('power-timerange').addEventListener('change', loadStats);
    document.getElementById('fleet-chart-timerange').addEventListener('change', () => {
        const hours = parseInt(document.getElementById('fleet-chart-timerange').value);
        loadFleetCombinedChart(hours);
    });
    document.getElementById('fleet-chart-refresh').addEventListener('click', () => {
        const hours = parseInt(document.getElementById('fleet-chart-timerange').value);
        loadFleetCombinedChart(hours);
    });

    // Energy config form
    document.getElementById('energy-config-form').addEventListener('submit', applyEnergyPreset);

    // Show/hide custom rate entry based on dropdown selection
    document.getElementById('energy-company').addEventListener('change', function() {
        const customRateEntry = document.getElementById('custom-rate-entry');
        if (this.value === 'Custom (Manual Entry)') {
            customRateEntry.style.display = 'block';
        } else {
            customRateEntry.style.display = 'none';
        }
    });

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
    } else if (tabName === 'pools') {
        loadPoolsTab();
    } else if (tabName === 'fleet') {
        loadDashboard();
    }
}

// Load all dashboard data
async function loadDashboard() {
    try {
        await Promise.all([
            loadStats(),
            loadMiners(),
            loadFleetCombinedChart()
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
        // Get current stats (live)
        const response = await fetch(`${API_BASE}/api/stats`);
        const data = await response.json();

        if (data.success) {
            const stats = data.stats;
            document.getElementById('total-miners').textContent = stats.total_miners ?? 0;
            document.getElementById('online-miners').textContent = stats.online_miners ?? 0;
            document.getElementById('offline-miners').textContent = stats.offline_miners ?? 0;
            document.getElementById('total-hashrate').textContent = formatHashrate(stats.total_hashrate ?? 0);
            document.getElementById('best-difficulty').textContent = formatDifficulty(stats.best_difficulty_ever || 0);
            document.getElementById('avg-temp').textContent = `${(stats.avg_temperature ?? 0).toFixed(1)}°C`;
        }

        // Get time-based stats for shares and power
        const sharesHours = parseInt(document.getElementById('shares-timerange').value);
        const powerHours = parseInt(document.getElementById('power-timerange').value);

        const [sharesResponse, powerResponse] = await Promise.all([
            fetch(`${API_BASE}/api/stats/aggregate?hours=${sharesHours}`),
            fetch(`${API_BASE}/api/stats/aggregate?hours=${powerHours}`)
        ]);

        const sharesData = await sharesResponse.json();
        const powerData = await powerResponse.json();

        if (sharesData.success) {
            const totalShares = sharesData.stats.total_shares_accepted ?? 0;
            document.getElementById('total-shares').textContent = formatNumber(totalShares);
        }

        if (powerData.success) {
            const avgPower = powerData.stats.avg_power ?? 0;
            document.getElementById('total-power').textContent = `${avgPower.toFixed(1)} W`;
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

        console.log('Miners API response:', data);

        if (data.success) {
            displayMiners(data.miners);
        } else {
            console.error('API returned success=false:', data);
            const container = document.getElementById('miners-container');
            container.innerHTML = '<p class="no-miners">Error loading miners. Check console for details.</p>';
        }
    } catch (error) {
        console.error('Error loading miners:', error);
        const container = document.getElementById('miners-container');
        container.innerHTML = '<p class="no-miners">Error loading miners. Check console for details.</p>';
    }
}

// Display miners in grid
function displayMiners(miners) {
    const container = document.getElementById('miners-container');

    console.log('displayMiners called with:', miners);
    console.log('Number of miners:', miners ? miners.length : 'undefined');

    if (!miners || miners.length === 0) {
        container.innerHTML = '<p class="no-miners">No miners found. Click "Discover Miners" to scan your network.</p>';
        return;
    }

    try {
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

        console.log('Successfully displayed', miners.length, 'miners');
    } catch (error) {
        console.error('Error in displayMiners:', error);
        container.innerHTML = '<p class="no-miners">Error displaying miners. Check console for details.</p>';
    }
}

// Create HTML for single miner card
function createMinerCard(miner) {
    const status = miner.last_status || {};
    const isOnline = status.status === 'online';
    const offlineClass = isOnline ? '' : 'offline';

    // Extract chip type from raw data
    const chipType = status.raw?.ASICModel || 'Unknown';

    // Use custom name if set, otherwise use model or type
    const displayName = miner.custom_name || miner.model || miner.type;
    const isCustomName = !!miner.custom_name;

    return `
        <div class="miner-card ${offlineClass}">
            <div class="miner-header">
                <div class="miner-title" id="miner-title-${miner.ip.replace(/\./g, '-')}" data-ip="${miner.ip}">
                    ${displayName}
                    <span class="edit-name-btn" onclick="editMinerName('${miner.ip}', '${(miner.custom_name || '').replace(/'/g, "\\'")}')">✏️</span>
                </div>
                <div class="miner-type">${miner.type}</div>
            </div>
            <div class="miner-ip">${miner.ip}</div>
            <div class="chip-type">Chip Type: ${chipType}</div>

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
                    <div class="miner-stat">
                        <span class="miner-stat-label">Shares Found</span>
                        <span class="miner-stat-value">${formatNumber(status.shares_accepted || 0)}</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Best Difficulty</span>
                        <span class="miner-stat-value">${formatDifficulty(status.best_difficulty || 0)}</span>
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

// Format number with commas
function formatNumber(num) {
    if (!num) return '0';
    return num.toLocaleString();
}

// Format difficulty to human-readable
function formatDifficulty(diff) {
    if (!diff) return '0';

    if (diff >= 1_000_000_000) {
        return `${(diff / 1_000_000_000).toFixed(2)}B`;
    } else if (diff >= 1_000_000) {
        return `${(diff / 1_000_000).toFixed(2)}M`;
    } else if (diff >= 1_000) {
        return `${(diff / 1_000).toFixed(2)}K`;
    } else {
        return diff.toFixed(0);
    }
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
            },
            body: JSON.stringify({})
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

// Edit miner name
async function editMinerName(ip, currentName) {
    const newName = prompt(`Enter custom name for ${ip}:`, currentName || '');

    // User cancelled
    if (newName === null) return;

    try {
        const response = await fetch(`${API_BASE}/api/miner/${ip}/name`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ custom_name: newName })
        });

        const data = await response.json();

        if (data.success) {
            showAlert(`Miner name updated`, 'success');
            loadDashboard();
        } else {
            showAlert(`Failed to update name: ${data.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error updating name: ${error.message}`, 'error');
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

    if (!preset) {
        showAlert('Please select an energy company', 'error');
        return;
    }

    // If custom rates selected, validate and send custom rates
    if (preset === 'Custom (Manual Entry)') {
        const customRate = parseFloat(document.getElementById('custom-rate').value);
        const customPeakRate = parseFloat(document.getElementById('custom-peak-rate').value) || null;
        const customOffpeakRate = parseFloat(document.getElementById('custom-offpeak-rate').value) || null;

        if (!customRate || customRate <= 0) {
            showAlert('Please enter a valid standard rate', 'error');
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/api/energy/rates/custom`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    standard_rate: customRate,
                    peak_rate: customPeakRate,
                    offpeak_rate: customOffpeakRate
                })
            });

            const data = await response.json();

            if (data.success) {
                showAlert('✅ Custom energy rates applied successfully!', 'success');
                loadEnergyTab();
            } else {
                showAlert(`Error: ${data.error}`, 'error');
            }
        } catch (error) {
            showAlert(`Error applying custom rates: ${error.message}`, 'error');
        }
        return;
    }

    // Apply preset rates
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
                `$${(data.current_rate ?? 0).toFixed(3)}/kWh`;

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
                            <td>${rate.start_time ?? 'N/A'} - ${rate.end_time ?? 'N/A'}</td>
                            <td>$${(rate.rate_per_kwh ?? 0).toFixed(3)}/kWh</td>
                            <td><span class="rate-type ${rate.rate_type ?? 'standard'}">${rate.rate_type ?? 'standard'}</span></td>
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
                    <span class="profit-value">$${(prof.btc_price ?? 0).toLocaleString()}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">BTC Per Day</span>
                    <span class="profit-value">${(prof.btc_per_day ?? 0).toFixed(8)} BTC</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Revenue Per Day</span>
                    <span class="profit-value">$${(prof.revenue_per_day ?? 0).toFixed(2)}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Energy Cost Per Day</span>
                    <span class="profit-value">$${(prof.energy_cost_per_day ?? 0).toFixed(2)}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Profit Per Day</span>
                    <span class="profit-value ${profitClass}">$${(prof.profit_per_day ?? 0).toFixed(2)}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Profit Margin</span>
                    <span class="profit-value ${profitClass}">${(prof.profit_margin ?? 0).toFixed(1)}%</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Break-Even BTC Price</span>
                    <span class="profit-value">$${(prof.break_even_btc_price ?? 0).toLocaleString()}</span>
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
                `${(data.total_kwh ?? 0).toFixed(2)} kWh`;
            document.getElementById('cost-today').textContent =
                `$${(data.total_cost ?? 0).toFixed(2)}`;
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
// FLEET PAGE CHART
// ============================================================================

// Load Fleet Combined Chart (6 hours, compact view for dashboard)
async function loadFleetCombinedChart(hours = 6) {
    try {
        // Fetch both temperature and hashrate data in parallel
        const [tempResponse, hashrateResponse] = await Promise.all([
            fetch(`${API_BASE}/api/history/temperature?hours=${hours}`),
            fetch(`${API_BASE}/api/history/hashrate?hours=${hours}`)
        ]);

        const tempResult = await tempResponse.json();
        const hashrateResult = await hashrateResponse.json();

        if (!tempResult.success || !hashrateResult.success) {
            console.error('Error loading fleet chart data');
            return;
        }

        const ctx = document.getElementById('fleet-combined-chart').getContext('2d');

        // Prepare hashrate dataset (single line, total hashrate)
        const hashrateData = hashrateResult.data.map(point => ({
            x: new Date(point.timestamp),
            y: point.hashrate_ths
        }));

        // Group temperature data by miner IP
        const minerTempData = {};
        tempResult.data.forEach(point => {
            if (!minerTempData[point.miner_ip]) {
                minerTempData[point.miner_ip] = [];
            }
            minerTempData[point.miner_ip].push({
                x: new Date(point.timestamp),
                y: point.temperature
            });
        });

        // Create datasets
        const datasets = [];

        // Add hashrate dataset (left y-axis)
        datasets.push({
            label: 'Total Hashrate',
            data: hashrateData,
            borderColor: '#00FF41',
            backgroundColor: 'rgba(0, 255, 65, 0.1)',
            borderWidth: 3,
            fill: true,
            tension: 0.4,
            yAxisID: 'y-hashrate',
            order: 1,
            pointRadius: 2,
            pointHoverRadius: 6,
            pointBackgroundColor: '#00FF41',
            borderDash: []
        });

        // Add temperature datasets for each miner (right y-axis) - more distinct colors
        const tempColors = [
            '#FF1744',  // Bright red
            '#00E5FF',  // Cyan
            '#FFEA00',  // Yellow
            '#D500F9',  // Purple
            '#FF6E40',  // Orange
            '#76FF03',  // Lime
            '#18FFFF',  // Aqua
            '#FF4081'   // Pink
        ];
        Object.keys(minerTempData).forEach((ip, index) => {
            datasets.push({
                label: `${ip} Temp`,
                data: minerTempData[ip],
                borderColor: tempColors[index % tempColors.length],
                backgroundColor: 'transparent',
                borderWidth: 3,
                fill: false,
                tension: 0.4,
                yAxisID: 'y-temperature',
                order: 2,
                pointRadius: 2,
                pointHoverRadius: 6,
                pointBackgroundColor: tempColors[index % tempColors.length],
                borderDash: []
            });
        });

        // Destroy existing chart
        if (fleetCombinedChart) {
            fleetCombinedChart.destroy();
        }

        // Create new dual-axis chart
        fleetCombinedChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        labels: {
                            color: '#fff',
                            usePointStyle: true,
                            padding: 15
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    if (context.dataset.yAxisID === 'y-hashrate') {
                                        label += context.parsed.y.toFixed(2) + ' TH/s';
                                    } else {
                                        label += context.parsed.y.toFixed(1) + '°C';
                                    }
                                }
                                return label;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'hour'
                        },
                        ticks: { color: '#888' },
                        grid: { color: '#333' }
                    },
                    'y-hashrate': {
                        type: 'linear',
                        position: 'left',
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Hashrate (TH/s)',
                            color: '#4CAF50'
                        },
                        ticks: {
                            color: '#4CAF50',
                            callback: function(value) {
                                return value.toFixed(2);
                            }
                        },
                        grid: {
                            color: '#333',
                            drawOnChartArea: true
                        }
                    },
                    'y-temperature': {
                        type: 'linear',
                        position: 'right',
                        min: 0,
                        max: 200,
                        title: {
                            display: true,
                            text: 'Temperature (°C)',
                            color: '#2196F3'
                        },
                        ticks: {
                            color: '#2196F3',
                            stepSize: 50,
                            callback: function(value) {
                                return value.toFixed(0) + '°C';
                            }
                        },
                        grid: {
                            drawOnChartArea: false
                        }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error loading fleet combined chart:', error);
    }
}

// ============================================================================
// PHASE 4: CHARTS, ALERTS, AND WEATHER
// ============================================================================

// Chart instances
let combinedChart = null;
let fleetCombinedChart = null;
let powerChart = null;
let profitabilityChart = null;
let efficiencyChart = null;
let sharesChart = null;

// Load Charts Tab
async function loadChartsTab() {
    const hours = parseInt(document.getElementById('chart-time-range').value);
    await Promise.all([
        loadCombinedChart(hours),
        loadPowerChart(hours),
        loadProfitabilityChart(),
        loadEfficiencyChart(hours),
        loadSharesMetrics()
    ]);
}

// Load Combined Hashrate & Temperature Chart (AxeOS-style)
async function loadCombinedChart(hours = 24) {
    try {
        // Fetch both temperature and hashrate data in parallel
        const [tempResponse, hashrateResponse] = await Promise.all([
            fetch(`${API_BASE}/api/history/temperature?hours=${hours}`),
            fetch(`${API_BASE}/api/history/hashrate?hours=${hours}`)
        ]);

        const tempResult = await tempResponse.json();
        const hashrateResult = await hashrateResponse.json();

        if (!tempResult.success || !hashrateResult.success) {
            console.error('Error loading chart data');
            return;
        }

        const ctx = document.getElementById('combined-chart').getContext('2d');

        // Prepare hashrate dataset (single line, total hashrate)
        const hashrateData = hashrateResult.data.map(point => ({
            x: new Date(point.timestamp),
            y: point.hashrate_ths
        }));

        // Group temperature data by miner IP
        const minerTempData = {};
        tempResult.data.forEach(point => {
            if (!minerTempData[point.miner_ip]) {
                minerTempData[point.miner_ip] = [];
            }
            minerTempData[point.miner_ip].push({
                x: new Date(point.timestamp),
                y: point.temperature
            });
        });

        // Create datasets
        const datasets = [];

        // Add hashrate dataset (left y-axis)
        datasets.push({
            label: 'Total Hashrate',
            data: hashrateData,
            borderColor: '#00FF41',
            backgroundColor: 'rgba(0, 255, 65, 0.1)',
            borderWidth: 3,
            fill: true,
            tension: 0.4,
            yAxisID: 'y-hashrate',
            order: 1,
            pointRadius: 2,
            pointHoverRadius: 6,
            pointBackgroundColor: '#00FF41',
            borderDash: []
        });

        // Add temperature datasets for each miner (right y-axis) - more distinct colors
        const tempColors = [
            '#FF1744',  // Bright red
            '#00E5FF',  // Cyan
            '#FFEA00',  // Yellow
            '#D500F9',  // Purple
            '#FF6E40',  // Orange
            '#76FF03',  // Lime
            '#18FFFF',  // Aqua
            '#FF4081'   // Pink
        ];
        Object.keys(minerTempData).forEach((ip, index) => {
            datasets.push({
                label: `${ip} Temp`,
                data: minerTempData[ip],
                borderColor: tempColors[index % tempColors.length],
                backgroundColor: 'transparent',
                borderWidth: 3,
                fill: false,
                tension: 0.4,
                yAxisID: 'y-temperature',
                order: 2,
                pointRadius: 2,
                pointHoverRadius: 6,
                pointBackgroundColor: tempColors[index % tempColors.length],
                borderDash: []
            });
        });

        // Destroy existing chart
        if (combinedChart) {
            combinedChart.destroy();
        }

        // Create new dual-axis chart
        combinedChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        labels: {
                            color: '#fff',
                            usePointStyle: true,
                            padding: 15
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    if (context.dataset.yAxisID === 'y-hashrate') {
                                        label += context.parsed.y.toFixed(2) + ' TH/s';
                                    } else {
                                        label += context.parsed.y.toFixed(1) + '°C';
                                    }
                                }
                                return label;
                            }
                        }
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
                    'y-hashrate': {
                        type: 'linear',
                        position: 'left',
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Hashrate (TH/s)',
                            color: '#4CAF50'
                        },
                        ticks: {
                            color: '#4CAF50',
                            callback: function(value) {
                                return value.toFixed(2);
                            }
                        },
                        grid: {
                            color: '#333',
                            drawOnChartArea: true
                        }
                    },
                    'y-temperature': {
                        type: 'linear',
                        position: 'right',
                        min: 0,
                        max: 200,  // Fixed range to make temp lines appear low
                        title: {
                            display: true,
                            text: 'Temperature (°C)',
                            color: '#2196F3'
                        },
                        ticks: {
                            color: '#2196F3',
                            stepSize: 50,
                            callback: function(value) {
                                return value.toFixed(0) + '°C';
                            }
                        },
                        grid: {
                            drawOnChartArea: false
                        }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error loading combined chart:', error);
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
                    borderColor: '#FF6E40',
                    backgroundColor: 'rgba(255, 110, 64, 0.15)',
                    fill: true,
                    tension: 0.4,
                    borderWidth: 3,
                    pointRadius: 2,
                    pointHoverRadius: 6,
                    pointBackgroundColor: '#FF6E40'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
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
                    tension: 0.3,
                    borderWidth: 1.5,
                    pointRadius: 0,
                    pointHoverRadius: 4,
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
                animation: false,
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

// Load Efficiency Chart
async function loadEfficiencyChart(hours = 24) {
    try {
        const response = await fetch(`${API_BASE}/api/history/hashrate?hours=${hours}`);
        const result = await response.json();

        if (!result.success) return;

        const ctx = document.getElementById('efficiency-chart').getContext('2d');

        // Calculate efficiency (GH/s per Watt) for each data point
        const efficiencyData = result.data.map(point => {
            // Get corresponding power data (simplified - using average power)
            const efficiency = point.hashrate_ths / (point.total_power || 1) * 1000; // Convert to GH/W
            return {
                x: new Date(point.timestamp),
                y: efficiency
            };
        });

        if (efficiencyChart) {
            efficiencyChart.destroy();
        }

        efficiencyChart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Fleet Efficiency (GH/W)',
                    data: efficiencyData,
                    borderColor: '#00d9a3',
                    backgroundColor: '#00d9a320',
                    fill: true,
                    tension: 0.3,
                    borderWidth: 1.5,
                    pointRadius: 0,
                    pointHoverRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
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
                            text: 'Efficiency (GH/W)',
                            color: '#888'
                        },
                        ticks: { color: '#888' },
                        grid: { color: '#333' }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error loading efficiency chart:', error);
    }
}

// Load Shares Metrics
async function loadSharesMetrics() {
    try {
        const response = await fetch(`${API_BASE}/api/stats`);
        const result = await response.json();

        if (!result.success) return;

        const stats = result.stats;
        const totalShares = stats.total_shares || 0;
        const totalRejected = stats.total_rejected || 0;
        const totalAttempts = totalShares + totalRejected;

        const acceptRate = totalAttempts > 0 ? ((totalShares / totalAttempts) * 100).toFixed(2) : 0;
        const rejectRate = totalAttempts > 0 ? ((totalRejected / totalAttempts) * 100).toFixed(2) : 0;

        // Update metrics
        const efficiency = stats.total_power > 0 ? ((stats.total_hashrate / 1e9) / stats.total_power * 1000).toFixed(2) : 0;
        document.getElementById('fleet-efficiency').textContent = `${efficiency} GH/W`;
        document.getElementById('accept-rate').textContent = `${acceptRate}%`;
        document.getElementById('reject-rate').textContent = `${rejectRate}%`;
        document.getElementById('charts-avg-temp').textContent = `${(stats.avg_temperature ?? 0).toFixed(1)}°C`;

        // Create shares pie chart
        const ctx = document.getElementById('shares-chart').getContext('2d');

        if (sharesChart) {
            sharesChart.destroy();
        }

        sharesChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Accepted', 'Rejected'],
                datasets: [{
                    data: [totalShares, totalRejected],
                    backgroundColor: ['#00d9a3', '#f44336'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: {
                        labels: {
                            color: '#fff',
                            font: { size: 14 }
                        },
                        position: 'bottom'
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const label = context.label || '';
                                const value = context.parsed || 0;
                                const percentage = totalAttempts > 0 ? ((value / totalAttempts) * 100).toFixed(2) : 0;
                                return `${label}: ${formatNumber(value)} (${percentage}%)`;
                            }
                        }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error loading shares metrics:', error);
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
                    <div class="weather-stat-value">${(weather.temp_f ?? 0).toFixed(1)}°F</div>
                    <div class="weather-stat-description">${(weather.temp_c ?? 0).toFixed(1)}°C</div>
                </div>
                <div class="weather-stat">
                    <div class="weather-stat-label">Feels Like</div>
                    <div class="weather-stat-value">${(weather.feels_like_f ?? 0).toFixed(1)}°F</div>
                </div>
                <div class="weather-stat">
                    <div class="weather-stat-label">Humidity</div>
                    <div class="weather-stat-value">${weather.humidity ?? 0}%</div>
                </div>
                <div class="weather-stat">
                    <div class="weather-stat-label">Conditions</div>
                    <div class="weather-stat-description">${weather.description ?? 'N/A'}</div>
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
                    <div class="forecast-temp">${(forecast.temp_f ?? 0).toFixed(0)}°F</div>
                    <div class="forecast-desc">${forecast.description ?? 'N/A'}</div>
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
                <div class="prediction-message">${pred.message ?? 'N/A'}</div>
                <div class="prediction-details">
                    <div class="prediction-detail">
                        <div class="prediction-detail-label">Current Ambient</div>
                        <div class="prediction-detail-value">${(pred.current_ambient_f ?? 0).toFixed(1)}°F</div>
                    </div>
                    <div class="prediction-detail">
                        <div class="prediction-detail-label">Forecast Max</div>
                        <div class="prediction-detail-value">${(pred.forecast_max_f ?? 0).toFixed(1)}°F</div>
                    </div>
                    <div class="prediction-detail">
                        <div class="prediction-detail-label">Estimated Miner Temp</div>
                        <div class="prediction-detail-value">${(pred.estimated_miner_temp_c ?? 0).toFixed(1)}°C</div>
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
                    <div class="optimal-period-time">${period.start ?? 'N/A'} - ${period.end ?? 'N/A'}</div>
                    <div class="optimal-period-duration">${period.duration_hours ?? 0} hours</div>
                    <div class="optimal-period-temp">Avg: ${(period.avg_temp_f ?? 0).toFixed(1)}°F</div>
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
                telegram_bot_token: botToken,
                telegram_chat_id: chatId,
                telegram_enabled: true
            })
        });

        const result = await response.json();
        if (result.success) {
            showAlert('✅ Telegram configuration saved successfully!', 'success');
        } else {
            showAlert(`❌ Error: ${result.error}`, 'error');
        }
    } catch (error) {
        showAlert(`❌ Error saving Telegram config: ${error.message}`, 'error');
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
        } else if (currentTab === 'pools') {
            loadPoolsTab();
        }
    }, UPDATE_INTERVAL);
};

// ============================================================================
// POOLS TAB FUNCTIONS
// ============================================================================

// Load Pools Tab
async function loadPoolsTab() {
    await loadAllPools();
}

// Load All Pools
async function loadAllPools() {
    try {
        const response = await fetch(`${API_BASE}/api/pools`);
        const result = await response.json();

        const container = document.getElementById('pools-container');

        if (!result.success || result.miners.length === 0) {
            container.innerHTML = '<p class="loading">No miners available or pool management not supported</p>';
            return;
        }

        let html = '';
        result.miners.forEach(miner => {
            html += createPoolCard(miner);
        });
        container.innerHTML = html;

        // Attach event listeners
        result.miners.forEach(miner => {
            const form = document.getElementById(`pool-form-${miner.ip.replace(/\./g, '-')}`);
            if (form) {
                form.addEventListener('submit', (e) => {
                    e.preventDefault();
                    savePoolConfig(miner.ip);
                });
            }
        });
    } catch (error) {
        console.error('Error loading pools:', error);
    }
}

// Create Pool Card HTML
function createPoolCard(miner) {
    const ipId = miner.ip.replace(/\./g, '-');
    const pools = miner.pools || [];

    // Only support 2 pools: Primary and Secondary (Backup)
    while (pools.length < 2) {
        pools.push({ url: '', user: '', password: 'x' });
    }
    // Limit to 2 pools
    const limitedPools = pools.slice(0, 2);

    const poolLabels = ['Primary Pool', 'Secondary Pool (Backup)'];

    return `
        <div class="pool-card">
            <div class="pool-card-header">
                <h3>${miner.custom_name || miner.model || miner.type}</h3>
                <div class="pool-card-ip">${miner.ip}</div>
            </div>
            <form id="pool-form-${ipId}" class="pool-form">
                <div class="pools-grid">
                    ${limitedPools.map((pool, index) => `
                        <div class="pool-item ${index === miner.active_pool ? 'active' : ''}">
                            <h4>${poolLabels[index]} ${index === miner.active_pool ? '✓ Active' : ''}</h4>
                            <div class="form-group">
                                <label>Pool URL:</label>
                                <input type="text"
                                       name="pool${index}_url"
                                       value="${pool.url || ''}"
                                       placeholder="stratum+tcp://pool.example.com:3333"
                                       ${index === 0 ? 'required' : ''}>
                            </div>
                            <div class="form-group">
                                <label>Worker Username:</label>
                                <input type="text"
                                       name="pool${index}_user"
                                       value="${pool.user || ''}"
                                       placeholder="your_bitcoin_address.worker"
                                       ${index === 0 ? 'required' : ''}>
                            </div>
                            <div class="form-group">
                                <label>Password:</label>
                                <input type="text"
                                       name="pool${index}_password"
                                       value="${pool.password || 'x'}"
                                       placeholder="x">
                            </div>
                        </div>
                    `).join('')}
                </div>
                <div class="pool-actions">
                    <button type="submit" class="btn btn-primary">💾 Save Pool Configuration</button>
                </div>
            </form>
        </div>
    `;
}

// Save Pool Configuration
async function savePoolConfig(ip) {
    const ipId = ip.replace(/\./g, '-');
    const form = document.getElementById(`pool-form-${ipId}`);
    const formData = new FormData(form);

    // Build pools array - Only Primary and Secondary
    const pools = [];
    for (let i = 0; i < 2; i++) {
        const url = formData.get(`pool${i}_url`);
        const user = formData.get(`pool${i}_user`);
        const password = formData.get(`pool${i}_password`) || 'x';

        if (url && user) {
            pools.push({ url, user, password });
        }
    }

    if (pools.length === 0) {
        showAlert('❌ Primary pool configuration is required', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/miner/${ip}/pools`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pools })
        });

        const result = await response.json();

        if (result.success) {
            showAlert(`✅ Pool configuration updated for ${ip}`, 'success');
            setTimeout(() => loadAllPools(), 1000);
        } else {
            showAlert(`❌ Error: ${result.error}`, 'error');
        }
    } catch (error) {
        showAlert(`❌ Error saving pool config: ${error.message}`, 'error');
    }
}
