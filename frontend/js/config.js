/**
 * AegisTrack - Global Frontend Configuration
 * 
 * This file allows dynamic environment override for production deployments.
 * 
 * LOCAL DEVELOPMENT:
 * - Leave window.BACKEND_URL empty ("") or commented out.
 * - The system will automatically fall back to window.location.hostname on port 5000.
 * 
 * PRODUCTION DEPLOYMENT:
 * - Set window.BACKEND_URL to your deployed production backend URL (e.g., Render, Railway, etc.).
 * - Do NOT include a trailing slash. Example: "https://aegistrack-backend.onrender.com"
 */

const DEFAULT_BACKEND_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? `http://${window.location.hostname}:5000`
    : "https://aegistrack-backend.onrender.com";

window.BACKEND_URL = window.BACKEND_URL || DEFAULT_BACKEND_URL;

const AEGIS_THEME_KEY = 'theme';
const AEGIS_DEFAULT_THEME = 'dark';

function applyTheme(theme) {
    const normalized = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = normalized;
    try {
        localStorage.setItem(AEGIS_THEME_KEY, normalized);
    } catch (error) {
        console.warn('AegisTrack theme persistence failed:', error);
    }
    return normalized;
}

function getTheme() {
    return document.documentElement.dataset.theme || AEGIS_DEFAULT_THEME;
}

function initTheme() {
    const savedTheme = localStorage.getItem(AEGIS_THEME_KEY);
    const initialTheme = savedTheme === 'light' ? 'light' : AEGIS_DEFAULT_THEME;
    applyTheme(initialTheme);
}

window.AegisTheme = {
    init: initTheme,
    getTheme,
    setTheme: applyTheme,
    toggleTheme: () => applyTheme(getTheme() === 'light' ? 'dark' : 'light'),
};

initTheme();

// Optional: Explicitly configure production WebSocket URL if automatic replacement fails
// window.WS_URL = "wss://aegistrack-backend.onrender.com/ws";

