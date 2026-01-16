// Mining Fleet Manager Dashboard
const API_BASE = '';
const UPDATE_INTERVAL = 5000; // 5 seconds

let updateTimer = null;
let currentTab = 'fleet';
let minersCache = {}; // Cache for miner data including nicknames

// ============================================================================
// CHART COLOR SYSTEM - "Mission Control" Palette
// ============================================================================
const CHART_COLORS = {
    // Primary metrics
    hashrate: {
        line: '#00d4ff',      // Electric cyan - computational flow
        fill: 'rgba(0, 212, 255, 0.12)',
        glow: 'rgba(0, 212, 255, 0.3)'
    },
    temperature: {
        line: '#ff5252',      // Danger red - heat indicator
        fill: 'rgba(255, 82, 82, 0.12)',
        safe: '#00e676',      // Success green < 55°C
        warm: '#ffab00',      // Warning amber 55-70°C
        hot: '#ff5252',       // Danger 70-85°C
        danger: '#ff1744'     // Critical > 85°C
    },
    power: {
        line: '#f7931a',      // Bitcoin amber - electricity
        fill: 'rgba(247, 147, 26, 0.15)'
    },
    profit: {
        positive: '#00e676',  // Success green
        negative: '#ff5252',  // Danger red
        fillPositive: 'rgba(0, 230, 118, 0.15)',
        fillNegative: 'rgba(255, 82, 82, 0.15)'
    },
    efficiency: {
        line: '#8b5cf6',      // Purple - hero metric
        fill: 'rgba(139, 92, 246, 0.12)'
    },
    shares: {
        accepted: '#00e676',  // Success green
        rejected: '#6b7280'   // Muted gray
    },
    // Hashrate colors - COOL tones (cyans, blues, purples)
    hashrateColors: [
        '#00d4ff',  // Electric cyan
        '#00a8cc',  // Dim cyan
        '#8b5cf6',  // Purple
        '#7c3aed',  // Purple dim
        '#3b82f6',  // Blue
        '#0ea5e9',  // Sky
        '#14b8a6',  // Teal
        '#22d3ee'   // Light cyan
    ],
    // Temperature colors - WARM tones (reds, oranges, ambers)
    tempColors: [
        '#ff5252',  // Danger red
        '#ff1744',  // Critical red
        '#ffab00',  // Warning amber
        '#f7931a',  // Bitcoin amber
        '#ff6b6b',  // Light red
        '#ff9800',  // Orange
        '#ffc107',  // Yellow
        '#e91e63'   // Pink
    ],
    // Grid and text
    grid: 'rgba(255, 255, 255, 0.04)',
    gridLight: 'rgba(255, 255, 255, 0.08)',
    text: '#9ca3af',
    textMuted: '#6b7280'
};

// Get temperature color based on value
function getTempColor(temp) {
    if (temp < 55) return CHART_COLORS.temperature.safe;
    if (temp < 70) return CHART_COLORS.temperature.warm;
    if (temp < 85) return CHART_COLORS.temperature.hot;
    return CHART_COLORS.temperature.danger;
}

// Calculate adaptive axis max with nice rounding
function getAdaptiveAxisMax(maxValue) {
    if (maxValue <= 0) return 10; // Default minimum

    // Add 15-20% headroom
    const withHeadroom = maxValue * 1.18;

    // Find appropriate step size based on magnitude
    const magnitude = Math.pow(10, Math.floor(Math.log10(withHeadroom)));
    const normalized = withHeadroom / magnitude;

    // Round up to nice number
    let niceMax;
    if (normalized <= 1) niceMax = 1;
    else if (normalized <= 1.5) niceMax = 1.5;
    else if (normalized <= 2) niceMax = 2;
    else if (normalized <= 2.5) niceMax = 2.5;
    else if (normalized <= 3) niceMax = 3;
    else if (normalized <= 4) niceMax = 4;
    else if (normalized <= 5) niceMax = 5;
    else if (normalized <= 6) niceMax = 6;
    else if (normalized <= 8) niceMax = 8;
    else niceMax = 10;

    return niceMax * magnitude;
}

// Format hashrate with appropriate unit (TH/s or PH/s)
function formatHashrateAxis(valueTHs) {
    if (valueTHs >= 1000) {
        return (valueTHs / 1000).toFixed(1) + ' PH/s';
    }
    return valueTHs.toFixed(1) + ' TH/s';
}

// Get hashrate unit info based on max value
function getHashrateUnitInfo(maxTHs) {
    if (maxTHs >= 1000) {
        return { unit: 'PH/s', divisor: 1000, label: 'Hashrate (PH/s)' };
    }
    return { unit: 'TH/s', divisor: 1, label: 'Hashrate (TH/s)' };
}

// Generate grouped legend labels for combined charts (hashrate + temperature)
function generateGroupedLegendLabels(chart) {
    const datasets = chart.data.datasets;
    const hrDatasets = datasets.filter(d => d.metricType === 'hashrate');
    const tempDatasets = datasets.filter(d => d.metricType === 'temperature');

    const labels = [];

    // Hashrate section header
    if (hrDatasets.length > 0) {
        labels.push({
            text: 'HASHRATE',
            fillStyle: CHART_COLORS.hashrate.line,
            strokeStyle: CHART_COLORS.hashrate.line,
            fontColor: CHART_COLORS.hashrate.line,
            hidden: false,
            pointStyle: 'line',
            lineWidth: 3,
            datasetIndex: -1
        });

        // Hashrate datasets
        hrDatasets.forEach((dataset) => {
            const originalIndex = datasets.indexOf(dataset);
            labels.push({
                text: '  ' + dataset.label,
                fillStyle: dataset.borderColor,
                strokeStyle: dataset.borderColor,
                lineWidth: 2,
                pointStyle: 'line',
                hidden: !chart.isDatasetVisible(originalIndex),
                datasetIndex: originalIndex
            });
        });
    }

    // Temperature section header
    if (tempDatasets.length > 0) {
        labels.push({
            text: 'TEMPERATURE',
            fillStyle: CHART_COLORS.temperature.line,
            strokeStyle: CHART_COLORS.temperature.line,
            fontColor: CHART_COLORS.temperature.line,
            hidden: false,
            pointStyle: 'line',
            lineWidth: 3,
            lineDash: [4, 2],
            datasetIndex: -2
        });

        // Temperature datasets
        tempDatasets.forEach((dataset) => {
            const originalIndex = datasets.indexOf(dataset);
            labels.push({
                text: '  ' + dataset.label,
                fillStyle: dataset.borderColor,
                strokeStyle: dataset.borderColor,
                lineWidth: 2,
                pointStyle: 'line',
                lineDash: [4, 2],
                hidden: !chart.isDatasetVisible(originalIndex),
                datasetIndex: originalIndex
            });
        });
    }

    return labels;
}

// Handle legend click for grouped legends (prevent header toggling)
function handleGroupedLegendClick(e, legendItem, legend) {
    if (legendItem.datasetIndex < 0) return; // Don't toggle headers

    const chart = legend.chart;
    const index = legendItem.datasetIndex;
    chart.setDatasetVisibility(index, !chart.isDatasetVisible(index));
    chart.update();
}

// Common chart options for consistency
const CHART_DEFAULTS = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300, easing: 'easeOutQuart' },
    interaction: { mode: 'index', intersect: false },
    plugins: {
        legend: {
            labels: {
                color: CHART_COLORS.text,
                usePointStyle: true,
                padding: 16,
                font: { family: "'Outfit', sans-serif", size: 12, weight: '500' }
            }
        },
        tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            titleColor: '#f8fafc',
            bodyColor: '#cbd5e1',
            borderColor: 'rgba(148, 163, 184, 0.2)',
            borderWidth: 1,
            padding: 12,
            cornerRadius: 8,
            titleFont: { family: "'Outfit', sans-serif", size: 13, weight: '600' },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
            displayColors: true,
            boxPadding: 4
        }
    },
    scales: {
        x: {
            ticks: { color: CHART_COLORS.text, font: { size: 11 } },
            grid: { color: CHART_COLORS.grid, drawBorder: false }
        },
        y: {
            ticks: { color: CHART_COLORS.text, font: { size: 11 } },
            grid: { color: CHART_COLORS.grid, drawBorder: false }
        }
    }
};

// ============================================================================
// THEME MANAGEMENT
// ============================================================================

function initializeTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    // Set initial theme based on saved preference or system preference
    if (savedTheme) {
        document.documentElement.setAttribute('data-theme', savedTheme);
    } else if (prefersDark) {
        document.documentElement.setAttribute('data-theme', 'dark');
    } else {
        document.documentElement.setAttribute('data-theme', 'light');
    }

    // Listen for system theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
            document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
        }
    });
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);

    // Update chart colors if charts exist
    updateChartTheme();
}

function updateChartTheme() {
    // Get current theme colors
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const gridColor = isDark ? 'rgba(148, 163, 184, 0.06)' : 'rgba(148, 163, 184, 0.1)';
    const textColor = isDark ? '#94a3b8' : '#64748b';
    const legendColor = isDark ? '#e2e8f0' : '#334155';

    // Update all chart instances if they exist
    const chartInstances = [combinedChart, fleetCombinedChart, powerChart, profitabilityChart, efficiencyChart, sharesChart];

    chartInstances.forEach(chart => {
        if (chart && chart.options) {
            // Update grid colors (but keep axis-specific colors)
            if (chart.options.scales) {
                Object.keys(chart.options.scales).forEach(scaleKey => {
                    const scale = chart.options.scales[scaleKey];
                    if (scale.grid && scaleKey === 'x') {
                        scale.grid.color = gridColor;
                    }
                    if (scale.ticks && scaleKey === 'x') {
                        scale.ticks.color = textColor;
                    }
                });
            }

            // Update legend colors
            if (chart.options.plugins && chart.options.plugins.legend && chart.options.plugins.legend.labels) {
                chart.options.plugins.legend.labels.color = legendColor;
            }

            // Update tooltip styling
            if (chart.options.plugins && chart.options.plugins.tooltip) {
                chart.options.plugins.tooltip.backgroundColor = isDark ? 'rgba(15, 23, 42, 0.95)' : 'rgba(255, 255, 255, 0.95)';
                chart.options.plugins.tooltip.titleColor = isDark ? '#f8fafc' : '#0f172a';
                chart.options.plugins.tooltip.bodyColor = isDark ? '#cbd5e1' : '#475569';
                chart.options.plugins.tooltip.borderColor = isDark ? 'rgba(148, 163, 184, 0.2)' : 'rgba(148, 163, 184, 0.3)';
            }

            chart.update('none');
        }
    });
}

// Initialize theme immediately before DOM is ready
initializeTheme();

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
    // Theme toggle button
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }

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
        // Update miners cache for charts
        minersCache = {};
        miners.forEach(miner => {
            minersCache[miner.ip] = {
                custom_name: miner.custom_name,
                model: miner.model,
                type: miner.type
            };
        });

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

// Helper function to get display name for miner in charts
function getMinerDisplayName(ip) {
    if (minersCache[ip] && minersCache[ip].custom_name) {
        return `${minersCache[ip].custom_name} (${ip})`;
    }
    return ip;
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
                    <span class="miner-name">${displayName}</span>
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
    const MAX_NAME_LENGTH = 24;
    let newName = prompt(`Enter custom name for ${ip} (max ${MAX_NAME_LENGTH} characters):`, currentName || '');

    // User cancelled
    if (newName === null) return;

    // Trim and enforce character limit
    newName = newName.trim().substring(0, MAX_NAME_LENGTH);

    if (newName.length === 0) {
        // Allow clearing the name
        newName = '';
    }

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
                    <span class="profit-sublabel">${((prof.btc_per_day ?? 0) * 100000000).toFixed(0)} sats</span>
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

    // Load schedule simulations after profitability is loaded
    loadScheduleSimulations(prof);
}

// Load and display schedule simulations
async function loadScheduleSimulations(profitability) {
    try {
        // Get rate schedule data
        const ratesResponse = await fetch(`${API_BASE}/api/energy/rates`);
        const ratesData = await ratesResponse.json();

        if (!ratesData.success || !ratesData.schedule) {
            document.getElementById('simulation-strategies').innerHTML =
                '<p class="loading">Unable to load rate schedule for simulations</p>';
            return;
        }

        const rates = ratesData.schedule;
        const avgRate = rates.reduce((sum, r) => sum + r.rate_per_kwh, 0) / rates.length;
        const minRate = Math.min(...rates.map(r => r.rate_per_kwh));
        const maxRate = Math.max(...rates.map(r => r.rate_per_kwh));

        // Calculate hours for each rate type
        const offPeakHours = rates.filter(r => r.rate_per_kwh < avgRate).length;
        const peakHours = 24 - offPeakHours;

        // Define strategies
        const strategies = [
            {
                name: "24/7 Maximum Mining",
                description: "Mine at maximum frequency 24 hours a day, regardless of energy rates",
                miningHours: 24,
                avgFrequency: 1.0,
                schedule: "All day: MAX frequency",
                settings: { maxRate: 999, highRateFreq: 0, lowRateFreq: 0 }
            },
            {
                name: "Off-Peak Only",
                description: "Mine only during off-peak hours when electricity is cheapest",
                miningHours: offPeakHours,
                avgFrequency: 1.0,
                schedule: `${offPeakHours} hours/day at MAX frequency during lowest rates`,
                settings: { maxRate: avgRate, highRateFreq: 0, lowRateFreq: 0 },
                recommended: true
            },
            {
                name: "Smart Scheduling",
                description: "Reduce frequency during peak rates, maximize during off-peak",
                miningHours: 24,
                avgFrequency: 0.7,
                schedule: "Peak: 400 MHz underclock, Off-peak: MAX frequency",
                settings: { maxRate: 999, highRateFreq: 400, lowRateFreq: 0 }
            },
            {
                name: "Conservative",
                description: "Turn off during highest rates, mine at reduced frequency otherwise",
                miningHours: offPeakHours,
                avgFrequency: 0.8,
                schedule: `Turn OFF when rate > $${avgRate.toFixed(3)}/kWh, otherwise 450 MHz`,
                settings: { maxRate: avgRate, highRateFreq: 0, lowRateFreq: 450 }
            }
        ];

        // Calculate profitability for each strategy
        const strategiesWithProfit = strategies.map(strategy => {
            // Estimate revenue based on mining hours and frequency
            const revenueMultiplier = (strategy.miningHours / 24) * strategy.avgFrequency;
            const estimatedRevenue = profitability.revenue_per_day * revenueMultiplier;

            // Estimate energy cost based on mining hours and frequency
            const energyMultiplier = (strategy.miningHours / 24) * strategy.avgFrequency;
            const avgRateForStrategy = strategy.miningHours === 24 ? avgRate : minRate;
            const estimatedEnergyCost = (profitability.energy_cost_per_day / avgRate) * avgRateForStrategy * energyMultiplier;

            const estimatedProfit = estimatedRevenue - estimatedEnergyCost;
            const estimatedBtc = profitability.btc_per_day * revenueMultiplier;

            return {
                ...strategy,
                estimatedRevenue,
                estimatedEnergyCost,
                estimatedProfit,
                estimatedBtc
            };
        });

        // Sort by profitability
        strategiesWithProfit.sort((a, b) => b.estimatedProfit - a.estimatedProfit);

        // Display strategy cards
        displayStrategyCards(strategiesWithProfit);

    } catch (error) {
        console.error('Error loading schedule simulations:', error);
        document.getElementById('simulation-strategies').innerHTML =
            '<p class="loading">Error loading simulations</p>';
    }
}

// Display strategy cards
function displayStrategyCards(strategies) {
    const container = document.getElementById('simulation-strategies');

    const html = strategies.map(strategy => {
        const profitClass = strategy.estimatedProfit > 0 ? 'profit' : 'loss';
        const recommendedClass = strategy.recommended ? 'recommended' : '';

        return `
            <div class="strategy-card ${recommendedClass}">
                <div class="strategy-header">
                    <div class="strategy-name">${strategy.name}</div>
                    <div class="strategy-description">${strategy.description}</div>
                </div>

                <div class="strategy-metrics">
                    <div class="strategy-metric">
                        <span class="metric-label">Est. Daily Profit</span>
                        <span class="metric-value ${profitClass}">$${strategy.estimatedProfit.toFixed(2)}</span>
                    </div>
                    <div class="strategy-metric">
                        <span class="metric-label">Est. Daily Revenue</span>
                        <span class="metric-value">$${strategy.estimatedRevenue.toFixed(2)}</span>
                    </div>
                    <div class="strategy-metric">
                        <span class="metric-label">Est. Energy Cost</span>
                        <span class="metric-value">$${strategy.estimatedEnergyCost.toFixed(2)}</span>
                    </div>
                    <div class="strategy-metric">
                        <span class="metric-label">Est. BTC/Day</span>
                        <span class="metric-value">${strategy.estimatedBtc.toFixed(8)}</span>
                    </div>
                </div>

                <div class="strategy-schedule-info">
                    <strong>Schedule:</strong> ${strategy.schedule}
                </div>

                <button class="apply-strategy-btn" onclick="applyStrategy(${JSON.stringify(strategy.settings).replace(/"/g, '&quot;')})">
                    Apply This Schedule
                </button>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

// Apply a strategy
async function applyStrategy(settings) {
    try {
        const response = await fetch(`${API_BASE}/api/energy/schedule`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                auto_from_rates: true,
                max_rate_threshold: settings.maxRate,
                low_frequency: settings.highRateFreq,
                high_frequency: settings.lowRateFreq
            })
        });

        const data = await response.json();

        if (data.success) {
            showAlert('Mining schedule applied successfully! Your miners will now follow this strategy.', 'success');
        } else {
            showAlert(`Error: ${data.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error applying schedule: ${error.message}`, 'error');
    }
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

        // Group hashrate data by miner IP (per-miner hashrates)
        const minerHashrateData = {};
        (hashrateResult.data || []).forEach(point => {
            if (point.hashrate_ths != null && point.hashrate_ths > 0 && point.miner_ip && point.miner_ip !== '_total_') {
                if (!minerHashrateData[point.miner_ip]) {
                    minerHashrateData[point.miner_ip] = [];
                }
                minerHashrateData[point.miner_ip].push({
                    x: new Date(point.timestamp),
                    y: point.hashrate_ths
                });
            }
        });

        // Sort each miner's data by timestamp
        Object.keys(minerHashrateData).forEach(ip => {
            minerHashrateData[ip].sort((a, b) => a.x - b.x);
        });

        // Calculate adaptive hashrate axis based on individual miner max
        let maxHashrate = 0;
        Object.values(minerHashrateData).forEach(data => {
            if (data.length > 0) {
                const minerMax = Math.max(...data.map(d => d.y));
                if (minerMax > maxHashrate) maxHashrate = minerMax;
            }
        });
        if (maxHashrate === 0) maxHashrate = 10;
        const hashrateAxisMax = getAdaptiveAxisMax(maxHashrate);
        const unitInfo = getHashrateUnitInfo(hashrateAxisMax);

        // Group temperature data by miner IP - filter out null/invalid values
        const minerTempData = {};
        (tempResult.data || []).forEach(point => {
            if (point.temperature != null && point.temperature > 0 && point.temperature < 300 && point.miner_ip) {
                if (!minerTempData[point.miner_ip]) {
                    minerTempData[point.miner_ip] = [];
                }
                minerTempData[point.miner_ip].push({
                    x: new Date(point.timestamp),
                    y: point.temperature
                });
            }
        });

        // Sort each miner's temperature data by timestamp
        Object.keys(minerTempData).forEach(ip => {
            minerTempData[ip].sort((a, b) => a.x - b.x);
        });

        // Get unique miner IPs from both datasets
        const minerIPs = [...new Set([...Object.keys(minerHashrateData), ...Object.keys(minerTempData)])];

        // Create datasets - AxeOS style: per-miner hashrate + per-miner temp
        const datasets = [];

        // Add per-miner hashrate datasets (left y-axis) - COOL colors, solid lines
        minerIPs.forEach((ip, index) => {
            const color = CHART_COLORS.hashrateColors[index % CHART_COLORS.hashrateColors.length];
            const displayName = getMinerDisplayName(ip);

            if (minerHashrateData[ip] && minerHashrateData[ip].length > 0) {
                datasets.push({
                    label: `${displayName}`,
                    data: minerHashrateData[ip],
                    borderColor: color,
                    backgroundColor: color + '15',
                    borderWidth: 2.5,
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'y-hashrate',
                    order: 1,
                    pointRadius: 4,
                    pointHoverRadius: 7,
                    pointBackgroundColor: color,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    metricType: 'hashrate'
                });
            }
        });

        // Add per-miner temperature datasets (right y-axis) - WARM colors, dashed lines
        minerIPs.forEach((ip, index) => {
            const color = CHART_COLORS.tempColors[index % CHART_COLORS.tempColors.length];
            const displayName = getMinerDisplayName(ip);

            if (minerTempData[ip] && minerTempData[ip].length > 0) {
                datasets.push({
                    label: `${displayName}`,
                    data: minerTempData[ip],
                    borderColor: color,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'y-temperature',
                    order: 2,
                    pointRadius: 3,
                    pointHoverRadius: 6,
                    pointBackgroundColor: color,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1,
                    borderDash: [8, 4],
                    metricType: 'temperature'
                });
            }
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
                            color: CHART_COLORS.text,
                            usePointStyle: true,
                            padding: 12,
                            font: { family: "'Outfit', sans-serif", size: 11, weight: '600' },
                            generateLabels: generateGroupedLegendLabels
                        },
                        onClick: handleGroupedLegendClick
                    },
                    tooltip: {
                        ...CHART_DEFAULTS.plugins.tooltip,
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    if (context.dataset.yAxisID === 'y-hashrate') {
                                        // Use appropriate unit based on magnitude
                                        const val = context.parsed.y;
                                        if (val >= 1000) {
                                            label += (val / 1000).toFixed(2) + ' PH/s';
                                        } else {
                                            label += val.toFixed(2) + ' TH/s';
                                        }
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
                        ticks: { color: CHART_COLORS.text, font: { size: 11 } },
                        grid: { color: CHART_COLORS.grid }
                    },
                    'y-hashrate': {
                        type: 'linear',
                        position: 'left',
                        beginAtZero: true,
                        max: hashrateAxisMax,
                        title: {
                            display: true,
                            text: unitInfo.label,
                            color: CHART_COLORS.hashrate.line,
                            font: { size: 12, weight: '600' }
                        },
                        ticks: {
                            color: CHART_COLORS.hashrate.line,
                            font: { size: 11 },
                            callback: function(value) {
                                if (unitInfo.divisor > 1) {
                                    return (value / unitInfo.divisor).toFixed(1);
                                }
                                return value.toFixed(1);
                            }
                        },
                        grid: {
                            color: CHART_COLORS.grid,
                            drawOnChartArea: true
                        }
                    },
                    'y-temperature': {
                        type: 'linear',
                        position: 'right',
                        min: 0,
                        max: 100,
                        title: {
                            display: true,
                            text: 'Temperature (°C)',
                            color: CHART_COLORS.temperature.line,
                            font: { size: 12, weight: '600' }
                        },
                        ticks: {
                            color: CHART_COLORS.temperature.line,
                            font: { size: 11 },
                            stepSize: 20,
                            callback: function(value) {
                                return value + '°C';
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

        // Group hashrate data by miner IP (per-miner hashrates)
        const minerHashrateData = {};
        (hashrateResult.data || []).forEach(point => {
            if (point.hashrate_ths != null && point.hashrate_ths > 0 && point.miner_ip && point.miner_ip !== '_total_') {
                if (!minerHashrateData[point.miner_ip]) {
                    minerHashrateData[point.miner_ip] = [];
                }
                minerHashrateData[point.miner_ip].push({
                    x: new Date(point.timestamp),
                    y: point.hashrate_ths
                });
            }
        });

        // Sort each miner's data by timestamp
        Object.keys(minerHashrateData).forEach(ip => {
            minerHashrateData[ip].sort((a, b) => a.x - b.x);
        });

        // Calculate adaptive hashrate axis based on individual miner max
        let maxHashrate = 0;
        Object.values(minerHashrateData).forEach(data => {
            if (data.length > 0) {
                const minerMax = Math.max(...data.map(d => d.y));
                if (minerMax > maxHashrate) maxHashrate = minerMax;
            }
        });
        if (maxHashrate === 0) maxHashrate = 10;
        const hashrateAxisMax = getAdaptiveAxisMax(maxHashrate);
        const unitInfo = getHashrateUnitInfo(hashrateAxisMax);

        // Group temperature data by miner IP - filter out null/invalid values
        const minerTempData = {};
        (tempResult.data || []).forEach(point => {
            if (point.temperature != null && point.temperature > 0 && point.temperature < 300 && point.miner_ip) {
                if (!minerTempData[point.miner_ip]) {
                    minerTempData[point.miner_ip] = [];
                }
                minerTempData[point.miner_ip].push({
                    x: new Date(point.timestamp),
                    y: point.temperature
                });
            }
        });

        // Sort each miner's temperature data by timestamp
        Object.keys(minerTempData).forEach(ip => {
            minerTempData[ip].sort((a, b) => a.x - b.x);
        });

        // Get unique miner IPs from both datasets
        const minerIPs = [...new Set([...Object.keys(minerHashrateData), ...Object.keys(minerTempData)])];

        // Create datasets - AxeOS style: per-miner hashrate + per-miner temp
        const datasets = [];

        // Add per-miner hashrate datasets (left y-axis) - COOL colors, solid lines
        minerIPs.forEach((ip, index) => {
            const color = CHART_COLORS.hashrateColors[index % CHART_COLORS.hashrateColors.length];
            const displayName = getMinerDisplayName(ip);

            if (minerHashrateData[ip] && minerHashrateData[ip].length > 0) {
                datasets.push({
                    label: `${displayName}`,
                    data: minerHashrateData[ip],
                    borderColor: color,
                    backgroundColor: color + '15',
                    borderWidth: 2.5,
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'y-hashrate',
                    order: 1,
                    pointRadius: 4,
                    pointHoverRadius: 7,
                    pointBackgroundColor: color,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    metricType: 'hashrate'
                });
            }
        });

        // Add per-miner temperature datasets (right y-axis) - WARM colors, dashed lines
        minerIPs.forEach((ip, index) => {
            const color = CHART_COLORS.tempColors[index % CHART_COLORS.tempColors.length];
            const displayName = getMinerDisplayName(ip);

            if (minerTempData[ip] && minerTempData[ip].length > 0) {
                datasets.push({
                    label: `${displayName}`,
                    data: minerTempData[ip],
                    borderColor: color,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'y-temperature',
                    order: 2,
                    pointRadius: 3,
                    pointHoverRadius: 6,
                    pointBackgroundColor: color,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 1,
                    borderDash: [8, 4],
                    metricType: 'temperature'
                });
            }
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
                            color: CHART_COLORS.text,
                            usePointStyle: true,
                            padding: 12,
                            font: { family: "'Outfit', sans-serif", size: 11, weight: '600' },
                            generateLabels: generateGroupedLegendLabels
                        },
                        onClick: handleGroupedLegendClick
                    },
                    tooltip: {
                        ...CHART_DEFAULTS.plugins.tooltip,
                        callbacks: {
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    if (context.dataset.yAxisID === 'y-hashrate') {
                                        const val = context.parsed.y;
                                        if (val >= 1000) {
                                            label += (val / 1000).toFixed(2) + ' PH/s';
                                        } else {
                                            label += val.toFixed(2) + ' TH/s';
                                        }
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
                        ticks: { color: CHART_COLORS.text, font: { size: 11 } },
                        grid: { color: CHART_COLORS.grid }
                    },
                    'y-hashrate': {
                        type: 'linear',
                        position: 'left',
                        beginAtZero: true,
                        max: hashrateAxisMax,
                        title: {
                            display: true,
                            text: unitInfo.label,
                            color: CHART_COLORS.hashrate.line,
                            font: { size: 12, weight: '600' }
                        },
                        ticks: {
                            color: CHART_COLORS.hashrate.line,
                            font: { size: 11 },
                            callback: function(value) {
                                if (unitInfo.divisor > 1) {
                                    return (value / unitInfo.divisor).toFixed(1);
                                }
                                return value.toFixed(1);
                            }
                        },
                        grid: {
                            color: CHART_COLORS.grid,
                            drawOnChartArea: true
                        }
                    },
                    'y-temperature': {
                        type: 'linear',
                        position: 'right',
                        min: 0,
                        max: 100,
                        title: {
                            display: true,
                            text: 'Temperature (°C)',
                            color: CHART_COLORS.temperature.line,
                            font: { size: 12, weight: '600' }
                        },
                        ticks: {
                            color: CHART_COLORS.temperature.line,
                            font: { size: 11 },
                            stepSize: 20,
                            callback: function(value) {
                                return value + '°C';
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

        // Prepare data - filter out null/invalid values
        const validData = result.data.filter(point => point.power != null && point.power > 0);
        const labels = validData.map(point => new Date(point.timestamp));
        const data = validData.map(point => point.power);

        // Calculate adaptive power axis
        const maxPower = data.length > 0 ? Math.max(...data) : 100;
        const powerAxisMax = getAdaptiveAxisMax(maxPower);

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
                    label: 'Fleet Power',
                    data,
                    borderColor: CHART_COLORS.power.line,
                    backgroundColor: CHART_COLORS.power.fill,
                    fill: true,
                    tension: 0.35,
                    borderWidth: 2.5,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointBackgroundColor: CHART_COLORS.power.line,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2
                }]
            },
            options: {
                ...CHART_DEFAULTS,
                plugins: {
                    ...CHART_DEFAULTS.plugins,
                    tooltip: {
                        ...CHART_DEFAULTS.plugins.tooltip,
                        callbacks: {
                            label: function(context) {
                                const watts = context.parsed.y;
                                const kw = (watts / 1000).toFixed(2);
                                return `Power: ${watts.toFixed(0)} W (${kw} kW)`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: { unit: hours <= 24 ? 'hour' : 'day' },
                        ticks: { color: CHART_COLORS.text, font: { size: 11 } },
                        grid: { color: CHART_COLORS.grid }
                    },
                    y: {
                        beginAtZero: true,
                        max: powerAxisMax,
                        title: {
                            display: true,
                            text: powerAxisMax >= 1000 ? 'Power (kW)' : 'Power (W)',
                            color: CHART_COLORS.power.line,
                            font: { size: 12, weight: '600' }
                        },
                        ticks: {
                            color: CHART_COLORS.power.line,
                            font: { size: 11 },
                            callback: function(value) {
                                return value >= 1000 ? (value/1000).toFixed(1) : value.toFixed(0);
                            }
                        },
                        grid: { color: CHART_COLORS.grid }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error loading power chart:', error);
    }
}

// Load Profitability Chart
async function loadProfitabilityChart(days = 7) {
    try {
        const response = await fetch(`${API_BASE}/api/energy/profitability/history?days=${days}`);
        const result = await response.json();

        if (!result.success) {
            console.error('Error loading profitability history:', result.error);
            return;
        }

        const ctx = document.getElementById('profitability-chart').getContext('2d');

        // Prepare data
        const labels = result.history.map(point => new Date(point.timestamp));
        const profitData = result.history.map(point => point.profit_per_day);

        // Calculate adaptive profit axis (handle both positive and negative)
        const maxProfit = profitData.length > 0 ? Math.max(...profitData) : 1;
        const minProfit = profitData.length > 0 ? Math.min(...profitData) : -1;
        const absMax = Math.max(Math.abs(maxProfit), Math.abs(minProfit));
        const profitAxisMax = getAdaptiveAxisMax(absMax);
        const profitAxisMin = minProfit < 0 ? -profitAxisMax : 0;

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
                    label: 'Daily Profit',
                    data: profitData,
                    borderColor: CHART_COLORS.profit.positive,
                    backgroundColor: CHART_COLORS.profit.fillPositive,
                    fill: true,
                    tension: 0.35,
                    borderWidth: 2.5,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointBackgroundColor: CHART_COLORS.profit.positive,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    segment: {
                        borderColor: ctx => {
                            const value = ctx.p1.parsed.y;
                            return value >= 0 ? CHART_COLORS.profit.positive : CHART_COLORS.profit.negative;
                        },
                        backgroundColor: ctx => {
                            const value = ctx.p1.parsed.y;
                            return value >= 0 ? CHART_COLORS.profit.fillPositive : CHART_COLORS.profit.fillNegative;
                        }
                    }
                }]
            },
            options: {
                ...CHART_DEFAULTS,
                plugins: {
                    ...CHART_DEFAULTS.plugins,
                    tooltip: {
                        ...CHART_DEFAULTS.plugins.tooltip,
                        callbacks: {
                            label: function(context) {
                                const value = context.parsed.y;
                                const prefix = value >= 0 ? '+' : '';
                                return `Profit: ${prefix}$${value.toFixed(2)}/day`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: { unit: 'day' },
                        ticks: { color: CHART_COLORS.text, font: { size: 11 } },
                        grid: { color: CHART_COLORS.grid }
                    },
                    y: {
                        min: profitAxisMin,
                        max: profitAxisMax,
                        title: {
                            display: true,
                            text: 'Profit (USD/day)',
                            color: CHART_COLORS.profit.positive,
                            font: { size: 12, weight: '600' }
                        },
                        ticks: {
                            color: CHART_COLORS.text,
                            font: { size: 11 },
                            callback: function(value) {
                                const prefix = value >= 0 ? '+' : '';
                                return prefix + '$' + value.toFixed(2);
                            }
                        },
                        grid: {
                            color: (context) => {
                                if (context.tick.value === 0) {
                                    return 'rgba(148, 163, 184, 0.3)';
                                }
                                return CHART_COLORS.grid;
                            },
                            lineWidth: context => context.tick.value === 0 ? 2 : 1
                        }
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

        // Use totals data for efficiency calculation (contains total_power)
        const totalsData = result.totals || result.data;

        // Calculate efficiency (GH/s per Watt) for each data point
        const efficiencyData = totalsData
            .filter(point => point.hashrate_ths > 0 && point.total_power > 0)
            .map(point => {
                const efficiency = point.hashrate_ths / (point.total_power || 1) * 1000; // Convert to GH/W
                return {
                    x: new Date(point.timestamp),
                    y: efficiency
                };
            });

        // Calculate adaptive efficiency axis
        const maxEfficiency = efficiencyData.length > 0
            ? Math.max(...efficiencyData.map(d => d.y).filter(v => isFinite(v) && v > 0))
            : 100;
        const efficiencyAxisMax = getAdaptiveAxisMax(maxEfficiency || 100);

        if (efficiencyChart) {
            efficiencyChart.destroy();
        }

        efficiencyChart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Fleet Efficiency',
                    data: efficiencyData,
                    borderColor: CHART_COLORS.efficiency.line,
                    backgroundColor: CHART_COLORS.efficiency.fill,
                    fill: true,
                    tension: 0.35,
                    borderWidth: 2.5,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointBackgroundColor: CHART_COLORS.efficiency.line,
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2
                }]
            },
            options: {
                ...CHART_DEFAULTS,
                plugins: {
                    ...CHART_DEFAULTS.plugins,
                    tooltip: {
                        ...CHART_DEFAULTS.plugins.tooltip,
                        callbacks: {
                            label: function(context) {
                                return `Efficiency: ${context.parsed.y.toFixed(2)} GH/W`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: { unit: hours <= 24 ? 'hour' : 'day' },
                        ticks: { color: CHART_COLORS.text, font: { size: 11 } },
                        grid: { color: CHART_COLORS.grid }
                    },
                    y: {
                        beginAtZero: true,
                        max: efficiencyAxisMax,
                        title: {
                            display: true,
                            text: 'Efficiency (GH/W)',
                            color: CHART_COLORS.efficiency.line,
                            font: { size: 12, weight: '600' }
                        },
                        ticks: {
                            color: CHART_COLORS.efficiency.line,
                            font: { size: 11 },
                            callback: function(value) {
                                return value.toFixed(1);
                            }
                        },
                        grid: { color: CHART_COLORS.grid }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error loading efficiency chart:', error);
    }
}

// Load Shares Metrics
async function loadSharesMetrics(hours = 24) {
    try {
        // Get aggregate stats for the time range
        const aggResponse = await fetch(`${API_BASE}/api/stats/aggregate?hours=${hours}`);
        const aggResult = await aggResponse.json();

        // Get current stats for other metrics
        const response = await fetch(`${API_BASE}/api/stats`);
        const result = await response.json();

        if (!result.success || !aggResult.success) return;

        const stats = result.stats;
        const aggStats = aggResult.stats;

        // Use aggregated shares data for the pie chart
        const totalShares = aggStats.total_shares_accepted || 0;
        const totalRejected = aggStats.total_shares_rejected || 0;
        const totalAttempts = totalShares + totalRejected;

        const acceptRate = totalAttempts > 0 ? ((totalShares / totalAttempts) * 100).toFixed(2) : 0;
        const rejectRate = totalAttempts > 0 ? ((totalRejected / totalAttempts) * 100).toFixed(2) : 0;

        // Update metrics
        // Calculate efficiency in TH/W: (hashrate in H/s / 1e12) / power in W * 1000 = TH/W
        const efficiency = stats.total_power > 0 ? ((stats.total_hashrate / 1e12) / stats.total_power * 1000).toFixed(3) : 0;
        document.getElementById('fleet-efficiency').textContent = `${efficiency} TH/W`;
        document.getElementById('total-accepted-shares').textContent = formatNumber(totalShares);
        document.getElementById('total-rejected-shares').textContent = formatNumber(totalRejected);
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
                labels: [
                    `Accepted: ${formatNumber(totalShares)} (${acceptRate}%)`,
                    `Rejected: ${formatNumber(totalRejected)} (${rejectRate}%)`
                ],
                datasets: [{
                    data: [totalShares, totalRejected],
                    backgroundColor: [CHART_COLORS.shares.accepted, CHART_COLORS.shares.rejected],
                    borderWidth: 0,
                    hoverOffset: 8,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 300, easing: 'easeOutQuart' },
                cutout: '65%',
                plugins: {
                    legend: {
                        labels: {
                            color: CHART_COLORS.text,
                            font: {
                                size: 13,
                                weight: '500',
                                family: "'Outfit', sans-serif"
                            },
                            padding: 16,
                            usePointStyle: true,
                            pointStyle: 'circle',
                            generateLabels: function(chart) {
                                const data = chart.data;
                                if (data.labels.length && data.datasets.length) {
                                    return data.labels.map((label, i) => {
                                        const dataset = data.datasets[0];
                                        return {
                                            text: label,
                                            fillStyle: dataset.backgroundColor[i],
                                            fontColor: CHART_COLORS.text,
                                            hidden: false,
                                            index: i
                                        };
                                    });
                                }
                                return [];
                            }
                        },
                        position: 'bottom'
                    },
                    tooltip: {
                        ...CHART_DEFAULTS.plugins.tooltip,
                        callbacks: {
                            label: function(context) {
                                const value = context.parsed || 0;
                                const percentage = totalAttempts > 0 ? ((value / totalAttempts) * 100).toFixed(2) : 0;
                                return `${formatNumber(value)} shares (${percentage}%)`;
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

// Individual chart controls event listeners
document.getElementById('combined-chart-refresh')?.addEventListener('click', () => {
    const hours = parseInt(document.getElementById('combined-chart-timerange').value);
    loadCombinedChart(hours);
});
document.getElementById('combined-chart-timerange')?.addEventListener('change', () => {
    const hours = parseInt(document.getElementById('combined-chart-timerange').value);
    loadCombinedChart(hours);
});

document.getElementById('power-chart-refresh')?.addEventListener('click', () => {
    const hours = parseInt(document.getElementById('power-chart-timerange').value);
    loadPowerChart(hours);
});
document.getElementById('power-chart-timerange')?.addEventListener('change', () => {
    const hours = parseInt(document.getElementById('power-chart-timerange').value);
    loadPowerChart(hours);
});

document.getElementById('profitability-chart-refresh')?.addEventListener('click', () => {
    const days = parseInt(document.getElementById('profitability-chart-timerange').value);
    loadProfitabilityChart(days);
});
document.getElementById('profitability-chart-timerange')?.addEventListener('change', () => {
    const days = parseInt(document.getElementById('profitability-chart-timerange').value);
    loadProfitabilityChart(days);
});

document.getElementById('efficiency-chart-refresh')?.addEventListener('click', () => {
    const hours = parseInt(document.getElementById('efficiency-chart-timerange').value);
    loadEfficiencyChart(hours);
});
document.getElementById('efficiency-chart-timerange')?.addEventListener('change', () => {
    const hours = parseInt(document.getElementById('efficiency-chart-timerange').value);
    loadEfficiencyChart(hours);
});

document.getElementById('shares-chart-refresh')?.addEventListener('click', () => {
    const hours = parseInt(document.getElementById('shares-chart-timerange').value);
    loadSharesMetrics(hours);
});
document.getElementById('shares-chart-timerange')?.addEventListener('change', () => {
    const hours = parseInt(document.getElementById('shares-chart-timerange').value);
    loadSharesMetrics(hours);
});

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
