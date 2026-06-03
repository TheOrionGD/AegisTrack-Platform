const BACKEND_HOST = window.location.hostname || 'localhost';
const BACKEND_PROTOCOL = window.location.protocol === 'file:' ? 'http:' : window.location.protocol;
const BACKEND_URL = window.BACKEND_URL || `${BACKEND_PROTOCOL}//${BACKEND_HOST}:5000`;

const requestForm = document.getElementById('trackingRequestForm');
const previewBtn = document.getElementById('previewBtn');
const sendBtn = document.getElementById('sendBtn');
const prevBtn = document.getElementById('prevBtn');
const cancelBtn = document.getElementById('cancelBtn');
const formStep = document.getElementById('formStep');
const reviewStep = document.getElementById('reviewStep');
const stepIndicator1 = document.getElementById('stepIndicator1');
const stepIndicator2 = document.getElementById('stepIndicator2');
const stepIndicator3 = document.getElementById('stepIndicator3');
const closePreview = document.getElementById('closePreview');
const sendPreviewBtn = document.getElementById('sendPreviewBtn');
const copySmsBtn = document.getElementById('copySmsBtn');
const smsPreviewModal = document.getElementById('smsPreviewModal');
const smsPreviewText = document.getElementById('smsPreviewText');
const requestTokenOutput = document.getElementById('requestToken');
const registrationUrlOutput = document.getElementById('registrationUrl');
const smsStatusOutput = document.getElementById('smsStatus');
const deliveryActionsPanel = document.getElementById('deliveryActionsPanel');
const whatsappWebBtn = document.getElementById('whatsappWebBtn');
const whatsappAppBtn = document.getElementById('whatsappAppBtn');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const gmailComposeBtn = document.getElementById('gmailComposeBtn');
const mailtoBtn = document.getElementById('mailtoBtn');
const deliveryPreviewText = document.getElementById('deliveryPreviewText');
const qrCodeImage = document.getElementById('qrCodeImage');
const reviewSummary = document.getElementById('reviewSummary');
const toastContainer = document.getElementById('toastContainer');
const auditLog = document.getElementById('auditLog');

// Consent Delivery Engine element mappings
const tokenElement = document.getElementById('requestToken');
const urlElement = document.getElementById('registrationUrl');
const copyButton = document.getElementById('copyLinkBtn');
const whatsappButton = document.getElementById('whatsappWebBtn');
const gmailButton = document.getElementById('gmailComposeBtn');
const mailButton = document.getElementById('mailtoBtn');
const previewHtmlEmailBtn = document.getElementById('previewHtmlEmailBtn');
const sendHtmlEmailBtn = document.getElementById('sendHtmlEmailBtn');
const htmlEmailPreviewModal = document.getElementById('htmlEmailPreviewModal');
const closeHtmlPreview = document.getElementById('closeHtmlPreview');
const htmlEmailFrame = document.getElementById('htmlEmailFrame');
const btnPreviewDesktop = document.getElementById('btnPreviewDesktop');
const btnPreviewMobile = document.getElementById('btnPreviewMobile');
const smtpDot = document.getElementById('smtpDot');
const smtpText = document.getElementById('smtpText');
const copyRawHtmlBtn = document.getElementById('copyRawHtmlBtn');
const copyRichTextBtn = document.getElementById('copyRichTextBtn');
const sendDirectHtmlBtn = document.getElementById('sendDirectHtmlBtn');
const qrButton = {
    set disabled(val) {
        const qrEl = document.getElementById('qrCodeImage');
        if (qrEl) qrEl.disabled = val;
    },
    get disabled() {
        return false;
    }
};
let currentRequest = null;
let statusInterval = null;

let currentWizardStep = 1;

// Operator auth elements
const operatorUsername = document.getElementById('operatorUsername');
const operatorPassword = document.getElementById('operatorPassword');
const operatorLoginBtn = document.getElementById('operatorLoginBtn');
const operatorLogoutBtn = document.getElementById('operatorLogoutBtn');
const operatorStatus = document.getElementById('operatorStatus');

const inputs = {
    phoneNumber: document.getElementById('phoneNumber'),
    ownerName: document.getElementById('ownerName'),
    trackingPurpose: document.getElementById('trackingPurpose'),
    trackingDuration: document.getElementById('trackingDuration'),
    organizationName: document.getElementById('organizationName'),
    consentExpiry: document.getElementById('consentExpiry'),
    notifyEmail: document.getElementById('notifyEmail')
};

let lastRequest = null;

document.addEventListener('DOMContentLoaded', () => {
    previewBtn.addEventListener('click', handleWizardContinue);
    prevBtn.addEventListener('click', handleWizardBack);
    sendBtn.addEventListener('click', sendTrackingLink);
    cancelBtn.addEventListener('click', resetForm);
    closePreview.addEventListener('click', closeModal);
    sendPreviewBtn.addEventListener('click', sendTrackingLink);
    copySmsBtn.addEventListener('click', copyPreviewText);
    if (whatsappWebBtn) whatsappWebBtn.addEventListener('click', openWhatsAppWeb);
    if (whatsappAppBtn) whatsappAppBtn.addEventListener('click', openWhatsAppApp);
    if (copyLinkBtn) copyLinkBtn.addEventListener('click', copyRegistrationLink);
    if (gmailComposeBtn) gmailComposeBtn.addEventListener('click', openGmailCompose);
    if (mailtoBtn) mailtoBtn.addEventListener('click', openMailClient);
    if (previewHtmlEmailBtn) previewHtmlEmailBtn.addEventListener('click', openHtmlEmailPreview);
    if (sendHtmlEmailBtn) sendHtmlEmailBtn.addEventListener('click', openHtmlEmailPreview);
    if (closeHtmlPreview) closeHtmlPreview.addEventListener('click', closeHtmlEmailPreview);
    if (btnPreviewDesktop) btnPreviewDesktop.addEventListener('click', () => setPreviewSize('desktop'));
    if (btnPreviewMobile) btnPreviewMobile.addEventListener('click', () => setPreviewSize('mobile'));
    if (copyRawHtmlBtn) copyRawHtmlBtn.addEventListener('click', copyRawHtmlContent);
    if (copyRichTextBtn) copyRichTextBtn.addEventListener('click', copyRichEmailText);
    if (sendDirectHtmlBtn) sendDirectHtmlBtn.addEventListener('click', sendDirectHtmlEmail);
    if (operatorLoginBtn) operatorLoginBtn.addEventListener('click', operatorLogin);
    if (operatorLogoutBtn) operatorLogoutBtn.addEventListener('click', operatorLogout);
    
    // Add close button functionality
    document.querySelectorAll('.close-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            resetForm();
        });
    });
    
    setWizardStep(1);
    refreshOperatorState();
});

function generateEnrollmentToken() {
    const array = new Uint8Array(16);
    window.crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('') + '-' + Date.now().toString(36);
}

function buildRegistrationUrl(token) {
    return `${BACKEND_URL.replace(':5000', ':5000')}/register-device/${token}`;
}

function buildMessage(payload) {
    return `MTS Consent Request:\n` +
        `Owner: ${payload.owner_name}\n` +
        `Purpose: ${payload.tracking_purpose}\n` +
        `Duration: ${payload.tracking_duration}\n\n` +
        `Review the secure registration portal and provide consent:\n${payload.registration_url}`;
}

function handleWizardContinue() {
    const payload = collectFormData();
    if (!payload) {
        showAudit('ERROR: Please complete all required fields.');
        showToast('Please fill all required fields before continuing.', 'warning');
        return;
    }

    if (currentWizardStep === 1) {
        populateReview(payload);
        setWizardStep(2);
        return;
    }
}

function handleWizardBack() {
    if (currentWizardStep > 1) {
        setWizardStep(currentWizardStep - 1);
    }
}

function escapeHTML(str) {
    if (!str) return '';
    return str.toString().replace(/[&<>'"]/g, (tag) => {
        if (tag === '&') return '&amp;';
        if (tag === '<') return '&lt;';
        if (tag === '>') return '&gt;';
        if (tag === "'") return '&#39;';
        if (tag === '"') return '&quot;';
        return tag;
    });
}

function populateReview(payload) {
    const previewUrl = buildRegistrationUrl(generateEnrollmentToken());
    
    // Clear reviewSummary securely
    reviewSummary.innerHTML = '';
    
    const rows = [
        { label: 'Owner:', value: payload.owner_name },
        { label: 'Phone:', value: payload.phone_number },
        { label: 'Organization:', value: payload.organization_name },
        { label: 'Purpose:', value: payload.tracking_purpose },
        { label: 'Duration:', value: payload.tracking_duration },
        { label: 'Consent expires:', value: payload.consent_expiry_date || 'Not set' }
    ];
    
    rows.forEach(row => {
        const div = document.createElement('div');
        div.className = 'review-card-row';
        
        const strong = document.createElement('strong');
        strong.textContent = row.label;
        
        const span = document.createTextNode(' ' + row.value);
        
        div.appendChild(strong);
        div.appendChild(span);
        reviewSummary.appendChild(div);
    });
    
    // Preview link row
    const linkDiv = document.createElement('div');
    linkDiv.className = 'review-card-row preview-link';
    
    const linkStrong = document.createElement('strong');
    linkStrong.textContent = 'Preview link: ';
    
    const code = document.createElement('code');
    code.textContent = previewUrl;
    
    linkDiv.appendChild(linkStrong);
    linkDiv.appendChild(code);
    reviewSummary.appendChild(linkDiv);
    
    // Preview note row
    const noteDiv = document.createElement('div');
    noteDiv.className = 'review-card-row preview-note';
    noteDiv.textContent = 'Link is generated when you send the request.';
    reviewSummary.appendChild(noteDiv);
    
    showToast('Review the request before sending.', 'info');
}

function setWizardStep(step) {
    currentWizardStep = step;
    formStep.classList.toggle('hidden', step !== 1);
    reviewStep.classList.toggle('hidden', step !== 2);
    prevBtn.classList.toggle('hidden', step === 1 || step === 3);
    previewBtn.classList.toggle('hidden', step !== 1);
    sendBtn.classList.toggle('hidden', step !== 2);
    stepIndicator1.classList.toggle('active', step === 1);
    stepIndicator2.classList.toggle('active', step === 2);
    stepIndicator3.classList.toggle('active', step === 3);
}

function closeModal() {
    smsPreviewModal.classList.add('hidden');
}

function copyPreviewText() {
    const text = smsPreviewText.textContent.trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        alert('SMS preview copied to clipboard.');
    }).catch(() => {
        alert('Copy failed. Please copy manually.');
    });
}

function collectFormData() {
    const payload = {
        phone_number: inputs.phoneNumber.value.trim(),
        owner_name: inputs.ownerName.value.trim(),
        tracking_purpose: inputs.trackingPurpose.value.trim(),
        tracking_duration: inputs.trackingDuration.value.trim(),
        organization_name: inputs.organizationName.value.trim(),
        consent_expiry_date: inputs.consentExpiry.value
    };

    const missing = Object.entries(payload)
        .filter(([_, value]) => !value)
        .map(([key]) => key);

    if (missing.length > 0) {
        return null;
    }

    if (inputs.notifyEmail) {
        payload.notify_email = inputs.notifyEmail.value.trim();
    }
    return payload;
}

async function sendTrackingLink() {
    const payload = collectFormData();
    if (!payload) {
        showAudit('ERROR: All request fields are required.');
        return;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = 'SENDING...';

    try {
        const headers = { 'Content-Type': 'application/json' };
        const token = localStorage.getItem('access_token');
        if (!token) {
            showAudit('ERROR: Operator authentication required. Please login and try again.');
            return;
        }
        headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch(`${BACKEND_URL}/tracking-requests`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });
        let data = null;
        try {
            data = await response.json();
        } catch (err) {
            // Non-JSON response
            data = null;
        }

        if (response.ok) {
            lastRequest = data;
            console.log("Create Request Response", data);

            // Map token and registrationUrl to the response object exactly as requested
            const responseObj = {
                data: data,
                token: data.token,
                registrationUrl: data.registrationUrl || data.registration_url
            };
            currentRequest = responseObj.data;

            tokenElement.textContent = responseObj.token;
            urlElement.textContent = responseObj.registrationUrl;

            if (copyButton) copyButton.disabled = false;
            if (whatsappButton) whatsappButton.disabled = false;
            if (gmailButton) gmailButton.disabled = false;
            if (mailButton) mailButton.disabled = false;
            if (qrButton) qrButton.disabled = false;
            if (previewHtmlEmailBtn) previewHtmlEmailBtn.disabled = false;
            if (sendHtmlEmailBtn) sendHtmlEmailBtn.disabled = false;

            smsStatusOutput.textContent = data.status || 'LINK_GENERATED';
            smsStatusOutput.style.color = '#00ff88';
            showAudit('TRACKING_REQUEST_CREATED — secure link generated.');
            deliveryActionsPanel.classList.remove('hidden');

            // Message Preview automatically populated
            const ownerName = data.owner_name || inputs.ownerName.value.trim() || '';
            const organization = data.organization_name || inputs.organizationName.value.trim() || '';
            const purpose = data.tracking_purpose || inputs.trackingPurpose.value.trim() || '';
            let duration = data.tracking_duration || inputs.trackingDuration.value.trim() || '';
            if (duration && !duration.toLowerCase().includes('day')) {
                duration = duration + ' days';
            }
            const registrationUrlVal = responseObj.registrationUrl;
            const consentExpiry = data.consent_expiry_date || inputs.consentExpiry.value || '';

            const messageText = `MTS CORE TRACKER

Device Monitoring Consent Request

Hello ${ownerName},

${organization} has requested authorization
to register and monitor a device
associated with this mobile number.

Purpose: ${purpose}
Duration: ${duration}

Tracking will NOT begin unless
you explicitly approve.

To continue:

• Open the registration link:
${registrationUrlVal}

OR

• Scan the QR code displayed below to access the consent portal.

Inside the portal you can:
✓ Review monitoring details
✓ Read the privacy policy
✓ Grant or deny consent
✓ Register your device
✓ Revoke authorization later if desired

This request expires on: ${consentExpiry}
Note: The registration link is active for 7 minutes only.

MTS CORE TRACKER
Consent-Based Device Enrollment System (CDEAS)

Scan QR Code to access:
${BACKEND_URL}/tracking-requests/${data.token}/qr`;

            deliveryPreviewText.textContent = messageText;

            // Generate QR Code dynamically using qrcode.min.js if backend-generated image is not available
            const qrContainer = document.getElementById('qr-container');
            if (qrCodeImage && data.qr_code_data_uri) {
                qrCodeImage.src = data.qr_code_data_uri;
                qrCodeImage.classList.remove('hidden');
                if (qrContainer) {
                    qrContainer.style.setProperty('display', 'none', 'important');
                }
            } else if (typeof QRCode !== 'undefined' && qrContainer) {
                qrContainer.innerHTML = '';
                new QRCode(qrContainer, {
                    text: registrationUrlVal,
                    width: 140,
                    height: 140
                });
                qrContainer.style.display = 'flex';
                if (qrCodeImage) {
                    qrCodeImage.classList.add('hidden');
                }
            }

            showToast('Secure request ready. Choose a delivery method.', 'success');
            setWizardStep(3);
            
            // Log AUDIT event
            createAuditLog({ event: 'CONSENT_LINK_GENERATED', phone_number: payload.phone_number, owner_name: payload.owner_name, token: data.token });
            createAuditLog({ event: 'TRACKING_REQUEST_CREATED', phone_number: payload.phone_number, owner_name: payload.owner_name, token: data.token });

            // Start real-time polling
            startStatusPolling();
        } else {
            const errMsg = (data && (data.error || data.msg || data.message)) ? (data.error || data.msg || data.message) : `HTTP ${response.status}`;
            if (response.status === 401) {
                showAudit(`ERROR: Authentication required. ${errMsg}`);
            } else {
                showAudit(`ERROR: ${errMsg}`);
            }
        }
    } catch (error) {
        showAudit(`ERROR: ${error.message}`);
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Registration Link';
    }
}

function resetForm() {
    requestForm.reset();
    requestTokenOutput.textContent = '--';
    registrationUrlOutput.textContent = '--';
    smsStatusOutput.textContent = 'pending';
    smsStatusOutput.style.color = '';
    deliveryActionsPanel.classList.add('hidden');
    deliveryPreviewText.textContent = '--';
    if (previewHtmlEmailBtn) previewHtmlEmailBtn.disabled = true;
    if (sendHtmlEmailBtn) sendHtmlEmailBtn.disabled = true;
    const qrContainer = document.getElementById('qr-container');
    if (qrContainer) {
        qrContainer.innerHTML = '';
        qrContainer.style.removeProperty('display');
    }
    if (qrCodeImage) {
        qrCodeImage.src = '';
        qrCodeImage.classList.add('hidden');
    }
    if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
    }
    setWizardStep(1);
    showAudit('Request form reset.');
    showToast('Ready for a new consent request.', 'info');
}

function showAudit(message) {
    const timestamp = new Date().toLocaleTimeString();
    auditLog.textContent = `[${timestamp}] ${message}`;
}

function createAuditLog(entry) {
    const token = localStorage.getItem('access_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    fetch(`${BACKEND_URL}/vault/logs`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
            event: entry.event,
            details: entry,
            timestamp: new Date().toISOString()
        })
    }).catch(() => {});
}

async function updateRequestStatus(newStatus) {
    if (!lastRequest || !lastRequest.token) return;
    try {
        const token = localStorage.getItem('access_token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        const response = await fetch(`${BACKEND_URL}/tracking-requests/${lastRequest.token}/status`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ status: newStatus })
        });
        if (response.ok) {
            smsStatusOutput.textContent = newStatus;
            showAudit(`Status updated to: ${newStatus}`);
        }
    } catch (e) {
        console.error("Failed to update status", e);
    }
}

function startStatusPolling() {
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(async () => {
        if (!lastRequest || !lastRequest.token) return;
        try {
            const token = localStorage.getItem('access_token');
            const headers = {};
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            const response = await fetch(`${BACKEND_URL}/tracking-requests/${lastRequest.token}`, {
                headers
            });
            if (response.status === 410) {
                clearInterval(statusInterval);
                if (smsStatusOutput.textContent !== 'TRACKING_ACTIVE') {
                    smsStatusOutput.textContent = 'TRACKING_ACTIVE';
                    showAudit('Status updated in real-time to: TRACKING_ACTIVE (Completed)');
                    if (typeof showToast === 'function') {
                        showToast('Device registration completed successfully! Tracking active.', 'success');
                    }
                }
                return;
            }
            if (response.ok) {
                const data = await response.json();
                if (data && data.status) {
                    if (smsStatusOutput.textContent !== data.status) {
                        smsStatusOutput.textContent = data.status;
                        showAudit(`Status updated in real-time to: ${data.status}`);
                        if (data.status === 'TRACKING_ACTIVE' || data.status === 'REVOKED') {
                            clearInterval(statusInterval);
                        }
                    }
                }
            }
        } catch (e) {
            console.error("Polling failed", e);
        }
    }, 2000);
}

function copyRegistrationLink() {
    const registrationUrl = lastRequest?.registration_url || lastRequest?.registrationUrl;
    if (!registrationUrl) {
        showToast('No registration link available yet.', 'warning');
        return;
    }
    navigator.clipboard.writeText(registrationUrl).then(() => {
        showToast('Registration link copied successfully.', 'success');
        updateRequestStatus('LINK_COPIED');
        createAuditLog({ event: 'CONSENT_LINK_COPIED', phone_number: lastRequest.phone_number || lastRequest.phone, token: lastRequest.token });
    }).catch(() => {
        showToast('Copy failed. Please copy the link manually.', 'danger');
    });
}

function openWhatsAppWeb() {
    const registrationUrl = lastRequest?.registration_url || lastRequest?.registrationUrl;
    if (!registrationUrl) {
        showToast('No registration link available yet.', 'warning');
        return;
    }

    const ownerName = lastRequest.owner_name || lastRequest.owner || '';
    const organization = lastRequest.organization_name || lastRequest.organization || '';

    const message = `MTS CORE TRACKER

Device Monitoring Consent Request

Owner: ${ownerName}
Organization: ${organization}

Please review and approve:

${registrationUrl}

Tracking will not begin without your consent.`.trim();

    window.open('https://wa.me/?text=' + encodeURIComponent(message), '_blank');
    updateRequestStatus('WHATSAPP_OPENED');
    createAuditLog({ event: 'WHATSAPP_SHARE_OPENED', phone_number: lastRequest.phone_number || lastRequest.phone, token: lastRequest.token });
}

function openWhatsAppApp() {
    const registrationUrl = lastRequest?.registration_url || lastRequest?.registrationUrl;
    if (!registrationUrl) {
        showToast('No registration link available yet.', 'warning');
        return;
    }

    const ownerName = lastRequest.owner_name || lastRequest.owner || '';
    const organization = lastRequest.organization_name || lastRequest.organization || '';

    const message = `MTS CORE TRACKER

Device Monitoring Consent Request

Owner: ${ownerName}
Organization: ${organization}

Please review and approve:

${registrationUrl}

Tracking will not begin without your consent.`.trim();

    updateRequestStatus('WHATSAPP_OPENED');
    createAuditLog({ event: 'WHATSAPP_SHARE_OPENED', phone_number: lastRequest.phone_number || lastRequest.phone, token: lastRequest.token });

    try {
        window.location.href = 'whatsapp://send?text=' + encodeURIComponent(message);
    } catch (e) {
        window.open('https://wa.me/?text=' + encodeURIComponent(message), '_blank');
    }
}

function openGmailCompose() {
    const registrationUrl = lastRequest?.registration_url || lastRequest?.registrationUrl;
    if (!registrationUrl) {
        showToast('No registration link available yet.', 'warning');
        return;
    }

    const ownerName = lastRequest.owner_name || lastRequest.owner || '';
    const organization = lastRequest.organization_name || lastRequest.organization || '';
    const purpose = lastRequest.tracking_purpose || '';
    let duration = lastRequest.tracking_duration || '';
    if (duration && !duration.toLowerCase().includes('day')) {
        duration = duration + ' days';
    }
    const consentExpiry = lastRequest.consent_expiry_date || '';
    
    // Set To email recipient from the user's new notify email field, defaulting to empty
    const toEmail = lastRequest.notify_email || '';

    const message = `MTS CORE TRACKER

Device Monitoring Consent Request

From: no-reply@mts.com
To: ${toEmail}

Hello ${ownerName},

${organization} has requested authorization
to register and monitor a device
associated with this mobile number.

Purpose: ${purpose}
Duration: ${duration}

Tracking will NOT begin unless
you explicitly approve.

To continue:

• Open the registration link:
${registrationUrl}

OR

• Scan the QR code displayed below to access the consent portal.

Inside the portal you can:
✓ Review monitoring details
✓ Read the privacy policy
✓ Grant or deny consent
✓ Register your device
✓ Revoke authorization later if desired

This request expires on: ${consentExpiry}
Note: The registration link is active for 7 minutes only.

MTS CORE TRACKER
Consent-Based Device Enrollment System (CDEAS)

Scan QR Code to access:
${BACKEND_URL}/tracking-requests/${lastRequest.token}/qr`.trim();

    const subject = `MTS CORE TRACKER: Device Monitoring Consent Request`;

    // Incorporate To and suggest From for Gmail
    const gmailUrl =
        'https://mail.google.com/mail/?view=cm&fs=1' +
        '&to=' + encodeURIComponent(toEmail) +
        '&from=' + encodeURIComponent('') +
        '&su=' + encodeURIComponent(subject) +
        '&body=' + encodeURIComponent(message);

    window.open(gmailUrl, '_blank');
    updateRequestStatus('EMAIL_OPENED');
    createAuditLog({ event: 'EMAIL_SHARE_OPENED', phone_number: lastRequest.phone_number || lastRequest.phone, token: lastRequest.token });
}

function openMailClient() {
    const registrationUrl = lastRequest?.registration_url || lastRequest?.registrationUrl;
    if (!registrationUrl) {
        showToast('No registration link available yet.', 'warning');
        return;
    }

    const ownerName = lastRequest.owner_name || lastRequest.owner || '';
    const organization = lastRequest.organization_name || lastRequest.organization || '';
    const purpose = lastRequest.tracking_purpose || '';
    let duration = lastRequest.tracking_duration || '';
    if (duration && !duration.toLowerCase().includes('day')) {
        duration = duration + ' days';
    }
    const consentExpiry = lastRequest.consent_expiry_date || '';

    // Set To email recipient from the user's new notify email field, defaulting to empty
    const toEmail = lastRequest.notify_email || '';

    const message = `MTS CORE TRACKER

Device Monitoring Consent Request

From: no-reply@mts.com
To: ${toEmail}

Hello ${ownerName},

${organization} has requested authorization
to register and monitor a device
associated with this mobile number.

Purpose: ${purpose}
Duration: ${duration}

Tracking will NOT begin unless
you explicitly approve.

To continue:

• Open the registration link:
${registrationUrl}

OR

• Scan the QR code displayed below to access the consent portal.

Inside the portal you can:
✓ Review monitoring details
✓ Read the privacy policy
✓ Grant or deny consent
✓ Register your device
✓ Revoke authorization later if desired

This request expires on: ${consentExpiry}
Note: The registration link is active for 7 minutes only.

MTS CORE TRACKER
Consent-Based Device Enrollment System (CDEAS)

Scan QR Code to access:
${BACKEND_URL}/tracking-requests/${lastRequest.token}/qr`.trim();

    const subject = `MTS CORE TRACKER: Device Monitoring Consent Request`;
    const mailtoUrl = `mailto:${toEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;

    window.location.href = mailtoUrl;
    updateRequestStatus('EMAIL_OPENED');
    createAuditLog({ event: 'EMAIL_SHARE_OPENED', phone_number: lastRequest.phone_number || lastRequest.phone, token: lastRequest.token });
}

function showToast(message, type = 'info') {
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

async function operatorLogin() {
    const username = operatorUsername.value && operatorUsername.value.trim();
    const password = operatorPassword.value && operatorPassword.value.trim();
    if (!username || !password) {
        showAudit('ERROR: Username and password are required for operator login.');
        return;
    }
    operatorLoginBtn.disabled = true;
    operatorLoginBtn.textContent = 'AUTHENTICATING...';
    try {
        const res = await fetch(`${BACKEND_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.access_token) {
            localStorage.setItem('access_token', data.access_token);
            operatorStatus.textContent = `Signed in: ${username}`;
            operatorLogoutBtn.classList.remove('hidden');
            operatorLoginBtn.classList.add('hidden');
            const liveLink = document.getElementById('liveMonitorLink');
            if (liveLink) liveLink.classList.remove('hidden');
            showAudit('ACCESS_GRANTED — operator authenticated');
            createAuditLog({ event: 'OPERATOR_LOGIN', operator: username });
        } else {
            const msg = data && (data.error || data.message) ? (data.error || data.message) : `HTTP ${res.status}`;
            showAudit(`ERROR: ${msg}`);
        }
    } catch (err) {
        showAudit(`ERROR: ${err.message}`);
    } finally {
        operatorLoginBtn.disabled = false;
        operatorLoginBtn.textContent = 'Login';
    }
}

function operatorLogout() {
    localStorage.removeItem('access_token');
    operatorStatus.textContent = 'Not signed in';
    operatorLogoutBtn.classList.add('hidden');
    operatorLoginBtn.classList.remove('hidden');
    operatorStatus.classList.remove('signed');
    operatorStatus.classList.add('not-signed');
    const liveLink = document.getElementById('liveMonitorLink');
    if (liveLink) liveLink.classList.add('hidden');
    showAudit('Operator logged out');
}

function refreshOperatorState() {
    const t = localStorage.getItem('access_token');
    const liveLink = document.getElementById('liveMonitorLink');
    if (t) {
        // If already set by login handler, keep username; otherwise show generic
        if (!operatorStatus.textContent || operatorStatus.textContent === 'Not signed in') {
            operatorStatus.textContent = 'Signed in';
        }
        if (operatorLogoutBtn) operatorLogoutBtn.classList.remove('hidden');
        if (operatorLoginBtn) operatorLoginBtn.classList.add('hidden');
        operatorStatus.classList.remove('not-signed');
        operatorStatus.classList.add('signed');
        if (liveLink) liveLink.classList.remove('hidden');
    } else {
        operatorStatus.textContent = 'Not signed in';
        if (operatorLogoutBtn) operatorLogoutBtn.classList.add('hidden');
        if (operatorLoginBtn) operatorLoginBtn.classList.remove('hidden');
        operatorStatus.classList.remove('signed');
        operatorStatus.classList.add('not-signed');
        if (liveLink) liveLink.classList.add('hidden');
    }
}

// PREMIUM HTML CONSENT EMAIL UTILITIES
function openHtmlEmailPreview() {
    if (!lastRequest || (!lastRequest.token && !lastRequest.html_preview)) {
        showToast('No request available for preview.', 'warning');
        return;
    }
    
    // Set SMTP indicator
    const isSmtpConfigured = lastRequest.smtp_configured;
    if (smtpDot && smtpText) {
        if (isSmtpConfigured) {
            smtpDot.style.backgroundColor = '#00ff88'; // green
            smtpText.textContent = 'SMTP mailer is active';
        } else {
            smtpDot.style.backgroundColor = '#ffbb33'; // orange warning
            smtpText.textContent = 'SMTP inactive (Gmail redirect active)';
        }
        
        // Always enable the compose button
        if (sendDirectHtmlBtn) {
            sendDirectHtmlBtn.disabled = false;
            sendDirectHtmlBtn.style.opacity = '1';
            sendDirectHtmlBtn.style.cursor = 'pointer';
            sendDirectHtmlBtn.innerHTML = '<i class="fa-solid fa-envelope"></i> Compose in Gmail';
        }
    }

    // Set preview desktop as active size by default
    setPreviewSize('desktop');

    // Populate frame content
    if (htmlEmailFrame) {
        const doc = htmlEmailFrame.contentDocument || htmlEmailFrame.contentWindow.document;
        doc.open();
        doc.write(lastRequest.html_preview || '<h3>No preview available</h3>');
        doc.close();
    }

    // Open Modal
    if (htmlEmailPreviewModal) {
        htmlEmailPreviewModal.classList.remove('hidden');
    }
    
    createAuditLog({ event: 'EMAIL_PREVIEW_OPENED', phone_number: lastRequest.phone_number || lastRequest.phone, token: lastRequest.token });
}

function closeHtmlEmailPreview() {
    if (htmlEmailPreviewModal) {
        htmlEmailPreviewModal.classList.add('hidden');
    }
}

function setPreviewSize(size) {
    if (!htmlEmailFrame) return;
    if (size === 'desktop') {
        htmlEmailFrame.style.width = '100%';
        btnPreviewDesktop.classList.add('active');
        btnPreviewMobile.classList.remove('active');
    } else {
        htmlEmailFrame.style.width = '375px';
        btnPreviewDesktop.classList.remove('active');
        btnPreviewMobile.classList.add('active');
    }
}

function copyRawHtmlContent() {
    if (!lastRequest || !lastRequest.html_preview) return;
    navigator.clipboard.writeText(lastRequest.html_preview).then(() => {
        showToast('HTML source code copied to clipboard!', 'success');
        createAuditLog({ event: 'EMAIL_HTML_COPIED', phone_number: lastRequest.phone_number || lastRequest.phone, token: lastRequest.token });
    }).catch(() => {
        showToast('Copy failed. Please copy manually.', 'danger');
    });
}

function copyRichEmailText() {
    if (!lastRequest) return;
    
    const ownerName = lastRequest.owner_name || '';
    const organization = lastRequest.organization_name || '';
    const purpose = lastRequest.tracking_purpose || '';
    let duration = lastRequest.tracking_duration || '';
    if (duration && !duration.toLowerCase().includes('day')) {
        duration = duration + ' Days';
    }
    const consentExpiry = lastRequest.consent_expiry_date || '';
    const registrationUrl = lastRequest.registration_url || lastRequest.registrationUrl;

    const emailText = `MTS CORE TRACKER - Device Monitoring Authorization Request

Hello ${ownerName},

A request has been submitted for your review. Tracking will only begin after your explicit approval.

${organization} has requested your authorization to register and monitor a device associated with this mobile number.

REQUEST DETAILS:
• Organization: ${organization}
• Purpose: ${purpose}
• Duration: ${duration}
• Requested By: MTS Operator
• Expires On: ${consentExpiry}

Please review and respond by visiting the registration portal:
${registrationUrl}

What Happens Next?
1. Review monitoring details
2. Read privacy policy
3. Grant or deny consent
4. Register your device
5. Revoke authorization later if needed

SECURITY NOTICE:
Your privacy matters. Tracking will NOT begin automatically. Location monitoring only becomes active after you review and approve the request.

---
MTS CORE TRACKER - Consent-Based Device Enrollment`;

    navigator.clipboard.writeText(emailText).then(() => {
        showToast('Formatted email text copied!', 'success');
        createAuditLog({ event: 'EMAIL_TEXT_COPIED', phone_number: lastRequest.phone_number || lastRequest.phone, token: lastRequest.token });
    }).catch(() => {
        showToast('Copy failed. Please copy manually.', 'danger');
    });
}

async function sendDirectHtmlEmail() {
    if (!lastRequest || !lastRequest.token || !lastRequest.html_preview) {
        showToast('No email template available for copy.', 'warning');
        return;
    }
    
    const toEmail = lastRequest.notify_email || inputs.notifyEmail.value.trim() || '';
    
    // Visually show copy and redirect operation progress
    if (sendDirectHtmlBtn) {
        sendDirectHtmlBtn.disabled = true;
        sendDirectHtmlBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing Gmail...';
    }
    
    try {
        const plainTextFallback = `MTS Device Enrollment Consent Request:\n\nHello ${lastRequest.owner_name || 'Owner'},\n\nA monitoring request has been generated. Please review and respond by visiting the registration portal:\n${lastRequest.registration_url || lastRequest.registrationUrl}`;
        
        // Write the rich-formatted HTML preview to the modern browser clipboard
        const htmlBlob = new Blob([lastRequest.html_preview], { type: 'text/html' });
        const textBlob = new Blob([plainTextFallback], { type: 'text/plain' });
        
        await navigator.clipboard.write([
            new ClipboardItem({
                'text/html': htmlBlob,
                'text/plain': textBlob
            })
        ]);
        
        showToast('HTML Email template copied! Opening Gmail...', 'success');
        
        const subject = `MTS CORE TRACKER: Device Monitoring Consent Request`;
        const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(toEmail)}&su=${encodeURIComponent(subject)}`;
        
        // Open Gmail Compose in a new tab
        setTimeout(() => {
            window.open(gmailUrl, '_blank');
            closeHtmlEmailPreview();
            updateRequestStatus('EMAIL_OPENED');
        }, 1200);
        
    } catch (e) {
        console.warn('Clipboard rich-text copy failed, falling back to plaintext content:', e.message);
        
        // Simple plain text fallback
        const plainTextFallback = `MTS Device Enrollment Consent Request:\n\nHello ${lastRequest.owner_name || 'Owner'},\n\nPlease review and respond by visiting the registration portal:\n${lastRequest.registration_url || lastRequest.registrationUrl}`;
        
        navigator.clipboard.writeText(plainTextFallback).then(() => {
            showToast('Email text copied to clipboard! Opening Gmail...', 'info');
            const subject = `MTS CORE TRACKER: Device Monitoring Consent Request`;
            const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(toEmail)}&su=${encodeURIComponent(subject)}`;
            window.open(gmailUrl, '_blank');
            closeHtmlEmailPreview();
            updateRequestStatus('EMAIL_OPENED');
        }).catch(() => {
            showToast('Failed to copy content automatically. Please copy manually.', 'danger');
        });
    } finally {
        if (sendDirectHtmlBtn) {
            sendDirectHtmlBtn.disabled = false;
            sendDirectHtmlBtn.innerHTML = '<i class="fa-solid fa-envelope"></i> Compose in Gmail';
        }
    }
}
