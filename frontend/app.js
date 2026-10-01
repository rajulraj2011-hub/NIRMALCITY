let currentUser = null;
// Latest Live Monitor rows, keyed by id, so Details/Photo can open instantly
// without another round-trip.
const liveMonitor = { reports: {}, pickups: {} };
const API_BASE = '';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = localStorage.getItem('nirmalcityToken');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        if (response.status === 401) {
            localStorage.removeItem('nirmalcityToken');
            currentUser = null;
            applyAuthState();
        }
        throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return payload;
}

// Keeps a double tap from filing the same complaint/request twice.
async function withSubmitLock(button, task) {
    if (button) button.disabled = true;
    try {
        return await task();
    } finally {
        if (button) button.disabled = false;
    }
}

function submitButtonFor(target) {
    return target.querySelector('button[type="submit"]') || target.querySelector('.submit-btn');
}

function setSignedIn(data) {
    localStorage.setItem('nirmalcityToken', data.token);
    currentUser = data.user;
    applyAuthState();
}

function applyAuthState() {
    const signedIn = Boolean(currentUser);
    const isAdmin = currentUser?.role === 'admin';
    document.getElementById('welcome-msg').innerText = signedIn ? `Hello, ${currentUser.email.split('@')[0]} 👋` : '';
    document.getElementById('nav-admin').style.display = isAdmin ? 'inline-flex' : 'none';
    // Admin accounts don't earn resident rewards, so Rewards stays hidden.
    document.getElementById('nav-pickup').style.display = isAdmin ? 'none' : '';
    // ...and they never file reports either: hide Report Issue for admins.
    document.getElementById('nav-report').style.display = isAdmin ? 'none' : '';
    document.getElementById('logout-btn').style.display = signedIn ? 'block' : 'none';
    document.querySelector('.auth-toggle').style.display = signedIn ? 'none' : 'flex';
    document.getElementById('login-form').style.display = signedIn ? 'none' : 'flex';
    document.getElementById('signup-form').style.display = 'none';
}

async function initApp() {
    setupMonitors();
    document.getElementById('overview').style.display = 'flex';
    document.getElementById('app-content').style.display = 'none';
    document.getElementById('main-header').style.display = 'none';
    document.getElementById('main-nav').style.display = 'none';
    document.getElementById('nav-admin').style.display = 'none';
    const token = localStorage.getItem('nirmalcityToken');
    if (token) {
        try {
            const data = await api('/api/auth/me');
            currentUser = data.user;
        } catch (_error) {
            localStorage.removeItem('nirmalcityToken');
            currentUser = null;
        }
    }
    applyAuthState();
}

const sectionBackgrounds = {
    overview: 'linear-gradient(rgba(0,0,0,0.6), rgba(0,0,0,0.6)), url("https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?auto=format&fit=crop&w=1920&q=80")',
    auth: 'linear-gradient(rgba(0,0,0,0.7), rgba(0,0,0,0.7)), url("https://images.unsplash.com/photo-1555949963-ff9fe0c870eb?auto=format&fit=crop&w=1920&q=80")',
    report: 'linear-gradient(rgba(0,0,0,0.7), rgba(0,0,0,0.7)), url("https://images.unsplash.com/photo-1611284446314-60a58ac0deb9?auto=format&fit=crop&w=1920&q=80")',
    pickup: 'linear-gradient(rgba(0,0,0,0.7), rgba(0,0,0,0.7)), url("https://images.unsplash.com/photo-1532996122724-e3c354a0b15b?auto=format&fit=crop&w=1920&q=80")',
    track: 'linear-gradient(rgba(0,0,0,0.7), rgba(0,0,0,0.7)), url("https://images.unsplash.com/photo-1524661135-423995f22d0b?auto=format&fit=crop&w=1920&q=80")',
    admin: 'linear-gradient(rgba(0,0,0,0.8), rgba(0,0,0,0.8)), url("https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=1920&q=80")',
    awareness: 'linear-gradient(rgba(0,0,0,0.7), rgba(0,0,0,0.7)), url("https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?auto=format&fit=crop&w=1920&q=80")'
};

function switchTab(tabId) {
    if (['report', 'pickup', 'track'].includes(tabId) && !currentUser) {
        alert('Please log in first.');
        tabId = 'auth';
    }
    if (tabId === 'admin' && currentUser?.role !== 'admin') {
        alert('Admin access required.');
        tabId = 'auth';
    }
    if (tabId === 'pickup' && currentUser?.role === 'admin') {
        // Rewards are a resident feature; admins don't have this option.
        alert('Rewards are not available for admin accounts.');
        tabId = 'admin';
    }
    if (tabId === 'report' && currentUser?.role === 'admin') {
        // Admins monitor issues, they don't file reports.
        alert('Report Issue is not available for admin accounts.');
        tabId = 'admin';
    }
    document.body.style.backgroundImage = sectionBackgrounds[tabId] || sectionBackgrounds.overview;
    document.getElementById('overview').style.display = 'none';
    document.getElementById('app-content').style.display = 'block';
    document.getElementById('main-header').style.display = 'block';
    document.getElementById('main-nav').style.display = 'flex';
    const titles = { auth: 'Profile', report: 'Report Issue', pickup: 'Rewards', track: 'My Activity', admin: 'Admin Panel', awareness: 'Guidelines' };
    document.querySelector('#main-header p').innerText = titles[tabId] || 'Dashboard';
    document.querySelectorAll('.content-area .section').forEach((element) => {
        element.style.display = 'none';
        element.classList.remove('active-section');
    });
    document.querySelectorAll('#main-nav button').forEach((element) => element.classList.remove('active-nav'));
    const section = document.getElementById(tabId);
    if (section) {
        section.style.display = 'block';
        section.classList.add('active-section');
    }
    const nav = document.getElementById(`nav-${tabId}`);
    if (nav) {
        nav.classList.add('active-nav');
        nav.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
    refreshData();
}

function toggleAuth(mode) {
    const signup = mode === 'signup';
    document.getElementById('login-form').style.display = signup ? 'none' : 'flex';
    document.getElementById('signup-form').style.display = signup ? 'flex' : 'none';
    document.getElementById('btn-show-login').classList.toggle('active-btn', !signup);
    document.getElementById('btn-show-signup').classList.toggle('active-btn', signup);
    // Always start the OTP wizard fresh when the mode changes.
    signupWizard.mode = 'signup';
    resetSignupWizard();
}

/* --- OTP wizard: email → OTP → password --------------------------------
   mode 'signup' creates an account; mode 'reset' is forgot-password —
   same three steps, different endpoints and copy. */
const signupWizard = { step: 1, email: '', setupToken: '', mode: 'signup' };

function startPasswordReset() {
    // Pre-fill from the login form when the user already typed their address.
    const loginEmail = document.getElementById('login-email').value.trim();
    toggleAuth('signup');
    signupWizard.mode = 'reset';
    if (loginEmail) document.getElementById('signup-email').value = loginEmail;
    showSignupStep(1);
}

function setSignupStatus(text, kind) {
    const status = document.getElementById('signup-status');
    if (!status) return;
    status.textContent = text || '';
    status.className = `auth-step-status${kind ? ` ${kind}` : ''}`;
}

function showSignupStep(step) {
    signupWizard.step = step;
    for (let i = 1; i <= 3; i += 1) {
        const box = document.getElementById(`signup-step-${i}`);
        box.style.display = i === step ? 'flex' : 'none';
        // Inactive steps are disabled so their required fields cannot block
        // native form validation on the active step.
        box.querySelectorAll('input').forEach((input) => { input.disabled = i !== step; });
    }
    const resetMode = signupWizard.mode === 'reset';
    const hints = resetMode ? {
        1: "Forgot password? Step 1 of 3 — enter your account email; we'll send a 6-digit code.",
        2: `Step 2 of 3 — enter the 6-digit reset code sent to ${signupWizard.email}.`,
        3: 'Step 3 of 3 — choose your new password.'
    } : {
        1: "Step 1 of 3 — enter your email; we'll send a 6-digit code.",
        2: `Step 2 of 3 — enter the 6-digit code sent to ${signupWizard.email}.`,
        3: 'Step 3 of 3 — choose your password to finish sign up.'
    };
    document.getElementById('signup-hint').textContent = hints[step];
    document.getElementById('signup-btn-1').textContent = resetMode ? 'Send reset code' : 'Send OTP to my email';
    document.getElementById('signup-btn-3').textContent = resetMode ? 'Save new password' : 'Create Account';
    setSignupStatus('');
}

function resetSignupWizard() {
    signupWizard.email = '';
    signupWizard.setupToken = '';
    clearInterval(otpCountdownTimer);
    document.getElementById('signup-form').reset();
    // Disabled inputs are skipped by form.reset() — clear them explicitly.
    document.getElementById('signup-email').value = '';
    document.getElementById('signup-otp').value = '';
    document.getElementById('signup-password').value = '';
    showSignupStep(1);
}

function reportOtpDelivery(data) {
    // Without SMTP credentials the API returns the code (dev mode).
    if (data.delivery === 'console' && data.dev_otp) {
        setSignupStatus(`Dev mode (SMTP not configured) — your code: ${data.dev_otp}`, 'warn');
    } else {
        setSignupStatus(`Code sent to ${data.email} · valid ${Math.round((data.expires_in_seconds || 300) / 60)} min.`);
    }
}

async function requestWizardOtp() {
    const email = document.getElementById('signup-email').value.trim() || signupWizard.email;
    const path = signupWizard.mode === 'reset' ? '/api/auth/forgot-password' : '/api/auth/signup';
    const data = await api(path, { method: 'POST', body: JSON.stringify({ email }) });
    signupWizard.email = email;
    showSignupStep(2);
    reportOtpDelivery(data);
}

function cooldownSeconds(message) {
    const match = /wait (\d+)s/i.exec(message || '');
    return match ? Number(match[1]) : 0;
}

let otpCountdownTimer = 0;
function startOtpCountdown(seconds, onDone) {
    clearInterval(otpCountdownTimer);
    let left = seconds;
    const tick = () => {
        if (left <= 0) {
            clearInterval(otpCountdownTimer);
            onDone();
            return;
        }
        setSignupStatus(`Please wait ${left}s — the code will be sent automatically…`, 'warn');
        left -= 1;
    };
    tick();
    otpCountdownTimer = setInterval(tick, 1000);
}

async function handleSignupFailure(error) {
    // Setup token (10 min) expired at the password step — send them back to
    // step 1 with the address pre-filled so they can request a fresh code.
    if (signupWizard.step === 3 && /verification expired/i.test(error.message || '')) {
        const keepEmail = signupWizard.email;
        resetSignupWizard();
        document.getElementById('signup-email').value = keepEmail;
        signupWizard.email = keepEmail;
        setSignupStatus(error.message, 'error');
        return;
    }
    const wait = cooldownSeconds(error.message);
    if (wait > 0) {
        // Resend cooldown: count down, then request the code again by itself.
        startOtpCountdown(wait, () => { requestWizardOtp().catch(handleSignupFailure); });
    } else {
        setSignupStatus(error.message, 'error');
    }
}

async function handleSignupStep(event) {
    event.preventDefault();
    try {
        await withSubmitLock(submitButtonFor(event.target), async () => {
            const resetMode = signupWizard.mode === 'reset';
            if (signupWizard.step === 1) {
                await requestWizardOtp();
            } else if (signupWizard.step === 2) {
                const otp = document.getElementById('signup-otp').value.trim();
                const path = resetMode ? '/api/auth/verify-reset-otp' : '/api/auth/verify-otp';
                const data = await api(path, { method: 'POST', body: JSON.stringify({ email: signupWizard.email, otp }) });
                signupWizard.setupToken = data.setup_token || data.reset_token;
                showSignupStep(3);
                setSignupStatus(resetMode
                    ? 'Code verified ✓ — now choose your new password.'
                    : 'Code verified ✓ — now set your password.');
            } else {
                const password = document.getElementById('signup-password').value;
                const path = resetMode ? '/api/auth/reset-password' : '/api/auth/set-password';
                const body = resetMode
                    ? { email: signupWizard.email, password, reset_token: signupWizard.setupToken }
                    : { email: signupWizard.email, password, setup_token: signupWizard.setupToken };
                const data = await api(path, { method: 'POST', body: JSON.stringify(body) });
                setSignedIn(data);
                alert(resetMode ? 'Password reset. You are now logged in.' : 'Account created. You are now logged in.');
                resetSignupWizard();
                signupWizard.mode = 'signup';
                switchTab(currentUser?.role === 'admin' ? 'admin' : 'report');
            }
        });
    } catch (error) { handleSignupFailure(error); }
}

async function resendOtp() {
    const button = document.getElementById('signup-resend');
    if (button.disabled) return;
    button.disabled = true;
    try {
        const path = signupWizard.mode === 'reset' ? '/api/auth/resend-reset-otp' : '/api/auth/resend-otp';
        const data = await api(path, { method: 'POST', body: JSON.stringify({ email: signupWizard.email }) });
        document.getElementById('signup-otp').value = '';
        reportOtpDelivery(data);
    } catch (error) { handleSignupFailure(error); }
    finally { button.disabled = false; }
}

async function handleLogin(event) {
    event.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    try {
        await withSubmitLock(submitButtonFor(event.target), async () => {
            setSignedIn(await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }));
        });
        event.target.reset();
        // Admins land on the admin panel; residents land on Report Issue.
        switchTab(currentUser?.role === 'admin' ? 'admin' : 'report');
    } catch (error) { alert(error.message); }
}

async function handleLogout() {
    // Revoke the session on the server so the token stops working everywhere.
    if (localStorage.getItem('nirmalcityToken')) {
        try { await api('/api/auth/logout', { method: 'POST' }); } catch (_error) { /* Local sign-out always proceeds. */ }
    }
    localStorage.removeItem('nirmalcityToken');
    currentUser = null;
    applyAuthState();
    toggleAuth('login');
    switchTab('auth');
}

let locationRequestId = 0;

function getLocation() {
    const locationInput = document.getElementById('issue-location');
    if (!navigator.geolocation) {
        alert('Location is not supported by this browser.');
        return;
    }
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        alert('GPS requires HTTPS (or localhost). Open this app over a secure connection.');
        return;
    }
    locationInput.value = 'Fetching GPS…';
    navigator.geolocation.getCurrentPosition(async (position) => {
        const latitude = position.coords.latitude;
        const longitude = position.coords.longitude;
        document.getElementById('issue-latitude').value = latitude;
        document.getElementById('issue-longitude').value = longitude;
        // Readable fallback while the place name is resolved.
        locationInput.value = `Lat ${latitude.toFixed(6)}, Lon ${longitude.toFixed(6)}`;
        const requestId = ++locationRequestId;
        try {
            const response = await fetch(`/api/geocode/reverse?lat=${latitude}&lon=${longitude}`);
            const payload = response.ok ? await response.json() : null;
            // Ignore stale replies so a slower fix cannot overwrite a newer one.
            if (payload?.label && requestId === locationRequestId) {
                locationInput.value = payload.label;
            }
        } catch (_error) { /* Coordinates are still saved when geocoding is offline. */ }
    }, (error) => {
        locationInput.value = '';
        alert(error.code === 1 ? 'Allow location permission in your browser to use GPS.' : 'Could not get your location. Enter it manually.');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
}

async function handleReport(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = new FormData();
    body.append('location', document.getElementById('issue-location').value.trim());
    body.append('problem_type', document.getElementById('issue-type').value);
    body.append('details', document.getElementById('issue-desc').value.trim());
    const latitude = document.getElementById('issue-latitude').value;
    const longitude = document.getElementById('issue-longitude').value;
    if (latitude && longitude) {
        body.append('latitude', latitude);
        body.append('longitude', longitude);
    }
    const photo = document.getElementById('issue-photo').files[0];
    if (photo) {
        if (photo.size > 8 * 1024 * 1024) {
            alert('Photo must be smaller than 8 MB.');
            return;
        }
        body.append('photo', photo);
    }
    try {
        const data = await withSubmitLock(submitButtonFor(form), () => api('/api/reports', { method: 'POST', body }));
        const verification = data.complaint && data.complaint.verification;
        if (verification && verification.status === 'rejected') {
            alert('Report submitted, but AI verification REJECTED it:\n' +
                (verification.reason || 'not a genuine waste report') +
                '\n\nIt will NOT appear in the admin monitor. See it under Track.');
        } else if (verification && verification.status === 'pending') {
            alert('Report submitted. Verification pending: ' + (verification.reason || ''));
        } else {
            const earned = data.rewards && data.rewards.points_earned;
            alert('Report submitted and AI verified ✓'
                + (earned ? `\n+${earned} points earned! 🎁` : ''));
        }
        form.reset();
        switchTab('track');
    } catch (error) { alert(error.message); }
}

function statusClass(status) {
    if (status === 'Resolved') return 'status-resolved';
    if (status === 'In Progress') return 'status-in-progress';
    return 'status-pending';
}

function verificationLabel(status) {
    if (status === 'verified') return 'Verified';
    if (status === 'rejected') return 'Rejected';
    return 'Review needed';
}

// AI verdict chip. Rows saved before verification existed get no chip.
function verificationBadge(item) {
    const verification = item.verification;
    if (!verification || !verification.status) return '';
    const title = escapeHtml(verification.reason || '');
    if (verification.status === 'verified') {
        return `<span class="verify-badge verify-ok" title="${title}">✓ AI Verified</span>`;
    }
    if (verification.status === 'rejected') {
        return `<span class="verify-badge verify-bad" title="${title}">✗ AI Rejected</span>`;
    }
    return `<span class="verify-badge verify-warn" title="${title}">⏳ Review needed</span>`;
}

// Why a report was rejected / could not be verified, shown under the badges.
function verificationNote(item) {
    const verification = item.verification;
    if (!verification || !verification.status || verification.status === 'verified') return '';
    if (!verification.reason) return '';
    return `<small class="verify-reason">${escapeHtml(verification.reason)}</small>`;
}

function photoFallback(image) {
    // Prefer the full-size original if the preview failed; if that is gone too,
    // show an icon instead of a broken image.
    const full = image.getAttribute('data-full');
    if (full && image.dataset.fallbackTried !== 'full') {
        image.dataset.fallbackTried = 'full';
        image.src = full;
        return;
    }
    image.outerHTML = '<span style="font-size:20px;">📄</span>';
}

function photoMarkup(path, thumbPath) {
    if (!path) return '<span style="font-size:20px;">📄</span>';
    const src = thumbPath || path;
    return `<img src="${escapeHtml(src)}" data-full="${escapeHtml(path)}" loading="lazy" alt="Complaint photo" onerror="photoFallback(this)" style="width:40px;height:40px;border-radius:8px;object-fit:cover;">`;
}

// One report row, shared by the admin Live Monitor, the resident's Track list,
// and the admin Track monitoring groups — so every table looks identical.
// `adminControls` adds the status dropdown (backend allows admins only).
function reportRowHtml(item, adminControls) {
    return `
                <tr>
                    <td>${photoMarkup(item.photo_path, item.photo_thumb_path)}</td>
                    <td><strong>${escapeHtml(item.problem_type)}</strong><br>${escapeHtml(item.user_email || '')}<br><small style="color:#7f8c8d;">${escapeHtml(item.location || '')} · ${escapeHtml((item.created_at || '').slice(0, 10))}</small><br>${escapeHtml(item.details || '')}</td>
                    <td>${verificationBadge(item)} <span class="${statusClass(item.status)}">${escapeHtml(item.status)}</span>${verificationNote(item)}<br>${adminControls ? statusSelect('reports', item) : ''}${monitorActions('reports', item)}</td>
                </tr>`;
}

// Admin's Track is a monitoring view over EVERYONE's reports: all in-progress
// requests plus the three newest ones. Residents keep their own activity list.
async function renderAdminTrack() {
    const data = await api('/api/reports');  // newest first, rejected filtered out
    const all = data.reports;
    const inProgress = all.filter((item) => item.status === 'In Progress');
    const latest = all.slice(0, 3);
    liveMonitor.reports = {};
    all.forEach((item) => { liveMonitor.reports[item.id] = item; });
    const group = (title, items, emptyText) => {
        const header = `<tr class="group-row"><td colspan="3"><h4>${escapeHtml(title)}</h4></td></tr>`;
        if (!items.length) {
            return header + `<tr><td colspan="3" class="empty-group">${escapeHtml(emptyText)}</td></tr>`;
        }
        return header + items.map((item) => reportRowHtml(item, true)).join('');
    };
    const body = document.getElementById('user-table-body');
    body.innerHTML =
        group(`In Progress — ${inProgress.length}`, inProgress, 'No reports in progress right now.') +
        group('Latest 3 new reports', latest, 'No reports yet.');
    bindRowControls(body);
}

/* ------------------------------------------------------------------ *
 * REWARDS: points earned from AI-verified reports + partner coupons   *
 * ------------------------------------------------------------------ */

function renderRewards(data) {
    document.getElementById('rewards-points').textContent = data.points;
    document.getElementById('earnings-list').innerHTML =
        data.earnings.map((item) => `
            <div class="earning-row">
                <span class="earning-plus">+${escapeHtml(item.points)}</span>
                <span>${escapeHtml(item.label || 'Verified report')}<small> · AI verified · ${escapeHtml((item.created_at || '').slice(0, 10))}</small></span>
            </div>`).join('')
        || '<p class="earnings-empty">No points yet — submit a report that AI verifies as genuine.</p>';
    const cards = data.catalog.map((offer) => {
        const unlocked = data.coupons.find((item) => item.coupon_id === offer.id);
        return couponCardHtml(offer, unlocked, data.points);
    });
    // A coupon the user already unlocked can drop out of the catalog once it
    // expires — keep showing it as history (the points were spent).
    data.coupons
        .filter((item) => !data.catalog.some((offer) => offer.id === item.coupon_id))
        .forEach((item) => cards.push(couponCardHtml({
            id: item.coupon_id, website: item.website, type: item.type,
            title: item.title, terms: item.terms, valid_til: item.valid_til,
            verified_on: item.verified_on, via: item.via,
        }, item, data.points)));
    document.getElementById('coupons-grid').innerHTML =
        cards.join('')
        || '<p class="coupons-empty">No coupons available right now.</p>';
}

function couponCardHtml(offer, unlocked, points) {
    const typeClass = offer.type === 'cashback' ? 'cashback' : 'discount';
    const typeLabel = offer.type === 'cashback' ? 'Cashback' : 'Discount';
    const expired = Boolean(offer.valid_til) && offer.valid_til < new Date().toISOString().slice(0, 10);
    let action;
    if (unlocked) {
        action = `<code class="coupon-code" id="coupon-code-${escapeHtml(offer.id)}">${escapeHtml(unlocked.code || '')}</code>
            <button type="button" class="mini-btn secondary" onclick="copyCoupon('${escapeHtml(offer.id)}', this)">Copy</button>`;
        if (unlocked.url) {
            action += `<a class="coupon-visit" href="${escapeHtml(unlocked.url)}" target="_blank" rel="noopener noreferrer">Visit site ↗</a>`;
        }
    } else if (expired) {
        action = '<span class="coupon-lock">Expired</span>';
    } else if (points >= offer.cost) {
        action = `<button type="button" class="mini-btn" onclick="redeemCoupon('${escapeHtml(offer.id)}')">Unlock · ${escapeHtml(offer.cost)} pts</button>`;
    } else {
        action = `<span class="coupon-lock">🔒 ${escapeHtml(offer.cost)} pts</span>`;
    }
    const meta = [];
    if (offer.via) meta.push(`auto-verified via ${offer.via}`);
    if (offer.verified_on) meta.push(`✓ verified ${offer.verified_on}`);
    if (offer.valid_til) meta.push(expired ? 'Expired' : `Valid till ${offer.valid_til}`);
    const metaHtml = meta.length
        ? `<div class="coupon-meta">${meta.map((text) => `<span>${escapeHtml(text)}</span>`).join('')}</div>`
        : '';
    return `
        <div class="coupon-card${expired ? ' is-expired' : ''}">
            <div class="coupon-top"><span class="coupon-website">${escapeHtml(offer.website)}</span><span class="coupon-type ${typeClass}">${typeLabel}</span></div>
            <p class="coupon-title">${escapeHtml(offer.title)}</p>
            <small class="coupon-terms">${escapeHtml(offer.terms || '')}</small>
            ${metaHtml}
            <div class="coupon-actions">${action}</div>
        </div>`;
}

async function redeemCoupon(couponId) {
    try {
        await api('/api/rewards/redeem', {
            method: 'POST', body: JSON.stringify({ coupon_id: couponId })
        });
        renderRewards(await api('/api/rewards'));
    } catch (error) { alert(error.message); }
}

async function copyCoupon(couponId, button) {
    const code = document.getElementById(`coupon-code-${couponId}`)?.textContent || '';
    if (!code) return;
    try {
        await navigator.clipboard.writeText(code);
    } catch (_error) {
        // Older/insecure contexts: fall back to a hidden textarea.
        const helper = document.createElement('textarea');
        helper.value = code;
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
    }
    if (button) {
        const original = button.textContent;
        button.textContent = 'Copied ✓';
        setTimeout(() => { button.textContent = original; }, 1500);
    }
}

async function refreshData() {
    if (!currentUser) return;
    const activeSection = document.querySelector('.content-area .active-section')?.id;
    if (activeSection === 'pickup') {
        try {
            renderRewards(await api('/api/rewards'));
        } catch (error) { alert(error.message); }
    }
    if (activeSection === 'track') {
        try {
            const body = document.getElementById('user-table-body');
            if (currentUser.role === 'admin') {
                await renderAdminTrack();
                return;
            }
            // Mirror the admin Live Monitor: cache every entry so the row's
            // 👁 Details / 📷 Photo buttons work for residents too.
            const data = await api('/api/activity/mine');
            liveMonitor.reports = {};
            liveMonitor.pickups = {};
            data.activity.forEach((item) => {
                liveMonitor[item.activity_type === 'pickup' ? 'pickups' : 'reports'][item.id] = item;
            });
            body.innerHTML = data.activity.map((item) => {
                const pickup = item.activity_type === 'pickup';
                if (!pickup) return reportRowHtml(item, false);
                const summary = item.pickup_date ? `Pickup scheduled: ${item.pickup_date}` : '';
                return `
                <tr>
                    <td><span style="font-size:20px;">📦</span></td>
                    <td><strong>${escapeHtml(item.problem_type)}</strong><br>${escapeHtml(item.user_email || '')}<br><small style="color:#7f8c8d;">${escapeHtml(item.location || '')} · ${escapeHtml((item.created_at || '').slice(0, 10))}</small><br>${escapeHtml(summary)}</td>
                    <td>${verificationBadge(item)} <span class="${statusClass(item.status)}">${escapeHtml(item.status)}</span>${verificationNote(item)}<br>${monitorActions('pickup', item)}</td>
                </tr>`;
            }).join('') || '<tr><td colspan="3">No activity yet.</td></tr>';
            bindRowControls(body);
        } catch (error) { alert(error.message); }
    }
    if (activeSection === 'admin' && currentUser.role === 'admin') {
        try {
            const data = await api('/api/reports');
            const body = document.getElementById('admin-table-body');
            liveMonitor.reports = {};
            data.reports.forEach((item) => { liveMonitor.reports[item.id] = item; });
            body.innerHTML = data.reports.map((item) => reportRowHtml(item, true)).join('')
                || '<tr><td colspan="3">No complaints yet.</td></tr>';
            bindRowControls(body);
        } catch (error) { alert(error.message); }
        renderCouponFeed();
    }
}

/* ------------------------------------------------------------------ *
 * AUTOMATIC COUPON FEED: every 4 days the backend re-verifies the     *
 * trusted coupon sources and merges fresh codes (admin card below).   *
 * ------------------------------------------------------------------ */

async function renderCouponFeed() {
    const card = document.getElementById('coupon-feed-card');
    if (!card) return;
    try {
        const data = await api('/api/admin/coupons/feed');
        card.style.display = 'block';
        const result = data.last_result || {};
        const last = data.last_run
            ? new Date(data.last_run).toLocaleString('en-IN',
                { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
            : 'never';
        let summary = data.running
            ? '⏳ Refresh running — scanning sources…'
            : `Last run: ${last} · auto-refresh every ${data.refresh_days} days`;
        if (result.status === 'ran') {
            summary += ` · +${(result.added || []).length} new, ${result.refreshed || 0} re-verified, ${result.staled || 0} retired`;
        } else if (result.status === 'failed') {
            summary += ` · ⚠️ last run failed: ${result.error || 'unknown error'}`;
        }
        if (data.overdue && !data.running) summary += ' · ⚠️ overdue';
        document.getElementById('coupon-feed-summary').textContent = summary;
        const scraping = (data.sources || [])
            .map((s) => `${s.label} (${s.pages} page${s.pages === 1 ? '' : 's'})`).join(', ');
        const none = (data.unavailable || []).map((u) => u.site).join(', ');
        document.getElementById('coupon-feed-sources').textContent =
            `Scraping for codes: ${scraping}.`
            + (none ? ` Tracked but no paste codes served (reported honestly): ${none}.` : '')
            + ` Active auto codes: ${data.active_auto}.`;
    } catch (_error) {
        card.style.display = 'none';
    }
}

async function refreshCouponFeed() {
    const button = document.getElementById('coupon-feed-refresh-btn');
    const output = document.getElementById('coupon-feed-result');
    try {
        await api('/api/admin/coupons/refresh', { method: 'POST' });
        output.textContent = '⏳ Refresh started — scanning sources (~1 minute)…';
        button.disabled = true;
        const poll = setInterval(async () => {
            try {
                const data = await api('/api/admin/coupons/feed');
                if (data.running) return;
                clearInterval(poll);
                button.disabled = false;
                const result = data.last_result || {};
                if (result.status === 'failed') {
                    output.textContent = `❌ Refresh failed: ${result.error || 'unknown error'}`;
                } else {
                    const added = (result.added || [])
                        .map((a) => `${a.website}: ${a.code} (via ${a.via})`);
                    output.textContent = `✓ Done — ${(result.added || []).length} new`
                        + (added.length ? `: ${added.slice(0, 8).join(', ')}${added.length > 8 ? '…' : ''}` : '')
                        + ` · ${result.refreshed || 0} re-verified`;
                }
                renderCouponFeed();
            } catch (error) {
                clearInterval(poll);
                button.disabled = false;
                output.textContent = `❌ ${error.message}`;
            }
        }, 4000);
    } catch (error) {
        output.textContent = `❌ ${error.message}`;
    }
}

function statusSelect(kind, item) {
    const options = ['Pending', 'In Progress', 'Resolved']
        .map((status) => `<option value="${status}"${status === item.status ? ' selected' : ''}>${status}</option>`)
        .join('');
    return `<select class="status-select" data-kind="${kind}" data-item-id="${escapeHtml(item.id)}">${options}</select>`;
}

function monitorActions(kind, item) {
    const photoButton = item.photo_path
        ? `<button type="button" class="mini-btn" data-open="photo" data-kind="${kind}" data-item-id="${escapeHtml(item.id)}">📷 Photo</button>`
        : '<span class="no-photo">No photo</span>';
    return `<div class="row-actions">
        <button type="button" class="mini-btn secondary" data-open="details" data-kind="${kind}" data-item-id="${escapeHtml(item.id)}">👁 Details</button>
        ${photoButton}
    </div>`;
}

function bindRowControls(root) {
    root.querySelectorAll('.status-select').forEach((select) => {
        select.addEventListener('change', () => updateStatus(select.dataset.kind, select.dataset.itemId, select.value));
    });
    root.querySelectorAll('[data-open]').forEach((button) => {
        button.addEventListener('click', () => {
            if (button.dataset.open === 'photo') openPhoto(button.dataset.kind, button.dataset.itemId);
            else openDetails(button.dataset.kind, button.dataset.itemId);
        });
    });
}

async function updateStatus(kind, id, status) {
    try {
        await api(`/api/${kind}/${encodeURIComponent(id)}/status`, {
            method: 'PATCH', body: JSON.stringify({ status })
        });
    } catch (error) { alert(error.message); }
    refreshData();
}

/* ------------------------------------------------------------------ *
 * LIVE MONITOR: details modal + photo viewer (zoom in/out/reset/fit)  *
 * ------------------------------------------------------------------ */

const photoView = { scale: 1, x: 0, y: 0, min: 0.1, max: 12 };

function openModal(id) {
    document.getElementById(id).classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeModal(id) {
    document.getElementById(id).classList.remove('open');
    if (!document.querySelector('.modal.open')) document.body.style.overflow = '';
}

function formatTimestamp(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function detailRows(item) {
    const rows = [];
    const add = (label, value) => rows.push(
        `<div class="detail-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value == null || value === '' ? '—' : String(value))}</dd></div>`
    );
    add('ID', item.id);
    add('Problem Type', item.problem_type);
    add('Details', item.details || item.address);
    add('Location', item.location);
    add('Coordinates', item.coordinates
        ? `${item.coordinates.latitude}, ${item.coordinates.longitude}`
        : 'Not shared');
    add('Reported By', item.user_email);
    add('User ID', item.user_id);
    add('Status', item.status);
    const verification = item.verification;
    add('AI Verification', verification && verification.status
        ? `${verificationLabel(verification.status)}${verification.reason ? ` — ${verification.reason}` : ''}${verification.confidence != null ? ` (${verification.confidence}%)` : ''}`
        : item.activity_type === 'pickup' ? 'Not applicable (pickup request)'
            : 'Not checked (report predates AI verification)');
    add('Created', formatTimestamp(item.created_at));
    add('Last Updated', formatTimestamp(item.updated_at));
    add('Photo', item.photo_path ? 'Attached' : 'None');
    return rows;
}

function openDetails(kind, id) {
    const item = (liveMonitor[kind] || {})[id];
    const body = document.getElementById('details-body');
    const actions = document.getElementById('details-actions');
    document.getElementById('details-title').textContent =
        kind === 'pickup' ? 'Pickup Details' : 'Complaint Details';
    if (!item) {
        body.innerHTML = '<p class="modal-empty">Details could not be loaded. Refresh the list and try again.</p>';
        actions.innerHTML = '';
    } else {
        body.innerHTML = detailRows(item).join('');
        actions.innerHTML = item.photo_path
            ? '<button type="button" class="mini-btn" id="details-open-photo">📷 Open Photo</button>'
            : '';
        const photoButton = document.getElementById('details-open-photo');
        if (photoButton) {
            photoButton.addEventListener('click', () => {
                closeModal('details-modal');
                openPhoto(kind, id);
            });
        }
    }
    openModal('details-modal');
}

function showPhotoMessage(text) {
    document.getElementById('photo-image').style.display = 'none';
    const message = document.getElementById('photo-message');
    message.textContent = text;
    message.style.display = 'block';
    document.getElementById('photo-zoom-level').textContent = '—';
}

function openPhoto(kind, id) {
    const item = (liveMonitor[kind] || {})[id];
    const image = document.getElementById('photo-image');
    const message = document.getElementById('photo-message');
    if (!item || !item.photo_path) {
        showPhotoMessage('No photo attached to this entry.');
        openModal('photo-modal');
        return;
    }
    message.style.display = 'none';
    image.style.display = 'none';
    image.onload = () => {
        image.style.display = 'block';
        fitPhoto();
    };
    image.onerror = () => showPhotoMessage('The photo file is no longer available.');
    // If the browser already has this image cached, `load` may not re-fire.
    image.src = item.photo_path;
    if (image.complete && image.naturalWidth > 0) {
        image.style.display = 'block';
        fitPhoto();
    }
    openModal('photo-modal');
}

function applyPhotoTransform() {
    const image = document.getElementById('photo-image');
    image.style.transform =
        `translate(${photoView.x}px, ${photoView.y}px) scale(${photoView.scale})`;
    document.getElementById('photo-zoom-level').textContent =
        `${Math.round(photoView.scale * 100)}%`;
}

function clampScale(value) {
    return Math.min(photoView.max, Math.max(photoView.min, value));
}

function zoomPhotoAt(newScale, clientX, clientY) {
    const stage = document.getElementById('photo-stage');
    const rect = stage.getBoundingClientRect();
    // Keep the point under the cursor stable while scaling around it.
    const cx = clientX - rect.left - rect.width / 2;
    const cy = clientY - rect.top - rect.height / 2;
    const pointX = (cx - photoView.x) / photoView.scale;
    const pointY = (cy - photoView.y) / photoView.scale;
    photoView.scale = clampScale(newScale);
    photoView.x = cx - pointX * photoView.scale;
    photoView.y = cy - pointY * photoView.scale;
    applyPhotoTransform();
}

function zoomFromCenter(factor) {
    const rect = document.getElementById('photo-stage').getBoundingClientRect();
    zoomPhotoAt(photoView.scale * factor,
        rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function fitPhoto() {
    const image = document.getElementById('photo-image');
    const stage = document.getElementById('photo-stage');
    if (!image.naturalWidth) return;
    const rect = stage.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth,
        rect.height / image.naturalHeight) * 0.94;
    photoView.scale = clampScale(scale);
    photoView.x = 0;
    photoView.y = 0;
    applyPhotoTransform();
}

function resetPhotoZoom() {
    photoView.scale = 1;
    photoView.x = 0;
    photoView.y = 0;
    applyPhotoTransform();
}

function setupMonitors() {
    document.getElementById('details-close')
        .addEventListener('click', () => closeModal('details-modal'));
    document.getElementById('photo-close')
        .addEventListener('click', () => closeModal('photo-modal'));
    document.getElementById('photo-zoom-in')
        .addEventListener('click', () => zoomFromCenter(1.3));
    document.getElementById('photo-zoom-out')
        .addEventListener('click', () => zoomFromCenter(1 / 1.3));
    document.getElementById('photo-zoom-reset')
        .addEventListener('click', resetPhotoZoom);
    document.getElementById('photo-zoom-fit')
        .addEventListener('click', fitPhoto);

    // Click on the dimmed backdrop closes the modal.
    ['details-modal', 'photo-modal'].forEach((id) => {
        document.getElementById(id).addEventListener('click', (event) => {
            if (event.target.id === id) closeModal(id);
        });
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (document.getElementById('photo-modal').classList.contains('open')) {
            closeModal('photo-modal');
        } else if (document.getElementById('details-modal').classList.contains('open')) {
            closeModal('details-modal');
        }
    });

    const stage = document.getElementById('photo-stage');
    stage.addEventListener('wheel', (event) => {
        event.preventDefault();
        zoomPhotoAt(photoView.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15),
            event.clientX, event.clientY);
    }, { passive: false });

    // Drag to pan while zoomed in.
    let drag = null;
    stage.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        drag = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: photoView.x,
            originY: photoView.y
        };
        stage.classList.add('dragging');
        stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener('pointermove', (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        photoView.x = drag.originX + (event.clientX - drag.startX);
        photoView.y = drag.originY + (event.clientY - drag.startY);
        applyPhotoTransform();
    });
    const endDrag = (event) => {
        if (drag && drag.id === event.pointerId) {
            drag = null;
            stage.classList.remove('dragging');
        }
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
}
