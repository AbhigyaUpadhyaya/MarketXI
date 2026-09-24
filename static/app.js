// ==========================================================
// static/app.js (Vanilla UI Logic + theme system)
// ==========================================================
const API_BASE = "/api";

// State
let comparisonList = [];
let chartInstance = null;
let searchTimeout = null;
let currentPlayer = null;

let lbSortBy = "market_value";
let lbOrder = "desc";
let lbOffset = 0;
const INITIAL_LIMIT = 5;
const PAGE_LIMIT = 10;
let lbTotal = 0;
let loadedPlayers = [];

const THEME_KEY = 'tvp-theme';
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function buildAvatar() {
    const fill = (cssVar('--avatar-fallback') || '#8d8f70').replace('#', '%23');
    return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='${fill}'><path d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/></svg>`;
}

let fallbackAvatar = buildAvatar();

/* Icons are decorative: a blocked CDN must never kill the app. */
function refreshIcons() {
    try {
        if (window.lucide && typeof lucide.createIcons === 'function') lucide.createIcons();
    } catch (e) { /* icons stay as empty placeholders */ }
}

/* ---------- Theme ---------- */
function effectiveTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function paintThemeIcon() {
    const icon = document.getElementById('themeIcon');
    const btn = document.getElementById('themeToggle');
    if (!icon || !btn) return;
    const next = effectiveTheme() === 'light' ? 'dark' : 'light';
    icon.setAttribute('data-lucide', effectiveTheme() === 'light' ? 'moon' : 'sun');
    btn.setAttribute('aria-label', `Switch to ${next} mode`);
    btn.setAttribute('title', `Switch to ${next} mode`);
    refreshIcons();
}

function applyTheme(theme, persist = true) {
    document.documentElement.setAttribute('data-theme', theme);
    if (persist) {
        try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode */ }
    }
    fallbackAvatar = buildAvatar();
    paintThemeIcon();
    // Charts read CSS variables at render time — repaint if visible.
    if (chartInstance && comparisonList.length > 0) renderLineChart();
}

const logoBtn = document.getElementById('logoBtn');
const searchInput = document.getElementById('searchInput');
const searchDropdown = document.getElementById('searchDropdown');
const homeMarquee = document.getElementById('homeMarquee');
const marqueeTrack = document.getElementById('marqueeTrack');
const leaderboardSection = document.getElementById('leaderboardSection');
const sortSelect = document.getElementById('sortSelect');
const segTabs = document.querySelector('.seg-tabs');
const segPill = document.getElementById('segPill');
const leaderboardSkeleton = document.getElementById('leaderboardSkeleton');
const leaderboardList = document.getElementById('leaderboardList');
const loadMoreContainer = document.getElementById('loadMoreContainer');
const btnLoadMore = document.getElementById('btnLoadMore');
const profileSection = document.getElementById('profileSection');
const errorState = document.getElementById('errorState');
const errorMessage = document.getElementById('errorMessage');
const profileSkeleton = document.getElementById('profileSkeleton');
const profileCard = document.getElementById('profileCard');
const btnCompare = document.getElementById('btnCompare');
const btnCompareText = document.getElementById('btnCompareText');
const comparisonSection = document.getElementById('comparisonSection');
const compTags = document.getElementById('compTags');
const compCount = document.getElementById('compCount');
const btnClearComp = document.getElementById('btnClearComp');

/* Core boot first: data rendering must never depend on decorations. */
try {
    initMarquee();
} catch (e) { console.error("Marquee failed", e); }
try {
    fetchLeaderboard(true);
} catch (e) { console.error("Leaderboard failed", e); }

/* Decorative enhancements last: any failure here leaves the app working. */
try {
    refreshIcons();
    paintThemeIcon();
} catch (e) { console.error("Enhancement init failed", e); }

/* Per-character entrance for the brand wordmark (once, on load) */
(function brandEntrance() {
    const mark = document.getElementById('logoWordmark');
    if (!mark) return;
    const text = mark.textContent;
    mark.textContent = '';
    mark.setAttribute('aria-label', text);
    [...text].forEach((ch, i) => {
        const span = document.createElement('span');
        span.className = 'char' + (i >= 6 ? ' char-accent' : '');
        span.style.setProperty('--i', i);
        span.textContent = ch;
        span.setAttribute('aria-hidden', 'true');
        mark.appendChild(span);
    });
    if (reduceMotion) {
        mark.querySelectorAll('.char').forEach(c => { c.style.opacity = '1'; c.style.animation = 'none'; });
    }
})();

document.getElementById('themeToggle').onclick = () => {
    applyTheme(effectiveTheme() === 'light' ? 'dark' : 'light');
};

const formatGBP = (value) => {
    if (value === null || value === undefined) return 'Unknown';
    if (value >= 1_000_000_000) return `£${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 1_000_000) return `£${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `£${(value / 1_000).toFixed(0)}K`;
    return `£${value.toFixed(0)}`;
};

const handleImageError = (imgEl) => {
    imgEl.onerror = null;
    imgEl.src = fallbackAvatar;
};

const hideEl = (el) => {
    if (el) el.onerror = null, el.classList.add('hidden');
};

logoBtn.onclick = () => showHomeView();
logoBtn.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') showHomeView(); };

/* ---------- Morphing profile dialog ----------
   The sheet expands from the clicked row/card (FLIP). Core
   fetch/render never depends on the animation. */
let lastTrigger = null;

/* Soft, critically-damped spring feel: deliberate but never bouncy.
   (Equivalent zeta ~1; WAAPI has no spring type, so the curve
   below is its closest restrained analogue.) */
const MORPH_OPEN_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const MORPH_CLOSE_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';

function morphSheet(fromRect, reverse = false, fromRadius = '12px') {
    if (reduceMotion || !fromRect) return null;
    const sheet = document.querySelector('.profile-sheet');
    if (!sheet) return null;
    const toRect = sheet.getBoundingClientRect();
    if (!toRect.width || !toRect.height) return null;
    const toRadius = getComputedStyle(sheet).borderRadius || '16px';
    const sx = Math.min(Math.max(fromRect.width / toRect.width, 0.04), 1);
    const sy = Math.min(Math.max(fromRect.height / toRect.height, 0.04), 1);
    const dx = (fromRect.left + fromRect.width / 2) - (toRect.left + toRect.width / 2);
    const dy = (fromRect.top + fromRect.height / 2) - (toRect.top + toRect.height / 2);
    const closed = {
        transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
        opacity: 0,
        borderRadius: fromRadius,
    };
    const open = { transform: 'translate(0px, 0px) scale(1, 1)', opacity: 1, borderRadius: toRadius };
    return sheet.animate(reverse ? [open, closed] : [closed, open], {
        duration: reverse ? 320 : 480,
        easing: reverse ? MORPH_CLOSE_EASE : MORPH_OPEN_EASE,
        fill: 'backwards',
    });
}

/* Content settles a breath after the container: one subtle rise. */
function settleContent() {
    if (reduceMotion) return;
    const card = document.getElementById('profileCard');
    if (!card || card.classList.contains('hidden')) return;
    try {
        card.animate([
            { opacity: 0, transform: 'translateY(10px)' },
            { opacity: 1, transform: 'translateY(0px)' },
        ], { duration: 340, delay: 130, easing: MORPH_OPEN_EASE, fill: 'backwards' });
    } catch (e) { /* content is already rendered; animation is optional */ }
}

function openProfileDialog(trigger) {
    lastTrigger = trigger && trigger.isConnected ? trigger : null;
    profileSection.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    // Layout must settle before measuring the sheet.
    requestAnimationFrame(() => {
        const rect = lastTrigger ? lastTrigger.getBoundingClientRect() : null;
        const radius = lastTrigger ? getComputedStyle(lastTrigger).borderRadius : '12px';
        morphSheet(rect, false, radius);
        settleContent();
        profileSection.focus({ preventScroll: true });
    });
}

function closeProfileDialog() {
    if (profileSection.classList.contains('hidden')) return;
    const trigger = lastTrigger && lastTrigger.isConnected ? lastTrigger : null;
    const done = () => {
        profileSection.classList.add('hidden');
        document.body.style.overflow = '';
        if (trigger) trigger.focus({ preventScroll: true });
        lastTrigger = null;
    };
    try {
        const radius = trigger ? getComputedStyle(trigger).borderRadius : '12px';
        const anim = trigger ? morphSheet(trigger.getBoundingClientRect(), true, radius) : null;
        if (anim) {
            anim.finished.then(done).catch(done);
            return;
        }
    } catch (e) { /* fall through to instant close */ }
    done();
}

document.getElementById('profileBackdrop').onclick = () => closeProfileDialog();
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !profileSection.classList.contains('hidden')
        && document.getElementById('photoLightbox').classList.contains('hidden')) {
        e.stopPropagation();
        closeProfileDialog();
    }
});

/* ---------- Nested photo lightbox ----------
   Morphs the profile photo into a large centered view (FLIP,
   easeInOut 300ms). Closing it never touches the outer dialog. */
const PHOTO_EASE = 'easeInOut';

function photoFlip(fromRect, toRect, reverse = false) {
    if (reduceMotion || !fromRect || !toRect || !toRect.width || !toRect.height) return null;
    const fig = document.querySelector('.photo-lightbox-figure');
    if (!fig) return null;
    const sx = Math.min(Math.max(fromRect.width / toRect.width, 0.02), 1);
    const sy = Math.min(Math.max(fromRect.height / toRect.height, 0.02), 1);
    const dx = (fromRect.left + fromRect.width / 2) - (toRect.left + toRect.width / 2);
    const dy = (fromRect.top + fromRect.height / 2) - (toRect.top + toRect.height / 2);
    const small = {
        transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
        opacity: 0.3,
        borderRadius: '50%',
    };
    const large = { transform: 'translate(0px, 0px) scale(1, 1)', opacity: 1, borderRadius: '4px' };
    try {
        return fig.animate(reverse ? [large, small] : [small, large], {
            duration: 300,
            easing: PHOTO_EASE,
            fill: 'backwards',
        });
    } catch (e) {
        return null;
    }
}

function openPhotoLightbox() {
    const box = document.getElementById('photoLightbox');
    const src = document.getElementById('playerPhoto');
    const large = document.getElementById('photoLarge');
    if (!box || !src || !large) return;
    // Same image the profile shows (real photo, or the app fallback).
    large.src = src.src;
    large.alt = currentPlayer && currentPlayer.player
        ? `${currentPlayer.player} — enlarged photo`
        : 'Enlarged player photo';
    const fromRect = src.getBoundingClientRect();
    box.classList.remove('hidden');
    requestAnimationFrame(() => {
        photoFlip(fromRect, large.getBoundingClientRect());
        document.getElementById('photoClose').focus({ preventScroll: true });
    });
}

function closePhotoLightbox() {
    const box = document.getElementById('photoLightbox');
    if (!box || box.classList.contains('hidden')) return;
    const src = document.getElementById('playerPhoto');
    const large = document.getElementById('photoLarge');
    const done = () => {
        box.classList.add('hidden');
        const trigger = document.getElementById('photoTrigger');
        if (trigger) trigger.focus({ preventScroll: true });
    };
    const anim = (src && large)
        ? photoFlip(src.getBoundingClientRect(), large.getBoundingClientRect(), true)
        : null;
    if (anim) {
        try {
            anim.finished.then(done).catch(done);
            return;
        } catch (e) { /* fall through */ }
    }
    done();
}

document.getElementById('photoTrigger').onclick = (e) => {
    e.stopPropagation();
    openPhotoLightbox();
};
document.getElementById('photoClose').onclick = () => closePhotoLightbox();
document.getElementById('photoLightboxBackdrop').onclick = () => closePhotoLightbox();
document.getElementById('photoLightbox').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        e.stopPropagation();
        closePhotoLightbox();
    }
});

/* Dock navigation */
document.getElementById('dockHome').onclick = () => {
    showHomeView();
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
};
document.getElementById('dockSearch').onclick = () => {
    showHomeView();
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    searchInput.focus();
};
document.getElementById('dockCompare').onclick = () => {
    if (profileSection.classList.contains('hidden') === false) showHomeView();
    comparisonSection.classList.remove('hidden');
    comparisonSection.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
};

function showHomeView() {
    closeProfileDialog();
    currentPlayer = null;
    profileSection.classList.add('hidden');
    homeMarquee.classList.remove('hidden');
    leaderboardSection.classList.remove('hidden');
}

async function initMarquee() {
    try {
        const res = await fetch(`${API_BASE}/top-scorers`);
        const scorers = await res.json();
        const topScorers = scorers.slice(0, 7);

        if (topScorers.length === 0) return;
        if (!currentPlayer) homeMarquee.classList.remove('hidden');

        const renderCards = () => topScorers.map(s => `
            <div class="marquee-card" onclick="loadPlayer('${s.player_id}', this)">
                <div class="marquee-card-header">
                    <img src="${s.photo_url || fallbackAvatar}" onerror="handleImageError(this)" alt="${s.player}">
                    <div class="marquee-card-info">
                        <h4>${s.player}</h4>
                        <div class="team-badge-row" style="margin:0">
                            ${s.club_logo_url ? `<img src="${s.club_logo_url}" class="club-badge" style="width:16px;height:16px;border:none" onerror="hideEl(this)" alt="">` : ''}
                            <p>${s.team}</p>
                        </div>
                    </div>
                </div>
                <div class="marquee-card-stats">
                    <div class="mq-stat">
                        <span class="mq-val">${s.total_goals || 0}</span>
                        <span class="mq-lbl">Goals</span>
                    </div>
                    <div class="mq-stat">
                        <span class="mq-val">${s.total_assists || 0}</span>
                        <span class="mq-lbl">Assists</span>
                    </div>
                    <div class="mq-stat">
                        <span class="mq-val">${s.total_appearances || 0}</span>
                        <span class="mq-lbl">Apps</span>
                    </div>
                </div>
            </div>
        `).join('');

        marqueeTrack.innerHTML = renderCards() + renderCards();
        marqueeTrack.querySelectorAll('.marquee-card').forEach(makeTrigger);
    } catch (err) {
        console.error("Marquee initialization failed", err);
    }
}

function makeTrigger(el) {
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            el.click();
        }
    };
}

async function fetchLeaderboard(reset = false) {
    if (reset) {
        lbOffset = 0;
        loadedPlayers = [];
        leaderboardList.innerHTML = '';
        const lbErr = document.getElementById('leaderboardError');
        if (lbErr) lbErr.classList.add('hidden');
        leaderboardSkeleton.classList.remove('hidden');
        loadMoreContainer.classList.add('hidden');
    }

    const currentLimit = reset ? INITIAL_LIMIT : PAGE_LIMIT;

    try {
        const res = await fetch(`${API_BASE}/players/leaderboard?sort_by=${lbSortBy}&order=${lbOrder}&limit=${currentLimit}&offset=${lbOffset}`);
        const data = await res.json();

        lbTotal = data.total;
        loadedPlayers = loadedPlayers.concat(data.players);
        lbOffset += data.players.length;

        renderLeaderboard(reset);
    } catch (err) {
        console.error("Failed to load leaderboard", err);
        const lbErr = document.getElementById('leaderboardError');
        if (lbErr) {
            lbErr.classList.remove('hidden');
            refreshIcons();
        }
    } finally {
        leaderboardSkeleton.classList.add('hidden');
    }
}

function renderLeaderboard(reset) {
    if (reset) leaderboardList.innerHTML = '';

    const startIndex = loadedPlayers.length - (lbOffset === INITIAL_LIMIT ? INITIAL_LIMIT : Math.min(PAGE_LIMIT, loadedPlayers.length));

    for (let i = startIndex; i < loadedPlayers.length; i++) {
        const p = loadedPlayers[i];
        const rank = i + 1;

        let primaryStatVal = formatGBP(p.market_value_gbp);
        let primaryStatLbl = "Market Value";

        if (lbSortBy === 'appearances') {
            primaryStatVal = p.total_appearances ?? '-';
            primaryStatLbl = "Appearances";
        } else if (lbSortBy === 'minutes') {
            primaryStatVal = p.total_minutes ? p.total_minutes.toLocaleString() : '-';
            primaryStatLbl = "Minutes";
        } else if (lbSortBy === 'assists') {
            primaryStatVal = p.total_assists ?? '-';
            primaryStatLbl = "Assists";
        } else if (lbSortBy === 'goals') {
            primaryStatVal = p.total_goals ?? '-';
            primaryStatLbl = "Goals";
        }

        const div = document.createElement('div');
        div.className = 'leaderboard-item';
        div.onclick = (e) => loadPlayer(p.player_id, e.currentTarget);
        makeTrigger(div);

        div.innerHTML = `
            <div class="lb-left">
                <span class="lb-rank ${rank <= 3 ? 'lb-rank-top' : ''}">${rank}</span>
                <img src="${p.photo_url || fallbackAvatar}" onerror="handleImageError(this)" class="lb-photo" alt="${p.player}">
                <div class="lb-details">
                    <h4>${p.player}</h4>
                    <div class="team-badge-row" style="margin:0">
                        ${p.club_logo_url ? `<img src="${p.club_logo_url}" class="club-badge" style="width:14px;height:14px;border:none" onerror="hideEl(this)" alt="">` : ''}
                        <p style="margin:0">${p.team} • ${p.position}</p>
                    </div>
                </div>
            </div>
            <div class="lb-stats">
                <div class="lb-stat-column">
                    <span class="lb-stat-val accent-text">${primaryStatVal}</span>
                    <span class="lb-stat-lbl">${primaryStatLbl}</span>
                </div>
                ${lbSortBy !== 'market_value' ? `
                    <div class="lb-stat-column">
                        <span class="lb-stat-val">${formatGBP(p.market_value_gbp)}</span>
                        <span class="lb-stat-lbl">Market Value</span>
                    </div>
                ` : `
                    <div class="lb-stat-column">
                        <span class="lb-stat-val">${p.total_goals ?? 0}</span>
                        <span class="lb-stat-lbl">Goals</span>
                    </div>
                `}
            </div>
        `;
        leaderboardList.appendChild(div);
    }

    if (lbOffset < lbTotal) {
        loadMoreContainer.classList.remove('hidden');
    } else {
        loadMoreContainer.classList.add('hidden');
    }
}

sortSelect.onchange = (e) => {
    lbSortBy = e.target.value;
    fetchLeaderboard(true);
};

/* Segmented order tabs: sliding pill follows the real sort state */
function paintSegTabs() {
    segTabs.setAttribute('data-active', lbOrder);
    segTabs.querySelectorAll('.seg-tab').forEach(btn => {
        const active = btn.dataset.order === lbOrder;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
}

segTabs.querySelectorAll('.seg-tab').forEach(btn => {
    btn.onclick = () => {
        if (lbOrder === btn.dataset.order) return;
        lbOrder = btn.dataset.order;
        paintSegTabs();
        fetchLeaderboard(true);
    };
});
paintSegTabs();

btnLoadMore.onclick = () => fetchLeaderboard(false);

searchInput.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(searchTimeout);

    if (q.length < 2) {
        searchDropdown.style.display = 'none';
        return;
    }

    searchTimeout = setTimeout(async () => {
        try {
            const res = await fetch(`${API_BASE}/players/search?q=${encodeURIComponent(q)}`);
            const data = await res.json();
            renderDropdown(data);
        } catch {
            searchDropdown.style.display = 'none';
        }
    }, 300);
});

document.addEventListener('click', (e) => {
    if (!e.target.closest('#searchContainer')) {
        searchDropdown.style.display = 'none';
    }
});

function renderDropdown(results) {
    searchDropdown.innerHTML = '';
    if (results.length === 0) {
        searchDropdown.innerHTML = `<div style="padding:1rem; text-align:center; color:var(--muted); font-size:0.9rem">No player found.</div>`;
    } else {
        results.forEach(p => {
            const div = document.createElement('div');
            div.className = 'search-item';
            div.innerHTML = `
                <img src="${p.photo_url || fallbackAvatar}" onerror="handleImageError(this)" alt="${p.player}">
                <div>
                    <div class="search-item-name">${p.player}</div>
                    <div class="search-item-team">${p.team}</div>
                </div>
            `;
            div.onclick = (e) => {
                searchInput.value = '';
                searchDropdown.style.display = 'none';
                loadPlayer(p.player_id, e.currentTarget);
            };
            makeTrigger(div);
            searchDropdown.appendChild(div);
        });
    }
    searchDropdown.style.display = 'block';
}

async function loadPlayer(playerId, trigger) {
    errorState.classList.add('hidden');
    profileCard.classList.add('hidden');
    profileSkeleton.style.display = 'block';
    // Render into the dialog immediately so the sheet has size for the morph.
    profileSection.classList.remove('hidden');

    try {
        const res = await fetch(`${API_BASE}/players/${playerId}`);
        if (!res.ok) throw new Error("Player profile unavailable.");
        const player = await res.json();
        renderProfile(player);
    } catch (err) {
        errorMessage.textContent = err.message;
        errorState.classList.remove('hidden');
    } finally {
        profileSkeleton.style.display = 'none';
    }
    openProfileDialog(trigger || null);
}

function renderProfile(player) {
    currentPlayer = player;

    const photoEl = document.getElementById('playerPhoto');
    photoEl.src = player.photo_url || fallbackAvatar;
    photoEl.onerror = () => handleImageError(photoEl);

    document.getElementById('playerName').textContent = player.player;
    document.getElementById('playerTeam').textContent = player.team;

    const badgeEl = document.getElementById('clubBadge');
    if (player.club_logo_url) {
        badgeEl.src = player.club_logo_url;
        badgeEl.classList.remove('hidden');
        badgeEl.onerror = () => hideEl(badgeEl);
    } else {
        badgeEl.classList.add('hidden');
    }

    document.getElementById('playerMeta').textContent = `${player.position} • Latest Season: ${player.season}`;

    const warningBox = document.getElementById('invalidSeasonWarning');
    const statsGrid = document.getElementById('statsGrid');
    const valuationData = document.getElementById('valuationData');

    if (!player.has_valid_season) {
        warningBox.classList.remove('hidden');
        statsGrid.classList.add('hidden');
        valuationData.classList.add('hidden');
        btnCompare.classList.add('hidden');
    } else {
        warningBox.classList.add('hidden');
        statsGrid.classList.remove('hidden');
        valuationData.classList.remove('hidden');
        btnCompare.classList.remove('hidden');

        document.getElementById('statApps').textContent = player.total_appearances ?? '-';
        document.getElementById('statMins').textContent = player.total_minutes ? player.total_minutes.toLocaleString() : '-';
        document.getElementById('statGoals').textContent = player.total_goals ?? '-';
        document.getElementById('statAssists').textContent = player.total_assists ?? '-';

        document.getElementById('valActual').textContent = formatGBP(player.market_value_gbp);
        // Predicted has its own explicit state: genuine nulls (or a backend
        // "unavailable" status) render as Unavailable, never £0.
        const predAvailable = player.prediction_status
            ? player.prediction_status === 'available'
            : player.predicted_value_gbp !== null && player.predicted_value_gbp !== undefined;
        document.getElementById('valPredicted').textContent = predAvailable
            ? formatGBP(player.predicted_value_gbp)
            : 'Unavailable';

        const diffEl = document.getElementById('valDifference');
        // Comparison requires BOTH a verified actual value and a prediction.
        const canCompare = player.comparison_available !== undefined
            ? player.comparison_available === true
            : (player.predicted_value_gbp !== null && player.market_value_gbp !== null);
        if (canCompare && player.market_value_gbp > 0) {
            const diff = player.predicted_value_gbp - player.market_value_gbp;
            const pct = (diff / player.market_value_gbp) * 100;
            const isOver = diff > 0;
            const isExact = diff === 0;

            const icon = isExact ? 'minus' : isOver ? 'trending-up' : 'trending-down';
            const colorClass = isExact ? '' : isOver ? 'diff-up' : 'diff-down';
            const text = isExact ? "Exact match" : `${formatGBP(Math.abs(diff))} (${Math.abs(pct).toFixed(1)}%) ${isOver ? "Overestimated" : "Underestimated"}`;

            diffEl.innerHTML = `<i data-lucide="${icon}" class="diff-icon"></i> <span>${text}</span>`;
            diffEl.className = `val-diff ${colorClass}`;
            refreshIcons();
        } else {
            diffEl.innerHTML = `<span>Comparison unavailable</span>`;
            diffEl.className = `val-diff`;
        }

        updateCompareButtonState();
    }

    profileCard.classList.remove('hidden');
}

/* Morphing compare-button label: quick dip-and-rise on real state changes */
function setCompareText(text) {
    if (btnCompareText.textContent === text) return;
    if (reduceMotion) {
        btnCompareText.textContent = text;
        return;
    }
    btnCompareText.classList.add('morph-swap', 'is-leaving');
    setTimeout(() => {
        btnCompareText.textContent = text;
        btnCompareText.classList.remove('is-leaving');
    }, 160);
}

function updateCompareButtonState() {
    if (!currentPlayer) return;

    if (comparisonList.some(p => p.player_id === currentPlayer.player_id)) {
        btnCompare.disabled = true;
        setCompareText("Added to Comparison");
    } else if (comparisonList.length >= 5) {
        btnCompare.disabled = true;
        setCompareText("Limit Reached (5/5)");
    } else {
        btnCompare.disabled = false;
        setCompareText("Add to Comparison");
    }
}

btnCompare.onclick = () => {
    if (!currentPlayer || !currentPlayer.has_valid_season) return;
    if (comparisonList.length >= 5) return;

    if (!comparisonList.find(p => p.player_id === currentPlayer.player_id)) {
        comparisonList.push(currentPlayer);
        updateComparisonUI();
        updateCompareButtonState();
    }
};

btnClearComp.onclick = () => {
    comparisonList = [];
    updateComparisonUI();
    updateCompareButtonState();
};

/* Comparison search: same dataset/API as global search, adds straight to the chart */
const btnCompSearch = document.getElementById('btnCompSearch');
const compSearchPop = document.getElementById('compSearchPop');
const compSearchInput = document.getElementById('compSearchInput');
const compSearchResults = document.getElementById('compSearchResults');
let compSearchTimeout = null;
let compHighlight = -1;

function syncCompSearch() {
    const full = comparisonList.length >= 5;
    btnCompSearch.disabled = full;
    btnCompSearch.setAttribute('aria-label', full ? 'Comparison is full (5/5)' : 'Search player to compare');
    if (full) closeCompSearch();
}

function openCompSearch() {
    if (btnCompSearch.disabled) return;
    compSearchPop.classList.remove('hidden');
    btnCompSearch.setAttribute('aria-expanded', 'true');
    compSearchInput.value = '';
    compSearchResults.innerHTML = '';
    compHighlight = -1;
    compSearchInput.focus();
}

function closeCompSearch() {
    compSearchPop.classList.add('hidden');
    btnCompSearch.setAttribute('aria-expanded', 'false');
    clearTimeout(compSearchTimeout);
}

btnCompSearch.onclick = () => {
    if (compSearchPop.classList.contains('hidden')) openCompSearch();
    else closeCompSearch();
};

compSearchInput.addEventListener('input', () => {
    const q = compSearchInput.value.trim();
    clearTimeout(compSearchTimeout);
    compHighlight = -1;
    if (q.length < 2) {
        compSearchResults.innerHTML = '';
        return;
    }
    compSearchTimeout = setTimeout(async () => {
        try {
            const res = await fetch(`${API_BASE}/players/search?q=${encodeURIComponent(q)}`);
            renderCompResults(await res.json());
        } catch {
            compSearchResults.innerHTML = `<div class="comp-search-empty">Search failed. Try again.</div>`;
        }
    }, 300);
});

compSearchInput.addEventListener('keydown', (e) => {
    const items = compSearchResults.querySelectorAll('.comp-search-item');
    if (e.key === 'Escape') {
        e.stopPropagation();
        closeCompSearch();
        btnCompSearch.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        compHighlight = e.key === 'ArrowDown'
            ? (compHighlight + 1) % items.length
            : (compHighlight - 1 + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('is-highlight', i === compHighlight));
        items[compHighlight].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && items.length) {
        e.preventDefault();
        (items[Math.max(compHighlight, 0)]).click();
    }
});

document.addEventListener('click', (e) => {
    if (!compSearchPop.classList.contains('hidden')
        && !e.target.closest('#compSearchPop')
        && !e.target.closest('#btnCompSearch')) {
        closeCompSearch();
    }
});

function renderCompResults(results) {
    compHighlight = -1;
    if (!results.length) {
        compSearchResults.innerHTML = `<div class="comp-search-empty">No player found.</div>`;
        return;
    }
    compSearchResults.innerHTML = '';
    results.forEach(p => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'comp-search-item';
        btn.innerHTML = `
            <img src="${p.photo_url || fallbackAvatar}" onerror="handleImageError(this)" alt="${p.player}">
            <span>
                <span class="comp-search-name">${p.player}</span><br>
                <span class="comp-search-sub">${p.team}</span>
            </span>
        `;
        btn.onclick = () => addToComparison(p.player_id);
        compSearchResults.appendChild(btn);
    });
}

async function addToComparison(playerId) {
    if (comparisonList.length >= 5) return;
    if (comparisonList.some(p => p.player_id === String(playerId))) {
        closeCompSearch();
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/players/${playerId}`);
        if (!res.ok) throw new Error();
        const player = await res.json();
        if (!player.has_valid_season) {
            compSearchResults.innerHTML = `<div class="comp-search-empty">${player.player} has no completed season to compare.</div>`;
            return;
        }
        comparisonList.push(player);
        closeCompSearch();
        updateComparisonUI();
        updateCompareButtonState();
    } catch {
        compSearchResults.innerHTML = `<div class="comp-search-empty">Could not add that player. Try again.</div>`;
    }
}

window.removeComparison = function (id) {
    comparisonList = comparisonList.filter(p => p.player_id !== id);
    updateComparisonUI();
    updateCompareButtonState();
};

function updateComparisonUI() {
    compCount.textContent = `(${comparisonList.length}/5)`;
    syncCompSearch();

    if (comparisonList.length === 0) {
        comparisonSection.classList.add('hidden');
        compTags.innerHTML = '';
        return;
    }

    comparisonSection.classList.remove('hidden');
    compTags.innerHTML = comparisonList.map(p => `
        <div class="comp-tag">
            <img src="${p.photo_url || fallbackAvatar}" onerror="handleImageError(this)" alt="${p.player}">
            <span>${p.player}</span>
            <button onclick="removeComparison('${p.player_id}')" aria-label="Remove ${p.player}"><i data-lucide="x"></i></button>
        </div>
    `).join('');
    refreshIcons();
    renderLineChart();
}

function chartTheme() {
    return {
        actual: cssVar('--accent') || '#718f70',
        predicted: cssVar('--primary') || '#8d8f70',
        grid: cssVar('--chart-grid') || 'rgba(128,128,128,0.15)',
        tick: cssVar('--muted') || '#888',
        legend: cssVar('--text') || '#333',
        tipBg: effectiveTheme() === 'light' ? 'rgba(244,244,241,0.97)' : 'rgba(14,14,11,0.95)',
        tipBorder: cssVar('--border') || '#ccc',
    };
}

function renderLineChart() {
    if (typeof Chart === 'undefined') return; // CDN blocked: tags still work, chart skipped
    const ctx = document.getElementById('comparisonChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    const t = chartTheme();

    const labels = comparisonList.map(p => p.player);
    const actualData = comparisonList.map(p => p.market_value_gbp ?? null);
    const predictedData = comparisonList.map(p => p.predicted_value_gbp ?? null);

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Actual Market Value',
                    data: actualData,
                    borderColor: t.actual,
                    backgroundColor: t.actual + '26',
                    borderWidth: 3,
                    pointBackgroundColor: t.actual,
                    pointBorderColor: t.actual,
                    pointBorderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 8,
                    fill: true,
                    tension: 0.3
                },
                {
                    label: 'Predicted Market Value',
                    data: predictedData,
                    borderColor: t.predicted,
                    backgroundColor: t.predicted + '26',
                    borderWidth: 3,
                    pointBackgroundColor: t.predicted,
                    pointBorderColor: t.predicted,
                    pointBorderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 8,
                    fill: true,
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: t.grid },
                    ticks: {
                        color: t.tick,
                        font: { family: "'Inter', sans-serif" },
                        callback: function (value) { return '£' + (value / 1000000) + 'M'; }
                    },
                    border: { display: false }
                },
                x: {
                    grid: { display: false },
                    ticks: {
                        color: t.legend,
                        font: { family: "'Inter', sans-serif", weight: '500' }
                    },
                    border: { display: false }
                }
            },
            plugins: {
                legend: {
                    labels: {
                        color: t.legend,
                        font: { family: "'Inter', sans-serif", size: 13 },
                        usePointStyle: true,
                        boxWidth: 8
                    }
                },
                tooltip: {
                    backgroundColor: t.tipBg,
                    titleColor: t.legend,
                    bodyColor: t.legend,
                    titleFont: { family: "'Inter', sans-serif", size: 14 },
                    bodyFont: { family: "'Inter', sans-serif", size: 13 },
                    padding: 12,
                    borderColor: t.tipBorder,
                    borderWidth: 1,
                    callbacks: {
                        label: function (context) {
                            return context.dataset.label + ': ' + formatGBP(context.raw);
                        }
                    }
                }
            }
        }
    });
}

/* Boot is handled above (core first, decorations last). */
