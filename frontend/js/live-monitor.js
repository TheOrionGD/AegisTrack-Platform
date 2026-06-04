/**
 * AegisTrack — Live Monitor
 */
'use strict';

// ── Config ───────────────────────────────────────────────────────────────────
const BACKEND_URL      = window.BACKEND_URL || 'https://aegistrack-backend.onrender.com';
const WS_URL           = window.WS_URL || (BACKEND_URL.replace(/^http/, 'ws') + '/ws');

const POLL_INTERVAL_MS  = 30000;   // refresh device list every 30s
const PATH_MAX_POINTS   = 50;      // max path points on map
const MAP_DEFAULT_LAT   = 0; // default map center if no device
const MAP_DEFAULT_LNG   = 0;
const MAP_DEFAULT_ZOOM  = 2;

// ── State ────────────────────────────────────────────────────────────────────
let jwtToken        = null;
let operatorName    = null;
let allDevices      = [];          // full device list from API
let selectedDevice  = null;        // currently selected device object
let pollTimer       = null;        // device list refresh interval
let wsConn          = null;        // WebSocket connection
let wsReconnectTimer= null;
let showPath        = true;
let showGeofence    = true;
let pendingIntervalMs = null;      // interval to push on next force-location

// ── Leaflet Map State ─────────────────────────────────────────────────────────
let map             = null;
const activeMarkers = new Map();   // Map<device_id, marker>
let geofenceCircle  = null;
let pathPolyline    = null;
let pathPoints      = [];          // [{lat, lng}]

// ── DOM ───────────────────────────────────────────────────────────────────────
const authOverlay     = document.getElementById('authOverlay');
const monitorApp      = document.getElementById('monitorApp');
const authUsername    = document.getElementById('authUsername');
const authPassword    = document.getElementById('authPassword');
const authLoginBtn    = document.getElementById('authLoginBtn');
const authError       = document.getElementById('authError');

const wsStatusBadge   = document.getElementById('wsStatusBadge');
const wsStatusText    = document.getElementById('wsStatusText');
const operatorLabel   = document.getElementById('operatorLabel');
const topbarLogout    = document.getElementById('topbarLogout');
const refreshBtn      = document.getElementById('refreshBtn');
const deviceSearch    = document.getElementById('deviceSearch');
const deviceList      = document.getElementById('deviceList');
const deviceCount     = document.getElementById('deviceCount');
const mapNoDeviceOverlay = document.getElementById('mapNoDeviceOverlay');
const centerMapBtn    = document.getElementById('centerMapBtn');
const togglePathBtn   = document.getElementById('togglePathBtn');
const toggleGeofenceBtn = document.getElementById('toggleGeofenceBtn');

// Detail panel
const deviceDetailEmpty   = document.getElementById('deviceDetailEmpty');
const deviceDetailContent = document.getElementById('deviceDetailContent');
const deviceStatusBadge   = document.getElementById('deviceStatusBadge');
const detDeviceName   = document.getElementById('detDeviceName');
const detOwnerName    = document.getElementById('detOwnerName');
const detDeviceModel  = document.getElementById('detDeviceModel');
const detDeviceOS     = document.getElementById('detDeviceOS');
const detLatitude     = document.getElementById('detLatitude');
const detLongitude    = document.getElementById('detLongitude');
const detAccuracy     = document.getElementById('detAccuracy');
const detLastSeen     = document.getElementById('detLastSeen');
const detAlerts       = document.getElementById('detAlerts');
const geofenceStatusText = document.getElementById('geofenceStatusText');
const forceLocationBtn = document.getElementById('forceLocationBtn');
const detGoogleMapsLink = document.getElementById('detGoogleMapsLink');

// Interval selector
const intervalBtns    = Array.from(document.querySelectorAll('.interval-btn'));

// Geofence controls
const gfCenterLat     = document.getElementById('gfCenterLat');
const gfCenterLng     = document.getElementById('gfCenterLng');
const gfRadius        = document.getElementById('gfRadius');
const radiusDisplay   = document.getElementById('radiusDisplay');
const setGeofenceBtn  = document.getElementById('setGeofenceBtn');
const useDevicePosBtn = document.getElementById('useDevicePosBtn');

// Alert feed
const alertFeed       = document.getElementById('alertFeed');
const alertFeedCount  = document.getElementById('alertFeedCount');
let alertCount        = 0;

// Breach toast
const breachToast     = document.getElementById('breachToast');
const breachToastMsg  = document.getElementById('breachToastMsg');
const breachToastClose = document.getElementById('breachToastClose');

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    jwtToken = localStorage.getItem('access_token');

    if (jwtToken) {
        showDashboard();
    } else {
        showAuthOverlay();
    }

    // Auth form
    authLoginBtn.addEventListener('click', doLogin);
    authPassword.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

    // Topbar
    topbarLogout.addEventListener('click', doLogout);
    refreshBtn.addEventListener('click', () => fetchDevices(true));

    // Map controls
    centerMapBtn.addEventListener('click', centerOnDevice);
    togglePathBtn.addEventListener('click', togglePath);
    toggleGeofenceBtn.addEventListener('click', toggleGeofenceOverlay);

    // Device search
    deviceSearch.addEventListener('input', renderDeviceList);

    // Interval selector
    intervalBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            intervalBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const ms = parseInt(btn.dataset.ms, 10);
            pendingIntervalMs = ms;
            showToast(`Update interval set to ${formatInterval(ms)}. Will apply on next force-check.`, 'info');
        });
    });

    // Geofence form
    gfRadius.addEventListener('input', () => {
        radiusDisplay.textContent = `${gfRadius.value} m`;
    });
    gfCenterLat.addEventListener('input', validateGeofenceForm);
    gfCenterLng.addEventListener('input', validateGeofenceForm);
    gfRadius.addEventListener('input', validateGeofenceForm);
    setGeofenceBtn.addEventListener('click', submitGeofence);
    useDevicePosBtn.addEventListener('click', fillDevicePosition);

    // Force location
    forceLocationBtn.addEventListener('click', triggerForceLocation);

    // Breach toast close
    breachToastClose.addEventListener('click', () => breachToast.classList.add('hidden'));
});

// ── Auth ──────────────────────────────────────────────────────────────────────
function showAuthOverlay() {
    authOverlay.classList.remove('hidden');
    monitorApp.classList.add('hidden');
    setTimeout(() => authUsername.focus(), 100);
}

function showDashboard() {
    authOverlay.classList.add('hidden');
    monitorApp.classList.remove('hidden');

    // Decode username from JWT payload
    try {
        const payload = JSON.parse(atob(jwtToken.split('.')[1]));
        operatorName = payload.sub || payload.identity || 'Operator';
    } catch (_) { operatorName = 'Operator'; }
    operatorLabel.textContent = operatorName;

    initMap();
    fetchDevices(true);
    fetchDeviceLocations();
    fetchAlerts();
    startPollTimer();
    connectWebSocket();
}

async function doLogin() {
    const username = authUsername.value.trim();
    const password = authPassword.value.trim();
    if (!username || !password) {
        showAuthError('Username and password are required.');
        return;
    }
    authLoginBtn.disabled = true;
    authLoginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Authenticating…';
    authError.classList.add('hidden');

    try {
        const res = await fetch(`${BACKEND_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.access_token) {
            jwtToken = data.access_token;
            localStorage.setItem('access_token', jwtToken);
            showDashboard();
        } else {
            showAuthError(data?.error || `Login failed (${res.status}).`);
        }
    } catch (err) {
        showAuthError(`Network error: ${err.message}`);
    } finally {
        authLoginBtn.disabled = false;
        authLoginBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Authenticate';
    }
}

function doLogout() {
    localStorage.removeItem('access_token');
    jwtToken = null;
    stopPollTimer();
    disconnectWebSocket();
    showAuthOverlay();
}

function showAuthError(msg) {
    authError.textContent = msg;
    authError.classList.remove('hidden');
}

// ── Map Init ──────────────────────────────────────────────────────────────────
function initMap() {
    if (map) return;
    map = L.map('map', { zoomControl: true }).setView([MAP_DEFAULT_LAT, MAP_DEFAULT_LNG], MAP_DEFAULT_ZOOM);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
        maxZoom: 19
    }).addTo(map);
}

// ── Device List ───────────────────────────────────────────────────────────────
async function fetchDevices(showLoader = false) {
    if (showLoader) {
        deviceList.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading devices…</p></div>';
    }
    try {
        const res = await fetch(`${BACKEND_URL}/devices/monitored`, {
            headers: { 'Authorization': `Bearer ${jwtToken}` }
        });
        if (res.status === 401) { doLogout(); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        allDevices = data.devices || [];
        deviceCount.textContent = allDevices.length;

        // If a device was selected before, refresh its data
        if (selectedDevice) {
            const updated = allDevices.find(d => d.device_id === selectedDevice.device_id);
            if (updated) {
                selectedDevice = updated;
                renderDetailPanel(updated);
                updateMapForDevice(updated);
            }
        }
        renderDeviceList();
    } catch (err) {
        console.warn('[AegisTrack Monitor] fetchDevices error:', err.message);
    }
}

async function fetchDeviceLocations() {
    try {
        const res = await fetch(`${BACKEND_URL}/device-locations`, {
            headers: { 'Authorization': `Bearer ${jwtToken}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const locations = data.locations || [];

        if (locations.length === 0) {
            // Update overlay to show "No location data available"
            mapNoDeviceOverlay.querySelector('h3').textContent = "No location data available.";
            mapNoDeviceOverlay.querySelector('p').textContent = "Wait for enrolled devices to transmit coordinates.";
            mapNoDeviceOverlay.classList.remove('hidden');
            
            // Remove any existing markers
            activeMarkers.forEach(marker => {
                marker.remove();
            });
            activeMarkers.clear();
            return;
        }

        // Clear old markers that are no longer present
        const locIds = locations.map(l => l.device_id);
        activeMarkers.forEach((marker, id) => {
            if (!locIds.includes(id)) {
                marker.remove();
                activeMarkers.delete(id);
            }
        });

        // Add or update markers
        locations.forEach(loc => {
            const latlng = L.latLng(loc.latitude, loc.longitude);
            if (activeMarkers.has(loc.device_id)) {
                activeMarkers.get(loc.device_id).setLatLng(latlng);
            } else {
                const icon = L.divIcon({
                    className: '',
                    html: '<div class="device-marker-icon"></div>',
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                });
                const marker = L.marker(latlng, { icon }).addTo(map);
                
                const popupContent = document.createElement('div');
                popupContent.style.fontFamily = "'Inter',sans-serif";
                popupContent.style.minWidth = '180px';

                const strong = document.createElement('strong');
                strong.style.color = '#00c3ff';
                strong.style.fontSize = '13px';
                strong.textContent = loc.device_name || loc.device_id;

                const br = document.createElement('br');

                const ownerSpan = document.createElement('span');
                ownerSpan.style.color = '#8da2bb';
                ownerSpan.style.fontSize = '11px';
                ownerSpan.textContent = loc.owner_name || '';

                const br2 = document.createElement('br');

                const infoDiv = document.createElement('div');
                infoDiv.style.marginTop = '8px';
                infoDiv.style.fontSize = '12px';
                infoDiv.style.color = '#e8f0fa';

                const latDiv = document.createElement('div');
                latDiv.appendChild(document.createTextNode('Lat: '));
                const latCode = document.createElement('code');
                latCode.style.color = '#00c3ff';
                latCode.textContent = loc.latitude.toFixed(6);
                latDiv.appendChild(latCode);

                const lngDiv = document.createElement('div');
                lngDiv.appendChild(document.createTextNode('Lng: '));
                const lngCode = document.createElement('code');
                lngCode.style.color = '#00c3ff';
                lngCode.textContent = loc.longitude.toFixed(6);
                lngDiv.appendChild(lngCode);

                const timeDiv = document.createElement('div');
                timeDiv.style.color = '#4e6177';
                timeDiv.style.marginTop = '4px';
                timeDiv.style.fontSize = '10px';
                timeDiv.textContent = formatRelative(loc.timestamp);

                infoDiv.appendChild(latDiv);
                infoDiv.appendChild(lngDiv);
                infoDiv.appendChild(timeDiv);

                popupContent.appendChild(strong);
                popupContent.appendChild(br);
                popupContent.appendChild(ownerSpan);
                popupContent.appendChild(br2);
                popupContent.appendChild(infoDiv);

                marker.bindPopup(popupContent);
                activeMarkers.set(loc.device_id, marker);
            }
        });

        // Fit bounds to markers if not focused on selectedDevice
        if (!selectedDevice && locations.length > 0) {
            const group = new L.featureGroup(Array.from(activeMarkers.values()));
            map.fitBounds(group.getBounds().pad(0.1));
        }
    } catch (err) {
        console.warn('[AegisTrack Monitor] fetchDeviceLocations error:', err.message);
    }
}

function renderDeviceList() {
    const query = deviceSearch.value.toLowerCase().trim();
    const filtered = allDevices.filter(d =>
        (d.device_name || '').toLowerCase().includes(query) ||
        (d.owner_name || '').toLowerCase().includes(query) ||
        (d.device_id || '').toLowerCase().includes(query)
    );

    if (filtered.length === 0) {
        deviceList.innerHTML = '';
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-state';
        
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-satellite-dish';
        
        const p = document.createElement('p');
        p.textContent = allDevices.length === 0 ? 'No registered devices available.' : 'No devices match your search.';
        
        emptyDiv.appendChild(icon);
        emptyDiv.appendChild(p);
        deviceList.appendChild(emptyDiv);
        return;
    }

    deviceList.innerHTML = '';
    filtered.forEach(device => {
        const card = buildDeviceCard(device);
        deviceList.appendChild(card);
    });
}

function buildDeviceCard(device) {
    const card = document.createElement('div');
    card.className = `device-card${selectedDevice?.device_id === device.device_id ? ' selected' : ''}`;
    card.dataset.deviceId = device.device_id;

    const status = device.tracking_status || 'REGISTERED';
    const badgeClass = getStatusBadgeClass(status);
    const hasLocation = device.latitude != null && device.longitude != null;
    const lat = hasLocation ? device.latitude.toFixed(5) : '—';
    const lng = hasLocation ? device.longitude.toFixed(5) : '—';
    const lastSeen = device.last_updated ? formatRelative(device.last_updated) : 'Never';

    // Header
    const header = document.createElement('div');
    header.className = 'device-card-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'device-card-name';
    const displayName = device.device_name || device.device_id;
    nameSpan.title = displayName;
    nameSpan.textContent = displayName;

    const statusSpan = document.createElement('span');
    statusSpan.className = `status-badge ${badgeClass}`;
    statusSpan.textContent = status;

    header.appendChild(nameSpan);
    header.appendChild(statusSpan);

    // Owner
    const ownerDiv = document.createElement('div');
    ownerDiv.className = 'device-card-owner';
    const userIcon = document.createElement('i');
    userIcon.className = 'fa-solid fa-user';
    userIcon.style.fontSize = '10px';
    userIcon.style.marginRight = '4px';
    ownerDiv.appendChild(userIcon);
    ownerDiv.appendChild(document.createTextNode(device.owner_name || '—'));

    // Coords
    const coordsDiv = document.createElement('div');
    coordsDiv.className = 'device-card-coords';
    coordsDiv.textContent = `${lat}, ${lng}`;

    // Footer
    const footer = document.createElement('div');
    footer.className = 'device-card-footer';

    const lastSeenSpan = document.createElement('span');
    lastSeenSpan.className = 'device-card-lastseen';
    const clockIcon = document.createElement('i');
    clockIcon.className = 'fa-solid fa-clock';
    clockIcon.style.fontSize = '9px';
    clockIcon.style.marginRight = '3px';
    lastSeenSpan.appendChild(clockIcon);
    lastSeenSpan.appendChild(document.createTextNode(lastSeen));
    footer.appendChild(lastSeenSpan);

    if (device.alert_count_24h > 0) {
        const alertSpan = document.createElement('span');
        alertSpan.className = 'status-badge badge-revoked';
        const alertIcon = document.createElement('i');
        alertIcon.className = 'fa-solid fa-triangle-exclamation';
        alertSpan.appendChild(alertIcon);
        alertSpan.appendChild(document.createTextNode(` ${device.alert_count_24h}`));
        footer.appendChild(alertSpan);
    }

    card.appendChild(header);
    card.appendChild(ownerDiv);
    card.appendChild(coordsDiv);
    card.appendChild(footer);

    card.addEventListener('click', () => selectDevice(device));
    return card;
}

function selectDevice(device) {
    selectedDevice = device;
    renderDeviceList(); // re-render to update selected highlight
    renderDetailPanel(device);
    updateMapForDevice(device);
    fetchDeviceHistory(device.device_id);
    mapNoDeviceOverlay.classList.add('hidden');
    enableGeofenceForm(true);
}

// ── Detail Panel ──────────────────────────────────────────────────────────────
function renderDetailPanel(device) {
    deviceDetailEmpty.classList.add('hidden');
    deviceDetailContent.classList.remove('hidden');

    const status = device.tracking_status || 'REGISTERED';
    deviceStatusBadge.className = `status-badge ${getStatusBadgeClass(status)}`;
    deviceStatusBadge.textContent = status;

    detDeviceName.textContent  = device.device_name   || '—';
    detOwnerName.textContent   = device.owner_name    || '—';
    detDeviceModel.textContent = device.device_model  || '—';
    detDeviceOS.textContent    = device.operating_system || '—';

    const hasLocation = device.latitude != null && device.longitude != null;
    detLatitude.textContent  = hasLocation ? device.latitude.toFixed(6) + '°' : '—';
    detLongitude.textContent = hasLocation ? device.longitude.toFixed(6) + '°' : '—';
    detAccuracy.textContent  = device.accuracy != null ? `±${Math.round(device.accuracy)} m` : '—';
    detLastSeen.textContent  = device.last_updated ? formatRelative(device.last_updated) : 'Never';
    detAlerts.textContent    = device.alert_count_24h || 0;

    // Update Google Maps Pinpoint link dynamically
    if (detGoogleMapsLink) {
        if (hasLocation) {
            detGoogleMapsLink.href = `https://www.google.com/maps/search/?api=1&query=${device.latitude},${device.longitude}`;
            detGoogleMapsLink.style.opacity = '1';
            detGoogleMapsLink.style.pointerEvents = 'auto';
            detGoogleMapsLink.style.cursor = 'pointer';
        } else {
            detGoogleMapsLink.href = '#';
            detGoogleMapsLink.style.opacity = '0.4';
            detGoogleMapsLink.style.pointerEvents = 'none';
            detGoogleMapsLink.style.cursor = 'default';
        }
    }

    // Geofence status
    if (device.geofence) {
        const gf = device.geofence;
        geofenceStatusText.textContent = gf.is_inside
            ? `Inside geofence (r=${gf.radius_meters}m)`
            : `⚠ OUTSIDE geofence (r=${gf.radius_meters}m)`;
        geofenceStatusText.style.color = gf.is_inside ? 'var(--green)' : 'var(--red)';

        // Pre-fill geofence form
        gfCenterLat.value = gf.center_lat;
        gfCenterLng.value = gf.center_lng;
        gfRadius.value = gf.radius_meters;
        radiusDisplay.textContent = `${gf.radius_meters} m`;
    } else {
        geofenceStatusText.textContent = 'No Active Geofences';
        geofenceStatusText.style.color = '';
    }

    forceLocationBtn.disabled = !device.request_token;
    validateGeofenceForm();
}

// ── Map Update ─────────────────────────────────────────────────────────────────
function updateMapForDevice(device) {
    if (!map) return;
    const hasLocation = device.latitude != null && device.longitude != null;
    if (!hasLocation) {
        showToast("No location data available.", "warning");
        return;
    }

    const lat = device.latitude;
    const lng = device.longitude;
    const latlng = L.latLng(lat, lng);

    // Create/move device marker
    if (!activeMarkers.has(device.device_id)) {
        const icon = L.divIcon({
            className: '',
            html: '<div class="device-marker-icon"></div>',
            iconSize: [16, 16],
            iconAnchor: [8, 8]
        });
        activeMarkers.set(device.device_id, L.marker(latlng, { icon }).addTo(map));
    } else {
        activeMarkers.get(device.device_id).setLatLng(latlng);
    }

    const accuracyText = device.accuracy ? `±${Math.round(device.accuracy)}m` : '';

    const popupContent = document.createElement('div');
    popupContent.style.fontFamily = "'Inter',sans-serif";
    popupContent.style.minWidth = '180px';

    const strong = document.createElement('strong');
    strong.style.color = '#00c3ff';
    strong.style.fontSize = '13px';
    strong.textContent = device.device_name || device.device_id;

    const br = document.createElement('br');

    const ownerSpan = document.createElement('span');
    ownerSpan.style.color = '#8da2bb';
    ownerSpan.style.fontSize = '11px';
    ownerSpan.textContent = device.owner_name || '';

    const br2 = document.createElement('br');

    const infoDiv = document.createElement('div');
    infoDiv.style.marginTop = '8px';
    infoDiv.style.fontSize = '12px';
    infoDiv.style.color = '#e8f0fa';

    const latDiv = document.createElement('div');
    latDiv.appendChild(document.createTextNode('Lat: '));
    const latCode = document.createElement('code');
    latCode.style.color = '#00c3ff';
    latCode.textContent = lat.toFixed(6);
    latDiv.appendChild(latCode);

    const lngDiv = document.createElement('div');
    lngDiv.appendChild(document.createTextNode('Lng: '));
    const lngCode = document.createElement('code');
    lngCode.style.color = '#00c3ff';
    lngCode.textContent = lng.toFixed(6);
    lngDiv.appendChild(lngCode);

    infoDiv.appendChild(latDiv);
    infoDiv.appendChild(lngDiv);

    if (accuracyText) {
        const accDiv = document.createElement('div');
        accDiv.appendChild(document.createTextNode('Accuracy: '));
        const accCode = document.createElement('code');
        accCode.textContent = accuracyText;
        accDiv.appendChild(accCode);
        infoDiv.appendChild(accDiv);
    }

    const timeDiv = document.createElement('div');
    timeDiv.style.color = '#4e6177';
    timeDiv.style.marginTop = '4px';
    timeDiv.style.fontSize = '10px';
    timeDiv.textContent = formatRelative(device.last_updated);
    infoDiv.appendChild(timeDiv);

    popupContent.appendChild(strong);
    popupContent.appendChild(br);
    popupContent.appendChild(ownerSpan);
    popupContent.appendChild(br2);
    popupContent.appendChild(infoDiv);

    activeMarkers.get(device.device_id).bindPopup(popupContent);

    // Geofence circle
    updateGeofenceCircle(device);

    // Pan map smoothly to device
    map.panTo(latlng, { animate: true, duration: 0.5 });
}

function updateGeofenceCircle(device) {
    if (!map) return;
    if (geofenceCircle) { geofenceCircle.remove(); geofenceCircle = null; }
    if (!showGeofence || !device.geofence) return;

    const gf = device.geofence;
    geofenceCircle = L.circle([gf.center_lat, gf.center_lng], {
        radius: gf.radius_meters,
        color: gf.is_inside ? '#00c3ff' : '#ff4444',
        fillColor: gf.is_inside ? '#00c3ff' : '#ff4444',
        fillOpacity: 0.07,
        weight: 1.5,
        dashArray: '6,4'
    }).addTo(map);
}

function updatePath(lat, lng) {
    if (!showPath || !map) return;
    pathPoints.push({ lat, lng });
    if (pathPoints.length > PATH_MAX_POINTS) pathPoints.shift();

    if (pathPolyline) pathPolyline.remove();
    if (pathPoints.length < 2) return;
    pathPolyline = L.polyline(pathPoints.map(p => [p.lat, p.lng]), {
        color: '#00c3ff', weight: 2, opacity: 0.5, dashArray: '4,3'
    }).addTo(map);
}

async function fetchDeviceHistory(deviceId) {
    try {
        const res = await fetch(
            `${BACKEND_URL}/devices/${encodeURIComponent(deviceId)}/locations?limit=50`,
            { headers: { 'Authorization': `Bearer ${jwtToken}` } }
        );
        if (!res.ok) return;
        const data = await res.json();
        pathPoints = (data.locations || []).map(l => ({ lat: l.latitude, lng: l.longitude }));
        if (pathPolyline) { pathPolyline.remove(); pathPolyline = null; }
        if (showPath && pathPoints.length >= 2 && map) {
            pathPolyline = L.polyline(pathPoints.map(p => [p.lat, p.lng]), {
                color: '#00c3ff', weight: 2, opacity: 0.5, dashArray: '4,3'
            }).addTo(map);
        }
    } catch (_) {}
}

function centerOnDevice() {
    if (!map || !selectedDevice || !activeMarkers.has(selectedDevice.device_id)) return;
    map.setView(activeMarkers.get(selectedDevice.device_id).getLatLng(), 16, { animate: true });
}

function togglePath() {
    showPath = !showPath;
    togglePathBtn.classList.toggle('active', showPath);
    if (!showPath && pathPolyline) { pathPolyline.remove(); pathPolyline = null; }
    else if (showPath && pathPoints.length >= 2 && map) {
        pathPolyline = L.polyline(pathPoints.map(p => [p.lat, p.lng]), {
            color: '#00c3ff', weight: 2, opacity: 0.5, dashArray: '4,3'
        }).addTo(map);
    }
}

function toggleGeofenceOverlay() {
    showGeofence = !showGeofence;
    toggleGeofenceBtn.classList.toggle('active', showGeofence);
    if (selectedDevice) updateGeofenceCircle(selectedDevice);
}

// ── Alert Feed ─────────────────────────────────────────────────────────────────
async function fetchAlerts() {
    try {
        const res = await fetch(`${BACKEND_URL}/alerts`, {
            headers: { 'Authorization': `Bearer ${jwtToken}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        const items = data.alerts || [];
        alertCount = items.length;
        alertFeedCount.textContent = alertCount;

        if (items.length === 0) {
            alertFeed.innerHTML = `<div class="dp-empty"><i class="fa-solid fa-check-circle" style="color:var(--green);"></i><p>No alerts</p></div>`;
            return;
        }
        alertFeed.innerHTML = '';
        items.slice(0, 20).forEach(a => {
            const el = document.createElement('div');
            el.className = 'alert-item';
            const ts = a.timestamp || a.created_at || '';
            
            const header = document.createElement('div');
            header.className = 'alert-item-header';
            
            const typeSpan = document.createElement('span');
            typeSpan.className = 'alert-item-type';
            typeSpan.textContent = a.type || 'ALERT';
            
            const timeSpan = document.createElement('span');
            timeSpan.className = 'alert-item-time';
            timeSpan.textContent = ts ? formatRelative(ts) : '';
            
            header.appendChild(typeSpan);
            header.appendChild(timeSpan);
            
            const msgDiv = document.createElement('div');
            msgDiv.className = 'alert-item-msg';
            msgDiv.textContent = a.message || `Device: ${a.device_id}`;
            
            el.appendChild(header);
            el.appendChild(msgDiv);
            alertFeed.appendChild(el);
        });
    } catch (_) {}
}

// ── Geofence ──────────────────────────────────────────────────────────────────
function enableGeofenceForm(enabled) {
    setGeofenceBtn.disabled = !enabled;
    useDevicePosBtn.disabled = !enabled;
    validateGeofenceForm();
}

function validateGeofenceForm() {
    const lat = parseFloat(gfCenterLat.value);
    const lng = parseFloat(gfCenterLng.value);
    const r   = parseFloat(gfRadius.value);
    setGeofenceBtn.disabled = !(selectedDevice && !isNaN(lat) && !isNaN(lng) && r > 0);
}

function fillDevicePosition() {
    if (!selectedDevice) return;
    if (selectedDevice.latitude != null) {
        gfCenterLat.value = selectedDevice.latitude.toFixed(6);
        gfCenterLng.value = selectedDevice.longitude.toFixed(6);
        validateGeofenceForm();
        showToast('Geofence center set to device position.', 'info');
    } else {
        showToast('Device has no location yet. Cannot set center.', 'warning');
    }
}

async function submitGeofence() {
    if (!selectedDevice) return;
    const lat = parseFloat(gfCenterLat.value);
    const lng = parseFloat(gfCenterLng.value);
    const r   = parseFloat(gfRadius.value);

    setGeofenceBtn.disabled = true;
    setGeofenceBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Arming…';

    try {
        const res = await fetch(`${BACKEND_URL}/geofence`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${jwtToken}`
            },
            body: JSON.stringify({
                device_id: selectedDevice.device_id,
                center_lat: lat,
                center_lng: lng,
                radius_meters: r
            })
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
            showToast('Geofence armed successfully.', 'success');
            // Update local geofence data
            selectedDevice.geofence = {
                center_lat: lat, center_lng: lng, radius_meters: r, is_inside: true
            };
            renderDetailPanel(selectedDevice);
            updateGeofenceCircle(selectedDevice);
        } else {
            showToast(data?.error || 'Failed to set geofence.', 'danger');
        }
    } catch (err) {
        showToast(`Network error: ${err.message}`, 'danger');
    } finally {
        setGeofenceBtn.disabled = false;
        setGeofenceBtn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Arm Geofence';
        validateGeofenceForm();
    }
}

// ── Force Location ─────────────────────────────────────────────────────────────
async function triggerForceLocation() {
    if (!selectedDevice?.request_token) return;
    forceLocationBtn.disabled = true;
    forceLocationBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Queuing…';

    try {
        const body = {};
        if (pendingIntervalMs) body.interval_ms = pendingIntervalMs;

        const res = await fetch(
            `${BACKEND_URL}/tracking-requests/${encodeURIComponent(selectedDevice.request_token)}/force-location`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${jwtToken}`
                },
                body: JSON.stringify(body)
            }
        );
        const data = await res.json().catch(() => null);
        if (res.ok) {
            showToast('Force location signal sent. Device will respond within ~60s.', 'success');
            if (pendingIntervalMs) {
                showToast(`Interval change (${formatInterval(pendingIntervalMs)}) queued.`, 'info');
                pendingIntervalMs = null;
            }
        } else {
            showToast(data?.error || 'Failed to queue force location.', 'danger');
        }
    } catch (err) {
        showToast(`Network error: ${err.message}`, 'danger');
    } finally {
        setTimeout(() => {
            forceLocationBtn.disabled = false;
            forceLocationBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Force Location';
        }, 3000);
    }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWebSocket() {
    if (wsConn && wsConn.readyState < 2) return; // already open/connecting
    setWsStatus('CONNECTING', 'ws-disconnected', 'Establishing secure WebSocket tunnel...');

    try {
        wsConn = new WebSocket(`${WS_URL}?token=${encodeURIComponent(jwtToken)}`);
    } catch (e) {
        setWsStatus('ERROR', 'ws-error', `Local handshake or network protocol failure: ${e.message}`);
        scheduleWsReconnect();
        return;
    }

    wsConn.onopen = () => {
        setWsStatus('LIVE', 'ws-connected', 'Real-time WebSocket connection active.');
        // Send heartbeat every 25s
        wsConn._pingTimer = setInterval(() => {
            if (wsConn.readyState === 1) {
                wsConn.send(JSON.stringify({ type: 'ping' }));
            }
        }, 25000);
    };

    wsConn.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch (_) { return; }
        handleWsEvent(msg.event, msg.payload);
    };

    wsConn.onerror = () => {
        setWsStatus('ERROR', 'ws-error', 'Active connection error. Reconnecting...');
    };

    wsConn.onclose = () => {
        clearInterval(wsConn._pingTimer);
        setWsStatus('RECONNECTING', 'ws-disconnected', 'WebSocket connection closed. Retrying link in 5s...');
        scheduleWsReconnect();
    };
}

function scheduleWsReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectWebSocket();
    }, 5000);
}

function disconnectWebSocket() {
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (wsConn) { wsConn.onclose = null; wsConn.close(); wsConn = null; }
    setWsStatus('DISCONNECTED', 'ws-disconnected', 'Session closed manually or authentication expired.');
}

function setWsStatus(text, cls, detail = '') {
    wsStatusBadge.className = `ws-badge ${cls}`;
    wsStatusText.textContent = text;
    wsStatusBadge.title = detail || `AegisTrack WebSocket Status: ${text}`;
}

function handleWsEvent(event, payload) {
    if (!payload) return;

    if (event === 'location_updated') {
        // Update the matching device in allDevices
        const idx = allDevices.findIndex(d => d.device_id === payload.device_id);
        if (idx !== -1) {
            allDevices[idx].latitude        = payload.latitude;
            allDevices[idx].longitude       = payload.longitude;
            allDevices[idx].accuracy        = payload.accuracy;
            allDevices[idx].last_updated    = payload.timestamp;
            allDevices[idx].tracking_status = payload.tracking_status || allDevices[idx].tracking_status;
        }

        if (selectedDevice?.device_id === payload.device_id) {
            selectedDevice.latitude     = payload.latitude;
            selectedDevice.longitude    = payload.longitude;
            selectedDevice.accuracy     = payload.accuracy;
            selectedDevice.last_updated = payload.timestamp;
            renderDetailPanel(selectedDevice);
            updateMapForDevice(selectedDevice);
            updatePath(payload.latitude, payload.longitude);
        }
        
        // Also update activeMarkers
        const latlng = L.latLng(payload.latitude, payload.longitude);
        if (activeMarkers.has(payload.device_id)) {
            activeMarkers.get(payload.device_id).setLatLng(latlng);
        } else {
            fetchDeviceLocations();
        }
        renderDeviceList();
    }

    if (event === 'geofence_alert') {
        const deviceId = payload.device_id;
        // Update device geofence state
        const idx = allDevices.findIndex(d => d.device_id === deviceId);
        if (idx !== -1 && allDevices[idx].geofence) {
            allDevices[idx].geofence.is_inside = false;
            allDevices[idx].alert_count_24h = (allDevices[idx].alert_count_24h || 0) + 1;
        }
        if (selectedDevice?.device_id === deviceId) {
            if (selectedDevice.geofence) selectedDevice.geofence.is_inside = false;
            renderDetailPanel(selectedDevice);
            updateGeofenceCircle(selectedDevice);
        }

        // Show breach toast
        const dist = payload.distance_meters ? `${Math.round(payload.distance_meters)}m outside` : '';
        breachToastMsg.textContent = `Device ${deviceId} has exited the monitored zone. ${dist}`;
        breachToast.classList.remove('hidden');

        // Add to alert feed
        addAlertToFeed({
            type: 'GEOFENCE_BREACH',
            message: `Device ${deviceId} breached geofence — ${dist}`,
            timestamp: payload.timestamp || new Date().toISOString()
        });

        renderDeviceList();
    }

    if (event === 'status_updated') {
        const idx = allDevices.findIndex(d => d.device_id === payload.device_id);
        if (idx !== -1 && payload.status) allDevices[idx].tracking_status = payload.status;
        if (selectedDevice?.device_id === payload.device_id) {
            selectedDevice.tracking_status = payload.status;
            renderDetailPanel(selectedDevice);
        }
        renderDeviceList();
    }
}

function addAlertToFeed(alert) {
    alertCount++;
    alertFeedCount.textContent = alertCount;

    const el = document.createElement('div');
    el.className = 'alert-item';
    
    const header = document.createElement('div');
    header.className = 'alert-item-header';
    
    const typeSpan = document.createElement('span');
    typeSpan.className = 'alert-item-type';
    typeSpan.textContent = alert.type;
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'alert-item-time';
    timeSpan.textContent = alert.timestamp ? formatRelative(alert.timestamp) : 'just now';
    
    header.appendChild(typeSpan);
    header.appendChild(timeSpan);
    
    const msgDiv = document.createElement('div');
    msgDiv.className = 'alert-item-msg';
    msgDiv.textContent = alert.message;
    
    el.appendChild(header);
    el.appendChild(msgDiv);

    // Remove empty state
    const emptyEl = alertFeed.querySelector('.dp-empty');
    if (emptyEl) emptyEl.remove();
    alertFeed.insertBefore(el, alertFeed.firstChild);
}

// ── Poll Timer ────────────────────────────────────────────────────────────────
function startPollTimer() {
    stopPollTimer();
    pollTimer = setInterval(() => {
        fetchDevices(false);
        fetchDeviceLocations();
        fetchAlerts();
    }, POLL_INTERVAL_MS);
}

function stopPollTimer() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('hide');
        setTimeout(() => toast.remove(), 350);
    }, 3000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

function formatRelative(dateStr) {
    if (!dateStr) return '—';
    const diff = Math.round((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 5)    return 'just now';
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
    return new Date(dateStr).toLocaleDateString();
}

function formatInterval(ms) {
    if (ms < 60000)  return `${ms/1000} seconds`;
    if (ms < 3600000) return `${ms/60000} minute${ms/60000 !== 1 ? 's' : ''}`;
    return `${ms/3600000} hour${ms/3600000 !== 1 ? 's' : ''}`;
}

function getStatusBadgeClass(status) {
    if (!status) return 'badge-inactive';
    const s = status.toUpperCase();
    if (s.includes('ACTIVE') || s === 'TRACKING_ACTIVE') return 'badge-active';
    if (s === 'REVOKED') return 'badge-revoked';
    if (s.includes('UNAVAILABLE') || s.includes('ERROR')) return 'badge-revoked';
    if (s.includes('GRANTED') || s === 'LOCATION_GRANTED') return 'badge-active';
    return 'badge-inactive';
}
