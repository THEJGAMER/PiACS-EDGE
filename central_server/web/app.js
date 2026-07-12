document.addEventListener('DOMContentLoaded', () => {
    // Navigation Tabs
    const navItems = document.querySelectorAll('.menu-item');
    const panels = document.querySelectorAll('.view-panel');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navItems.forEach(nav => nav.classList.remove('active'));
            panels.forEach(panel => panel.classList.remove('active'));

            item.classList.add('active');
            const targetId = 'view-' + item.id.replace('btn-', '');
            document.getElementById(targetId).classList.add('active');

            // Clear health polling interval when changing tabs
            if (healthPollInterval) {
                clearInterval(healthPollInterval);
                healthPollInterval = null;
            }
            if (mapPollInterval) {
                clearInterval(mapPollInterval);
                mapPollInterval = null;
            }

            if (item.id === 'btn-syslogs') {
                loadControllerLogs();
            } else if (item.id === 'btn-events') {
                loadSites();
                loadEventsDoors();
                loadEventsConsole();
            } else if (item.id === 'btn-map') {
                loadMapPlacements();
                mapPollInterval = setInterval(loadAPBOccupancy, 5000);
            } else if (item.id === 'btn-threat') {
                loadThreatLevel();
            } else if (item.id === 'btn-health') {
                loadSystemHealth();
                healthPollInterval = setInterval(loadSystemHealth, 5000);
            } else if (item.id === 'btn-accesshub') {
                loadSchedules();
                loadHolidays();
                loadAccessLevels();
                loadCredentials();
            } else if (item.id === 'btn-config') {
                checkConfigAuth();
            }
        });
    });

    // Sub-tab toggles in Access Control Hub
    const subTabItems = document.querySelectorAll('.sub-tab-item');
    const subTabContents = document.querySelectorAll('.sub-tab-content');

    subTabItems.forEach(btn => {
        btn.addEventListener('click', () => {
            subTabItems.forEach(item => item.classList.remove('active'));
            subTabContents.forEach(content => content.classList.remove('active'));

            btn.classList.add('active');
            const targetSubtab = btn.getAttribute('data-subtab');
            document.getElementById(targetSubtab).classList.add('active');
        });
    });

    // Side-Drawer actions for Cardholder
    const drawer = document.getElementById('cardholder-drawer');
    const closeDrawerBtn = document.getElementById('btn-close-cardholder-drawer');
    const cancelBadgeBtn = document.getElementById('btn-cancel-badge');
    const addCardholderBtn = document.getElementById('btn-add-cardholder');

    function openDrawer(isEdit = false) {
        drawer.classList.add('drawer-open');
        if (!isEdit) {
            document.getElementById('form-credential').reset();
            document.getElementById('cred-id').value = '';
            document.getElementById('cred-user-id').value = '';
            document.getElementById('btn-save-badge').innerText = 'Register Badge Credential';
            
            // Set default validity dates
            const todayStr = new Date().toISOString().split('T')[0];
            document.getElementById('cred-start-date').value = todayStr;
            const nextYear = new Date();
            nextYear.setFullYear(nextYear.getFullYear() + 1);
            document.getElementById('cred-end-date').value = nextYear.toISOString().split('T')[0];

            // Uncheck all access levels
            document.querySelectorAll('input[name="cred-al"]').forEach(cb => cb.checked = false);
        }
    }

    function closeDrawer() {
        drawer.classList.remove('drawer-open');
    }

    if (addCardholderBtn) {
        addCardholderBtn.addEventListener('click', () => openDrawer(false));
    }
    if (closeDrawerBtn) {
        closeDrawerBtn.addEventListener('click', closeDrawer);
    }
    if (cancelBadgeBtn) {
        cancelBadgeBtn.addEventListener('click', closeDrawer);
    }

    // Search and status filters for Cardholders
    const searchCardholderInput = document.getElementById('search-cardholder');
    if (searchCardholderInput) {
        searchCardholderInput.addEventListener('input', (e) => {
            currentFilterSearch = e.target.value.toLowerCase();
            renderCredentials();
        });
    }

    const filterStatusButtons = document.querySelectorAll('.filter-status-btn');
    filterStatusButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            filterStatusButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilterStatus = btn.getAttribute('data-status');
            renderCredentials();
        });
    });

    // Dynamic Time Zone intervals
    const addIntervalBtn = document.getElementById('btn-add-interval');
    const intervalsContainer = document.getElementById('tz-intervals-container');

    addIntervalBtn.addEventListener('click', () => {
        const row = document.createElement('div');
        row.className = 'interval-row mt-2';
        row.innerHTML = `
            <select class="sel-day">
                <option value="1">Monday</option>
                <option value="2">Tuesday</option>
                <option value="3">Wednesday</option>
                <option value="4">Thursday</option>
                <option value="5">Friday</option>
                <option value="6">Saturday</option>
                <option value="0">Sunday</option>
                <option value="7">Holiday Only</option>
            </select>
            <input type="time" class="time-start" value="08:00">
            <input type="time" class="time-end" value="17:00">
        `;
        intervalsContainer.appendChild(row);
    });

    // Controllers State Matrix
    let controllersMap = {}; // controller_id -> state details
    let globalControllers = [];
    let globalTimezones = [];
    let healthPollInterval = null;
    let eventsCache = [];    // Cached logs for filtering and CSV export
    let credentialsCache = [];
    let currentFilterStatus = 'ALL';
    let currentFilterSearch = '';
    
    // Auth & Logging State
    let configAuthToken = sessionStorage.getItem('piacs_config_token') || null;
    let selectedConfigControllerId = '';
    let systemLogsCache = [];

    // Load Initial Data
    loadControllers();
    loadSchedules();
    loadHolidays();
    loadAccessLevels();
    loadCredentials();
    loadInitialEvents();
    checkConfigAuth();

    // Start Live SSE Event Stream
    startEventStream();

    // Global Overrides
    document.getElementById('btn-global-unlock').addEventListener('click', () => sendCommand('ALL', 'REMOTE_UNLOCK'));
    document.getElementById('btn-global-lockdown').addEventListener('click', () => sendCommand('ALL', 'FORCE_LOCK'));
    document.getElementById('btn-global-clear').addEventListener('click', () => sendCommand('ALL', 'CLEAR_ALARMS'));

    // Forms Form submission handlers
    document.getElementById('form-timezone').addEventListener('submit', saveTimeZone);
    document.getElementById('form-holiday').addEventListener('submit', saveHoliday);
    document.getElementById('form-access-level').addEventListener('submit', saveAccessLevel);
    document.getElementById('form-credential').addEventListener('submit', saveCredential);

    // Logging Console Filters
    document.getElementById('log-filter-type').addEventListener('change', renderLogs);
    document.getElementById('log-search').addEventListener('input', renderLogs);
    document.getElementById('btn-log-export').addEventListener('click', exportLogsCSV);

    function renderAccessLevelFormMappings() {
        const container = document.getElementById('al-mappings-container');
        if (!container) return;
        container.innerHTML = '';

        if (globalControllers.length === 0) {
            container.innerHTML = '<div style="color: #888; font-size: 13px; padding: 4px 0;">No reader controllers found/loaded.</div>';
            return;
        }

        globalControllers.forEach(ctrl => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.gap = '12px';
            row.style.padding = '8px 0';
            row.style.borderBottom = '1px solid rgba(255,255,255,0.03)';

            // Checkbox + Name
            const left = document.createElement('div');
            left.style.display = 'flex';
            left.style.alignItems = 'center';
            left.style.gap = '8px';
            left.innerHTML = `
                <input type="checkbox" class="mapping-chk" data-reader-id="${ctrl.controller_id}">
                <span style="font-weight: 500; color: #fff; font-size: 13px;">${ctrl.controller_id} <span style="color: #888; font-size: 12px;">(${ctrl.friendly_name})</span></span>
            `;

            // Timezone Select
            const right = document.createElement('div');
            const tzSelect = document.createElement('select');
            tzSelect.className = 'mapping-tz';
            tzSelect.style.padding = '4px 8px';
            tzSelect.style.fontSize = '12px';
            tzSelect.style.background = '#1e293b';
            tzSelect.style.border = '1px solid rgba(255,255,255,0.1)';
            tzSelect.style.borderRadius = '4px';
            tzSelect.style.color = '#fff';

            globalTimezones.forEach(tz => {
                const opt = document.createElement('option');
                opt.value = tz.id;
                opt.innerText = tz.name;
                tzSelect.appendChild(opt);
            });

            right.appendChild(tzSelect);
            row.appendChild(left);
            row.appendChild(right);
            container.appendChild(row);
        });
    }

    async function loadControllers() {
        try {
            const res = await fetch('/api/controllers');
            const data = await res.json();
            globalControllers = data;
            renderAccessLevelFormMappings();

            const container = document.getElementById('doors-container');
            const logCtrlSelect = document.getElementById('log-ctrl-select');
            
            container.innerHTML = '';
            logCtrlSelect.innerHTML = '<option value="">All Controllers</option>';
            document.getElementById('stat-ctrls').innerText = data.length;

            data.forEach(ctrl => {
                controllersMap[ctrl.controller_id] = {
                    name: ctrl.friendly_name,
                    ip: ctrl.server_ip,
                    isOnline: ctrl.is_online,
                    isOpen: false,
                    alarm: false,
                    lockdown: false,
                    sustain: false
                };

                // Add option to log controller select
                const optLog = document.createElement('option');
                optLog.value = ctrl.controller_id;
                optLog.innerText = `${ctrl.controller_id} (${ctrl.friendly_name})`;
                logCtrlSelect.appendChild(optLog);

                // Build door card
                const card = document.createElement('div');
                card.className = `card glass door-card ${ctrl.is_online ? '' : 'offline'}`;
                card.id = `card-${ctrl.controller_id}`;
                card.innerHTML = `
                    <div class="door-card-header">
                        <div>
                            <h4>${ctrl.friendly_name}</h4>
                            <span class="ip">${ctrl.controller_id} (${ctrl.server_ip})</span>
                        </div>
                        <span class="status-badge ${ctrl.is_online ? 'secure' : 'offline'}" id="badge-${ctrl.controller_id}">
                            ${ctrl.is_online ? 'SECURE' : 'OFFLINE'}
                        </span>
                    </div>
                    <div class="door-viz-wrapper" id="viz-wrapper-${ctrl.controller_id}">
                        <svg viewBox="0 0 200 200" width="100%" height="150">
                            <line x1="20" y1="100" x2="70" y2="100" stroke="#444" stroke-width="8" stroke-linecap="round"/>
                            <line x1="130" y1="100" x2="180" y2="100" stroke="#444" stroke-width="8" stroke-linecap="round"/>
                            <path d="M 70 100 A 60 60 0 0 1 130 100" fill="none" stroke="#222" stroke-width="2" stroke-dasharray="4 4"/>
                            <line id="wing-${ctrl.controller_id}" x1="70" y1="100" x2="130" y2="100" stroke="#10b981" stroke-width="6" stroke-linecap="round"/>
                            <circle id="led-${ctrl.controller_id}" cx="135" cy="85" r="8" fill="#10b981" class="led-glow"/>
                        </svg>
                    </div>
                    <div class="door-actions-grid">
                        <button class="btn btn-grant btn-action-unlock" data-id="${ctrl.controller_id}">🔓 Unlock</button>
                        <button class="btn btn-lockdown btn-action-lockdown" id="action-lock-${ctrl.controller_id}" data-id="${ctrl.controller_id}">🚨 Lockdown</button>
                        <button class="btn btn-sustain btn-action-sustain" id="action-sustain-${ctrl.controller_id}" data-id="${ctrl.controller_id}">🚪 Sustain</button>
                        <button class="btn btn-clear btn-action-clear" data-id="${ctrl.controller_id}">🛡️ Clear</button>
                        <button class="btn btn-secondary btn-action-logs" data-id="${ctrl.controller_id}" style="grid-column: span 2;">💬 Console Logs</button>
                    </div>
                `;
                container.appendChild(card);
            });

            // Bind individual card override buttons
            document.querySelectorAll('.btn-action-unlock').forEach(b => b.addEventListener('click', e => sendCommand(e.target.dataset.id, 'REMOTE_UNLOCK')));
            document.querySelectorAll('.btn-action-lockdown').forEach(b => b.addEventListener('click', e => {
                const cId = e.target.dataset.id;
                sendCommand(cId, controllersMap[cId].lockdown ? 'REMOVE_LOCKDOWN' : 'FORCE_LOCK');
            }));
            document.querySelectorAll('.btn-action-sustain').forEach(b => b.addEventListener('click', e => {
                const cId = e.target.dataset.id;
                sendCommand(cId, controllersMap[cId].sustain ? 'CLOSE_SUSTAIN' : 'SUSTAIN_OPEN');
            }));
            document.querySelectorAll('.btn-action-clear').forEach(b => b.addEventListener('click', e => sendCommand(e.target.dataset.id, 'CLEAR_ALARMS')));
            document.querySelectorAll('.btn-action-logs').forEach(b => b.addEventListener('click', e => {
                const cId = e.target.dataset.id;
                document.getElementById('btn-syslogs').click();
                document.getElementById('log-ctrl-select').value = cId;
                loadControllerLogs();
            }));

        } catch (err) {
            console.error('Failed to load controllers:', err);
        }
    }

    async function loadInitialEvents() {
        try {
            const res = await fetch('/api/events');
            eventsCache = await res.json();
            renderLogs();
            updateAlarmsStat();
        } catch (err) {
            console.error('Failed to load initial events:', err);
        }
    }

    function startEventStream() {
        const stream = new EventSource('/api/events/stream');
        const indicator = document.getElementById('server-indicator');

        stream.onopen = () => {
            indicator.className = 'status-indicator online';
            indicator.nextElementSibling.innerText = 'Sync Node: Online';
        };

        stream.onerror = () => {
            indicator.className = 'status-indicator offline';
            indicator.nextElementSibling.innerText = 'Sync Node: Offline';
        };

        stream.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.event_source === 'system') {
                if (data.event_type === 'THREAT_LEVEL_CHANGE') {
                    updateThreatLevelUI(data.threat_level);
                    showToastAlert({
                        level: 'WARN',
                        controller_id: 'SYSTEM',
                        message: data.details
                    });
                }
                return;
            }

            if (data.event_source === 'controller_logs') {
                systemLogsCache.unshift(data);
                if (systemLogsCache.length > 500) systemLogsCache.pop();

                const currentCtrl = document.getElementById('log-ctrl-select').value;
                const currentLvl = document.getElementById('log-level-select').value;
                if ((!currentCtrl || currentCtrl === data.controller_id) && (!currentLvl || currentLvl === data.level)) {
                    renderSystemLogs(document.getElementById('log-msg-search').value.toLowerCase());
                }

                if (['WARN', 'ERROR', 'FATAL'].includes(data.level)) {
                    showToastAlert(data);
                }
                return;
            }

            // Prepend to memory cache
            eventsCache.unshift(data);
            if (eventsCache.length > 200) eventsCache.pop(); // Keep cache size sane

            // Prepend to Events Console Cache
            if (typeof eventsConsoleCache !== 'undefined' && Array.isArray(eventsConsoleCache)) {
                eventsConsoleCache.unshift(data);
                if (eventsConsoleCache.length > 200) eventsConsoleCache.pop();
                if (typeof renderEventsConsole === 'function') {
                    renderEventsConsole();
                }
            }

            renderLogs();
            evaluateTelemetry(data);
            updateAlarmsStat();
        };
    }

    function evaluateTelemetry(data) {
        const cId = data.controller_id;
        if (!controllersMap[cId]) return;

        const led = document.getElementById(`led-${cId}`);
        const wing = document.getElementById(`wing-${cId}`);
        const badge = document.getElementById(`badge-${cId}`);
        const wrapper = document.getElementById(`viz-wrapper-${cId}`);
        const card = document.getElementById(`card-${cId}`);

        if (data.event_source === 'system_alarms') {
            const isCleared = data.is_cleared;
            controllersMap[cId].alarm = !isCleared;

            if (!isCleared) {
                badge.innerText = data.alarm_type || data.event_type;
                badge.className = 'status-badge alarm';
                led.className = 'led-glow led-red';
                card.classList.add('alarm-active');
            } else {
                controllersMap[cId].alarm = false;
                card.classList.remove('alarm-active');
                resetVisuals(cId);
            }
            return;
        }

        if (data.event_source === 'access_logs') {
            const type = data.event_type;

            if (type === 'CARD_GRANT' || (type === 'API_COMMAND' && data.details.includes('unlock'))) {
                controllersMap[cId].isOpen = true;
                wrapper.classList.add('door-open');
                badge.innerText = 'OPEN (AUTH)';
                badge.className = 'status-badge open';
                led.className = 'led-glow';

                setTimeout(() => {
                    controllersMap[cId].isOpen = false;
                    if (!controllersMap[cId].alarm && !controllersMap[cId].sustain) {
                        wrapper.classList.remove('door-open');
                        resetVisuals(cId);
                    }
                }, 4000);
            }

            else if (type === 'DENY' || type === 'DENY_SCHEDULE') {
                led.className = 'led-glow led-red';
                setTimeout(() => {
                    if (!controllersMap[cId].alarm && !controllersMap[cId].lockdown) {
                        led.className = 'led-glow';
                    }
                }, 1500);
            }

            else if (type === 'DOOR_OPEN') {
                controllersMap[cId].isOpen = true;
                wrapper.classList.add('door-open');
                if (!controllersMap[cId].alarm && !controllersMap[cId].sustain) {
                    badge.innerText = 'OPEN';
                    badge.className = 'status-badge open';
                }
            }

            else if (type === 'DOOR_CLOSE') {
                controllersMap[cId].isOpen = false;
                if (!controllersMap[cId].alarm && !controllersMap[cId].sustain) {
                    wrapper.classList.remove('door-open');
                    resetVisuals(cId);
                }
            }

            else if (type === 'DFO' || type === 'DHO' || type === 'APB_VIOLATION') {
                controllersMap[cId].alarm = true;
                badge.innerText = type;
                badge.className = 'status-badge alarm';
                led.className = 'led-glow led-red';
                card.classList.add('alarm-active');
            }
        }
    }

    function resetVisuals(cId) {
        const led = document.getElementById(`led-${cId}`);
        const badge = document.getElementById(`badge-${cId}`);
        const wrapper = document.getElementById(`viz-wrapper-${cId}`);
        const c = controllersMap[cId];

        if (c.lockdown) {
            badge.innerText = 'LOCKDOWN';
            badge.className = 'status-badge lockdown';
            led.className = 'led-glow led-purple';
            wrapper.classList.remove('door-open');
        } else if (c.sustain) {
            badge.innerText = 'SUSTAIN';
            badge.className = 'status-badge open';
            led.className = 'led-glow led-yellow';
            wrapper.classList.add('door-open');
        } else {
            badge.innerText = 'SECURE';
            badge.className = 'status-badge secure';
            led.className = 'led-glow';
            wrapper.classList.remove('door-open');
        }
    }

    function updateAlarmsStat() {
        let activeAlarms = 0;
        for (let cId in controllersMap) {
            if (controllersMap[cId].alarm) activeAlarms++;
        }
        const statAl = document.getElementById('stat-alarms');
        statAl.innerText = activeAlarms;
        if (activeAlarms > 0) {
            statAl.className = 'val alarm active';
        } else {
            statAl.className = 'val alarm';
        }
    }

    function renderLogs() {
        const consoleEl = document.getElementById('log-console');
        const filterType = document.getElementById('log-filter-type').value;
        const searchQuery = document.getElementById('log-search').value.toLowerCase();

        consoleEl.innerHTML = '';

        const filtered = eventsCache.filter(e => {
            // Type Filter
            if (filterType === 'GRANT') {
                if (e.event_type !== 'CARD_GRANT') return false;
            } else if (filterType === 'DENY') {
                if (e.event_type !== 'DENY' && e.event_type !== 'DENY_SCHEDULE') return false;
            } else if (filterType === 'ALARM') {
                if (e.event_source !== 'system_alarms' && !['DFO', 'DHO', 'APB_VIOLATION'].includes(e.event_type)) return false;
            }

            // Search Keyword Filter
            if (searchQuery) {
                const name = (e.employee_name || '').toLowerCase();
                const card = (e.card_id || '').toLowerCase();
                const type = (e.event_type || e.alarm_type || '').toLowerCase();
                const details = (e.details || '').toLowerCase();
                const ctrl = (e.controller_id || '').toLowerCase();

                if (!name.includes(searchQuery) && !card.includes(searchQuery) && !type.includes(searchQuery) && !details.includes(searchQuery) && !ctrl.includes(searchQuery)) {
                    return false;
                }
            }

            return true;
        });

        filtered.forEach(e => {
            const row = document.createElement('div');
            let typeClass = 'info';
            let typeLabel = 'INFO';
            let detailText = e.details;

            if (e.event_source === 'system_alarms') {
                typeClass = 'alarm';
                typeLabel = e.alarm_type || e.event_type;
                detailText = `CRITICAL ALARM on Controller ${e.controller_id}: ${e.details}`;
            } else {
                const et = e.event_type;
                typeLabel = et;
                if (et.includes('GRANT')) typeClass = 'grant';
                else if (et.includes('DENY') || et.includes('REJECT')) typeClass = 'deny';
                else if (et.includes('ALARM') || ['DFO', 'DHO', 'APB_VIOLATION'].includes(et)) typeClass = 'alarm';
                else if (et.includes('WARN')) typeClass = 'warn';
            }

            const timeStr = formatDateTime(e.event_timestamp || e.created_at);
            row.className = `log-row ${typeClass}`;
            row.innerHTML = `
                <span class="time">[${timeStr}]</span>
                <span class="type">${typeLabel}</span>
                <span class="message">${detailText} ${e.employee_name ? '(' + e.employee_name + ')' : ''}</span>
            `;
            consoleEl.appendChild(row);
        });
    }

    function exportLogsCSV() {
        const headers = ['Timestamp', 'Event Source', 'Controller ID', 'Type', 'Employee Name', 'Card ID', 'Details'];
        const csvRows = [headers.join(',')];

        eventsCache.forEach(e => {
            const dateStr = formatDateTime(e.event_timestamp || e.created_at);
            const source = e.event_source;
            const ctrl = e.controller_id;
            const type = e.event_type || e.alarm_type;
            const name = e.employee_name || '';
            const card = e.card_id || '';
            const details = (e.details || '').replace(/"/g, '""');

            csvRows.push([
                `"${dateStr}"`,
                `"${source}"`,
                `"${ctrl}"`,
                `"${type}"`,
                `"${name}"`,
                `"${card}"`,
                `"${details}"`
            ].join(','));
        });

        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('href', url);
        a.setAttribute('download', `piacs_events_export_${new Date().toISOString().slice(0,10)}.csv`);
        a.click();
    }

    async function sendCommand(controllerId, command) {
        try {
            const res = await fetch('/api/controller/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    controller_id: controllerId,
                    command: command
                })
            });
            const data = await res.json();
            console.log('Command return:', data);

            // Handle local state updates for visual representation
            const updateState = (cId) => {
                const lockBtn = document.getElementById(`action-lock-${cId}`);
                const sustainBtn = document.getElementById(`action-sustain-${cId}`);

                if (command === 'FORCE_LOCK') {
                    controllersMap[cId].lockdown = true;
                    if (lockBtn) {
                        lockBtn.innerText = '🛡️ Unlock L';
                        lockBtn.className = 'btn btn-grant btn-action-lockdown';
                    }
                } else if (command === 'REMOVE_LOCKDOWN') {
                    controllersMap[cId].lockdown = false;
                    if (lockBtn) {
                        lockBtn.innerText = '🚨 Lockdown';
                        lockBtn.className = 'btn btn-lockdown btn-action-lockdown';
                    }
                } else if (command === 'SUSTAIN_OPEN') {
                    controllersMap[cId].sustain = true;
                    if (sustainBtn) {
                        sustainBtn.innerText = '🔒 Lock S';
                        sustainBtn.className = 'btn btn-lockdown btn-action-sustain';
                    }
                } else if (command === 'CLOSE_SUSTAIN') {
                    controllersMap[cId].sustain = false;
                    if (sustainBtn) {
                        sustainBtn.innerText = '🚪 Sustain';
                        sustainBtn.className = 'btn btn-sustain btn-action-sustain';
                    }
                } else if (command === 'CLEAR_ALARMS') {
                    controllersMap[cId].alarm = false;
                }

                resetVisuals(cId);
            };

            if (controllerId === 'ALL') {
                for (let cId in controllersMap) {
                    updateState(cId);
                }
            } else {
                updateState(controllerId);
            }
            updateAlarmsStat();

        } catch (err) {
            console.error('Command delivery error:', err);
        }
    }

    // Schedules Management
    async function loadSchedules() {
        const res = await fetch('/api/schedules');
        const data = await res.json();
        globalTimezones = data;
        renderAccessLevelFormMappings();

        const tbody = document.querySelector('#table-timezones tbody');
        tbody.innerHTML = '';

        data.forEach(tz => {
            const tr = document.createElement('tr');
            
            // Build the visual 24h weekly timeline
            let timelineHtml = '<div class="timeline-bar-container">';
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Holiday'];
            
            for (let dayIdx = 0; dayIdx < 8; dayIdx++) {
                const dayIntervals = tz.intervals.filter(iv => iv.day_of_week === dayIdx);
                
                timelineHtml += `
                    <div class="timeline-bar-row">
                        <span class="timeline-day-label">${dayNames[dayIdx]}</span>
                        <div class="timeline-bar-visual">
                `;
                
                dayIntervals.forEach(iv => {
                    const startParts = iv.start_time.split(':');
                    const endParts = iv.end_time.split(':');
                    const startMin = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
                    const endMin = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
                    
                    const leftPct = (startMin / 1440) * 100;
                    const widthPct = ((endMin - startMin) / 1440) * 100;
                    
                    timelineHtml += `
                        <div class="timeline-bar-active-segment" style="left: ${leftPct}%; width: ${widthPct}%;" title="${iv.start_time.slice(0, 5)} - ${iv.end_time.slice(0, 5)}"></div>
                    `;
                });
                
                timelineHtml += `
                        </div>
                    </div>
                `;
            }
            timelineHtml += '</div>';

            tr.innerHTML = `
                <td>${tz.id}</td>
                <td style="font-weight: bold; color: #fff; vertical-align: top; min-width: 150px;">${tz.name}</td>
                <td style="min-width: 300px;">${timelineHtml}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    async function saveTimeZone(e) {
        e.preventDefault();
        const name = document.getElementById('tz-name').value;
        const intervalRows = document.querySelectorAll('.interval-row');
        const intervals = [];

        intervalRows.forEach(row => {
            const day = parseInt(row.querySelector('.sel-day').value);
            const start = row.querySelector('.time-start').value + ':00';
            const end = row.querySelector('.time-end').value + ':00';
            intervals.push({ day_of_week: day, start_time: start, end_time: end });
        });

        const res = await fetch('/api/schedules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, intervals })
        });

        if (res.ok) {
            document.getElementById('form-timezone').reset();
            intervalsContainer.innerHTML = `
                <div class="interval-row">
                    <select class="sel-day">
                        <option value="1">Monday</option>
                        <option value="2">Tuesday</option>
                        <option value="3">Wednesday</option>
                        <option value="4">Thursday</option>
                        <option value="5">Friday</option>
                        <option value="6">Saturday</option>
                        <option value="0">Sunday</option>
                        <option value="7">Holiday Only</option>
                    </select>
                    <input type="time" class="time-start" value="08:00">
                    <input type="time" class="time-end" value="17:00">
                </div>
            `;
            loadSchedules();
        }
    }

    // Holidays Management
    async function loadHolidays() {
        const res = await fetch('/api/holidays');
        const data = await res.json();
        const tbody = document.querySelector('#table-holidays tbody');
        tbody.innerHTML = '';
        data.forEach(h => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${formatDateOnly(h.holiday_date)}</td>
                <td>${h.name}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    async function saveHoliday(e) {
        e.preventDefault();
        const date = document.getElementById('hol-date').value;
        const name = document.getElementById('hol-name').value;

        const res = await fetch('/api/holidays', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ holiday_date: date, name })
        });

        if (res.ok) {
            document.getElementById('form-holiday').reset();
            loadHolidays();
        }
    }

    // Access Levels Management
    let allAccessLevelsData = [];

    async function loadAccessLevels() {
        const res = await fetch('/api/access-levels');
        const data = await res.json();
        allAccessLevelsData = data;
        const credContainer = document.getElementById('cred-access-levels-container');
        credContainer.innerHTML = '';
        data.forEach(al => {
            const lbl = document.createElement('label');
            lbl.style.display = 'block';
            lbl.style.marginBottom = '6px';
            lbl.innerHTML = `
                <input type="checkbox" name="cred-al" value="${al.id}">
                <span style="font-weight: bold; color: #fff;">${al.name}</span>
                <span style="color: #888; font-size: 11px;">(${al.mappings ? al.mappings.map(m => m.reader_id).join(', ') : 'No readers'})</span>
            `;
            credContainer.appendChild(lbl);
        });
        renderAccessLevels(data);
    }

    function renderAccessLevels(data) {
        const tbody = document.querySelector('#table-access-levels tbody');
        tbody.innerHTML = '';
        data.forEach(al => {
            const tr = document.createElement('tr');
            let mappingsHtml = '';
            if (al.mappings && al.mappings.length > 0) {
                mappingsHtml = al.mappings.map(m => `
                    <div style="margin-bottom: 4px;">
                        <span style="font-family: monospace; color: #10b981; font-weight: bold;">${m.reader_id}</span>
                        ➔
                        <span style="color: #60a5fa;">${m.timezone_name || ('TZ ' + m.time_zone_id)}</span>
                    </div>
                `).join('');
            } else {
                mappingsHtml = '<span style="color:#666; font-style:italic;">No reader mappings</span>';
            }

            tr.innerHTML = `
                <td>${al.id}</td>
                <td style="font-weight: bold; color: #fff;">${al.name}</td>
                <td>${mappingsHtml}</td>
                <td><span style="color: ${al.dho_override ? 'var(--green-color)' : 'var(--text-secondary)'}; font-weight: bold;">${al.dho_override ? 'YES' : 'NO'}</span></td>
                <td>
                    <button class="btn btn-secondary btn-al-edit" data-id="${al.id}" style="padding: 4px 8px; font-size: 12px; display: inline-block;">Edit</button>
                    <button class="btn btn-secondary btn-al-delete" data-id="${al.id}" style="padding: 4px 8px; font-size: 12px; display: inline-block; border-color: rgba(239,68,68,0.2); color: #f87171;">Delete</button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        // Bind Edit buttons
        tbody.querySelectorAll('.btn-al-edit').forEach(btn => {
            btn.addEventListener('click', () => {
                const alId = parseInt(btn.getAttribute('data-id'));
                const al = allAccessLevelsData.find(x => x.id === alId);
                if (al) startEditAccessLevel(al);
            });
        });

        // Bind Delete buttons
        tbody.querySelectorAll('.btn-al-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                const alId = btn.getAttribute('data-id');
                if (confirm('Are you sure you want to delete this access level? This will remove all mappings and links to cardholders.')) {
                    const res = await fetch(`/api/access-levels?id=${alId}`, { method: 'DELETE' });
                    if (res.ok) loadAccessLevels();
                }
            });
        });
    }

    function startEditAccessLevel(al) {
        document.getElementById('al-id').value = al.id;
        document.getElementById('al-name').value = al.name;
        document.getElementById('al-dho-override').checked = al.dho_override;

        // Reset check status
        const listContainer = document.getElementById('al-mappings-container');
        listContainer.querySelectorAll('.mapping-chk').forEach(chk => {
            chk.checked = false;
        });

        if (al.mappings && al.mappings.length > 0) {
            al.mappings.forEach(m => {
                const row = listContainer.querySelector(`.mapping-chk[data-reader-id="${m.reader_id}"]`);
                if (row) {
                    row.checked = true;
                    const select = row.closest('div').nextSibling.querySelector('.mapping-tz');
                    if (select) select.value = m.time_zone_id;
                }
            });
        }

        document.getElementById('btn-al-submit').innerText = 'Update Access Level';
        document.getElementById('btn-al-cancel-edit').style.display = 'inline-block';
        document.getElementById('form-access-level').scrollIntoView({ behavior: 'smooth' });
    }

    document.getElementById('btn-al-cancel-edit').addEventListener('click', () => {
        document.getElementById('al-id').value = '';
        document.getElementById('al-name').value = '';
        document.getElementById('al-dho-override').checked = false;
        document.getElementById('al-mappings-container').querySelectorAll('.mapping-chk').forEach(chk => {
            chk.checked = false;
        });
        document.getElementById('btn-al-submit').innerText = 'Create Access Level';
        document.getElementById('btn-al-cancel-edit').style.display = 'none';
    });

    async function saveAccessLevel(e) {
        e.preventDefault();
        const id = document.getElementById('al-id').value;
        const name = document.getElementById('al-name').value;
        const dhoOverride = document.getElementById('al-dho-override').checked;

        const mappings = [];
        document.querySelectorAll('#al-mappings-container > div').forEach(row => {
            const chk = row.querySelector('.mapping-chk');
            if (chk && chk.checked) {
                const readerId = chk.getAttribute('data-reader-id');
                const tzVal = parseInt(row.querySelector('.mapping-tz').value);
                mappings.push({ reader_id: readerId, time_zone_id: tzVal });
            }
        });

        const payload = { name, dho_override: dhoOverride, mappings };
        let url = '/api/access-levels';
        let method = 'POST';

        if (id) {
            url += `?id=${id}`;
            method = 'PUT';
        }

        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            document.getElementById('form-access-level').reset();
            document.getElementById('al-id').value = '';
            document.getElementById('btn-al-submit').innerText = 'Create Access Level';
            document.getElementById('btn-al-cancel-edit').style.display = 'none';
            loadAccessLevels();
        }
    }

    // Credentials / Badges Management
    async function loadCredentials() {
        const res = await fetch('/api/credentials');
        const data = await res.json();
        credentialsCache = data;
        renderCredentials();
    }

    function renderCredentials() {
        const tbody = document.querySelector('#table-credentials tbody');
        tbody.innerHTML = '';

        const today = new Date();

        const filtered = credentialsCache.filter(c => {
            const nameMatch = c.employee_name.toLowerCase().includes(currentFilterSearch);
            const cardMatch = String(c.card_id).includes(currentFilterSearch);
            if (!nameMatch && !cardMatch) return false;

            const expDate = new Date(c.expiration_date);
            const isExpired = expDate < today;

            if (currentFilterStatus === 'ACTIVE') {
                return c.is_active && !isExpired;
            } else if (currentFilterStatus === 'EXPIRED') {
                return isExpired;
            } else if (currentFilterStatus === 'INACTIVE') {
                return !c.is_active && !isExpired;
            }
            return true;
        });

        filtered.forEach(c => {
            const tr = document.createElement('tr');
            
            // Build initials avatar circle
            const nameParts = c.employee_name.split(' ');
            const initials = nameParts.map(p => p[0]).join('').slice(0, 2).toUpperCase();
            
            // Assign deterministic color class based on employee name
            const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];
            const colorIdx = c.employee_name.length % colors.length;
            const avatarColor = colors[colorIdx];

            const expDate = new Date(c.expiration_date);
            const isExpired = expDate < today;
            
            let statusClass = 'secure';
            let statusText = 'ACTIVE';
            if (isExpired) {
                statusClass = 'offline';
                statusText = 'EXPIRED';
            } else if (!c.is_active) {
                statusClass = 'offline';
                statusText = 'INACTIVE';
            }

            // Map access level names for readability
            let alNames = 'No entry rights';
            if (c.access_levels && c.access_levels.length > 0) {
                alNames = c.access_levels.map(alId => {
                    const al = allAccessLevelsData.find(x => x.id === alId);
                    return al ? al.name : `Level ${alId}`;
                }).join(', ');
            }

            tr.innerHTML = `
                <td>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div class="avatar-circle" style="background: ${avatarColor};">${initials}</div>
                        <div>
                            <span style="font-weight: bold; color: #fff; font-size: 14px;">${c.employee_name}</span>
                            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">User ID: ${c.user_id}</div>
                        </div>
                    </div>
                </td>
                <td style="font-family: monospace;">Wiegand ${c.bit_length} bit</td>
                <td>
                    <span style="color: #60a5fa; font-weight: 500;">FC: ${c.facility_code}</span> / 
                    <span style="color: #fff; font-weight: bold;">ID: ${c.card_id}</span>
                </td>
                <td style="color: var(--text-secondary);">
                    <div>${formatDateOnly(c.activation_date)}</div>
                    <div style="font-size: 11px; color: #555; margin-top: 2px;">to ${formatDateOnly(c.expiration_date)}</div>
                </td>
                <td>
                    <span class="status-badge ${statusClass}">${statusText}</span>
                    <div style="font-size: 11px; color: #888; margin-top: 4px; max-width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${alNames}">🔑 ${alNames}</div>
                </td>
                <td>
                    <button class="btn btn-secondary btn-cred-edit" data-id="${c.id}" style="padding: 4px 8px; font-size: 12px; display: inline-block;">Edit</button>
                    <button class="btn btn-secondary btn-cred-delete" data-id="${c.id}" style="padding: 4px 8px; font-size: 12px; display: inline-block; border-color: rgba(239,68,68,0.2); color: #f87171;">Delete</button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        // Bind Edit buttons
        tbody.querySelectorAll('.btn-cred-edit').forEach(btn => {
            btn.addEventListener('click', () => {
                const credId = parseInt(btn.getAttribute('data-id'));
                const cred = credentialsCache.find(x => x.id === credId);
                if (cred) {
                    startEditCredential(cred);
                }
            });
        });

        // Bind Delete buttons
        tbody.querySelectorAll('.btn-cred-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                const credId = btn.getAttribute('data-id');
                if (confirm('Are you sure you want to delete this credential? This cannot be undone.')) {
                    const res = await fetch(`/api/credentials?id=${credId}`, { method: 'DELETE' });
                    if (res.ok) {
                        loadCredentials();
                    }
                }
            });
        });
    }

    function startEditCredential(c) {
        document.getElementById('cred-id').value = c.id;
        document.getElementById('cred-user-id').value = c.user_id;
        document.getElementById('cred-name').value = c.employee_name;
        document.getElementById('cred-fc').value = c.facility_code;
        document.getElementById('cred-cid').value = c.card_id;
        document.getElementById('cred-bits').value = c.bit_length;
        document.getElementById('cred-pin').value = c.pin_code || '';
        document.getElementById('cred-start-date').value = c.activation_date.split('T')[0];
        document.getElementById('cred-end-date').value = c.expiration_date.split('T')[0];
        document.getElementById('cred-active').checked = c.is_active;

        // Reset and apply access levels checks
        document.querySelectorAll('input[name="cred-al"]').forEach(cb => {
            cb.checked = (c.access_levels || []).includes(parseInt(cb.value));
        });

        document.getElementById('btn-save-badge').innerText = 'Save Changes';
        openDrawer(true);
    }

    async function saveCredential(e) {
        e.preventDefault();
        const id = document.getElementById('cred-id').value;
        const userId = document.getElementById('cred-user-id').value;
        const name = document.getElementById('cred-name').value;
        const fc = parseInt(document.getElementById('cred-fc').value);
        const cardId = parseInt(document.getElementById('cred-cid').value);
        const bits = parseInt(document.getElementById('cred-bits').value);
        const pin = document.getElementById('cred-pin').value.trim() || null;
        const startDate = document.getElementById('cred-start-date').value;
        const endDate = document.getElementById('cred-end-date').value;
        const active = document.getElementById('cred-active').checked;

        const alIds = [];
        document.querySelectorAll('input[name="cred-al"]:checked').forEach(cb => {
            alIds.push(parseInt(cb.value));
        });

        const payload = {
            id: id ? parseInt(id) : 0,
            user_id: userId ? parseInt(userId) : 0,
            employee_name: name,
            bit_length: bits,
            facility_code: fc,
            card_id: cardId,
            is_active: active,
            access_levels: alIds,
            activation_date: startDate,
            expiration_date: endDate,
            pin_code: pin
        };

        let method = 'POST';
        if (id) {
            method = 'PUT';
        }

        const res = await fetch('/api/credentials', {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            closeDrawer();
            loadCredentials();
        }
    }

    // Interactive Floor Map placements and Drag & Drop
    let mapPlacementsCache = [];
    let mapPollInterval = null;

    async function loadMapPlacements() {
        try {
            const resPlacements = await fetch('/api/map-placements');
            mapPlacementsCache = await resPlacements.json();

            // Populate Map nodes container
            const container = document.getElementById('map-nodes-container');
            container.innerHTML = '';
            
            mapPlacementsCache.forEach(p => {
                const node = document.createElement('div');
                node.className = `map-door-node ${p.is_online ? 'secure' : 'offline'}`;
                node.id = `map-node-${p.controller_id}`;
                node.style.left = `${p.pos_x}px`;
                node.style.top = `${p.pos_y}px`;
                node.title = `${p.friendly_name} (${p.controller_id})`;
                node.innerHTML = `🚪`;

                // Add popover menu on click
                node.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showMapPopover(node, p);
                });

                // Attach drag events
                enableDragElement(node, p.controller_id);

                container.appendChild(node);
            });

            // Populate side panel of unplaced controllers
            const unplacedContainer = document.getElementById('map-unplaced-list');
            unplacedContainer.innerHTML = '';
            
            const placedIDs = mapPlacementsCache.map(p => p.controller_id);
            const unplaced = globalControllers.filter(c => !placedIDs.includes(c.controller_id));

            if (unplaced.length === 0) {
                unplacedContainer.innerHTML = '<div style="color: #444; font-size: 12px; font-style: italic;">All nodes placed.</div>';
            } else {
                unplaced.forEach(c => {
                    const item = document.createElement('div');
                    item.className = 'card';
                    item.style.padding = '0.5rem';
                    item.style.marginBottom = '0.4rem';
                    item.style.background = 'rgba(255,255,255,0.05)';
                    item.style.border = '1px solid var(--border-color)';
                    item.style.borderRadius = '4px';
                    item.style.fontSize = '12px';
                    item.style.cursor = 'grab';
                    item.style.userSelect = 'none';
                    item.draggable = true;
                    item.innerText = c.friendly_name || c.controller_id;

                    item.addEventListener('dragstart', (e) => {
                        e.dataTransfer.setData('text/plain', c.controller_id);
                    });

                    unplacedContainer.appendChild(item);
                });
            }

            // Set up drop target on the map wrapper
            const mapWrapper = document.querySelector('.map-container-wrapper');
            mapWrapper.addEventListener('dragover', (e) => {
                e.preventDefault();
            });

            mapWrapper.addEventListener('drop', async (e) => {
                e.preventDefault();
                const controllerId = e.dataTransfer.getData('text/plain');
                if (!controllerId) return;

                const rect = mapWrapper.getBoundingClientRect();
                const posX = e.clientX - rect.left - 20; // 20 is half node width
                const posY = e.clientY - rect.top - 20;

                await saveMapPlacement(controllerId, Math.round(posX), Math.round(posY));
            });

            loadAPBOccupancy();

        } catch (err) {
            console.error('Failed to load map placements:', err);
        }
    }

    async function saveMapPlacement(controllerId, posX, posY) {
        try {
            const res = await fetch('/api/map-placements', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    controller_id: controllerId,
                    pos_x: posX,
                    pos_y: posY
                })
            });
            if (res.ok) {
                loadMapPlacements();
            }
        } catch (err) {
            console.error('Failed to save map placement:', err);
        }
    }

    function showMapPopover(node, p) {
        // Remove any existing popover
        const existing = document.querySelector('.map-popover');
        if (existing) existing.remove();

        const popover = document.createElement('div');
        popover.className = 'map-popover';
        popover.innerHTML = `
            <h5>🚪 ${p.friendly_name}</h5>
            <div style="font-size: 11px; color: #888; font-family: monospace; text-align: center; margin-bottom: 0.75rem;">${p.controller_id}</div>
            <div class="map-popover-buttons">
                <button class="btn btn-grant btn-pop-unlock" data-id="${p.controller_id}">Unlock</button>
                <button class="btn btn-lockdown btn-pop-lock" data-id="${p.controller_id}">Lockdown</button>
                <button class="btn btn-secondary btn-pop-unplace" style="grid-column: span 2; border-color: rgba(239,68,68,0.2); color: #f87171; margin-top: 4px;">Unplace from Map</button>
            </div>
        `;

        popover.querySelector('.btn-pop-unlock').addEventListener('click', () => {
            sendCommand(p.controller_id, 'REMOTE_UNLOCK');
            popover.remove();
        });
        popover.querySelector('.btn-pop-lock').addEventListener('click', () => {
            sendCommand(p.controller_id, 'FORCE_LOCK');
            popover.remove();
        });
        popover.querySelector('.btn-pop-unplace').addEventListener('click', async () => {
            if (confirm('Remove this controller from the map layout?')) {
                await deleteMapPlacement(p.controller_id);
                popover.remove();
            }
        });

        node.appendChild(popover);

        // Dismiss popover on body click
        setTimeout(() => {
            const dismissPopover = () => {
                popover.remove();
                document.body.removeEventListener('click', dismissPopover);
            };
            document.body.addEventListener('click', dismissPopover);
        }, 10);
    }

    async function deleteMapPlacement(controllerId) {
        try {
            const res = await fetch(`/api/map-placements?controller_id=${controllerId}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                loadMapPlacements();
            }
        } catch (err) {
            console.error('Failed to delete map placement:', err);
        }
    }

    function enableDragElement(elmnt, controllerId) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        elmnt.onmousedown = dragMouseDown;

        function dragMouseDown(e) {
            e = e || window.event;
            // Prevent drag trigger if clicking inside the popover
            if (e.target.closest('.map-popover')) return;
            
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e = e || window.event;
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;

            // Calculate new relative position
            const newLeft = elmnt.offsetLeft - pos1;
            const newTop = elmnt.offsetTop - pos2;

            // Clamp positions within map area bounds
            const wrapper = document.querySelector('.map-container-wrapper');
            const maxLeft = wrapper.clientWidth - 40;
            const maxTop = wrapper.clientHeight - 40;

            const finalLeft = Math.max(0, Math.min(newLeft, maxLeft));
            const finalTop = Math.max(0, Math.min(newTop, maxTop));

            elmnt.style.left = `${finalLeft}px`;
            elmnt.style.top = `${finalTop}px`;
        }

        async function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;

            // Save new position relative coordinates
            const posX = parseInt(elmnt.style.left);
            const posY = parseInt(elmnt.style.top);
            await saveMapPlacement(controllerId, posX, posY);
        }
    }

    async function loadAPBOccupancy() {
        try {
            const res = await fetch('/api/apb-status');
            if (!res.ok) return;
            const data = await res.json();
            
            const listEl = document.getElementById('apb-occupancy-list');
            if (!listEl) return;
            listEl.innerHTML = '';

            if (data.length === 0) {
                listEl.innerHTML = '<span style="color: #555; font-size: 12px;">No active cardholders seen on site...</span>';
                return;
            }

            data.forEach(e => {
                const badge = document.createElement('span');
                badge.style.display = 'inline-flex';
                badge.style.alignItems = 'center';
                badge.style.padding = '4px 10px';
                badge.style.borderRadius = '20px';
                badge.style.fontSize = '12px';
                badge.style.fontWeight = '600';
                badge.style.background = e.apb_violation ? 'rgba(249, 115, 22, 0.12)' : 'rgba(16, 185, 129, 0.12)';
                badge.style.color = e.apb_violation ? '#f97316' : '#10b981';
                badge.style.border = `1px solid ${e.apb_violation ? 'rgba(249,115,22,0.2)' : 'rgba(16,185,129,0.2)'}`;
                badge.style.cursor = 'help';
                
                const timeStr = new Date(e.last_seen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                badge.title = `Last swiped at: ${e.last_controller_id} (${timeStr})\nStatus: ${e.last_event_type}`;
                badge.innerHTML = `
                    <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:currentColor; margin-right:6px;"></span>
                    ${e.employee_name} @ ${e.last_controller_id}
                `;

                listEl.appendChild(badge);
            });
        } catch (err) {
            console.error('Failed to load APB occupancy:', err);
        }
    }

    // Show Register Controller modal
    document.getElementById('btn-open-reg-ctrl').addEventListener('click', () => {
        document.getElementById('modal-register-ctrl').style.display = 'flex';
        document.getElementById('form-register-ctrl').reset();
        document.getElementById('reg-ctrl-status').style.display = 'none';
    });

    document.getElementById('btn-cancel-reg-ctrl').addEventListener('click', () => {
        document.getElementById('modal-register-ctrl').style.display = 'none';
    });

    document.getElementById('form-register-ctrl').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('reg-ctrl-id').value.trim().toUpperCase();
        const name = document.getElementById('reg-ctrl-name').value.trim();
        const ip = document.getElementById('reg-ctrl-ip').value.trim();
        const location = document.getElementById('reg-ctrl-location').value.trim();

        const statusEl = document.getElementById('reg-ctrl-status');
        statusEl.style.display = 'block';
        statusEl.style.color = '#fff';
        statusEl.textContent = 'Registering...';

        try {
            const res = await fetch('/api/controllers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    controller_id: id,
                    friendly_name: name,
                    server_ip: ip,
                    location: location
                })
            });

            if (res.ok) {
                statusEl.style.color = '#10b981';
                statusEl.textContent = '✅ Controller registered successfully!';
                loadControllers();
                setTimeout(() => {
                    document.getElementById('modal-register-ctrl').style.display = 'none';
                }, 1000);
            } else {
                const err = await res.text();
                statusEl.style.color = '#ff4444';
                statusEl.textContent = '❌ Error: ' + err;
            }
        } catch (err) {
            statusEl.style.color = '#ff4444';
            statusEl.textContent = '❌ Network error: ' + err.message;
        }
    });

    // Dismiss modal on backdrop click
    document.getElementById('modal-register-ctrl').addEventListener('click', (e) => {
        if (e.target === document.getElementById('modal-register-ctrl')) {
            document.getElementById('modal-register-ctrl').style.display = 'none';
        }
    });

    // Crisis Threat Level Postures
    async function loadThreatLevel() {
        try {
            const res = await fetch('/api/threat-level');
            const data = await res.json();
            updateThreatLevelUI(data.threat_level);
        } catch (err) {
            console.error('Failed to load threat level:', err);
        }
    }

    function updateThreatLevelUI(activeLevel) {
        document.querySelectorAll('.threat-card').forEach(card => {
            card.classList.remove('active');
        });
        const activeCard = document.getElementById(`threat-card-${activeLevel}`);
        if (activeCard) {
            activeCard.classList.add('active');
        }
    }

    async function setThreatLevel(level) {
        try {
            const res = await fetch('/api/threat-level', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threat_level: level })
            });
            if (res.ok) {
                updateThreatLevelUI(level);
            }
        } catch (err) {
            console.error('Failed to update threat level:', err);
        }
    }

    document.querySelectorAll('.threat-card').forEach(card => {
        card.addEventListener('click', () => {
            const level = card.id.replace('threat-card-', '');
            setThreatLevel(level);
        });
    });

    // System Health & Diagnostics
    async function loadSystemHealth() {
        try {
            const res = await fetch('/api/system-health');
            const data = await res.json();
            renderSystemHealth(data);
        } catch (err) {
            console.error('Failed to load system health:', err);
        }
    }

    function renderSystemHealth(data) {
        const container = document.getElementById('health-cards-container');
        container.innerHTML = '';

        data.forEach(h => {
            const card = document.createElement('div');
            card.className = `card glass health-card ${h.is_online ? '' : 'offline'}`;

            const cpuWarnClass = h.cpu_usage > 80 ? 'critical' : (h.cpu_usage > 50 ? 'warning' : '');
            const memWarnClass = h.memory_usage > 85 ? 'critical' : (h.memory_usage > 60 ? 'warning' : '');

            let apiStatusClass = 'offline';
            if (h.api_status === 'HEALTHY') {
                apiStatusClass = 'secure';
            } else if (h.api_status.startsWith('API_') || h.api_status === 'UNKNOWN') {
                apiStatusClass = 'warning';
            }

            card.innerHTML = `
                <div class="health-card-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem; margin-bottom: 1rem;">
                    <div>
                        <h4 style="margin: 0; color: #fff;">${h.friendly_name}</h4>
                        <span style="font-size: 0.75rem; color: #888;">${h.controller_id} (${h.server_ip})</span>
                    </div>
                    <span class="status-badge ${h.is_online ? 'secure' : 'offline'}">${h.is_online ? 'ONLINE' : 'OFFLINE'}</span>
                </div>
                
                <div class="health-stat">
                    <div class="health-stat-header">
                        <span>CPU Utilization</span>
                        <span style="font-weight: bold; color: #fff;">${h.cpu_usage.toFixed(1)}%</span>
                    </div>
                    <div class="health-bar-bg">
                        <div class="health-bar-fill ${cpuWarnClass}" style="width: ${h.cpu_usage}%"></div>
                    </div>
                </div>

                <div class="health-stat">
                    <div class="health-stat-header">
                        <span>Memory Utilization</span>
                        <span style="font-weight: bold; color: #fff;">${h.memory_usage.toFixed(1)}%</span>
                    </div>
                    <div class="health-bar-bg">
                        <div class="health-bar-fill ${memWarnClass}" style="width: ${h.memory_usage}%"></div>
                    </div>
                </div>

                <div class="health-metrics-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 1rem; margin-top: 1rem;">
                    <div>
                        <div class="health-metric-label" style="font-size: 0.75rem; color: #888; margin-bottom: 0.2rem;">API Check</div>
                        <div class="health-metric-val" style="margin-top: 0.2rem;"><span class="status-badge ${apiStatusClass}" style="font-size: 0.75rem; font-weight: bold; padding: 0.2rem 0.5rem; display: inline-block;">${h.api_status}</span></div>
                    </div>
                    <div>
                        <div class="health-metric-label" style="font-size: 0.75rem; color: #888; margin-bottom: 0.2rem;">Local SQLite Queue</div>
                        <div class="health-metric-val" style="font-size: 1.1rem; font-weight: bold; color: #fff;">${h.buffered_logs}</div>
                    </div>
                    <div>
                        <div class="health-metric-label" style="font-size: 0.75rem; color: #888; margin-bottom: 0.2rem;">Ping (Server ➔ Node)</div>
                        <div class="health-metric-val" style="font-size: 1.1rem; font-weight: bold; color: #fff;">${h.server_ping_ms} ms</div>
                    </div>
                    <div>
                        <div class="health-metric-label" style="font-size: 0.75rem; color: #888; margin-bottom: 0.2rem;">Ping (Node ➔ DB)</div>
                        <div class="health-metric-val" style="font-size: 1.1rem; font-weight: bold; color: #fff;">${h.last_ping_ms} ms</div>
                    </div>
                </div>
            `;
            container.appendChild(card);
        });
    }

    // ---- Controller Configuration (Authenticated) ----

    // Auth login form
    document.getElementById('form-config-auth').addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = document.getElementById('config-password').value;
        const errorEl = document.getElementById('config-auth-error');
        errorEl.style.display = 'none';

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });

            if (!res.ok) {
                const data = await res.json();
                errorEl.innerText = data.error || 'Authentication failed';
                errorEl.style.display = 'block';
                return;
            }

            const data = await res.json();
            configAuthToken = data.token;
            sessionStorage.setItem('piacs_config_token', data.token);

            document.getElementById('config-auth-gate').style.display = 'none';
            document.getElementById('config-panel').style.display = 'flex';

            populateConfigControllerSelect();
        } catch (err) {
            errorEl.innerText = 'Connection error: ' + err.message;
            errorEl.style.display = 'block';
        }
    });

    // Check for existing token on config tab load
    async function checkConfigAuth() {
        if (!configAuthToken) {
            document.getElementById('config-auth-gate').style.display = 'block';
            document.getElementById('config-panel').style.display = 'none';
            return;
        }
        try {
            const res = await fetch('/api/controller-config', {
                headers: { 'Authorization': 'Bearer ' + configAuthToken }
            });
            if (res.ok) {
                document.getElementById('config-auth-gate').style.display = 'none';
                document.getElementById('config-panel').style.display = 'flex';
                populateConfigControllerSelect();
            } else {
                configAuthToken = null;
                sessionStorage.removeItem('piacs_config_token');
                document.getElementById('config-auth-gate').style.display = 'block';
                document.getElementById('config-panel').style.display = 'none';
            }
        } catch (e) {
            configAuthToken = null;
            sessionStorage.removeItem('piacs_config_token');
            document.getElementById('config-auth-gate').style.display = 'block';
            document.getElementById('config-panel').style.display = 'none';
        }
    }

    async function populateConfigControllerSelect() {
        try {
            const res = await fetch('/api/controllers');
            const data = await res.json();
            const listEl = document.getElementById('config-ctrl-list');
            listEl.innerHTML = '';
            
            data.forEach(c => {
                const card = document.createElement('div');
                card.className = 'controller-list-card';
                if (selectedConfigControllerId === c.controller_id) {
                    card.classList.add('active');
                }
                
                const dotColor = c.is_online ? '#10b981' : '#ef4444';
                card.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.4rem;">
                        <span style="font-weight: 700; color: #fff; font-size: 13px;">${c.friendly_name}</span>
                        <span style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: ${c.is_online ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'}; color: ${dotColor}; font-weight: bold; border: 1px solid ${c.is_online ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'};">${c.is_online ? 'ONLINE' : 'OFFLINE'}</span>
                    </div>
                    <div style="font-size: 11px; color: #888; font-family: monospace; margin-bottom: 0.3rem;">ID: ${c.controller_id}</div>
                    <div style="font-size: 11px; color: #aaa; margin-bottom: 0.3rem;">🌐 ${c.server_ip}</div>
                    <div style="font-size: 11px; color: #777;">📍 ${c.location || 'No Location Configured'}</div>
                `;

                card.addEventListener('click', () => {
                    document.querySelectorAll('#config-ctrl-list .controller-list-card').forEach(x => {
                        x.classList.remove('active');
                    });
                    card.classList.add('active');
                    selectedConfigControllerId = c.controller_id;
                    loadControllerConfigData(c.controller_id);
                });

                listEl.appendChild(card);
            });

            // Auto-select first controller if none selected
            if (data.length > 0) {
                if (!selectedConfigControllerId || !data.some(x => x.controller_id === selectedConfigControllerId)) {
                    selectedConfigControllerId = data[0].controller_id;
                    loadControllerConfigData(data[0].controller_id);
                    const firstCard = listEl.querySelector('.controller-list-card');
                    if (firstCard) {
                        firstCard.classList.add('active');
                    }
                }
            } else {
                listEl.innerHTML = '<span style="color:#555;font-size:12px;">No controllers registered.</span>';
                document.getElementById('form-controller-config').reset();
            }
        } catch (err) {
            console.error('Failed to load controllers for config:', err);
        }
    }

    async function loadControllerConfigData(controllerId) {
        try {
            const errBanner = document.getElementById('config-validation-error');
            if (errBanner) errBanner.style.display = 'none';
            
            const res = await fetch(`/api/controller-config?controller_id=${controllerId}`, {
                headers: { 'Authorization': 'Bearer ' + configAuthToken }
            });
            if (res.status === 401 || res.status === 403) {
                configAuthToken = null;
                sessionStorage.removeItem('piacs_config_token');
                document.getElementById('config-auth-gate').style.display = 'block';
                document.getElementById('config-panel').style.display = 'none';
                return;
            }
            const data = await res.json();
            if (data.length === 0) return;
            const cc = data[0];

            document.getElementById('cfg-controller-id').value = cc.controller_id;
            document.getElementById('cfg-friendly-name').value = cc.friendly_name || '';
            document.getElementById('cfg-location').value = cc.location || '';
            document.getElementById('cfg-gpio-chip').value = cc.gpio_chip_device;
            document.getElementById('cfg-d0').value = cc.wiegand_d0_pin;
            document.getElementById('cfg-d1').value = cc.wiegand_d1_pin;
            document.getElementById('cfg-wiegand-timeout').value = cc.wiegand_timeout_ms;
            document.getElementById('cfg-relay').value = cc.lock_relay_pin;
            document.getElementById('cfg-red-led').value = cc.reader_red_led_pin;
            document.getElementById('cfg-green-led').value = cc.reader_green_led_pin;
            document.getElementById('cfg-buzzer').value = cc.reader_buzzer_pin;
            document.getElementById('cfg-horn').value = cc.alarm_horn_pin;
            document.getElementById('cfg-dsm').value = cc.dsm_pin;
            document.getElementById('cfg-rex').value = cc.rex_pin;
            document.getElementById('cfg-dsm-nc').checked = cc.dsm_normally_closed;
            document.getElementById('cfg-dho-enabled').checked = cc.dho_enabled;
            document.getElementById('cfg-dho-timeout').value = cc.dho_timeout_secs;
            document.getElementById('cfg-dho-prealarm').value = cc.dho_pre_alarm_secs;
            document.getElementById('cfg-dfo-enabled').checked = cc.dfo_enabled;
            document.getElementById('cfg-apb-strict').checked = cc.apb_strict;
            document.getElementById('cfg-relock-on-open').checked = cc.relock_on_open || false;
            
            // Populate and set site ID dropdown
            await loadSites();
            document.getElementById('cfg-site').value = cc.site_id || '';
        } catch (err) {
            console.error('Failed to load controller config:', err);
        }
    }

    document.getElementById('btn-config-reset').addEventListener('click', () => {
        if (selectedConfigControllerId) loadControllerConfigData(selectedConfigControllerId);
    });

    document.getElementById('form-controller-config').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const errorBanner = document.getElementById('config-validation-error');
        if (errorBanner) {
            errorBanner.style.display = 'none';
            errorBanner.innerHTML = '';
        }

        const d0 = parseInt(document.getElementById('cfg-d0').value);
        const d1 = parseInt(document.getElementById('cfg-d1').value);
        const relay = parseInt(document.getElementById('cfg-relay').value);
        const redLed = parseInt(document.getElementById('cfg-red-led').value);
        const greenLed = parseInt(document.getElementById('cfg-green-led').value);
        const buzzer = parseInt(document.getElementById('cfg-buzzer').value);
        const horn = parseInt(document.getElementById('cfg-horn').value);
        const dsm = parseInt(document.getElementById('cfg-dsm').value);
        const rex = parseInt(document.getElementById('cfg-rex').value);

        const pins = [
            { name: 'Wiegand D0', val: d0 },
            { name: 'Wiegand D1', val: d1 },
            { name: 'Lock Relay', val: relay },
            { name: 'Reader Red LED', val: redLed },
            { name: 'Reader Green LED', val: greenLed },
            { name: 'Reader Buzzer', val: buzzer },
            { name: 'Alarm Horn', val: horn },
            { name: 'Door Status Monitor (DSM)', val: dsm },
            { name: 'Request-to-Exit (REX)', val: rex }
        ];

        const pinMap = {};
        const overlaps = [];

        pins.forEach(p => {
            if (p.val > 0) {
                if (pinMap[p.val]) {
                    pinMap[p.val].push(p.name);
                } else {
                    pinMap[p.val] = [p.name];
                }
            }
        });

        for (const pin in pinMap) {
            if (pinMap[pin].length > 1) {
                overlaps.push(`Pin <strong>${pin}</strong> is assigned to: ${pinMap[pin].join(', ')}`);
            }
        }

        const statusEl = document.getElementById('config-save-status');

        if (overlaps.length > 0) {
            if (errorBanner) {
                errorBanner.innerHTML = `
                    <div>
                        <div style="font-weight: 700; margin-bottom: 0.25rem;">⚠️ GPIO Configuration Error: Overlapping Pins Detected</div>
                        <ul style="margin: 0; padding-left: 1.2rem; font-size: 0.85rem; line-height: 1.4;">
                            ${overlaps.map(o => `<li>${o}</li>`).join('')}
                        </ul>
                    </div>
                `;
                errorBanner.style.display = 'flex';
                errorBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            if (statusEl) statusEl.style.display = 'none';
            return;
        }

        if (statusEl) {
            statusEl.style.display = 'block';
            statusEl.style.color = '#4ecdc4';
            statusEl.innerText = 'Saving and pushing to controller...';
        }

        const payload = {
            controller_id: document.getElementById('cfg-controller-id').value,
            friendly_name: document.getElementById('cfg-friendly-name').value.trim(),
            location: document.getElementById('cfg-location').value.trim(),
            gpio_chip_device: document.getElementById('cfg-gpio-chip').value,
            wiegand_d0_pin: parseInt(document.getElementById('cfg-d0').value),
            wiegand_d1_pin: parseInt(document.getElementById('cfg-d1').value),
            wiegand_timeout_ms: parseInt(document.getElementById('cfg-wiegand-timeout').value),
            lock_relay_pin: parseInt(document.getElementById('cfg-relay').value),
            reader_red_led_pin: parseInt(document.getElementById('cfg-red-led').value),
            reader_green_led_pin: parseInt(document.getElementById('cfg-green-led').value),
            reader_buzzer_pin: parseInt(document.getElementById('cfg-buzzer').value),
            alarm_horn_pin: parseInt(document.getElementById('cfg-horn').value),
            dsm_pin: parseInt(document.getElementById('cfg-dsm').value),
            rex_pin: parseInt(document.getElementById('cfg-rex').value),
            dsm_normally_closed: document.getElementById('cfg-dsm-nc').checked,
            dho_enabled: document.getElementById('cfg-dho-enabled').checked,
            dho_timeout_secs: parseInt(document.getElementById('cfg-dho-timeout').value),
            dho_pre_alarm_secs: parseInt(document.getElementById('cfg-dho-prealarm').value),
            dfo_enabled: document.getElementById('cfg-dfo-enabled').checked,
            apb_strict: document.getElementById('cfg-apb-strict').checked,
            relock_on_open: document.getElementById('cfg-relock-on-open').checked,
            site_id: document.getElementById('cfg-site').value ? parseInt(document.getElementById('cfg-site').value) : null
        };

        try {
            const res = await fetch('/api/controller-config', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + configAuthToken
                },
                body: JSON.stringify(payload)
            });

            if (res.status === 401 || res.status === 403) {
                configAuthToken = null;
                sessionStorage.removeItem('piacs_config_token');
                document.getElementById('config-auth-gate').style.display = 'block';
                document.getElementById('config-panel').style.display = 'none';
                statusEl.style.display = 'none';
                return;
            }

            const data = await res.json();
            if (data.push === 'pushed') {
                statusEl.style.color = '#2ecc71';
                statusEl.innerText = '✅ Config saved to DB and pushed live to controller successfully.';
            } else {
                statusEl.style.color = '#f39c12';
                statusEl.innerText = `⚠️ Config saved to DB. Push status: ${data.push}`;
            }

            populateConfigControllerSelect();
            if (typeof loadMapPlacements === 'function') {
                loadMapPlacements();
            }
        } catch (err) {
            statusEl.style.color = '#ff4444';
            statusEl.innerText = '❌ Error: ' + err.message;
        }
    });

    // === Events Console & Site Grouping Layer ===
    let selectedEventMode = 'door';
    let selectedEventDoorId = '';
    let selectedEventSiteId = '';
    let selectedEventFilterView = 'combined';
    let eventsConsoleCache = [];

    // Mode Selector Handler
    const eventModeSelect = document.getElementById('event-mode-select');
    const eventDoorSelect = document.getElementById('event-door-select');
    const eventSiteSelect = document.getElementById('event-site-select');

    if (eventModeSelect) {
        eventModeSelect.addEventListener('change', () => {
            selectedEventMode = eventModeSelect.value;
            if (selectedEventMode === 'door') {
                eventDoorSelect.style.display = 'block';
                eventSiteSelect.style.display = 'none';
            } else {
                eventDoorSelect.style.display = 'none';
                eventSiteSelect.style.display = 'block';
            }
            loadEventsConsole();
        });
    }

    if (eventDoorSelect) {
        eventDoorSelect.addEventListener('change', () => {
            selectedEventDoorId = eventDoorSelect.value;
            loadEventsConsole();
        });
    }

    if (eventSiteSelect) {
        eventSiteSelect.addEventListener('change', () => {
            selectedEventSiteId = eventSiteSelect.value;
            loadEventsConsole();
        });
    }

    // View Filter Tab Handlers
    const tabCombined = document.getElementById('btn-event-view-combined');
    const tabAlarms = document.getElementById('btn-event-view-alarms');
    const tabEvents = document.getElementById('btn-event-view-events');

    function setActiveEventTab(activeBtn, view) {
        [tabCombined, tabAlarms, tabEvents].forEach(btn => {
            if (btn) btn.classList.remove('active');
        });
        activeBtn.classList.add('active');
        selectedEventFilterView = view;
        loadEventsConsole();
    }

    if (tabCombined) tabCombined.addEventListener('click', () => setActiveEventTab(tabCombined, 'combined'));
    if (tabAlarms) tabAlarms.addEventListener('click', () => setActiveEventTab(tabAlarms, 'alarms'));
    if (tabEvents) tabEvents.addEventListener('click', () => setActiveEventTab(tabEvents, 'events'));

    // Create Site Button
    const btnCreateSite = document.getElementById('btn-create-site');
    const inputNewSiteName = document.getElementById('input-new-site-name');
    const siteErrorMsg = document.getElementById('site-error-msg');

    if (btnCreateSite) {
        btnCreateSite.addEventListener('click', async () => {
            const name = inputNewSiteName.value.trim();
            if (!name) return;
            siteErrorMsg.style.display = 'none';

            try {
                const res = await fetch('/api/sites', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
                if (res.ok) {
                    inputNewSiteName.value = '';
                    loadSites();
                } else {
                    const err = await res.text();
                    siteErrorMsg.innerText = err || 'Failed to create site';
                    siteErrorMsg.style.display = 'block';
                }
            } catch (err) {
                siteErrorMsg.innerText = 'Network error: ' + err.message;
                siteErrorMsg.style.display = 'block';
            }
        });
    }

    async function loadSites() {
        try {
            const res = await fetch('/api/sites');
            if (!res.ok) return;
            const sites = await res.json();

            // Populate event-site-select
            const siteSelect = document.getElementById('event-site-select');
            if (siteSelect) {
                siteSelect.innerHTML = '<option value="">All Sites</option>';
                sites.forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.id;
                    opt.innerText = s.name;
                    siteSelect.appendChild(opt);
                });
                siteSelect.value = selectedEventSiteId;
            }

            // Populate cfg-site dropdown
            const cfgSite = document.getElementById('cfg-site');
            if (cfgSite) {
                const currentVal = cfgSite.value;
                cfgSite.innerHTML = '<option value="">None (Unassigned)</option>';
                sites.forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.id;
                    opt.innerText = s.name;
                    cfgSite.appendChild(opt);
                });
                cfgSite.value = currentVal;
            }

            // Render active site list
            const listContainer = document.getElementById('site-list-container');
            if (listContainer) {
                listContainer.innerHTML = '';
                if (sites.length === 0) {
                    listContainer.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.85rem; font-style: italic;">No sites created yet.</div>';
                }
                sites.forEach(s => {
                    const row = document.createElement('div');
                    row.style.display = 'flex';
                    row.style.justifyContent = 'space-between';
                    row.style.alignItems = 'center';
                    row.style.background = 'rgba(255,255,255,0.03)';
                    row.style.padding = '0.4rem 0.6rem';
                    row.style.borderRadius = '4px';
                    row.style.border = '1px solid var(--border-color)';
                    row.style.fontSize = '0.9rem';

                    row.innerHTML = `
                        <span>🏢 ${s.name}</span>
                        <button class="btn btn-lockdown" style="padding: 0.2rem 0.4rem; font-size: 0.75rem;" data-delete-site="${s.id}">Delete</button>
                    `;
                    listContainer.appendChild(row);
                });

                // Attach delete listeners
                listContainer.querySelectorAll('[data-delete-site]').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const id = btn.getAttribute('data-delete-site');
                        if (confirm('Are you sure you want to delete this site? Controllers in this site will become unassigned.')) {
                            await deleteSite(id);
                        }
                    });
                });
            }
        } catch (err) {
            console.error('Failed to load sites:', err);
        }
    }

    async function deleteSite(id) {
        try {
            const res = await fetch(`/api/sites?id=${id}`, { method: 'DELETE' });
            if (res.ok) {
                if (selectedEventSiteId === id) selectedEventSiteId = '';
                loadSites();
            }
        } catch (err) {
            console.error('Failed to delete site:', err);
        }
    }

    async function loadEventsDoors() {
        try {
            const res = await fetch('/api/controllers');
            if (!res.ok) return;
            const ctrls = await res.json();
            const doorSelect = document.getElementById('event-door-select');
            if (doorSelect) {
                doorSelect.innerHTML = '<option value="">All Doors</option>';
                ctrls.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.controller_id;
                    opt.innerText = c.friendly_name || c.controller_id;
                    doorSelect.appendChild(opt);
                });
                doorSelect.value = selectedEventDoorId;
            }
        } catch (err) {
            console.error('Failed to load doors list:', err);
        }
    }

    async function loadEventsConsole() {
        try {
            let url = `/api/events?filter_view=${selectedEventFilterView}`;
            if (selectedEventMode === 'door' && selectedEventDoorId) {
                url += `&controller_id=${selectedEventDoorId}`;
            } else if (selectedEventMode === 'site' && selectedEventSiteId) {
                url += `&site_id=${selectedEventSiteId}`;
            }

            const res = await fetch(url);
            if (!res.ok) return;
            eventsConsoleCache = await res.json();
            renderEventsConsole();
        } catch (err) {
            console.error('Failed to load events console:', err);
        }
    }

    window.renderEventsConsole = function() {
        const consoleEl = document.getElementById('event-stream-console');
        if (!consoleEl) return;
        consoleEl.innerHTML = '';

        if (eventsConsoleCache.length === 0) {
            consoleEl.innerHTML = '<div style="color: var(--text-secondary); font-style: italic; padding: 1rem;">No events match the selected criteria.</div>';
            return;
        }

        eventsConsoleCache.forEach(e => {
            const row = document.createElement('div');
            let typeClass = 'info';
            let typeLabel = e.event_type || e.alarm_type || 'INFO';
            let detailText = e.details;

            if (e.event_source === 'system_alarms') {
                if (typeLabel === 'PRE_ALARM') {
                    typeClass = 'warn';
                    detailText = `CAUTION: ${e.details}`;
                } else {
                    typeClass = 'alarm';
                    detailText = `CRITICAL ALARM: ${e.details}`;
                }
            } else {
                const et = e.event_type;
                if (et === 'CARD_GRANT') {
                    typeClass = 'grant';
                } else if (et === 'DENY' || et === 'DENY_SCHEDULE') {
                    typeClass = 'deny';
                } else if (et === 'DOOR_OPEN' || et === 'DOOR_CLOSE') {
                    typeClass = 'open-close';
                } else if (['DFO', 'DHO', 'APB_VIOLATION'].includes(et)) {
                    typeClass = 'alarm';
                } else if (et === 'PRE_ALARM') {
                    typeClass = 'warn';
                }
            }

            const timeStr = formatDateTime(e.event_timestamp || e.created_at);
            row.className = `log-row ${typeClass}`;
            row.innerHTML = `
                <span class="time">[${timeStr}]</span>
                <span class="type" style="text-transform: uppercase;">${typeLabel}</span>
                <span class="message">${detailText} ${e.employee_name ? '(' + e.employee_name + ')' : ''}</span>
            `;
            consoleEl.appendChild(row);
        });
    }

    // Delete Controller
    document.getElementById('btn-config-delete').addEventListener('click', async () => {
        const controllerId = selectedConfigControllerId;
        if (!controllerId) {
            alert('No controller selected.');
            return;
        }

        const confirmMsg = `⚠️ WARNING: ARE YOU SURE YOU WANT TO DELETE THIS CONTROLLER? ⚠️\n\n` +
                           `This will permanently delete controller "${controllerId}" from the database.\n\n` +
                           `This action will also DELETE:\n` +
                           `- All Door Map Placements\n` +
                           `- All Controller Configurations\n` +
                           `- All Access Level Mappings for this controller\n` +
                           `- ALL HISTORIC ACCESS LOG EVENTS\n` +
                           `- ALL SYSTEM ALARMS & BREACH ALERTS\n\n` +
                           `This cannot be undone. Type 'DELETE' to confirm:`;

        const confirmation = prompt(confirmMsg);
        if (confirmation !== 'DELETE') {
            alert('Deletion cancelled.');
            return;
        }

        try {
            const res = await fetch(`/api/controllers?controller_id=${controllerId}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                alert(`✅ Controller "${controllerId}" and all associated data deleted successfully.`);
                selectedConfigControllerId = '';
                populateConfigControllerSelect();
                if (typeof loadMapPlacements === 'function') {
                    loadMapPlacements();
                }
            } else {
                const err = await res.text();
                alert('Deletion failed: ' + err);
            }
        } catch (err) {
            alert('Network error: ' + err.message);
        }
    });

    // Helper functions
    function formatDateTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        const datePart = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
        const timePart = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        
        let tzName = '';
        try {
            const match = d.toString().match(/\(([^)]+)\)$/);
            if (match) tzName = ' ' + match[1];
        } catch(e) {}
        
        return `${datePart} ${timePart}${tzName}`;
    }

    function formatDateOnly(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    }

    function loadControllerLogs() {
        const consoleEl = document.getElementById('syslog-console');
        if (!consoleEl) return;
        
        const currentCtrl = document.getElementById('log-ctrl-select').value;
        const currentLvl = document.getElementById('log-level-select').value;
        const searchVal = document.getElementById('log-msg-search').value.trim().toLowerCase();
        
        let url = '/api/controller-logs?limit=250';
        if (currentCtrl) url += `&controller_id=${currentCtrl}`;
        if (currentLvl) url += `&level=${currentLvl}`;
        
        fetch(url)
            .then(res => res.json())
            .then(data => {
                systemLogsCache = data;
                renderSystemLogs(searchVal);
            })
            .catch(err => {
                console.error('Failed to load logs:', err);
            });
    }

    function renderSystemLogs(searchVal) {
        const consoleEl = document.getElementById('syslog-console');
        if (!consoleEl) return;
        
        consoleEl.innerHTML = '';
        
        const filtered = systemLogsCache.filter(l => {
            if (!searchVal) return true;
            return l.message.toLowerCase().includes(searchVal) || 
                   l.level.toLowerCase().includes(searchVal) || 
                   l.controller_id.toLowerCase().includes(searchVal);
        });
        
        if (filtered.length === 0) {
            consoleEl.innerHTML = '<div style="color: #666; font-style: italic; padding: 10px;">No system log messages match.</div>';
            return;
        }
        
        filtered.forEach(l => {
            const row = document.createElement('div');
            row.className = `syslog-row ${l.level.toLowerCase()}`;
            
            let messageText = l.message;
            if (searchVal) {
                const regex = new RegExp(`(${escapeRegExp(searchVal)})`, 'gi');
                messageText = messageText.replace(regex, '<mark class="search-highlight">$1</mark>');
            }
            
            row.innerHTML = `
                <span class="time">[${formatDateTime(l.log_timestamp)}]</span>
                <span class="ctrl">${l.controller_id}</span>
                <span class="badge badge-${l.level.toLowerCase()}">${l.level}</span>
                <span class="msg">${messageText}</span>
            `;
            consoleEl.appendChild(row);
        });
        
        if (document.getElementById('chk-log-autoscroll').checked) {
            const wrapper = consoleEl.closest('.syslog-console-wrapper');
            if (wrapper) {
                wrapper.scrollTop = wrapper.scrollHeight;
            }
        }
    }

    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    document.getElementById('btn-syslog-refresh').addEventListener('click', () => {
        loadControllerLogs();
    });

    document.getElementById('log-ctrl-select').addEventListener('change', () => {
        loadControllerLogs();
    });

    document.getElementById('log-level-select').addEventListener('change', () => {
        loadControllerLogs();
    });

    document.getElementById('log-msg-search').addEventListener('input', (e) => {
        renderSystemLogs(e.target.value.trim().toLowerCase());
    });

    document.getElementById('btn-syslog-export').addEventListener('click', () => {
        const headers = ['Timestamp', 'Controller ID', 'Level', 'Message'];
        const csvRows = [headers.join(',')];
        
        systemLogsCache.forEach(l => {
            const dateStr = formatDateTime(l.log_timestamp);
            const msg = l.message.replace(/"/g, '""');
            csvRows.push([
                `"${dateStr}"`,
                `"${l.controller_id}"`,
                `"${l.level}"`,
                `"${msg}"`
            ].join(','));
        });
        
        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('href', url);
        a.setAttribute('download', `controller_system_logs_${new Date().toISOString().slice(0,10)}.csv`);
        a.click();
    });

    function showToastAlert(logData) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        
        const toast = document.createElement('div');
        toast.className = `toast ${logData.level.toLowerCase()}`;
        
        toast.innerHTML = `
            <div class="toast-header">
                <span class="level-label">${logData.level} ALERT</span>
                <span style="font-weight: bold; font-family: monospace;">${logData.controller_id}</span>
                <button class="close-btn">&times;</button>
            </div>
            <div class="toast-body">${logData.message || logData.details}</div>
            <div class="toast-footer">${new Date().toLocaleTimeString()}</div>
        `;
        
        toast.querySelector('.close-btn').addEventListener('click', () => {
            toast.remove();
        });
        
        container.appendChild(toast);
        
        // Auto-remove after 6 seconds
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100%) scale(0.9)';
            setTimeout(() => toast.remove(), 300);
        }, 6000);
    }
});