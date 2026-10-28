/**
 * MAL Affinity Explorer - Client-side Engine
 * Calculates Pearson Correlation Coefficient on mutually rated anime between MAL users.
 */

// State management
const state = {
    targetUser: '',
    targetList: new Map(), // anime_id -> { id, title, score, status, image }
    candidates: [],        // array of username strings
    results: [],           // array of AffinityResult objects
    isRunning: false,
    abortController: null,
    settings: {
        minShared: 10,
        maxCandidates: 30,
        requestDelay: 400, // ms between requests
        proxyUrl: 'local', // 'local', 'cf-worker', 'custom', 'direct'
        customProxyUrl: '',
        discoverySources: ['friends', 'top_anime', 'online'],
        sortBy: 'weighted', // 'weighted', 'affinity', 'shared', 'diff'
    }
};

// Available default proxy endpoints
const PROXIES = {
    local: 'http://localhost:8000/api/proxy?url=',
    custom: '',
    direct: '',
};

// System usernames to ignore
const EXCLUDED_USERNAMES = new Set([
    'login', 'register', 'logout', 'about', 'terms', 'privacy', 'help',
    'support', 'contact', 'forum', 'news', 'clubs', 'search', 'api', 'edit',
    'profile', 'anime', 'manga', 'character', 'people', 'users'
]);

/**
 * Builds proxied URL based on current settings
 */
function buildProxiedUrl(targetUrl) {
    const proxyMode = state.settings.proxyUrl;
    if (proxyMode === 'direct') {
        return targetUrl;
    }
    if (proxyMode === 'custom') {
        const base = state.settings.customProxyUrl.trim();
        if (!base) return targetUrl;
        return base.includes('?url=') ? `${base}${encodeURIComponent(targetUrl)}` : `${base}${targetUrl}`;
    }
    if (proxyMode === 'local') {
        return `${PROXIES.local}${encodeURIComponent(targetUrl)}`;
    }
    return targetUrl;
}

/**
 * Fetch wrapper with timeout, proxy and rate limiting
 */
async function fetchWithProxy(url, asJson = true, timeoutMs = 12000) {
    const proxied = buildProxiedUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const resp = await fetch(proxied, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json, text/html, */*'
            }
        });
        clearTimeout(timeout);

        if (!resp.ok) {
            if (resp.status === 400 || resp.status === 404) return null; // private list or 404
            throw new Error(`HTTP ${resp.status}`);
        }

        if (asJson) {
            return await resp.json();
        }
        return await resp.text();
    } catch (e) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') {
            throw new Error('Request timed out');
        }
        throw e;
    }
}

/**
 * Sleep helper
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pearson Correlation Coefficient
 * Returns r in range [-1.0, 1.0], or 0 if variance is zero or shared < 2
 */
function calculatePearson(x, y) {
    const n = x.length;
    if (n < 2) return 0;

    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let num = 0;
    let denX = 0;
    let denY = 0;

    for (let i = 0; i < n; i++) {
        const dx = x[i] - meanX;
        const dy = y[i] - meanY;
        num += dx * dy;
        denX += dx * dx;
        denY += dy * dy;
    }

    if (denX <= 0 || denY <= 0) return 0;

    const r = num / Math.sqrt(denX * denY);
    return Math.max(-1.0, Math.min(1.0, r));
}

/**
 * Fetches user's anime list with pagination
 */
async function fetchUserAnimeList(username, onProgress = null) {
    const animeMap = new Map();
    let offset = 0;
    let page = 1;

    while (true) {
        if (!state.isRunning) break;
        if (onProgress) onProgress(`Fetching ${username}'s anime list (page ${page})...`);

        const url = `https://myanimelist.net/animelist/${encodeURIComponent(username)}/load.json?offset=${offset}&status=7`;
        let data = null;

        try {
            data = await fetchWithProxy(url, true);
        } catch (err) {
            console.warn(`Error fetching list for ${username}:`, err);
            return null;
        }

        if (!data || !Array.isArray(data) || data.length === 0) {
            break;
        }

        for (const item of data) {
            const score = parseInt(item.score, 10) || 0;
            const animeId = parseInt(item.anime_id, 10);
            animeMap.set(animeId, {
                id: animeId,
                title: item.anime_title || '',
                titleEng: item.anime_title_eng || '',
                score: score,
                status: parseInt(item.status, 10) || 0,
                image: item.anime_image_path || '',
            });
        }

        offset += data.length;
        page++;

        if (data.length < 300) {
            break;
        }

        await sleep(state.settings.requestDelay);
    }

    return animeMap;
}

/**
 * Discovers candidate users from friends
 */
async function discoverFriends(username, maxFriends = 100) {
    const candidates = new Set();
    let offset = 0;

    while (candidates.size < maxFriends && state.isRunning) {
        const url = `https://myanimelist.net/profile/${encodeURIComponent(username)}/friends?offset=${offset}`;
        try {
            const html = await fetchWithProxy(url, false);
            if (!html) break;

            const matches = [...html.matchAll(/\/profile\/([a-zA-Z0-9_-]+)/g)];
            let newFound = 0;
            for (const m of matches) {
                const u = m[1];
                if (u.toLowerCase() !== username.toLowerCase() && !EXCLUDED_USERNAMES.has(u.toLowerCase())) {
                    if (!candidates.has(u)) {
                        candidates.add(u);
                        newFound++;
                    }
                }
            }

            offset += 100;
            if (newFound < 10) break;
            await sleep(state.settings.requestDelay);
        } catch (e) {
            break;
        }
    }

    return Array.from(candidates);
}

/**
 * Discovers candidates who loved (recommended/reviewed) the target's top rated anime
 */
async function discoverFromTopAnime(targetList, maxPerAnime = 50) {
    const topAnime = Array.from(targetList.values())
        .filter(a => a.score >= 9)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

    const candidates = new Set();

    for (const anime of topAnime) {
        if (!state.isRunning) break;
        const slug = anime.title.replace(/[^a-zA-Z0-9_]+/g, '_') || 'anime';

        // 1. User Recommendations
        const recsUrl = `https://myanimelist.net/anime/${anime.id}/${encodeURIComponent(slug)}/userrecs`;
        try {
            const html = await fetchWithProxy(recsUrl, false);
            if (html) {
                const matches = [...html.matchAll(/\/profile\/([a-zA-Z0-9_-]+)/g)];
                for (const m of matches) {
                    const u = m[1];
                    if (!EXCLUDED_USERNAMES.has(u.toLowerCase()) && u.toLowerCase() !== state.targetUser.toLowerCase()) {
                        candidates.add(u);
                        if (candidates.size >= 150) break;
                    }
                }
            }
        } catch (e) {
            console.warn('Error fetching recs:', e);
        }

        await sleep(state.settings.requestDelay);
    }

    return Array.from(candidates);
}

/**
 * Discovers currently online / active users
 */
async function discoverOnlineUsers() {
    const candidates = new Set();
    const url = 'https://myanimelist.net/users.php';
    try {
        const html = await fetchWithProxy(url, false);
        if (html) {
            const matches = [...html.matchAll(/\/profile\/([a-zA-Z0-9_-]+)/g)];
            for (const m of matches) {
                const u = m[1];
                if (!EXCLUDED_USERNAMES.has(u.toLowerCase()) && u.toLowerCase() !== state.targetUser.toLowerCase()) {
                    candidates.add(u);
                }
            }
        }
    } catch (e) {
        console.warn('Error fetching online users:', e);
    }
    return Array.from(candidates);
}

/**
 * Calculates detailed affinity metrics between target and candidate list
 */
function computeAffinityMetrics(candidateUser, candidateList) {
    const targetMap = state.targetList;
    const sharedIds = [];

    for (const [id, cEntry] of candidateList.entries()) {
        if (cEntry.score > 0 && targetMap.has(id)) {
            const tEntry = targetMap.get(id);
            if (tEntry.score > 0) {
                sharedIds.push(id);
            }
        }
    }

    const sharedCount = sharedIds.length;
    if (sharedCount < 2) {
        return {
            candidateUser,
            affinity: 0,
            sharedCount,
            meanDiff: 0,
            weightedAffinity: 0,
            favorites: [],
            disagreements: [],
            recommendations: [],
            allShared: []
        };
    }

    const x = sharedIds.map(id => targetMap.get(id).score);
    const y = sharedIds.map(id => candidateList.get(id).score);

    const r = calculatePearson(x, y);
    const affinityPct = r * 100.0;

    let totalDiff = 0;
    const allShared = [];
    const favorites = [];
    const disagreements = [];

    for (let i = 0; i < sharedCount; i++) {
        const id = sharedIds[i];
        const tScore = x[i];
        const cScore = y[i];
        const diff = Math.abs(tScore - cScore);
        totalDiff += diff;

        const entry = targetMap.get(id) || candidateList.get(id);
        const item = {
            id,
            title: entry.title,
            targetScore: tScore,
            candidateScore: cScore,
            diff,
            image: entry.image
        };

        allShared.push(item);

        if (tScore >= 8 && cScore >= 8) {
            favorites.push(item);
        }
        if (diff >= 2) {
            disagreements.push(item);
        }
    }

    const meanDiff = totalDiff / sharedCount;

    // Bayesian shrinkage weight: k = 15
    const k = 15;
    const weight = sharedCount / (sharedCount + k);
    const weightedAffinity = affinityPct * weight;

    favorites.sort((a, b) => (b.targetScore + b.candidateScore) - (a.targetScore + a.candidateScore));
    disagreements.sort((a, b) => b.diff - a.diff);
    allShared.sort((a, b) => a.diff - b.diff);

    // Unwatched recommendations from candidate (candidate score >= 8)
    const recommendations = [];
    for (const [id, cEntry] of candidateList.entries()) {
        if (cEntry.score >= 8) {
            const tEntry = targetMap.get(id);
            if (!tEntry || tEntry.score === 0) {
                recommendations.push({
                    id: cEntry.id,
                    title: cEntry.title,
                    titleEng: cEntry.titleEng,
                    score: cEntry.score,
                    image: cEntry.image
                });
            }
        }
    }
    recommendations.sort((a, b) => b.score - a.score);

    return {
        candidateUser,
        affinity: affinityPct,
        sharedCount,
        meanDiff,
        weightedAffinity,
        favorites,
        disagreements,
        recommendations,
        allShared
    };
}

/**
 * UI Controller & Rendering
 */
document.addEventListener('DOMContentLoaded', () => {
    initUI();
});

function initUI() {
    const scanBtn = document.getElementById('btn-scan');
    const stopBtn = document.getElementById('btn-stop');
    const usernameInput = document.getElementById('input-username');
    const testProxyBtn = document.getElementById('btn-test-proxy');

    scanBtn.addEventListener('click', startScan);
    stopBtn.addEventListener('click', stopScan);
    testProxyBtn.addEventListener('click', testProxyConnection);

    // Filter controls
    document.getElementById('select-sort').addEventListener('change', updateTable);
    document.getElementById('input-min-shared').addEventListener('input', (e) => {
        document.getElementById('label-min-shared').textContent = e.target.value;
        updateTable();
    });
    document.getElementById('input-search').addEventListener('input', updateTable);
    document.getElementById('select-proxy').addEventListener('change', handleProxyChange);

    // Export buttons
    document.getElementById('btn-export-json').addEventListener('click', exportJSON);
    document.getElementById('btn-export-csv').addEventListener('click', exportCSV);

    // Modal close
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-backdrop').addEventListener('click', closeModal);
}

function handleProxyChange(e) {
    const val = e.target.value;
    state.settings.proxyUrl = val;
    const customContainer = document.getElementById('container-custom-proxy');
    if (val === 'custom') {
        customContainer.classList.remove('hidden');
    } else {
        customContainer.classList.add('hidden');
    }
}

async function testProxyConnection() {
    const statusEl = document.getElementById('proxy-status');
    statusEl.innerHTML = '<span class="text-blue-400">Testing connection to MAL...</span>';

    const customInput = document.getElementById('input-custom-proxy').value.trim();
    if (customInput) state.settings.customProxyUrl = customInput;

    const testUrl = 'https://myanimelist.net/animelist/Xinil/load.json?offset=0&status=7';
    try {
        const start = performance.now();
        const data = await fetchWithProxy(testUrl, true, 8000);
        const duration = Math.round(performance.now() - start);

        if (Array.isArray(data) && data.length > 0) {
            statusEl.innerHTML = `<span class="text-green-400 font-semibold">OK! Connected in ${duration}ms (${data.length} items parsed)</span>`;
        } else {
            statusEl.innerHTML = '<span class="text-yellow-400">Warning: MAL returned unexpected format.</span>';
        }
    } catch (err) {
        statusEl.innerHTML = `<span class="text-red-400 font-semibold">Failed: ${err.message}. Check proxy setup or start local server.</span>`;
    }
}

function setStatus(text, progressPct = null) {
    const statusText = document.getElementById('status-text');
    const progressBar = document.getElementById('progress-bar');
    statusText.textContent = text;
    if (progressPct !== null) {
        progressBar.style.width = `${Math.min(100, Math.max(0, progressPct))}%`;
    }
}

async function startScan() {
    const usernameInput = document.getElementById('input-username');
    const username = usernameInput.value.trim();
    if (!username) {
        alert('Please enter a MyAnimeList username');
        usernameInput.focus();
        return;
    }

    state.targetUser = username;
    state.isRunning = true;
    state.results = [];
    state.candidates = [];

    // Read UI configuration
    state.settings.maxCandidates = parseInt(document.getElementById('input-max-users').value, 10) || 30;
    state.settings.minShared = parseInt(document.getElementById('input-min-shared').value, 10) || 10;
    state.settings.customProxyUrl = document.getElementById('input-custom-proxy').value.trim();

    // Toggle UI controls
    document.getElementById('btn-scan').classList.add('hidden');
    document.getElementById('btn-stop').classList.remove('hidden');
    document.getElementById('progress-card').classList.remove('hidden');
    document.getElementById('results-section').classList.remove('hidden');

    setStatus(`Fetching profile for @${username}...`, 5);

    try {
        // Step 1: Fetch target user's anime list
        const targetList = await fetchUserAnimeList(username, (msg) => setStatus(msg, 10));
        if (!targetList || targetList.size === 0) {
            alert(`Could not load anime list for "${username}". Either the list is private, user does not exist, or proxy is blocked.`);
            stopScan();
            return;
        }

        state.targetList = targetList;
        const scoredCount = Array.from(targetList.values()).filter(a => a.score > 0).length;
        setStatus(`Loaded @${username}'s list (${scoredCount} scored anime). Discovering candidate users...`, 20);

        // Step 2: Candidate Discovery
        const candidateSet = new Set();

        // Custom candidates if provided
        const customCandidatesText = document.getElementById('input-custom-candidates').value.trim();
        if (customCandidatesText) {
            const list = customCandidatesText.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
            list.forEach(u => candidateSet.add(u));
        }

        // Friends
        if (document.getElementById('check-friends').checked && candidateSet.size < state.settings.maxCandidates) {
            setStatus('Searching friends list for candidates...', 25);
            const friends = await discoverFriends(username, 60);
            friends.forEach(u => candidateSet.add(u));
        }

        // Top Anime fans
        if (document.getElementById('check-top-anime').checked && candidateSet.size < state.settings.maxCandidates) {
            setStatus('Searching fans of your top-rated anime...', 35);
            const topFans = await discoverFromTopAnime(targetList, 50);
            topFans.forEach(u => candidateSet.add(u));
        }

        // Online users
        if (document.getElementById('check-online').checked && candidateSet.size < state.settings.maxCandidates) {
            setStatus('Checking currently active / online MAL users...', 45);
            const onlineUsers = await discoverOnlineUsers();
            onlineUsers.forEach(u => candidateSet.add(u));
        }

        candidateSet.delete(username);
        const candidateList = Array.from(candidateSet).slice(0, state.settings.maxCandidates);
        state.candidates = candidateList;

        if (candidateList.length === 0) {
            setStatus('No candidate users found to evaluate.', 100);
            stopScan();
            return;
        }

        setStatus(`Found ${candidateList.length} candidate users. Calculating affinities...`, 50);

        // Step 3: Evaluate candidates one by one
        let processed = 0;
        for (const candUser of candidateList) {
            if (!state.isRunning) break;

            processed++;
            const pct = 50 + Math.round((processed / candidateList.length) * 50);
            setStatus(`Evaluating ${processed}/${candidateList.length}: @${candUser}...`, pct);

            try {
                const candList = await fetchUserAnimeList(candUser);
                if (candList && candList.size > 0) {
                    const metrics = computeAffinityMetrics(candUser, candList);
                    if (metrics.sharedCount >= 2) {
                        state.results.push(metrics);
                        updateTable();
                    }
                }
            } catch (err) {
                console.warn(`Error evaluating ${candUser}:`, err);
            }

            await sleep(state.settings.requestDelay);
        }

        setStatus(`Completed! Evaluated ${processed} candidates. Found ${state.results.length} with shared scores.`, 100);
    } catch (err) {
        console.error(err);
        setStatus(`Error during scan: ${err.message}`, 100);
    } finally {
        stopScan();
    }
}

function stopScan() {
    state.isRunning = false;
    document.getElementById('btn-scan').classList.remove('hidden');
    document.getElementById('btn-stop').classList.add('hidden');
}

/**
 * Updates Leaderboard Table
 */
function updateTable() {
    const tbody = document.getElementById('table-body');
    const sortBy = document.getElementById('select-sort').value;
    const minShared = parseInt(document.getElementById('input-min-shared').value, 10) || 0;
    const query = document.getElementById('input-search').value.toLowerCase().trim();

    // Filter
    let filtered = state.results.filter(r => r.sharedCount >= minShared);
    if (query) {
        filtered = filtered.filter(r => r.candidateUser.toLowerCase().includes(query));
    }

    // Sort
    filtered.sort((a, b) => {
        if (sortBy === 'weighted') return b.weightedAffinity - a.weightedAffinity;
        if (sortBy === 'affinity') return b.affinity - a.affinity;
        if (sortBy === 'shared') return b.sharedCount - a.sharedCount;
        if (sortBy === 'diff') return a.meanDiff - b.meanDiff;
        return 0;
    });

    document.getElementById('match-count').textContent = `${filtered.length} matched`;

    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" class="text-center py-8 text-gray-500">
                    No users meet current filter (min shared: ${minShared}).
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filtered.map((item, index) => {
        const affVal = item.affinity;
        let affColor = 'text-gray-400';
        let affBadge = 'bg-gray-800 text-gray-300';

        if (affVal >= 70) {
            affColor = 'text-green-400 font-bold';
            affBadge = 'bg-green-900/60 text-green-300 border border-green-700/50';
        } else if (affVal >= 40) {
            affColor = 'text-emerald-400 font-semibold';
            affBadge = 'bg-emerald-900/50 text-emerald-300 border border-emerald-700/40';
        } else if (affVal >= 15) {
            affColor = 'text-blue-400';
            affBadge = 'bg-blue-900/50 text-blue-300 border border-blue-700/40';
        } else if (affVal >= 0) {
            affColor = 'text-yellow-400';
            affBadge = 'bg-yellow-900/40 text-yellow-300 border border-yellow-700/30';
        } else {
            affColor = 'text-red-400';
            affBadge = 'bg-red-900/40 text-red-300 border border-red-700/30';
        }

        const sign = affVal > 0 ? '+' : '';
        const weightedSign = item.weightedAffinity > 0 ? '+' : '';

        return `
            <tr class="border-b border-gray-800 hover:bg-gray-800/40 transition cursor-pointer" onclick="openDetailsModal('${item.candidateUser}')">
                <td class="py-3 px-4 text-center font-bold text-gray-500">#${index + 1}</td>
                <td class="py-3 px-4 font-semibold text-white flex items-center gap-2">
                    <a href="https://myanimelist.net/profile/${item.candidateUser}" target="_blank" rel="noopener" class="text-blue-400 hover:underline flex items-center gap-1" onclick="event.stopPropagation()">
                        ${item.candidateUser}
                        <svg class="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
                    </a>
                </td>
                <td class="py-3 px-4 text-center">
                    <span class="inline-block px-2.5 py-1 rounded-full text-xs font-bold ${affBadge}">
                        ${sign}${affVal.toFixed(1)}%
                    </span>
                </td>
                <td class="py-3 px-4 text-center text-sm font-semibold text-purple-300">
                    ${weightedSign}${item.weightedAffinity.toFixed(1)}%
                </td>
                <td class="py-3 px-4 text-center text-sm text-gray-300">
                    <span class="font-bold text-white">${item.sharedCount}</span>
                </td>
                <td class="py-3 px-4 text-center text-sm text-gray-400">
                    ${item.meanDiff.toFixed(2)} pts
                </td>
                <td class="py-3 px-4 text-center">
                    <button class="px-3 py-1 bg-blue-600/30 hover:bg-blue-600 text-blue-300 hover:text-white rounded text-xs transition border border-blue-500/40">
                        View Details
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * Modal Inspection
 */
function openDetailsModal(username) {
    const item = state.results.find(r => r.candidateUser === username);
    if (!item) return;

    document.getElementById('modal-title').textContent = `@${state.targetUser} vs @${item.candidateUser}`;
    document.getElementById('modal-sub').textContent = `Affinity: ${item.affinity.toFixed(1)}% | Shared: ${item.sharedCount} anime | Avg Difference: ${item.meanDiff.toFixed(2)} pts`;

    // Render Shared Favorites
    const favsEl = document.getElementById('modal-favs');
    if (item.favorites.length > 0) {
        favsEl.innerHTML = item.favorites.map(f => `
            <div class="flex items-center justify-between p-2 rounded bg-gray-800/60 border border-gray-700/50">
                <a href="https://myanimelist.net/anime/${f.id}" target="_blank" class="text-sm font-medium text-white hover:text-blue-400 truncate max-w-[280px]">
                    ${f.title}
                </a>
                <div class="flex items-center gap-2 text-xs">
                    <span class="px-2 py-0.5 bg-blue-900/60 text-blue-300 rounded font-bold">You: ${f.targetScore}</span>
                    <span class="px-2 py-0.5 bg-purple-900/60 text-purple-300 rounded font-bold">Them: ${f.candidateScore}</span>
                </div>
            </div>
        `).join('');
    } else {
        favsEl.innerHTML = '<p class="text-xs text-gray-500">No mutual favorites (rated 8-10) found.</p>';
    }

    // Render Disagreements
    const disagEl = document.getElementById('modal-disagreements');
    if (item.disagreements.length > 0) {
        disagEl.innerHTML = item.disagreements.slice(0, 8).map(d => `
            <div class="flex items-center justify-between p-2 rounded bg-gray-800/60 border border-gray-700/50">
                <a href="https://myanimelist.net/anime/${d.id}" target="_blank" class="text-sm font-medium text-white hover:text-blue-400 truncate max-w-[280px]">
                    ${d.title}
                </a>
                <div class="flex items-center gap-2 text-xs">
                    <span class="px-2 py-0.5 bg-blue-900/60 text-blue-300 rounded">You: ${d.targetScore}</span>
                    <span class="px-2 py-0.5 bg-purple-900/60 text-purple-300 rounded">Them: ${d.candidateScore}</span>
                    <span class="px-2 py-0.5 bg-red-900/60 text-red-300 rounded font-bold">Δ ${d.diff}</span>
                </div>
            </div>
        `).join('');
    } else {
        disagEl.innerHTML = '<p class="text-xs text-gray-500">No major disagreements (difference >= 2) found.</p>';
    }

    // Render Recommendations
    const recsEl = document.getElementById('modal-recs');
    if (item.recommendations.length > 0) {
        recsEl.innerHTML = item.recommendations.slice(0, 8).map(r => `
            <div class="flex items-center justify-between p-2 rounded bg-gray-800/60 border border-gray-700/50">
                <a href="https://myanimelist.net/anime/${r.id}" target="_blank" class="text-sm font-medium text-white hover:text-blue-400 truncate max-w-[300px]">
                    ${r.title}
                </a>
                <span class="px-2 py-0.5 bg-green-900/60 text-green-300 rounded text-xs font-bold">
                    Rated ${r.score}/10
                </span>
            </div>
        `).join('');
    } else {
        recsEl.innerHTML = '<p class="text-xs text-gray-500">No new recommendations available from this user.</p>';
    }

    document.getElementById('modal').classList.remove('hidden');
}

function closeModal() {
    document.getElementById('modal').classList.add('hidden');
}

/**
 * Export helpers
 */
function exportJSON() {
    if (state.results.length === 0) return alert('No results to export.');
    const blob = new Blob([JSON.stringify(state.results, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mal_affinity_${state.targetUser}.json`;
    a.click();
}

function exportCSV() {
    if (state.results.length === 0) return alert('No results to export.');
    const headers = ['Rank', 'Candidate', 'Affinity(%)', 'WeightedAffinity(%)', 'SharedCount', 'MeanDifference'];
    const rows = state.results.map((r, i) => [
        i + 1,
        r.candidateUser,
        r.affinity.toFixed(2),
        r.weightedAffinity.toFixed(2),
        r.sharedCount,
        r.meanDiff.toFixed(2)
    ]);
    const csvContent = [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mal_affinity_${state.targetUser}.csv`;
    a.click();
}
