/**
 * AegisTrack // API_KERNEL_DIAGNOSTICS
 * Run this in your browser console (F12) while on any page of the AegisTrack dashboard,
 * or create a temporary .html file with this code inside <script> tags.
 */

const TEST_CONFIG = {
    baseUrl: 'http://10.171.58.245:5000',
    testUser: 'TEST_OP_' + Math.floor(Math.random() * 1000),
    testPass: 'SECURE_ALPHA_123',
    testDeviceId: 'DRONE_NODE_' + Math.floor(Math.random() * 100)
};

async function runDiagnostics() {
    console.log('%c INITIALIZING AegisTrack API DIAGNOSTICS... ', 'background: #00f2ff; color: #000; font-weight: bold;');
    
    let token = '';
    let apiKey = '';

    // 1. TEST REGISTRATION
    try {
        console.log(`[1/5] REGISTERING USER: ${TEST_CONFIG.testUser}...`);
        const regRes = await fetch(`${TEST_CONFIG.baseUrl}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: TEST_CONFIG.testUser, password: TEST_CONFIG.testPass })
        });
        const regData = await regRes.json();
        console.log(regRes.ok ? '✅ REGISTRATION SUCCESS' : '❌ REGISTRATION FAILED: ' + regData.error);
    } catch (e) { console.error('🚫 REGISTRATION CRASH:', e.message); }

    // 2. TEST LOGIN
    try {
        console.log('[2/5] AUTHENTICATING...');
        const logRes = await fetch(`${TEST_CONFIG.baseUrl}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: TEST_CONFIG.testUser, password: TEST_CONFIG.testPass })
        });
        const logData = await logRes.json();
        if (logRes.ok) {
            token = logData.access_token;
            console.log('✅ LOGIN SUCCESS. TOKEN ACQUIRED.');
        } else {
            console.log('❌ LOGIN FAILED: ' + logData.error);
            return;
        }
    } catch (e) { console.error('🚫 LOGIN CRASH:', e.message); return; }

    // 3. TEST DEVICE REGISTRATION
    try {
        console.log(`[3/5] REGISTERING DEVICE: ${TEST_CONFIG.testDeviceId}...`);
        const devRes = await fetch(`${TEST_CONFIG.baseUrl}/devices/register`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ device_id: TEST_CONFIG.testDeviceId })
        });
        const devData = await devRes.json();
        if (devRes.ok) {
            apiKey = devData.api_key;
            console.log('✅ DEVICE REGISTERED. API_KEY:', apiKey);
        } else {
            console.log('❌ DEVICE REG FAILED: ' + devData.error);
        }
    } catch (e) { console.error('🚫 DEVICE REG CRASH:', e.message); }

    // 4. TEST LOCATION BROADCAST
    try {
        console.log('[4/5] BROADCASTING TELEMETRY...');
        const locRes = await fetch(`${TEST_CONFIG.baseUrl}/location`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'X-API-KEY': apiKey
            },
            body: JSON.stringify({ 
                device_id: TEST_CONFIG.testDeviceId,
                latitude: 12.9716,
                longitude: 77.5946,
                accuracy: 5.0,
                timestamp: new Date().toISOString()
            })
        });
        const locData = await locRes.json();
        console.log(locRes.ok ? '✅ TELEMETRY UPLINK OK' : '❌ TELEMETRY FAILED: ' + locData.error);
    } catch (e) { console.error('🚫 TELEMETRY CRASH:', e.message); }

    // 5. TEST DEVICE LISTING
    try {
        console.log('[5/5] RETRIEVING NODE LIST...');
        const listRes = await fetch(`${TEST_CONFIG.baseUrl}/devices`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const listData = await listRes.json();
        if (listRes.ok) {
            console.log(`✅ DISCOVERED ${listData.devices.length} NODES.`);
            console.table(listData.devices);
        } else {
            console.log('❌ LISTING FAILED');
        }
    } catch (e) { console.error('🚫 LISTING CRASH:', e.message); }

    console.log('%c DIAGNOSTICS COMPLETE. ', 'background: #00ff9d; color: #000; font-weight: bold;');
}

runDiagnostics();
