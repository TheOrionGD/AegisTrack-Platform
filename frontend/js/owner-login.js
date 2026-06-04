const BACKEND_URL = window.BACKEND_URL || 'https://aegistrack-backend.onrender.com';

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('ownerLoginForm');
    const loginBtn = document.getElementById('loginBtn');
    const emailInput = document.getElementById('ownerEmail');
    const passwordInput = document.getElementById('ownerPassword');

    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const email = emailInput.value.trim();
            const password = passwordInput.value.trim();

            if (!email || !password) {
                showToast('Email and password are required.', 'warning');
                return;
            }

            loginBtn.disabled = true;
            loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Authenticating...';

            try {
                const response = await fetch(`${BACKEND_URL}/auth/owner-login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });

                const data = await response.json();

                if (response.ok) {
                    localStorage.setItem('access_token', data.access_token);
                    localStorage.setItem('user_role', 'DEVICE_OWNER');
                    localStorage.setItem('owner_device_id', data.device_id);

                    showToast('Authentication successful! Redirecting...', 'success');
                    
                    setTimeout(() => {
                        window.location.replace('owner-live-monitor.html');
                    }, 1000);
                } else {
                    const errorMsg = data.error || 'Invalid credentials or access denied.';
                    showToast(errorMsg, 'danger');
                    loginBtn.disabled = false;
                    loginBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Login to Live Tracker';
                }
            } catch (error) {
                showToast('Authentication server offline or unreachable.', 'danger');
                console.error(error);
                loginBtn.disabled = false;
                loginBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Login to Live Tracker';
            }
        });
    }
});

function showToast(message, type = 'info') {
    const toastContainer = document.getElementById('toastContainer');
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
