/**
 * AegisTrack Owner Portal — Shared JS
 * Bottom nav injection, auth guard, device loading, AI engine.
 */

// ── BOTTOM NAV HTML ────────────────────────────────────────────
const OWNER_BOTTOM_NAV_HTML = `
<a href="dashboard.html"          class="bottom-nav-item" data-page="dashboard">
    <i class="fa-solid fa-gauge-high"></i>
    <span>Home</span>
</a>
<a href="live-tracking.html"      class="bottom-nav-item" data-page="live-tracking">
    <i class="fa-solid fa-map-location-dot"></i>
    <span>My Location</span>
</a>
<a href="devices.html"            class="bottom-nav-item" data-page="devices">
    <i class="fa-solid fa-mobile-screen-button"></i>
    <span>Devices</span>
</a>
<a href="chat.html"               class="bottom-nav-item" data-page="chat">
    <i class="fa-solid fa-comments"></i>
    <span>Chat</span>
    <span class="nav-notif hidden" id="chatNavNotif"></span>
</a>
<a href="ai-assistant.html"       class="bottom-nav-item" data-page="ai-assistant">
    <i class="fa-solid fa-robot"></i>
    <span>AI</span>
</a>
`;

// ── OWNER TOPBAR HTML ──────────────────────────────────────────
const OWNER_TOPBAR_HTML = (title) => `
<div class="owner-brand">
    <div class="brand-icon"><i class="fa-solid fa-satellite-dish"></i></div>
    <span class="brand-name" style="font-size:var(--text-base);">AegisTrack</span>
</div>
<div style="font-size:var(--text-sm);font-weight:600;color:var(--text-primary);">${title}</div>
<div style="display:flex;align-items:center;gap:var(--space-3);">
    <div class="ws-badge ws-connecting" id="wsBadge" style="padding:3px 8px;">
        <span class="ws-dot"></span>
    </div>
    <div id="ownerTopbarAvatar" style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--accent-cyan),var(--accent-green));display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--text-inverse);cursor:pointer;" onclick="AegisAuth.logout();" title="Logout">?</div>
</div>
`;

// ── INIT OWNER PORTAL ──────────────────────────────────────────
async function initOwnerPortal(pageTitle = 'My Portal') {
    const ok = await AegisAuth.requireRole('DEVICE_OWNER');
    if (!ok) return false;

    // Inject topbar
    const topbarEl = document.getElementById('ownerTopbar');
    if (topbarEl) topbarEl.innerHTML = OWNER_TOPBAR_HTML(pageTitle);

    // Inject bottom nav
    const bottomNavEl = document.getElementById('bottomNav');
    if (bottomNavEl) bottomNavEl.innerHTML = OWNER_BOTTOM_NAV_HTML;

    // Mark active nav
    const currentPage = window.location.pathname.split('/').pop();
    document.querySelectorAll('.bottom-nav-item').forEach(el => {
        const href = el.getAttribute('href') || '';
        el.classList.toggle('active', href.endsWith(currentPage));
    });

    // Render avatar
    const identity  = AegisAuth.getIdentity() || 'Owner';
    const initials  = getAvatarInitials(identity);
    const avatarEl  = document.getElementById('ownerTopbarAvatar');
    if (avatarEl) avatarEl.textContent = initials;

    // Connect WS
    AegisWS.connect();

    AegisWS.on('message_received', () => {
        const badge = document.getElementById('chatNavNotif');
        if (badge) badge.classList.remove('hidden');
    });

    return true;
}

// ── OWNER AI ENGINE ────────────────────────────────────────────
const OwnerAI = {
    async respond(query, deviceData) {
        const q = query.toLowerCase();
        const device = deviceData?.[0];

        if (q.includes('where') || q.includes('location') || q.includes('position')) {
            if (device?.latitude && device?.longitude) {
                return `Your device (${device.device_id || device.device_name}) is currently at:<br>
                    📍 <strong>${parseFloat(device.latitude).toFixed(6)}° N, ${parseFloat(device.longitude).toFixed(6)}° E</strong><br>
                    Last updated: ${device.timestamp ? timeAgo(device.timestamp) : 'recently'}.
                    <a href="live-tracking.html" style="color:var(--accent-cyan);">View on map →</a>`;
            }
            return `No current location data available for your device. Make sure location sharing is active. <a href="live-tracking.html" style="color:var(--accent-cyan);">Check Live Tracking →</a>`;
        }

        if (q.includes('track') || q.includes('status') || q.includes('active')) {
            const status = device?.tracking_status || device?.status || '—';
            return `Your tracking status is currently: <strong>${status}</strong>.<br>
                You can pause or revoke tracking at any time from the <a href="consent-management.html" style="color:var(--accent-cyan);">Consent Management</a> page.`;
        }

        if (q.includes('pause') || q.includes('stop') || q.includes('disable')) {
            return `To pause tracking, go to <a href="consent-management.html" style="color:var(--accent-cyan);">Consent Management</a> and tap "Pause Tracking". Pausing is temporary and can be resumed anytime.`;
        }

        if (q.includes('revoke') || q.includes('delete') || q.includes('remove')) {
            return `To permanently revoke consent, go to <a href="consent-management.html" style="color:var(--accent-cyan);">Consent Management</a> and tap "Revoke Consent". This will permanently stop all tracking and require a new consent link to re-enroll.`;
        }

        if (q.includes('operator') || q.includes('contact') || q.includes('message')) {
            return `You can send a message to your operator directly from the <a href="chat.html" style="color:var(--accent-cyan);">Chat</a> page. Messages are tied to your specific device for context.`;
        }

        if (q.includes('device') || q.includes('my')) {
            if (device) {
                return `Your registered device: <strong>${device.device_name || device.device_id}</strong><br>Model: ${device.device_model || '—'}<br>OS: ${device.operating_system || '—'}<br>Status: ${device.tracking_status || '—'}`;
            }
            return `View all your registered devices on the <a href="devices.html" style="color:var(--accent-cyan);">Devices</a> page.`;
        }

        const defaults = [
            `I can help you check your location, understand your tracking status, pause/revoke consent, or contact your operator. What would you like to do?`,
            `Try asking: "Where is my device?", "What is my tracking status?", "How do I pause tracking?", or "How do I message my operator?"`,
        ];
        return defaults[Math.floor(Math.random() * defaults.length)];
    }
};

window.OwnerAI = OwnerAI;
window.initOwnerPortal = initOwnerPortal;
