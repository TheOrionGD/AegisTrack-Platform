/**
 * AegisTrack Operator Portal — Shared JS
 * Sidebar toggle, WS subscription, notification management, auth guard.
 * Included on every operator page.
 */

// ── SHARED SIDEBAR HTML (injected dynamically) ─────────────────
const OPERATOR_SIDEBAR_HTML = `
<div class="sidebar-brand">
    <div class="brand-icon"><i class="fa-solid fa-satellite-dish"></i></div>
    <div>
        <div class="brand-name">AegisTrack</div>
        <div style="font-size:10px;color:var(--text-muted);">Operator Console</div>
    </div>
</div>
<nav class="sidebar-nav">
    <div class="nav-section-label">Main</div>
    <a href="dashboard.html"         class="nav-item" data-page="dashboard">
        <i class="fa-solid fa-gauge-high"></i> Dashboard
    </a>
    <a href="tracking-requests.html" class="nav-item" data-page="tracking-requests">
        <i class="fa-solid fa-paper-plane"></i> Tracking Requests
    </a>
    <a href="live-monitor.html"      class="nav-item" data-page="live-monitor">
        <i class="fa-solid fa-map-location-dot"></i> Live Monitor
    </a>
    <div class="nav-section-label">Manage</div>
    <a href="owners.html"   class="nav-item" data-page="owners">
        <i class="fa-solid fa-users"></i> Owners
    </a>
    <a href="devices.html"  class="nav-item" data-page="devices">
        <i class="fa-solid fa-mobile-screen-button"></i> Devices
    </a>
    <a href="geofences.html" class="nav-item" data-page="geofences">
        <i class="fa-solid fa-draw-polygon"></i> Geofences
    </a>
    <div class="nav-section-label">Intelligence</div>
    <a href="communications.html" class="nav-item" data-page="communications">
        <i class="fa-solid fa-comments"></i> Communications
        <span class="nav-badge" id="navMsgBadge" style="display:none;">0</span>
    </a>
    <a href="ai-assistant.html" class="nav-item" data-page="ai-assistant">
        <i class="fa-solid fa-robot"></i> AI Assistant
    </a>
    <div class="nav-section-label">Config</div>
    <a href="settings.html" class="nav-item" data-page="settings">
        <i class="fa-solid fa-gear"></i> Settings
    </a>
</nav>
<div class="sidebar-footer">
    <div class="sidebar-user" id="sidebarUserBtn" title="Logout">
        <div class="user-avatar" id="sidebarAvatar">OP</div>
        <div class="user-info">
            <div class="user-name" id="sidebarUserName">Operator</div>
            <div class="user-role" id="sidebarUserRole">Operator</div>
        </div>
        <i class="fa-solid fa-right-from-bracket" style="color:var(--text-muted);font-size:13px;margin-left:auto;"></i>
    </div>
</div>
`;

// ── SHARED TOPBAR HTML ─────────────────────────────────────────
const OPERATOR_TOPBAR_HTML = (title) => `
<div class="topbar-left">
    <button class="hamburger" id="hamburger" aria-label="Toggle sidebar">
        <span></span><span></span><span></span>
    </button>
    <span class="topbar-title">${title}</span>
</div>
<div class="topbar-right">
    <div class="ws-badge ws-connecting" id="wsBadge">
        <span class="ws-dot"></span>
        <span id="wsStatusText">CONNECTING</span>
    </div>
    <button class="topbar-icon-btn" id="notifBtn" title="Notifications">
        <i class="fa-solid fa-bell"></i>
        <span class="notif-badge hidden" id="notifBadge"></span>
    </button>
    <div class="topbar-icon-btn" id="topbarAvatar" title="Logged in as operator"
         style="background:linear-gradient(135deg,var(--accent-green),var(--accent-cyan));color:var(--text-inverse);font-size:12px;font-weight:700;cursor:default;">
        OP
    </div>
</div>
`;

// ── INIT OPERATOR PORTAL ───────────────────────────────────────
async function initOperatorPortal(pageTitle = 'Dashboard') {
    // Auth guard
    const ok = await AegisAuth.requireRole('OPERATOR');
    if (!ok) return;

    // Inject sidebar
    const sidebarEl = document.getElementById('sidebar');
    if (sidebarEl) sidebarEl.innerHTML = OPERATOR_SIDEBAR_HTML;

    // Inject topbar
    const topbarEl = document.getElementById('topbar');
    if (topbarEl) topbarEl.innerHTML = OPERATOR_TOPBAR_HTML(pageTitle);

    // Mark active nav
    markActiveNav();
    renderUserInfo();
    initSidebar();

    // Logout button
    const logoutBtn = document.getElementById('sidebarUserBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', () => AegisAuth.logout());

    // Connect WS
    AegisWS.connect();

    // WS events
    AegisWS.on('notification', (payload) => {
        showToast(payload.message || 'New notification', 'info');
        updateNotifBadge(1);
    });

    AegisWS.on('message_received', (payload) => {
        const badge = document.getElementById('navMsgBadge');
        if (badge) {
            const cur = parseInt(badge.textContent || '0');
            badge.textContent = cur + 1;
            badge.style.display = '';
        }
    });

    return true;
}

function updateNotifBadge(count) {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
    else           { badge.classList.add('hidden'); }
}

// ── OPERATOR AI ENGINE ─────────────────────────────────────────
const OperatorAI = {
    async respond(query, deviceData) {
        const q = query.toLowerCase();
        let response = '';

        if (q.includes('alert') || q.includes('breach')) {
            response = `Based on the current monitoring session, there are active geofence alerts requiring review. Navigate to Live Monitor → Alert Feed to see real-time breach notifications for all enrolled devices.`;
        } else if (q.includes('report') || q.includes('summar')) {
            const count = deviceData?.length || 0;
            response = `Summary: ${count} device(s) currently enrolled. Tracking active on all consented devices. Recommend reviewing devices with PAUSED status and following up with owners.`;
        } else if (q.includes('risk') || q.includes('danger')) {
            response = `Risk Analysis: Devices outside their last known geofence are flagged as HIGH risk. Review the Alert Feed on the Live Monitor for real-time breach detection. Consider issuing a force-location request for unresponsive devices.`;
        } else if (q.includes('movement') || q.includes('travel') || q.includes('route')) {
            response = `Movement Analysis: Historical location data is available per device in the Live Monitor. Select a device and view the route path to analyse movement patterns over the last 24 hours.`;
        } else if (q.includes('chat') || q.includes('message') || q.includes('owner')) {
            response = `To communicate with a device owner, navigate to Communications → select the owner thread → type your message. Each device has its own conversation thread for precise context.`;
        } else if (q.includes('how many') || q.includes('count') || q.includes('total')) {
            response = `Check the Dashboard KPI cards for real-time counts: Active Devices, Registered Owners, Pending Requests, and Active Alerts — all updated via WebSocket.`;
        } else {
            const defaults = [
                `I can help with: alert summaries, movement analysis, device risk assessment, owner communication guidance, and report generation. What would you like to know?`,
                `Ask me to summarise alerts, analyse a device's movement pattern, assess risk, or generate a monitoring report. I have access to your operator dashboard data.`,
                `Try: "Summarise today's alerts", "Which devices are high risk?", "How do I message a device owner?", or "Generate a movement report".`,
            ];
            response = defaults[Math.floor(Math.random() * defaults.length)];
        }
        return response;
    }
};

window.OperatorAI = OperatorAI;
window.initOperatorPortal = initOperatorPortal;
window.updateNotifBadge   = updateNotifBadge;
