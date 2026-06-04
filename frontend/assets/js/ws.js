/**
 * AegisTrack — WebSocket Manager
 * Auto-reconnect, event subscription, and heartbeat.
 */

const AegisWS = (() => {
    'use strict';

    let ws = null;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let maxReconnectAttempts = 10;
    let reconnectDelay = 1500;
    let isManualClose = false;
    let pingInterval = null;

    const listeners = {}; // event → [handler, ...]
    const statusListeners = []; // (status) => void

    function getWsUrl() {
        if (window.WS_URL) return window.WS_URL;
        const backend = window.BACKEND_URL || `http://${window.location.hostname}:5000`;
        return backend.replace(/^http/, 'ws') + '/ws';
    }

    function notifyStatus(status) {
        statusListeners.forEach(fn => { try { fn(status); } catch {} });
    }

    function updateStatusUI(status) {
        const badge = document.getElementById('wsBadge') || document.getElementById('wsStatusBadge');
        const text  = document.getElementById('wsStatusText');
        if (!badge) return;
        badge.className = badge.className.replace(/ws-\S+/g, '').trim();
        if (status === 'connected') {
            badge.classList.add('ws-connected');
            if (text) text.textContent = 'CONNECTED';
        } else if (status === 'connecting') {
            badge.classList.add('ws-connecting');
            if (text) text.textContent = 'CONNECTING';
        } else {
            badge.classList.add('ws-disconnected');
            if (text) text.textContent = 'OFFLINE';
        }
        notifyStatus(status);
    }

    function startPing() {
        stopPing();
        pingInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
            }
        }, 30000);
    }

    function stopPing() {
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    }

    function connect() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

        isManualClose = false;
        updateStatusUI('connecting');

        const token = localStorage.getItem('aegis_access_token')
                    || localStorage.getItem('access_token') || '';
        const url = `${getWsUrl()}?token=${encodeURIComponent(token)}`;

        try {
            ws = new WebSocket(url);
        } catch (e) {
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            reconnectAttempts = 0;
            reconnectDelay = 1500;
            updateStatusUI('connected');
            startPing();
            // Notify all 'connect' listeners
            (listeners['connect'] || []).forEach(fn => { try { fn(); } catch {} });
        };

        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            const event = msg.event || msg.type;
            const payload = msg.payload || msg.data || msg;
            (listeners[event] || []).forEach(fn => { try { fn(payload); } catch {} });
            (listeners['*'] || []).forEach(fn => { try { fn({ event, payload }); } catch {} });
        };

        ws.onerror = () => {};

        ws.onclose = (ev) => {
            stopPing();
            updateStatusUI('disconnected');
            (listeners['disconnect'] || []).forEach(fn => { try { fn(ev); } catch {} });
            if (!isManualClose) scheduleReconnect();
        };
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        if (reconnectAttempts >= maxReconnectAttempts) {
            updateStatusUI('disconnected');
            return;
        }
        reconnectAttempts++;
        reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, reconnectDelay);
    }

    function disconnect() {
        isManualClose = true;
        stopPing();
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (ws) { ws.close(); ws = null; }
        updateStatusUI('disconnected');
    }

    function send(payload) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify(payload)); return true; } catch { return false; }
        }
        return false;
    }

    /** Subscribe to a WebSocket event */
    function on(event, handler) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(handler);
    }

    /** Unsubscribe from a WebSocket event */
    function off(event, handler) {
        if (!listeners[event]) return;
        listeners[event] = listeners[event].filter(fn => fn !== handler);
    }

    /** Subscribe to connection status changes */
    function onStatus(fn) {
        statusListeners.push(fn);
    }

    function isConnected() {
        return ws && ws.readyState === WebSocket.OPEN;
    }

    return { connect, disconnect, send, on, off, onStatus, isConnected };
})();

window.AegisWS = AegisWS;

/** ── Shared Toast Utility ── */
window.showToast = function(message, type = 'info', duration = 4000) {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const icons = { success: 'fa-check-circle', danger: 'fa-circle-xmark', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 400);
    }, duration);
};

/** ── Shared Avatar Initials ── */
window.getAvatarInitials = function(name) {
    if (!name) return '?';
    const parts = name.trim().split(' ');
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
};

/** ── Time Ago Utility ── */
window.timeAgo = function(timestamp) {
    if (!timestamp) return '—';
    const now = Date.now();
    const date = new Date(timestamp).getTime();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60)     return `${diff}s ago`;
    if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
};

/** ── Format Coordinates ── */
window.formatCoord = function(val, decimals = 6) {
    if (val === null || val === undefined) return '—';
    return Number(val).toFixed(decimals);
};

/** ── Sidebar Toggle (Operator Portal) ── */
window.initSidebar = function() {
    const hamburger = document.getElementById('hamburger');
    const sidebar   = document.getElementById('sidebar');
    const overlay   = document.getElementById('sidebarOverlay');
    if (!hamburger || !sidebar) return;

    function open() { sidebar.classList.add('open'); if(overlay) overlay.classList.add('open'); hamburger.classList.add('open'); }
    function close() { sidebar.classList.remove('open'); if(overlay) overlay.classList.remove('open'); hamburger.classList.remove('open'); }

    hamburger.addEventListener('click', () => sidebar.classList.contains('open') ? close() : open());
    if (overlay) overlay.addEventListener('click', close);
};

/** ── Mark Active Nav Item ── */
window.markActiveNav = function() {
    const currentPage = window.location.pathname.split('/').pop();
    document.querySelectorAll('.nav-item').forEach(item => {
        const href = item.getAttribute('href') || '';
        if (href.endsWith(currentPage)) {
            item.classList.add('active');
        }
    });
};

/** ── Render User Info in Sidebar/Topbar ── */
window.renderUserInfo = function() {
    const user = AegisAuth.getUser();
    const identity = AegisAuth.getIdentity();
    const role = AegisAuth.getRole();
    const displayName = (user?.name) || identity || 'User';
    const initials = getAvatarInitials(displayName);

    // Sidebar user
    const nameEl = document.getElementById('sidebarUserName');
    const roleEl = document.getElementById('sidebarUserRole');
    const avatarEl = document.getElementById('sidebarAvatar');
    if (nameEl) nameEl.textContent = displayName;
    if (roleEl) roleEl.textContent = role === 'OPERATOR' ? 'Operator' : 'Device Owner';
    if (avatarEl) avatarEl.textContent = initials;

    // Topbar
    const topbarAvatar = document.getElementById('topbarAvatar');
    if (topbarAvatar) topbarAvatar.textContent = initials;
};
