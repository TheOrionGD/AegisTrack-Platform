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

window.BACKEND_URL = "https://aegistrack-backend.onrender.com";

// Optional: Explicitly configure production WebSocket URL if automatic replacement fails
// window.WS_URL = "wss://aegistrack-backend.onrender.com/ws";

