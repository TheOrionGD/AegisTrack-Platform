/**
 * AegisTrack — Centralised API Wrapper
 * Provides named endpoint helpers with automatic token injection,
 * error normalisation, and 401 refresh chaining.
 */

const AegisAPI = (() => {
    'use strict';

    function getBackendUrl() {
        if (window.BACKEND_URL) return window.BACKEND_URL;
        return `http://${window.location.hostname}:5000`;
    }

    async function getAuthHeaders() {
        const token = await AegisAuth.getToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        return headers;
    }

    async function request(method, path, body = null, opts = {}) {
        const url = path.startsWith('http') ? path : `${getBackendUrl()}${path}`;
        const headers = await getAuthHeaders();
        const config = { method, headers, ...opts };
        if (body) config.body = JSON.stringify(body);

        let res;
        try {
            res = await fetch(url, config);
        } catch (e) {
            throw { status: 0, error: 'Network error — server unreachable', raw: e };
        }

        if (res.status === 401) {
            // Token expired — attempt refresh once
            const ok = await AegisAuth.requireRole(null); // will refresh silently
            if (!ok) throw { status: 401, error: 'Session expired' };
            const retryHeaders = await getAuthHeaders();
            const retryConfig = { method, headers: retryHeaders };
            if (body) retryConfig.body = JSON.stringify(body);
            res = await fetch(url, retryConfig);
        }

        let data;
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
            data = await res.json();
        } else {
            data = { message: await res.text() };
        }

        if (!res.ok) {
            throw { status: res.status, error: data.error || data.message || 'Request failed', data };
        }

        return data;
    }

    const get  = (path, opts)       => request('GET',    path, null, opts);
    const post = (path, body, opts)  => request('POST',   path, body, opts);
    const put  = (path, body, opts)  => request('PUT',    path, body, opts);
    const del  = (path, opts)        => request('DELETE', path, null, opts);
    const patch = (path, body, opts) => request('PATCH',  path, body, opts);

    // ── Named Endpoints ────────────────────────────────────────

    const auth = {
        loginOperator: (u, p) => post('/auth/login', { username: u, password: p }),
        loginOwner: (e, p)    => post('/auth/owner-login', { email: e, password: p }),
        refresh: ()           => post('/auth/refresh', null),
        register: (u, p)      => post('/auth/register', { username: u, password: p }),
    };

    const devices = {
        list: ()               => get('/devices'),
        get: (id)              => get(`/devices/${id}`),
        register: (data)       => post('/devices/register', data),
        remove: (id)           => del(`/devices/${id}`),
        pauseTracking: (id)    => post(`/devices/${id}/pause`, {}),
        resumeTracking: (id)   => post(`/devices/${id}/resume`, {}),
        allLocations: ()       => get('/device-locations'),
        forceLocation: (id)    => post(`/devices/${id}/force-location`, {}),
    };

    const tracking = {
        list: ()                => get('/tracking-requests'),
        create: (data)          => post('/tracking-requests', data),
        get: (token)            => get(`/tracking-requests/${token}`),
        revoke: (token)         => post(`/tracking-requests/${token}/revoke`, {}),
        resend: (token)         => post(`/tracking-requests/${token}/resend`, {}),
        verify: (token)         => get(`/tracking-requests/verify/${token}`),
        register: (token, data) => post(`/tracking-requests/${token}/register`, data),
    };

    const locations = {
        latest: (deviceId)      => get(`/locations/${deviceId}`),
        history: (deviceId, n)  => get(`/locations/${deviceId}/history?limit=${n || 50}`),
        update: (deviceId, loc) => post(`/locations/${deviceId}`, loc),
        allLatest: ()           => get('/device-locations'),
    };

    const geofences = {
        get: (deviceId)         => get(`/geofences/${deviceId}`),
        set: (deviceId, data)   => post(`/geofences/${deviceId}`, data),
        clear: (deviceId)       => del(`/geofences/${deviceId}`),
    };

    const alerts = {
        list: (deviceId)        => get(deviceId ? `/alerts?device_id=${deviceId}` : '/alerts'),
        acknowledge: (id)       => post(`/alerts/${id}/acknowledge`, {}),
    };

    const messages = {
        threads: ()                     => get('/messages/threads'),
        getThread: (deviceId)           => get(`/messages/thread/${deviceId}`),
        send: (deviceId, text, role)    => post('/messages/send', { device_id: deviceId, text, role }),
        markRead: (threadId)            => post(`/messages/thread/${threadId}/read`, {}),
    };

    const owner = {
        myDevice: ()                => get('/my-device'),
        myDevices: ()               => get('/my-devices'),
        consent: (action, deviceId) => post('/my-device/consent', { action, device_id: deviceId }),
        dashboard: ()               => get('/owner/dashboard'),
    };

    const dashboard = {
        summary: () => get('/dashboard/summary'),
    };

    const owners = {
        list: ()       => get('/owners'),
        get: (id)      => get(`/owners/${id}`),
        devices: (id)  => get(`/owners/${id}/devices`),
    };

    // ── Utilities ────────────────────────────────────────────

    function formatError(err) {
        if (typeof err === 'string') return err;
        if (err?.error) return err.error;
        if (err?.message) return err.message;
        return 'An unknown error occurred';
    }

    return {
        get, post, put, del, patch,
        auth, devices, tracking, locations,
        geofences, alerts, messages, owner,
        dashboard, owners,
        formatError,
        getBackendUrl,
    };
})();

window.AegisAPI = AegisAPI;
