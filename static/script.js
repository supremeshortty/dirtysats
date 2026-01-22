// DirtySats - Bitcoin Mining Fleet Manager
const API_BASE = '';
const UPDATE_INTERVAL = 5000; // 5 seconds
const CHART_REFRESH_INTERVAL = 30000; // 30 seconds for chart updates
const OPTIMIZATION_INTERVAL = 300000; // 5 minutes between frequency adjustments
const MAX_FREQ_STEP = 25; // Maximum frequency increase per step (MHz)

let updateTimer = null;
let chartRefreshTimer = null;
let currentTab = 'fleet';
let minersCache = {}; // Cache for miner data including nicknames

// ============================================================================
// AUTO-OPTIMIZATION STATE
// ============================================================================
let optimizationState = {
    // Track which miners are being optimized: { ip: { active, startTime, startFreq, startHashrate, startShares, lastAdjustment, status } }
    miners: {},
    // Fleet-wide optimization active
    fleetOptimizing: false,
    // Intervals for optimization loops
    intervals: {}
};

// ============================================================================
// BATCH SELECTION STATE
// ============================================================================
let batchSelectionState = {
    selectedMiners: new Set(),  // Set of selected miner IPs
    selectionMode: false        // Whether selection mode is active
};

// Toggle batch selection mode
function toggleBatchSelectionMode() {
    batchSelectionState.selectionMode = !batchSelectionState.selectionMode;
    if (!batchSelectionState.selectionMode) {
        batchSelectionState.selectedMiners.clear();
    }
    updateBatchSelectionUI();
    loadMiners();
}

// Toggle miner selection
function toggleMinerSelection(ip, event) {
    if (event) event.stopPropagation();
    if (batchSelectionState.selectedMiners.has(ip)) {
        batchSelectionState.selectedMiners.delete(ip);
    } else {
        batchSelectionState.selectedMiners.add(ip);
    }
    updateBatchSelectionUI();
}

// Select all miners
function selectAllMiners() {
    for (const ip of Object.keys(minersCache)) {
        batchSelectionState.selectedMiners.add(ip);
    }
    updateBatchSelectionUI();
    loadMiners();
}

// Deselect all miners
function deselectAllMiners() {
    batchSelectionState.selectedMiners.clear();
    updateBatchSelectionUI();
    loadMiners();
}

// Update batch selection UI
function updateBatchSelectionUI() {
    const toolbar = document.getElementById('batch-toolbar');
    const count = document.getElementById('batch-selected-count');
    const selectBtn = document.getElementById('batch-select-btn');

    if (toolbar) toolbar.style.display = batchSelectionState.selectionMode ? 'flex' : 'none';
    if (count) count.textContent = batchSelectionState.selectedMiners.size;
    if (selectBtn) {
        selectBtn.classList.toggle('active', batchSelectionState.selectionMode);
        const icon = selectBtn.querySelector('img');
        const text = selectBtn.querySelector('span') || selectBtn;
        if (text.tagName !== 'IMG') {
            text.textContent = batchSelectionState.selectionMode ? ' Cancel' : ' Select';
        }
    }
    document.querySelectorAll('.miner-checkbox').forEach(cb => {
        cb.checked = batchSelectionState.selectedMiners.has(cb.dataset.ip);
    });
}

// Batch restart selected miners
async function batchRestart() {
    const ips = Array.from(batchSelectionState.selectedMiners);
    if (ips.length === 0) { showAlert('No miners selected', 'warning'); return; }
    if (!confirm('Restart ' + ips.length + ' selected miners?')) return;
    try {
        const response = await fetch(API_BASE + '/api/batch/restart', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ips })
        });
        const result = await response.json();
        if (result.success) {
            showAlert('Restarted ' + result.results.success.length + ' miners', 'success');
        } else { showAlert(result.error || 'Batch restart failed', 'error'); }
    } catch (error) { showAlert('Batch restart failed', 'error'); }
}

// Batch apply frequency
async function batchApplyFrequency() {
    const ips = Array.from(batchSelectionState.selectedMiners);
    if (ips.length === 0) { showAlert('No miners selected', 'warning'); return; }
    const frequency = prompt('Enter frequency (MHz) for all selected miners:', '500');
    if (!frequency) return;
    const freq = parseInt(frequency);
    if (isNaN(freq) || freq < 100 || freq > 1000) {
        showAlert('Invalid frequency (100-1000 MHz)', 'error'); return;
    }
    try {
        const response = await fetch(API_BASE + '/api/batch/settings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ips, settings: { frequency: freq } })
        });
        const result = await response.json();
        if (result.success) {
            showAlert('Applied ' + freq + 'MHz to ' + result.results.success.length + ' miners', 'success');
            loadMiners();
        } else { showAlert(result.error || 'Failed', 'error'); }
    } catch (error) { showAlert('Batch settings failed', 'error'); }
}

// Batch apply fan speed
async function batchApplyFanSpeed() {
    const ips = Array.from(batchSelectionState.selectedMiners);
    if (ips.length === 0) { showAlert('No miners selected', 'warning'); return; }
    const fanSpeed = prompt('Enter fan speed (%) for all selected miners:', '50');
    if (!fanSpeed) return;
    const fan = parseInt(fanSpeed);
    if (isNaN(fan) || fan < 0 || fan > 100) {
        showAlert('Invalid fan speed (0-100%)', 'error'); return;
    }
    try {
        const response = await fetch(API_BASE + '/api/batch/settings', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ips, settings: { fanspeed: fan, autofanspeed: 0 } })
        });
        const result = await response.json();
        if (result.success) {
            showAlert('Applied ' + fan + '% fan to ' + result.results.success.length + ' miners', 'success');
            loadMiners();
        } else { showAlert(result.error || 'Failed', 'error'); }
    } catch (error) { showAlert('Batch settings failed', 'error'); }
}

// Batch remove miners
async function batchRemove() {
    const ips = Array.from(batchSelectionState.selectedMiners);
    if (ips.length === 0) { showAlert('No miners selected', 'warning'); return; }
    if (!confirm('Remove ' + ips.length + ' miners from dashboard?')) return;
    try {
        const response = await fetch(API_BASE + '/api/batch/remove', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ips })
        });
        const result = await response.json();
        if (result.success) {
            showAlert('Removed ' + result.results.success.length + ' miners', 'success');
            batchSelectionState.selectedMiners.clear();
            updateBatchSelectionUI();
            loadMiners();
        } else { showAlert(result.error || 'Failed', 'error'); }
    } catch (error) { showAlert('Batch remove failed', 'error'); }
}

// ============================================================================
// DATA EXPORT
// ============================================================================

// Export data (miners, history, or profitability)
function exportData(type, format) {
    let url = API_BASE + '/api/export/' + type + '?format=' + format;

    // Add time parameters based on type
    if (type === 'history') {
        url += '&hours=168'; // Last 7 days
    } else if (type === 'profitability') {
        url += '&days=30';
    }

    // Trigger download
    window.open(url, '_blank');
    showAlert('Downloading ' + type + ' data as ' + format.toUpperCase(), 'success');
}

// ============================================================================
// MINER GROUPS
// ============================================================================

let groupsCache = [];
let currentGroupFilter = '';
let assigningGroupId = null;

// Open groups management modal
async function openGroupsModal() {
    const modal = document.getElementById('groups-modal');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    await loadGroups();
}

// Close groups modal
function closeGroupsModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('groups-modal');
    modal.style.display = 'none';
    document.body.style.overflow = '';
    // Reset assign section
    document.getElementById('assign-miners-section').style.display = 'none';
    assigningGroupId = null;
}

// Load all groups from API
async function loadGroups() {
    try {
        const response = await fetch(API_BASE + '/api/groups');
        const data = await response.json();
        if (data.success) {
            groupsCache = data.groups;
            renderGroupsList();
            updateGroupFilterDropdown();
        }
    } catch (error) {
        console.error('Error loading groups:', error);
    }
}

// Render groups list in modal
function renderGroupsList() {
    const container = document.getElementById('groups-list');
    if (groupsCache.length === 0) {
        container.innerHTML = '<p class="no-groups-message">No groups created yet. Create one above!</p>';
        return;
    }

    container.innerHTML = groupsCache.map(group => `
        <div class="group-item" data-group-id="${group.id}">
            <div class="group-item-info">
                <span class="group-color-dot" style="background: ${group.color}"></span>
                <span class="group-item-name">${escapeHtml(group.name)}</span>
                <span class="group-item-count">(${group.member_count} miners)</span>
            </div>
            <div class="group-item-actions">
                <button onclick="showAssignMiners(${group.id}, '${escapeHtml(group.name)}')" title="Assign miners">Assign</button>
                <button onclick="editGroup(${group.id})" title="Edit">Edit</button>
                <button class="delete" onclick="deleteGroup(${group.id})" title="Delete">Delete</button>
            </div>
        </div>
    `).join('');
}

// Update group filter dropdown
function updateGroupFilterDropdown() {
    const select = document.getElementById('group-filter-select');
    if (!select) return;

    // Keep current selection
    const currentValue = select.value;

    select.innerHTML = '<option value="">All Groups</option>';
    groupsCache.forEach(group => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        option.style.borderLeft = `3px solid ${group.color}`;
        select.appendChild(option);
    });

    // Restore selection if still valid
    if (currentValue && groupsCache.some(g => g.id == currentValue)) {
        select.value = currentValue;
    }
}

// Filter miners by group
function filterByGroup(groupId) {
    currentGroupFilter = groupId;
    renderMinersFiltered();
}

// Render miners with group filter applied
function renderMinersFiltered() {
    const container = document.getElementById('miners-container');
    if (!container) return;

    let minersToShow = Object.values(minersCache);

    // Apply group filter if set
    if (currentGroupFilter) {
        minersToShow = minersToShow.filter(miner => {
            const groups = miner.groups || [];
            return groups.some(g => g.id == currentGroupFilter);
        });
    }

    if (minersToShow.length === 0) {
        container.innerHTML = currentGroupFilter ?
            '<p class="loading">No miners in this group</p>' :
            '<p class="loading">No miners discovered yet</p>';
        return;
    }

    // Render filtered miners
    const minersHTML = minersToShow.map(miner => createMinerCard(miner)).join('');
    container.innerHTML = `<div class="miners-grid">${minersHTML}</div>`;

    // Attach event listeners
    minersToShow.forEach(miner => {
        const card = document.getElementById(`miner-card-${miner.ip.replace(/\./g, '-')}`);
        if (card) {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.miner-actions') || e.target.closest('.edit-name-btn') || e.target.closest('.miner-checkbox')) {
                    return;
                }
                openMinerDetail(miner.ip);
            });
        }

        const deleteBtn = document.getElementById(`delete-${miner.ip}`);
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteMiner(miner.ip);
            });
        }

        const restartBtn = document.getElementById(`restart-${miner.ip}`);
        if (restartBtn) {
            restartBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                restartMiner(miner.ip);
            });
        }
    });
}

// Create a new group
async function createGroup() {
    const nameInput = document.getElementById('new-group-name');
    const colorInput = document.getElementById('new-group-color');

    const name = nameInput.value.trim();
    const color = colorInput.value;

    if (!name) {
        showAlert('Please enter a group name', 'warning');
        return;
    }

    try {
        const response = await fetch(API_BASE + '/api/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, color })
        });
        const result = await response.json();

        if (result.success) {
            showAlert(`Group "${name}" created`, 'success');
            nameInput.value = '';
            colorInput.value = '#3498db';
            await loadGroups();
        } else {
            showAlert(result.error || 'Failed to create group', 'error');
        }
    } catch (error) {
        showAlert('Error creating group', 'error');
    }
}

// Delete a group
async function deleteGroup(groupId) {
    if (!confirm('Delete this group? Miners will not be deleted, only removed from the group.')) {
        return;
    }

    try {
        const response = await fetch(API_BASE + '/api/groups/' + groupId, {
            method: 'DELETE'
        });
        const result = await response.json();

        if (result.success) {
            showAlert('Group deleted', 'success');
            await loadGroups();
            loadMiners(); // Refresh to update miner group tags
        } else {
            showAlert(result.error || 'Failed to delete group', 'error');
        }
    } catch (error) {
        showAlert('Error deleting group', 'error');
    }
}

// Edit a group
async function editGroup(groupId) {
    const group = groupsCache.find(g => g.id === groupId);
    if (!group) return;

    const newName = prompt('Enter new name for group:', group.name);
    if (!newName || newName.trim() === group.name) return;

    try {
        const response = await fetch(API_BASE + '/api/groups/' + groupId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName.trim() })
        });
        const result = await response.json();

        if (result.success) {
            showAlert('Group updated', 'success');
            await loadGroups();
        } else {
            showAlert(result.error || 'Failed to update group', 'error');
        }
    } catch (error) {
        showAlert('Error updating group', 'error');
    }
}

// Show assign miners interface
async function showAssignMiners(groupId, groupName) {
    assigningGroupId = groupId;
    document.getElementById('assign-group-name').textContent = groupName;
    document.getElementById('assign-miners-section').style.display = 'block';

    // Get current group members
    let currentMembers = [];
    try {
        const response = await fetch(API_BASE + '/api/groups/' + groupId);
        const data = await response.json();
        if (data.success) {
            currentMembers = data.group.members || [];
        }
    } catch (error) {
        console.error('Error loading group members:', error);
    }

    // Render all miners with checkboxes
    const container = document.getElementById('assign-miners-list');
    const miners = Object.values(minersCache);

    container.innerHTML = miners.map(miner => {
        const isChecked = currentMembers.includes(miner.ip);
        const name = miner.custom_name || miner.model || miner.type || miner.ip;
        return `
            <div class="assign-miner-item">
                <input type="checkbox" id="assign-${miner.ip}" value="${miner.ip}" ${isChecked ? 'checked' : ''}>
                <label for="assign-${miner.ip}">${escapeHtml(name)}</label>
            </div>
        `;
    }).join('');
}

// Cancel assigning miners
function cancelAssignMiners() {
    document.getElementById('assign-miners-section').style.display = 'none';
    assigningGroupId = null;
}

// Save assigned miners
async function saveAssignedMiners() {
    if (!assigningGroupId) return;

    const checkboxes = document.querySelectorAll('#assign-miners-list input[type="checkbox"]');
    const selectedIps = [];
    const unselectedIps = [];

    checkboxes.forEach(cb => {
        if (cb.checked) {
            selectedIps.push(cb.value);
        } else {
            unselectedIps.push(cb.value);
        }
    });

    try {
        // Add selected miners
        if (selectedIps.length > 0) {
            await fetch(API_BASE + '/api/groups/' + assigningGroupId + '/members', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ips: selectedIps })
            });
        }

        // Remove unselected miners
        if (unselectedIps.length > 0) {
            await fetch(API_BASE + '/api/groups/' + assigningGroupId + '/members', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ips: unselectedIps })
            });
        }

        showAlert('Group membership updated', 'success');
        await loadGroups();
        loadMiners(); // Refresh to update miner group tags
        cancelAssignMiners();
    } catch (error) {
        showAlert('Error updating group membership', 'error');
    }
}

// Generate group tags HTML for a miner
function renderMinerGroupTags(groups) {
    if (!groups || groups.length === 0) return '';

    return `
        <div class="miner-groups-tags">
            ${groups.map(g => `
                <span class="group-tag">
                    <span class="tag-dot" style="background: ${g.color}"></span>
                    ${escapeHtml(g.name)}
                </span>
            `).join('')}
        </div>
    `;
}

// Helper function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize groups on page load
document.addEventListener('DOMContentLoaded', () => {
    loadGroups();
});

// Load persisted auto-optimize settings from backend
async function loadAutoOptimizeSettings() {
    try {
        const response = await fetch(`${API_BASE}/api/auto-optimize/all`);
        const data = await response.json();

        if (data.success && data.settings) {
            // Start optimization for miners that have it enabled
            for (const [ip, enabled] of Object.entries(data.settings)) {
                if (enabled && minersCache[ip]) {
                    // Initialize state and start optimization silently
                    if (!optimizationState.miners[ip]?.active) {
                        startMinerOptimizationSilent(ip);
                    }
                }
            }

            // Update fleet button state
            const anyActive = Object.values(data.settings).some(v => v);
            optimizationState.fleetOptimizing = anyActive;
            updateFleetOptimizeButton();
        }
    } catch (error) {
        console.error('Error loading auto-optimize settings:', error);
    }
}

// Start optimization without confirmation dialog (for restoring state)
async function startMinerOptimizationSilent(ip) {
    const miner = minersCache[ip];
    if (!miner) return;

    const status = miner.last_status || {};
    const profile = getMinerOCProfileByIP(ip);

    // Initialize optimization state for this miner
    optimizationState.miners[ip] = {
        active: true,
        startTime: Date.now(),
        startFreq: status.raw?.frequency || status.frequency || profile.frequency.stock,
        startHashrate: status.hashrate || 0,
        startShares: status.shares_accepted || 0,
        startEfficiency: calculateEfficiency(status.hashrate, status.power),
        lastAdjustment: Date.now(),
        adjustmentCount: 0,
        status: 'starting'
    };

    // Add optimizing class to miner card
    const cardId = `miner-card-${ip.replace(/\./g, '-')}`;
    const card = document.getElementById(cardId);
    if (card) {
        card.classList.add('optimizing');
        card.classList.remove('optimized');
    }

    // Run first optimization check immediately
    await runOptimizationCycle(ip);

    // Set up interval for ongoing optimization
    optimizationState.intervals[ip] = setInterval(() => {
        runOptimizationCycle(ip);
    }, 30000);
}

// Save auto-optimize setting to backend
async function saveAutoOptimizeSetting(ip, enabled) {
    try {
        await fetch(`${API_BASE}/api/miner/${ip}/auto-optimize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
    } catch (error) {
        console.error('Error saving auto-optimize setting:', error);
    }
}

// Update fleet optimize button state
function updateFleetOptimizeButton() {
    const btn = document.getElementById('auto-optimize-fleet-btn');
    const btnText = document.getElementById('auto-optimize-fleet-text');
    if (btn && btnText) {
        if (optimizationState.fleetOptimizing) {
            btn.classList.add('optimizing');
            btnText.textContent = 'Stop Optimization';
        } else {
            btn.classList.remove('optimizing');
            btnText.textContent = 'Auto Optimize Fleet';
        }
    }
}

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
    interaction: { mode: 'nearest', intersect: false },
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

    // Utility Rate Configuration - Tab switching
    document.querySelectorAll('.rate-tab').forEach(tab => {
        tab.addEventListener('click', function() {
            const targetTab = this.dataset.tab;
            // Update tab buttons
            document.querySelectorAll('.rate-tab').forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            // Update panels
            document.querySelectorAll('.rate-panel').forEach(p => p.classList.remove('active'));
            document.getElementById(`${targetTab}-panel`).classList.add('active');
        });
    });

    // OpenEI API Key management
    document.getElementById('save-api-key').addEventListener('click', saveOpenEIKey);
    document.getElementById('toggle-api-key-visibility').addEventListener('click', toggleApiKeyVisibility);
    document.getElementById('openei-api-key').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveOpenEIKey();
        }
    });
    // Allow clicking on status to toggle form
    document.getElementById('api-key-status').addEventListener('click', toggleApiKeyForm);
    // Check API key status on load
    checkOpenEIKeyStatus();

    // Utility search
    document.getElementById('utility-search-btn').addEventListener('click', searchUtilities);
    document.getElementById('utility-search').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            searchUtilities();
        }
    });

    // Apply OpenEI rate button
    document.getElementById('apply-openei-rate').addEventListener('click', applySelectedOpenEIRate);

    // Manual rate form
    document.getElementById('manual-rate-form').addEventListener('submit', applyManualRates);

    // Manual rate type toggle (TOU vs Flat)
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const rateType = this.dataset.type;
            document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');

            if (rateType === 'tou') {
                document.getElementById('tou-rate-entry').style.display = 'block';
                document.getElementById('flat-rate-entry').style.display = 'none';
            } else {
                document.getElementById('tou-rate-entry').style.display = 'none';
                document.getElementById('flat-rate-entry').style.display = 'block';
            }
        });
    });

    // Mining schedule form
    document.getElementById('mining-schedule-form').addEventListener('submit', createMiningSchedule);

    // Mining control radio buttons - show/hide frequency inputs
    initializeMiningControlRadios();

    // Frequency slider sync with number input
    initializeFrequencySliders();

    // Collapsible sections toggle
    document.querySelectorAll('.collapsible-header').forEach(header => {
        header.addEventListener('click', () => {
            const section = header.closest('.collapsible-section');
            section.classList.toggle('collapsed');
            // Save state to localStorage
            const sectionId = section.id;
            if (sectionId) {
                const collapsed = section.classList.contains('collapsed');
                localStorage.setItem(`section-${sectionId}`, collapsed ? 'collapsed' : 'expanded');
            }
        });
    });

    // Restore collapsible section states from localStorage
    document.querySelectorAll('.collapsible-section').forEach(section => {
        const sectionId = section.id;
        if (sectionId) {
            const savedState = localStorage.getItem(`section-${sectionId}`);
            if (savedState === 'collapsed') {
                section.classList.add('collapsed');
            }
        }
    });
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
    } else if (tabName === 'pools') {
        loadPoolsTab();
    } else if (tabName === 'fleet') {
        loadDashboard();
    }
}

// Load all dashboard data
async function loadDashboard() {
    try {
        // Read fleet chart time range from dropdown
        const fleetChartHours = parseInt(document.getElementById('fleet-chart-timerange')?.value) || 6;
        await Promise.all([
            loadStats(),
            loadMiners(),
            loadFleetCombinedChart(fleetChartHours),
            loadSoloOdds()
        ]);
        updateLastUpdateTime();

        // Load and restore auto-optimize settings after miners are loaded
        await loadAutoOptimizeSettings();
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
            document.getElementById('overheated-miners').textContent = stats.overheated_miners ?? 0;
            document.getElementById('total-hashrate').textContent = formatHashrate(stats.total_hashrate ?? 0);
            document.getElementById('best-difficulty').textContent = formatDifficulty(stats.best_difficulty_ever || 0);
            document.getElementById('avg-temp').textContent = `${(stats.avg_temperature ?? 0).toFixed(1)}°C`;
            // Note: total-power is now set by historical average below, not live stats
            // Calculate and display fleet efficiency (J/TH)
            const fleetEffEl = document.getElementById('fleet-efficiency');
            if (fleetEffEl && stats.total_hashrate && stats.total_power) {
                const hashrateTH = stats.total_hashrate / 1e12;
                if (hashrateTH > 0) {
                    const fleetEfficiency = stats.total_power / hashrateTH;
                    fleetEffEl.textContent = `${fleetEfficiency.toFixed(1)} J/TH`;
                    // Add color coding class
                    fleetEffEl.className = 'stat-value ' + getEfficiencyClass(stats.total_hashrate, stats.total_power);
                } else {
                    fleetEffEl.textContent = '-- J/TH';
                }
            }
        }

        // Get time-based stats for shares
        const sharesHours = parseInt(document.getElementById('shares-timerange').value);

        const sharesResponse = await fetch(`${API_BASE}/api/stats/aggregate?hours=${sharesHours}`);
        const sharesData = await sharesResponse.json();

        if (sharesData.success) {
            const totalShares = sharesData.stats.total_shares_accepted ?? 0;
            document.getElementById('total-shares').textContent = formatNumber(totalShares);
        }

        // Get time-based stats for power - calculate TOTAL ENERGY CONSUMED (kWh)
        const powerTimerangeEl = document.getElementById('power-timerange');
        const powerHours = powerTimerangeEl ? parseInt(powerTimerangeEl.value) : 24;
        const energyDisplayEl = document.getElementById('total-power');

        try {
            const powerResponse = await fetch(`${API_BASE}/api/history/power?hours=${powerHours}`);
            const powerData = await powerResponse.json();

            if (powerData.success && powerData.data && powerData.data.length > 0) {
                // Calculate average power (W) over the selected period
                const totalPower = powerData.data.reduce((sum, point) => sum + (point.power || 0), 0);
                const avgPowerWatts = totalPower / powerData.data.length;

                // Calculate total energy consumed: Energy (kWh) = Power (W) × Time (h) ÷ 1000
                const energyKwh = (avgPowerWatts * powerHours) / 1000;

                // Always display in kWh
                if (energyDisplayEl) energyDisplayEl.textContent = `${energyKwh.toFixed(2)} kWh`;
            } else {
                // Fallback: estimate from current live power if no historical data
                const livePower = data.stats?.total_power ?? 0;
                if (livePower > 0) {
                    const energyKwh = (livePower * powerHours) / 1000;
                    if (energyDisplayEl) energyDisplayEl.textContent = `${energyKwh.toFixed(2)} kWh`;
                } else {
                    if (energyDisplayEl) energyDisplayEl.textContent = `0.00 kWh`;
                }
            }
        } catch (powerError) {
            console.error('Error loading power history:', powerError);
            // Still show estimate based on current power
            const livePower = data.stats?.total_power ?? 0;
            const energyKwh = (livePower * powerHours) / 1000;
            if (energyDisplayEl) energyDisplayEl.textContent = `${energyKwh.toFixed(2)} kWh`;
        }

    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// Load fleet solo mining odds
async function loadSoloOdds() {
    try {
        const response = await fetch(`${API_BASE}/api/solo-chance`);
        const data = await response.json();

        if (data.success && data.solo_chance) {
            const odds = data.solo_chance;
            const blockEl = document.getElementById('solo-odds-block');
            const dayEl = document.getElementById('solo-odds-day');
            const timeEl = document.getElementById('solo-odds-time');

            if (blockEl) {
                blockEl.textContent = odds.chance_per_block_display || '--';
            }
            if (dayEl) {
                dayEl.textContent = odds.chance_per_day_display || '--';
            }
            if (timeEl) {
                timeEl.textContent = odds.time_estimate_display || '--';
            }
        }
    } catch (error) {
        console.error('Error loading solo odds:', error);
    }
}

// Load solo odds for a specific miner (used in miner modal)
async function loadMinerSoloOdds(ip) {
    try {
        const response = await fetch(`${API_BASE}/api/solo-chance?ip=${encodeURIComponent(ip)}`);
        const data = await response.json();

        if (data.success && data.solo_chance) {
            const odds = data.solo_chance;
            const blockEl = document.getElementById('modal-solo-block');
            const dayEl = document.getElementById('modal-solo-day');
            const timeEl = document.getElementById('modal-solo-time');

            if (blockEl) {
                blockEl.textContent = odds.chance_per_block_display || '--';
            }
            if (dayEl) {
                dayEl.textContent = odds.chance_per_day_display || '--';
            }
            if (timeEl) {
                timeEl.textContent = odds.time_estimate_display || '--';
            }
        }
    } catch (error) {
        console.error('Error loading miner solo odds:', error);
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

    if (!miners || miners.length === 0) {
        container.innerHTML = '<p class="no-miners">No miners found. Click "Discover Miners" to scan your network.</p>';
        return;
    }

    try {
        // Update miners cache for charts and modal data (includes groups)
        miners.forEach(miner => {
            minersCache[miner.ip] = {
                ip: miner.ip,
                custom_name: miner.custom_name,
                model: miner.model,
                type: miner.type,
                last_status: miner.last_status || {},
                auto_tune_enabled: miner.auto_tune_enabled || false,
                groups: miner.groups || []
            };
        });

        // Apply group filter if set
        let minersToDisplay = miners;
        if (currentGroupFilter) {
            minersToDisplay = miners.filter(miner => {
                const groups = miner.groups || [];
                return groups.some(g => g.id == currentGroupFilter);
            });
            if (minersToDisplay.length === 0) {
                container.innerHTML = '<p class="no-miners">No miners in this group</p>';
                return;
            }
        }

        // Check if we need to rebuild the grid or can update in-place
        const existingGrid = container.querySelector('.miners-grid');
        const currentMinerIPs = minersToDisplay.map(m => m.ip).sort().join(',');
        const existingMinerIPs = existingGrid ?
            Array.from(existingGrid.querySelectorAll('.miner-card')).map(c => c.dataset.ip).sort().join(',') : '';

        // If miner list changed (added/removed), rebuild the grid
        if (!existingGrid || currentMinerIPs !== existingMinerIPs) {
            const minersHTML = minersToDisplay.map(miner => createMinerCard(miner)).join('');
            container.innerHTML = `<div class="miners-grid">${minersHTML}</div>`;

            // Attach event listeners for actions
            minersToDisplay.forEach(miner => {
                const card = document.getElementById(`miner-card-${miner.ip.replace(/\./g, '-')}`);
                if (card) {
                    card.addEventListener('click', (e) => {
                        // Don't open modal if clicking on action buttons, edit name, or checkbox
                        if (e.target.closest('.miner-actions') || e.target.closest('.edit-name-btn') || e.target.closest('.miner-checkbox')) {
                            return;
                        }
                        openMinerDetail(miner.ip);
                    });
                }

                const deleteBtn = document.getElementById(`delete-${miner.ip}`);
                if (deleteBtn) {
                    deleteBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        deleteMiner(miner.ip);
                    });
                }

                const restartBtn = document.getElementById(`restart-${miner.ip}`);
                if (restartBtn) {
                    restartBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        restartMiner(miner.ip);
                    });
                }
            });
        } else {
            // Update existing cards in-place (live update without flickering)
            minersToDisplay.forEach(miner => {
                updateMinerCardData(miner.ip);
            });
        }
    } catch (error) {
        console.error('Error in displayMiners:', error);
        container.innerHTML = '<p class="no-miners">Error displaying miners. Check console for details.</p>';
    }
}

// Helper function to get display name for miner in charts (no IP addresses)
function getMinerDisplayName(ip) {
    if (minersCache[ip]) {
        // Prefer custom name, then model, then type
        if (minersCache[ip].custom_name) {
            return minersCache[ip].custom_name;
        }
        if (minersCache[ip].model) {
            return minersCache[ip].model;
        }
        if (minersCache[ip].type) {
            return minersCache[ip].type;
        }
    }
    // Fallback to a generic name (avoid showing IP)
    return 'Miner';
}

// Create HTML for single miner card
function createMinerCard(miner) {
    const status = miner.last_status || {};
    const minerStatus = status.status || 'offline';
    const isOnline = minerStatus === 'online' || minerStatus === 'overheating';
    const isOverheated = minerStatus === 'overheated';
    const isOverheating = minerStatus === 'overheating';

    // Determine card class based on status
    let statusClass = '';
    if (isOverheated) {
        statusClass = 'overheated';
    } else if (isOverheating) {
        statusClass = 'overheating';
    } else if (!isOnline) {
        statusClass = 'offline';
    }

    // Extract chip type from raw data or status (for CGMiner-based miners like Antminer)
    const chipType = status.raw?.ASICModel || status.asic_model || 'Unknown';

    // Use custom name if set, otherwise use model or type
    const displayName = miner.custom_name || miner.model || miner.type;
    const isCustomName = !!miner.custom_name;

    // Check if this miner is currently being optimized
    const isOptimizing = optimizationState.miners[miner.ip]?.active === true;
    const isOptimized = optimizationState.miners[miner.ip]?.status === 'optimal';
    const optimizingClass = isOptimizing ? 'optimizing' : (isOptimized ? 'optimized' : '');

    // Build status badge HTML
    let statusBadge = '';
    if (isOverheated) {
        statusBadge = '<span class="status-badge overheated">OVERHEATED</span>';
    } else if (isOverheating) {
        statusBadge = '<span class="status-badge overheating">OVERHEATING</span>';
    } else if (isOptimizing) {
        statusBadge = '<span class="optimization-badge tuning">AUTO-TUNING</span>';
    } else if (isOptimized) {
        statusBadge = '<span class="optimization-badge optimized">OPTIMIZED</span>';
    }

    // Check if this miner is selected
    const isSelected = batchSelectionState.selectedMiners.has(miner.ip);
    const selectedClass = isSelected ? 'selected' : '';

    return `
        <div class="miner-card ${statusClass} ${optimizingClass} ${selectedClass}" id="miner-card-${miner.ip.replace(/\./g, '-')}" data-ip="${miner.ip}">
            ${batchSelectionState.selectionMode ? `
                <div class="miner-checkbox-wrapper">
                    <input type="checkbox" class="miner-checkbox" data-ip="${miner.ip}"
                           ${isSelected ? 'checked' : ''}
                           onclick="toggleMinerSelection('${miner.ip}', event)">
                </div>
            ` : ''}
            <div class="miner-header">
                <div class="miner-title" id="miner-title-${miner.ip.replace(/\./g, '-')}" data-ip="${miner.ip}">
                    <span class="miner-name">${displayName}</span>
                    <span class="edit-name-btn" onclick="editMinerName('${miner.ip}', '${(miner.custom_name || '').replace(/'/g, "\\'")}')">✏️</span>
                </div>
                <div class="miner-badges">
                    ${statusBadge}
                    <div class="miner-type">${miner.type}</div>
                </div>
            </div>
            <div class="miner-ip">${miner.ip}</div>
            <div class="chip-type">Chip Type: ${chipType}</div>
            ${renderMinerGroupTags(miner.groups)}

            ${isOverheated ? `
                <div class="status-overheated" style="text-align: center; padding: 20px;">
                    <div style="font-size: 2em; margin-bottom: 10px;">🔥</div>
                    <div style="color: #ff4444; font-weight: bold;">DEVICE OVERHEATED</div>
                    <div style="color: #888; font-size: 0.9em; margin-top: 5px;">Cooling down...</div>
                </div>
            ` : isOnline ? `
                <div class="miner-stats">
                    <div class="miner-stat">
                        <span class="miner-stat-label">Hashrate</span>
                        <span class="miner-stat-value">${formatHashrate(status.hashrate)}</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Temperature</span>
                        <span class="miner-stat-value ${isOverheating ? 'temp-warning' : ''}">${status.temperature?.toFixed(1) || 'N/A'}°C</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Power</span>
                        <span class="miner-stat-value">${status.power?.toFixed(1) || 'N/A'} W</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Efficiency <span class="help-icon" onclick="showEfficiencyTooltip(event)" title="What is J/TH?">?</span></span>
                        <span class="miner-stat-value efficiency-help ${getEfficiencyClass(status.hashrate, status.power)}">${formatEfficiency(status.hashrate, status.power)}</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Fan Speed</span>
                        <span class="miner-stat-value">${formatFanSpeed(status.fan_speed)}</span>
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
                <button id="restart-${miner.ip}" class="btn btn-secondary" ${!isOnline ? 'disabled' : ''}>
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

// Format fan speed with correct unit (% for PWM control, RPM for traditional ASIC miners)
function formatFanSpeed(value) {
    if (value === null || value === undefined || value === 'N/A') return 'N/A';
    const numValue = parseInt(value);
    if (isNaN(numValue)) return 'N/A';
    // Values > 100 are RPM (traditional ASIC miners like Antminer S9)
    // Values <= 100 are percentage (ESP-Miner based devices like BitAxe)
    if (numValue > 100) {
        return `${numValue.toLocaleString()} RPM`;
    }
    return `${numValue}%`;
}

// Format difficulty to human-readable
function formatDifficulty(diff) {
    if (!diff) return '0';

    // If already a formatted string (e.g., '2.73 G'), return as-is
    if (typeof diff === 'string') {
        return diff;
    }

    if (diff >= 1_000_000_000_000) {
        return `${(diff / 1_000_000_000_000).toFixed(2)}T`;
    } else if (diff >= 1_000_000_000) {
        return `${(diff / 1_000_000_000).toFixed(2)}G`;
    } else if (diff >= 1_000_000) {
        return `${(diff / 1_000_000).toFixed(2)}M`;
    } else if (diff >= 1_000) {
        return `${(diff / 1_000).toFixed(2)}K`;
    } else {
        return diff.toFixed(0);
    }
}

// Format efficiency in J/TH (Joules per Terahash - industry standard, lower is better)
// Reference benchmarks: S21 Pro ~15 J/TH, BitAxe Ultra ~24 J/TH, S9 ~100 J/TH
function formatEfficiency(hashrate, power) {
    if (!hashrate || !power) return 'N/A';

    // Convert hashrate to TH/s
    const hashrateTH = hashrate / 1e12;
    if (hashrateTH <= 0) return 'N/A';

    // Calculate J/TH (power in Watts / hashrate in TH/s = J/TH)
    const efficiency = power / hashrateTH;

    if (efficiency >= 1000) {
        return `${(efficiency / 1000).toFixed(1)}k J/TH`;
    }
    return `${efficiency.toFixed(1)} J/TH`;
}

// Get CSS class for efficiency rating (lower is better)
// J/TH benchmarks (2025):
//   Industrial: S21 XP Hydro ~12, S21 Pro ~15, S19 XP ~22
//   Home/BitAxe: Gamma (BM1370) ~15, Ultra (BM1366) ~24, Supra ~22
//   Legacy: S9 ~100+
function getEfficiencyClass(hashrate, power) {
    if (!hashrate || !power) return '';

    const hashrateTH = hashrate / 1e12;
    if (hashrateTH <= 0) return '';

    const efficiency = power / hashrateTH;

    // Thresholds tuned for home miners (BitAxe/NerdAxe family)
    if (efficiency < 20) return 'efficiency-excellent';  // BM1370 chips, top-tier
    if (efficiency < 30) return 'efficiency-good';       // BM1366/BM1368 chips
    if (efficiency < 50) return 'efficiency-average';    // Older chips or suboptimal config
    if (efficiency < 80) return 'efficiency-poor';       // Legacy or inefficient setup
    return 'efficiency-bad';                             // Very old hardware (S9-era)
}

// Efficiency tooltip functions
function showEfficiencyTooltip(event) {
    if (event) event.stopPropagation();
    document.getElementById('efficiency-tooltip').classList.add('active');
    document.getElementById('efficiency-tooltip-overlay').classList.add('active');
}

function closeEfficiencyTooltip() {
    document.getElementById('efficiency-tooltip').classList.remove('active');
    document.getElementById('efficiency-tooltip-overlay').classList.remove('active');
}

// Button loading state helpers
function setButtonLoading(btn, isLoading, loadingText = 'Loading...') {
    if (!btn) return;
    if (isLoading) {
        btn.dataset.originalText = btn.textContent;
        btn.classList.add('loading');
        btn.disabled = true;
        btn.innerHTML = `<span class="btn-spinner"></span> ${loadingText}`;
    } else {
        btn.classList.remove('loading');
        btn.disabled = false;
        btn.textContent = btn.dataset.originalText || btn.textContent;
    }
}

// Discover miners
async function discoverMiners() {
    const btn = document.getElementById('discover-btn');
    setButtonLoading(btn, true, 'Discovering...');

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
        setButtonLoading(btn, false);
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-icon">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg> Discover Miners`;
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
            // Immediately update the UI
            const displayName = newName || minersCache[ip]?.model || minersCache[ip]?.type || 'Unknown';

            // Update miners cache
            if (minersCache[ip]) {
                minersCache[ip].custom_name = newName || null;
            }

            // Update miner card name
            const cardId = `miner-card-${ip.replace(/\./g, '-')}`;
            const card = document.getElementById(cardId);
            if (card) {
                const nameEl = card.querySelector('.miner-name');
                if (nameEl) nameEl.textContent = displayName;

                // Update edit button with new name
                const editBtn = card.querySelector('.edit-name-btn');
                if (editBtn) {
                    const escapedName = (newName || '').replace(/'/g, "\\'");
                    editBtn.setAttribute('onclick', `editMinerName('${ip}', '${escapedName}')`);
                }
            }

            showAlert(`Miner name updated`, 'success');
        } else {
            showAlert(`Failed to update name: ${data.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error updating name: ${error.message}`, 'error');
    }
}

// ========== ENERGY TAB FUNCTIONS ==========

// Flag to track if chart has been loaded initially
let energyChartInitialized = false;

async function loadEnergyTab(refreshChart = false) {
    const promises = [
        loadEnergyRates(),
        loadProfitability(),
        loadEnergyConsumption()
    ];

    // Only load chart on initial load or explicit refresh, not on auto-refresh
    if (!energyChartInitialized || refreshChart) {
        promises.push(loadEnergyConsumptionChart(parseInt(document.getElementById('energy-chart-timerange')?.value) || 168));
        energyChartInitialized = true;
    }

    await Promise.all(promises);
}

// Lighter refresh for energy tab during auto-refresh (doesn't reload chart)
async function refreshEnergyTabData() {
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

            // Update current rate period indicator
            updateRatePeriodIndicator(data.rates, data.current_rate_type);
        }
    } catch (error) {
        console.error('Error loading energy rates:', error);
    }
}

// Update the visual rate period indicator
function updateRatePeriodIndicator(rates, currentRateType) {
    const badge = document.getElementById('period-badge');
    const timeRemaining = document.getElementById('period-time-remaining');

    if (!badge || !rates || rates.length === 0) return;

    // Determine current period from rate type or time
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeDecimal = currentHour + currentMinute / 60;

    // Find current rate period
    let currentPeriod = null;
    let nextPeriodStart = null;

    for (const rate of rates) {
        const startParts = (rate.start_time || '00:00').split(':');
        const endParts = (rate.end_time || '23:59').split(':');
        let startHour = parseInt(startParts[0]) + parseInt(startParts[1]) / 60;
        let endHour = parseInt(endParts[0]) + parseInt(endParts[1]) / 60;
        if (rate.end_time === '23:59') endHour = 24;

        if (currentTimeDecimal >= startHour && currentTimeDecimal < endHour) {
            currentPeriod = rate;
            nextPeriodStart = endHour;
            break;
        }
    }

    // Use API-provided rate type if available, otherwise determine from rate
    const rateType = currentRateType || currentPeriod?.rate_type || 'standard';

    // Update badge
    badge.className = 'period-badge ' + rateType.replace('-', '');
    badge.textContent = rateType === 'off-peak' ? '💰 OFF-PEAK' :
                        rateType === 'peak' ? '⚡ PEAK' : '● STANDARD';

    // Calculate time until next period
    if (nextPeriodStart !== null) {
        const minutesRemaining = Math.round((nextPeriodStart - currentTimeDecimal) * 60);
        if (minutesRemaining > 60) {
            const hours = Math.floor(minutesRemaining / 60);
            const mins = minutesRemaining % 60;
            timeRemaining.textContent = `${hours}h ${mins}m remaining`;
        } else {
            timeRemaining.textContent = `${minutesRemaining}m remaining`;
        }
    } else {
        timeRemaining.textContent = '';
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
                    ${rates.map(rate => {
                        // Display "00:00" instead of "23:59" for end-of-day clarity
                        const endTime = (rate.end_time === '23:59') ? '00:00' : (rate.end_time ?? 'N/A');
                        return `
                        <tr>
                            <td>${rate.start_time ?? 'N/A'} - ${endTime}</td>
                            <td>$${(rate.rate_per_kwh ?? 0).toFixed(3)}/kWh</td>
                            <td><span class="rate-type ${rate.rate_type ?? 'standard'}">${rate.rate_type ?? 'standard'}</span></td>
                        </tr>
                    `}).join('')}
                </tbody>
            </table>
        </div>
    `;

    container.innerHTML = tableHTML;
}

// ============================================
// OpenEI Utility Rate Search Functions
// ============================================

// Global state for selected utility rate
let selectedOpenEIRate = null;

// Check OpenEI API key status on page load
async function checkOpenEIKeyStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/openei/key`);
        const data = await response.json();

        const statusEl = document.getElementById('api-key-status');
        const formEl = document.getElementById('api-key-form');
        const inputEl = document.getElementById('openei-api-key');
        const apiKeySection = document.getElementById('api-key-section');
        const searchSection = document.getElementById('utility-search-section');
        const sectionDivider = document.querySelector('#openei-panel .section-divider');

        if (data.success && data.configured) {
            statusEl.textContent = 'Configured ✓';
            statusEl.className = 'api-key-status configured';
            if (inputEl) inputEl.placeholder = data.masked_key || 'API key configured';
            // Collapse the entire API key section since key is already set
            if (formEl) formEl.style.display = 'none';
            // Hide the description paragraph too
            const descParagraph = apiKeySection?.querySelector('.panel-description');
            if (descParagraph) descParagraph.style.display = 'none';
            // Hide the hint paragraph
            const hintParagraph = apiKeySection?.querySelector('.panel-hint');
            if (hintParagraph) hintParagraph.style.display = 'none';
            // Show search section prominently
            if (searchSection) searchSection.style.display = 'block';
            if (sectionDivider) sectionDivider.style.display = 'block';
        } else {
            statusEl.textContent = 'Not Configured';
            statusEl.className = 'api-key-status not-configured';
            if (formEl) formEl.style.display = 'block';
            // Show the description and hint
            const descParagraph = apiKeySection?.querySelector('.panel-description');
            if (descParagraph) descParagraph.style.display = 'block';
            const hintParagraph = apiKeySection?.querySelector('.panel-hint');
            if (hintParagraph) hintParagraph.style.display = 'block';
            // Still show search section but it won't work without key
            if (searchSection) searchSection.style.display = 'block';
            if (sectionDivider) sectionDivider.style.display = 'block';
        }
    } catch (error) {
        console.error('Error checking API key status:', error);
    }
}

// Save OpenEI API key
async function saveOpenEIKey() {
    const inputEl = document.getElementById('openei-api-key');
    const apiKey = inputEl.value.trim();

    if (!apiKey) {
        showAlert('Please enter an API key', 'warning');
        return;
    }

    const saveBtn = document.getElementById('save-api-key');
    const originalText = saveBtn.textContent;
    saveBtn.textContent = 'Validating...';
    saveBtn.disabled = true;

    try {
        const response = await fetch(`${API_BASE}/api/openei/key`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey })
        });

        const data = await response.json();

        if (data.success) {
            showAlert('API key saved successfully!', 'success');
            inputEl.value = '';
            inputEl.placeholder = data.masked_key || 'API key configured';
            await checkOpenEIKeyStatus();
        } else {
            showAlert(data.error || 'Failed to save API key', 'error');
        }
    } catch (error) {
        console.error('Error saving API key:', error);
        showAlert('Error saving API key. Please try again.', 'error');
    } finally {
        saveBtn.textContent = originalText;
        saveBtn.disabled = false;
    }
}

// Toggle API key visibility
function toggleApiKeyVisibility() {
    const inputEl = document.getElementById('openei-api-key');
    if (inputEl.type === 'password') {
        inputEl.type = 'text';
    } else {
        inputEl.type = 'password';
    }
}

// Toggle API key form visibility (for reconfiguring)
function toggleApiKeyForm() {
    const formEl = document.getElementById('api-key-form');
    if (formEl.style.display === 'none') {
        formEl.style.display = 'block';
    } else {
        formEl.style.display = 'none';
    }
}

// Search utilities via OpenEI API
async function searchUtilities() {
    const searchInput = document.getElementById('utility-search');
    const query = searchInput.value.trim();

    if (query.length < 2) {
        showAlert('Please enter at least 2 characters to search', 'warning');
        return;
    }

    const utilityList = document.getElementById('utility-list');
    const searchResultsWrapper = document.getElementById('utility-search-results');
    const ratePlansContainer = document.getElementById('rate-plans-container');
    const ratePlansList = document.getElementById('rate-plans-list');
    const ratePreview = document.getElementById('rate-preview');

    // Show loading state
    utilityList.innerHTML = '<div class="loading">Searching utilities...</div>';
    searchResultsWrapper.style.display = 'block';
    ratePlansContainer.style.display = 'none';
    ratePlansList.innerHTML = '';
    ratePreview.style.display = 'none';
    selectedOpenEIRate = null;
    document.getElementById('apply-openei-rate').disabled = true;

    try {
        const response = await fetch(`${API_BASE}/api/utilities/search?q=${encodeURIComponent(query)}`);
        const data = await response.json();

        if (data.success && data.utilities && data.utilities.length > 0) {
            displayUtilityResults(data.utilities);
        } else if (data.error) {
            // Show API error (likely missing API key)
            const isApiKeyError = data.error.includes('API key') || data.error.includes('API_KEY');
            utilityList.innerHTML = `
                <div class="error-message">
                    <p>${data.error}</p>
                    ${isApiKeyError ? `
                        <p class="hint">
                            <a href="https://openei.org/services/api/signup" target="_blank">Get a free API key</a>
                            and add it to your config.py or set the OPENEI_API_KEY environment variable.
                        </p>
                        <p class="hint">Or use the <strong>Manual Entry</strong> tab to enter your rates directly.</p>
                    ` : `
                        <p class="hint">Please try again or use manual entry</p>
                    `}
                </div>
            `;
        } else {
            utilityList.innerHTML = `
                <div class="no-results">
                    <p>No utilities found for "${query}"</p>
                    <p class="hint">Try searching by utility name, state, or city (e.g., "Xcel Energy", "Colorado", "Denver")</p>
                </div>
            `;
        }
    } catch (error) {
        console.error('Error searching utilities:', error);
        utilityList.innerHTML = `
            <div class="error-message">
                <p>Error searching utilities: ${error.message}</p>
                <p class="hint">Please try again or use the Manual Entry tab</p>
            </div>
        `;
    }
}

// Display utility search results
function displayUtilityResults(utilities) {
    const container = document.getElementById('utility-list');
    const wrapper = document.getElementById('utility-search-results');

    const html = utilities.map(utility => `
        <div class="utility-item" data-utility-name="${utility.utility_name}" data-eia-id="${utility.eia_id || ''}">
            <div class="utility-name">${utility.utility_name}</div>
            <div class="utility-info">${utility.state || ''} ${utility.eia_id ? `(EIA: ${utility.eia_id})` : ''}</div>
        </div>
    `).join('');

    container.innerHTML = html;
    wrapper.style.display = 'block';

    // Add click handlers to utility items
    container.querySelectorAll('.utility-item').forEach(item => {
        item.addEventListener('click', () => {
            // Remove selection from other items
            container.querySelectorAll('.utility-item').forEach(i => i.classList.remove('selected'));
            // Select this item
            item.classList.add('selected');
            // Load rate plans for this utility
            loadUtilityRatePlans(item.dataset.utilityName, item.dataset.eiaId);
        });
    });
}

// Load rate plans for a selected utility
async function loadUtilityRatePlans(utilityName, eiaId) {
    const container = document.getElementById('rate-plans-container');
    const plansList = document.getElementById('rate-plans-list');
    const ratePreview = document.getElementById('rate-preview');

    // Show loading state
    container.style.display = 'block';
    plansList.innerHTML = '<div class="loading">Loading rate plans...</div>';
    ratePreview.style.display = 'none';
    selectedOpenEIRate = null;
    document.getElementById('apply-openei-rate').disabled = true;

    try {
        let url = `${API_BASE}/api/utilities/${encodeURIComponent(utilityName)}/rates`;
        if (eiaId) {
            url += `?eia_id=${encodeURIComponent(eiaId)}`;
        }

        const response = await fetch(url);
        const data = await response.json();

        if (data.success && data.rate_plans && data.rate_plans.length > 0) {
            displayRatePlans(data.rate_plans);
        } else {
            plansList.innerHTML = `
                <div class="no-results">
                    <p>No residential rate plans found for this utility</p>
                    <p class="hint">Try a different utility or use manual entry</p>
                </div>
            `;
        }
    } catch (error) {
        console.error('Error loading rate plans:', error);
        plansList.innerHTML = `
            <div class="error-message">
                <p>Error loading rate plans: ${error.message}</p>
            </div>
        `;
    }
}

// Display available rate plans
function displayRatePlans(plans) {
    const plansList = document.getElementById('rate-plans-list');

    const html = plans.map(plan => `
        <div class="rate-plan-item" data-rate-label="${plan.label}">
            <div class="rate-plan-name">${plan.name || plan.label}</div>
            <div class="rate-plan-details">
                ${plan.startdate ? `Effective: ${plan.startdate}` : ''}
                ${plan.is_tou ? '<span class="tou-badge">TOU</span>' : ''}
            </div>
        </div>
    `).join('');

    plansList.innerHTML = html;

    // Add click handlers to rate plan items
    plansList.querySelectorAll('.rate-plan-item').forEach(item => {
        item.addEventListener('click', () => {
            // Remove selection from other items
            plansList.querySelectorAll('.rate-plan-item').forEach(i => i.classList.remove('selected'));
            // Select this item
            item.classList.add('selected');
            // Preview this rate plan
            previewRatePlan(item.dataset.rateLabel);
        });
    });
}

// Preview a rate plan's details
async function previewRatePlan(rateLabel) {
    const preview = document.getElementById('rate-preview');
    const previewContent = document.getElementById('rate-preview-content');

    // Show loading state
    preview.style.display = 'block';
    previewContent.innerHTML = '<div class="loading">Loading rate details...</div>';

    try {
        const response = await fetch(`${API_BASE}/api/utilities/rates/${encodeURIComponent(rateLabel)}`);
        const data = await response.json();

        if (data.success && data.rates) {
            // Reshape data for display
            const rateData = {
                name: data.plan_name || rateLabel,
                utility: data.utility,
                schedules: data.rates // Backend returns 'rates', frontend uses 'schedules'
            };
            displayRatePreview(rateData, rateLabel);
            selectedOpenEIRate = rateLabel;
            document.getElementById('apply-openei-rate').disabled = false;
        } else {
            previewContent.innerHTML = `
                <div class="error-message">
                    <p>Could not load rate details: ${data.error || 'Unknown error'}</p>
                </div>
            `;
            selectedOpenEIRate = null;
            document.getElementById('apply-openei-rate').disabled = true;
        }
    } catch (error) {
        console.error('Error loading rate preview:', error);
        previewContent.innerHTML = `
            <div class="error-message">
                <p>Error: ${error.message}</p>
            </div>
        `;
        selectedOpenEIRate = null;
        document.getElementById('apply-openei-rate').disabled = true;
    }
}

// Display rate preview
function displayRatePreview(rateData, rateLabel) {
    const content = document.getElementById('rate-preview-content');
    const schedules = rateData.schedules || [];

    let html = `
        <div class="rate-preview-header">
            <strong>${rateData.name || rateLabel}</strong>
            ${rateData.utility ? `<span class="utility-name">${rateData.utility}</span>` : ''}
        </div>
    `;

    if (schedules.length > 0) {
        html += `
            <div class="rate-schedule-preview">
                <table class="rate-preview-table">
                    <thead>
                        <tr>
                            <th>Time Period</th>
                            <th>Rate</th>
                            <th>Type</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${schedules.map(s => `
                            <tr>
                                <td>${s.start_time} - ${s.end_time}</td>
                                <td>$${s.rate_per_kwh.toFixed(4)}/kWh</td>
                                <td><span class="rate-type ${s.rate_type}">${s.rate_type}</span></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    } else {
        html += '<p class="no-schedule">No detailed schedule available for this rate</p>';
    }

    content.innerHTML = html;
}

// Apply selected OpenEI rate
async function applySelectedOpenEIRate() {
    if (!selectedOpenEIRate) {
        showAlert('Please select a rate plan first', 'warning');
        return;
    }

    const applyBtn = document.getElementById('apply-openei-rate');
    const originalText = applyBtn.textContent;
    applyBtn.textContent = 'Applying...';
    applyBtn.disabled = true;

    try {
        const response = await fetch(`${API_BASE}/api/utilities/rates/${encodeURIComponent(selectedOpenEIRate)}/apply`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (data.success) {
            showAlert('Rate plan applied successfully!', 'success');
            // Reload energy rates to show the new schedule
            await loadEnergyRates();
            // Reload profitability to reflect new rates
            await loadProfitability();
        } else {
            showAlert(`Failed to apply rate: ${data.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        console.error('Error applying rate:', error);
        showAlert(`Error applying rate: ${error.message}`, 'error');
    } finally {
        applyBtn.textContent = originalText;
        applyBtn.disabled = !selectedOpenEIRate;
    }
}

// Apply manually entered rates
async function applyManualRates(e) {
    e.preventDefault();

    const activeToggle = document.querySelector('.toggle-btn.active');
    const rateType = activeToggle ? activeToggle.dataset.type : 'flat';

    let ratesPayload;

    if (rateType === 'flat') {
        // Flat rate - single rate for all hours
        const flatRate = parseFloat(document.getElementById('manual-flat-rate').value);

        if (isNaN(flatRate) || flatRate <= 0) {
            showAlert('Please enter a valid rate', 'warning');
            return;
        }

        ratesPayload = {
            standard_rate: flatRate
        };
    } else {
        // TOU rates - peak hours and off-peak for all other hours
        const peakRate = parseFloat(document.getElementById('manual-peak-rate').value);
        const peakStart = document.getElementById('manual-peak-start').value;
        const peakEnd = document.getElementById('manual-peak-end').value;
        const offPeakRate = parseFloat(document.getElementById('manual-offpeak-rate').value);

        // Validate inputs
        if (isNaN(peakRate) || peakRate <= 0) {
            showAlert('Please enter a valid peak rate', 'warning');
            return;
        }
        if (isNaN(offPeakRate) || offPeakRate <= 0) {
            showAlert('Please enter a valid off-peak rate', 'warning');
            return;
        }
        if (!peakStart || !peakEnd) {
            showAlert('Please enter peak hours', 'warning');
            return;
        }

        ratesPayload = {
            peak_rate: peakRate,
            peak_start: peakStart,
            peak_end: peakEnd,
            off_peak_rate: offPeakRate
        };
    }

    const submitBtn = document.querySelector('#manual-rate-form button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Applying...';
    submitBtn.disabled = true;

    try {
        const response = await fetch(`${API_BASE}/api/energy/rates/manual`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(ratesPayload)
        });

        const data = await response.json();

        if (data.success) {
            showAlert('Rates applied successfully!', 'success');
            // Reload energy rates to show the new schedule
            await loadEnergyRates();
            // Reload profitability to reflect new rates
            await loadProfitability();
        } else {
            showAlert(`Failed to apply rates: ${data.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        console.error('Error applying manual rates:', error);
        showAlert(`Error applying rates: ${error.message}`, 'error');
    } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
    }
}

// Load profitability
async function loadProfitability() {
    try {
        const response = await fetch(`${API_BASE}/api/energy/profitability`);
        const data = await response.json();

        if (data.success) {
            console.log('Profitability data:', data.profitability);
            console.log('Energy cost details:', data.profitability.energy_cost_details);
            displayProfitability(data.profitability);
        } else {
            console.error('Profitability API error:', data.error);
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

    // Calculate sats for display
    const satsPerDay = Math.round((prof.btc_per_day ?? 0) * 100000000);
    const poolFeePercent = prof.pool_fee_percent ?? 2;
    const includesTxFees = prof.includes_tx_fees ?? true;
    const blockSubsidy = prof.block_subsidy ?? 3.125;
    const blocksUntilHalving = prof.blocks_until_halving ?? 0;
    const daysUntilHalving = prof.days_until_halving ?? 0;
    const blockHeight = prof.block_height ?? 0;

    // Format halving countdown
    let halvingText = '';
    if (daysUntilHalving > 365) {
        const years = (daysUntilHalving / 365).toFixed(1);
        halvingText = `~${years} years`;
    } else if (daysUntilHalving > 30) {
        const months = Math.round(daysUntilHalving / 30);
        halvingText = `~${months} months`;
    } else {
        halvingText = `~${Math.round(daysUntilHalving)} days`;
    }

    // Energy cost breakdown
    const energyDetails = prof.energy_cost_details ?? {};
    const usesSchedule = energyDetails.uses_schedule ?? false;
    const costByType = energyDetails.cost_by_rate_type ?? {};
    const ratesByType = energyDetails.rates_by_type ?? {};  // Actual $/kWh rates
    const hoursInfo = usesSchedule ?
        `${energyDetails.hours_full_power ?? 24}h full, ${energyDetails.hours_reduced ?? 0}h reduced, ${energyDetails.hours_off ?? 0}h off` :
        '24h constant';

    // Build energy cost sublabel - show the actual $/kWh rates being used
    let energyCostSublabel = '';
    const hasTOURates = ratesByType.peak || ratesByType['off-peak'];
    if (hasTOURates) {
        const parts = [];
        if (ratesByType.peak) parts.push(`Peak: $${ratesByType.peak.toFixed(3)}/kWh`);
        if (ratesByType['off-peak']) parts.push(`Off-peak: $${ratesByType['off-peak'].toFixed(3)}/kWh`);
        if (ratesByType.standard) parts.push(`Std: $${ratesByType.standard.toFixed(3)}/kWh`);
        energyCostSublabel = parts.join(' | ');
    } else if (ratesByType.standard) {
        energyCostSublabel = `$${ratesByType.standard.toFixed(3)}/kWh`;
    } else {
        energyCostSublabel = `${(prof.energy_kwh_per_day ?? 0).toFixed(2)} kWh`;
    }

    // Calculate key miner efficiency metrics
    const energyKwhPerDay = prof.energy_kwh_per_day ?? 0;
    const hashrateThs = prof.total_hashrate_ths ?? 0;

    // Sats per kWh - how many sats you earn for each kWh consumed (higher is better)
    const satsPerKwh = energyKwhPerDay > 0 ? Math.round(satsPerDay / energyKwhPerDay) : 0;

    // Cost per TH/day - daily energy cost per TH of hashrate (lower is better, for hosting comparison)
    const costPerThDay = hashrateThs > 0 ? (prof.energy_cost_per_day ?? 0) / hashrateThs : 0;

    const html = `
        <div class="profitability-card">
            <div class="profitability-notice">
                <span class="data-badge estimated">Estimated</span> Values include ${poolFeePercent}% pool fee${includesTxFees ? ' + tx fees (FPPS)' : ''}. Actual pool earnings may vary.
            </div>
            <div class="profitability-grid">
                <div class="profit-item">
                    <span class="profit-label">BTC Price <span class="data-badge actual">Live</span></span>
                    <span class="profit-value">$${(prof.btc_price ?? 0).toLocaleString()}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Est. BTC Per Day</span>
                    <span class="profit-value">${(prof.btc_per_day ?? 0).toFixed(8)} BTC</span>
                    <span class="profit-sublabel">${satsPerDay.toLocaleString()} sats</span>
                </div>
                <div class="profit-item" title="Sats earned per kWh consumed (higher is better)">
                    <span class="profit-label">Sats/kWh</span>
                    <span class="profit-value">${satsPerKwh.toLocaleString()}</span>
                    <span class="profit-sublabel">Mining efficiency</span>
                </div>
                <div class="profit-item" title="Daily energy cost per TH - compare with hosting rates">
                    <span class="profit-label">$/TH/day</span>
                    <span class="profit-value">$${costPerThDay.toFixed(3)}</span>
                    <span class="profit-sublabel">Hosting comparison</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Est. Revenue Per Day</span>
                    <span class="profit-value">$${(prof.revenue_per_day ?? 0).toFixed(2)}</span>
                    <span class="profit-sublabel">After ${poolFeePercent}% pool fee</span>
                </div>
                <div class="profit-item" title="${hoursInfo}">
                    <span class="profit-label">Energy Cost Per Day</span>
                    <span class="profit-value">$${(prof.energy_cost_per_day ?? 0).toFixed(2)}</span>
                    <span class="profit-sublabel">${energyCostSublabel}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Est. Profit Per Day</span>
                    <span class="profit-value ${profitClass}">$${(prof.profit_per_day ?? 0).toFixed(2)}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Profit Margin</span>
                    <span class="profit-value ${profitClass}">${(prof.profit_margin ?? 0).toFixed(1)}%</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Break-Even BTC Price</span>
                    <span class="profit-value">$${(prof.break_even_btc_price ?? 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                </div>
                <div class="profit-item">
                    <span class="profit-label">Status</span>
                    <span class="profit-value ${profitClass}">
                        ${isProfitable ? '✓ Profitable' : '✗ Not Profitable'}
                    </span>
                </div>
            </div>
            <div class="halving-info">
                <div class="halving-item">
                    <span class="halving-label">Block Height</span>
                    <span class="halving-value">${blockHeight.toLocaleString()}</span>
                </div>
                <div class="halving-item">
                    <span class="halving-label">Block Subsidy</span>
                    <span class="halving-value">${blockSubsidy} BTC</span>
                </div>
                <div class="halving-item">
                    <span class="halving-label">Next Halving</span>
                    <span class="halving-value">${halvingText}</span>
                    <span class="halving-sublabel">${blocksUntilHalving.toLocaleString()} blocks</span>
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

        // Calculate actual hours for each rate type by parsing time ranges
        let offPeakHours = 0;
        let peakHours = 0;
        rates.forEach(r => {
            // Parse time range (e.g., "00:00" to "17:00")
            const startParts = (r.start_time || '00:00').split(':');
            const endParts = (r.end_time || '23:59').split(':');
            let startHour = parseInt(startParts[0]) + parseInt(startParts[1]) / 60;
            let endHour = parseInt(endParts[0]) + parseInt(endParts[1]) / 60;
            // Handle end time of 23:59 as 24:00
            if (r.end_time === '23:59') endHour = 24;
            const hours = endHour - startHour;
            if (r.rate_per_kwh <= minRate || r.rate_type === 'off-peak') {
                offPeakHours += hours;
            } else {
                peakHours += hours;
            }
        });
        // Ensure we have valid totals
        if (offPeakHours + peakHours === 0) {
            offPeakHours = 12;
            peakHours = 12;
        }

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
                schedule: `${Math.round(offPeakHours)} hours/day at MAX frequency during lowest rates`,
                settings: { maxRate: avgRate, highRateFreq: 0, lowRateFreq: 0 }
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

        // Mark the most profitable strategy as recommended
        if (strategiesWithProfit.length > 0) {
            strategiesWithProfit[0].recommended = true;
        }

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

// Load energy consumption using actual power data with TOU rates
async function loadEnergyConsumption() {
    try {
        // Use the new actual consumption endpoint that calculates from miner power readings
        const response = await fetch(`${API_BASE}/api/energy/consumption/actual?hours=24`);
        const data = await response.json();

        if (data.success) {
            const energyEl = document.getElementById('energy-today');
            const costEl = document.getElementById('cost-today');

            energyEl.textContent = `${(data.total_kwh ?? 0).toFixed(2)} kWh`;

            // Build cost display with TOU breakdown visible
            const peakCost = data.cost_by_rate_type?.peak ?? 0;
            const offPeakCost = data.cost_by_rate_type?.['off-peak'] ?? 0;
            const standardCost = data.cost_by_rate_type?.standard ?? 0;
            const totalCost = data.total_cost ?? 0;

            // Show breakdown inline if TOU rates are used
            if (peakCost > 0 || offPeakCost > 0) {
                costEl.innerHTML = `$${totalCost.toFixed(2)}<span class="cost-breakdown">Peak: $${peakCost.toFixed(2)} | Off-Peak: $${offPeakCost.toFixed(2)}</span>`;
                costEl.title = `Coverage: ${(data.time_coverage_percent ?? 0).toFixed(0)}%`;
            } else if (standardCost > 0) {
                costEl.textContent = `$${totalCost.toFixed(2)}`;
            } else {
                costEl.textContent = `$${totalCost.toFixed(2)}`;
            }
        }
    } catch (error) {
        console.error('Error loading energy consumption:', error);
    }
}

// Initialize mining control radio buttons
function initializeMiningControlRadios() {
    // Peak action radios
    const peakRadios = document.querySelectorAll('input[name="peak-action"]');
    const peakFreqGroup = document.getElementById('peak-freq-group');

    peakRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.value === 'reduce' && radio.checked) {
                peakFreqGroup?.classList.remove('hidden');
            } else if (radio.value === 'off' && radio.checked) {
                peakFreqGroup?.classList.add('hidden');
            }
        });
    });

    // Off-peak action radios
    const offpeakRadios = document.querySelectorAll('input[name="offpeak-action"]');
    const offpeakFreqGroup = document.getElementById('offpeak-freq-group');

    offpeakRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.value === 'custom' && radio.checked) {
                offpeakFreqGroup?.classList.remove('hidden');
            } else if (radio.value === 'max' && radio.checked) {
                offpeakFreqGroup?.classList.add('hidden');
            }
        });
    });
}

// Initialize frequency sliders
function initializeFrequencySliders() {
    // Peak frequency slider
    const peakSlider = document.getElementById('peak-freq-slider');
    const peakNumber = document.getElementById('high-rate-frequency');

    if (peakSlider && peakNumber) {
        peakSlider.addEventListener('input', () => {
            peakNumber.value = peakSlider.value;
        });
        peakNumber.addEventListener('input', () => {
            peakSlider.value = peakNumber.value;
        });
    }

    // Off-peak frequency slider
    const offpeakSlider = document.getElementById('offpeak-freq-slider');
    const offpeakNumber = document.getElementById('low-rate-frequency');

    if (offpeakSlider && offpeakNumber) {
        offpeakSlider.addEventListener('input', () => {
            offpeakNumber.value = offpeakSlider.value;
        });
        offpeakNumber.addEventListener('input', () => {
            offpeakSlider.value = offpeakNumber.value;
        });
    }
}

// Toggle advanced control section
function toggleAdvancedControl(header) {
    header.classList.toggle('expanded');
    const content = header.nextElementSibling;
    content.classList.toggle('hidden');
}

// Create mining schedule
async function createMiningSchedule(e) {
    e.preventDefault();

    const maxRate = parseFloat(document.getElementById('max-rate-threshold').value);

    // Get peak action
    const peakAction = document.querySelector('input[name="peak-action"]:checked')?.value || 'off';
    let highRateFreq = 0;
    if (peakAction === 'reduce') {
        highRateFreq = parseInt(document.getElementById('high-rate-frequency').value) || 400;
    }

    // Get off-peak action
    const offpeakAction = document.querySelector('input[name="offpeak-action"]:checked')?.value || 'max';
    let lowRateFreq = 0; // 0 means MAX
    if (offpeakAction === 'custom') {
        lowRateFreq = parseInt(document.getElementById('low-rate-frequency').value) || 600;
    }

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
// Style: Total hashrate (red with fill), average hashrate (dashed), avg temperature (white/gray)
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

        // Bucket size based on time range for optimal data point density
        const BUCKET_SIZE = hours <= 1 ? 1 * 60 * 1000 :      // 1 min for 1 hour
                           hours <= 6 ? 5 * 60 * 1000 :       // 5 min for 6 hours
                           hours <= 24 ? 15 * 60 * 1000 :     // 15 min for 24 hours
                           60 * 60 * 1000;                     // 1 hour for longer

        // Aggregate hashrate data by time bucket (sum all miners)
        const hashrateByTime = {};
        (hashrateResult.data || []).forEach(point => {
            if (point.hashrate_ths != null && point.hashrate_ths > 0 && point.miner_ip && point.miner_ip !== '_total_') {
                const bucketTime = Math.round(new Date(point.timestamp).getTime() / BUCKET_SIZE) * BUCKET_SIZE;
                if (!hashrateByTime[bucketTime]) {
                    hashrateByTime[bucketTime] = { sum: 0, byMiner: {} };
                }
                // Store by miner IP to avoid double-counting
                hashrateByTime[bucketTime].byMiner[point.miner_ip] = point.hashrate_ths;
            }
        });

        // Calculate totals from byMiner data
        Object.values(hashrateByTime).forEach(bucket => {
            bucket.sum = Object.values(bucket.byMiner).reduce((a, b) => a + b, 0);
        });

        // Convert to array and sort
        const totalHashrateData = Object.entries(hashrateByTime)
            .map(([time, bucket]) => ({ x: new Date(parseInt(time)), y: bucket.sum }))
            .sort((a, b) => a.x - b.x);

        // Calculate average hashrate for the dashed reference line
        const avgHashrate = totalHashrateData.length > 0
            ? totalHashrateData.reduce((sum, d) => sum + d.y, 0) / totalHashrateData.length
            : 0;

        // Aggregate temperature data by time bucket (average all miners)
        const tempByTime = {};
        (tempResult.data || []).forEach(point => {
            if (point.temperature != null && point.temperature > 0 && point.temperature < 150 && point.miner_ip) {
                const bucketTime = Math.round(new Date(point.timestamp).getTime() / BUCKET_SIZE) * BUCKET_SIZE;
                if (!tempByTime[bucketTime]) {
                    tempByTime[bucketTime] = { sum: 0, count: 0 };
                }
                tempByTime[bucketTime].sum += point.temperature;
                tempByTime[bucketTime].count++;
            }
        });

        // Convert to array with averages
        const avgTempData = Object.entries(tempByTime)
            .map(([time, bucket]) => ({ x: new Date(parseInt(time)), y: bucket.sum / bucket.count }))
            .sort((a, b) => a.x - b.x);

        // Calculate axis ranges
        let maxHashrate = totalHashrateData.length > 0 ? Math.max(...totalHashrateData.map(d => d.y)) : 10;
        let minHashrate = totalHashrateData.length > 0 ? Math.min(...totalHashrateData.map(d => d.y)) : 0;
        if (maxHashrate === 0) maxHashrate = 10;

        // Hashrate axis: adaptive range based on data to show fluctuations clearly
        const hashrateRange = maxHashrate - minHashrate;
        const hashratePadding = Math.max(hashrateRange * 0.15, maxHashrate * 0.02); // 15% of range or 2% of max
        const hashrateAxisMin = Math.max(0, minHashrate - hashratePadding);
        const hashrateAxisMax = maxHashrate + hashratePadding;
        const unitInfo = getHashrateUnitInfo(hashrateAxisMax);

        // Temperature axis: position data in lower portion of chart
        let minTemp = avgTempData.length > 0 ? Math.min(...avgTempData.map(d => d.y)) : 50;
        let maxTemp = avgTempData.length > 0 ? Math.max(...avgTempData.map(d => d.y)) : 70;
        const tempRange = Math.max(maxTemp - minTemp, 5);
        const tempAxisMin = Math.max(0, minTemp - 5);
        const tempAxisMax = maxTemp + tempRange * 2.5;

        // Create average hashrate reference line data (horizontal line across chart)
        const avgHashrateLineData = totalHashrateData.length > 0 ? [
            { x: totalHashrateData[0].x, y: avgHashrate },
            { x: totalHashrateData[totalHashrateData.length - 1].x, y: avgHashrate }
        ] : [];

        // Create datasets - clean style matching reference image
        const datasets = [];

        // 1. Total Hashrate - Red/pink line with filled area
        if (totalHashrateData.length > 0) {
            datasets.push({
                label: 'Total Hashrate',
                data: totalHashrateData,
                borderColor: '#e74c3c',
                backgroundColor: 'rgba(231, 76, 60, 0.25)',
                borderWidth: 2,
                fill: true,
                tension: 0.2,
                yAxisID: 'y-hashrate',
                order: 1,
                pointRadius: 2,
                pointHoverRadius: 5,
                pointBackgroundColor: '#e74c3c',
                pointBorderColor: '#e74c3c',
                pointBorderWidth: 0
            });
        }

        // 2. Average Total Hashrate - Dashed red horizontal line
        if (avgHashrateLineData.length > 0) {
            datasets.push({
                label: 'Average Total Hashrate',
                data: avgHashrateLineData,
                borderColor: '#e74c3c',
                backgroundColor: 'transparent',
                borderWidth: 1.5,
                borderDash: [6, 4],
                fill: false,
                tension: 0,
                yAxisID: 'y-hashrate',
                order: 0,
                pointRadius: 0,
                pointHoverRadius: 0
            });
        }

        // 3. Average Temperature - White/light gray line
        if (avgTempData.length > 0) {
            datasets.push({
                label: 'ASIC Temp',
                data: avgTempData,
                borderColor: 'rgba(255, 255, 255, 0.85)',
                backgroundColor: 'transparent',
                borderWidth: 1.5,
                fill: false,
                tension: 0.2,
                yAxisID: 'y-temperature',
                order: 2,
                pointRadius: 1.5,
                pointHoverRadius: 4,
                pointBackgroundColor: 'rgba(255, 255, 255, 0.85)',
                pointBorderColor: 'rgba(255, 255, 255, 0.85)',
                pointBorderWidth: 0
            });
        }

        // Destroy existing chart
        if (fleetCombinedChart) {
            fleetCombinedChart.destroy();
        }

        // Create new chart
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
                        display: true,
                        position: 'top',
                        align: 'center',
                        labels: {
                            color: CHART_COLORS.text,
                            usePointStyle: true,
                            pointStyle: 'circle',
                            padding: 20,
                            font: { family: "'Outfit', sans-serif", size: 11, weight: '500' },
                            boxWidth: 8,
                            boxHeight: 8
                        }
                    },
                    tooltip: {
                        ...CHART_DEFAULTS.plugins.tooltip,
                        callbacks: {
                            title: function(context) {
                                if (context[0] && context[0].parsed.x) {
                                    return new Date(context[0].parsed.x).toLocaleString();
                                }
                                return '';
                            },
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) label += ': ';
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
                            unit: hours <= 1 ? 'minute' : hours <= 6 ? 'hour' : hours <= 24 ? 'hour' : 'day',
                            displayFormats: {
                                minute: 'h:mm a',
                                hour: 'ha',
                                day: 'MMM d'
                            }
                        },
                        min: new Date(Date.now() - hours * 60 * 60 * 1000),
                        max: new Date(),
                        ticks: {
                            color: CHART_COLORS.text,
                            font: { size: 10 },
                            maxTicksLimit: 8
                        },
                        grid: { color: CHART_COLORS.grid }
                    },
                    'y-hashrate': {
                        type: 'linear',
                        position: 'left',
                        min: hashrateAxisMin,
                        max: hashrateAxisMax,
                        title: {
                            display: true,
                            text: unitInfo.label,
                            color: '#e74c3c',
                            font: { size: 11, weight: '600' }
                        },
                        ticks: {
                            color: '#e74c3c',
                            font: { size: 10 },
                            callback: function(value) {
                                if (unitInfo.divisor > 1) {
                                    return (value / unitInfo.divisor).toFixed(1) + ' ' + unitInfo.suffix;
                                }
                                return value.toFixed(2) + ' TH/s';
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
                        min: tempAxisMin,
                        max: tempAxisMax,
                        title: {
                            display: true,
                            text: 'Temperature',
                            color: 'rgba(255, 255, 255, 0.7)',
                            font: { size: 11, weight: '600' }
                        },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.7)',
                            font: { size: 10 },
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
let energyConsumptionChart = null;

// Load Charts Tab - reads each chart's individual time range
async function loadChartsTab() {
    // Each chart has its own time range dropdown
    const combinedHours = parseInt(document.getElementById('combined-chart-timerange')?.value) || 6;
    const powerHours = parseInt(document.getElementById('power-chart-timerange')?.value) || 6;
    const profitDays = parseInt(document.getElementById('profitability-chart-timerange')?.value) || 7;
    const efficiencyHours = parseInt(document.getElementById('efficiency-chart-timerange')?.value) || 6;
    const sharesHours = parseInt(document.getElementById('shares-chart-timerange')?.value) || 24;

    await Promise.all([
        loadCombinedChart(combinedHours),
        loadPowerChart(powerHours),
        loadProfitabilityChart(profitDays),
        loadEfficiencyChart(efficiencyHours),
        loadSharesMetrics(sharesHours)
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

        // Calculate adaptive hashrate axis based on individual miner data
        let maxHashrate = 0;
        let minHashrate = Infinity;
        Object.values(minerHashrateData).forEach(data => {
            if (data.length > 0) {
                const minerMax = Math.max(...data.map(d => d.y));
                const minerMin = Math.min(...data.map(d => d.y));
                if (minerMax > maxHashrate) maxHashrate = minerMax;
                if (minerMin < minHashrate) minHashrate = minerMin;
            }
        });
        if (maxHashrate === 0) maxHashrate = 10;
        if (minHashrate === Infinity) minHashrate = 0;

        // Adaptive axis range to show fluctuations clearly
        const hashrateRange = maxHashrate - minHashrate;
        const hashratePadding = Math.max(hashrateRange * 0.15, maxHashrate * 0.02); // 15% of range or 2% of max
        const hashrateAxisMin = Math.max(0, minHashrate - hashratePadding);
        const hashrateAxisMax = maxHashrate + hashratePadding;
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
                    borderWidth: 1.5,
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'y-hashrate',
                    order: 1,
                    pointRadius: 1,
                    pointHoverRadius: 3,
                    pointBackgroundColor: color,
                    pointBorderColor: color,
                    pointBorderWidth: 0,
                    metricType: 'hashrate',
                    spanGaps: false
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
                    pointRadius: 1,
                    pointHoverRadius: 3,
                    pointBackgroundColor: color,
                    pointBorderColor: color,
                    pointBorderWidth: 0,
                    borderDash: [8, 4],
                    metricType: 'temperature',
                    spanGaps: false
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
                    mode: 'nearest',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: false  // Hide legend - names shown on hover only
                    },
                    tooltip: {
                        ...CHART_DEFAULTS.plugins.tooltip,
                        callbacks: {
                            title: function(context) {
                                // Show timestamp
                                if (context[0] && context[0].parsed.x) {
                                    return new Date(context[0].parsed.x).toLocaleString();
                                }
                                return '';
                            },
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
                        // Set explicit bounds to prevent chart from extending past data
                        min: new Date(Date.now() - hours * 60 * 60 * 1000),
                        max: new Date(),
                        ticks: { color: CHART_COLORS.text, font: { size: 11 } },
                        grid: { color: CHART_COLORS.grid }
                    },
                    'y-hashrate': {
                        type: 'linear',
                        position: 'left',
                        min: hashrateAxisMin,
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
                    borderWidth: 1.5,
                    pointRadius: 1,
                    pointHoverRadius: 3,
                    pointBackgroundColor: CHART_COLORS.power.line,
                    pointBorderColor: CHART_COLORS.power.line,
                    pointBorderWidth: 0,
                    spanGaps: false
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
                        min: new Date(Date.now() - hours * 60 * 60 * 1000),
                        max: new Date(),
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
                    borderWidth: 1.5,
                    pointRadius: 1,
                    pointHoverRadius: 3,
                    pointBackgroundColor: CHART_COLORS.profit.positive,
                    pointBorderColor: CHART_COLORS.profit.positive,
                    pointBorderWidth: 0,
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

        // Calculate efficiency in J/TH (industry standard, lower is better)
        const efficiencyData = totalsData
            .filter(point => point.hashrate_ths > 0 && point.total_power > 0)
            .map(point => {
                const efficiency = point.total_power / point.hashrate_ths; // W/TH
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
                    borderWidth: 1.5,
                    pointRadius: 1,
                    pointHoverRadius: 3,
                    pointBackgroundColor: CHART_COLORS.efficiency.line,
                    pointBorderColor: CHART_COLORS.efficiency.line,
                    pointBorderWidth: 0,
                    spanGaps: false
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
                                return `Efficiency: ${context.parsed.y.toFixed(1)} J/TH`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: { unit: hours <= 24 ? 'hour' : 'day' },
                        min: new Date(Date.now() - hours * 60 * 60 * 1000),
                        max: new Date(),
                        ticks: { color: CHART_COLORS.text, font: { size: 11 } },
                        grid: { color: CHART_COLORS.grid }
                    },
                    y: {
                        beginAtZero: true,
                        max: efficiencyAxisMax,
                        title: {
                            display: true,
                            text: 'Efficiency (J/TH)',
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
        // Calculate efficiency in J/TH: power in W / (hashrate in H/s / 1e12) = J/TH (industry standard, lower is better)
        const hashrateThs = stats.total_hashrate / 1e12;
        const efficiency = hashrateThs > 0 ? (stats.total_power / hashrateThs).toFixed(1) : 0;
        document.getElementById('fleet-efficiency').textContent = `${efficiency} J/TH`;
        document.getElementById('total-accepted-shares').textContent = formatNumber(totalShares);
        document.getElementById('total-rejected-shares').textContent = formatNumber(totalRejected);
        document.getElementById('accept-rate').textContent = `${acceptRate}%`;
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

// Format relative time (e.g., "5 minutes ago")
function formatRelativeTime(timestamp) {
    const now = new Date();
    const alertTime = new Date(timestamp);
    const diffMs = now - alertTime;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
}

// Get icon for alert type
function getAlertIcon(alertType) {
    const icons = {
        'high_temperature': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>`,
        'critical_temperature': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>`,
        'miner_offline': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
        'miner_online': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
        'low_hashrate': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>`,
        'frequency_adjusted': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
        'emergency_shutdown': `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
    };
    return icons[alertType] || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
}

// Extract miner IP from alert title/message
function extractMinerIP(alert) {
    const ipRegex = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;
    const match = (alert.title || alert.message || '').match(ipRegex);
    return match ? match[1] : null;
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
            container.innerHTML = `
                <div class="no-alerts">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="48" height="48">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                    </svg>
                    <p>No alerts in the last 24 hours</p>
                </div>
            `;
            return;
        }

        let html = '';
        result.alerts.forEach(alert => {
            const relativeTime = formatRelativeTime(alert.timestamp);
            const fullTime = new Date(alert.timestamp).toLocaleString();
            const icon = getAlertIcon(alert.alert_type);
            const minerIP = extractMinerIP(alert);
            const minerName = minerIP && minersCache[minerIP] ?
                (minersCache[minerIP].custom_name || minersCache[minerIP].model || minerIP) :
                minerIP;

            // Parse extra data if available
            let extraDetails = '';
            if (alert.data_json) {
                try {
                    const data = typeof alert.data_json === 'string' ? JSON.parse(alert.data_json) : alert.data_json;
                    const details = [];
                    if (data.temperature) details.push(`Temp: ${data.temperature}`);
                    if (data.hashrate) details.push(`Hashrate: ${data.hashrate}`);
                    if (data.frequency) details.push(`Freq: ${data.frequency}`);
                    if (details.length > 0) {
                        extraDetails = `<div class="alert-item-details">${details.join(' • ')}</div>`;
                    }
                } catch (e) { /* ignore parse errors */ }
            }

            html += `
                <div class="alert-item ${alert.level}">
                    <div class="alert-item-icon">${icon}</div>
                    <div class="alert-item-content">
                        <div class="alert-item-header">
                            <div class="alert-item-title">${alert.title || 'Alert'}</div>
                            <div class="alert-item-time" title="${fullTime}">${relativeTime}</div>
                        </div>
                        ${minerName ? `<div class="alert-item-miner">${minerName}</div>` : ''}
                        <div class="alert-item-message">${alert.message}</div>
                        ${extraDetails}
                    </div>
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

// Event Listeners for Phase 4 features
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

// Energy Consumption Chart event listeners
document.getElementById('energy-chart-refresh')?.addEventListener('click', () => {
    const hours = parseInt(document.getElementById('energy-chart-timerange').value);
    loadEnergyConsumptionChart(hours);
});
document.getElementById('energy-chart-timerange')?.addEventListener('change', () => {
    const hours = parseInt(document.getElementById('energy-chart-timerange').value);
    loadEnergyConsumptionChart(hours);
});

// Load Energy Consumption History Chart
async function loadEnergyConsumptionChart(hours = 168) {
    try {
        const response = await fetch(`${API_BASE}/api/energy/consumption/actual?hours=${hours}`);
        const data = await response.json();

        const canvas = document.getElementById('energy-consumption-chart');
        if (!canvas) return;

        if (!data.success || !data.hourly_breakdown || data.hourly_breakdown.length === 0) {
            // No data available - clear chart but keep canvas, update summary to show no data
            if (energyConsumptionChart) {
                energyConsumptionChart.destroy();
                energyConsumptionChart = null;
            }
            document.getElementById('energy-chart-total').textContent = '0.00 kWh';
            document.getElementById('energy-chart-cost').textContent = '$0.00';
            document.getElementById('energy-chart-avg').textContent = '0.00 kWh';
            return;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Prepare chart data - aggregate by day if showing more than 48 hours
        let chartData;
        if (hours > 48) {
            // Aggregate by day
            const dailyData = {};
            data.hourly_breakdown.forEach(item => {
                const day = item.hour.split(' ')[0];
                if (!dailyData[day]) {
                    dailyData[day] = { kwh: 0, readings: 0 };
                }
                dailyData[day].kwh += item.kwh;
                dailyData[day].readings += item.readings;
            });
            chartData = Object.entries(dailyData).map(([date, values]) => ({
                x: new Date(date),
                y: values.kwh
            }));
        } else {
            // Hourly data
            chartData = data.hourly_breakdown.map(item => ({
                x: new Date(item.hour.replace(' ', 'T') + ':00'),
                y: item.kwh
            }));
        }

        if (energyConsumptionChart) {
            energyConsumptionChart.destroy();
        }

        energyConsumptionChart = new Chart(ctx, {
            type: 'bar',
            data: {
                datasets: [{
                    label: 'Energy Consumed',
                    data: chartData,
                    backgroundColor: 'rgba(0, 212, 255, 0.6)',
                    borderColor: 'rgba(0, 212, 255, 1)',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                const date = new Date(context[0].parsed.x);
                                return hours > 48 ? date.toLocaleDateString() : date.toLocaleString();
                            },
                            label: function(context) {
                                return `Energy: ${context.parsed.y.toFixed(3)} kWh`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: hours > 48 ? 'day' : 'hour',
                            displayFormats: {
                                hour: 'ha',
                                day: 'MMM d'
                            }
                        },
                        ticks: { color: CHART_COLORS.text },
                        grid: { color: CHART_COLORS.grid }
                    },
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Energy (kWh)',
                            color: CHART_COLORS.text
                        },
                        ticks: { color: CHART_COLORS.text },
                        grid: { color: CHART_COLORS.grid }
                    }
                }
            }
        });

        // Update summary
        const totalKwh = data.total_kwh || 0;
        const totalCost = data.total_cost || 0;
        const days = hours / 24;
        const avgDaily = days > 0 ? totalKwh / days : 0;

        document.getElementById('energy-chart-total').textContent = `${totalKwh.toFixed(2)} kWh`;
        document.getElementById('energy-chart-cost').textContent = `$${totalCost.toFixed(2)}`;
        document.getElementById('energy-chart-avg').textContent = `${avgDaily.toFixed(2)} kWh`;

    } catch (error) {
        console.error('Error loading energy consumption chart:', error);
    }
}

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
    // Main refresh interval (5 seconds) - excludes charts (they have their own interval)
    updateTimer = setInterval(() => {
        if (currentTab === 'fleet') {
            loadDashboard();
        } else if (currentTab === 'energy') {
            // Use lighter refresh that doesn't reload chart
            refreshEnergyTabData();
        } else if (currentTab === 'alerts') {
            loadAlertsTab();
        } else if (currentTab === 'pools') {
            loadPoolsTab();
        }
    }, UPDATE_INTERVAL);

    // Chart refresh interval (30 seconds) - runs independently
    chartRefreshTimer = setInterval(() => {
        // Always refresh fleet chart on dashboard - read time range from dropdown
        if (currentTab === 'fleet') {
            const fleetChartHours = parseInt(document.getElementById('fleet-chart-timerange')?.value) || 6;
            loadFleetCombinedChart(fleetChartHours);
        }
        // Refresh charts tab if active
        if (currentTab === 'charts') {
            loadChartsTab();
        }
        // Refresh energy chart if on energy tab (30-second interval)
        if (currentTab === 'energy') {
            const hours = parseInt(document.getElementById('energy-chart-timerange')?.value) || 168;
            loadEnergyConsumptionChart(hours);
        }
    }, CHART_REFRESH_INTERVAL);
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

// ============================================================================
// MINER DETAIL MODAL
// ============================================================================

let currentMinerIP = null;
let minerDetailUpdateInterval = null;

// Open the miner detail modal
function openMinerDetail(ip) {
    currentMinerIP = ip;
    const modal = document.getElementById('miner-detail-modal');
    if (!modal) return;

    // Reset to overview tab
    switchMinerTab('overview');

    // Reset voltage controls (require acknowledgment each time)
    resetVoltageControls();

    // Populate the modal with miner data
    populateMinerDetail(ip);

    // Show the modal
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Start auto-refresh for live data
    minerDetailUpdateInterval = setInterval(() => {
        if (currentMinerIP) {
            refreshMinerDetailData(currentMinerIP);
        }
    }, 5000);

    // Close on escape key
    document.addEventListener('keydown', handleModalEscape);

    // Close on overlay click
    modal.addEventListener('click', handleOverlayClick);
}

// Close the miner detail modal
function closeMinerDetail() {
    const modal = document.getElementById('miner-detail-modal');
    if (!modal) return;

    modal.style.display = 'none';
    document.body.style.overflow = '';
    currentMinerIP = null;

    // Stop auto-refresh
    if (minerDetailUpdateInterval) {
        clearInterval(minerDetailUpdateInterval);
        minerDetailUpdateInterval = null;
    }

    // Remove event listeners
    document.removeEventListener('keydown', handleModalEscape);
    modal.removeEventListener('click', handleOverlayClick);
}

function handleModalEscape(e) {
    if (e.key === 'Escape') {
        closeMinerDetail();
    }
}

function handleOverlayClick(e) {
    if (e.target.classList.contains('modal-overlay')) {
        closeMinerDetail();
    }
}

// Populate the modal with miner data
function populateMinerDetail(ip) {
    const miner = minersCache[ip];
    if (!miner) {
        console.error('Miner not found in cache:', ip);
        return;
    }

    const status = miner.last_status || miner;
    const minerStatus = status.status || 'offline';
    const isOnline = minerStatus === 'online' || minerStatus === 'overheating';
    const isOverheated = minerStatus === 'overheated';
    const isOverheating = minerStatus === 'overheating';

    // Header info
    document.getElementById('modal-miner-name').textContent = miner.custom_name || miner.model || 'Unknown Miner';
    document.getElementById('modal-miner-type').textContent = miner.model || miner.type || 'Bitcoin Miner';
    document.getElementById('modal-miner-ip').textContent = ip;

    // Status avatar - handle overheated state
    const avatarEl = document.getElementById('modal-miner-status');
    avatarEl.classList.remove('offline', 'overheated', 'overheating');
    if (isOverheated) {
        avatarEl.classList.add('overheated');
    } else if (isOverheating) {
        avatarEl.classList.add('overheating');
    } else if (!isOnline) {
        avatarEl.classList.add('offline');
    }

    // Hashrate - extract numeric value for display
    const hashrate = status.hashrate || 0;
    const hashrateFormatted = formatHashrateForModal(hashrate);
    document.getElementById('modal-hashrate').textContent = hashrateFormatted.value;
    document.getElementById('modal-hashrate-unit').textContent = hashrateFormatted.unit;

    // Temperature
    const temp = status.temperature || 0;
    document.getElementById('modal-temp').textContent = `${temp.toFixed(1)}°C`;

    // Power
    const power = status.power || 0;
    document.getElementById('modal-power').textContent = `${power.toFixed(1)} W`;

    // Efficiency (J/TH - industry standard, lower is better)
    const hashrateThs = hashrate / 1e12;
    const efficiency = hashrateThs > 0 ? (power / hashrateThs).toFixed(1) : '0';
    document.getElementById('modal-efficiency').textContent = `${efficiency} J/TH`;

    // Shares
    document.getElementById('modal-shares').textContent = formatNumber(status.shares_accepted || 0);

    // Fan speed - use formatFanSpeed to handle RPM vs percentage
    const fanSpeed = status.fan_speed || status.raw?.fanSpeedPercent || 0;
    document.getElementById('modal-fan-percent').textContent = formatFanSpeed(fanSpeed);

    // Uptime - check multiple field names for compatibility
    const uptime = status.uptime || status.uptime_seconds || status.raw?.uptimeSeconds || 0;
    document.getElementById('modal-uptime').textContent = formatUptime(uptime);

    // Pool status bar - handle overheated state
    const poolStatus = status.pool_status || (isOnline && !isOverheated ? 'Alive' : 'Dead');
    const poolBar = document.querySelector('.pool-bar');
    const poolText = document.querySelector('.pool-text');
    poolBar?.classList.remove('offline', 'overheated');
    if (isOverheated) {
        poolBar?.classList.add('overheated');
        if (poolText) poolText.textContent = 'Miner Overheated - Cooling Down';
    } else if (poolStatus.toLowerCase() === 'alive' && isOnline) {
        if (poolText) poolText.textContent = 'Pool Connected';
    } else {
        poolBar?.classList.add('offline');
        if (poolText) poolText.textContent = 'Pool Disconnected';
    }

    // Pool URL
    const poolUrl = status.pool_url || status.raw?.stratumURL || 'Not configured';
    const poolUrlEl = document.getElementById('modal-pool-url');
    if (poolUrlEl) poolUrlEl.textContent = poolUrl;

    // --- Performance Tab ---
    // Best difficulty (all-time from database)
    document.getElementById('modal-best-diff').textContent = formatDifficulty(status.best_difficulty || 0);
    // Session difficulty (current session only, don't fall back to all-time best)
    document.getElementById('modal-session-diff').textContent = formatDifficulty(status.session_difficulty || 0);

    // Live readings
    document.getElementById('modal-perf-hashrate').textContent = formatHashrate(hashrate);
    document.getElementById('modal-perf-temp').textContent = `${temp.toFixed(1)}°C`;

    const vrTemp = status.vr_temp || status.raw?.vrTemp || '--';
    document.getElementById('modal-vr-temp').textContent = typeof vrTemp === 'number' ? `${vrTemp}°C` : `${vrTemp}°C`;

    document.getElementById('modal-perf-power').textContent = `${power.toFixed(1)} W`;

    // Determine input voltage based on miner type for current calculation
    // BitAxe/NerdAxe family: 5V USB, Traditional ASICs: 12V or higher
    const minerModel = status.raw?.boardVersion || status.raw?.ASICModel || '';
    const isTraditionalASIC = /antminer|whatsminer|avalon/i.test(minerModel);
    const inputVoltage = status.raw?.inputVoltage || (isTraditionalASIC ? 12 : 5);
    const amps = power / inputVoltage;
    document.getElementById('modal-perf-current').textContent = `${amps.toFixed(2)} A`;

    const kwhDay = (power / 1000) * 24;
    document.getElementById('modal-kwh-day').textContent = `${kwhDay.toFixed(2)} kWh`;

    const fanRpm = status.fan_rpm || status.raw?.fanrpm || 0;
    document.getElementById('modal-fan-rpm').textContent = formatNumber(fanRpm);

    const wifiSignal = status.wifi_rssi || status.raw?.wifiRSSI || -65;
    document.getElementById('modal-wifi-signal').textContent = `${wifiSignal} dBm`;

    // Share stats
    document.getElementById('modal-pool-shares').textContent = formatNumber(status.shares_accepted || 0);
    document.getElementById('modal-rejected-shares').textContent = formatNumber(status.shares_rejected || 0);

    // Calculate acceptance rate
    const totalShares = (status.shares_accepted || 0) + (status.shares_rejected || 0);
    const acceptRate = totalShares > 0 ? (status.shares_accepted / totalShares) * 100 : 100;

    // Update acceptance rate gauge
    const gaugeArc = document.getElementById('acceptance-gauge-arc');
    const gaugePercent = document.getElementById('acceptance-rate-percent');
    if (gaugeArc && gaugePercent) {
        // Circumference = 2 * π * r = 2 * π * 42 ≈ 264
        const circumference = 264;
        const offset = circumference - (acceptRate / 100) * circumference;
        gaugeArc.style.strokeDashoffset = offset;
        gaugeArc.style.transition = 'stroke-dashoffset 0.5s ease';
        gaugePercent.textContent = `${acceptRate.toFixed(1)}%`;
    }

    // Legacy share bar (if still present)
    const shareBarEl = document.getElementById('share-bar-accepted');
    if (shareBarEl) shareBarEl.style.width = `${acceptRate}%`;

    // --- Tuning Tab ---
    const frequency = status.raw?.frequency || status.frequency || 525;
    const coreVoltage = status.raw?.coreVoltage || status.core_voltage || 1150;
    const voltageInMv = Math.round(coreVoltage * (coreVoltage < 100 ? 1000 : 1));

    document.getElementById('modal-frequency').textContent = `${frequency} MHz`;
    document.getElementById('modal-voltage').textContent = `${voltageInMv} mV`;

    // Set voltage input to current value
    const voltageInput = document.getElementById('voltage-input');
    if (voltageInput) {
        voltageInput.value = voltageInMv;
        updateVoltageWarning(voltageInMv);
    }

    // Update OC profile UI for this miner type
    updateOCProfileUI();

    // Update auto-optimization UI
    updateMinerOptimizeUI();

    // Initialize fan controls
    initializeFanControls(miner);

    // Footer status
    const footerStatus = document.getElementById('modal-uptime-status');
    if (footerStatus) {
        footerStatus.textContent = isOnline ? (uptime > 86400 ? 'Rock solid' : 'Running') : 'Offline';
        footerStatus.style.color = isOnline ? 'var(--success)' : 'var(--danger)';
    }

    // Load solo mining odds for this miner
    loadMinerSoloOdds(ip);
}

// Format hashrate for modal display (returns value and unit separately)
function formatHashrateForModal(hashrate) {
    if (!hashrate) return { value: '0', unit: 'H/s' };

    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    let value = hashrate;
    let unitIndex = 0;

    while (value >= 1000 && unitIndex < units.length - 1) {
        value /= 1000;
        unitIndex++;
    }

    return { value: value.toFixed(2), unit: units[unitIndex] };
}

// Switch between miner detail tabs
function switchMinerTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.miner-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelector(`.miner-tab[data-tab="${tabName}"]`)?.classList.add('active');

    // Update tab panes
    document.querySelectorAll('.miner-tab-pane').forEach(pane => {
        pane.classList.remove('active');
    });
    document.getElementById(`tab-${tabName}`)?.classList.add('active');
}

// Format uptime to human readable
function formatUptime(seconds) {
    if (!seconds || seconds === 0) return '0h';

    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) {
        return `${days}d ${hours}h`;
    } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else {
        return `${minutes}m`;
    }
}

// Refresh miner detail data
async function refreshMinerDetailData(ip) {
    try {
        const response = await fetch(`${API_BASE}/api/miners`);
        const data = await response.json();

        if (data.success && data.miners) {
            const miner = data.miners.find(m => m.ip === ip);
            if (miner) {
                // Update cache including auto_tune_enabled
                minersCache[ip] = {
                    custom_name: miner.custom_name,
                    model: miner.model,
                    type: miner.type,
                    last_status: miner.last_status || {},
                    auto_tune_enabled: miner.auto_tune_enabled || false
                };
                // Refresh display
                populateMinerDetail(ip);
            }
        }
    } catch (error) {
        console.error('Error refreshing miner detail:', error);
    }
}

// Toggle expandable sections
function toggleSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
        section.classList.toggle('expanded');
    }
}

// Restart miner from modal
function restartMinerFromModal() {
    if (currentMinerIP) {
        restartMiner(currentMinerIP);
    }
}

// Open miner's web UI
function openMinerWebUI() {
    if (currentMinerIP) {
        window.open(`http://${currentMinerIP}`, '_blank');
    }
}

// Miner-specific OC profiles with safe ranges and auto-optimization targets
// Research sources: D-Central, Solo Satoshi, AxeForge, Power Mining, GitHub repos
// Temperature targets based on: https://d-central.tech/the-complete-bitaxe-overclocking-guide-from-1-2-th-s-to-2-th-s/
const MINER_OC_PROFILES = {
    // BitAxe Ultra (BM1366) - S19XP chip
    // Stock: 485MHz/1200mV = ~425-500 GH/s, OC to 550+ GH/s
    'BitAxe Ultra': {
        chip: 'BM1366',
        hashrate: { stock: '500 GH/s', max: '650 GH/s' },
        voltage: { min: 1100, max: 1350, safe: { min: 1150, max: 1250 }, danger: 1300, stock: 1200 },
        frequency: { min: 400, max: 700, stock: 485, mild: 525, med: 575, heavy: 625 },
        power: { stock: 12, max: 25 },
        // Temperature targets for auto-optimization
        temp: { optimal: 55, efficiency: { min: 45, max: 55 }, safeMax: 65, throttle: 70, shutdown: 80 }
    },
    // BitAxe Supra (BM1368) - S21 chip, 17.5 J/TH efficiency
    'BitAxe Supra': {
        chip: 'BM1368',
        hashrate: { stock: '580 GH/s', max: '900 GH/s' },
        voltage: { min: 1100, max: 1400, safe: { min: 1150, max: 1300 }, danger: 1350, stock: 1200 },
        frequency: { min: 400, max: 800, stock: 490, mild: 550, med: 600, heavy: 700 },
        power: { stock: 15, max: 30 },
        temp: { optimal: 55, efficiency: { min: 45, max: 55 }, safeMax: 65, throttle: 70, shutdown: 80 }
    },
    // BitAxe Gamma (BM1370) - S21 Pro chip, most efficient (15 J/TH)
    'BitAxe Gamma': {
        chip: 'BM1370',
        hashrate: { stock: '1.2 TH/s', max: '2.0 TH/s' },
        voltage: { min: 1050, max: 1350, safe: { min: 1100, max: 1200 }, danger: 1250, stock: 1150 },
        frequency: { min: 400, max: 900, stock: 525, mild: 600, med: 700, heavy: 800 },
        power: { stock: 15, max: 35 },
        temp: { optimal: 55, efficiency: { min: 45, max: 55 }, safeMax: 65, throttle: 70, shutdown: 80 }
    },
    // BitAxe Hex (6x BM1366) - Multi-chip version
    'BitAxe Hex': {
        chip: '6x BM1366',
        hashrate: { stock: '3.0 TH/s', max: '4.0 TH/s' },
        voltage: { min: 1100, max: 1300, safe: { min: 1150, max: 1250 }, danger: 1280, stock: 1200 },
        frequency: { min: 400, max: 650, stock: 485, mild: 525, med: 550, heavy: 600 },
        power: { stock: 50, max: 80 },
        temp: { optimal: 55, efficiency: { min: 45, max: 55 }, safeMax: 65, throttle: 70, shutdown: 80 }
    },
    // NerdAxe (single BM1366) - Similar to BitAxe Ultra
    'NerdAxe': {
        chip: 'BM1366',
        hashrate: { stock: '500 GH/s', max: '650 GH/s' },
        voltage: { min: 1100, max: 1350, safe: { min: 1150, max: 1250 }, danger: 1300, stock: 1200 },
        frequency: { min: 400, max: 700, stock: 485, mild: 525, med: 575, heavy: 625 },
        power: { stock: 12, max: 25 },
        temp: { optimal: 55, efficiency: { min: 45, max: 55 }, safeMax: 65, throttle: 70, shutdown: 80 }
    },
    // NerdQAxe++ (4x BM1366) - Quad chip
    // 8A fuse limits to ~700MHz
    'NerdQAxe++': {
        chip: '4x BM1366',
        hashrate: { stock: '4.8 TH/s', max: '6.5 TH/s' },
        voltage: { min: 1100, max: 1300, safe: { min: 1150, max: 1250 }, danger: 1280, stock: 1200 },
        frequency: { min: 400, max: 750, stock: 490, mild: 550, med: 600, heavy: 675 },
        power: { stock: 72, max: 115 },
        temp: { optimal: 58, efficiency: { min: 50, max: 60 }, safeMax: 70, throttle: 75, shutdown: 85 }
    },
    // NerdOctaxe Gamma (8x BM1370) - Octa chip, most powerful Nerd
    'NerdOctaxe': {
        chip: '8x BM1370',
        hashrate: { stock: '9.6 TH/s', max: '10.6 TH/s' },
        voltage: { min: 1100, max: 1300, safe: { min: 1150, max: 1200 }, danger: 1250, stock: 1150 },
        frequency: { min: 500, max: 750, stock: 600, mild: 625, med: 650, heavy: 700 },
        power: { stock: 178, max: 200 },
        temp: { optimal: 55, efficiency: { min: 45, max: 55 }, safeMax: 65, throttle: 70, shutdown: 80 }
    },
    // Antminer S9 - Legacy miner (BM1387) - runs hotter
    'Antminer S9': {
        chip: 'BM1387',
        hashrate: { stock: '13.5 TH/s', max: '14.5 TH/s' },
        voltage: { min: 800, max: 950, safe: { min: 840, max: 900 }, danger: 920, stock: 860 },
        frequency: { min: 550, max: 700, stock: 650, mild: 662, med: 675, heavy: 700 },
        power: { stock: 1350, max: 1500 },
        temp: { optimal: 70, efficiency: { min: 60, max: 75 }, safeMax: 80, throttle: 85, shutdown: 95 }
    },
    // Antminer S19 - Modern miner (BM1362)
    'Antminer S19': {
        chip: 'BM1362',
        hashrate: { stock: '95 TH/s', max: '110 TH/s' },
        voltage: { min: 1100, max: 1400, safe: { min: 1200, max: 1350 }, danger: 1380, stock: 1300 },
        frequency: { min: 400, max: 600, stock: 500, mild: 525, med: 550, heavy: 575 },
        power: { stock: 3250, max: 3800 },
        temp: { optimal: 60, efficiency: { min: 50, max: 65 }, safeMax: 75, throttle: 80, shutdown: 90 }
    },
    // Whatsminer M30S
    'Whatsminer M30S': {
        chip: 'Custom ASIC',
        hashrate: { stock: '86 TH/s', max: '100 TH/s' },
        voltage: { min: 1100, max: 1400, safe: { min: 1200, max: 1350 }, danger: 1380, stock: 1300 },
        frequency: { min: 400, max: 600, stock: 480, mild: 510, med: 540, heavy: 580 },
        power: { stock: 3344, max: 4000 },
        temp: { optimal: 60, efficiency: { min: 50, max: 65 }, safeMax: 75, throttle: 80, shutdown: 90 }
    },
    // Avalon Nano 3S - A3197S chip, USB-powered compact device (~5.5 TH/s)
    'Nano3s': {
        chip: 'A3197S',
        hashrate: { stock: '5.5 TH/s', max: '6.5 TH/s' },
        voltage: { min: 1100, max: 1300, safe: { min: 1150, max: 1250 }, danger: 1280, stock: 1200 },
        frequency: { min: 400, max: 550, stock: 435, mild: 450, med: 475, heavy: 500 },
        power: { stock: 27, max: 35 },
        temp: { optimal: 75, efficiency: { min: 65, max: 80 }, safeMax: 85, throttle: 92, shutdown: 97 }
    },
    // Default fallback for unknown miners
    'default': {
        chip: 'Unknown',
        hashrate: { stock: 'N/A', max: 'N/A' },
        voltage: { min: 1000, max: 1400, safe: { min: 1100, max: 1250 }, danger: 1300, stock: 1150 },
        frequency: { min: 400, max: 700, stock: 500, mild: 550, med: 600, heavy: 650 },
        power: { stock: 15, max: 50 },
        temp: { optimal: 55, efficiency: { min: 45, max: 60 }, safeMax: 65, throttle: 70, shutdown: 80 }
    }
};

// ============================================================================
// AUTO-OPTIMIZATION ALGORITHM
// ============================================================================

// Get OC profile for a specific miner IP (not just currentMinerIP)
function getMinerOCProfileByIP(ip) {
    if (!ip || !minersCache[ip]) {
        return MINER_OC_PROFILES['default'];
    }

    const miner = minersCache[ip];
    const model = (miner.model || miner.type || '').toLowerCase();

    for (const [key, profile] of Object.entries(MINER_OC_PROFILES)) {
        if (key !== 'default' && model.includes(key.toLowerCase())) {
            return profile;
        }
    }

    // Chip-based matching
    if (model.includes('nano3s') || model.includes('nano 3s')) return MINER_OC_PROFILES['Nano3s'];
    if (model.includes('bm1370') || model.includes('gamma')) return MINER_OC_PROFILES['BitAxe Gamma'];
    if (model.includes('bm1368') || model.includes('supra')) return MINER_OC_PROFILES['BitAxe Supra'];
    if (model.includes('bm1366') || model.includes('ultra')) return MINER_OC_PROFILES['BitAxe Ultra'];
    if (model.includes('nerdqaxe') || model.includes('qaxe')) return MINER_OC_PROFILES['NerdQAxe++'];
    if (model.includes('nerdoctaxe') || model.includes('octaxe')) return MINER_OC_PROFILES['NerdOctaxe'];
    if (model.includes('nerdaxe') || model.includes('nerd')) return MINER_OC_PROFILES['NerdAxe'];
    if (model.includes('hex')) return MINER_OC_PROFILES['BitAxe Hex'];
    if (model.includes('bitaxe') || model.includes('axe')) return MINER_OC_PROFILES['BitAxe Ultra'];

    return MINER_OC_PROFILES['default'];
}

// Toggle fleet-wide auto optimization
async function toggleFleetAutoOptimize() {
    const btn = document.getElementById('auto-optimize-fleet-btn');
    const btnText = document.getElementById('auto-optimize-fleet-text');

    if (optimizationState.fleetOptimizing) {
        // Stop all optimizations
        stopAllOptimizations();
        btn.classList.remove('optimizing');
        btnText.textContent = 'Auto Optimize Fleet';
        showAlert('Fleet optimization stopped.', 'success');
    } else {
        // Start optimizing all miners
        const minerIPs = Object.keys(minersCache);
        if (minerIPs.length === 0) {
            showAlert('No miners found. Discover miners first.', 'error');
            return;
        }

        const confirmed = confirm(
            `Start auto-optimization for ${minerIPs.length} miner(s)?\n\n` +
            `This will gradually increase frequency to reach optimal temperature.\n` +
            `Fan will be set to auto. Frequency increases max +${MAX_FREQ_STEP} MHz every 5 minutes.\n\n` +
            `You can stop optimization at any time.`
        );
        if (!confirmed) return;

        optimizationState.fleetOptimizing = true;
        btn.classList.add('optimizing');
        btnText.textContent = 'Stop Optimization';

        // Start optimization for each miner
        for (const ip of minerIPs) {
            startMinerOptimization(ip);
        }

        showAlert(`Fleet optimization started for ${minerIPs.length} miner(s).`, 'success');
    }
}

// Toggle single miner auto optimization (from modal)
function toggleMinerAutoOptimize() {
    if (!currentMinerIP) return;

    const state = optimizationState.miners[currentMinerIP];

    if (state && state.active) {
        stopMinerOptimization(currentMinerIP);
        showAlert('Optimization stopped for this miner.', 'success');
    } else {
        const profile = getMinerOCProfileByIP(currentMinerIP);
        const miner = minersCache[currentMinerIP];
        const minerName = miner?.custom_name || miner?.model || currentMinerIP;

        const confirmed = confirm(
            `Start auto-optimization for ${minerName}?\n\n` +
            `Target temperature: ${profile.temp.optimal}°C\n` +
            `Frequency will increase by max +${MAX_FREQ_STEP} MHz every 5 minutes.\n\n` +
            `Optimization will stop when temperature reaches optimal range.`
        );
        if (!confirmed) return;

        startMinerOptimization(currentMinerIP);
        showAlert(`Optimization started for ${minerName}.`, 'success');
    }

    updateMinerOptimizeUI();
}

// Start optimization for a single miner
async function startMinerOptimization(ip) {
    const miner = minersCache[ip];
    if (!miner) return;

    const status = miner.last_status || {};
    const profile = getMinerOCProfileByIP(ip);

    // Initialize optimization state for this miner
    optimizationState.miners[ip] = {
        active: true,
        startTime: Date.now(),
        startFreq: status.raw?.frequency || status.frequency || profile.frequency.stock,
        startHashrate: status.hashrate || 0,
        startShares: status.shares_accepted || 0,
        startEfficiency: calculateEfficiency(status.hashrate, status.power),
        lastAdjustment: Date.now(),
        adjustmentCount: 0,
        status: 'starting'
    };

    // Save setting to backend for persistence
    saveAutoOptimizeSetting(ip, true);

    // Add optimizing class to miner card
    const cardId = `miner-card-${ip.replace(/\./g, '-')}`;
    const card = document.getElementById(cardId);
    if (card) {
        card.classList.add('optimizing');
        card.classList.remove('optimized');
    }

    // Run first optimization check immediately
    await runOptimizationCycle(ip);

    // Set up interval for ongoing optimization (check every 30 seconds, adjust every 5 min)
    optimizationState.intervals[ip] = setInterval(() => {
        runOptimizationCycle(ip);
    }, 30000); // Check every 30 seconds
}

// Stop optimization for a single miner
function stopMinerOptimization(ip) {
    if (optimizationState.intervals[ip]) {
        clearInterval(optimizationState.intervals[ip]);
        delete optimizationState.intervals[ip];
    }

    if (optimizationState.miners[ip]) {
        const wasActive = optimizationState.miners[ip].active;
        optimizationState.miners[ip].active = false;
        optimizationState.miners[ip].status = wasActive ? 'stopped' : 'idle';
    }

    // Save setting to backend for persistence
    saveAutoOptimizeSetting(ip, false);

    // Update miner card class
    const cardId = `miner-card-${ip.replace(/\./g, '-')}`;
    const card = document.getElementById(cardId);
    if (card) {
        card.classList.remove('optimizing');
        // Check if optimization achieved good results
        if (optimizationState.miners[ip]?.status === 'optimal') {
            card.classList.add('optimized');
        }
    }

    // Check if any miners are still optimizing
    const anyActive = Object.values(optimizationState.miners).some(m => m.active);
    if (!anyActive) {
        optimizationState.fleetOptimizing = false;
        updateFleetOptimizeButton();
    }
}

// Stop all optimizations
function stopAllOptimizations() {
    for (const ip of Object.keys(optimizationState.miners)) {
        stopMinerOptimization(ip);
    }
    optimizationState.fleetOptimizing = false;
}

// Main optimization cycle - runs every 30 seconds for each optimizing miner
async function runOptimizationCycle(ip) {
    const state = optimizationState.miners[ip];
    if (!state || !state.active) return;

    const miner = minersCache[ip];
    if (!miner) {
        stopMinerOptimization(ip);
        return;
    }

    // Fetch fresh data for this miner
    try {
        const response = await fetch(`${API_BASE}/api/miners`);
        const data = await response.json();
        const freshMiner = data.miners?.find(m => m.ip === ip);

        if (!freshMiner) {
            state.status = 'offline';
            updateMinerOptimizeUI();
            return;
        }

        // Update cache with fresh data
        minersCache[ip] = {
            ...minersCache[ip],
            last_status: freshMiner.last_status || freshMiner,
            auto_tune_enabled: freshMiner.auto_tune_enabled || false
        };

        const status = freshMiner.last_status || freshMiner;
        const profile = getMinerOCProfileByIP(ip);
        const currentTemp = status.temperature || 0;
        const currentFreq = status.raw?.frequency || status.frequency || profile.frequency.stock;
        const currentPower = status.power || 0;
        const currentHashrate = status.hashrate || 0;

        // Update state with current readings
        state.currentTemp = currentTemp;
        state.currentFreq = currentFreq;
        state.currentHashrate = currentHashrate;
        state.currentEfficiency = calculateEfficiency(currentHashrate, currentPower);

        // Determine action based on temperature
        const timeSinceLastAdjust = Date.now() - state.lastAdjustment;
        const canAdjust = timeSinceLastAdjust >= OPTIMIZATION_INTERVAL;

        if (currentTemp >= profile.temp.throttle) {
            // DANGER: Temperature too high - decrease frequency immediately
            state.status = 'cooling';
            if (canAdjust || currentTemp >= profile.temp.shutdown - 5) {
                await adjustMinerFrequency(ip, -MAX_FREQ_STEP * 2); // Decrease more aggressively
                state.lastAdjustment = Date.now();
            }
        } else if (currentTemp > profile.temp.safeMax) {
            // WARNING: Above safe max - decrease frequency
            state.status = 'reducing';
            if (canAdjust) {
                await adjustMinerFrequency(ip, -MAX_FREQ_STEP);
                state.lastAdjustment = Date.now();
            }
        } else if (currentTemp >= profile.temp.efficiency.min && currentTemp <= profile.temp.optimal + 3) {
            // OPTIMAL: In the sweet spot
            state.status = 'optimal';
            // Small adjustment if slightly below optimal and have headroom
            if (canAdjust && currentTemp < profile.temp.optimal - 2 && currentFreq < profile.frequency.max - MAX_FREQ_STEP) {
                await adjustMinerFrequency(ip, Math.floor(MAX_FREQ_STEP / 2)); // Smaller step when near optimal
                state.lastAdjustment = Date.now();
            }
        } else if (currentTemp < profile.temp.efficiency.min) {
            // COLD: Can increase frequency
            state.status = 'increasing';
            if (canAdjust && currentFreq < profile.frequency.max) {
                await adjustMinerFrequency(ip, MAX_FREQ_STEP);
                state.lastAdjustment = Date.now();
            }
        } else {
            // Between optimal and safeMax - holding steady
            state.status = 'stable';
        }

        // Check if we've reached max frequency
        if (currentFreq >= profile.frequency.max - 5) {
            state.status = 'max_freq';
        }

        // Update UI if modal is open for this miner
        if (currentMinerIP === ip) {
            updateMinerOptimizeUI();
        }

    } catch (error) {
        console.error(`Optimization cycle error for ${ip}:`, error);
        state.status = 'error';
    }
}

// Adjust miner frequency by delta
async function adjustMinerFrequency(ip, delta) {
    const miner = minersCache[ip];
    if (!miner) return false;

    const status = miner.last_status || {};
    const profile = getMinerOCProfileByIP(ip);
    const currentFreq = status.raw?.frequency || status.frequency || profile.frequency.stock;
    let newFreq = currentFreq + delta;

    // Clamp to valid range
    newFreq = Math.max(profile.frequency.min, Math.min(profile.frequency.max, newFreq));

    // Don't adjust if no change needed
    if (newFreq === currentFreq) return false;

    try {
        const response = await fetch(`${API_BASE}/api/miner/${ip}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frequency: newFreq })
        });

        const result = await response.json();

        if (result.success) {
            // Update cache
            if (minersCache[ip].last_status) {
                if (!minersCache[ip].last_status.raw) minersCache[ip].last_status.raw = {};
                minersCache[ip].last_status.raw.frequency = newFreq;
                minersCache[ip].last_status.frequency = newFreq;
            }

            // Update optimization state
            if (optimizationState.miners[ip]) {
                optimizationState.miners[ip].adjustmentCount++;
                optimizationState.miners[ip].currentFreq = newFreq;
            }

            console.log(`Auto-optimize: ${ip} frequency adjusted from ${currentFreq} to ${newFreq} MHz`);
            return true;
        }
    } catch (error) {
        console.error(`Failed to adjust frequency for ${ip}:`, error);
    }

    return false;
}

// Calculate efficiency (J/TH)
function calculateEfficiency(hashrate, power) {
    if (!hashrate || !power) return 0;
    const hashrateTH = hashrate / 1e12;
    return hashrateTH > 0 ? (power / hashrateTH) : 0;
}

// Update the modal optimization UI
function updateMinerOptimizeUI() {
    if (!currentMinerIP) return;

    const state = optimizationState.miners[currentMinerIP];
    const profile = getMinerOCProfileByIP(currentMinerIP);
    const miner = minersCache[currentMinerIP];
    const status = miner?.last_status || miner || {};

    // Update target temp display
    const targetTempEl = document.getElementById('modal-target-temp');
    if (targetTempEl) targetTempEl.textContent = `${profile.temp.optimal}°C`;

    // Update current temp display
    const currentTempEl = document.getElementById('modal-current-temp-opt');
    const currentTemp = status.temperature || 0;
    if (currentTempEl) {
        currentTempEl.textContent = `${currentTemp.toFixed(1)}°C`;
        currentTempEl.className = 'target-value';
        if (currentTemp >= profile.temp.throttle) {
            currentTempEl.classList.add('danger');
        } else if (currentTemp > profile.temp.safeMax) {
            currentTempEl.classList.add('warning');
        } else if (currentTemp >= profile.temp.efficiency.min && currentTemp <= profile.temp.optimal + 3) {
            currentTempEl.classList.add('optimal');
        }
    }

    // Update status display
    const statusEl = document.getElementById('modal-opt-status');
    if (statusEl) {
        const statusText = getOptimizationStatusText(state?.status || 'idle');
        statusEl.textContent = statusText;
        statusEl.className = 'target-value';
        if (state?.active) {
            statusEl.classList.add('optimizing');
        }
        if (state?.status === 'optimal') {
            statusEl.classList.add('optimal');
        }
    }

    // Update progress bar and button
    const progressEl = document.getElementById('auto-optimize-progress');
    const progressFill = document.getElementById('opt-progress-fill');
    const progressText = document.getElementById('opt-progress-text');
    const btn = document.getElementById('auto-optimize-miner-btn');
    const btnText = document.getElementById('auto-optimize-miner-text');
    const card = document.querySelector('.auto-optimize-card');

    if (state?.active) {
        // Show progress
        if (progressEl) progressEl.style.display = 'block';

        // Calculate progress based on temperature approach to optimal
        const tempDiff = Math.abs(currentTemp - profile.temp.optimal);
        const maxDiff = profile.temp.safeMax - profile.temp.efficiency.min;
        const progress = Math.max(0, Math.min(100, 100 - (tempDiff / maxDiff * 100)));

        if (progressFill) progressFill.style.width = `${progress}%`;
        if (progressText) progressText.textContent = getProgressText(state);

        // Update button to stop mode
        if (btn) btn.classList.add('stop');
        if (btnText) {
            btnText.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" class="btn-icon"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Stop Optimization`;
        }

        if (card) card.classList.add('optimizing');
    } else {
        // Hide progress, show start button
        if (progressEl) progressEl.style.display = 'none';
        if (btn) btn.classList.remove('stop');
        if (btnText) {
            btnText.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Auto Optimize`;
        }
        if (card) card.classList.remove('optimizing');
    }
}

// Get human-readable status text
function getOptimizationStatusText(status) {
    const statusMap = {
        'idle': 'Idle',
        'starting': 'Starting...',
        'increasing': 'Increasing Freq',
        'stable': 'Stable',
        'optimal': 'Optimal',
        'reducing': 'Reducing Freq',
        'cooling': 'Cooling Down',
        'max_freq': 'Max Frequency',
        'stopped': 'Stopped',
        'offline': 'Miner Offline',
        'error': 'Error'
    };
    return statusMap[status] || status;
}

// Get progress text
function getProgressText(state) {
    if (!state) return '';

    const elapsed = Math.floor((Date.now() - state.startTime) / 60000);
    const freqChange = (state.currentFreq || state.startFreq) - state.startFreq;
    const freqSign = freqChange >= 0 ? '+' : '';

    return `Running ${elapsed}m | Freq: ${freqSign}${freqChange} MHz | Adjustments: ${state.adjustmentCount || 0}`;
}

// Initialize auto-optimize button event listeners
document.addEventListener('DOMContentLoaded', function() {
    const fleetBtn = document.getElementById('auto-optimize-fleet-btn');
    if (fleetBtn) {
        fleetBtn.addEventListener('click', toggleFleetAutoOptimize);
    }
});

// Get OC profile for current miner
function getMinerOCProfile() {
    if (!currentMinerIP || !minersCache[currentMinerIP]) {
        return MINER_OC_PROFILES['default'];
    }

    const miner = minersCache[currentMinerIP];
    const model = (miner.model || miner.type || '').toLowerCase();

    // Try exact matches first
    for (const [key, profile] of Object.entries(MINER_OC_PROFILES)) {
        if (key !== 'default' && model.includes(key.toLowerCase())) {
            return profile;
        }
    }

    // Try partial/variant matches
    // BitAxe variants
    if (model.includes('ultra') || model.includes('bm1366')) return MINER_OC_PROFILES['BitAxe Ultra'];
    if (model.includes('supra') || model.includes('bm1368')) return MINER_OC_PROFILES['BitAxe Supra'];
    if (model.includes('gamma') || model.includes('bm1370') || model.includes('601')) return MINER_OC_PROFILES['BitAxe Gamma'];
    if (model.includes('hex') || model.includes('6x')) return MINER_OC_PROFILES['BitAxe Hex'];

    // NerdAxe variants
    if (model.includes('nerdoctaxe') || model.includes('octaxe') || model.includes('8x')) return MINER_OC_PROFILES['NerdOctaxe'];
    if (model.includes('nerdqaxe') || model.includes('qaxe') || model.includes('4x') || model.includes('quad')) return MINER_OC_PROFILES['NerdQAxe++'];
    if (model.includes('nerdaxe')) return MINER_OC_PROFILES['NerdAxe'];

    // Antminer variants
    if (model.includes('s19')) return MINER_OC_PROFILES['Antminer S19'];
    if (model.includes('s9') || model.includes('antminer')) return MINER_OC_PROFILES['Antminer S9'];

    // Whatsminer
    if (model.includes('whatsminer') || model.includes('m30')) return MINER_OC_PROFILES['Whatsminer M30S'];

    // Generic BitAxe fallback
    if (model.includes('bitaxe') || model.includes('axe')) return MINER_OC_PROFILES['BitAxe Ultra'];

    return MINER_OC_PROFILES['default'];
}

// Update OC UI for current miner's profile
function updateOCProfileUI() {
    const profile = getMinerOCProfile();

    // Update voltage input constraints
    const voltageInput = document.getElementById('voltage-input');
    if (voltageInput) {
        voltageInput.min = profile.voltage.min;
        voltageInput.max = profile.voltage.max;
    }

    // Update voltage range display
    const voltageRange = document.querySelector('.voltage-range');
    if (voltageRange) {
        voltageRange.innerHTML = `
            <span>Safe: ${profile.voltage.safe.min}-${profile.voltage.safe.max} mV</span>
            <span class="voltage-danger">Danger: >${profile.voltage.danger} mV</span>
        `;
    }

    // Update frequency preset buttons
    const presetButtons = document.querySelectorAll('.preset-btn');
    presetButtons.forEach(btn => {
        const preset = btn.dataset.preset;
        const freqSpan = btn.querySelector('.preset-freq');
        if (freqSpan && profile.frequency[preset]) {
            freqSpan.textContent = `${profile.frequency[preset]} MHz`;
        }
    });

    // Update custom frequency input constraints and value
    const freqInput = document.getElementById('frequency-input');
    if (freqInput) {
        freqInput.min = profile.frequency.min;
        freqInput.max = profile.frequency.max;

        // Use the miner's actual current frequency if available
        let currentFreq = profile.frequency.stock;
        if (currentMinerIP && minersCache[currentMinerIP]) {
            const minerStatus = minersCache[currentMinerIP].last_status || minersCache[currentMinerIP];
            currentFreq = minerStatus?.raw?.frequency || minerStatus?.frequency || profile.frequency.stock;
        }
        freqInput.value = currentFreq;

        // Sync preset buttons to highlight matching preset (if any)
        syncPresetButtonsWithFrequency(currentFreq);
    }

    // Update frequency range hint
    const freqRangeHint = document.getElementById('freq-range-hint');
    if (freqRangeHint) {
        freqRangeHint.textContent = `Range: ${profile.frequency.min}-${profile.frequency.max} MHz`;
    }

    // Add chip info to tuning section
    const tuningSection = document.querySelector('.voltage-section h4');
    if (tuningSection && !document.getElementById('chip-info')) {
        const chipInfo = document.createElement('span');
        chipInfo.id = 'chip-info';
        chipInfo.className = 'chip-info-badge';
        chipInfo.textContent = profile.chip;
        tuningSection.appendChild(chipInfo);
    } else if (document.getElementById('chip-info')) {
        document.getElementById('chip-info').textContent = profile.chip;
    }
}

// Set overclock preset - FREQUENCY ONLY, never auto-adjust voltage
function setOCPreset(preset) {
    const profile = getMinerOCProfile();

    // Update preset button UI
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`.preset-btn[data-preset="${preset}"]`)?.classList.add('active');

    // Get frequency from profile
    const frequency = profile.frequency[preset] || profile.frequency.stock;

    // Sync all frequency displays
    document.getElementById('modal-frequency').textContent = `${frequency} MHz`;

    // Sync custom frequency input field
    const freqInput = document.getElementById('frequency-input');
    if (freqInput) {
        freqInput.value = frequency;
    }

    showAlert(`Frequency preset "${preset}" selected (${frequency} MHz). Click Apply to send to miner.`, 'success');
}

// Toggle voltage controls visibility based on acknowledgment checkbox
function toggleVoltageControls() {
    const checkbox = document.getElementById('voltage-risk-checkbox');
    const controls = document.getElementById('voltage-controls');
    const acknowledge = document.getElementById('voltage-acknowledge');

    if (checkbox && checkbox.checked) {
        controls.style.display = 'block';
        acknowledge.style.display = 'none';
    } else {
        controls.style.display = 'none';
        acknowledge.style.display = 'block';
    }
}

// Adjust voltage by increment (uses miner-specific bounds)
function adjustVoltage(delta) {
    const input = document.getElementById('voltage-input');
    if (!input) return;

    const profile = getMinerOCProfile();
    let value = parseInt(input.value) || profile.voltage.stock;
    value += delta;

    // Clamp to miner-specific range
    value = Math.max(profile.voltage.min, Math.min(profile.voltage.max, value));
    input.value = value;

    // Update visual warning for dangerous values
    updateVoltageWarning(value);
}

// Update voltage input warning state (uses miner-specific profile)
function updateVoltageWarning(value) {
    const input = document.getElementById('voltage-input');
    if (!input) return;

    const profile = getMinerOCProfile();
    const dangerThreshold = profile.voltage.danger;

    if (value > dangerThreshold) {
        input.classList.add('danger');
    } else {
        input.classList.remove('danger');
    }
}

// Apply voltage change to miner
async function applyVoltage() {
    const input = document.getElementById('voltage-input');
    if (!input || !currentMinerIP) return;

    const voltage = parseInt(input.value);
    const profile = getMinerOCProfile();
    const miner = minersCache[currentMinerIP];
    const minerName = miner?.model || miner?.type || 'this miner';

    // Validate against miner-specific bounds
    if (voltage < profile.voltage.min || voltage > profile.voltage.max) {
        showAlert(`Voltage ${voltage} mV is outside valid range for ${minerName} (${profile.voltage.min}-${profile.voltage.max} mV)`, 'error');
        return;
    }

    // Extra confirmation for dangerous voltage levels (miner-specific)
    if (voltage > profile.voltage.danger) {
        const confirmed = confirm(
            `⚠️ EXTREME DANGER for ${minerName}!\n\n` +
            `${voltage} mV exceeds safe limit (${profile.voltage.danger} mV) for ${profile.chip} chip(s).\n\n` +
            `This voltage level can:\n` +
            `• Permanently destroy your ASIC chips\n` +
            `• Cause overheating and fire risk\n` +
            `• Void any warranty immediately\n\n` +
            `Are you ABSOLUTELY SURE you want to apply ${voltage} mV?`
        );
        if (!confirmed) return;
    } else if (voltage < profile.voltage.safe.min) {
        const confirmed = confirm(
            `⚠️ WARNING: ${voltage} mV is below recommended range for ${minerName}.\n\n` +
            `Safe range for ${profile.chip}: ${profile.voltage.safe.min}-${profile.voltage.safe.max} mV\n\n` +
            `Low voltage may cause:\n` +
            `• Unstable operation\n` +
            `• Increased error rates\n` +
            `• Reduced hashrate\n\n` +
            `Continue with ${voltage} mV?`
        );
        if (!confirmed) return;
    } else if (voltage > profile.voltage.safe.max) {
        const confirmed = confirm(
            `⚠️ CAUTION: ${voltage} mV is above recommended safe range for ${minerName}.\n\n` +
            `Safe range for ${profile.chip}: ${profile.voltage.safe.min}-${profile.voltage.safe.max} mV\n\n` +
            `Higher voltage increases heat and reduces chip lifespan.\n\n` +
            `Continue with ${voltage} mV?`
        );
        if (!confirmed) return;
    } else {
        const confirmed = confirm(
            `Apply voltage: ${voltage} mV to ${minerName}?\n\n` +
            `This is within the safe range for ${profile.chip}.`
        );
        if (!confirmed) return;
    }

    try {
        // Send voltage change to miner
        const response = await fetch(`${API_BASE}/api/miner/${currentMinerIP}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ coreVoltage: voltage })
        });

        const result = await response.json();

        if (result.success) {
            showAlert(`Voltage set to ${voltage} mV. Miner may restart.`, 'success');

            // Update modal display
            document.getElementById('modal-voltage').textContent = `${voltage} mV`;

            // Update cache with new voltage
            if (minersCache[currentMinerIP]) {
                if (!minersCache[currentMinerIP].last_status) {
                    minersCache[currentMinerIP].last_status = {};
                }
                if (!minersCache[currentMinerIP].last_status.raw) {
                    minersCache[currentMinerIP].last_status.raw = {};
                }
                minersCache[currentMinerIP].last_status.raw.coreVoltage = voltage;
                minersCache[currentMinerIP].last_status.core_voltage = voltage;
            }

            // Update the miner card in the fleet view
            updateMinerCardData(currentMinerIP);
        } else {
            showAlert(`Failed to set voltage: ${result.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        showAlert(`Error applying voltage: ${error.message}`, 'error');
    }
}

// ============================================================================
// FAN CONTROL FUNCTIONS
// ============================================================================

// Set fan control mode (manual or auto)
function setFanMode(mode) {
    const manualBtn = document.getElementById('fan-mode-manual-btn');
    const autoBtn = document.getElementById('fan-mode-auto-btn');
    const manualControls = document.getElementById('fan-manual-controls');
    const autoControls = document.getElementById('fan-auto-controls');

    if (mode === 'auto') {
        manualBtn?.classList.remove('active');
        autoBtn?.classList.add('active');
        if (manualControls) manualControls.style.display = 'none';
        if (autoControls) autoControls.style.display = 'block';
    } else {
        manualBtn?.classList.add('active');
        autoBtn?.classList.remove('active');
        if (manualControls) manualControls.style.display = 'block';
        if (autoControls) autoControls.style.display = 'none';
    }
}

// Update fan slider display value
function updateFanSliderValue() {
    const slider = document.getElementById('fan-speed-slider');
    const valueDisplay = document.getElementById('fan-speed-value');
    if (slider && valueDisplay) {
        valueDisplay.textContent = `${slider.value}%`;
    }
}

// Apply manual fan speed to miner
async function applyFanSpeed() {
    const slider = document.getElementById('fan-speed-slider');
    if (!slider || !currentMinerIP) return;

    const fanSpeed = parseInt(slider.value);
    const miner = minersCache[currentMinerIP];
    const minerName = miner?.custom_name || miner?.model || miner?.type || 'this miner';

    try {
        const response = await fetch(`${API_BASE}/api/miner/${currentMinerIP}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fanSpeed: fanSpeed })
        });

        const result = await response.json();

        if (result.success) {
            showAlert(`Fan speed set to ${fanSpeed}% for ${minerName}`, 'success');

            // Update the current fan status display
            document.getElementById('current-fan-status').textContent = `${fanSpeed}%`;

            // Update cache
            if (minersCache[currentMinerIP]) {
                if (!minersCache[currentMinerIP].last_status) {
                    minersCache[currentMinerIP].last_status = {};
                }
                if (!minersCache[currentMinerIP].last_status.raw) {
                    minersCache[currentMinerIP].last_status.raw = {};
                }
                minersCache[currentMinerIP].last_status.fan_speed = fanSpeed;
                minersCache[currentMinerIP].last_status.raw.fanSpeedPercent = fanSpeed;
                // Manual fan speed disables auto fan mode
                minersCache[currentMinerIP].last_status.raw.autofanspeed = 0;
            }

            // Update the miner card in the fleet view
            updateMinerCardData(currentMinerIP);
        } else {
            showAlert(`Failed to set fan speed: ${result.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        showAlert(`Error applying fan speed: ${error.message}`, 'error');
    }
}

// Apply auto fan control with optimal target temperature for this miner type
async function applyAutoFan() {
    if (!currentMinerIP) return;

    const miner = minersCache[currentMinerIP];
    const minerName = miner?.custom_name || miner?.model || miner?.type || 'this miner';
    const thermalProfile = getThermalProfile(miner?.type || miner?.model);
    const targetTemp = thermalProfile.target;

    try {
        const response = await fetch(`${API_BASE}/api/miner/${currentMinerIP}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                autofanspeed: 1,
                targetTemp: targetTemp
            })
        });

        const result = await response.json();

        if (result.success) {
            showAlert(`Auto fan enabled for ${minerName}. Target: ${targetTemp}°C`, 'success');

            // Update the current fan status display
            const fanStatus = document.getElementById('current-fan-status');
            if (fanStatus) fanStatus.textContent = `Auto (${targetTemp}°C)`;

            // Update cache
            if (minersCache[currentMinerIP]) {
                if (!minersCache[currentMinerIP].last_status) {
                    minersCache[currentMinerIP].last_status = {};
                }
                if (!minersCache[currentMinerIP].last_status.raw) {
                    minersCache[currentMinerIP].last_status.raw = {};
                }
                minersCache[currentMinerIP].last_status.raw.autofanspeed = 1;
                minersCache[currentMinerIP].last_status.raw.targetTemp = targetTemp;
            }
        } else {
            showAlert(`Failed to enable auto fan: ${result.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        showAlert(`Error enabling auto fan: ${error.message}`, 'error');
    }
}

// Thermal profiles for different miner types (based on thermal.py research)
// target = middle-upper of optimal zone (70% between optimal and warning)
// Thermal profiles based on comprehensive research
// Sources: solosatoshi.com, d-central.tech, mineshop.eu, zeusbtc.com, bitmain.com
// Smaller devices = less cooling capacity = lower optimal temp targets
// Traditional ASIC miners measure board temp (higher thresholds)
const THERMAL_PROFILES = {
    // Single-chip BitAxe family (small 40mm heatsink + tiny fan)
    'BitAxe': { optimal: 55, warning: 62, critical: 68, target: 58 },
    'BitAxe Max': { optimal: 55, warning: 62, critical: 68, target: 58 },        // BM1397
    'BitAxe Ultra': { optimal: 55, warning: 62, critical: 68, target: 58 },      // BM1366
    'BitAxe Supra': { optimal: 55, warning: 63, critical: 69, target: 58 },      // BM1368, better heat dissipation
    'BitAxe Gamma': { optimal: 55, warning: 63, critical: 70, target: 58 },      // BM1370, most efficient
    'NerdAxe': { optimal: 55, warning: 62, critical: 68, target: 58 },           // Single BM1366

    // Multi-chip devices (better cooling infrastructure)
    'BitAxe Hex': { optimal: 52, warning: 60, critical: 68, target: 55 },        // 6x BM1366, 45-55°C optimal
    'NerdQAxe+': { optimal: 55, warning: 63, critical: 70, target: 58 },         // 4x BM1366
    'NerdQAxe++': { optimal: 55, warning: 63, critical: 70, target: 58 },        // 4x BM1370
    'NerdOctaxe': { optimal: 55, warning: 62, critical: 68, target: 58 },        // 8x BM1370, dual 120mm fans

    // LuckyMiner (ESP-Miner based)
    'LuckyMiner': { optimal: 55, warning: 62, critical: 68, target: 58 },

    // Traditional ASIC miners (measure board/PCB temp, not chip temp)
    'Antminer': { optimal: 70, warning: 80, critical: 85, target: 75 },          // PCB temp
    'Antminer S9': { optimal: 70, warning: 80, critical: 85, target: 75 },       // Max PCB 85-95°C
    'Antminer S19': { optimal: 65, warning: 75, critical: 80, target: 70 },      // Max PCB 75-85°C
    'Whatsminer': { optimal: 65, warning: 75, critical: 80, target: 70 },        // Warning at 80°C
    'Avalon': { optimal: 65, warning: 75, critical: 80, target: 70 },

    // Avalon Nano 3S - A3197S chip, USB-powered compact device
    // Small form factor with limited cooling, target 75°C
    'Nano3s': { optimal: 75, warning: 85, critical: 92, target: 75 },           // Manufacturer recommended target

    'default': { optimal: 55, warning: 62, critical: 68, target: 58 }
};

// Get thermal profile for a miner type
function getThermalProfile(minerType) {
    if (!minerType) return THERMAL_PROFILES['default'];

    // Try exact match first
    if (THERMAL_PROFILES[minerType]) {
        return THERMAL_PROFILES[minerType];
    }

    // Try partial match (check specific models before generic ones)
    const typeUpper = minerType.toUpperCase();
    if (typeUpper.includes('NERDOCTAXE')) return THERMAL_PROFILES['NerdOctaxe'];
    if (typeUpper.includes('NERDQAXE')) return THERMAL_PROFILES['NerdQAxe+'];
    if (typeUpper.includes('NERDAXE')) return THERMAL_PROFILES['NerdAxe'];
    if (typeUpper.includes('BITAXE')) return THERMAL_PROFILES['BitAxe'];
    if (typeUpper.includes('ANTMINER')) return THERMAL_PROFILES['Antminer'];
    if (typeUpper.includes('WHATSMINER')) return THERMAL_PROFILES['Whatsminer'];
    // Check for Avalon Nano 3S before generic Avalon
    if (typeUpper.includes('NANO3S') || typeUpper.includes('NANO 3S')) return THERMAL_PROFILES['Nano3s'];
    if (typeUpper.includes('AVALON')) return THERMAL_PROFILES['Avalon'];

    return THERMAL_PROFILES['default'];
}

// Initialize fan controls when modal opens
function initializeFanControls(miner) {
    const status = miner?.last_status || {};
    const raw = status.raw || {};

    // Check if auto-tuning is managing this miner (uses auto fan control)
    const autoTuneEnabled = miner?.auto_tune_enabled === true;
    // Check if miner's native auto fan is enabled
    const nativeAutoFan = raw.autofanspeed === 1;
    // Either auto-tuning OR native auto fan means fan is in auto mode
    const isAutoFan = autoTuneEnabled || nativeAutoFan;

    // Get thermal profile for this miner type
    const thermalProfile = getThermalProfile(miner?.type || miner?.model);

    // Set current fan speed display
    const currentFanStatus = document.getElementById('current-fan-status');
    if (currentFanStatus) {
        if (isAutoFan) {
            const targetTemp = raw.targetTemp || thermalProfile.target || 60;
            currentFanStatus.textContent = `Auto (${targetTemp}°C)`;
        } else {
            const fanSpeed = status.fan_speed ?? raw.fanSpeedPercent ?? '--';
            currentFanStatus.textContent = `${fanSpeed}%`;
        }
    }

    // Set slider to current fan speed
    const slider = document.getElementById('fan-speed-slider');
    const valueDisplay = document.getElementById('fan-speed-value');
    if (slider && valueDisplay) {
        const fanSpeed = status.fan_speed ?? raw.fanSpeedPercent ?? 50;
        slider.value = Math.max(20, fanSpeed); // Ensure minimum of 20
        valueDisplay.textContent = `${Math.max(20, fanSpeed)}%`;
    }

    // Set the auto fan target temperature display
    const targetTempDisplay = document.getElementById('auto-fan-target-temp');
    if (targetTempDisplay) {
        targetTempDisplay.textContent = `${thermalProfile.target}°C`;
    }

    // Show/hide auto-tune notice and enable button based on state
    const autoTuneNotice = document.getElementById('auto-tune-fan-notice');
    const enableAutoFanBtn = document.getElementById('enable-auto-fan-btn');
    if (autoTuneNotice && enableAutoFanBtn) {
        if (autoTuneEnabled) {
            // Auto-tuning is managing fan - show notice, hide button
            autoTuneNotice.style.display = 'flex';
            enableAutoFanBtn.style.display = 'none';
        } else {
            // Auto-tuning not active - hide notice, show button
            autoTuneNotice.style.display = 'none';
            enableAutoFanBtn.style.display = 'flex';
        }
    }

    // Set mode based on current state - auto if either auto-tuning or native auto fan
    if (isAutoFan) {
        setFanMode('auto');
    } else {
        setFanMode('manual');
    }
}

// Adjust frequency by increment (uses miner-specific bounds)
function adjustFrequency(delta) {
    const input = document.getElementById('frequency-input');
    if (!input) return;

    const profile = getMinerOCProfile();
    let value = parseInt(input.value) || profile.frequency.stock;
    value += delta;

    // Clamp to miner-specific range
    value = Math.max(profile.frequency.min, Math.min(profile.frequency.max, value));
    input.value = value;

    // Sync preset buttons - will select matching preset or deselect all
    syncPresetButtonsWithFrequency(value);
}

// Apply custom frequency to miner
async function applyFrequency() {
    const input = document.getElementById('frequency-input');
    if (!input || !currentMinerIP) return;

    const frequency = parseInt(input.value);
    const profile = getMinerOCProfile();
    const miner = minersCache[currentMinerIP];
    const minerName = miner?.model || miner?.type || 'this miner';

    // Validate against miner-specific bounds
    if (frequency < profile.frequency.min || frequency > profile.frequency.max) {
        showAlert(`Frequency ${frequency} MHz is outside valid range for ${minerName} (${profile.frequency.min}-${profile.frequency.max} MHz)`, 'error');
        return;
    }

    // Warning for frequencies above "heavy" preset
    if (frequency > profile.frequency.heavy) {
        const confirmed = confirm(
            `⚠️ HIGH FREQUENCY WARNING for ${minerName}\n\n` +
            `${frequency} MHz exceeds the "Heavy" preset (${profile.frequency.heavy} MHz).\n\n` +
            `Running at very high frequencies may:\n` +
            `• Increase chip temperature significantly\n` +
            `• Cause instability and errors\n` +
            `• Require additional cooling\n\n` +
            `Continue with ${frequency} MHz?`
        );
        if (!confirmed) return;
    }

    const confirmed = confirm(`Apply frequency: ${frequency} MHz to ${minerName}?`);
    if (!confirmed) return;

    try {
        const response = await fetch(`${API_BASE}/api/miner/${currentMinerIP}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frequency: frequency })
        });

        const result = await response.json();

        if (result.success) {
            showAlert(`Frequency set to ${frequency} MHz. Miner may restart.`, 'success');

            // Update modal display
            document.getElementById('modal-frequency').textContent = `${frequency} MHz`;

            // Update cache with new frequency
            if (minersCache[currentMinerIP]) {
                if (!minersCache[currentMinerIP].last_status) {
                    minersCache[currentMinerIP].last_status = {};
                }
                if (!minersCache[currentMinerIP].last_status.raw) {
                    minersCache[currentMinerIP].last_status.raw = {};
                }
                minersCache[currentMinerIP].last_status.raw.frequency = frequency;
                minersCache[currentMinerIP].last_status.frequency = frequency;
            }

            // Update preset button selection based on whether freq matches a preset
            syncPresetButtonsWithFrequency(frequency);

            // Update the miner card in the fleet view
            updateMinerCardData(currentMinerIP);
        } else {
            showAlert(`Failed to set frequency: ${result.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        showAlert(`Error applying frequency: ${error.message}`, 'error');
    }
}

// Sync preset buttons with a given frequency value
// Selects matching preset or deselects all if custom value
function syncPresetButtonsWithFrequency(frequency) {
    const profile = getMinerOCProfile();

    // Check if frequency matches any preset
    const presets = ['stock', 'mild', 'med', 'heavy'];
    let matchingPreset = null;

    for (const preset of presets) {
        if (profile.frequency[preset] === frequency) {
            matchingPreset = preset;
            break;
        }
    }

    // Update preset buttons
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    if (matchingPreset) {
        document.querySelector(`.preset-btn[data-preset="${matchingPreset}"]`)?.classList.add('active');
    }
}

// Update a single miner card in the fleet view without reloading all miners
function updateMinerCardData(ip) {
    const miner = minersCache[ip];
    if (!miner) return;

    const cardId = `miner-card-${ip.replace(/\./g, '-')}`;
    const card = document.getElementById(cardId);
    if (!card) return;

    const status = miner.last_status || miner;
    const minerStatus = status.status || 'offline';
    const isOnline = minerStatus === 'online' || minerStatus === 'overheating';
    const isOverheated = minerStatus === 'overheated';
    const isOverheating = minerStatus === 'overheating';

    // Update miner name
    const displayName = miner.custom_name || miner.model || miner.type || 'Unknown';
    const nameEl = card.querySelector('.miner-name');
    if (nameEl && nameEl.textContent !== displayName) {
        nameEl.textContent = displayName;
    }

    // Update edit name button onclick with new name
    const editBtn = card.querySelector('.edit-name-btn');
    if (editBtn) {
        const escapedName = (miner.custom_name || '').replace(/'/g, "\\'");
        editBtn.setAttribute('onclick', `editMinerName('${ip}', '${escapedName}')`);
    }

    // Update status classes
    card.classList.remove('offline', 'overheated', 'overheating');
    if (isOverheated) {
        card.classList.add('overheated');
    } else if (isOverheating) {
        card.classList.add('overheating');
    } else if (!isOnline) {
        card.classList.add('offline');
    }

    // Update optimization badge
    const isOptimizing = optimizationState.miners[ip]?.active === true;
    const isOptimized = optimizationState.miners[ip]?.status === 'optimal';

    card.classList.remove('optimizing', 'optimized');
    if (isOptimizing && !isOverheated) {
        card.classList.add('optimizing');
    } else if (isOptimized && !isOverheated) {
        card.classList.add('optimized');
    }

    // Update badge in header
    const badgesContainer = card.querySelector('.miner-badges');
    if (badgesContainer) {
        // Remove existing badges
        let statusBadge = badgesContainer.querySelector('.status-badge');
        let optBadge = badgesContainer.querySelector('.optimization-badge');

        // Handle status badges (overheated/overheating take priority)
        if (isOverheated) {
            if (optBadge) optBadge.remove();
            if (!statusBadge) {
                statusBadge = document.createElement('span');
                statusBadge.className = 'status-badge overheated';
                badgesContainer.insertBefore(statusBadge, badgesContainer.firstChild);
            } else {
                statusBadge.className = 'status-badge overheated';
            }
            statusBadge.textContent = 'OVERHEATED';
        } else if (isOverheating) {
            if (optBadge) optBadge.remove();
            if (!statusBadge) {
                statusBadge = document.createElement('span');
                statusBadge.className = 'status-badge overheating';
                badgesContainer.insertBefore(statusBadge, badgesContainer.firstChild);
            } else {
                statusBadge.className = 'status-badge overheating';
            }
            statusBadge.textContent = 'OVERHEATING';
        } else {
            // Remove status badge if not overheated/overheating
            if (statusBadge) statusBadge.remove();

            // Handle optimization badges
            if (isOptimizing) {
                if (!optBadge) {
                    optBadge = document.createElement('span');
                    optBadge.className = 'optimization-badge tuning';
                    badgesContainer.insertBefore(optBadge, badgesContainer.firstChild);
                } else {
                    optBadge.className = 'optimization-badge tuning';
                }
                optBadge.textContent = 'AUTO-TUNING';
            } else if (isOptimized) {
                if (!optBadge) {
                    optBadge = document.createElement('span');
                    optBadge.className = 'optimization-badge optimized';
                    badgesContainer.insertBefore(optBadge, badgesContainer.firstChild);
                } else {
                    optBadge.className = 'optimization-badge optimized';
                }
                optBadge.textContent = 'OPTIMIZED';
            } else if (optBadge) {
                optBadge.remove();
            }
        }
    }

    // Check for state transitions that require rebuilding the card content
    const statsContainer = card.querySelector('.miner-stats');
    const overheatedContainer = card.querySelector('.status-overheated');
    const offlineContainer = card.querySelector('.status-offline');

    // Determine what content type should be showing
    const shouldShowStats = isOnline && !isOverheated;
    const shouldShowOverheated = isOverheated;
    const shouldShowOffline = !isOnline && !isOverheated;

    // Check if current content matches expected state
    const hasCorrectContent =
        (shouldShowStats && statsContainer) ||
        (shouldShowOverheated && overheatedContainer) ||
        (shouldShowOffline && offlineContainer);

    if (!hasCorrectContent) {
        // State changed - rebuild the content section
        // Find the content area (after chip-type, before miner-actions)
        const chipType = card.querySelector('.chip-type');
        const actions = card.querySelector('.miner-actions');

        if (chipType && actions) {
            // Remove old content
            if (statsContainer) statsContainer.remove();
            if (overheatedContainer) overheatedContainer.remove();
            if (offlineContainer) offlineContainer.remove();

            // Create new content based on status
            let newContent;
            if (shouldShowOverheated) {
                newContent = document.createElement('div');
                newContent.className = 'status-overheated';
                newContent.style.textAlign = 'center';
                newContent.style.padding = '20px';
                newContent.innerHTML = `
                    <div style="font-size: 2em; margin-bottom: 10px;">🔥</div>
                    <div style="color: #ff4444; font-weight: bold;">DEVICE OVERHEATED</div>
                    <div style="color: #888; font-size: 0.9em; margin-top: 5px;">Cooling down...</div>
                `;
            } else if (shouldShowStats) {
                newContent = document.createElement('div');
                newContent.className = 'miner-stats';
                newContent.innerHTML = `
                    <div class="miner-stat">
                        <span class="miner-stat-label">Hashrate</span>
                        <span class="miner-stat-value">${formatHashrate(status.hashrate)}</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Temperature</span>
                        <span class="miner-stat-value ${isOverheating ? 'temp-warning' : ''}">${status.temperature?.toFixed(1) || 'N/A'}°C</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Power</span>
                        <span class="miner-stat-value">${status.power?.toFixed(1) || 'N/A'} W</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Efficiency <span class="help-icon" onclick="showEfficiencyTooltip(event)" title="What is J/TH?">?</span></span>
                        <span class="miner-stat-value efficiency-help ${getEfficiencyClass(status.hashrate, status.power)}">${formatEfficiency(status.hashrate, status.power)}</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Fan Speed</span>
                        <span class="miner-stat-value">${formatFanSpeed(status.fan_speed)}</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Shares Found</span>
                        <span class="miner-stat-value">${formatNumber(status.shares_accepted || 0)}</span>
                    </div>
                    <div class="miner-stat">
                        <span class="miner-stat-label">Best Difficulty</span>
                        <span class="miner-stat-value">${formatDifficulty(status.best_difficulty || 0)}</span>
                    </div>
                `;
            } else {
                newContent = document.createElement('div');
                newContent.className = 'status-offline';
                newContent.style.textAlign = 'center';
                newContent.style.padding = '20px';
                newContent.textContent = '⚠️ Offline';
            }

            // Insert before actions
            card.insertBefore(newContent, actions);
        }
    } else if (shouldShowStats && statsContainer) {
        // Just update stats in place (order: Hashrate, Temp, Power, Efficiency, Fan, Shares, Difficulty)
        const hashrateEl = statsContainer.querySelector('.miner-stat:nth-child(1) .miner-stat-value');
        if (hashrateEl) hashrateEl.textContent = formatHashrate(status.hashrate || 0);

        const tempEl = statsContainer.querySelector('.miner-stat:nth-child(2) .miner-stat-value');
        if (tempEl) tempEl.textContent = `${(status.temperature || 0).toFixed(1)}°C`;

        const powerEl = statsContainer.querySelector('.miner-stat:nth-child(3) .miner-stat-value');
        if (powerEl) powerEl.textContent = `${(status.power || 0).toFixed(1)} W`;

        const efficiencyEl = statsContainer.querySelector('.miner-stat:nth-child(4) .miner-stat-value');
        if (efficiencyEl) {
            efficiencyEl.textContent = formatEfficiency(status.hashrate, status.power);
            efficiencyEl.className = 'miner-stat-value ' + getEfficiencyClass(status.hashrate, status.power);
        }

        const fanEl = statsContainer.querySelector('.miner-stat:nth-child(5) .miner-stat-value');
        if (fanEl) fanEl.textContent = formatFanSpeed(status.fan_speed);

        const sharesEl = statsContainer.querySelector('.miner-stat:nth-child(6) .miner-stat-value');
        if (sharesEl) sharesEl.textContent = formatNumber(status.shares_accepted || 0);

        const diffEl = statsContainer.querySelector('.miner-stat:nth-child(7) .miner-stat-value');
        if (diffEl) diffEl.textContent = formatDifficulty(status.best_difficulty || 0);
    }
}

// Reset voltage controls when modal opens
function resetVoltageControls() {
    const checkbox = document.getElementById('voltage-risk-checkbox');
    const controls = document.getElementById('voltage-controls');
    const acknowledge = document.getElementById('voltage-acknowledge');

    if (checkbox) checkbox.checked = false;
    if (controls) controls.style.display = 'none';
    if (acknowledge) acknowledge.style.display = 'block';
}

// Initialize input listeners (called once on page load)
document.addEventListener('DOMContentLoaded', function() {
    // Voltage input - update warning state as user types
    const voltageInput = document.getElementById('voltage-input');
    if (voltageInput) {
        voltageInput.addEventListener('input', function() {
            const value = parseInt(this.value) || 0;
            updateVoltageWarning(value);
        });
    }

    // Frequency input - sync preset buttons as user types
    const frequencyInput = document.getElementById('frequency-input');
    if (frequencyInput) {
        frequencyInput.addEventListener('input', function() {
            const value = parseInt(this.value) || 0;
            syncPresetButtonsWithFrequency(value);
        });
    }
});

// Open overclock settings - scrolls to tuning tab
function openOCSettings() {
    switchMinerTab('tuning');
}
