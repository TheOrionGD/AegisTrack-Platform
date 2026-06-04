/**
 * AegisTrack — Centralised RBAC Auth Module
 * Handles login, logout, session management, and route protection.
 */

const AegisAuth = (() => {
    'use strict';

    const KEYS = {
        ACCESS_TOKEN:  'aegis_access_token',
        REFRESH_TOKEN: 'aegis_refresh_token',
        USER_ROLE:     'aegis_user_role',
        USER_IDENTITY: 'aegis_user_identity',
        USER_DATA:     'aegis_user_data',
    };

    function getBackendUrl() {
        return window.BACKEND_URL || "https://aegistrack-backend.onrender.com";
    }

    function getPortalBase() {
        // Compute the path depth to build relative paths correctly
        const path = window.location.pathname;
        if (path.includes('/operator/')) return '../';
        if (path.includes('/owner/'))    return '../';
        if (path.includes('/auth/'))     return '../';
        if (path.includes('/enrollment/')) return '../';
        return './';
    }

    /** Decode a JWT payload without verification (client-side display only) */
    function decodeJwt(token) {
        try {
            const payload = token.split('.')[1];
            const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
            return decoded;
        } catch {
            return null;
        }
    }

    /** Check if a JWT token is expired */
    function isTokenExpired(token) {
        const decoded = decodeJwt(token);
        if (!decoded || !decoded.exp) return true;
        return Date.now() / 1000 >= decoded.exp;
    }

    /** Store session data after a successful login */
    function storeSession(data, role) {
        localStorage.setItem(KEYS.ACCESS_TOKEN,  data.access_token);
        localStorage.setItem(KEYS.REFRESH_TOKEN, data.refresh_token);
        localStorage.setItem(KEYS.USER_ROLE,     role || data.role || 'OPERATOR');
        const decoded = decodeJwt(data.access_token);
        if (decoded) {
            localStorage.setItem(KEYS.USER_IDENTITY, decoded.sub || '');
            localStorage.setItem(KEYS.USER_DATA,     JSON.stringify(decoded));
        }
    }

    /** Attempt silent token refresh */
    async function refreshToken() {
        const refreshTk = localStorage.getItem(KEYS.REFRESH_TOKEN);
        if (!refreshTk) return false;
        try {
            const res = await fetch(`${getBackendUrl()}/auth/refresh`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${refreshTk}`
                }
            });
            if (!res.ok) return false;
            const data = await res.json();
            if (data.access_token) {
                localStorage.setItem(KEYS.ACCESS_TOKEN, data.access_token);
                return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    /** Clear all session data */
    function clearSession() {
        Object.values(KEYS).forEach(k => localStorage.removeItem(k));
        // Also clear legacy keys for backward compat
        ['access_token', 'refresh_token', 'user_role'].forEach(k => localStorage.removeItem(k));
    }

    /** Get the current access token (refreshing if needed) */
    async function getToken() {
        let token = localStorage.getItem(KEYS.ACCESS_TOKEN)
                 || localStorage.getItem('access_token'); // legacy compat
        if (!token) return null;
        if (isTokenExpired(token)) {
            const ok = await refreshToken();
            if (!ok) return null;
            token = localStorage.getItem(KEYS.ACCESS_TOKEN);
        }
        return token;
    }

    /** Synchronously get current user role */
    function getRole() {
        return localStorage.getItem(KEYS.USER_ROLE)
            || localStorage.getItem('user_role') // legacy compat
            || null;
    }

    /** Get decoded user claims from JWT */
    function getUser() {
        const raw = localStorage.getItem(KEYS.USER_DATA);
        if (raw) {
            try { return JSON.parse(raw); } catch { /* fall through */ }
        }
        // Fallback: decode current token
        const token = localStorage.getItem(KEYS.ACCESS_TOKEN);
        if (token) return decodeJwt(token);
        return null;
    }

    /** Get current user's identity (username/email) */
    function getIdentity() {
        return localStorage.getItem(KEYS.USER_IDENTITY) || getUser()?.sub || null;
    }

    function isLoggedIn() {
        const token = localStorage.getItem(KEYS.ACCESS_TOKEN) || localStorage.getItem('access_token');
        return !!token;
    }

    function isOperator() { return getRole() === 'OPERATOR'; }
    function isOwner()    { return getRole() === 'DEVICE_OWNER'; }

    /**
     * Protect a page — redirects if not authenticated or wrong role.
     * @param {string} requiredRole — 'OPERATOR' | 'DEVICE_OWNER' | null (any authenticated user)
     */
    async function requireRole(requiredRole = null) {
        const base = getPortalBase();
        const token = localStorage.getItem(KEYS.ACCESS_TOKEN) || localStorage.getItem('access_token');

        if (!token) {
            window.location.href = `${base}auth/login.html`;
            return false;
        }

        if (isTokenExpired(token)) {
            const ok = await refreshToken();
            if (!ok) {
                clearSession();
                window.location.href = `${base}auth/login.html`;
                return false;
            }
        }

        if (requiredRole) {
            const role = getRole();
            if (role !== requiredRole) {
                // Redirect to correct portal
                if (role === 'OPERATOR') {
                    window.location.href = `${base}operator/dashboard.html`;
                } else if (role === 'DEVICE_OWNER') {
                    window.location.href = `${base}owner/dashboard.html`;
                } else {
                    window.location.href = `${base}auth/login.html`;
                }
                return false;
            }
        }

        return true;
    }

    /**
     * Operator Login
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async function loginOperator(username, password) {
        try {
            const res = await fetch(`${getBackendUrl()}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) return { success: false, error: data.error || 'Login failed' };
            if (data.role !== 'OPERATOR') return { success: false, error: 'Not an operator account' };
            storeSession(data, 'OPERATOR');
            // Also set legacy keys for backward compat with existing JS
            localStorage.setItem('access_token', data.access_token);
            localStorage.setItem('refresh_token', data.refresh_token);
            return { success: true, data };
        } catch (e) {
            return { success: false, error: 'Network error — check server connection' };
        }
    }

    /**
     * Owner Login
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async function loginOwner(email, password) {
        try {
            const res = await fetch(`${getBackendUrl()}/auth/owner-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (!res.ok) return { success: false, error: data.error || 'Login failed' };
            storeSession(data, 'DEVICE_OWNER');
            localStorage.setItem('access_token', data.access_token);
            localStorage.setItem('refresh_token', data.refresh_token);
            return { success: true, data };
        } catch (e) {
            return { success: false, error: 'Network error — check server connection' };
        }
    }

    /** Logout and redirect to login */
    function logout() {
        clearSession();
        const base = getPortalBase();
        window.location.href = `${base}auth/login.html`;
    }

    /** Build the correct redirect URL after login based on role */
    function getPostLoginUrl(role) {
        const base = getPortalBase();
        if (role === 'OPERATOR')     return `${base}operator/dashboard.html`;
        if (role === 'DEVICE_OWNER') return `${base}owner/dashboard.html`;
        return `${base}auth/login.html`;
    }

    // Public API
    return {
        storeSession,
        clearSession,
        getToken,
        getRole,
        getUser,
        getIdentity,
        isLoggedIn,
        isOperator,
        isOwner,
        requireRole,
        loginOperator,
        loginOwner,
        logout,
        getPostLoginUrl,
        decodeJwt,
        KEYS,
    };
})();

// Make globally available
window.AegisAuth = AegisAuth;
