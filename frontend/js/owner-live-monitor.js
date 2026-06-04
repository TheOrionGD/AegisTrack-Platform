const BACKEND_URL = window.BACKEND_URL || 'https://aegistrack-backend.onrender.com';
const WS_URL = BACKEND_URL.replace(/^http/, 'ws') + '/ws';

let jwtToken = localStorage.getItem('access_token');
let userRole = localStorage.getItem('user_role');
let ownerDeviceId = localStorage.getItem('owner_device_id');

// Guard Page
if (!jwtToken || userRole !== 'DEVICE_OWNER') {
    window.location.replace('owner-login.html');
}

let map = null;
let marker = null;
let geofenceCircle = null;
let wsConn = null;

document.addEventListener('DOMContentLoaded', () => {
    // Bind DOM elements
    const logoutBtn = document.getElementById('logoutBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    const resumeBtn = document.getElementById('resumeBtn');
    const revokeBtn = document.getElementById('revokeBtn');

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            localStorage.clear();
            window.location.replace('owner-login.html');
        });
    }

    if (pauseBtn) pauseBtn.addEventListener('click', () => updateConsentAction('pause'));
    if (resumeBtn) resumeBtn.addEventListener('click', () => updateConsentAction('resume'));
    if (revokeBtn) {
        revokeBtn.addEventListener('click', () => {
            if (confirm('WARNING: Are you sure you want to completely withdraw consent? Location monitoring will stop immediately and the operator will be notified.')) {
                updateConsentAction('revoke');
            }
        });
    }

    // Initialize Map and Load telemetry
    initMap();
    loadDeviceData();
    connectWebSocket();
});

function initMap() {
    map = L.map('map').setView([0, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);
}

async function loadDeviceData() {
    try {
        const response = await fetch(`${BACKEND_URL}/my-device`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${jwtToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.status === 401 || response.status === 403) {
            localStorage.clear();
            window.location.replace('owner-login.html');
            return;
        }

        const data = await response.json();
        if (response.ok) {
            renderDeviceData(data);
        } else {
            showToast(data.error || 'Failed to load device status.', 'danger');
        }
    } catch (e) {
        showToast('Unable to reach telemetry server.', 'danger');
        console.error(e);
    }
}

function renderDeviceData(data) {
    document.getElementById('ownerName').textContent = data.owner_name || '—';
    document.getElementById('deviceModel').textContent = `${data.device_name || 'Device'} (${data.device_model || '—'})`;
    
    const lastSeenDate = data.last_updated ? new Date(data.last_updated).toLocaleString() : 'Never';
    document.getElementById('lastUpdated').textContent = lastSeenDate;

    // Consent Badge
    const consentBadge = document.getElementById('consentBadge');
    consentBadge.textContent = data.consent_status;
    consentBadge.className = 'status-badge';
    if (data.consent_status === 'GRANTED') {
        consentBadge.classList.add('badge-active');
    } else {
        consentBadge.classList.add('badge-revoked');
    }

    // Tracking Badge
    const trackingBadge = document.getElementById('trackingBadge');
    trackingBadge.textContent = data.tracking_status;
    trackingBadge.className = 'status-badge';
    if (data.tracking_status === 'ACTIVE' || data.tracking_status === 'TRACKING_ACTIVE') {
        trackingBadge.classList.add('badge-active');
    } else if (data.tracking_status === 'PAUSED') {
        trackingBadge.classList.add('badge-paused');
    } else {
        trackingBadge.classList.add('badge-revoked');
    }

    // Position Rendering
    if (data.latitude !== null && data.longitude !== null) {
        const lat = parseFloat(data.latitude);
        const lon = parseFloat(data.longitude);
        const acc = data.accuracy ? ` (±${Math.round(data.accuracy)}m)` : '';
        document.getElementById('currentCoords').textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}${acc}`;

        const pos = [lat, lon];
        map.setView(pos, 16);

        if (!marker) {
            marker = L.marker(pos).addTo(map);
        } else {
            marker.setLatLng(pos);
        }
        marker.bindPopup(`<strong>My Device</strong><br>Last active: ${escapeHTML(lastSeenDate)}`).openPopup();
    } else {
        document.getElementById('currentCoords').textContent = 'No telemetry received';
    }

    // Geofence Rendering
    const geofenceStatus = document.getElementById('geofenceStatus');
    if (data.geofence) {
        const centerLat = parseFloat(data.geofence.center_lat);
        const centerLng = parseFloat(data.geofence.center_lng);
        const radius = parseFloat(data.geofence.radius_meters);
        const inside = data.geofence.is_inside;

        geofenceStatus.textContent = inside ? 'Inside Perimeter' : 'PERIMETER BREACHED';
        geofenceStatus.style.color = inside ? 'var(--accent)' : 'var(--danger)';

        // Draw Geofence on map
        if (geofenceCircle) {
            geofenceCircle.remove();
        }
        geofenceCircle = L.circle([centerLat, centerLng], {
            radius: radius,
            color: inside ? '#00c2ff' : '#ff4444',
            fillColor: inside ? '#00c2ff' : '#ff4444',
            fillOpacity: 0.15
        }).addTo(map);
    } else {
        geofenceStatus.textContent = 'No geofence configured';
        geofenceStatus.style.color = '';
        if (geofenceCircle) {
            geofenceCircle.remove();
            geofenceCircle = null;
        }
    }
}

async function updateConsentAction(action) {
    try {
        const response = await fetch(`${BACKEND_URL}/my-device/consent`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${jwtToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ action })
        });

        const data = await response.json();
        if (response.ok) {
            showToast(data.message, 'success');
            loadDeviceData();
        } else {
            showToast(data.error || 'Failed to update consent.', 'danger');
        }
    } catch (e) {
        showToast('Unable to contact authentication server.', 'danger');
        console.error(e);
    }
}

function connectWebSocket() {
    setWsStatus('CONNECTING', 'ws-disconnected', 'Connecting telemetry tunnel...');
    try {
        wsConn = new WebSocket(`${WS_URL}?token=${encodeURIComponent(jwtToken)}`);

        wsConn.onopen = () => {
            setWsStatus('LIVE', 'ws-connected', 'Real-time WebSocket active.');
        };

        wsConn.onmessage = (e) => {
            try {
                const message = JSON.parse(e.data);
                if (message.event === 'location_updated') {
                    // Update location and reload coordinates
                    loadDeviceData();
                } else if (message.event === 'geofence_alert') {
                    const alertText = `ALERT: Geofence perimeter breached!`;
                    showToast(alertText, 'warning');
                    loadDeviceData();
                } else if (message.event === 'status_updated') {
                    loadDeviceData();
                }
            } catch (err) {
                console.error(err);
            }
        };

        wsConn.onerror = () => {
            setWsStatus('DISCONNECTED', 'ws-disconnected', 'WebSocket error.');
        };

        wsConn.onclose = () => {
            setWsStatus('DISCONNECTED', 'ws-disconnected', 'WebSocket connection closed. Reconnecting in 5s...');
            setTimeout(connectWebSocket, 5000);
        };
    } catch (e) {
        console.error(e);
        setWsStatus('DISCONNECTED', 'ws-disconnected', 'WebSocket failed to start.');
    }
}

function setWsStatus(text, badgeClass, title) {
    const wsStatusBadge = document.getElementById('wsStatusBadge');
    const wsStatusText = document.getElementById('wsStatusText');
    if (wsStatusBadge && wsStatusText) {
        wsStatusBadge.className = `ws-badge ${badgeClass}`;
        wsStatusText.textContent = text;
        wsStatusBadge.title = title;
    }
}

function showToast(message, type = 'info') {
    const toastContainer = document.getElementById('toastContainer');
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('hide');
        setTimeout(() => toast.remove(), 350);
    }, 2800);
}

function escapeHTML(str) {
    if (!str) return '';
    return str.toString().replace(/[&<>'"]/g, (tag) => {
        const chars = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        };
        return chars[tag] || tag;
    });
}
