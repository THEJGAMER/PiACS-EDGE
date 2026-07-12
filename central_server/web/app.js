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

    // ...
