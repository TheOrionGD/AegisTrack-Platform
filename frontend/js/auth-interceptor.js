/**
 * MTS AUTH INTERCEPTOR
 * Global fetch wrapper to handle:
 * 1. Automatic header token injection from localStorage
 * 2. Silent JWT token refresh when receiving 401 Unauthorized
 * 3. Queued retrying of failed HTTP requests
 */

(function () {
    'use strict';

    const originalFetch = window.fetch;
    let isRefreshing = false;
    let refreshQueue = [];

    // Helper to get backend URL dynamically
    function getBackendUrl() {
        if (window.BACKEND_URL) return window.BACKEND_URL;
        return `${window.location.protocol === 'file:' ? 'http:' : window.location.protocol}//${window.location.hostname || 'localhost'}:5000`;
    }

    // Perform the refresh token request
    async function executeTokenRefresh() {
        const refreshToken = localStorage.getItem('refresh_token');
        if (!refreshToken) {
            throw new Error('No refresh token available');
        }

        const backendUrl = getBackendUrl();
        const response = await originalFetch(`${backendUrl}/auth/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${refreshToken}`
            }
        });

        if (!response.ok) {
            throw new Error('Refresh request failed');
        }

        const data = await response.json();
        if (!data.access_token) {
            throw new Error('No access token returned');
        }

        // Save new access token
        localStorage.setItem('access_token', data.access_token);
        
        // Also sync any in-memory token variable in global scope if present
        if (typeof window.jwtToken !== 'undefined') {
            window.jwtToken = data.access_token;
        }

        return data.access_token;
    }

    // Global redirect or clean session cleanup on validation failure
    function handleAuthFailure() {
        console.warn('[MTS Auth] Session expired and cannot be refreshed. Redirecting to login.');
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');

        // Check if we are on pages that have auth overlays
        const overlay = document.getElementById('authOverlay');
        const appShell = document.getElementById('monitorApp');
        if (overlay && appShell) {
            overlay.classList.remove('hidden');
            appShell.classList.add('hidden');
            
            // Also stop any dashboard polling to prevent infinite 401 loops
            if (typeof window.stopPollTimer === 'function') {
                window.stopPollTimer();
            }
            if (typeof window.disconnectWebSocket === 'function') {
                window.disconnectWebSocket();
            }
        } else {
            // General page reload to trigger login flows
            const currentPath = window.location.pathname;
            if (currentPath.includes('live-monitor.html') || currentPath.includes('tracking-request.html')) {
                window.location.reload();
            }
        }
    }

    // Overwrite the global fetch function
    window.fetch = async function (resource, config) {
        const backendUrl = getBackendUrl();
        const urlString = typeof resource === 'string' ? resource : (resource.url || '');
        const isBackendRequest = urlString.startsWith('/') || urlString.includes(backendUrl);
        const isAuthRequest = urlString.includes('/auth/login') || urlString.includes('/login') || urlString.includes('/auth/refresh');

        // 1. Swap/Inject fresh token from localStorage into Authorization header for backend requests
        if (isBackendRequest && !isAuthRequest) {
            const token = localStorage.getItem('access_token');
            if (token) {
                config = config || {};
                config.headers = config.headers || {};

                if (config.headers instanceof Headers) {
                    config.headers.set('Authorization', `Bearer ${token}`);
                } else if (Array.isArray(config.headers)) {
                    const authIdx = config.headers.findIndex(([k]) => k.toLowerCase() === 'authorization');
                    if (authIdx !== -1) {
                        config.headers[authIdx][1] = `Bearer ${token}`;
                    } else {
                        config.headers.push(['Authorization', `Bearer ${token}`]);
                    }
                } else {
                    config.headers['Authorization'] = `Bearer ${token}`;
                }
            }
        }

        // 2. Perform the actual fetch request
        let response;
        try {
            response = await originalFetch(resource, config);
        } catch (error) {
            throw error;
        }

        // 3. Handle 410 Gone (Link Expired) specifically for device portal verification
        if (response.status === 410 && urlString.includes('/tracking-requests/')) {
            console.warn('[MTS Info] Link expired (410 Gone)');
            return response;
        }

        // 4. Handle 401 Unauthorized by executing silent refresh
        if (response.status === 401 && isBackendRequest && !isAuthRequest) {
            const refreshToken = localStorage.getItem('refresh_token');
            if (!refreshToken) {
                handleAuthFailure();
                return response;
            }

            if (isRefreshing) {
                // Another request is already refreshing, queue this one
                return new Promise((resolve, reject) => {
                    refreshQueue.push({ resource, config, resolve, reject });
                });
            }

            isRefreshing = true;
            try {
                console.log('[MTS Auth] Access token expired. Executing silent session refresh…');
                const newAccessToken = await executeTokenRefresh();
                isRefreshing = false;

                // Sync the current config headers with the new token
                if (config && config.headers) {
                    if (config.headers instanceof Headers) {
                        config.headers.set('Authorization', `Bearer ${newAccessToken}`);
                    } else if (Array.isArray(config.headers)) {
                        const authIdx = config.headers.findIndex(([k]) => k.toLowerCase() === 'authorization');
                        if (authIdx !== -1) {
                            config.headers[authIdx][1] = `Bearer ${newAccessToken}`;
                        } else {
                            config.headers.push(['Authorization', `Bearer ${newAccessToken}`]);
                        }
                    } else {
                        config.headers['Authorization'] = `Bearer ${newAccessToken}`;
                    }
                }

                // Resolve the current request
                const retryRes = await originalFetch(resource, config);

                // Process queued requests
                const queuedRequests = [...refreshQueue];
                refreshQueue = [];
                for (const req of queuedRequests) {
                    if (req.config && req.config.headers) {
                        if (req.config.headers instanceof Headers) {
                            req.config.headers.set('Authorization', `Bearer ${newAccessToken}`);
                        } else if (Array.isArray(req.config.headers)) {
                            const authIdx = req.config.headers.findIndex(([k]) => k.toLowerCase() === 'authorization');
                            if (authIdx !== -1) {
                                req.config.headers[authIdx][1] = `Bearer ${newAccessToken}`;
                            } else {
                                req.config.headers.push(['Authorization', `Bearer ${newAccessToken}`]);
                            }
                        } else {
                            req.config.headers['Authorization'] = `Bearer ${newAccessToken}`;
                        }
                    }
                    originalFetch(req.resource, req.config).then(req.resolve).catch(req.reject);
                }

                return retryRes;
            } catch (refreshErr) {
                isRefreshing = false;
                refreshQueue = [];
                handleAuthFailure();
                return response;
            }
        }

        return response;
    };
})();
