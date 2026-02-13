// DirtySats - Bitcoin Mining Fleet Manager
const API_BASE = '';
const UPDATE_INTERVAL = 5000; // 5 seconds

// CSRF Protection: Wrap fetch to auto-include CSRF token on state-changing requests
(function() {
    const originalFetch = window.fetch;
    function getCsrfToken() {
        const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
        return match ? match[1] : '';
    }
    window.fetch = function(url, options) {
        options = options || {};
        if (options.method && options.method.toUpperCase() !== 'GET') {
            if (!options.headers) {
                options.headers = {};
            }
            if (options.headers instanceof Headers) {
                if (!options.headers.has('X-CSRF-Token')) {
                    options.headers.set('X-CSRF-Token', getCsrfToken());
                }
            } else {
                if (!options.headers['X-CSRF-Token']) {
                    options.headers['X-CSRF-Token'] = getCsrfToken();
                }
            }
        }
        return originalFetch.call(this, url, options);
    };
})();
const CHART_REFRESH_INTERVAL = 30000; // 30 seconds for chart updates
const OPTIMIZATION_INTERVAL = 300000; // 5 minutes between frequency adjustments
const MAX_FREQ_STEP = 25; // Maximum frequency increase per step (MHz)

let updateTimer = null;
let chartRefreshTimer = null;
let currentTab = 'fleet';
let minersCache = {}; // Cache for miner data including nicknames
let deviceSpecsCache = null; // Cache for device_specifications.json data
let isUserEditingFrequency = false; // Track if user is actively editing frequency
let isUserEditingVoltage = false; // Track if user is actively editing voltage
let lastSetTargetFrequency = {}; // Per-IP target frequency tracking: { ip: freq }
let scoringSharesCache = {}; // Cache for per-miner scoring shares: { ip: score }

// ============================================================================
// FLEET DATA CACHE - Single fetch per update cycle
// ============================================================================
let fleetDataCache = {
    stats: null,        // /api/stats response
    miners: null,       // /api/miners response
    profitability: null, // /api/energy/profitability response
    lastFetch: 0        // timestamp of last fetch
};

// Fetch all fleet data once per cycle, store in cache
async function refreshFleetData() {
    const results = await Promise.allSettled([
        fetch(`${API_BASE}/api/stats`).then(r => r.json()),
        fetch(`${API_BASE}/api/miners`).then(r => r.json()),
        fetch(`${API_BASE}/api/energy/profitability`).then(r => r.json())
    ]);

    const [statsResult, minersResult, profResult] = results;

    if (statsResult.status === 'fulfilled' && statsResult.value.success) {
        fleetDataCache.stats = statsResult.value.stats;
    }
    if (minersResult.status === 'fulfilled' && minersResult.value.success) {
        fleetDataCache.miners = minersResult.value.miners || [];
    }
    if (profResult.status === 'fulfilled' && profResult.value.success) {
        fleetDataCache.profitability = profResult.value.profitability || null;
    }
    fleetDataCache.lastFetch = Date.now();

    return fleetDataCache;
}

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
// DEVICE SPECIFICATIONS HELPERS
// ============================================================================

// Fetch and cache device_specifications.json from backend
async function loadDeviceSpecs() {
    if (deviceSpecsCache) return deviceSpecsCache;
    try {
        const response = await fetch(`${API_BASE}/api/miner-specs`);
        const result = await response.json();
        if (result.success && result.data && result.data.devices) {
            deviceSpecsCache = result.data.devices;
        }
    } catch (error) {
        console.error('Error loading device specs:', error);
    }
    return deviceSpecsCache;
}

// Map a miner model/type string to a device_specifications.json key
function getDeviceSpecKey(miner) {
    if (!miner) return null;
    const model = (miner.model || miner.type || '').toLowerCase();
    const asicChip = (miner.last_status?.raw?.ASICModel || miner.last_status?.asic_model || '').toLowerCase();
    const numChips = miner.last_status?.raw?.asicCount || miner.last_status?.asic_count || 1;

    // Check for Hex variants first (multi-chip BitAxe)
    if (model.includes('hex') && (model.includes('supra') || asicChip.includes('bm1368'))) return 'bitaxe_hex_supra';
    if (model.includes('hex') && (model.includes('gamma') || asicChip.includes('bm1370'))) return 'bitaxe_hex_gamma';
    if (model.includes('hex')) return 'bitaxe_hex_ultra';

    // NerdOctaxe
    if (model.includes('nerdoctaxe') || model.includes('octaxe')) return 'nerdoctaxe_gamma';
    // NerdQAxe++
    if (model.includes('nerdqaxe++') || model.includes('qaxe++')) {
        if (asicChip.includes('bm1370')) return 'nerdqaxe_plusplus';
        return 'nerdqaxe_plusplus';
    }
    // NerdQAxe+
    if (model.includes('nerdqaxe') || model.includes('qaxe+')) return 'nerdqaxe_plus';
    // NerdAxe
    if (model.includes('nerdaxe')) return 'nerdaxe';

    // BitAxe single-chip variants
    if (model.includes('gamma') || (asicChip.includes('bm1370') && numChips <= 1)) return 'bitaxe_gamma';
    if (model.includes('supra') || (asicChip.includes('bm1368') && numChips <= 1)) return 'bitaxe_supra';
    if (model.includes('ultra') || (asicChip.includes('bm1366') && numChips <= 1)) return 'bitaxe_ultra';
    if (model.includes('max') || (asicChip.includes('bm1397') && numChips <= 1)) return 'bitaxe_max';
    if (model.includes('bitaxe')) return 'bitaxe_ultra'; // default BitAxe fallback

    // LuckyMiner
    if (model.includes('lucky')) return 'luckyminer';
    // Avalon Nano 3S
    if (model.includes('nano3s') || model.includes('nano 3s')) return 'avalon_nano_3s';

    return null;
}

// Get frequency specs for a miner from device_specifications.json
function getDeviceFrequencySpecs(miner) {
    if (!deviceSpecsCache) return null;
    const key = getDeviceSpecKey(miner);
    if (!key || !deviceSpecsCache[key]) return null;
    return deviceSpecsCache[key].frequency || null;
}

// Get device display name and chip info
function getDeviceDisplayInfo(miner) {
    if (!deviceSpecsCache) return { name: '--', chip: '--' };
    const key = getDeviceSpecKey(miner);
    if (!key || !deviceSpecsCache[key]) return { name: miner?.model || '--', chip: '--' };
    const spec = deviceSpecsCache[key];
    return {
        name: spec.name || miner?.model || '--',
        chip: spec.asic_chip || '--',
        numChips: spec.num_chips || 1
    };
}

// Round a frequency value to the nearest valid step
function roundToStep(value, min, step) {
    return Math.round((value - min) / step) * step + min;
}

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
            ips.forEach(ip => clearLocalOptimizationState(ip));
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
                <span class="group-color-dot" style="background: ${sanitizeColor(group.color)}"></span>
                <span class="group-item-name">${escapeHtml(group.name)}</span>
                <span class="group-item-count">(${group.member_count} miners)</span>
            </div>
            <div class="group-item-actions">
                <button onclick="showAssignMiners(${Number(group.id)}, '${escapeJsString(group.name)}')" title="Assign miners">Assign</button>
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
        option.style.borderLeft = `3px solid ${sanitizeColor(group.color)}`;
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
    // Event listeners handled by delegation on miners-container (see DOMContentLoaded)
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
                    <span class="tag-dot" style="background: ${sanitizeColor(g.color)}"></span>
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

// Escape string for safe insertion into single-quoted inline JS handler arguments.
function escapeJsString(text) {
    return String(text || '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/</g, '\\x3C')
        .replace(/>/g, '\\x3E');
}

// Sanitize CSS color values to prevent XSS via style attribute injection
function sanitizeColor(color) {
    if (!color) return '#3498db';
    // Allow hex colors: #rgb, #rrggbb, #rrggbbaa
    if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) {
        return color;
    }
    // Allow named CSS colors (letters only)
    if (/^[a-zA-Z]{1,20}$/.test(color)) {
        return color;
    }
    // Allow rgb/rgba/hsl/hsla with only safe characters
    if (/^(rgb|hsl)a?\(\s*[\d.,\s%]+\)$/.test(color)) {
        return color;
    }
    return '#3498db';
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
function getChartColors() {
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    return {
        // Primary metrics
        hashrate: {
            line: '#00d4ff',
            fill: 'rgba(0, 212, 255, 0.12)',
            glow: 'rgba(0, 212, 255, 0.3)'
        },
        temperature: {
            line: '#ff5252',
            fill: 'rgba(255, 82, 82, 0.12)',
            safe: '#00e676',
            warm: '#ffab00',
            hot: '#ff5252',
            danger: '#ff1744'
        },
        power: {
            line: '#f7931a',
            fill: 'rgba(247, 147, 26, 0.15)'
        },
        profit: {
            positive: '#00e676',
            negative: '#ff5252',
            fillPositive: 'rgba(0, 230, 118, 0.15)',
            fillNegative: 'rgba(255, 82, 82, 0.15)'
        },
        efficiency: {
            line: '#8b5cf6',
            fill: 'rgba(139, 92, 246, 0.12)'
        },
        shares: {
            accepted: '#00e676',
            rejected: '#ef4444',
            scoring: '#15803d'
        },
        hashrateColors: [
            '#00d4ff', '#00a8cc', '#8b5cf6', '#7c3aed',
            '#3b82f6', '#0ea5e9', '#14b8a6', '#22d3ee'
        ],
        tempColors: [
            '#ff5252', '#ff1744', '#ffab00', '#f7931a',
            '#ff6b6b', '#ff9800', '#ffc107', '#e91e63'
        ],
        grid: isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.06)',
        gridLight: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.1)',
        text: isDark ? '#9ca3af' : '#64748b',
        textMuted: isDark ? '#6b7280' : '#94a3b8',
    };
}
let CHART_COLORS = getChartColors();

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
    animation: false,
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
    // Refresh CHART_COLORS for current theme
    CHART_COLORS = getChartColors();
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

    // Event delegation for miner cards (avoids re-attaching listeners on every refresh)
    const minersContainer = document.getElementById('miners-container');
    if (minersContainer) {
        minersContainer.addEventListener('click', (e) => {
            // Find the closest miner card
            const card = e.target.closest('.miner-card');
            if (!card) return;
            const ip = card.dataset.ip;
            if (!ip) return;

            // Delete button
            if (e.target.closest('[id^="delete-"]')) {
                e.stopPropagation();
                deleteMiner(ip);
                return;
            }
            // Restart button
            if (e.target.closest('[id^="restart-"]')) {
                e.stopPropagation();
                restartMiner(ip);
                return;
            }
            // Skip if clicking on action buttons, edit name, or checkbox
            if (e.target.closest('.miner-actions') || e.target.closest('.edit-name-btn') || e.target.closest('.miner-checkbox')) {
                return;
            }
            // Open miner detail modal
            openMinerDetail(ip);
        });
    }

    // Fleet page time range selectors (may not exist if folded into cards)
    const sharesTimerangeSel = document.getElementById('shares-timerange');
    const powerTimerangeSel = document.getElementById('power-timerange');
    if (sharesTimerangeSel) sharesTimerangeSel.addEventListener('change', loadStats);
    if (powerTimerangeSel) powerTimerangeSel.addEventListener('change', loadStats);
    document.getElementById('fleet-chart-timerange').addEventListener('change', () => {
        const hours = parseInt(document.getElementById('fleet-chart-timerange').value);
        loadFleetCombinedChart(hours);
    });
    document.getElementById('fleet-chart-refresh').addEventListener('click', () => {
        const hours = parseInt(document.getElementById('fleet-chart-timerange').value);
        loadFleetCombinedChart(hours);
    });

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
        // Single fetch for all fleet data (eliminates redundant API calls)
        await refreshFleetData();

        // Read fleet chart time range from dropdown
        const fleetChartHours = parseInt(document.getElementById('fleet-chart-timerange')?.value) || 3;

        // Run all UI updates in parallel using cached data
        await Promise.all([
            loadStats(fleetDataCache),
            loadMinersFromCache(fleetDataCache),
            loadFleetCombinedChart(fleetChartHours),
            loadSoloOdds(),
            updateMetricCards(fleetDataCache)
        ]);
        updateLastUpdateTime();

        // Load and restore auto-optimize settings after miners are loaded
        await loadAutoOptimizeSettings();
    } catch (error) {
        console.error('Error loading dashboard:', error);
        showAlert('Error loading dashboard data', 'error');
    }
}

// Load fleet statistics (uses cached data when available)
async function loadStats(cache) {
    try {
        let stats;
        if (cache && cache.stats) {
            stats = cache.stats;
        } else {
            const response = await fetch(`${API_BASE}/api/stats`);
            const data = await response.json();
            if (!data.success) return;
            stats = data.stats;
        }

        if (stats) {
            // Quick Stats Bar: best difficulty
            const bestDiffEl = document.getElementById('best-difficulty');
            if (bestDiffEl) bestDiffEl.textContent = formatDifficulty(stats.best_difficulty_ever || 0);
        }

        // Get time-based stats for shares (default 24h)
        const sharesTimerangeEl = document.getElementById('shares-timerange');
        const sharesHours = sharesTimerangeEl ? parseInt(sharesTimerangeEl.value) : 24;

        const sharesResponse = await fetch(`${API_BASE}/api/stats/aggregate?hours=${sharesHours}`);
        const sharesData = await sharesResponse.json();

        if (sharesData.success) {
            const totalShares = sharesData.stats.total_shares_accepted ?? 0;
            const totalSharesEl = document.getElementById('total-shares');
            if (totalSharesEl) totalSharesEl.textContent = formatNumber(totalShares);

            // Update home screen scoring shares
            const homeScoringEl = document.getElementById('home-scoring-shares');
            if (homeScoringEl) {
                const scoringTotal = sharesData.stats.scoring_shares_total ?? 0;
                homeScoringEl.textContent = formatScoringNumber(scoringTotal);
            }
        }

        // Get actual energy consumption from the backend (same as energy page)
        const powerTimerangeEl = document.getElementById('power-timerange');
        const powerHours = powerTimerangeEl ? parseInt(powerTimerangeEl.value) : 24;
        const energyDisplayEl = document.getElementById('total-power');

        try {
            const energyResponse = await fetch(`${API_BASE}/api/energy/consumption/actual?hours=${powerHours}`);
            const energyData = await energyResponse.json();

            if (energyData.success && energyDisplayEl) {
                const coverage = energyData.time_coverage_percent || 0;
                if (coverage >= 80) {
                    // Good data coverage — show actual integrated value
                    energyDisplayEl.textContent = `${energyData.total_kwh.toFixed(2)} kWh`;
                } else if (energyData.avg_power_watts > 0) {
                    // Low coverage — extrapolate from actual avg power readings
                    const estimatedKwh = (energyData.avg_power_watts * powerHours) / 1000;
                    energyDisplayEl.textContent = `~${estimatedKwh.toFixed(2)} kWh`;
                } else {
                    energyDisplayEl.textContent = `0.00 kWh`;
                }
            }
        } catch (powerError) {
            console.error('Error loading energy consumption:', powerError);
            const livePower = stats?.total_power ?? 0;
            const energyKwh = (livePower * powerHours) / 1000;
            if (energyDisplayEl) energyDisplayEl.textContent = `~${energyKwh.toFixed(2)} kWh`;
        }

    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// Solo odds data cache for dropdown switching
let soloOddsData = null;

// Load fleet solo mining odds
async function loadSoloOdds() {
    try {
        const response = await fetch(`${API_BASE}/api/solo-chance`);
        const data = await response.json();

        if (data.success && data.solo_chance) {
            soloOddsData = data.solo_chance;
            updateSoloOddsDisplay();
        }
    } catch (error) {
        console.error('Error loading solo odds:', error);
    }
}

// Update solo odds display based on selected timeframe
function updateSoloOddsDisplay() {
    if (!soloOddsData) return;

    const odds = soloOddsData;
    const timeframe = document.getElementById('solo-odds-timeframe')?.value || 'day';

    // Map timeframe to API display field
    const displayMap = {
        block: odds.chance_per_block_display,
        hour:  odds.chance_per_hour_display,
        day:   odds.chance_per_day_display,
        week:  odds.chance_per_week_display,
        month: odds.chance_per_month_display,
        year:  odds.chance_per_year_display
    };

    // Set hero value for selected timeframe
    const heroEl = document.getElementById('solo-odds-hero');
    if (heroEl) {
        heroEl.textContent = displayMap[timeframe] || '--';
    }

    // Set time estimate
    const timeEl = document.getElementById('solo-odds-time');
    if (timeEl) {
        timeEl.textContent = odds.time_estimate_display ? `≈ ${odds.time_estimate_display}` : '--';
    }
}

// Update the 3 homescreen metric cards (Fleet Status, Today's Earnings, Fleet Efficiency)
async function updateMetricCards(cache) {
    try {
        let stats, miners;
        if (cache && cache.stats && cache.miners) {
            stats = cache.stats;
            miners = cache.miners;
        } else {
            const [statsResponse, minersResponse] = await Promise.all([
                fetch(`${API_BASE}/api/stats`),
                fetch(`${API_BASE}/api/miners`)
            ]);
            const statsData = await statsResponse.json();
            const minersData = await minersResponse.json();
            if (!statsData.success || !minersData.success) return;
            stats = statsData.stats;
            miners = minersData.miners || [];
        }

        // --- Card 1: Fleet Status ---
        const onlineCount = stats.online_miners ?? 0;
        const totalCount = stats.total_miners ?? 0;
        const offlineCount = stats.offline_miners ?? 0;
        const overheatedCount = stats.overheated_miners ?? 0;

        const onlineEl = document.getElementById('card-miners-online');
        const totalEl = document.getElementById('card-miners-total');
        const hashrateEl = document.getElementById('card-total-hashrate');
        const indicatorEl = document.getElementById('fleet-status-indicator');

        if (onlineEl) onlineEl.textContent = onlineCount;
        if (totalEl) totalEl.textContent = totalCount;
        if (hashrateEl) hashrateEl.textContent = formatHashrate(stats.total_hashrate ?? 0);

        // Status indicator: green = all online, yellow = some offline/overheated, red = majority offline
        if (indicatorEl) {
            if (offlineCount === 0 && overheatedCount === 0 && totalCount > 0) {
                indicatorEl.className = 'fleet-status-indicator status-green';
            } else if (offlineCount > totalCount / 2) {
                indicatorEl.className = 'fleet-status-indicator status-red';
            } else if (offlineCount > 0 || overheatedCount > 0) {
                indicatorEl.className = 'fleet-status-indicator status-yellow';
            } else {
                indicatorEl.className = 'fleet-status-indicator status-neutral';
            }
        }

        // Offline/overheated badges on Fleet Status card
        const badgesEl = document.getElementById('fleet-status-badges');
        if (badgesEl) {
            let badgesHTML = '';
            if (offlineCount > 0) {
                badgesHTML += `<span class="fleet-badge fleet-badge-danger">${offlineCount} Offline</span>`;
            }
            if (overheatedCount > 0) {
                badgesHTML += `<span class="fleet-badge fleet-badge-warning">${overheatedCount} Overheated</span>`;
            }
            badgesEl.innerHTML = badgesHTML;
        }

        // --- Card 2: Today's Earnings ---
        // Use cached profitability data or fetch
        try {
            let prof;
            if (cache && cache.profitability) {
                prof = cache.profitability;
            } else {
                const profResponse = await fetch(`${API_BASE}/api/energy/profitability`);
                const profData = await profResponse.json();
                if (profData.success && profData.profitability) {
                    prof = profData.profitability;
                }
            }

            if (prof) {
                const satsPerDay = Math.round((prof.btc_per_day ?? 0) * 100000000);
                const revenuePerDay = prof.revenue_per_day ?? 0;
                const costPerDay = prof.energy_cost_per_day ?? 0;
                const profitPerDay = prof.profit_per_day ?? 0;

                const satsEl = document.getElementById('card-sats-today');
                const revenueEl = document.getElementById('card-daily-revenue');
                const costEl = document.getElementById('card-daily-cost');
                const profitEl = document.getElementById('card-daily-profit');

                if (satsEl) satsEl.textContent = satsPerDay.toLocaleString();
                if (revenueEl) revenueEl.textContent = `$${revenuePerDay.toFixed(2)}`;
                if (costEl) costEl.textContent = `$${costPerDay.toFixed(2)}`;
                if (profitEl) {
                    profitEl.textContent = `$${profitPerDay.toFixed(2)}`;
                    if (profitPerDay >= 0) {
                        profitEl.classList.add('profit-positive');
                        profitEl.classList.remove('profit-negative');
                    } else {
                        profitEl.classList.add('profit-negative');
                        profitEl.classList.remove('profit-positive');
                    }
                }
            }
        } catch (profError) {
            console.error('Error loading profitability for metric cards:', profError);
        }

        // Energy used (24h) on Today's Earnings card
        const energyDisplayEl = document.getElementById('total-power');
        if (energyDisplayEl) {
            try {
                const energyResponse = await fetch(`${API_BASE}/api/energy/consumption/actual?hours=24`);
                const energyData = await energyResponse.json();
                if (energyData.success) {
                    const coverage = energyData.time_coverage_percent || 0;
                    if (coverage >= 80) {
                        energyDisplayEl.textContent = `${energyData.total_kwh.toFixed(2)} kWh`;
                    } else if (energyData.avg_power_watts > 0) {
                        const estimatedKwh = (energyData.avg_power_watts * 24) / 1000;
                        energyDisplayEl.textContent = `~${estimatedKwh.toFixed(2)} kWh`;
                    } else {
                        energyDisplayEl.textContent = '0.00 kWh';
                    }
                }
            } catch (e) {
                const livePower = stats?.total_power ?? 0;
                energyDisplayEl.textContent = livePower > 0
                    ? `~${((livePower * 24) / 1000).toFixed(2)} kWh`
                    : '0.00 kWh';
            }
        }

        // --- Card 3: Fleet Efficiency ---
        const fleetEffEl = document.getElementById('card-fleet-efficiency');
        const avgTempEl = document.getElementById('card-avg-temp');
        const bestMinerEl = document.getElementById('card-best-miner');
        const bestEffEl = document.getElementById('card-best-efficiency');
        const worstMinerEl = document.getElementById('card-worst-miner');
        const worstEffEl = document.getElementById('card-worst-efficiency');

        // Fleet-wide efficiency
        if (fleetEffEl && stats.total_hashrate && stats.total_power) {
            const hashrateTH = stats.total_hashrate / 1e12;
            if (hashrateTH > 0) {
                const fleetEff = stats.total_power / hashrateTH;
                fleetEffEl.textContent = fleetEff.toFixed(1);
                fleetEffEl.className = 'efficiency-value ' + getEfficiencyClass(stats.total_hashrate, stats.total_power);
            }
        }

        // Average temperature
        if (avgTempEl) {
            avgTempEl.textContent = `${(stats.avg_temperature ?? 0).toFixed(1)}\u00B0C`;
        }

        // Find best and worst miners by efficiency (J/TH)
        const minerEfficiencies = [];
        for (const miner of miners) {
            const status = miner.last_status || {};
            const hr = status.hashrate || 0;
            const pw = status.power || 0;
            if (hr > 0 && pw > 0) {
                const hrTH = hr / 1e12;
                if (hrTH > 0) {
                    minerEfficiencies.push({
                        name: miner.custom_name || miner.model || miner.type || miner.ip,
                        efficiency: pw / hrTH
                    });
                }
            }
        }

        if (minerEfficiencies.length > 0) {
            minerEfficiencies.sort(function(a, b) { return a.efficiency - b.efficiency; });
            const best = minerEfficiencies[0];
            const worst = minerEfficiencies[minerEfficiencies.length - 1];

            if (bestMinerEl) bestMinerEl.textContent = best.name;
            if (bestEffEl) bestEffEl.textContent = `${best.efficiency.toFixed(1)} J/TH`;
            if (worstMinerEl) worstMinerEl.textContent = worst.name;
            if (worstEffEl) worstEffEl.textContent = `${worst.efficiency.toFixed(1)} J/TH`;
        }

    } catch (error) {
        console.error('Error updating metric cards:', error);
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
        container.textContent = 'Error loading miners. Check console for details.';
    }
}

// Load miners from cache (avoids redundant /api/miners fetch)
async function loadMinersFromCache(cache) {
    if (cache && cache.miners) {
        displayMiners(cache.miners);
    } else {
        await loadMiners();
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
            container.innerHTML = `<div class="miners-grid">${minersHTML}</div>`; // eslint-disable-line -- content from createMinerCard uses escapeHtml
            // Event listeners handled by delegation on miners-container (see DOMContentLoaded)
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
    const safeIp = escapeHtml(miner.ip || '');
    const safeIpJs = escapeJsString(miner.ip || '');
    const safeIpId = (miner.ip || '').replace(/[^a-zA-Z0-9_.:-]/g, '').replace(/\./g, '-');
    const safeDisplayName = escapeHtml(displayName || 'Unknown');
    const safeCustomNameJs = escapeJsString(miner.custom_name || '');
    const safeType = escapeHtml(miner.type || 'Unknown');
    const safeChipType = escapeHtml(chipType);

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
        <div class="miner-card ${statusClass} ${optimizingClass} ${selectedClass}" id="miner-card-${safeIpId}" data-ip="${safeIp}">
            ${batchSelectionState.selectionMode ? `
                <div class="miner-checkbox-wrapper">
                    <input type="checkbox" class="miner-checkbox" data-ip="${safeIp}"
                           ${isSelected ? 'checked' : ''}
                           onclick="toggleMinerSelection('${safeIpJs}', event)">
                </div>
            ` : ''}
            <div class="miner-header">
                <div class="miner-title" id="miner-title-${safeIpId}" data-ip="${safeIp}">
                    <span class="miner-name">${safeDisplayName}</span>
                    <span class="edit-name-btn" onclick="editMinerName('${safeIpJs}', '${safeCustomNameJs}')">✏️</span>
                </div>
                <div class="miner-badges">
                    ${statusBadge}
                    <div class="miner-type">${safeType}</div>
                </div>
            </div>
            <div class="miner-ip">${safeIp}</div>
            <div class="chip-type">Chip Type: ${safeChipType}</div>
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
                        <span class="miner-stat-label">Best Diff</span>
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

// Consistent metric formatting across all charts
function formatMetric(value, type) {
    if (value === null || value === undefined || isNaN(value)) return '--';
    switch (type) {
        case 'temp': return value.toFixed(1);
        case 'hashrate': return value.toFixed(2);
        case 'power': return Math.round(value);
        case 'efficiency': return value.toFixed(1);
        case 'profit': return value.toFixed(2);
        default: return value.toFixed(2);
    }
}

// Update chart-meta element with data point count and last updated time
function updateChartMeta(chartId, dataPointCount, lastUpdated) {
    const metaEl = document.getElementById(`${chartId}-chart-meta`);
    if (!metaEl) return;
    const countText = `${dataPointCount} data points`;
    const timeText = lastUpdated ? `Last updated: ${new Date(lastUpdated).toLocaleTimeString()}` : '';
    metaEl.textContent = `${countText}${timeText ? ' | ' + timeText : ''}`;
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

// Scoring shares tooltip and formatting functions
function formatScoringNumber(num) {
    if (!num || num === 0) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toFixed(1);
}

function showScoringTooltip(event) {
    if (event) event.stopPropagation();
    document.getElementById('scoring-tooltip').classList.add('active');
    document.getElementById('scoring-tooltip-overlay').classList.add('active');
}

function closeScoringTooltip() {
    document.getElementById('scoring-tooltip').classList.remove('active');
    document.getElementById('scoring-tooltip-overlay').classList.remove('active');
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
            clearLocalOptimizationState(ip);
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
        loadEnergyConsumption(),
        loadMiningTimeline(),
        loadMiningAutoControls()
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

            // Store current rate globally for power chart Est. Cost calculation
            if (data.current_rate != null) {
                window._energyRate = data.current_rate;
            }

            // Display rate schedule
            displayRateSchedule(data.rates);

            // Update current rate period indicator
            updateRatePeriodIndicator(data.rates, data.current_rate_type);

            // Populate form fields from saved rates
            populateRateForm(data.rates);
        }
    } catch (error) {
        console.error('Error loading energy rates:', error);
    }
}

// Populate manual rate form fields from saved rates
function populateRateForm(rates) {
    if (!rates || rates.length === 0) return;

    const peakRate = rates.find(r => r.rate_type === 'peak');
    const offPeakRate = rates.find(r => r.rate_type === 'off-peak');

    if (peakRate) {
        const peakRateEl = document.getElementById('manual-peak-rate');
        const peakStartEl = document.getElementById('manual-peak-start');
        const peakEndEl = document.getElementById('manual-peak-end');
        if (peakRateEl) peakRateEl.value = peakRate.rate_per_kwh;
        if (peakStartEl) peakStartEl.value = peakRate.start_time || '';
        if (peakEndEl) peakEndEl.value = peakRate.end_time || '';
    }

    if (offPeakRate) {
        const offPeakRateEl = document.getElementById('manual-offpeak-rate');
        if (offPeakRateEl) offPeakRateEl.value = offPeakRate.rate_per_kwh;
    }

    // If all rates are the same type (flat rate), populate flat rate field
    const allSameRate = rates.every(r => r.rate_per_kwh === rates[0].rate_per_kwh);
    if (allSameRate && rates.length > 0) {
        const flatRateEl = document.getElementById('manual-flat-rate');
        if (flatRateEl) flatRateEl.value = rates[0].rate_per_kwh;
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
        // Check if seasonal mode is enabled
        const seasonalActive = document.querySelector('.seasonal-toggle .toggle-btn.active[data-seasonal="on"]');

        if (seasonalActive) {
            // Seasonal TOU rates - separate summer/winter rate schedules
            const summerPeakRate = parseFloat(document.getElementById('summer-peak-rate').value);
            const summerOffPeakRate = parseFloat(document.getElementById('summer-offpeak-rate').value);
            const summerPeakStart = document.getElementById('summer-peak-start').value;
            const summerPeakEnd = document.getElementById('summer-peak-end').value;
            const summerStartDate = document.getElementById('summer-start-date').value;

            const winterPeakRate = parseFloat(document.getElementById('winter-peak-rate').value);
            const winterOffPeakRate = parseFloat(document.getElementById('winter-offpeak-rate').value);
            const winterPeakStart = document.getElementById('winter-peak-start').value;
            const winterPeakEnd = document.getElementById('winter-peak-end').value;
            const winterStartDate = document.getElementById('winter-start-date').value;

            // Validate summer rates
            if (isNaN(summerPeakRate) || summerPeakRate <= 0) {
                showAlert('Please enter a valid summer peak rate', 'warning');
                return;
            }
            if (isNaN(summerOffPeakRate) || summerOffPeakRate <= 0) {
                showAlert('Please enter a valid summer off-peak rate', 'warning');
                return;
            }
            if (!summerPeakStart || !summerPeakEnd) {
                showAlert('Please enter summer peak hours', 'warning');
                return;
            }

            // Validate winter rates
            if (isNaN(winterPeakRate) || winterPeakRate <= 0) {
                showAlert('Please enter a valid winter peak rate', 'warning');
                return;
            }
            if (isNaN(winterOffPeakRate) || winterOffPeakRate <= 0) {
                showAlert('Please enter a valid winter off-peak rate', 'warning');
                return;
            }
            if (!winterPeakStart || !winterPeakEnd) {
                showAlert('Please enter winter peak hours', 'warning');
                return;
            }

            ratesPayload = {
                seasonal: true,
                summer: {
                    peak_rate: summerPeakRate,
                    off_peak_rate: summerOffPeakRate,
                    peak_start: summerPeakStart,
                    peak_end: summerPeakEnd,
                    start_date: summerStartDate
                },
                winter: {
                    peak_rate: winterPeakRate,
                    off_peak_rate: winterOffPeakRate,
                    peak_start: winterPeakStart,
                    peak_end: winterPeakEnd,
                    start_date: winterStartDate
                }
            };
        } else {
            // Standard TOU rates - peak hours and off-peak for all other hours
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
    const poolFeeSource = prof.pool_fee_source ?? 'default';
    const poolName = prof.pool_name ?? null;
    const poolType = prof.pool_type ?? 'PPS';
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
                ${poolFeeSource === 'detected' && poolName
                    ? `<span class="data-badge actual">Live</span> Values include ${poolFeePercent}% ${poolName} fee (${poolType}).`
                    : `<span class="data-badge estimated">Estimated</span> Values include ${poolFeePercent}% default pool fee${includesTxFees ? ' + tx fees (FPPS)' : ''}. Actual pool earnings may vary.`}
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

// Load and display strategy optimizer using real optimization algorithm
async function loadScheduleSimulations(profitability) {
    try {
        const response = await fetch(`${API_BASE}/api/energy/strategies`);
        const result = await response.json();

        if (!result.success || !result.strategies || result.strategies.length === 0) {
            const el = document.getElementById('simulation-strategies');
            if (el) el.textContent = 'Unable to generate strategies. Ensure miners are online and energy rates are configured.';
            return;
        }

        displayStrategyCards(result.strategies);

    } catch (error) {
        console.error('Error loading strategies:', error);
        const el = document.getElementById('simulation-strategies');
        if (el) el.textContent = 'Error loading strategies';
    }
}

// Display strategy cards with real data
function displayStrategyCards(strategies) {
    const container = document.getElementById('simulation-strategies');
    if (!container) return;

    // Clear safely
    while (container.firstChild) container.removeChild(container.firstChild);

    // Sort by daily profit descending; mark best as recommended
    const sorted = [...strategies].sort((a, b) =>
        (b.projections?.daily?.profit || 0) - (a.projections?.daily?.profit || 0)
    );

    sorted.forEach((strategy, index) => {
        const proj = strategy.projections || {};
        const daily = proj.daily || {};
        const weekly = proj.weekly || {};
        const monthly = proj.monthly || {};
        const isRecommended = index === 0;
        const profitClass = daily.profit >= 0 ? 'profit' : 'loss';

        const card = document.createElement('div');
        card.className = 'strategy-card' + (isRecommended ? ' recommended' : '');

        // Header
        const header = document.createElement('div');
        header.className = 'strategy-header';
        const nameDiv = document.createElement('div');
        nameDiv.className = 'strategy-name';
        nameDiv.textContent = strategy.name + (isRecommended ? ' (Recommended)' : '');
        const descDiv = document.createElement('div');
        descDiv.className = 'strategy-description';
        descDiv.textContent = `${strategy.mining_hours || 0}h mining per day`;
        header.appendChild(nameDiv);
        header.appendChild(descDiv);
        card.appendChild(header);

        // Mini timeline
        if (strategy.hourly_plan && strategy.hourly_plan.length === 24) {
            const timeline = document.createElement('div');
            timeline.className = 'strategy-mini-timeline';
            strategy.hourly_plan.forEach(h => {
                const block = document.createElement('div');
                block.className = 'mini-timeline-block';
                if (h.frequency === 0) block.classList.add('timeline-off');
                else if (h.frequency >= 500) block.classList.add('timeline-full');
                else block.classList.add('timeline-reduced');
                block.title = `${h.hour}:00 - ${h.frequency === 0 ? 'OFF' : h.frequency + ' MHz'} ($${(h.rate || 0).toFixed(3)}/kWh)`;
                timeline.appendChild(block);
            });
            card.appendChild(timeline);
        }

        // Earnings table
        const table = document.createElement('div');
        table.className = 'strategy-earnings-table';

        const rows = [
            ['', 'Daily', 'Weekly', 'Monthly'],
            ['Revenue', `$${daily.revenue?.toFixed(4) || '0'}`, `$${weekly.revenue?.toFixed(4) || '0'}`, `$${monthly.revenue?.toFixed(2) || '0'}`],
            ['Cost', `$${daily.cost?.toFixed(4) || '0'}`, `$${weekly.cost?.toFixed(4) || '0'}`, `$${monthly.cost?.toFixed(2) || '0'}`],
            ['Profit', `$${daily.profit?.toFixed(4) || '0'}`, `$${weekly.profit?.toFixed(4) || '0'}`, `$${monthly.profit?.toFixed(2) || '0'}`],
            ['BTC', `${daily.btc?.toFixed(8) || '0'}`, `${weekly.btc?.toFixed(8) || '0'}`, `${monthly.btc?.toFixed(8) || '0'}`],
            ['Sats', `${(daily.sats || 0).toLocaleString()}`, `${(weekly.sats || 0).toLocaleString()}`, `${(monthly.sats || 0).toLocaleString()}`]
        ];

        rows.forEach((row, ri) => {
            const rowDiv = document.createElement('div');
            rowDiv.className = 'earnings-row' + (ri === 0 ? ' earnings-header' : '');
            if (ri === 3) rowDiv.classList.add(profitClass);
            row.forEach(cell => {
                const cellDiv = document.createElement('div');
                cellDiv.className = 'earnings-cell';
                cellDiv.textContent = cell;
                rowDiv.appendChild(cellDiv);
            });
            table.appendChild(rowDiv);
        });
        card.appendChild(table);

        // Apply button
        const btn = document.createElement('button');
        btn.className = 'apply-strategy-btn';
        btn.textContent = 'Apply Strategy';
        btn.addEventListener('click', () => applyStrategy(strategy.name, strategy.hourly_plan));
        card.appendChild(btn);

        container.appendChild(card);
    });
}

// Apply a strategy using the new endpoint
async function applyStrategy(name, hourlyPlan) {
    try {
        const response = await fetch(`${API_BASE}/api/energy/strategies/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, hourly_plan: hourlyPlan })
        });

        const data = await response.json();

        if (data.success) {
            showAlert(`Strategy "${name}" applied successfully!`, 'success');
            loadMiningTimeline();
        } else {
            showAlert(`Error: ${data.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error applying strategy: ${error.message}`, 'error');
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
            const coverage = data.time_coverage_percent || 0;
            const avgPower = data.avg_power_watts || 0;

            // When data coverage is good, use actual values; otherwise extrapolate from avg power + TOU rates
            if (coverage >= 80) {
                energyEl.textContent = `${(data.total_kwh ?? 0).toFixed(2)} kWh`;
                const peakCost = data.cost_by_rate_type?.peak ?? 0;
                const offPeakCost = data.cost_by_rate_type?.['off-peak'] ?? 0;
                const totalCost = data.total_cost ?? 0;

                if (peakCost > 0 || offPeakCost > 0) {
                    costEl.innerHTML = `$${totalCost.toFixed(2)}<span class="cost-breakdown">Peak: $${peakCost.toFixed(2)} | Off-Peak: $${offPeakCost.toFixed(2)}</span>`;
                } else {
                    costEl.textContent = `$${totalCost.toFixed(2)}`;
                }
            } else if (avgPower > 0) {
                // Low coverage — extrapolate using avg power from actual readings + TOU schedule
                const estKwh = (avgPower * 24) / 1000;
                energyEl.textContent = `~${estKwh.toFixed(2)} kWh`;

                // Fetch TOU rates to compute estimated cost breakdown
                try {
                    const ratesResp = await fetch(`${API_BASE}/api/energy/rates`);
                    const ratesData = await ratesResp.json();
                    const rates = ratesData.rates || [];

                    let peakHours = 0, offPeakHours = 0;
                    for (const r of rates) {
                        const [sh, sm] = r.start_time.split(':').map(Number);
                        const [eh, em] = r.end_time.split(':').map(Number);
                        const start = sh + sm / 60;
                        const end = (r.end_time === '23:59') ? 24 : eh + em / 60;
                        const span = end - start;
                        if (r.rate_type === 'peak') peakHours += span;
                        else offPeakHours += span;
                    }
                    if (peakHours === 0 && offPeakHours === 0) offPeakHours = 24;

                    const peakRate = rates.find(r => r.rate_type === 'peak')?.rate_per_kwh ?? 0;
                    const offPeakRate = rates.find(r => r.rate_type === 'off-peak')?.rate_per_kwh ?? ratesData.current_rate ?? 0;

                    const peakCost = (avgPower * peakHours / 1000) * peakRate;
                    const offPeakCost = (avgPower * offPeakHours / 1000) * offPeakRate;
                    const totalCost = peakCost + offPeakCost;

                    if (peakCost > 0 || offPeakCost > 0) {
                        costEl.innerHTML = `~$${totalCost.toFixed(2)}<span class="cost-breakdown">Peak: ~$${peakCost.toFixed(2)} | Off-Peak: ~$${offPeakCost.toFixed(2)}</span>`;
                    } else {
                        costEl.textContent = `~$${totalCost.toFixed(2)}`;
                    }
                } catch (e) {
                    const estCost = estKwh * (ratesData?.current_rate ?? 0.10);
                    costEl.textContent = `~$${estCost.toFixed(2)}`;
                }
            } else {
                energyEl.textContent = '0.00 kWh';
                costEl.textContent = '$0.00';
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

// Load mining timeline from API
async function loadMiningTimeline() {
    try {
        const response = await fetch(`${API_BASE}/api/energy/schedule/timeline`);
        const result = await response.json();
        if (!result.success) return;

        const container = document.getElementById('mining-timeline');
        if (!container) return;

        // Clear existing content safely
        while (container.firstChild) container.removeChild(container.firstChild);

        result.timeline.forEach(hour => {
            const block = document.createElement('div');
            block.className = 'timeline-block';
            if (hour.status === 'full') block.classList.add('timeline-full');
            else if (hour.status === 'reduced') block.classList.add('timeline-reduced');
            else block.classList.add('timeline-off');
            if (hour.is_current) block.classList.add('timeline-current');

            const freqLabel = hour.target_frequency === 0 ? 'MAX' : `${hour.target_frequency} MHz`;
            const rateLabel = `$${hour.rate.toFixed(3)}/kWh`;
            block.title = `${hour.hour_label} | ${freqLabel} | ${rateLabel} | ${hour.rate_type}`;

            const hourSpan = document.createElement('span');
            hourSpan.className = 'timeline-hour';
            hourSpan.textContent = hour.hour;
            block.appendChild(hourSpan);
            container.appendChild(block);
        });
    } catch (error) {
        console.error('Error loading mining timeline:', error);
    }
}

// Load auto-control settings
async function loadMiningAutoControls() {
    try {
        const response = await fetch(`${API_BASE}/api/energy/auto-controls`);
        const result = await response.json();
        if (!result.success) return;

        const c = result.controls;
        const profToggle = document.getElementById('profitability-auto-pause');
        const btcFloor = document.getElementById('btc-price-floor');
        const diffThresh = document.getElementById('difficulty-alert-threshold');

        if (profToggle) profToggle.checked = c.profitability_auto_pause;
        if (btcFloor) btcFloor.value = c.btc_price_floor || 0;
        if (diffThresh) diffThresh.value = c.difficulty_alert_threshold || 5;
    } catch (error) {
        console.error('Error loading auto-controls:', error);
    }
}

// Save auto-control settings
async function saveMiningAutoControls() {
    try {
        const response = await fetch(`${API_BASE}/api/energy/auto-controls`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                profitability_auto_pause: document.getElementById('profitability-auto-pause')?.checked || false,
                btc_price_floor: parseFloat(document.getElementById('btc-price-floor')?.value) || 0,
                difficulty_alert_threshold: parseFloat(document.getElementById('difficulty-alert-threshold')?.value) || 5
            })
        });
        const result = await response.json();
        if (result.success) {
            showAlert('Auto-controls saved', 'success');
        } else {
            showAlert(`Error: ${result.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error saving auto-controls: ${error.message}`, 'error');
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
    // Clear any existing timers to prevent orphaned intervals
    if (updateTimer) clearInterval(updateTimer);
    if (chartRefreshTimer) clearInterval(chartRefreshTimer);
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

// Insert null points in sorted time-series data where gaps exceed threshold
function insertGapBreaks(sortedData, gapThresholdMs) {
    if (sortedData.length < 2) return sortedData;
    const result = [];
    for (let i = 0; i < sortedData.length; i++) {
        result.push(sortedData[i]);
        if (i < sortedData.length - 1) {
            const gap = sortedData[i + 1].x.getTime() - sortedData[i].x.getTime();
            if (gap > gapThresholdMs) {
                // Insert a null point midway to break the line
                result.push({ x: new Date(sortedData[i].x.getTime() + gap / 2), y: null });
            }
        }
    }
    return result;
}

// Load Fleet Combined Chart (6 hours, compact view for dashboard)
// Style: Total hashrate (red with fill), average hashrate (dashed), avg temperature (white/gray)
async function loadFleetCombinedChart(hours = 3, { canvasId = 'fleet-combined-chart', instanceKey = 'fleetCombined', cancelKey = 'fleetCombined' } = {}) {
    // Skip updates when tab is hidden
    if (!chartsVisible) return;

    // Cancel any pending request for this chart
    const signal = cancelChartRequest(cancelKey);

    try {
        // Fetch both temperature and hashrate data in parallel with abort support
        const [tempResponse, hashrateResponse] = await Promise.all([
            fetch(`${API_BASE}/api/history/temperature?hours=${hours}`, { signal }),
            fetch(`${API_BASE}/api/history/hashrate?hours=${hours}`, { signal })
        ]);

        const tempResult = await tempResponse.json();
        const hashrateResult = await hashrateResponse.json();

        if (!tempResult.success || !hashrateResult.success) {
            console.error('Error loading fleet chart data');
            return;
        }

        // Bucket size based on time range for optimal data point density
        const BUCKET_SIZE = hours <= 1 ? 1 * 60 * 1000 :      // 1 min for 1 hour
                           hours <= 6 ? 5 * 60 * 1000 :       // 5 min for 6 hours
                           hours <= 24 ? 15 * 60 * 1000 :     // 15 min for 24 hours
                           hours <= 168 ? 60 * 60 * 1000 :    // 1 hour for up to 1 week
                           4 * 60 * 60 * 1000;                 // 4 hours for 30 days

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

        // Use data directly — fleet chart connects points for visual continuity
        const totalHashrateDataWithGaps = totalHashrateData;

        // No EMA smoothing — display actual data points.
        // Visual smoothing is handled by Chart.js tension: 0.2 on the dataset.

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

        const avgTempDataWithGaps = avgTempData;

        // Calculate axis ranges
        let maxHashrate = totalHashrateData.length > 0 ? Math.max(...totalHashrateData.map(d => d.y)) : 10;
        let minHashrate = totalHashrateData.length > 0 ? Math.min(...totalHashrateData.map(d => d.y)) : 0;
        if (maxHashrate === 0) maxHashrate = 10;

        // Hashrate axis: adaptive range with generous padding to show variation clearly
        const hashrateRange = maxHashrate - minHashrate;
        const hashratePadding = Math.max(hashrateRange * 0.3, maxHashrate * 0.05); // 30% of range or 5% of max
        const hashrateAxisMin = Math.max(0, minHashrate - hashratePadding);
        const hashrateAxisMax = maxHashrate + hashratePadding;
        const unitInfo = getHashrateUnitInfo(hashrateAxisMax);

        // Temperature axis: position data in lower portion of chart
        let minTemp = avgTempData.length > 0 ? Math.min(...avgTempData.map(d => d.y)) : 50;
        let maxTemp = avgTempData.length > 0 ? Math.max(...avgTempData.map(d => d.y)) : 70;
        const tempRange = Math.max(maxTemp - minTemp, 5);
        const tempAxisMin = Math.round(Math.max(0, minTemp - 5));
        const tempAxisMax = Math.round(maxTemp + tempRange * 2.5);

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
                data: totalHashrateDataWithGaps,
                borderColor: '#e74c3c',
                backgroundColor: 'rgba(231, 76, 60, 0.25)',
                borderWidth: 1,
                fill: true,
                tension: 0.2,
                yAxisID: 'y-hashrate',
                order: 1,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointBackgroundColor: '#e74c3c',
                pointBorderColor: '#e74c3c',
                pointBorderWidth: 0,
                spanGaps: true
            });
        }

        // 2. Average Total Hashrate - Dashed red horizontal line
        if (avgHashrateLineData.length > 0) {
            datasets.push({
                label: 'Average Total Hashrate',
                data: avgHashrateLineData,
                borderColor: '#e74c3c',
                backgroundColor: 'transparent',
                borderWidth: 1,
                borderDash: [6, 4],
                fill: false,
                tension: 0,
                yAxisID: 'y-hashrate',
                order: 0,
                pointRadius: 0,
                pointHoverRadius: 0,
                spanGaps: true
            });
        }

        // 3. Average Temperature - Theme-aware line
        const isDarkTheme = document.documentElement.getAttribute('data-theme') !== 'light';
        const tempLineColor = isDarkTheme ? 'rgba(255, 255, 255, 0.85)' : 'rgba(30, 41, 59, 0.7)';
        const tempAxisColor = isDarkTheme ? 'rgba(255, 255, 255, 0.7)' : '#475569';

        if (avgTempData.length > 0) {
            datasets.push({
                label: 'ASIC Temp',
                data: avgTempDataWithGaps,
                borderColor: tempLineColor,
                backgroundColor: 'transparent',
                borderWidth: 1,
                fill: false,
                tension: 0.2,
                yAxisID: 'y-temperature',
                order: 2,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointBackgroundColor: tempLineColor,
                pointBorderColor: tempLineColor,
                pointBorderWidth: 0,
                spanGaps: true
            });
        }

        // Chart data and options
        const chartData = { datasets };
        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,  // Short animation for smooth updates
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
                    // Auto-scale to fit data
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
                        color: tempAxisColor,
                        font: { size: 11, weight: '600' }
                    },
                    ticks: {
                        color: tempAxisColor,
                        font: { size: 10 },
                        callback: function(value) {
                            return Math.round(value) + '°C';
                        }
                    },
                    grid: {
                        drawOnChartArea: false
                    }
                }
            }
        };

        // Update existing chart or create new one (prevents flickering)
        if (chartInstances[instanceKey]) {
            updateChartData(chartInstances[instanceKey], chartData, chartOptions);
        } else {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            chartInstances[instanceKey] = new Chart(ctx, {
                type: 'line',
                data: chartData,
                options: chartOptions
            });
        }
        if (instanceKey === 'fleetCombined') fleetCombinedChart = chartInstances[instanceKey];
    } catch (error) {
        // Ignore abort errors (expected when user changes timeframe quickly)
        if (error.name === 'AbortError') return;
        console.error('Error loading fleet combined chart:', error);
    }
}

// ============================================================================
// PHASE 4: CHARTS, ALERTS, AND WEATHER
// ============================================================================

// Chart instances (legacy variables - kept for compatibility)
let combinedChart = null;
let fleetCombinedChart = null;
let powerChart = null;
let profitabilityChart = null;
let efficiencyChart = null;
let sharesChart = null;
let energyConsumptionChart = null;

// ============================================================================
// CHART MANAGEMENT INFRASTRUCTURE - Prevents flickering and race conditions
// ============================================================================

// Centralized chart instance management
const chartInstances = {
    fleetCombined: null,
    combined: null,
    power: null,
    profitability: null,
    efficiency: null,
    shares: null,
    energyConsumption: null
};

// Per-miner card share doughnut chart instances (keyed by IP)
const minerCardShareCharts = {};

// Initialize or update a miner card's share doughnut chart
function initMinerCardShareChart(ip, accepted, rejected) {
    const canvas = document.querySelector(`.miner-card-shares-canvas[data-ip="${ip}"]`);
    if (!canvas) return;

    const total = accepted + rejected;
    const data = total > 0 ? [accepted, rejected] : [1, 0];

    if (minerCardShareCharts[ip]) {
        minerCardShareCharts[ip].data.datasets[0].data = data;
        minerCardShareCharts[ip].update();
    } else {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        minerCardShareCharts[ip] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                datasets: [{
                    data: data,
                    backgroundColor: ['#22c55e', '#ef4444'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: false,
                cutout: '70%',
                animation: false,
                events: [],
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false }
                }
            }
        });
    }
}

// Destroy a miner card share chart (when card is removed)
function destroyMinerCardShareChart(ip) {
    if (minerCardShareCharts[ip]) {
        minerCardShareCharts[ip].destroy();
        delete minerCardShareCharts[ip];
    }
}

// Abort controllers for request cancellation on timeframe changes
const chartAbortControllers = {
    fleetCombined: null,
    combined: null,
    power: null,
    profitability: null,
    efficiency: null,
    shares: null,
    energyConsumption: null
};

// Mining-specific color palette (standardized from mining-chart-design skill)
const MINING_COLORS = {
    healthy: '#10B981',
    warning: '#F59E0B',
    critical: '#EF4444',
    neutral: '#6B7280',
    hashrate: '#10B981',
    temperature: '#F97316',
    power: '#F59E0B',
    efficiency: '#8B5CF6',
    profit: '#10B981',
    loss: '#EF4444',
    hashrateFill: 'rgba(16, 185, 129, 0.2)',
    temperatureFill: 'rgba(249, 115, 22, 0.2)',
    powerFill: 'rgba(245, 158, 11, 0.2)'
};

// Visibility state for pausing updates when tab is hidden
let chartsVisible = true;

// Cancel pending chart request and return new abort signal
function cancelChartRequest(chartName) {
    if (chartAbortControllers[chartName]) {
        chartAbortControllers[chartName].abort();
    }
    chartAbortControllers[chartName] = new AbortController();
    return chartAbortControllers[chartName].signal;
}

// Update chart data without destroying (prevents flickering)
function updateChartData(chartInstance, newData, newOptions = null) {
    if (!chartInstance) return false;

    // Update labels in place (if present)
    if (newData.labels) {
        chartInstance.data.labels.length = 0;
        chartInstance.data.labels.push(...newData.labels);
    }

    // Update each dataset's data array in place (prevents flicker)
    newData.datasets.forEach((newDataset, i) => {
        if (chartInstance.data.datasets[i]) {
            // Update data array in place
            chartInstance.data.datasets[i].data.length = 0;
            chartInstance.data.datasets[i].data.push(...newDataset.data);
            // Update other dataset properties
            Object.keys(newDataset).forEach(key => {
                if (key !== 'data') {
                    chartInstance.data.datasets[i][key] = newDataset[key];
                }
            });
        }
    });

    // Optionally update options (merge with existing)
    if (newOptions) {
        Object.assign(chartInstance.options, newOptions);
    }

    // Use 'none' mode to prevent animation on frequent updates
    chartInstance.update('none');
    return true;
}

// Initialize chart only once, return existing instance if available
function initializeChart(chartName, canvasId, config) {
    // Return existing instance if already created
    if (chartInstances[chartName]) {
        return chartInstances[chartName];
    }

    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    chartInstances[chartName] = new Chart(ctx, config);
    return chartInstances[chartName];
}

// Pause chart updates when tab is hidden to save resources
document.addEventListener('visibilitychange', () => {
    chartsVisible = !document.hidden;
    if (chartsVisible) {
        // Tab became visible - refresh charts that may have stale data
        refreshVisibleCharts();
    }
});

// Refresh currently visible charts when tab becomes active
function refreshVisibleCharts() {
    if (!chartsVisible) return;

    // Only refresh if on a tab that has charts
    if (currentTab === 'fleet') {
        const fleetChartHours = parseInt(document.getElementById('fleet-chart-timerange')?.value) || 3;
        loadFleetCombinedChart(fleetChartHours);
    } else if (currentTab === 'charts') {
        loadChartsTab();
    } else if (currentTab === 'energy') {
        const energyHours = parseInt(document.getElementById('energy-chart-timerange')?.value) || 168;
        loadEnergyConsumptionChart(energyHours);
    }
}

// Load Charts Tab - reads each chart's individual time range
async function loadChartsTab() {
    // Each chart has its own time range dropdown
    const combinedHours = parseInt(document.getElementById('combined-chart-timerange')?.value) || 24;
    const powerHours = parseInt(document.getElementById('power-chart-timerange')?.value) || 24;
    const profitDays = parseInt(document.getElementById('profitability-chart-timerange')?.value) || 7;
    const efficiencyHours = parseInt(document.getElementById('efficiency-chart-timerange')?.value) || 24;
    const sharesHours = parseInt(document.getElementById('shares-chart-timerange')?.value) || 24;

    await Promise.all([
        loadCombinedChart(combinedHours),
        loadPowerChart(powerHours),
        loadProfitabilityChart(profitDays),
        loadEfficiencyChart(efficiencyHours),
        loadSharesMetrics(sharesHours)
    ]);
}

let combinedChartViewMode = 'fleet'; // 'fleet' or 'per-miner'

function toggleCombinedChartView() {
    combinedChartViewMode = combinedChartViewMode === 'fleet' ? 'per-miner' : 'fleet';
    const btn = document.getElementById('combined-chart-view-toggle');
    if (btn) btn.textContent = combinedChartViewMode === 'fleet' ? 'Per Miner' : 'Fleet Total';
    const hours = parseInt(document.getElementById('combined-chart-timerange')?.value) || 24;
    loadCombinedChart(hours);
}

// Load Combined Hashrate & Temperature Chart (AxeOS-style)
async function loadCombinedChart(hours = 24) {
    // Delegate to fleet combined chart with Charts page canvas
    return loadFleetCombinedChart(hours, {
        canvasId: 'combined-chart',
        instanceKey: 'combined',
        cancelKey: 'combined'
    });
}

// Legacy combined chart — kept as dead code reference, not called
async function _loadCombinedChart_legacy(hours = 24) {
    if (!chartsVisible) return;
    const signal = cancelChartRequest('combined');

    try {
        // Fetch both temperature and hashrate data in parallel with abort support
        const [tempResponse, hashrateResponse] = await Promise.all([
            fetch(`${API_BASE}/api/history/temperature?hours=${hours}`, { signal }),
            fetch(`${API_BASE}/api/history/hashrate?hours=${hours}`, { signal })
        ]);

        const tempResult = await tempResponse.json();
        const hashrateResult = await hashrateResponse.json();

        if (!tempResult.success || !hashrateResult.success) {
            console.error('Error loading chart data');
            return;
        }

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
        let hashrateAxisMin = Math.max(0, minHashrate - hashratePadding);
        let hashrateAxisMax = maxHashrate + hashratePadding;
        let unitInfo = getHashrateUnitInfo(hashrateAxisMax);

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

        // Create datasets based on view mode
        const datasets = [];

        if (combinedChartViewMode === 'fleet') {
            // FLEET TOTAL MODE: Aggregate like the fleet chart
            // Sum hashrate across all miners per timestamp bucket
            const BUCKET_SIZE = hours <= 1 ? 1 * 60 * 1000 :
                               hours <= 6 ? 5 * 60 * 1000 :
                               hours <= 24 ? 15 * 60 * 1000 :
                               hours <= 168 ? 60 * 60 * 1000 :
                               4 * 60 * 60 * 1000;

            const hashrateByTime = {};
            Object.entries(minerHashrateData).forEach(([ip, data]) => {
                data.forEach(point => {
                    const bucketTime = Math.round(point.x.getTime() / BUCKET_SIZE) * BUCKET_SIZE;
                    if (!hashrateByTime[bucketTime]) hashrateByTime[bucketTime] = {};
                    hashrateByTime[bucketTime][ip] = point.y;
                });
            });

            const totalHashrateData = Object.entries(hashrateByTime)
                .map(([time, miners]) => ({
                    x: new Date(parseInt(time)),
                    y: Object.values(miners).reduce((a, b) => a + b, 0)
                }))
                .sort((a, b) => a.x - b.x);

            // Average temperature across all miners per bucket
            const tempByTime = {};
            Object.entries(minerTempData).forEach(([ip, data]) => {
                data.forEach(point => {
                    const bucketTime = Math.round(point.x.getTime() / BUCKET_SIZE) * BUCKET_SIZE;
                    if (!tempByTime[bucketTime]) tempByTime[bucketTime] = { sum: 0, count: 0 };
                    tempByTime[bucketTime].sum += point.y;
                    tempByTime[bucketTime].count++;
                });
            });

            const avgTempData = Object.entries(tempByTime)
                .map(([time, bucket]) => ({
                    x: new Date(parseInt(time)),
                    y: bucket.sum / bucket.count
                }))
                .sort((a, b) => a.x - b.x);

            // Recalculate axis ranges for fleet totals
            if (totalHashrateData.length > 0) {
                maxHashrate = Math.max(...totalHashrateData.map(d => d.y));
                minHashrate = Math.min(...totalHashrateData.map(d => d.y));
            }
            if (maxHashrate === 0) maxHashrate = 10;
            const fleetHashrateRange = maxHashrate - minHashrate;
            const fleetHashratePadding = Math.max(fleetHashrateRange * 0.3, maxHashrate * 0.05);
            const fleetAxisMin = Math.max(0, minHashrate - fleetHashratePadding);
            const fleetAxisMax = maxHashrate + fleetHashratePadding;

            // Override axis values
            hashrateAxisMin = fleetAxisMin;
            hashrateAxisMax = fleetAxisMax;
            unitInfo = getHashrateUnitInfo(hashrateAxisMax);

            const avgHashrate = totalHashrateData.length > 0
                ? totalHashrateData.reduce((sum, d) => sum + d.y, 0) / totalHashrateData.length
                : 0;

            // Insert gap breaks
            const gapThreshold = BUCKET_SIZE * 2.5;
            const totalWithGaps = typeof insertGapBreaks === 'function' ? insertGapBreaks(totalHashrateData, gapThreshold) : totalHashrateData;
            const tempWithGaps = typeof insertGapBreaks === 'function' ? insertGapBreaks(avgTempData, gapThreshold) : avgTempData;

            if (totalHashrateData.length > 0) {
                datasets.push({
                    label: 'Total Hashrate',
                    data: totalWithGaps,
                    borderColor: '#e74c3c',
                    backgroundColor: 'rgba(231, 76, 60, 0.25)',
                    borderWidth: 1,
                    fill: true,
                    tension: 0.2,
                    yAxisID: 'y-hashrate',
                    order: 1,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointBackgroundColor: '#e74c3c',
                    pointBorderColor: '#e74c3c',
                    pointBorderWidth: 0,
                    spanGaps: false
                });
            }

            // Average hashrate reference line
            if (totalHashrateData.length > 0) {
                datasets.push({
                    label: 'Avg Hashrate',
                    data: [
                        { x: totalHashrateData[0].x, y: avgHashrate },
                        { x: totalHashrateData[totalHashrateData.length - 1].x, y: avgHashrate }
                    ],
                    borderColor: '#e74c3c',
                    backgroundColor: 'transparent',
                    borderWidth: 1,
                    borderDash: [6, 4],
                    fill: false,
                    tension: 0,
                    yAxisID: 'y-hashrate',
                    order: 0,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    spanGaps: true
                });
            }

            // Average temperature line (theme-aware)
            const legacyIsDark = document.documentElement.getAttribute('data-theme') !== 'light';
            const legacyTempColor = legacyIsDark ? 'rgba(255, 255, 255, 0.85)' : 'rgba(30, 41, 59, 0.7)';

            if (avgTempData.length > 0) {
                datasets.push({
                    label: 'Avg Temp',
                    data: tempWithGaps,
                    borderColor: legacyTempColor,
                    backgroundColor: 'transparent',
                    borderWidth: 1,
                    fill: false,
                    tension: 0.2,
                    yAxisID: 'y-temperature',
                    order: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointBackgroundColor: legacyTempColor,
                    pointBorderColor: legacyTempColor,
                    pointBorderWidth: 0,
                    spanGaps: false
                });
            }
        } else {
            // PER-MINER MODE: per-miner hashrate + per-miner temp

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
                        borderWidth: 1,
                        fill: false,
                        tension: 0.1,
                        yAxisID: 'y-hashrate',
                        order: 1,
                        pointRadius: 0,
                        pointHoverRadius: 3,
                        pointBackgroundColor: color,
                        pointBorderColor: color,
                        pointBorderWidth: 0,
                        metricType: 'hashrate',
                        spanGaps: true
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
                        borderWidth: 1,
                        fill: false,
                        tension: 0.1,
                        yAxisID: 'y-temperature',
                        order: 2,
                        pointRadius: 0,
                        pointHoverRadius: 3,
                        pointBackgroundColor: color,
                        pointBorderColor: color,
                        pointBorderWidth: 0,
                        borderDash: [8, 4],
                        metricType: 'temperature',
                        spanGaps: true
                    });
                }
            });
        }

        // Chart data and options
        const chartData = { datasets };
        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,  // Short animation for smooth updates
            interaction: {
                mode: 'nearest',
                intersect: false
            },
            plugins: {
                legend: {
                    display: combinedChartViewMode === 'fleet' || combinedChartViewMode === 'per-miner'  // Show legend in both modes
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
                    // Auto-scale to fit data
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
                            return Math.round(value) + '°C';
                        }
                    },
                    grid: {
                        drawOnChartArea: false
                    }
                }
            }
        };

        // Update existing chart or create new one (prevents flickering)
        if (chartInstances.combined) {
            updateChartData(chartInstances.combined, chartData, chartOptions);
        } else {
            const canvas = document.getElementById('combined-chart');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            chartInstances.combined = new Chart(ctx, {
                type: 'line',
                data: chartData,
                options: chartOptions
            });
        }
        // Keep legacy reference in sync
        combinedChart = chartInstances.combined;
        updateChartMeta('combined', hashrateResult.data_point_count || hashrateResult.data?.length || 0, hashrateResult.last_updated);
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Error loading combined chart:', error);
    }
}

// Load Power Chart
async function loadPowerChart(hours = 168) {
    // Delegate to energy consumption bar chart with Charts page canvas/summary IDs
    return loadEnergyConsumptionChart(hours, {
        canvasId: 'power-chart',
        instanceKey: 'power',
        cancelKey: 'power',
        summaryIds: { total: 'charts-energy-total', cost: 'charts-energy-cost', avg: 'charts-energy-avg' }
    });
}

// Load Profitability Chart
async function loadProfitabilityChart(days = 7) {
    // Skip updates when tab is hidden
    if (!chartsVisible) return;

    // Cancel any pending request for this chart
    const signal = cancelChartRequest('profitability');

    try {
        const response = await fetch(`${API_BASE}/api/energy/profitability/history?days=${days}`, { signal });
        const result = await response.json();

        if (!result.success) {
            console.error('Error loading profitability history:', result.error);
            return;
        }

        // Prepare data - sort by timestamp and format labels for bar chart
        const sortedHistory = [...result.history].sort((a, b) =>
            new Date(a.timestamp) - new Date(b.timestamp)
        );
        const labels = sortedHistory.map(point => {
            const d = new Date(point.timestamp);
            return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
        });
        const profitData = sortedHistory.map(point => point.profit_per_day);

        // Calculate adaptive profit axis (handle both positive and negative)
        const maxProfit = profitData.length > 0 ? Math.max(...profitData) : 1;
        const minProfit = profitData.length > 0 ? Math.min(...profitData) : -1;
        const absMax = Math.max(Math.abs(maxProfit), Math.abs(minProfit));
        // Ensure minimum axis range for visibility (at least $0.50 range for small profits)
        const minAxisRange = 0.5;
        const adjustedAbsMax = Math.max(absMax * 1.2, minAxisRange); // 20% headroom + minimum
        const profitAxisMax = getAdaptiveAxisMax(adjustedAbsMax);
        const profitAxisMin = minProfit < 0 ? -profitAxisMax : 0;

        // Chart data and options - Use BAR chart for better visibility of small values
        const chartData = {
            labels,
            datasets: [{
                label: 'Daily Profit',
                data: profitData,
                // Color bars based on positive/negative values
                backgroundColor: profitData.map(v => v >= 0 ? CHART_COLORS.profit.positive : CHART_COLORS.profit.negative),
                borderColor: profitData.map(v => v >= 0 ? CHART_COLORS.profit.positive : CHART_COLORS.profit.negative),
                borderWidth: 1,
                borderRadius: 4,
                barPercentage: 0.8,
                categoryPercentage: 0.9
            }]
        };
        const chartOptions = {
            ...CHART_DEFAULTS,
            animation: false,
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
                    type: 'category',
                    ticks: {
                        color: CHART_COLORS.text,
                        font: { size: 9 },
                        maxRotation: 45,
                        autoSkip: true,
                        maxTicksLimit: 10
                    },
                    grid: { display: false }
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
        };

        // Update existing chart or create new one
        // Note: Must destroy and recreate if chart type changed (line -> bar)
        const canvas = document.getElementById('profitability-chart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Destroy existing chart if it's the wrong type (line vs bar)
        if (chartInstances.profitability && chartInstances.profitability.config.type !== 'bar') {
            chartInstances.profitability.destroy();
            chartInstances.profitability = null;
        }

        if (chartInstances.profitability) {
            updateChartData(chartInstances.profitability, chartData, chartOptions);
        } else {
            chartInstances.profitability = new Chart(ctx, {
                type: 'bar',
                data: chartData,
                options: chartOptions
            });
        }
        // Keep legacy reference in sync
        profitabilityChart = chartInstances.profitability;
        updateChartMeta('profitability', result.history?.length || 0, result.history?.length ? result.history[result.history.length - 1].timestamp : null);

        // Calculate and display annotation values (avg revenue, cost, net profit)
        if (sortedHistory.length > 0) {
            const latest = sortedHistory[sortedHistory.length - 1];
            const btcPerDay = latest.estimated_btc_per_day || 0;
            const btcPrice = latest.btc_price || 0;
            const avgRevenue = btcPerDay * btcPrice;
            const avgCost = latest.energy_cost_per_day || 0;
            const avgProfit = latest.profit_per_day || 0;

            const revenueEl = document.getElementById('charts-total-revenue');
            const costEl = document.getElementById('charts-total-cost');
            const profitEl = document.getElementById('charts-net-profit');
            if (revenueEl) revenueEl.textContent = `$${avgRevenue.toFixed(2)}/day`;
            if (costEl) costEl.textContent = `$${avgCost.toFixed(2)}/day`;
            if (profitEl) {
                const prefix = avgProfit >= 0 ? '+' : '';
                profitEl.textContent = `${prefix}$${avgProfit.toFixed(2)}/day`;
            }
        }
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Error loading profitability chart:', error);
    }
}

// Load Efficiency Chart - uses server-side pre-computed J/TH endpoint
async function loadEfficiencyChart(hours = 24) {
    // Skip updates when tab is hidden
    if (!chartsVisible) return;

    // Cancel any pending request for this chart
    const signal = cancelChartRequest('efficiency');

    try {
        const response = await fetch(`${API_BASE}/api/history/efficiency?hours=${hours}`, { signal });
        const result = await response.json();

        if (!result.success) return;

        // Data is pre-computed server-side with proper J/TH values
        const efficiencyData = (result.data || [])
            .filter(point => point.efficiency_jth > 0)
            .map(point => ({
                x: new Date(point.timestamp),
                y: point.efficiency_jth
            }));

        // Calculate adaptive efficiency axis using percentile-based scaling
        let efficiencyAxisMax = 50;
        if (efficiencyData.length > 0) {
            const sortedValues = efficiencyData.map(d => d.y).sort((a, b) => a - b);
            const p95 = sortedValues[Math.floor(sortedValues.length * 0.95)] || sortedValues[sortedValues.length - 1];
            efficiencyAxisMax = getAdaptiveAxisMax(Math.max(p95 * 1.1, 10));
        }

        // Chart data and options
        const chartData = {
            datasets: [{
                label: 'Fleet Efficiency',
                data: efficiencyData,
                borderColor: CHART_COLORS.efficiency.line,
                backgroundColor: CHART_COLORS.efficiency.fill,
                fill: true,
                tension: 0.1,
                borderWidth: 1,
                pointRadius: 0,
                pointHoverRadius: 3,
                pointBackgroundColor: CHART_COLORS.efficiency.line,
                pointBorderColor: CHART_COLORS.efficiency.line,
                pointBorderWidth: 0,
                spanGaps: true
            }]
        };
        const chartOptions = {
            ...CHART_DEFAULTS,
            animation: false,
            plugins: {
                ...CHART_DEFAULTS.plugins,
                tooltip: {
                    ...CHART_DEFAULTS.plugins.tooltip,
                    callbacks: {
                        label: function(context) {
                            return `Efficiency: ${formatMetric(context.parsed.y, 'efficiency')} J/TH`;
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
                        text: 'Efficiency (J/TH)',
                        color: CHART_COLORS.efficiency.line,
                        font: { size: 12, weight: '600' }
                    },
                    ticks: {
                        color: CHART_COLORS.efficiency.line,
                        font: { size: 11 },
                        callback: function(value) {
                            return formatMetric(value, 'efficiency');
                        }
                    },
                    grid: { color: CHART_COLORS.grid }
                }
            }
        };

        // Update existing chart or create new one (prevents flickering)
        if (chartInstances.efficiency) {
            updateChartData(chartInstances.efficiency, chartData, chartOptions);
        } else {
            const canvas = document.getElementById('efficiency-chart');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            chartInstances.efficiency = new Chart(ctx, {
                type: 'line',
                data: chartData,
                options: chartOptions
            });
        }
        // Keep legacy reference in sync
        efficiencyChart = chartInstances.efficiency;
        updateChartMeta('efficiency', result.data_point_count || 0, result.last_updated);
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Error loading efficiency chart:', error);
    }
}

// Load Shares Metrics
async function loadSharesMetrics(hours = 24) {
    // Skip updates when tab is hidden
    if (!chartsVisible) return;

    // Cancel any pending request for this chart
    const signal = cancelChartRequest('shares');

    try {
        // Use cached stats if available, only fetch aggregate data
        let stats;
        if (fleetDataCache.stats) {
            stats = fleetDataCache.stats;
        } else {
            const statsResponse = await fetch(`${API_BASE}/api/stats`, { signal });
            const statsResult = await statsResponse.json();
            if (!statsResult.success) return;
            stats = statsResult.stats;
        }

        // Update stats-based annotations first (don't depend on aggregate endpoint)
        const hashrateThs = stats.total_hashrate / 1e12;
        const totalPower = stats.total_power || 0;
        const hasValidEfficiency = hashrateThs > 0 && totalPower > 0;
        const efficiency = hasValidEfficiency ? (totalPower / hashrateThs).toFixed(1) : null;

        // Update chart annotation: efficiency
        const chartsEffEl = document.getElementById('charts-fleet-efficiency');
        const effText = efficiency !== null ? `${efficiency} J/TH` : '--';
        if (chartsEffEl) chartsEffEl.textContent = effText;

        const benchEl = document.getElementById('charts-efficiency-benchmark');
        if (benchEl && efficiency !== null) {
            const eff = parseFloat(efficiency);
            if (eff <= 15) benchEl.textContent = 'Excellent';
            else if (eff <= 25) benchEl.textContent = 'Good';
            else if (eff <= 50) benchEl.textContent = 'Average';
            else if (eff <= 100) benchEl.textContent = 'Below avg';
            else benchEl.textContent = 'High';
        }

        // Update chart annotation: hashrate & temp
        const totalHashrateEl = document.getElementById('charts-total-hashrate');
        if (totalHashrateEl) {
            if (hashrateThs >= 1000) {
                totalHashrateEl.textContent = `${(hashrateThs / 1000).toFixed(2)} PH/s`;
            } else {
                totalHashrateEl.textContent = `${hashrateThs.toFixed(2)} TH/s`;
            }
        }

        // Update power chart annotation (avg power, total energy, est cost)
        const avgPowerEl = document.getElementById('charts-avg-power');
        if (avgPowerEl) avgPowerEl.textContent = `${totalPower.toFixed(1)} W`;
        const totalEnergyEl = document.getElementById('charts-total-energy');
        if (totalEnergyEl) {
            const kwhPerDay = (totalPower / 1000) * 24;
            totalEnergyEl.textContent = `${kwhPerDay.toFixed(2)} kWh/day`;
            const energyCostEl = document.getElementById('charts-energy-cost');
            if (energyCostEl && window._energyRate) {
                const dailyCost = kwhPerDay * window._energyRate;
                energyCostEl.textContent = `~$${dailyCost.toFixed(2)}/day`;
            }
        }
        const chartsAvgTemp = document.getElementById('charts-avg-temp');
        if (chartsAvgTemp) chartsAvgTemp.textContent = `${(stats.avg_temperature ?? 0).toFixed(1)}°C`;

        // Fetch aggregate data (may fail - don't block other annotations)
        let aggStats = null;
        try {
            const aggResponse = await fetch(`${API_BASE}/api/stats/aggregate?hours=${hours}`, { signal });
            const aggResult = await aggResponse.json();
            if (aggResult.success) {
                aggStats = aggResult.stats;
            }
        } catch (e) {
            // Aggregate endpoint unavailable - shares annotations will stay at defaults
        }

        // Update shares-specific annotations (require aggregate data)
        const totalShares = aggStats?.total_shares_accepted || 0;
        const totalRejected = aggStats?.total_shares_rejected || 0;
        const totalAttempts = totalShares + totalRejected;

        const acceptRate = totalAttempts > 0 ? ((totalShares / totalAttempts) * 100).toFixed(2) : 0;
        const rejectRate = totalAttempts > 0 ? ((totalRejected / totalAttempts) * 100).toFixed(2) : 0;

        const chartsAccepted = document.getElementById('charts-accepted-shares');
        const chartsRejected = document.getElementById('charts-rejected-shares');
        const chartsAcceptRate = document.getElementById('charts-accept-rate');
        if (chartsAccepted) chartsAccepted.textContent = formatNumber(totalShares);
        if (chartsRejected) chartsRejected.textContent = formatNumber(totalRejected);
        if (chartsAcceptRate) chartsAcceptRate.textContent = `${acceptRate}%`;

        // Update charts scoring shares + cache per-miner data
        const chartsScoringEl = document.getElementById('charts-scoring-shares');
        if (chartsScoringEl) {
            const scoringTotal = aggStats?.scoring_shares_total ?? 0;
            chartsScoringEl.textContent = formatScoringNumber(scoringTotal);
        }
        scoringSharesCache = aggStats?.scoring_shares_per_miner || {};

        // Chart data and options
        const scoringTotal = aggStats?.scoring_shares_total ?? 0;
        const chartLabels = [
            `Accepted: ${formatNumber(totalShares)} (${acceptRate}%)`,
            `Rejected: ${formatNumber(totalRejected)} (${rejectRate}%)`
        ];
        const chartDataValues = [totalShares, totalRejected];
        const chartBgColors = [CHART_COLORS.shares.accepted, CHART_COLORS.shares.rejected];

        if (scoringTotal > 0) {
            const scoringRate = totalAttempts > 0 ? ((scoringTotal / totalAttempts) * 100).toFixed(2) : 0;
            chartLabels.push(`Scoring: ${formatNumber(scoringTotal)} (${scoringRate}%) - PPLNS weighted`);
            chartDataValues.push(scoringTotal);
            chartBgColors.push(CHART_COLORS.shares.scoring);
        }

        const chartData = {
            labels: chartLabels,
            datasets: [{
                data: chartDataValues,
                backgroundColor: chartBgColors,
                borderWidth: 0,
                hoverOffset: 8,
                borderRadius: 4
            }]
        };
        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
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
        };

        // Center text plugin for doughnut chart
        const centerTextPlugin = {
            id: 'sharesCenterText',
            afterDraw(chart) {
                const { ctx: drawCtx, width, height } = chart;
                drawCtx.save();
                const centerX = width / 2;
                const centerY = height / 2 - 10;
                // Total shares count
                drawCtx.font = "bold 20px 'JetBrains Mono', monospace";
                const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
                drawCtx.fillStyle = isDark ? '#e2e8f0' : '#1e293b';
                drawCtx.textAlign = 'center';
                drawCtx.textBaseline = 'middle';
                drawCtx.fillText(formatNumber(totalAttempts), centerX, centerY - 8);
                // Accept rate
                drawCtx.font = "13px 'Outfit', sans-serif";
                drawCtx.fillStyle = isDark ? '#9ca3af' : '#64748b';
                drawCtx.fillText(`${acceptRate}% accepted`, centerX, centerY + 14);
                drawCtx.restore();
            }
        };

        // Update existing chart or create new one (prevents flickering)
        if (chartInstances.shares) {
            updateChartData(chartInstances.shares, chartData, chartOptions);
        } else {
            const canvas = document.getElementById('shares-chart');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            chartInstances.shares = new Chart(ctx, {
                type: 'doughnut',
                data: chartData,
                options: chartOptions,
                plugins: [centerTextPlugin]
            });
        }
        // Keep legacy reference in sync
        sharesChart = chartInstances.shares;
        updateChartMeta('shares', totalAttempts, null);
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('Error loading shares metrics:', error);
    }
}

// Load Alerts Tab
async function loadAlertsTab() {
    await Promise.all([loadAlertHistory(), loadAlertConfig()]);
}

// Load alert config and populate UI
async function loadAlertConfig() {
    try {
        const response = await fetch(`${API_BASE}/api/alerts/config`);
        const result = await response.json();
        if (!result.success) return;

        const config = result.config;

        // Populate alert type toggles
        const typesGrid = document.getElementById('alert-types-grid');
        if (typesGrid && config.enabled_alert_types) {
            while (typesGrid.firstChild) typesGrid.removeChild(typesGrid.firstChild);

            const typeLabels = {
                miner_offline: 'Miner Offline',
                high_temperature: 'High Temperature',
                critical_temperature: 'Critical Temperature',
                low_hashrate: 'Low Hashrate',
                unprofitable: 'Unprofitable Mining',
                emergency_shutdown: 'Emergency Shutdown',
                miner_online: 'Miner Back Online',
                overheat_recovery: 'Overheat Recovery',
                weather_warning: 'Weather Warning',
                frequency_adjusted: 'Frequency Adjusted'
            };

            Object.entries(config.enabled_alert_types).forEach(([type, enabled]) => {
                const card = document.createElement('div');
                card.className = 'alert-type-card';

                const label = document.createElement('span');
                // Convert unknown snake_case types to Title Case
                label.textContent = typeLabels[type] || type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

                const toggle = document.createElement('label');
                toggle.className = 'toggle-switch';
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = enabled;
                input.dataset.alertType = type;
                input.addEventListener('change', () => saveAlertConfig());
                const slider = document.createElement('span');
                slider.className = 'toggle-slider';
                toggle.appendChild(input);
                toggle.appendChild(slider);

                card.appendChild(label);
                card.appendChild(toggle);
                typesGrid.appendChild(card);
            });
        }

        // Quiet hours
        const qhEnabled = document.getElementById('quiet-hours-enabled');
        const qhStart = document.getElementById('quiet-hours-start');
        const qhEnd = document.getElementById('quiet-hours-end');
        if (qhEnabled && config.quiet_hours) {
            qhEnabled.checked = config.quiet_hours.enabled;
            if (qhStart) qhStart.value = config.quiet_hours.start || '22:00';
            if (qhEnd) qhEnd.value = config.quiet_hours.end || '07:00';
        }

        // Daily report
        const drEnabled = document.getElementById('daily-report-enabled');
        const drTime = document.getElementById('daily-report-time');
        if (drEnabled && config.daily_report) {
            drEnabled.checked = config.daily_report.enabled;
            if (drTime) drTime.value = config.daily_report.time || '08:00';
        }
    } catch (error) {
        console.error('Error loading alert config:', error);
    }
}

// Save all alert settings
async function saveAlertConfig() {
    try {
        // Gather alert type toggles
        const enabledTypes = {};
        document.querySelectorAll('#alert-types-grid input[data-alert-type]').forEach(input => {
            enabledTypes[input.dataset.alertType] = input.checked;
        });

        const response = await fetch(`${API_BASE}/api/alerts/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled_alert_types: enabledTypes,
                quiet_hours_enabled: document.getElementById('quiet-hours-enabled')?.checked || false,
                quiet_hours_start: document.getElementById('quiet-hours-start')?.value || '22:00',
                quiet_hours_end: document.getElementById('quiet-hours-end')?.value || '07:00',
                daily_report_enabled: document.getElementById('daily-report-enabled')?.checked || false,
                daily_report_time: document.getElementById('daily-report-time')?.value || '08:00'
            })
        });
        const result = await response.json();
        if (result.success) {
            showAlert('Alert settings saved', 'success');
        } else {
            showAlert(`Error: ${result.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error saving alert config: ${error.message}`, 'error');
    }
}

// Trigger daily report manually
async function triggerDailyReport() {
    try {
        const response = await fetch(`${API_BASE}/api/alerts/daily-report`, { method: 'POST' });
        const result = await response.json();
        if (result.success) {
            showAlert('Daily report sent', 'success');
        } else {
            showAlert(`Error: ${result.error}`, 'error');
        }
    } catch (error) {
        showAlert(`Error: ${error.message}`, 'error');
    }
}

// Format relative time (e.g., "5 minutes ago")
function formatRelativeTime(timestamp) {
    const now = new Date();
    // DB stores timestamps in UTC without timezone indicator — append 'Z' so
    // the browser interprets the value as UTC rather than local time.
    let ts = String(timestamp).trim();
    if (!ts.endsWith('Z') && !ts.includes('+') && !ts.includes('T')) {
        ts = ts.replace(' ', 'T') + 'Z';
    }
    const alertTime = new Date(ts);
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
            const level = ['info', 'warning', 'critical', 'emergency'].includes((alert.level || '').toLowerCase())
                ? alert.level.toLowerCase()
                : 'info';
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
                        extraDetails = `<div class="alert-item-details">${details.map(d => escapeHtml(String(d))).join(' • ')}</div>`;
                    }
                } catch (e) { /* ignore parse errors */ }
            }

            const safeTitle = escapeHtml(alert.title || 'Alert');
            const safeMessage = escapeHtml(alert.message || '');
            const safeMinerName = minerName ? escapeHtml(minerName) : '';
            const safeFullTime = escapeHtml(fullTime);
            const safeLevelLabel = escapeHtml(level.toUpperCase());

            html += `
                <div class="alert-item ${level}">
                    <div class="alert-item-icon">${icon}</div>
                    <div class="alert-item-content">
                        <div class="alert-item-header">
                            <div class="alert-item-title">${safeTitle}</div>
                            <div class="alert-item-time" title="${safeFullTime}">${relativeTime}</div>
                        </div>
                        ${safeMinerName ? `<div class="alert-item-miner">${safeMinerName}</div>` : ''}
                        <div class="alert-item-message">${safeMessage}</div>
                        ${extraDetails}
                    </div>
                    <span class="alert-item-level ${level}">${safeLevelLabel}</span>
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
async function loadEnergyConsumptionChart(hours = 168, { canvasId = 'energy-consumption-chart', instanceKey = 'energyConsumption', cancelKey = 'energyConsumption', summaryIds = null } = {}) {
    // Skip updates when tab is hidden
    if (!chartsVisible) return;

    // Cancel any pending request for this chart
    const signal = cancelChartRequest(cancelKey);

    try {
        const response = await fetch(`${API_BASE}/api/energy/consumption/actual?hours=${hours}`, { signal });
        const data = await response.json();

        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        // Determine summary element IDs
        const totalElId = summaryIds?.total || 'energy-chart-total';
        const costElId = summaryIds?.cost || 'energy-chart-cost';
        const avgElId = summaryIds?.avg || 'energy-chart-avg';

        if (!data.success || !data.hourly_breakdown || data.hourly_breakdown.length === 0) {
            if (chartInstances[instanceKey]) {
                chartInstances[instanceKey].data.datasets[0].data = [];
                chartInstances[instanceKey].update('none');
            }
            const te = document.getElementById(totalElId); if (te) te.textContent = '0.00 kWh';
            const ce = document.getElementById(costElId); if (ce) ce.textContent = '$0.00';
            const ae = document.getElementById(avgElId); if (ae) ae.textContent = '0.00 kWh';
            return;
        }

        // Prepare chart data - aggregate by day if showing more than 48 hours
        let chartDataPoints;
        if (hours > 48) {
            // Aggregate by day, extrapolating partial days using avg power
            const dailyData = {};
            data.hourly_breakdown.forEach(item => {
                const day = item.hour.split(' ')[0];
                if (!dailyData[day]) {
                    dailyData[day] = { kwh: 0, readings: 0, hoursWithData: 0 };
                }
                dailyData[day].kwh += item.kwh;
                dailyData[day].readings += item.readings;
                dailyData[day].hoursWithData++;
            });
            chartDataPoints = Object.entries(dailyData).map(([date, values]) => {
                let kwh = values.kwh;
                // Extrapolate partial days: if <20h of data, scale up based on avg power
                if (values.hoursWithData > 0 && values.hoursWithData < 20) {
                    const avgPowerKw = kwh / values.hoursWithData;
                    kwh = avgPowerKw * 24;
                }
                return { x: new Date(date), y: kwh };
            });
        } else {
            // Hourly data
            chartDataPoints = data.hourly_breakdown.map(item => ({
                x: new Date(item.hour.replace(' ', 'T') + ':00'),
                y: item.kwh
            }));
        }

        // Chart data and options
        const chartData = {
            datasets: [{
                label: 'Energy Consumed',
                data: chartDataPoints,
                backgroundColor: 'rgba(0, 212, 255, 0.6)',
                borderColor: 'rgba(0, 212, 255, 1)',
                borderWidth: 1,
                borderRadius: 4
            }]
        };
        const chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
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
        };

        // Update existing chart or create new one (prevents flickering)
        if (chartInstances[instanceKey]) {
            updateChartData(chartInstances[instanceKey], chartData, chartOptions);
        } else {
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            chartInstances[instanceKey] = new Chart(ctx, {
                type: 'bar',
                data: chartData,
                options: chartOptions
            });
        }
        if (instanceKey === 'energyConsumption') energyConsumptionChart = chartInstances[instanceKey];

        // Update summary — only count days with actual consumption for averages
        const daysWithData = chartDataPoints.filter(p => p.y > 0);
        const totalKwh = daysWithData.reduce((sum, p) => sum + p.y, 0);
        const numDays = hours > 48 ? daysWithData.length : Math.max(1, hours / 24);
        const avgDaily = numDays > 0 ? totalKwh / numDays : 0;

        // Compute cost from totalKwh using TOU blended rate so cost always matches the chart
        let totalCost = 0;
        try {
            const ratesResp = await fetch(`${API_BASE}/api/energy/rates`);
            const ratesData = await ratesResp.json();
            const rates = ratesData.rates || [];
            let peakHours = 0, offPeakHours = 0, peakRate = 0, offPeakRate = ratesData.current_rate || 0.10;
            for (const r of rates) {
                const [sh, sm] = r.start_time.split(':').map(Number);
                const [eh, em] = r.end_time.split(':').map(Number);
                const span = (r.end_time === '23:59' ? 24 : eh + em / 60) - (sh + sm / 60);
                if (r.rate_type === 'peak') { peakHours += span; peakRate = r.rate_per_kwh; }
                else { offPeakHours += span; offPeakRate = r.rate_per_kwh; }
            }
            if (peakHours === 0 && offPeakHours === 0) offPeakHours = 24;
            // Blended $/kWh weighted by hours in each rate period
            const blendedRate = (peakHours * peakRate + offPeakHours * offPeakRate) / (peakHours + offPeakHours);
            totalCost = totalKwh * blendedRate;
        } catch (e) {
            // Fallback: use raw API cost
            totalCost = data.total_cost || 0;
        }

        const totalEl = document.getElementById(totalElId); if (totalEl) totalEl.textContent = `${totalKwh.toFixed(2)} kWh`;
        const costEl = document.getElementById(costElId); if (costEl) costEl.textContent = `$${totalCost.toFixed(2)}`;
        const avgEl = document.getElementById(avgElId); if (avgEl) avgEl.textContent = `${avgDaily.toFixed(2)} kWh`;

    } catch (error) {
        if (error.name === 'AbortError') return;
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
    // Clear any existing timers to prevent orphaned intervals
    if (updateTimer) clearInterval(updateTimer);
    if (chartRefreshTimer) clearInterval(chartRefreshTimer);
    // Main refresh interval (5 seconds) - excludes charts (they have their own interval)
    updateTimer = setInterval(() => {
        if (currentTab === 'fleet') {
            loadDashboard();
        } else if (currentTab === 'energy') {
            // Use lighter refresh that doesn't reload chart
            refreshEnergyTabData();
        } else if (currentTab === 'alerts') {
            loadAlertHistory();
        } else if (currentTab === 'pools') {
            loadPoolsTab();
        }
    }, UPDATE_INTERVAL);

    // Chart refresh interval (30 seconds) - runs independently
    chartRefreshTimer = setInterval(() => {
        // Always refresh fleet chart on dashboard - read time range from dropdown
        if (currentTab === 'fleet') {
            const fleetChartHours = parseInt(document.getElementById('fleet-chart-timerange')?.value) || 3;
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
let poolDirectoryData = null;
let selectedPoolsForCompare = new Set();
let poolDirectoryLoaded = false;
let poolCurrentPage = 1;
const POOLS_PER_PAGE = 12;

// -- Badge Helpers --

function extractFeeDisplay(pool) {
    const raw = pool.fee_structure?.standard || '';
    // Try to extract a numeric percentage
    const match = raw.match(/([\d.]+)\s*%/);
    if (match) return match[1] + '%';
    // Clean labels for known non-numeric values
    const lower = raw.toLowerCase();
    if (lower.includes('private') || lower === '') return 'Private';
    if (lower.includes('n/a')) return 'N/A';
    if (lower.includes('varies') || lower.includes('competitive')) return 'Varies';
    if (lower.includes('maintenance') || lower.includes('not')) return 'N/A';
    if (lower.includes('tbd') || lower.includes('undisclosed') || lower.includes('exact')) return 'Undisclosed';
    // Fallback: if short enough, use it; otherwise label unknown
    return raw.length <= 8 ? raw : 'Varies';
}

function extractFeeNumber(pool) {
    const raw = pool.fee_structure?.standard || '';
    const match = raw.match(/([\d.]+)\s*%/);
    return match ? parseFloat(match[1]) : 99;
}

function extractPayoutDisplay(method) {
    if (!method) return '';
    const upper = method.toUpperCase();
    const known = ['FPPS', 'PPS+', 'PPS', 'PPLNS', 'SOLO', 'TIDES', 'SLICE'];
    const found = [];
    for (const k of known) {
        if (upper.includes(k) && !found.includes(k)) {
            // Avoid duplicate PPS if PPS+ already matched
            if (k === 'PPS' && found.includes('PPS+')) continue;
            if (k === 'PPS' && found.includes('FPPS')) continue;
            found.push(k);
        }
    }
    if (found.length > 0) return found.join(' / ');
    // Fallback: take first word(s) before parenthesis
    const clean = method.split('(')[0].trim();
    return clean.length <= 12 ? clean : clean.substring(0, 12);
}

function poolNameHash(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = ((hash << 5) - hash) + name.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash) % 360;
}

// -- Pool Tab Loading --

async function loadPoolsTab() {
    if (poolDirectoryLoaded) {
        // On subsequent calls, only reload miner pool config, not directory
        await loadAllPools();
        return;
    }
    await Promise.all([loadAllPools(), loadPoolDirectory()]);
    poolDirectoryLoaded = true;
}

// Load pool directory from API
async function loadPoolDirectory() {
    try {
        const response = await fetch(`${API_BASE}/api/pool-directory`);
        const result = await response.json();
        if (!result.success || !result.data || !result.data.pools) return;

        poolDirectoryData = result.data.pools;
        filterPoolDirectory();
        initPoolDirectoryFilters();
    } catch (error) {
        console.error('Error loading pool directory:', error);
    }
}

// Render pool directory cards (paginated)
function renderPoolDirectory(pools) {
    const grid = document.getElementById('pool-directory-grid');
    const countEl = document.getElementById('pool-directory-count');
    if (!grid) return;

    // Capture state before rebuild
    const expandedIds = new Set();
    const checkedIds = new Set(selectedPoolsForCompare);
    grid.querySelectorAll('.pd-card-details.open').forEach(el => {
        const card = el.closest('.pd-card');
        if (card?.dataset?.poolId) expandedIds.add(card.dataset.poolId);
    });

    // Pagination
    const totalPages = Math.ceil(pools.length / POOLS_PER_PAGE);
    if (poolCurrentPage > totalPages) poolCurrentPage = totalPages || 1;
    const startIdx = (poolCurrentPage - 1) * POOLS_PER_PAGE;
    const pagePools = pools.slice(startIdx, startIdx + POOLS_PER_PAGE);

    if (countEl) countEl.textContent = `Showing ${startIdx + 1}-${Math.min(startIdx + POOLS_PER_PAGE, pools.length)} of ${pools.length} pools`;

    while (grid.firstChild) grid.removeChild(grid.firstChild);

    pagePools.forEach(pool => {
        const card = document.createElement('div');
        card.className = 'pd-card';
        card.dataset.poolId = pool.id;

        // Apply status class for dimming
        const status = pool.status || 'active';
        if (status !== 'active') {
            card.classList.add(`status-${status}`);
        }

        // Header with initial circle and name
        const header = document.createElement('div');
        header.className = 'pd-card-header';
        const initial = document.createElement('div');
        initial.className = 'pd-card-initial';
        initial.textContent = (pool.name || '?')[0].toUpperCase();
        initial.style.background = `hsl(${poolNameHash(pool.name || '')}, 60%, 45%)`;
        const nameWrap = document.createElement('div');
        nameWrap.style.flex = '1';
        const nameEl = document.createElement('div');
        nameEl.className = 'pd-card-name';
        nameEl.textContent = pool.name;
        nameWrap.appendChild(nameEl);
        header.appendChild(initial);
        header.appendChild(nameWrap);

        // Status label for non-active pools
        if (status !== 'active') {
            const statusLabel = document.createElement('span');
            statusLabel.className = `pd-status-label status-${status}`;
            statusLabel.textContent = status.charAt(0).toUpperCase() + status.slice(1);
            header.appendChild(statusLabel);
        }

        // Badges (max 4: fee + payout + up to 2 feature badges)
        const badges = document.createElement('div');
        badges.className = 'pool-dir-badges';

        // Fee badge
        const feeDisplay = extractFeeDisplay(pool);
        const feeNum = extractFeeNumber(pool);
        const feeBadge = document.createElement('span');
        feeBadge.className = 'pool-badge';
        feeBadge.classList.add(feeNum < 1 ? 'badge-green' : feeNum <= 2 ? 'badge-yellow' : 'badge-red');
        if (feeNum >= 99) feeBadge.classList.replace('badge-red', 'badge-neutral');
        feeBadge.textContent = feeDisplay;
        badges.appendChild(feeBadge);

        // Payout method badge
        const payoutDisplay = extractPayoutDisplay(pool.payout_method);
        if (payoutDisplay) {
            const payoutBadge = document.createElement('span');
            payoutBadge.className = 'pool-badge badge-neutral';
            payoutBadge.textContent = payoutDisplay;
            badges.appendChild(payoutBadge);
        }

        // Feature badges (collect all, show max 2, rest as +N)
        const featureBadges = [];
        if (pool.supports_lightning) featureBadges.push({ text: 'Lightning', cls: 'badge-yellow' });
        if (!pool.requires_kyc) featureBadges.push({ text: 'No KYC', cls: 'badge-green' });
        if (pool.supports_solo_mining) featureBadges.push({ text: 'Solo', cls: 'badge-neutral' });
        if (pool.good_for_home_miners) featureBadges.push({ text: 'Home Miner', cls: 'badge-green' });

        const maxFeatureBadges = 2;
        const shownFeatures = featureBadges.slice(0, maxFeatureBadges);
        const extraCount = featureBadges.length - maxFeatureBadges;

        shownFeatures.forEach(fb => {
            const badge = document.createElement('span');
            badge.className = `pool-badge ${fb.cls}`;
            badge.textContent = fb.text;
            badges.appendChild(badge);
        });

        if (extraCount > 0) {
            const moreBadge = document.createElement('span');
            moreBadge.className = 'pool-badge badge-more';
            moreBadge.textContent = `+${extraCount}`;
            const tooltip = document.createElement('span');
            tooltip.className = 'badge-more-tooltip';
            tooltip.textContent = featureBadges.slice(maxFeatureBadges).map(f => f.text).join(', ');
            moreBadge.appendChild(tooltip);
            badges.appendChild(moreBadge);
        }

        // Details container (collapsed by default)
        const details = document.createElement('div');
        details.className = 'pd-card-details';
        if (expandedIds.has(pool.id)) details.classList.add('open');

        const desc = document.createElement('div');
        desc.className = 'pd-detail-description';
        desc.textContent = pool.unique_description || '';
        details.appendChild(desc);

        const detailsText = [];
        if (pool.minimum_payout) {
            detailsText.push(`Min Payout: ${pool.minimum_payout.onchain || 'N/A'}`);
            if (pool.minimum_payout.lightning && pool.minimum_payout.lightning !== 'Not supported') {
                detailsText.push(`Lightning Min: ${pool.minimum_payout.lightning}`);
            }
        }
        if (pool.stratum_urls && pool.stratum_urls.length > 0) {
            detailsText.push(`Stratum: ${pool.stratum_urls[0]}`);
        }
        if (pool.home_miner_notes) {
            detailsText.push(pool.home_miner_notes);
        }
        if (detailsText.length > 0) {
            const extraInfo = document.createElement('div');
            extraInfo.style.cssText = 'font-size: 0.8rem; color: var(--text-muted); margin-top: 8px; line-height: 1.4;';
            extraInfo.textContent = detailsText.join(' | ');
            details.appendChild(extraInfo);
        }

        // Actions
        const actions = document.createElement('div');
        actions.className = 'pd-card-actions';

        const expandBtn = document.createElement('button');
        expandBtn.className = 'pd-details-toggle';
        if (expandedIds.has(pool.id)) expandBtn.classList.add('open');
        expandBtn.textContent = 'Details';
        expandBtn.addEventListener('click', () => {
            details.classList.toggle('open');
            expandBtn.classList.toggle('open');
        });
        actions.appendChild(expandBtn);

        if (pool.website) {
            const linkBtn = document.createElement('a');
            linkBtn.className = 'pd-visit-btn';
            linkBtn.textContent = 'Visit';
            linkBtn.href = pool.website;
            linkBtn.target = '_blank';
            linkBtn.rel = 'noopener noreferrer';
            actions.appendChild(linkBtn);
        }

        const compareChk = document.createElement('label');
        compareChk.className = 'pool-compare-check';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = checkedIds.has(pool.id);
        chk.addEventListener('change', () => togglePoolCompare(pool.id, chk.checked));
        const chkLabel = document.createElement('span');
        chkLabel.textContent = 'Compare';
        compareChk.appendChild(chk);
        compareChk.appendChild(chkLabel);
        actions.appendChild(compareChk);

        card.appendChild(header);
        card.appendChild(badges);
        card.appendChild(details);
        card.appendChild(actions);
        grid.appendChild(card);
    });

    // Render pagination
    renderPoolPagination(totalPages);
}

function renderPoolPagination(totalPages) {
    const container = document.getElementById('pool-directory-pagination');
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);

    if (totalPages <= 1) return;

    // Prev button
    const prevBtn = document.createElement('button');
    prevBtn.className = 'pool-page-btn';
    prevBtn.textContent = 'Prev';
    prevBtn.disabled = poolCurrentPage <= 1;
    prevBtn.addEventListener('click', () => { poolCurrentPage--; filterPoolDirectory(); });
    container.appendChild(prevBtn);

    // Page number buttons
    for (let i = 1; i <= totalPages; i++) {
        const pageBtn = document.createElement('button');
        pageBtn.className = 'pool-page-btn';
        if (i === poolCurrentPage) pageBtn.classList.add('active');
        pageBtn.textContent = i;
        pageBtn.addEventListener('click', () => { poolCurrentPage = i; filterPoolDirectory(); });
        container.appendChild(pageBtn);
    }

    // Next button
    const nextBtn = document.createElement('button');
    nextBtn.className = 'pool-page-btn';
    nextBtn.textContent = 'Next';
    nextBtn.disabled = poolCurrentPage >= totalPages;
    nextBtn.addEventListener('click', () => { poolCurrentPage++; filterPoolDirectory(); });
    container.appendChild(nextBtn);
}

// Initialize pool directory filters and search
function initPoolDirectoryFilters() {
    const searchInput = document.getElementById('pool-directory-search');
    if (searchInput && !searchInput.dataset.bound) {
        searchInput.dataset.bound = '1';
        searchInput.addEventListener('input', () => { poolCurrentPage = 1; filterPoolDirectory(); });
    }

    document.querySelectorAll('.pool-filter-btn').forEach(btn => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
            document.querySelectorAll('.pool-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            poolCurrentPage = 1;
            filterPoolDirectory();
        });
    });

    const sortSelect = document.getElementById('pool-directory-sort');
    if (sortSelect && !sortSelect.dataset.bound) {
        sortSelect.dataset.bound = '1';
        sortSelect.addEventListener('change', () => { poolCurrentPage = 1; filterPoolDirectory(); });
    }
}

function filterPoolDirectory() {
    if (!poolDirectoryData) return;
    const search = (document.getElementById('pool-directory-search')?.value || '').toLowerCase();
    const filter = document.querySelector('.pool-filter-btn.active')?.dataset?.filter || 'all';
    const sort = document.getElementById('pool-directory-sort')?.value || 'name-az';

    let filtered = [...poolDirectoryData];

    // Text search
    if (search) {
        filtered = filtered.filter(p =>
            (p.name || '').toLowerCase().includes(search) ||
            (p.payout_method || '').toLowerCase().includes(search) ||
            (p.unique_description || '').toLowerCase().includes(search) ||
            (p.stratum_urls || []).some(u => u.toLowerCase().includes(search))
        );
    }

    // Category filter
    if (filter !== 'all') {
        filtered = filtered.filter(p => {
            switch (filter) {
                case 'active-only': return (p.status || 'active') === 'active';
                case 'home-miner': return p.good_for_home_miners;
                case 'no-kyc': return !p.requires_kyc;
                case 'lightning': return p.supports_lightning;
                case 'low-fee': return extractFeeNumber(p) < 2;
                case 'solo': return p.supports_solo_mining;
                case 'fpps': return (p.payout_method || '').toLowerCase().match(/fpps|pps/);
                case 'pplns': return (p.payout_method || '').toLowerCase().includes('pplns');
                default: return true;
            }
        });
    }

    // Sort non-active pools to bottom, then apply user sort
    const statusOrder = { active: 0, caution: 1, private: 2, legacy: 3 };
    filtered.sort((a, b) => {
        const sa = statusOrder[a.status || 'active'] || 0;
        const sb = statusOrder[b.status || 'active'] || 0;
        if (sa !== sb) return sa - sb;

        switch (sort) {
            case 'name-az': return (a.name || '').localeCompare(b.name || '');
            case 'name-za': return (b.name || '').localeCompare(a.name || '');
            case 'fee-low': return extractFeeNumber(a) - extractFeeNumber(b);
            case 'fee-high': return extractFeeNumber(b) - extractFeeNumber(a);
            case 'home-first': return (b.good_for_home_miners ? 1 : 0) - (a.good_for_home_miners ? 1 : 0);
            default: return 0;
        }
    });

    renderPoolDirectory(filtered);
}

function togglePoolCompare(poolId, checked) {
    if (checked) {
        if (selectedPoolsForCompare.size >= 4) {
            showAlert('Maximum 4 pools for comparison', 'warning');
            return;
        }
        selectedPoolsForCompare.add(poolId);
    } else {
        selectedPoolsForCompare.delete(poolId);
    }
    const btn = document.getElementById('compare-pools-btn');
    if (btn) {
        btn.textContent = `Compare Selected (${selectedPoolsForCompare.size})`;
        btn.disabled = selectedPoolsForCompare.size < 2;
    }
}

async function showPoolComparison() {
    if (selectedPoolsForCompare.size < 2) return;

    const modal = document.getElementById('pool-comparison-modal');
    if (modal) modal.style.display = 'flex';

    try {
        const response = await fetch(`${API_BASE}/api/pool-directory/compare`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pool_ids: [...selectedPoolsForCompare] })
        });
        const result = await response.json();
        if (!result.success) return;

        const content = document.getElementById('pool-comparison-content');
        if (!content) return;
        while (content.firstChild) content.removeChild(content.firstChild);

        // Build comparison table
        const table = document.createElement('table');
        table.className = 'comparison-table';

        const booleanFields = new Set(['Lightning', 'KYC Required', 'Solo Mining', 'Home Miner Friendly']);
        const fields = [
            ['Name', p => p.name],
            ['Fee', p => extractFeeDisplay(p)],
            ['Payout Method', p => extractPayoutDisplay(p.payout_method)],
            ['Min Payout (On-chain)', p => p.minimum_payout?.onchain || 'N/A'],
            ['Lightning', p => p.supports_lightning ? 'Yes' : 'No'],
            ['KYC Required', p => p.requires_kyc ? 'Yes' : 'No'],
            ['Solo Mining', p => p.supports_solo_mining ? 'Yes' : 'No'],
            ['Home Miner Friendly', p => p.good_for_home_miners ? 'Yes' : 'No'],
            ['Hashrate Share', p => p.approximate_hashrate_share || '?']
        ];

        fields.forEach(([label, getter]) => {
            const tr = document.createElement('tr');
            const th = document.createElement('th');
            th.textContent = label;
            tr.appendChild(th);
            result.pools.forEach(pool => {
                const td = document.createElement('td');
                const val = getter(pool);
                td.textContent = val;
                if (booleanFields.has(label)) {
                    td.classList.add(val === 'Yes' ? 'val-yes' : 'val-no');
                }
                tr.appendChild(td);
            });
            table.appendChild(tr);
        });

        content.appendChild(table);
    } catch (error) {
        console.error('Error comparing pools:', error);
    }
}

function closePoolComparison() {
    const modal = document.getElementById('pool-comparison-modal');
    if (modal) modal.style.display = 'none';
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

    // Use nickname from minersCache (populated from dashboard data) as primary source
    const cached = minersCache[miner.ip];
    const displayName = (cached && cached.custom_name) || miner.custom_name || miner.model || miner.type;

    return `
        <div class="pool-card">
            <div class="pool-card-header">
                <h3>${displayName}</h3>
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
                    <button type="submit" class="btn btn-primary pool-save-btn">Save Pool Configuration</button>
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
async function openMinerDetail(ip) {
    currentMinerIP = ip;
    isUserEditingFrequency = false;
    const modal = document.getElementById('miner-detail-modal');
    if (!modal) return;

    // Reset to overview tab
    switchMinerTab('overview');

    // Reset voltage controls (require acknowledgment each time)
    resetVoltageControls();

    // Load device specs if not yet cached
    await loadDeviceSpecs();

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
    const hashrateEl = document.getElementById('modal-hashrate');
    hashrateEl.textContent = hashrateFormatted.value;
    document.getElementById('modal-hashrate-unit').textContent = hashrateFormatted.unit;
    // Scale font to fit within the ring
    const valLen = hashrateFormatted.value.length;
    hashrateEl.style.fontSize = valLen > 6 ? '20px' : valLen > 4 ? '24px' : '28px';

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

    // Scoring shares — use ip param (not status.ip which may be undefined)
    const modalScoringEl = document.getElementById('modal-scoring-shares');
    if (modalScoringEl) {
        const cachedScore = scoringSharesCache[ip];
        if (cachedScore != null) {
            modalScoringEl.textContent = formatScoringNumber(cachedScore);
        } else if (!window._scoringFetchInFlight) {
            window._scoringFetchInFlight = true;
            modalScoringEl.textContent = '...';
            fetch(`${API_BASE}/api/stats/aggregate?hours=1`)
                .then(r => r.json())
                .then(data => {
                    if (data.success && data.stats?.scoring_shares_per_miner) {
                        scoringSharesCache = data.stats.scoring_shares_per_miner;
                        const score = scoringSharesCache[ip] ?? 0;
                        modalScoringEl.textContent = formatScoringNumber(score);
                    }
                })
                .catch(() => { modalScoringEl.textContent = '0'; })
                .finally(() => { window._scoringFetchInFlight = false; });
        }
    }

    // Calculate acceptance rate
    const totalShares = (status.shares_accepted || 0) + (status.shares_rejected || 0);
    const acceptRate = totalShares > 0 ? (status.shares_accepted / totalShares) * 100 : 100;

    // Update acceptance rate pie chart (actual pie showing accepted vs rejected proportions)
    const doughnutCanvas = document.getElementById('acceptance-pie-chart');
    const gaugePercent = document.getElementById('acceptance-rate-percent');
    if (doughnutCanvas && gaugePercent) {
        const accepted = status.shares_accepted || 0;
        const rejected = status.shares_rejected || 0;
        // Show enough precision so it never falsely reads 100% when there are rejected shares
        const displayRate = (rejected > 0 && acceptRate >= 99.95) ? acceptRate.toFixed(2) : acceptRate.toFixed(1);
        gaugePercent.textContent = `${displayRate}%`;
        // Ensure rejected slice is always visible (min 1.5% visual) when there are rejected shares
        const visualRejected = rejected > 0 ? Math.max(rejected, (accepted + rejected) * 0.015) : 0;
        const visualAccepted = rejected > 0 ? (accepted + rejected) - visualRejected : accepted;
        const pieData = {
            datasets: [{
                data: [visualAccepted, visualRejected],
                backgroundColor: ['#22c55e', '#ef4444'],
                borderWidth: 0,
                hoverOffset: 0,
                offset: 0,
                spacing: 1
            }]
        };
        if (window._acceptanceDoughnutChart) {
            window._acceptanceDoughnutChart.data = pieData;
            window._acceptanceDoughnutChart.update();
        } else {
            const ctx = doughnutCanvas.getContext('2d');
            if (ctx) {
                window._acceptanceDoughnutChart = new Chart(ctx, {
                    type: 'doughnut',
                    data: pieData,
                    options: {
                        responsive: false,
                        cutout: '68%',
                        animation: false,
                        spacing: 1,
                        plugins: {
                            legend: { display: false },
                            tooltip: { enabled: false }
                        },
                        hover: { mode: null }
                    }
                });
            }
        }
    }

    // Legacy share bar (if still present)
    const shareBarEl = document.getElementById('share-bar-accepted');
    if (shareBarEl) shareBarEl.style.width = `${acceptRate}%`;

    // --- Tuning Tab ---
    const frequency = status.raw?.frequency || status.frequency || 525;
    const coreVoltage = status.raw?.coreVoltage || status.core_voltage || 1150;
    const voltageInMv = Math.round(coreVoltage * (coreVoltage < 100 ? 1000 : 1));

    // Live frequency display (always updates)
    document.getElementById('modal-frequency').textContent = `${frequency} MHz`;
    document.getElementById('modal-voltage').textContent = `${voltageInMv} mV`;

    // Target frequency display - show what was last set (or current if not tracking)
    const targetFreq = lastSetTargetFrequency[ip] || frequency;
    const targetFreqEl = document.getElementById('modal-target-frequency');
    if (targetFreqEl) targetFreqEl.textContent = `${targetFreq} MHz`;

    // Device info bar
    const deviceInfo = getDeviceDisplayInfo(miner);
    const deviceTypeEl = document.getElementById('tuning-device-type');
    if (deviceTypeEl) deviceTypeEl.textContent = deviceInfo.name;
    const asicChipEl = document.getElementById('tuning-asic-chip');
    if (asicChipEl) {
        const chipText = deviceInfo.numChips > 1 ? `${deviceInfo.numChips}x ${deviceInfo.chip}` : deviceInfo.chip;
        asicChipEl.textContent = chipText;
    }
    const liveTempEl = document.getElementById('tuning-live-temp');
    if (liveTempEl) {
        liveTempEl.textContent = `${temp.toFixed(1)}°C`;
        liveTempEl.className = 'device-info-value';
        if (temp >= 75) liveTempEl.classList.add('temp-danger');
        else if (temp >= 65) liveTempEl.classList.add('temp-warning');
        else if (temp >= 40) liveTempEl.classList.add('temp-normal');
    }

    // Set voltage input to current value (only if user is NOT actively editing)
    const voltageInput = document.getElementById('voltage-input');
    if (voltageInput && !isUserEditingVoltage) {
        voltageInput.value = voltageInMv;
        updateVoltageWarning(voltageInMv);
    }

    // Update OC profile UI and device-specific frequency bounds
    updateOCProfileUI();
    updateFrequencyBoundsFromSpecs(miner, frequency);

    // Handle auto-tune vs manual frequency conflict
    updateAutoTuneFrequencyConflict(miner);

    // Only update frequency input/slider if user is NOT actively editing
    if (!isUserEditingFrequency) {
        const freqInput = document.getElementById('frequency-input');
        const freqSlider = document.getElementById('frequency-slider');
        if (freqInput) freqInput.value = frequency;
        if (freqSlider) {
            freqSlider.value = frequency;
            updateFrequencySliderDisplay(frequency);
        }
        syncPresetButtonsWithFrequency(frequency);
    }

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

// Clear local optimization state without backend calls (used when miner is removed).
function clearLocalOptimizationState(ip) {
    if (optimizationState.intervals[ip]) {
        clearInterval(optimizationState.intervals[ip]);
        delete optimizationState.intervals[ip];
    }
    if (optimizationState.miners[ip]) {
        delete optimizationState.miners[ip];
    }
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

// Update frequency slider/input bounds from device specs
function updateFrequencyBoundsFromSpecs(miner, currentFrequency) {
    const profile = getMinerOCProfile();
    const slider = document.getElementById('frequency-slider');
    const input = document.getElementById('frequency-input');
    const minLabel = document.getElementById('freq-slider-min');
    const maxLabel = document.getElementById('freq-slider-max');
    const min = profile?.frequency?.min || 50;
    const max = profile?.frequency?.max || 900;
    const step = profile?.frequency?.step || 25;
    if (slider) { slider.min = min; slider.max = max; slider.step = step; }
    if (input) { input.min = min; input.max = max; input.step = step; }
    if (minLabel) minLabel.textContent = min;
    if (maxLabel) maxLabel.textContent = max;
}

// Update the frequency slider's current value display
function updateFrequencySliderDisplay(frequency) {
    const currentDisplay = document.getElementById('freq-slider-current');
    if (currentDisplay) currentDisplay.textContent = `${frequency} MHz`;
}

// Check for auto-tune vs manual frequency conflict
function updateAutoTuneFrequencyConflict(miner) {
    // No-op if elements don't exist - prevents console errors
    const notice = document.getElementById('auto-tune-freq-notice');
    if (!notice) return;
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

    // Update target frequency display (not live frequency, which reflects actual miner state)
    const targetFreqEl = document.getElementById('modal-target-frequency');
    if (targetFreqEl) targetFreqEl.textContent = `${frequency} MHz`;

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
    isUserEditingVoltage = true;
    clearTimeout(window._voltageEditTimeout);
    window._voltageEditTimeout = setTimeout(() => { isUserEditingVoltage = false; }, 3000);

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

// Handle frequency slider input (called from HTML oninput)
function onFrequencySliderInput() {
    isUserEditingFrequency = true;
    const slider = document.getElementById('frequency-slider');
    const input = document.getElementById('frequency-input');
    const currentDisplay = document.getElementById('freq-slider-current');
    if (!slider) return;
    const value = parseInt(slider.value);
    if (input) input.value = value;
    if (currentDisplay) currentDisplay.textContent = `${value} MHz`;
    syncPresetButtonsWithFrequency(value);
    clearTimeout(window._freqEditTimeout);
    window._freqEditTimeout = setTimeout(() => { isUserEditingFrequency = false; }, 3000);
}

// Handle frequency number input change (called from HTML oninput)
function onFrequencyInputChange() {
    isUserEditingFrequency = true;
    const input = document.getElementById('frequency-input');
    const slider = document.getElementById('frequency-slider');
    if (!input) return;
    let value = parseInt(input.value) || 0;
    const minVal = parseInt(slider?.min) || 50;
    const maxVal = parseInt(slider?.max) || 900;
    value = Math.max(minVal, Math.min(maxVal, value));
    if (slider) slider.value = value;
    const currentDisplay = document.getElementById('freq-slider-current');
    if (currentDisplay) currentDisplay.textContent = `${value} MHz`;
    syncPresetButtonsWithFrequency(value);
    clearTimeout(window._freqEditTimeout);
    window._freqEditTimeout = setTimeout(() => { isUserEditingFrequency = false; }, 3000);
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

            // Track the target frequency we just applied
            lastSetTargetFrequency[currentMinerIP] = frequency;

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
        const safeIpJs = escapeJsString(ip);
        const safeNameJs = escapeJsString(miner.custom_name || '');
        editBtn.setAttribute('onclick', `editMinerName('${safeIpJs}', '${safeNameJs}')`);
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
            // Remove legacy shares section if present
            const oldSharesSection = card.querySelector('.miner-card-shares');
            if (oldSharesSection) oldSharesSection.remove();
            destroyMinerCardShareChart(ip);

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
                `;
            } else {
                newContent = document.createElement('div');
                newContent.className = 'status-offline';
                newContent.style.textAlign = 'center';
                newContent.style.padding = '20px';
                newContent.textContent = '⚠️ Offline';
            }

            if (newContent) {
                card.insertBefore(newContent, actions);
            }
        }
    } else if (shouldShowStats && statsContainer) {
        // Update stats in place (order: Hashrate, Temp, Power, Efficiency, Fan)
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

// Seasonal rate configuration toggle
function toggleSeasonalConfig() {
    const config = document.getElementById('seasonal-config');
    if (config) {
        config.classList.toggle('open');
    }
}

function setSeasonalMode(mode) {
    const buttons = document.querySelectorAll('.seasonal-toggle .toggle-btn');
    buttons.forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.seasonal === mode);
    });

    const seasonBlocks = document.getElementById('season-blocks');
    if (seasonBlocks) {
        if (mode === 'on') {
            seasonBlocks.classList.add('visible');
        } else {
            seasonBlocks.classList.remove('visible');
        }
    }
}
