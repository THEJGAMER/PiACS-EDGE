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

            if (item.id === 'btn-syslogs') {
                loadControllerLogs();
            } else if (item.id === 'btn-map') {
                loadMapPlacements();
            } else if (item.id === 'btn-threat') {
                loadThreatLevel();
            } else if (item.id === 'btn-health') {
                loadSystemHealth();
                healthPollInterval = setInterval(loadSystemHealth, 5000);
            }
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
    let healthPollInterval = null;
    let eventsCache = [];    // Cached logs for filtering and CSV export

    // Load Initial Data
    loadControllers();
    loadSchedules();
    loadHolidays();
    loadAccessLevels();
    loadCredentials();
    loadInitialEvents();

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

    // REST Functions
    async function loadControllers() {
        try {
            const res = await fetch('/api/controllers');
            const data = await res.json();
            const container = document.getElementById('doors-container');
            const readerSelect = document.getElementById('al-reader');
            const logCtrlSelect = document.getElementById('log-ctrl-select');
            
            container.innerHTML = '';
            readerSelect.innerHTML = '';
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

                // Add option to reader selectors
                const opt = document.createElement('option');
                opt.value = ctrl.controller_id;
                opt.innerText = `${ctrl.controller_id} (${ctrl.friendly_name})`;
                readerSelect.appendChild(opt);

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
        const tbody = document.querySelector('#table-timezones tbody');
        const alSelect = document.getElementById('al-timezone');

        tbody.innerHTML = '';
        alSelect.innerHTML = '<option value="">-- Choose Time Zone --</option>';

        data.forEach(tz => {
            const tr = document.createElement('tr');
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Holiday'];
            const daysConfigured = tz.intervals.map(iv => `${dayNames[iv.day_of_week]}: ${iv.start_time}-${iv.end_time}`).join(', ');

            tr.innerHTML = `
                <td>${tz.id}</td>
                <td>${tz.name}</td>
                <td>${daysConfigured || 'None'}</td>
            `;
            tbody.appendChild(tr);

            const opt = document.createElement('option');
            opt.value = tz.id;
            opt.innerText = tz.name;
            alSelect.appendChild(opt);
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
    async function loadAccessLevels() {
        const res = await fetch('/api/access-levels');
        const data = await res.json();
        const tbody = document.querySelector('#table-access-levels tbody');
        const credContainer = document.getElementById('cred-access-levels-container');

        tbody.innerHTML = '';
        credContainer.innerHTML = '';

        data.forEach(al => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${al.id}</td>
                <td>${al.name}</td>
                <td>${al.reader_id || 'N/A'}</td>
                <td>${al.timezone_name || 'N/A'}</td>
            `;
            tbody.appendChild(tr);

            const lbl = document.createElement('label');
            lbl.innerHTML = `
                <input type="checkbox" name="cred-al" value="${al.id}">
                ${al.name} (Reader: ${al.reader_id || 'N/A'})
            `;
            credContainer.appendChild(lbl);
        });
    }

    async function saveAccessLevel(e) {
        e.preventDefault();
        const name = document.getElementById('al-name').value;
        const reader_id = document.getElementById('al-reader').value;
        const time_zone_id = parseInt(document.getElementById('al-timezone').value);

        const res = await fetch('/api/access-levels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, reader_id, time_zone_id })
        });

        if (res.ok) {
            document.getElementById('form-access-level').reset();
            loadAccessLevels();
        }
    }
    async function loadCredentials() {
        const res = await fetch('/api/credentials');
        const data = await res.json();
        const tbody = document.querySelector('#table-credentials tbody');
        tbody.innerHTML = '';
        data.forEach(c => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>
                    <div style="font-weight: bold;">${c.employee_name}</div>
                    <div style="font-size: 0.75rem; color: #888;">User ID: ${c.user_id} | ID: ${c.id}</div>
                </td>
                <td>${c.card_id} <span style="font-size: 0.75rem; color: #666;">(FC:${c.facility_code}, ${c.bit_length}b)</span></td>
                <td>${formatDateOnly(c.activation_date)} - ${formatDateOnly(c.expiration_date)}</td>
                <td><span class="status-badge ${c.is_active ? 'secure' : 'alarm'}">${c.is_active ? 'ACTIVE' : 'INACTIVE'}</span></td>
                <td>
                    <button class="btn btn-secondary btn-edit-cred" data-id="${c.id}" style="padding: 0.2rem 0.5rem; font-size: 0.75rem; margin-right: 0.2rem;">✏️ Edit</button>
                    <button class="btn btn-clear btn-delete-cred" data-id="${c.id}" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;">🗑️ Del</button>
                </td>
            `;

            // Bind edit button
            tr.querySelector('.btn-edit-cred').addEventListener('click', () => {
                document.getElementById('cred-id').value = c.id;
                document.getElementById('cred-user-id').value = c.user_id;
                document.getElementById('cred-name').value = c.employee_name;
                document.getElementById('cred-fc').value = c.facility_code;
                document.getElementById('cred-cid').value = c.card_id;
                document.getElementById('cred-bits').value = c.bit_length;
                document.getElementById('cred-pin').value = c.pin_code || '';
                document.getElementById('cred-start-date').value = c.activation_date;
                document.getElementById('cred-end-date').value = c.expiration_date;
                document.getElementById('cred-active').checked = c.is_active;

                // Check assigned access levels
                document.querySelectorAll('input[name="cred-al"]').forEach(cb => {
                    cb.checked = c.access_levels ? c.access_levels.includes(parseInt(cb.value)) : false;
                });
                
                document.getElementById('btn-save-badge').innerText = 'Update Badge Credential';
            });

            // Bind delete button
            tr.querySelector('.btn-delete-cred').addEventListener('click', async () => {
                if (confirm(`Are you sure you want to delete ${c.employee_name}'s badge?`)) {
                    const delRes = await fetch(`/api/credentials?id=${c.id}`, { method: 'DELETE' });
                    if (delRes.ok) {
                        loadCredentials();
                    }
                }
            });

            tbody.appendChild(tr);
        });
    }

    async function saveCredential(e) {
        e.preventDefault();
        const id = document.getElementById('cred-id').value;
        const user_id = document.getElementById('cred-user-id').value;
        const employee_name = document.getElementById('cred-name').value;
        const facility_code = parseInt(document.getElementById('cred-fc').value);
        const card_id = parseInt(document.getElementById('cred-cid').value);
        const bit_length = parseInt(document.getElementById('cred-bits').value);
        const pinVal = document.getElementById('cred-pin').value;
        const activation_date = document.getElementById('cred-start-date').value;
        const expiration_date = document.getElementById('cred-end-date').value;
        const is_active = document.getElementById('cred-active').checked;

        const accessLevels = [];
        document.querySelectorAll('input[name="cred-al"]:checked').forEach(cb => {
            accessLevels.push(parseInt(cb.value));
        });

        const payload = {
            employee_name,
            facility_code,
            card_id,
            bit_length,
            is_active,
            access_levels: accessLevels,
            activation_date,
            expiration_date
        };

        if (pinVal) {
            payload.pin_code = pinVal;
        }

        let url = '/api/credentials';
        let method = 'POST';

        if (id) {
            payload.id = parseInt(id);
            payload.user_id = parseInt(user_id);
            method = 'PUT';
        }

        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            document.getElementById('form-credential').reset();
            document.getElementById('cred-id').value = '';
            document.getElementById('cred-user-id').value = '';
            document.getElementById('btn-save-badge').innerText = 'Register Badge Credential';
            loadCredentials();
        }
    }

    // System Logs variables & listeners
    let systemLogsCache = [];
    document.getElementById('log-ctrl-select').addEventListener('change', () => loadControllerLogs());
    document.getElementById('log-level-select').addEventListener('change', () => loadControllerLogs());
    document.getElementById('log-msg-search').addEventListener('input', (e) => renderSystemLogs(e.target.value.toLowerCase()));
    document.getElementById('btn-syslog-refresh').addEventListener('click', () => loadControllerLogs());

    async function loadControllerLogs() {
        const cId = document.getElementById('log-ctrl-select').value;
        const lvl = document.getElementById('log-level-select').value;
        const q = document.getElementById('log-msg-search').value.toLowerCase();

        let url = '/api/controller-logs?limit=200';
        if (cId) url += '&controller_id=' + encodeURIComponent(cId);
        if (lvl) url += '&level=' + encodeURIComponent(lvl);

        try {
            const res = await fetch(url);
            systemLogsCache = await res.json();
            renderSystemLogs(q);
        } catch (err) {
            console.error('Failed to load controller logs:', err);
        }
    }

    function renderSystemLogs(filterText = '') {
        const consoleEl = document.getElementById('syslog-console');
        consoleEl.innerHTML = '';

        const filtered = systemLogsCache.filter(l => {
            if (filterText && !l.message.toLowerCase().includes(filterText)) {
                return false;
            }
            return true;
        });

        filtered.forEach(l => {
            const row = document.createElement('div');
            const typeClass = l.level.toLowerCase();
            const timeStr = formatDateTime(l.log_timestamp);
            row.className = `syslog-row ${typeClass}`;
            row.innerHTML = `
                <span class="time">[${timeStr}]</span>
                <span class="ctrl">${l.controller_id}</span>
                <span class="lvl">${l.level}</span>
                <span class="msg">${l.message}</span>
            `;
            consoleEl.appendChild(row);
        });
    }

    function showToastAlert(data) {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        const levelClass = data.level.toLowerCase();
        toast.className = `toast ${levelClass}`;
        
        const timeStr = formatDateTime(data.log_timestamp || new Date());
        toast.innerHTML = `
            <div class="toast-header">
                <span class="level-label">${data.level}</span>
                <span style="margin-left: 8px;">${data.controller_id}</span>
                <button class="close-btn" style="margin-left: auto;">&times;</button>
            </div>
            <div class="toast-body">
                ${data.message}
            </div>
            <div class="toast-footer">
                ${timeStr}
            </div>
        `;

        toast.querySelector('.close-btn').addEventListener('click', () => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100%) scale(0.9)';
            setTimeout(() => toast.remove(), 300);
        });

        container.appendChild(toast);

        if (data.level !== 'FATAL') {
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.style.opacity = '0';
                    toast.style.transform = 'translateX(100%) scale(0.9)';
                    setTimeout(() => toast.remove(), 300);
                }
            }, 6000);
        }
    }

    function formatDateTime(dateInput) {
        if (!dateInput) return '';
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return dateInput;

        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();

        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        const seconds = String(d.getSeconds()).padStart(2, '0');

        let tz = '';
        try {
            const tzShort = d.toLocaleDateString('en-US', { day: 'numeric', timeZoneName: 'short' }).split(', ')[1] || '';
            if (tzShort) tz = ' ' + tzShort;
        } catch (err) {}

        return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}${tz}`;
    }

    function formatDateOnly(dateInput) {
        if (!dateInput) return '';
        const parts = dateInput.split('T')[0].split('-');
        if (parts.length === 3 && parts[0].length === 4) {
            return `${parts[2]}/${parts[1]}/${parts[0]}`;
        }
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return dateInput;
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
    }

    // Portal Map placements
    let mapPlacements = {};

    async function loadMapPlacements() {
        try {
            const pres = await fetch('/api/map-placements');
            const placements = await pres.json();
            mapPlacements = {};
            placements.forEach(p => {
                mapPlacements[p.controller_id] = { x: p.pos_x, y: p.pos_y };
            });

            const cres = await fetch('/api/controllers');
            const controllers = await cres.json();

            renderMapNodes(controllers);
        } catch (err) {
            console.error('Failed to load map placements:', err);
        }
    }

    function renderMapNodes(controllers) {
        const container = document.getElementById('map-nodes-container');
        container.innerHTML = '';

        controllers.forEach(ctrl => {
            const node = document.createElement('div');
            node.className = 'map-door-node';
            node.id = `map-node-${ctrl.controller_id}`;
            node.innerHTML = `🚪`;
            node.title = `${ctrl.friendly_name} (${ctrl.controller_id})`;

            const pos = mapPlacements[ctrl.controller_id] || { x: 100, y: 100 };
            node.style.left = `${pos.x}px`;
            node.style.top = `${pos.y}px`;

            if (ctrl.is_online) {
                node.classList.add('secure');
            } else {
                node.style.opacity = '0.5';
            }

            enableDrag(node, ctrl.controller_id);

            node.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.map-popover').forEach(p => p.remove());

                const popover = document.createElement('div');
                popover.className = 'map-popover';
                popover.innerHTML = `
                    <h5>${ctrl.friendly_name}</h5>
                    <div class="map-popover-buttons">
                        <button class="btn btn-grant btn-pop-unlock">Unlock</button>
                        <button class="btn btn-lockdown btn-pop-lockdown">Lockdown</button>
                        <button class="btn btn-sustain btn-pop-sustain">Sustain</button>
                        <button class="btn btn-clear btn-pop-clear">Clear</button>
                    </div>
                `;

                popover.querySelector('.btn-pop-unlock').addEventListener('click', () => sendCommand(ctrl.controller_id, 'REMOTE_UNLOCK'));
                popover.querySelector('.btn-pop-lockdown').addEventListener('click', () => sendCommand(ctrl.controller_id, 'FORCE_LOCK'));
                popover.querySelector('.btn-pop-sustain').addEventListener('click', () => sendCommand(ctrl.controller_id, 'SUSTAIN_OPEN'));
                popover.querySelector('.btn-pop-clear').addEventListener('click', () => sendCommand(ctrl.controller_id, 'CLEAR_ALARMS'));

                node.appendChild(popover);
            });

            container.appendChild(node);
        });

        document.getElementById('map-canvas').addEventListener('click', () => {
            document.querySelectorAll('.map-popover').forEach(p => p.remove());
        });
    }

    function enableDrag(el, controller_id) {
        let isDragging = false;
        let startX, startY, initialX, initialY;

        el.addEventListener('mousedown', (e) => {
            if (e.target.closest('.map-popover')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            initialX = el.offsetLeft;
            initialY = el.offsetTop;
            el.style.zIndex = '1000';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            const parent = el.offsetParent;
            let nx = initialX + dx;
            let ny = initialY + dy;
            if (nx < 0) nx = 0;
            if (ny < 0) ny = 0;
            if (nx > parent.clientWidth - el.clientWidth) nx = parent.clientWidth - el.clientWidth;
            if (ny > parent.clientHeight - el.clientHeight) ny = parent.clientHeight - el.clientHeight;

            el.style.left = `${nx}px`;
            el.style.top = `${ny}px`;
        });

        document.addEventListener('mouseup', async () => {
            if (!isDragging) return;
            isDragging = false;
            el.style.zIndex = '100';

            const x = parseInt(el.style.left);
            const y = parseInt(el.style.top);

            await fetch('/api/map-placements', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ controller_id, pos_x: x, pos_y: y })
            });
        });
    }

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

                <div class="health-metrics-grid">
                    <div>
                        <div class="health-metric-label">Local SQLite Queue</div>
                        <div class="health-metric-val">${h.buffered_logs}</div>
                    </div>
                    <div>
                        <div class="health-metric-label">DB Ping Latency</div>
                        <div class="health-metric-val">${h.last_ping_ms} ms</div>
                    </div>
                </div>
            `;
            container.appendChild(card);
        });
    }

    // ---- Controller Configuration (Authenticated) ----

    let configAuthToken = sessionStorage.getItem('piacs_config_token') || null;

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
            document.getElementById('config-panel').style.display = 'block';

            populateConfigControllerSelect();
        } catch (err) {
            errorEl.innerText = 'Connection error: ' + err.message;
            errorEl.style.display = 'block';
        }
    });

    // Check for existing token on config tab load
    async function checkConfigAuth() {
        if (!configAuthToken) return;
        try {
            const res = await fetch('/api/controller-config', {
                headers: { 'Authorization': 'Bearer ' + configAuthToken }
            });
            if (res.ok) {
                document.getElementById('config-auth-gate').style.display = 'none';
                document.getElementById('config-panel').style.display = 'block';
                populateConfigControllerSelect();
            } else {
                configAuthToken = null;
                sessionStorage.removeItem('piacs_config_token');
            }
        } catch (e) {
            configAuthToken = null;
            sessionStorage.removeItem('piacs_config_token');
        }
    }

    async function populateConfigControllerSelect() {
        try {
            const res = await fetch('/api/controllers');
            const data = await res.json();
            const sel = document.getElementById('config-ctrl-select');
            sel.innerHTML = '';
            data.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.controller_id;
                opt.textContent = `${c.friendly_name} (${c.controller_id})`;
                sel.appendChild(opt);
            });
            if (data.length > 0) {
                loadControllerConfigData(data[0].controller_id);
            }
        } catch (err) {
            console.error('Failed to load controllers for config:', err);
        }
    }

    async function loadControllerConfigData(controllerId) {
        try {
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
        } catch (err) {
            console.error('Failed to load controller config:', err);
        }
    }

    document.getElementById('btn-config-load').addEventListener('click', () => {
        const sel = document.getElementById('config-ctrl-select');
        if (sel.value) loadControllerConfigData(sel.value);
    });

    document.getElementById('btn-config-reset').addEventListener('click', () => {
        const sel = document.getElementById('config-ctrl-select');
        if (sel.value) loadControllerConfigData(sel.value);
    });

    document.getElementById('form-controller-config').addEventListener('submit', async (e) => {
        e.preventDefault();
        const statusEl = document.getElementById('config-save-status');
        statusEl.style.display = 'block';
        statusEl.style.color = '#4ecdc4';
        statusEl.innerText = 'Saving and pushing to controller...';

        const payload = {
            controller_id: document.getElementById('cfg-controller-id').value,
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
            apb_strict: document.getElementById('cfg-apb-strict').checked
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

            setTimeout(() => { statusEl.style.display = 'none'; }, 8000);
        } catch (err) {
            statusEl.style.color = '#ff4444';
            statusEl.innerText = '❌ Error: ' + err.message;
        }
    });
});
