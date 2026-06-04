const BACKEND_URL = window.BACKEND_URL || 'https://aegistrack-backend.onrender.com';
const queryParams = new URLSearchParams(window.location.search);
let token = queryParams.get('token');
let isStoredSession = false;
let deferredPrompt = null;

// ── Tracking Configuration ────────────────────────────────────────────────────
let LOCATION_UPDATE_INTERVAL_MS = 30000;  // 30 seconds default (continuous production updates)
const LOCATION_MIN_DISTANCE_METERS = 10;   // also send when device moves > 10m
const FORCE_CHECK_INTERVAL_MS = 60000;     // poll for force-location signal every 60s

/**
 * Encodes the five HTML special characters so that any string can be safely
 * interpolated into an innerHTML template without creating an XSS sink.
 * Use this for every untrusted value before insertion into HTML context.
 */
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

// ── DOM references (consent + wizard) ────────────────────────────────────────
const consentState = document.getElementById('consentState');
const tokenBadge = document.getElementById('tokenBadge');
const fingerprintValue = document.getElementById('fingerprintValue');
const browserInfo = document.getElementById('browserInfo');
const registeredAt = document.getElementById('registeredAt');
const revokeBtn = document.getElementById('revokeBtn');
const messageBox = document.getElementById('messageBox');
const policyCheckbox = document.getElementById('policyCheckbox');
const monitorCheckbox = document.getElementById('monitorCheckbox');
const consentCheckbox = document.getElementById('consentCheckbox');
const ownerCheckbox = document.getElementById('ownerCheckbox');
const nextToDetailsBtn = document.getElementById('nextToDetailsBtn');
const backToConsentBtn = document.getElementById('backToConsentBtn');
const nextToConfirmBtn = document.getElementById('nextToConfirmBtn');
const backToDetailsFromConfirmBtn = document.getElementById('backToDetailsFromConfirmBtn');
const confirmBtn = document.getElementById('confirmBtn');
const confirmSummary = document.getElementById('confirmSummary');
const consentStep = document.getElementById('consentStep');
const registrationStep = document.getElementById('registrationStep');
const confirmationStep = document.getElementById('confirmationStep');
const stepIndicators = Array.from(document.querySelectorAll('.registration-stepper .step'));
const registrationSuccessStep = document.getElementById('registrationSuccessStep');
const doneBtn = document.getElementById('doneBtn');
const successTimestamp = document.getElementById('successTimestamp');

const fields = {
    deviceName: document.getElementById('deviceName'),
    deviceModel: document.getElementById('deviceModel'),
    operatingSystem: document.getElementById('operatingSystem'),
    deviceIdentifier: document.getElementById('deviceIdentifier'),
    ownerFullName: document.getElementById('ownerFullName'),
    ownerMobileNumber: document.getElementById('ownerMobileNumber'),
    ownerPassword: document.getElementById('ownerPassword'),
    ownerConfirmPassword: document.getElementById('ownerConfirmPassword'),
    contactEmail: document.getElementById('contactEmail')
};

// ── State ─────────────────────────────────────────────────────────────────────
let registrationStatus = 'PENDING';
let currentFingerprint = 'unknown';
let registeredDeviceId = null;        // set after successful registration
let locationWatchId = null;           // navigator.geolocation.watchPosition handle
let lastSentPosition = null;          // {lat, lon, ts} — throttle reference
let locationUpdateTimer = null;       // interval for force-sends
let forceCheckTimer = null;           // interval for operator force-location polling

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    // Check if we need to resolve token from storage (e.g. when launching from home screen PWA)
    if (!token) {
        token = localStorage.getItem('aegistrack_token');
        if (token) {
            registeredDeviceId = localStorage.getItem('aegistrack_device_id');
            isStoredSession = true;
            console.log('[AegisTrack PWA] Restoring session from localStorage token.');
        }
    }

    if (!token) {
        renderInvalidLink('This registration link is invalid or has expired.');
        return;
    }
    tokenBadge.textContent = token;
    currentFingerprint = buildFingerprint();
    fingerprintValue.textContent = currentFingerprint;
    browserInfo.textContent = navigator.userAgent;

    policyCheckbox.addEventListener('change', updateWizardState);
    monitorCheckbox.addEventListener('change', updateWizardState);
    consentCheckbox.addEventListener('change', updateWizardState);
    ownerCheckbox.addEventListener('change', updateWizardState);
    fields.deviceName.addEventListener('input', updateWizardState);
    fields.deviceModel.addEventListener('input', updateWizardState);
    fields.operatingSystem.addEventListener('input', updateWizardState);
    fields.deviceIdentifier.addEventListener('input', updateWizardState);
    fields.ownerFullName.addEventListener('input', updateWizardState);
    fields.ownerMobileNumber.addEventListener('input', updateWizardState);
    fields.ownerPassword.addEventListener('input', updateWizardState);
    fields.ownerConfirmPassword.addEventListener('input', updateWizardState);

    nextToDetailsBtn.addEventListener('click', () => setWizardStep(2));
    backToConsentBtn.addEventListener('click', () => setWizardStep(1));
    nextToConfirmBtn.addEventListener('click', () => {
        updateConfirmSummary();
        setWizardStep(3);
    });
    backToDetailsFromConfirmBtn.addEventListener('click', () => setWizardStep(2));
    if (confirmBtn) confirmBtn.addEventListener('click', registerDevice);
    if (revokeBtn) revokeBtn.addEventListener('click', revokeConsent);
    if (doneBtn) {
        doneBtn.addEventListener('click', () => {
            setStatus('Enrollment workflow complete. You may close this tab safely.', '#00ff88');
            alert('Device registration and consent workflow completed successfully. You may now close this tab.');
        });
    }

    // Close buttons
    document.querySelectorAll('.close-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            resetRegistration();
        });
    });

    updateWizardState();
    
    if (isStoredSession) {
        validateStoredToken();
    } else {
        validateToken();
    }

    // Register Service Worker for PWA support
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('../sw.js', { scope: '/' })
            .then((reg) => console.log('AegisTrack Service Worker Registered. Scope:', reg.scope))
            .catch((err) => console.warn('AegisTrack Service Worker Registration failed:', err));
    }

    // Bind custom PWA install prompt button
    const installPwaBtn = document.getElementById('installPwaBtn');
    if (installPwaBtn) {
        installPwaBtn.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            // Show the install prompt
            deferredPrompt.prompt();
            // Wait for the user to respond to the prompt
            const { outcome } = await deferredPrompt.userChoice;
            console.log(`[AegisTrack PWA] User response to the install prompt: ${outcome}`);
            deferredPrompt = null;
            // Disable button
            installPwaBtn.disabled = true;
            const pwaInstallStatus = document.getElementById('pwaInstallStatus');
            if (pwaInstallStatus) {
                pwaInstallStatus.textContent = 'App installation triggered.';
                pwaInstallStatus.style.color = '#8da2bb';
            }
        });
    }

    // Initial check of standalone state
    checkPwaInstallationState();
});

// ── Registration Reset ────────────────────────────────────────────────────────
function resetRegistration() {
    Object.values(fields).forEach(field => {
        if (field.type === 'checkbox') field.checked = false;
        else field.value = '';
    });
    setWizardStep(1);
    updateWizardState();
    if (messageBox) messageBox.textContent = 'Registration cancelled. Start over to continue.';
}

// ── Invalid Link ──────────────────────────────────────────────────────────────
function renderInvalidLink(message) {
    const container = document.createElement('div');
    container.className = 'device-container';
    container.style.cssText = 'max-width:480px;margin:40px auto;padding:0 20px;';

    const card = document.createElement('div');
    card.className = 'panel';
    card.style.cssText = 'padding:40px 30px;text-align:center;border:1px solid rgba(255,68,68,0.25);box-shadow:0 12px 40px rgba(0,0,0,0.6), 0 0 30px rgba(255,68,68,0.12);background:#0f1923;border-radius:16px;animation:fadeUp .35s ease;display:block;';

    const iconDiv = document.createElement('div');
    iconDiv.style.cssText = 'font-size:56px;color:#ff4444;margin-bottom:20px;filter:drop-shadow(0 0 12px rgba(255,68,68,0.45));';
    iconDiv.innerHTML = '<i class="fa-solid fa-link-slash"></i>';

    const heading = document.createElement('h2');
    heading.style.cssText = 'color:#e8f0fa;font-size:22px;font-weight:700;margin-bottom:12px;letter-spacing:0.5px;';
    heading.textContent = 'Verification Link Expired';

    const errorPara = document.createElement('p');
    errorPara.style.cssText = 'color:#8da2bb;font-size:14px;line-height:1.6;margin-bottom:24px;';
    errorPara.textContent = message || 'This tracking request link is invalid or has expired.';

    const divider = document.createElement('div');
    divider.style.cssText = 'height:1px;background:rgba(255,255,255,0.06);margin-bottom:20px;';

    const instruction = document.createElement('div');
    instruction.style.cssText = 'color:#ffbb33;font-size:12px;line-height:1.6;margin-bottom:8px;text-align:left;background:rgba(255,187,51,0.05);border:1px solid rgba(255,187,51,0.20);padding:14px 16px;border-radius:10px;';
    instruction.innerHTML = '<strong style="display:block;margin-bottom:4px;"><i class="fa-solid fa-triangle-exclamation"></i> ACTION REQUIRED:</strong> The secure device verification window has expired. Please contact the security operator who generated this tracking request to receive a fresh enrollment link.';

    card.appendChild(iconDiv);
    card.appendChild(heading);
    card.appendChild(errorPara);
    card.appendChild(divider);
    card.appendChild(instruction);
    container.appendChild(card);

    document.body.textContent = '';
    document.body.style.cssText = 'background:radial-gradient(ellipse at 50% 30%, #0d1e35 0%, #060d18 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:\'Inter\',sans-serif;box-sizing:border-box;margin:0;padding:0;';
    document.body.appendChild(container);
}

// ── Token Validation ──────────────────────────────────────────────────────────
async function validateToken() {
    try {
        const response = await fetch(`${BACKEND_URL}/tracking-requests/${encodeURIComponent(token)}`);
        const data = await response.json();
        if (!response.ok) {
            renderInvalidLink(data.error || 'This registration link is invalid or has expired.');
            return;
        }
        if (data.completed) {
            showRegistrationCompleted(data);
            return;
        }
        
        // Prefill form details from DB
        if (fields.ownerFullName && data.owner_name) fields.ownerFullName.value = data.owner_name;
        if (fields.ownerMobileNumber && data.phone_number) fields.ownerMobileNumber.value = data.phone_number;
        if (fields.contactEmail && data.notify_email) fields.contactEmail.value = data.notify_email;
        
        const expires = data.consent_expiry_date ? new Date(data.consent_expiry_date).toLocaleDateString() : 'No expiry set';
        if (messageBox) messageBox.textContent = `Consent link valid for ${data.owner_name}. Expires: ${expires}.`;
        if (consentState) {
            consentState.textContent = 'Pending';
            consentState.style.color = '#ffbb33';
        }
        updateWizardState();
    } catch (error) {
        renderInvalidLink('Unable to verify registration token.');
    }
}

// ── Wizard State ──────────────────────────────────────────────────────────────
function updateWizardState() {
    const consentReady = policyCheckbox.checked && monitorCheckbox.checked && consentCheckbox.checked && ownerCheckbox.checked;
    const requiredFields = [
        fields.deviceName, fields.deviceModel, fields.operatingSystem,
        fields.deviceIdentifier, fields.ownerFullName, fields.ownerMobileNumber, fields.ownerPassword,
        fields.ownerConfirmPassword
    ];
    const allRequiredFilled = requiredFields.every(input => input.value.trim().length > 0);
    const passwordsMatch = fields.ownerPassword.value.trim() === fields.ownerConfirmPassword.value.trim();

    if (fields.ownerPassword.value.trim() && fields.ownerConfirmPassword.value.trim()) {
        if (!passwordsMatch) {
            fields.ownerConfirmPassword.style.borderColor = 'var(--danger, #ff4444)';
            setStatus('Passwords do not match.', '#ff4444');
        } else {
            fields.ownerConfirmPassword.style.borderColor = 'var(--accent, #00ff88)';
            setStatus('Passwords match.', '#00ff88');
        }
    } else {
        fields.ownerConfirmPassword.style.borderColor = '';
    }

    nextToDetailsBtn.disabled = !consentReady;
    nextToConfirmBtn.disabled = !allRequiredFilled || !passwordsMatch;
}

function setWizardStep(step) {
    if (consentStep) consentStep.classList.toggle('hidden', step !== 1);
    if (registrationStep) registrationStep.classList.toggle('hidden', step !== 2);
    if (confirmationStep) confirmationStep.classList.toggle('hidden', step !== 3);
    if (registrationSuccessStep) registrationSuccessStep.classList.toggle('hidden', step !== 4);

    stepIndicators.forEach((item, index) => {
        if (item) {
            item.classList.toggle('active', index + 1 === step);
            item.classList.toggle('completed', index + 1 < step);
        }
    });

    const messages = {
        1: ['Please review the consent agreement before continuing.', '#00f2ff'],
        2: ['Enter your device and owner details to continue.', '#00f2ff'],
        3: ['Review the summary and confirm registration to activate tracking.', '#00ff88'],
        4: ['Registration completed successfully! Requesting location permission...', '#00ff88']
    };
    const stepNum = Number(step);
    if (stepNum >= 1 && stepNum <= 4) {
        setStatus(...messages[stepNum]);
    }
}

// ── Confirm Summary ───────────────────────────────────────────────────────────
function updateConfirmSummary() {
    if (!confirmSummary) return;
    const rows = [
        ['Owner',   fields.ownerFullName.value.trim()     || '\u2014'],
        ['Mobile',  fields.ownerMobileNumber.value.trim() || '\u2014'],
        ['Device',  `${fields.deviceName.value.trim() || '\u2014'} (${fields.deviceModel.value.trim() || '\u2014'})`],
        ['OS / ID', `${fields.operatingSystem.value.trim() || '\u2014'} / ${fields.deviceIdentifier.value.trim() || '\u2014'}`],
        ['Contact', fields.contactEmail.value.trim()      || 'Not provided'],
    ];
    confirmSummary.textContent = '';
    rows.forEach(([label, value]) => {
        const p = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = label + ': ';
        p.appendChild(strong);
        p.appendChild(document.createTextNode(value));
        confirmSummary.appendChild(p);
    });
    const note = document.createElement('p');
    note.className = 'review-note';
    note.textContent = 'Consent is required for monitoring to proceed. You may withdraw at any time.';
    confirmSummary.appendChild(note);
}

// ── Fingerprint ───────────────────────────────────────────────────────────────
function buildFingerprint() {
    const components = [
        navigator.userAgent,
        navigator.platform,
        navigator.language,
        `${screen.width}x${screen.height}`,
        `tz=${Intl.DateTimeFormat().resolvedOptions().timeZone}`
    ];
    return components.join(' | ');
}

// ── Device Registration ───────────────────────────────────────────────────────
async function registerDevice() {
    setStatus('Submitting device consent...', '#00f2ff');
    confirmBtn.disabled = true;

    const payload = {
        token,
        device_name: fields.deviceName.value.trim(),
        device_model: fields.deviceModel.value.trim(),
        operating_system: fields.operatingSystem.value.trim(),
        device_identifier: fields.deviceIdentifier.value.trim(),
        contact_email: fields.contactEmail.value.trim(),
        full_name: fields.ownerFullName.value.trim(),
        mobile_number: fields.ownerMobileNumber.value.trim(),
        password: fields.ownerPassword.value.trim(),
        browser_info: navigator.userAgent,
        fingerprint: currentFingerprint
    };

    try {
        const response = await fetch(`${BACKEND_URL}/device-registrations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (response.ok) {
            registrationStatus = data.tracking_status;
            registeredDeviceId = fields.deviceIdentifier.value.trim();
            console.log('Registration Response', data);

            // Persist registration details for standalone PWA launch
            localStorage.setItem('aegistrack_token', token);
            localStorage.setItem('aegistrack_device_id', registeredDeviceId);
            localStorage.setItem('aegistrack_registered_data', JSON.stringify(data));

            showRegistrationCompleted(data);

            setStatus('Registration complete! Activating location tracking...', '#00ff88');
            if (revokeBtn) revokeBtn.classList.remove('hidden');
            if (confirmBtn) confirmBtn.classList.add('hidden');
            createAuditLog('CONSENT_GRANTED');

            checkGeolocationPermission();
        } else {
            setStatus(`Registration error: ${data.error || 'Unable to complete registration.'}`, '#ff6666');
            if (confirmBtn) confirmBtn.disabled = false;
        }
    } catch (error) {
        setStatus(`Network error: ${error.message}`, '#ff6666');
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

// ── Location Flow ─────────────────────────────────────────────────────────────
/**
 * Modern Geolocation Permission Handler.
 * Detects HTTPS/secure context, queries browser permissions status,
 * and handles UI changes/coordinates retrieval accordingly.
 */
async function checkGeolocationPermission() {
    const gpsCard = document.getElementById('gpsPermissionCard');
    const gpsDeniedCard = document.getElementById('gpsDeniedCard');
    const gpsActiveCard = document.getElementById('gpsActiveCard');

    // Secure context check first
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const isHttps = window.location.protocol === 'https:';
    if (!isHttps && !isLocalhost) {
        showLocationError(
            "Browser geolocation requires HTTPS\nor localhost.\n\nDeploy using HTTPS to enable\nreliable location tracking.",
            gpsCard,
            gpsDeniedCard
        );
        return;
    }

    if (!navigator.permissions || !navigator.permissions.query) {
        // Fallback for iOS/Safari: Instantly trigger browser native prompt
        acquireInitialLocation();
        return;
    }

    try {
        const result = await navigator.permissions.query({ name: 'geolocation' });
        handlePermissionState(result.state);
        result.onchange = () => {
            handlePermissionState(result.state);
        };
    } catch (error) {
        console.warn('navigator.permissions.query failed:', error);
        acquireInitialLocation();
    }
}

/**
 * Handle state logic from navigator.permissions query result
 */
function handlePermissionState(state) {
    const gpsCard = document.getElementById('gpsPermissionCard');
    const gpsDeniedCard = document.getElementById('gpsDeniedCard');
    const gpsActiveCard = document.getElementById('gpsActiveCard');

    if (state === 'granted') {
        if (gpsCard) gpsCard.classList.add('hidden');
        if (gpsDeniedCard) gpsDeniedCard.classList.add('hidden');
        if (gpsActiveCard) gpsActiveCard.classList.remove('hidden');
        acquireInitialLocation();
    } else if (state === 'prompt') {
        // Instantly trigger browser prompt automatically in the background
        acquireInitialLocation();
    } else if (state === 'denied') {
        showLocationError(
            "Location access is currently blocked.\n\nTo activate monitoring:\n\nSettings\n→ Site Permissions\n→ Location\n→ Allow",
            gpsCard,
            gpsDeniedCard
        );
    }
}

/**
 * Display the custom prompt card and bind action buttons.
 */
function handlePermissionPrompt() {
    const gpsCard = document.getElementById('gpsPermissionCard');
    const gpsDeniedCard = document.getElementById('gpsDeniedCard');
    const gpsActiveCard = document.getElementById('gpsActiveCard');

    if (gpsCard) gpsCard.classList.remove('hidden');
    if (gpsDeniedCard) gpsDeniedCard.classList.add('hidden');
    if (gpsActiveCard) gpsActiveCard.classList.add('hidden');

    const descEl = gpsCard ? gpsCard.querySelector('p') : null;
    if (descEl) {
        descEl.style.whiteSpace = 'pre-line';
        descEl.textContent = "AegisTrack requires location access\nto activate live monitoring.\n\nPlease allow location access when prompted.";
    }

    const allowBtn = document.getElementById('allowLocationBtn');
    if (allowBtn) {
        allowBtn.disabled = false;
        allowBtn.innerHTML = '<i class="fa-solid fa-location-dot"></i> Allow Location Access';
        allowBtn.onclick = () => {
            allowBtn.disabled = true;
            allowBtn.textContent = 'Requesting...';
            acquireInitialLocation();
        };
    }

    const retryBtn = document.getElementById('retryLocationBtn');
    if (retryBtn) {
        retryBtn.onclick = () => {
            if (gpsDeniedCard) gpsDeniedCard.classList.add('hidden');
            checkGeolocationPermission();
        };
    }
}

/**
 * Retrieve current user GPS coordinates and trigger active tracking.
 */
function acquireInitialLocation() {
    const gpsCard = document.getElementById('gpsPermissionCard');
    const gpsDeniedCard = document.getElementById('gpsDeniedCard');
    const gpsActiveCard = document.getElementById('gpsActiveCard');

    if (!navigator.geolocation) {
        showLocationError('Your browser does not support geolocation.', gpsCard, gpsDeniedCard);
        return;
    }

    // Instantly prepare visual state for background request
    if (gpsCard) gpsCard.classList.remove('hidden');
    if (gpsDeniedCard) gpsDeniedCard.classList.add('hidden');
    if (gpsActiveCard) gpsActiveCard.classList.add('hidden');

    const descEl = gpsCard ? gpsCard.querySelector('p') : null;
    if (descEl) {
        descEl.style.whiteSpace = 'pre-line';
        descEl.textContent = "AegisTrack is requesting device location...\nPlease check your browser's prompt to allow geolocation access.";
    }

    const allowBtn = document.getElementById('allowLocationBtn');
    if (allowBtn) {
        allowBtn.disabled = true;
        allowBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Requesting GPS Fix...';
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;

            if (lat === 0 && lon === 0) {
                showLocationError('Invalid coordinates (0, 0) received from device GPS.', gpsCard, gpsDeniedCard);
                return;
            }
            if (lat == null || lon == null) {
                showLocationError('Unable to acquire valid GPS coordinates.', gpsCard, gpsDeniedCard);
                return;
            }

            if (gpsCard) gpsCard.classList.add('hidden');
            if (gpsDeniedCard) gpsDeniedCard.classList.add('hidden');
            if (gpsActiveCard) gpsActiveCard.classList.remove('hidden');

            setGpsStatusPill('LOCATION_AVAILABLE', '#00ff88');
            sendLocationUpdate(position);
            startWatchPosition();
        },
        (error) => {
            showLocationError(geoErrorMessage(error), gpsCard, gpsDeniedCard);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
}

/**
 * Convert GeolocationPositionError to a human-friendly message.
 */
function geoErrorMessage(error) {
    switch (error.code) {
        case error.PERMISSION_DENIED:
            return 'Location permission was denied. Please allow location access in your browser settings and try again.';
        case error.POSITION_UNAVAILABLE:
            return 'GPS signal unavailable.\nMove outdoors and try again.';
        case error.TIMEOUT:
            return 'Location request timed out.\nRetrying...';
        default:
            return 'Unable to determine current location.';
    }
}

/**
 * Show the error card with the given message.
 */
function showLocationError(message, gpsCard, gpsDeniedCard) {
    if (gpsCard) gpsCard.classList.add('hidden');
    if (gpsDeniedCard) {
        gpsDeniedCard.classList.remove('hidden');
        const errMsg = document.getElementById('gpsDeniedMessage');
        if (errMsg) {
            errMsg.style.whiteSpace = 'pre-line';
            errMsg.textContent = message;
        }
    }
    setGpsStatusPill('LOCATION_UNAVAILABLE', '#ff6666');
    setStatus('Location permission is required for active tracking.', '#ffbb33');

    // Bind retry button inside denied card
    const retryBtn = document.getElementById('retryLocationBtn');
    if (retryBtn) {
        retryBtn.onclick = () => {
            if (gpsDeniedCard) gpsDeniedCard.classList.add('hidden');
            checkGeolocationPermission();
        };
    }
}

/**
 * Start watchPosition for continuous tracking.
 */
function startWatchPosition() {
    if (locationWatchId !== null) {
        navigator.geolocation.clearWatch(locationWatchId);
    }
    locationWatchId = navigator.geolocation.watchPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;

            if (lat === 0 && lon === 0) return;
            if (lat == null || lon == null) return;

            const now = Date.now();
            if (shouldSendUpdate(position, now)) {
                sendLocationUpdate(position);
            }
        },
        (error) => {
            console.warn('watchPosition error:', geoErrorMessage(error));
            setGpsStatusPill('LOCATION_UNAVAILABLE', '#ff6666');
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );

    // Force-send timer: always send every LOCATION_UPDATE_INTERVAL_MS regardless of movement
    if (locationUpdateTimer) clearInterval(locationUpdateTimer);
    locationUpdateTimer = setInterval(() => {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lon = position.coords.longitude;
                if (lat !== 0 && lon !== 0 && lat != null && lon != null) {
                    sendLocationUpdate(position);
                }
            },
            () => {}, // silent fail on timed forced-update
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    }, LOCATION_UPDATE_INTERVAL_MS);

    // Update on-screen interval display
    updateIntervalDisplay();

    // Start force-location polling (operator can request immediate GPS)
    startForceLocationPolling();
}

/**
 * Determine if we should send an update (moved > 10m OR 30s elapsed).
 */
function shouldSendUpdate(position, now) {
    if (!lastSentPosition) return true;
    const elapsed = now - lastSentPosition.ts;
    if (elapsed >= LOCATION_UPDATE_INTERVAL_MS) return true;
    const dist = haversineJs(
        position.coords.latitude, position.coords.longitude,
        lastSentPosition.lat, lastSentPosition.lon
    );
    return dist >= LOCATION_MIN_DISTANCE_METERS;
}

/**
 * Haversine distance in metres (client-side, JS).
 */
function haversineJs(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * POST location data to /device-location.
 */
async function sendLocationUpdate(position) {
    if (!registeredDeviceId) return;

    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    const acc = position.coords.accuracy;
    const alt = position.coords.altitude;
    const spd = position.coords.speed;
    const hdg = position.coords.heading;
    const ts  = new Date(position.timestamp).toISOString();

    // Update last-sent reference immediately (prevents duplicate sends)
    lastSentPosition = { lat, lon, ts: Date.now() };

    // Update on-screen live coordinates
    updateGpsDisplay(lat, lon, acc, ts);
    setGpsStatusPill('LOCATION_AVAILABLE', '#00ff88');

    try {
        const response = await fetch(`${BACKEND_URL}/device-location`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id: registeredDeviceId,
                token: token,
                latitude: lat,
                longitude: lon,
                accuracy: acc,
                altitude: alt,
                speed: spd,
                heading: hdg,
                timestamp: ts
            })
        });
        const data = await response.json();
        if (!response.ok) {
            console.warn('Location send failed:', data.error);
            if (data.error && data.error.includes('Consent has been revoked')) {
                stopLocationTracking();
                setGpsStatusPill('REVOKED', '#ff4444');
            }
        } else {
            console.log('Location sent:', lat.toFixed(6), lon.toFixed(6), '±', acc?.toFixed(0), 'm');
            if (data.geofence_breach) {
                showGeofenceBreach();
            }
        }
    } catch (err) {
        console.warn('Location POST network error:', err.message);
    }
}

/**
 * Update the live coordinates display on the success panel.
 */
function updateGpsDisplay(lat, lon, acc, ts) {
    const latEl  = document.getElementById('liveLatitude');
    const lonEl  = document.getElementById('liveLongitude');
    const accEl  = document.getElementById('liveAccuracy');
    const lastEl = document.getElementById('liveLastSent');

    if (latEl)  latEl.textContent  = lat.toFixed(6) + '°';
    if (lonEl)  lonEl.textContent  = lon.toFixed(6) + '°';
    if (accEl)  accEl.textContent  = acc ? `${acc.toFixed(0)}m` : '—';
    if (lastEl) {
        const options = { hour: '2-digit', minute: '2-digit', hour12: true };
        lastEl.textContent = new Date(ts).toLocaleTimeString([], options);
    }
}

/**
 * Update the status pill color and label.
 */
function setGpsStatusPill(label, color) {
    const pill = document.getElementById('gpsStatusPill');
    const pillText = document.getElementById('gpsStatusPillText');
    if (pill)  pill.style.borderColor = color;
    if (pillText) {
        pillText.textContent = label;
        pillText.style.color = color;
    }
    // Also update the status-panel consent state
    if (consentState) {
        consentState.textContent = label === 'TRACKING_ACTIVE' || label === 'LOCATION_AVAILABLE' ? 'ACTIVE' : label;
        consentState.style.color = color;
    }
}

/**
 * Flash a geofence breach notification.
 */
function showGeofenceBreach() {
    const breachBanner = document.getElementById('geofenceBreachBanner');
    if (breachBanner) {
        breachBanner.classList.remove('hidden');
        setTimeout(() => breachBanner.classList.add('hidden'), 8000);
    }
}

/**
 * Update the on-screen interval display.
 */
function updateIntervalDisplay() {
    const mins = Math.round(LOCATION_UPDATE_INTERVAL_MS / 60000);
    const secs = Math.round(LOCATION_UPDATE_INTERVAL_MS / 1000);
    const label = mins >= 1 ? `${mins} minute${mins !== 1 ? 's' : ''}` : `${secs} seconds`;
    const intervalEl = document.getElementById('trackingIntervalDisplay');
    if (intervalEl) intervalEl.textContent = `Updating every ${label}. Keep this tab open to maintain tracking.`;
}

/**
 * Poll the backend every 60s to check for operator force-location requests
 * or interval changes.
 */
function startForceLocationPolling() {
    if (forceCheckTimer) clearInterval(forceCheckTimer);
    forceCheckTimer = setInterval(async () => {
        if (!registeredDeviceId) return;
        try {
            const res = await fetch(
                `${BACKEND_URL}/device-location/${encodeURIComponent(registeredDeviceId)}/force-check?token=${encodeURIComponent(token)}`
            );
            if (!res.ok) return;
            const data = await res.json();

            // Operator revoked consent
            if (data.revoked) {
                stopLocationTracking();
                setGpsStatusPill('REVOKED', '#ff4444');
                return;
            }

            // Operator changed update interval
            if (data.interval_ms && data.interval_ms !== LOCATION_UPDATE_INTERVAL_MS) {
                LOCATION_UPDATE_INTERVAL_MS = data.interval_ms;
                // Restart the periodic timer with new interval
                if (locationUpdateTimer) clearInterval(locationUpdateTimer);
                locationUpdateTimer = setInterval(() => {
                    navigator.geolocation.getCurrentPosition(
                        (position) => sendLocationUpdate(position),
                        () => {},
                        { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 }
                    );
                }, LOCATION_UPDATE_INTERVAL_MS);
                updateIntervalDisplay();
                console.log(`[AegisTrack] Update interval changed to ${LOCATION_UPDATE_INTERVAL_MS}ms by operator.`);
            }

            // Operator requested immediate location
            if (data.force) {
                console.log('[AegisTrack] Force location request received from operator. Sending GPS now...');
                navigator.geolocation.getCurrentPosition(
                    (position) => sendLocationUpdate(position),
                    () => {},
                    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
                );
            }
        } catch (err) {
            // Silent: don't interrupt tracking on poll failure
            console.warn('[AegisTrack] Force-check poll failed:', err.message);
        }
    }, FORCE_CHECK_INTERVAL_MS);
}

/**
 * Stop all location tracking (called on consent revoke).
 */
function stopLocationTracking() {
    if (locationWatchId !== null) {
        navigator.geolocation.clearWatch(locationWatchId);
        locationWatchId = null;
    }
    if (locationUpdateTimer) {
        clearInterval(locationUpdateTimer);
        locationUpdateTimer = null;
    }
    if (forceCheckTimer) {
        clearInterval(forceCheckTimer);
        forceCheckTimer = null;
    }
}

// ── Consent Revoke ────────────────────────────────────────────────────────────
async function revokeConsent() {
    setStatus('Revoking tracking authorization...', '#ffbb33');
    stopLocationTracking();
    try {
        const response = await fetch(`${BACKEND_URL}/consent/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        const data = await response.json();
        if (response.ok) {
            // Clear local storage tracking state
            localStorage.removeItem('aegistrack_token');
            localStorage.removeItem('aegistrack_device_id');
            localStorage.removeItem('aegistrack_registered_data');

            if (consentState) {
                consentState.textContent = 'REVOKED';
                consentState.style.color = '#ff4444';
            }
            setStatus('Tracking authorization has been revoked.', '#ff4444');
            if (revokeBtn) revokeBtn.disabled = true;
            setGpsStatusPill('REVOKED', '#ff4444');
            createAuditLog('CONSENT_REVOKED');
        } else {
            setStatus(`Revoke error: ${data.error || 'Unable to revoke consent.'}`, '#ff6666');
        }
    } catch (error) {
        setStatus(`Network error: ${error.message}`, '#ff6666');
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(message, color) {
    if (!messageBox) return;
    messageBox.textContent = message;
    messageBox.style.color = color;
}

function createAuditLog(eventType) {
    const jwtToken = localStorage.getItem('access_token');
    if (!jwtToken) return;
    fetch(`${BACKEND_URL}/vault/logs`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToken}`
        },
        body: JSON.stringify({
            event: eventType,
            device_id: fields.deviceIdentifier.value.trim() || 'unknown',
            token,
            timestamp: new Date().toISOString()
        })
    }).catch(() => {});
}

function showRegistrationCompleted(data) {
    if (consentState) {
        consentState.textContent = 'GRANTED';
        consentState.style.color = '#00ff88';
    }
    const registeredTimestamp = data && (data.registered_at || data.registeredAt);
    const stamp = registeredTimestamp ? new Date(registeredTimestamp).toLocaleString() : new Date().toLocaleString();
    if (registeredAt) registeredAt.textContent = stamp;
    if (successTimestamp) successTimestamp.textContent = stamp;

    // Populate success card
    const successOwnerName = document.getElementById('successOwnerName');
    const successDeviceId = document.getElementById('successDeviceId');
    const successTrackingStatus = document.getElementById('successTrackingStatus');

    if (successOwnerName) successOwnerName.textContent = (data && data.owner_name) || fields.ownerFullName.value.trim() || '—';
    if (successDeviceId) successDeviceId.textContent = (data && data.device_id) || registeredDeviceId || '—';
    if (successTrackingStatus) {
        successTrackingStatus.textContent = (data && data.tracking_status) || registrationStatus || '—';
    }

    setWizardStep(4);
    
    // If completed and tracking is active, show the tracking active card
    const gpsStatusPillText = document.getElementById('gpsStatusPillText');
    const gpsActiveCard = document.getElementById('gpsActiveCard');
    const gpsPermissionCard = document.getElementById('gpsPermissionCard');
    
    if (data && data.completed && (data.tracking_status === 'ACTIVE' || data.tracking_status === 'TRACKING_ACTIVE')) {
        registeredDeviceId = data.device_id || fields.deviceIdentifier.value.trim();
        setGpsStatusPill('LOCATION_AVAILABLE', '#00ff88');
        if (gpsActiveCard) gpsActiveCard.classList.remove('hidden');
        if (gpsPermissionCard) gpsPermissionCard.classList.add('hidden');
        
        // Populate coordinates if they were returned
        const latEl = document.getElementById('liveLatitude');
        const lonEl = document.getElementById('liveLongitude');
        const accEl = document.getElementById('liveAccuracy');
        const lastEl = document.getElementById('liveLastSent');
        
        if (latEl && data.latitude != null) latEl.textContent = data.latitude.toFixed(6) + '°';
        if (lonEl && data.longitude != null) lonEl.textContent = data.longitude.toFixed(6) + '°';
        if (accEl && data.accuracy != null) accEl.textContent = `${data.accuracy.toFixed(0)}m`;
        if (lastEl && data.last_location_timestamp) {
            const options = { hour: '2-digit', minute: '2-digit', hour12: true };
            lastEl.textContent = new Date(data.last_location_timestamp).toLocaleTimeString([], options);
        }

        // Start watchPosition for continuous tracking
        startWatchPosition();
    }
    
    // Check PWA installation state when success step displays
    checkPwaInstallationState();
}

/**
 * Validates a stored token from localStorage.
 * Used for automatic PWA tracking on startup without query params.
 */
async function validateStoredToken() {
    try {
        const response = await fetch(`${BACKEND_URL}/tracking-requests/${encodeURIComponent(token)}`);
        const data = await response.json();
        if (!response.ok) {
            console.warn('[AegisTrack PWA] Stored token is invalid or expired. Cleaning up.');
            localStorage.removeItem('aegistrack_token');
            localStorage.removeItem('aegistrack_device_id');
            localStorage.removeItem('aegistrack_registered_data');
            renderInvalidLink(data.error || 'Your registration has expired or has been revoked.');
            return;
        }
        if (data.completed) {
            console.log('[AegisTrack PWA] Stored token validated. Activating tracking dashboard.');
            showRegistrationCompleted(data);
            if (revokeBtn) revokeBtn.classList.remove('hidden');
            if (confirmBtn) confirmBtn.classList.add('hidden');
            
            // Automatically prompt geolocation permission if needed
            checkGeolocationPermission();
            checkPwaInstallationState();
        } else {
            console.warn('[AegisTrack PWA] Consent request not completed. Restarting enrollment wizard.');
            localStorage.removeItem('aegistrack_token');
            localStorage.removeItem('aegistrack_device_id');
            localStorage.removeItem('aegistrack_registered_data');
            window.location.reload();
        }
    } catch (error) {
        console.warn('[AegisTrack PWA] Offline or backend unreachable, loading cached layout:', error.message);
        const rawData = localStorage.getItem('aegistrack_registered_data');
        if (rawData) {
            try {
                const cachedData = JSON.parse(rawData);
                showRegistrationCompleted(cachedData);
                if (revokeBtn) revokeBtn.classList.remove('hidden');
                if (confirmBtn) confirmBtn.classList.add('hidden');
                
                // Start best-effort offline positioning
                acquireInitialLocation();
                checkPwaInstallationState();
                return;
            } catch (err) {}
        }
        renderInvalidLink('Unable to verify registration status. Please check your internet connection.');
    }
}

/**
 * Queries and updates the PWA-specific UI cards according to display mode and platform.
 */
function checkPwaInstallationState() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    
    const pwaStandaloneBadge = document.getElementById('pwaStandaloneBadge');
    const pwaInstallCard = document.getElementById('pwaInstallCard');
    const pwaIosInstructions = document.getElementById('pwaIosInstructions');
    const pwaAlreadyInstalledCard = document.getElementById('pwaAlreadyInstalledCard');
    
    // Check if device is iOS/Safari
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    if (isStandalone) {
        if (pwaStandaloneBadge) pwaStandaloneBadge.classList.remove('hidden');
        if (pwaInstallCard) pwaInstallCard.classList.add('hidden');
        if (pwaIosInstructions) pwaIosInstructions.classList.add('hidden');
        if (pwaAlreadyInstalledCard) pwaAlreadyInstalledCard.classList.remove('hidden');
    } else {
        if (pwaStandaloneBadge) pwaStandaloneBadge.classList.add('hidden');
        if (isIos) {
            // Show custom iOS guidelines
            if (pwaInstallCard) pwaInstallCard.classList.add('hidden');
            if (pwaIosInstructions) pwaIosInstructions.classList.remove('hidden');
            if (pwaAlreadyInstalledCard) pwaAlreadyInstalledCard.classList.add('hidden');
        } else {
            // Show standard prompt card (Chrome/Android)
            if (pwaInstallCard) pwaInstallCard.classList.remove('hidden');
            if (pwaIosInstructions) pwaIosInstructions.classList.add('hidden');
            if (pwaAlreadyInstalledCard) pwaAlreadyInstalledCard.classList.add('hidden');

            const installPwaBtn = document.getElementById('installPwaBtn');
            const pwaInstallStatus = document.getElementById('pwaInstallStatus');
            
            if (deferredPrompt) {
                if (installPwaBtn) installPwaBtn.disabled = false;
                if (pwaInstallStatus) {
                    pwaInstallStatus.textContent = 'App can be installed on this device.';
                    pwaInstallStatus.style.color = '#00ff88';
                }
            } else {
                if (installPwaBtn) installPwaBtn.disabled = true;
                if (pwaInstallStatus) {
                    pwaInstallStatus.textContent = 'Awaiting app support query...';
                    pwaInstallStatus.style.color = '#8da2bb';
                }
            }
        }
    }
}

/**
 * Show app installed state
 */
function showPwaInstalledState() {
    const pwaInstallCard = document.getElementById('pwaInstallCard');
    const pwaIosInstructions = document.getElementById('pwaIosInstructions');
    const pwaAlreadyInstalledCard = document.getElementById('pwaAlreadyInstalledCard');
    
    if (pwaInstallCard) pwaInstallCard.classList.add('hidden');
    if (pwaIosInstructions) pwaIosInstructions.classList.add('hidden');
    if (pwaAlreadyInstalledCard) pwaAlreadyInstalledCard.classList.remove('hidden');
}

// ── PWA Global Window Event Listeners ─────────────────────────────────────────
window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the mini-infobar from appearing on mobile
    e.preventDefault();
    // Stash the event so it can be triggered later.
    deferredPrompt = e;
    console.log('[AegisTrack PWA] beforeinstallprompt event fired and stored.');
    
    // Check and update buttons
    checkPwaInstallationState();
});

window.addEventListener('appinstalled', (evt) => {
    console.log('[AegisTrack PWA] App was installed successfully.');
    showPwaInstalledState();
});
