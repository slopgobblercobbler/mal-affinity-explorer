/**
 * MAL Affinity Explorer - Client-side Engine with IndexedDB Cache & Multi-Source Scraper
 * Calculates Pearson Correlation Coefficient on mutually rated anime between MAL users.
 */

// IndexedDB Persistent Storage Layer
class MALStorage {
    constructor(dbName = 'MALAffinityDB', version = 1) {
        this.dbName = dbName;
        this.version = version;
        this.db = null;
    }

    async init() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, this.version);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('profiles')) {
                    db.createObjectStore('profiles', { keyPath: 'username' });
                }
                if (!db.objectStoreNames.contains('affinities')) {
                    const affStore = db.createObjectStore('affinities', { keyPath: 'id' });
                    affStore.createIndex('targetUser', 'targetUser', { unique: false });
                }
            };
            req.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async getProfile(username) {
        await this.init();
        const key = username.trim().toLowerCase();
        return new Promise((resolve) => {
            const tx = this.db.transaction('profiles', 'readonly');
            const store = tx.objectStore('profiles');
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    }

    async saveProfile(username, list, isPrivate = false, notFound = false) {
        await this.init();
        const key = username.trim().toLowerCase();
        return new Promise((resolve) => {
            const tx = this.db.transaction('profiles', 'readwrite');
            const store = tx.objectStore('profiles');
            const data = {
                username: key,
                originalName: username.trim(),
                list: list || [],
                scoredCount: list ? list.filter(a => a.score > 0).length : 0,
                isPrivate: Boolean(isPrivate),
                notFound: Boolean(notFound),
                updatedAt: Date.now()
            };
            store.put(data);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    }

    async getAffinity(targetUser, candidateUser) {
        await this.init();
        const id = `${targetUser.trim().toLowerCase()}::${candidateUser.trim().toLowerCase()}`;
        return new Promise((resolve) => {
            const tx = this.db.transaction('affinities', 'readonly');
            const store = tx.objectStore('affinities');
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    }

    async saveAffinity(targetUser, candidateUser, metrics) {
        await this.init();
        const tKey = targetUser.trim().toLowerCase();
        const cKey = candidateUser.trim().toLowerCase();
        const id = `${tKey}::${cKey}`;
        return new Promise((resolve) => {
            const tx = this.db.transaction('affinities', 'readwrite');
            const store = tx.objectStore('affinities');
            const record = {
                id,
                targetUser: tKey,
                candidateUser: candidateUser.trim(),
                affinity: metrics.affinity,
                weightedAffinity: metrics.weightedAffinity,
                sharedCount: metrics.sharedCount,
                meanDiff: metrics.meanDiff,
                favorites: metrics.favorites || [],
                disagreements: metrics.disagreements || [],
                recommendations: metrics.recommendations || [],
                allShared: metrics.allShared || [],
                updatedAt: Date.now()
            };
            store.put(record);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    }

    async getAllAffinities(targetUser) {
        await this.init();
        const tKey = targetUser.trim().toLowerCase();
        return new Promise((resolve) => {
            const tx = this.db.transaction('affinities', 'readonly');
            const store = tx.objectStore('affinities');
            const idx = store.index('targetUser');
            const req = idx.getAll(tKey);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    }

    async getAllEvaluatedUsernames(targetUser) {
        const records = await this.getAllAffinities(targetUser);
        const set = new Set();
        for (const r of records) {
            set.add(r.candidateUser.toLowerCase());
        }
        return set;
    }

    async getStats() {
        await this.init();
        return new Promise((resolve) => {
            const tx = this.db.transaction(['profiles', 'affinities'], 'readonly');
            const pStore = tx.objectStore('profiles');
            const aStore = tx.objectStore('affinities');
            const pReq = pStore.count();
            const aReq = aStore.count();
            tx.oncomplete = () => {
                resolve({
                    profiles: pReq.result || 0,
                    affinities: aReq.result || 0
                });
            };
            tx.onerror = () => resolve({ profiles: 0, affinities: 0 });
        });
    }

    async clearAll() {
        await this.init();
        return new Promise((resolve) => {
            const tx = this.db.transaction(['profiles', 'affinities'], 'readwrite');
            tx.objectStore('profiles').clear();
            tx.objectStore('affinities').clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    }

    async exportJSON() {
        await this.init();
        return new Promise((resolve) => {
            const tx = this.db.transaction(['profiles', 'affinities'], 'readonly');
            const pReq = tx.objectStore('profiles').getAll();
            const aReq = tx.objectStore('affinities').getAll();
            tx.oncomplete = () => {
                const dump = {
                    version: 1,
                    exportedAt: new Date().toISOString(),
                    profiles: pReq.result || [],
                    affinities: aReq.result || []
                };
                resolve(JSON.stringify(dump, null, 2));
            };
            tx.onerror = () => resolve('{}');
        });
    }

    async importJSON(jsonStr) {
        await this.init();
        const data = JSON.parse(jsonStr);
        if (!data.profiles && !data.affinities) {
            throw new Error('Invalid database backup format.');
        }
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['profiles', 'affinities'], 'readwrite');
            const pStore = tx.objectStore('profiles');
            const aStore = tx.objectStore('affinities');
            if (Array.isArray(data.profiles)) {
                for (const p of data.profiles) pStore.put(p);
            }
            if (Array.isArray(data.affinities)) {
                for (const a of data.affinities) aStore.put(a);
            }
            tx.oncomplete = () => resolve(true);
            tx.onerror = (e) => reject(e.target.error);
        });
    }
}

// Global Storage Instance
const storage = new MALStorage();

// State management
const state = {
    targetUser: '',
    targetList: new Map(), // anime_id -> { id, title, score, status, image }
    candidates: [],        // array of username strings
    results: [],           // array of AffinityResult objects
    isRunning: false,
    settings: {
        minShared: 10,
        maxCandidates: 30,
        requestDelay: 400, // ms between requests
        proxyUrl: 'local', // 'local', 'custom', 'direct'
        customProxyUrl: '',
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
    'profile', 'anime', 'manga', 'character', 'people', 'users', 'removed-user'
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
 * Fetches user's anime list with IndexedDB caching and pagination
 */
async function fetchUserAnimeList(username, onProgress = null, forceRefresh = false) {
    const cleanUser = username.trim();
    if (!cleanUser) return null;

    // Check IndexedDB cache first to avoid re-querying!
    if (!forceRefresh) {
        const cached = await storage.getProfile(cleanUser);
        if (cached) {
            if (cached.isPrivate || cached.notFound) {
                return null; // Known private or 404: skip without network calls!
            }
            if (Array.isArray(cached.list) && cached.list.length > 0) {
                const animeMap = new Map();
                for (const item of cached.list) {
                    animeMap.set(item.id, item);
                }
                return animeMap;
            }
        }
    }

    const animeMap = new Map();
    let offset = 0;
    let page = 1;

    while (true) {
        if (!state.isRunning) break;
        if (onProgress) onProgress(`Fetching @${cleanUser}'s anime list (page ${page})...`);

        const url = `https://myanimelist.net/animelist/${encodeURIComponent(cleanUser)}/load.json?offset=${offset}&status=7`;
        let data = null;

        try {
            data = await fetchWithProxy(url, true);
        } catch (err) {
            console.warn(`Error fetching list for ${cleanUser}:`, err);
            return null;
        }

        if (data === null || !Array.isArray(data)) {
            // Private list or 404: remember in cache so we never look up again!
            await storage.saveProfile(cleanUser, [], true, false);
            return null;
        }

        if (data.length === 0) {
            if (offset === 0) {
                // Empty list
                await storage.saveProfile(cleanUser, [], false, true);
                return null;
            }
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

    // Save list to IndexedDB
    const listArray = Array.from(animeMap.values());
    await storage.saveProfile(cleanUser, listArray, false, false);
    return animeMap;
}

// ==========================================
// Candidate Discovery Channels
// ==========================================

/**
 * 1. Direct Friends
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
 * 2. Friends-of-Friends (2nd-degree social network)
 */
async function discoverFriendsOfFriends(username, maxDirectFriends = 4, maxFof = 80) {
    const directFriends = await discoverFriends(username, maxDirectFriends);
    const candidates = new Set();

    for (const friend of directFriends) {
        if (!state.isRunning || candidates.size >= maxFof) break;
        const url = `https://myanimelist.net/profile/${encodeURIComponent(friend)}/friends`;
        try {
            const html = await fetchWithProxy(url, false);
            if (html) {
                const matches = [...html.matchAll(/\/profile\/([a-zA-Z0-9_-]+)/g)];
                for (const m of matches) {
                    const u = m[1];
                    if (
                        u.toLowerCase() !== username.toLowerCase() &&
                        u.toLowerCase() !== friend.toLowerCase() &&
                        !EXCLUDED_USERNAMES.has(u.toLowerCase())
                    ) {
                        candidates.add(u);
                        if (candidates.size >= maxFof) break;
                    }
                }
            }
            await sleep(state.settings.requestDelay);
        } catch (e) {
            // continue next friend
        }
    }

    return Array.from(candidates);
}

/**
 * 3. Fans & Reviewers of User's Top Rated Anime (9-10/10)
 */
async function discoverFromTopAnime(targetList, maxPerAnime = 40) {
    const topAnime = Array.from(targetList.values())
        .filter(a => a.score >= 9)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

    const candidates = new Set();

    for (const anime of topAnime) {
        if (!state.isRunning) break;
        const slug = anime.title.replace(/[^a-zA-Z0-9_]+/g, '_') || 'anime';

        // User Recommendations
        const recsUrl = `https://myanimelist.net/anime/${anime.id}/${encodeURIComponent(slug)}/userrecs`;
        try {
            const html = await fetchWithProxy(recsUrl, false);
            if (html) {
                const matches = [...html.matchAll(/\/profile\/([a-zA-Z0-9_-]+)/g)];
                for (const m of matches) {
                    const u = m[1];
                    if (!EXCLUDED_USERNAMES.has(u.toLowerCase()) && u.toLowerCase() !== state.targetUser.toLowerCase()) {
                        candidates.add(u);
                        if (candidates.size >= 120) break;
                    }
                }
            }
        } catch (e) {
            console.warn('Error fetching recs:', e);
        }

        // Reviews
        if (candidates.size < 120) {
            const revUrl = `https://myanimelist.net/anime/${anime.id}/${encodeURIComponent(slug)}/reviews`;
            try {
                const html = await fetchWithProxy(revUrl, false);
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
                // ignore
            }
        }

        await sleep(state.settings.requestDelay);
    }

    return Array.from(candidates);
}

/**
 * 4. Current Seasonal Airing Anime Reviewers
 */
async function discoverFromSeasonal(maxAnime = 3, maxUsers = 60) {
    const candidates = new Set();
    const url = 'https://myanimelist.net/anime/season';
    try {
        const html = await fetchWithProxy(url, false);
        if (!html) return [];

        const animeIds = [...new Set([...html.matchAll(/\/anime\/(\d+)\//g)].map(m => m[1]))].slice(0, maxAnime);
        for (const aid of animeIds) {
            if (!state.isRunning || candidates.size >= maxUsers) break;
            const revUrl = `https://myanimelist.net/anime/${aid}/_/reviews`;
            const revHtml = await fetchWithProxy(revUrl, false);
            if (revHtml) {
                const matches = [...revHtml.matchAll(/\/profile\/([a-zA-Z0-9_-]+)/g)];
                for (const m of matches) {
                    const u = m[1];
                    if (!EXCLUDED_USERNAMES.has(u.toLowerCase()) && u.toLowerCase() !== state.targetUser.toLowerCase()) {
                        candidates.add(u);
                        if (candidates.size >= maxUsers) break;
                    }
                }
            }
            await sleep(state.settings.requestDelay);
        }
    } catch (e) {
        console.warn('Error fetching seasonal:', e);
    }
    return Array.from(candidates);
}

/**
 * 5. Anime Forums (Recommendations, Series, Current Anime)
 */
async function discoverFromForums(boardIds = [16, 1, 4], maxUsers = 70) {
    const candidates = new Set();
    for (const bid of boardIds) {
        if (!state.isRunning || candidates.size >= maxUsers) break;
        const url = `https://myanimelist.net/forum/?board=${bid}`;
        try {
            const html = await fetchWithProxy(url, false);
            if (html) {
                const matches = [...html.matchAll(/\/profile\/([a-zA-Z0-9_-]+)/g)];
                for (const m of matches) {
                    const u = m[1];
                    if (!EXCLUDED_USERNAMES.has(u.toLowerCase()) && u.toLowerCase() !== state.targetUser.toLowerCase()) {
                        candidates.add(u);
                        if (candidates.size >= maxUsers) break;
                    }
                }
            }
            await sleep(state.settings.requestDelay);
        } catch (e) {
            // ignore
        }
    }
    return Array.from(candidates);
}

/**
 * 6. Active Anime Clubs
 */
async function discoverFromClubs(clubIds = [1, 77, 3538], maxUsers = 70) {
    const candidates = new Set();
    for (const cid of clubIds) {
        if (!state.isRunning || candidates.size >= maxUsers) break;
        const url = `https://myanimelist.net/clubs.php?cid=${cid}&action=members`;
        try {
            const html = await fetchWithProxy(url, false);
            if (html) {
                const matches = [...html.matchAll(/\/profile\/([a-zA-Z0-9_-]+)/g)];
                for (const m of matches) {
                    const u = m[1];
                    if (!EXCLUDED_USERNAMES.has(u.toLowerCase()) && u.toLowerCase() !== state.targetUser.toLowerCase()) {
                        candidates.add(u);
                        if (candidates.size >= maxUsers) break;
                    }
                }
            }
            await sleep(state.settings.requestDelay);
        } catch (e) {
            // ignore
        }
    }
    return Array.from(candidates);
}

/**
 * 7. Currently Online Users
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
 * 8. Profile Wall Commenters
 */
async function discoverFromComments(username, maxUsers = 50) {
    const candidates = new Set();
    const url = `https://myanimelist.net/profile/${encodeURIComponent(username)}`;
    try {
        const html = await fetchWithProxy(url, false);
        if (html) {
            const matches = [...html.matchAll(/\/profile\/([a-zA-Z0-9_-]+)/g)];
            for (const m of matches) {
                const u = m[1];
                if (!EXCLUDED_USERNAMES.has(u.toLowerCase()) && u.toLowerCase() !== username.toLowerCase()) {
                    candidates.add(u);
                    if (candidates.size >= maxUsers) break;
                }
            }
        }
    } catch (e) {
        console.warn('Error fetching comments:', e);
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
document.addEventListener('DOMContentLoaded', async () => {
    await initUI();
    await updateDatabaseStatsUI();
});

async function initUI() {
    const scanBtn = document.getElementById('btn-scan');
    const stopBtn = document.getElementById('btn-stop');
    const usernameInput = document.getElementById('input-username');
    const testProxyBtn = document.getElementById('btn-test-proxy');

    scanBtn.addEventListener('click', startScan);
    stopBtn.addEventListener('click', stopScan);
    testProxyBtn.addEventListener('click', testProxyConnection);

    // Username change: auto pre-load cached soulmates
    usernameInput.addEventListener('change', onUsernameChanged);

    // Filter controls
    document.getElementById('select-sort').addEventListener('change', updateTable);
    document.getElementById('input-min-shared').addEventListener('input', (e) => {
        document.getElementById('label-min-shared').textContent = e.target.value;
        updateTable();
    });
    document.getElementById('input-search').addEventListener('input', updateTable);
    document.getElementById('select-proxy').addEventListener('change', handleProxyChange);

    // Database action buttons
    document.getElementById('btn-export-db').addEventListener('click', exportDatabase);
    document.getElementById('btn-import-db').addEventListener('click', () => {
        document.getElementById('file-import-db').click();
    });
    document.getElementById('file-import-db').addEventListener('change', importDatabase);
    document.getElementById('btn-clear-db').addEventListener('click', clearDatabase);

    // Export table buttons
    document.getElementById('btn-export-json').addEventListener('click', exportJSON);
    document.getElementById('btn-export-csv').addEventListener('click', exportCSV);

    // Modal close
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-backdrop').addEventListener('click', closeModal);
}

async function onUsernameChanged() {
    const username = document.getElementById('input-username').value.trim();
    if (!username) return;

    if (document.getElementById('check-preload-cached').checked) {
        const cached = await storage.getAllAffinities(username);
        if (cached && cached.length > 0) {
            state.targetUser = username;
            state.results = cached;
            document.getElementById('results-section').classList.remove('hidden');
            updateTable();
            setStatus(`Loaded ${cached.length} previously saved soulmates from your local database!`);
        }
    }
    await updateDatabaseStatsUI();
}

async function updateDatabaseStatsUI() {
    const statsEl = document.getElementById('db-stats-text');
    if (!statsEl) return;
    try {
        const stats = await storage.getStats();
        const username = document.getElementById('input-username').value.trim();
        let targetMsg = '';
        if (username) {
            const targetAffinities = await storage.getAllAffinities(username);
            targetMsg = ` | <strong>${targetAffinities.length}</strong> matches for @${username}`;
        }
        statsEl.innerHTML = `<strong>${stats.profiles}</strong> profiles cached in browser | <strong>${stats.affinities}</strong> total soulmate comparisons saved${targetMsg}`;
    } catch (e) {
        statsEl.textContent = 'Local database active.';
    }
}

async function exportDatabase() {
    try {
        const jsonStr = await storage.exportJSON();
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mal_affinity_database_${Date.now()}.json`;
        a.click();
    } catch (e) {
        alert('Failed to export database: ' + e.message);
    }
}

async function importDatabase(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        await storage.importJSON(text);
        await updateDatabaseStatsUI();
        await onUsernameChanged();
        alert('Database successfully imported!');
    } catch (err) {
        alert('Failed to import database: ' + err.message);
    } finally {
        e.target.value = '';
    }
}

async function clearDatabase() {
    if (!confirm('Are you sure you want to clear your local database cache? All stored user lists and affinity history will be reset.')) {
        return;
    }
    await storage.clearAll();
    state.results = [];
    updateTable();
    await updateDatabaseStatsUI();
    alert('Local database cleared!');
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
    if (statusText) statusText.textContent = text;
    if (progressBar && progressPct !== null) {
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

    // Pre-load existing soulmates from IndexedDB if requested
    const skipEvaluated = document.getElementById('check-skip-evaluated').checked;
    const preloadCached = document.getElementById('check-preload-cached').checked;

    let alreadyEvaluated = new Set();
    if (skipEvaluated) {
        alreadyEvaluated = await storage.getAllEvaluatedUsernames(username);
    }

    if (preloadCached) {
        const existingAffinities = await storage.getAllAffinities(username);
        if (existingAffinities.length > 0) {
            state.results = existingAffinities;
            updateTable();
        }
    } else {
        state.results = [];
    }

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
        setStatus(`Loaded @${username}'s list (${scoredCount} scored anime). Discovering fresh candidate users...`, 20);

        // Step 2: Multi-Source Candidate Discovery
        const candidateSet = new Set();

        const addCandidateIfValid = (u) => {
            const uClean = u.trim();
            const uLower = uClean.toLowerCase();
            if (!uClean || uLower === username.toLowerCase() || EXCLUDED_USERNAMES.has(uLower)) return;
            if (skipEvaluated && alreadyEvaluated.has(uLower)) return; // Never look up already evaluated users!
            candidateSet.add(uClean);
        };

        // Custom candidates
        const customCandidatesText = document.getElementById('input-custom-candidates').value.trim();
        if (customCandidatesText) {
            const list = customCandidatesText.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
            list.forEach(addCandidateIfValid);
        }

        // 1. Direct Friends
        if (document.getElementById('check-friends').checked && candidateSet.size < state.settings.maxCandidates) {
            setStatus('Searching friends list for candidates...', 25);
            const friends = await discoverFriends(username, 60);
            friends.forEach(addCandidateIfValid);
        }

        // 2. Friends-of-Friends (2nd degree)
        if (document.getElementById('check-fof').checked && candidateSet.size < state.settings.maxCandidates) {
            setStatus('Searching friends-of-friends (2nd-degree network)...', 30);
            const fof = await discoverFriendsOfFriends(username, 4, 60);
            fof.forEach(addCandidateIfValid);
        }

        // 3. Top Anime Fans (9-10/10)
        if (document.getElementById('check-top-anime').checked && candidateSet.size < state.settings.maxCandidates) {
            setStatus('Searching reviewers of your top-rated anime...', 35);
            const topFans = await discoverFromTopAnime(targetList, 50);
            topFans.forEach(addCandidateIfValid);
        }

        // 4. Seasonal Anime Reviewers
        if (document.getElementById('check-seasonal').checked && candidateSet.size < state.settings.maxCandidates) {
            setStatus('Searching current seasonal anime reviewers...', 40);
            const seasonal = await discoverFromSeasonal(3, 50);
            seasonal.forEach(addCandidateIfValid);
        }

        // 5. Anime Forums (Recs & Series)
        if (document.getElementById('check-forums').checked && candidateSet.size < state.settings.maxCandidates) {
            setStatus('Searching active recommendation forum posters...', 43);
            const forumUsers = await discoverFromForums([16, 1, 4], 60);
            forumUsers.forEach(addCandidateIfValid);
        }

        // 6. Active Anime Clubs
        if (document.getElementById('check-clubs').checked && candidateSet.size < state.settings.maxCandidates) {
            setStatus('Searching active anime recommendation clubs...', 46);
            const clubUsers = await discoverFromClubs([1, 77, 3538], 60);
            clubUsers.forEach(addCandidateIfValid);
        }

        // 7. Online Users
        if (document.getElementById('check-online').checked && candidateSet.size < state.settings.maxCandidates) {
            setStatus('Checking currently active online MAL users...', 48);
            const onlineUsers = await discoverOnlineUsers();
            onlineUsers.forEach(addCandidateIfValid);
        }

        // 8. Profile Comments
        if (document.getElementById('check-comments').checked && candidateSet.size < state.settings.maxCandidates) {
            setStatus('Checking profile wall commenters...', 49);
            const commentUsers = await discoverFromComments(username, 40);
            commentUsers.forEach(addCandidateIfValid);
        }

        const candidateList = Array.from(candidateSet).slice(0, state.settings.maxCandidates);
        state.candidates = candidateList;

        if (candidateList.length === 0) {
            if (state.results.length > 0) {
                setStatus(`No new unscanned candidates found in selected sources. Displaying ${state.results.length} previously saved soulmates.`, 100);
            } else {
                setStatus('No candidate users found to evaluate. Try selecting more discovery channels.', 100);
            }
            stopScan();
            return;
        }

        setStatus(`Found ${candidateList.length} fresh candidate users. Calculating affinities...`, 50);

        // Step 3: Evaluate candidates one by one
        let processed = 0;
        for (const candUser of candidateList) {
            if (!state.isRunning) break;

            processed++;
            const pct = 50 + Math.round((processed / candidateList.length) * 50);
            setStatus(`Evaluating ${processed}/${candidateList.length}: @${candUser}...`, pct);

            try {
                // Fetch candidate list (uses IndexedDB cache if already scraped!)
                const candList = await fetchUserAnimeList(candUser);
                if (candList && candList.size > 0) {
                    const metrics = computeAffinityMetrics(candUser, candList);
                    if (metrics.sharedCount >= 2) {
                        // Save in IndexedDB so we never have to look them up again!
                        await storage.saveAffinity(username, candUser, metrics);

                        // Merge into active state results
                        const existingIdx = state.results.findIndex(r => r.candidateUser.toLowerCase() === candUser.toLowerCase());
                        if (existingIdx >= 0) {
                            state.results[existingIdx] = metrics;
                        } else {
                            state.results.push(metrics);
                        }
                        updateTable();
                    }
                }
            } catch (err) {
                console.warn(`Error evaluating ${candUser}:`, err);
            }

            await sleep(state.settings.requestDelay);
        }

        await updateDatabaseStatsUI();
        setStatus(`Scan complete! Evaluated ${processed} candidates. Showing ${state.results.length} total soulmates with shared scores.`, 100);
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
                <td colspan="7" class="text-center py-8 text-slate-500">
                    No users meet current filter (min shared: ${minShared}).
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filtered.map((item, index) => {
        const affVal = item.affinity;
        let affColor = 'text-slate-400';
        let affBadge = 'bg-slate-800 text-slate-300';

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
            <tr class="border-b border-slate-800 hover:bg-slate-800/40 transition cursor-pointer" onclick="openDetailsModal('${item.candidateUser}')">
                <td class="py-3 px-4 text-center font-bold text-slate-500">#${index + 1}</td>
                <td class="py-3 px-4 font-semibold text-white flex items-center gap-2">
                    <a href="https://myanimelist.net/profile/${item.candidateUser}" target="_blank" rel="noopener" class="text-blue-400 hover:underline flex items-center gap-1" onclick="event.stopPropagation()">
                        ${item.candidateUser}
                        <svg class="w-3 h-3 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
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
                <td class="py-3 px-4 text-center text-sm text-slate-300">
                    <span class="font-bold text-white">${item.sharedCount}</span>
                </td>
                <td class="py-3 px-4 text-center text-sm text-slate-400">
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
    const item = state.results.find(r => r.candidateUser.toLowerCase() === username.toLowerCase());
    if (!item) return;

    document.getElementById('modal-title').textContent = `@${state.targetUser} vs @${item.candidateUser}`;
    document.getElementById('modal-sub').textContent = `Affinity: ${item.affinity.toFixed(1)}% | Shared: ${item.sharedCount} anime | Avg Difference: ${item.meanDiff.toFixed(2)} pts`;

    // Render Shared Favorites
    const favsEl = document.getElementById('modal-favs');
    if (item.favorites && item.favorites.length > 0) {
        favsEl.innerHTML = item.favorites.map(f => `
            <div class="flex items-center justify-between p-2 rounded bg-slate-800/60 border border-slate-700/50">
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
        favsEl.innerHTML = '<p class="text-xs text-slate-500">No mutual favorites (rated 8-10) found.</p>';
    }

    // Render Disagreements
    const disagEl = document.getElementById('modal-disagreements');
    if (item.disagreements && item.disagreements.length > 0) {
        disagEl.innerHTML = item.disagreements.slice(0, 8).map(d => `
            <div class="flex items-center justify-between p-2 rounded bg-slate-800/60 border border-slate-700/50">
                <a href="https://myanimelist.net/anime/${d.id}" target="_blank" class="text-sm font-medium text-white hover:text-blue-400 truncate max-w-[280px]">
                    ${d.title}
                </a>
                <div class="flex items-center gap-2 text-xs">
                    <span class="px-2 py-0.5 bg-blue-900/60 text-blue-300 rounded">You: ${d.targetScore}</span>
                    <span class="px-2 py-0.5 bg-purple-900/60 text-purple-300 rounded">Them: ${d.candidateScore}</span>
                    <span class="px-2 py-0.5 bg-red-900/60 text-red-300 rounded font-bold">Diff: ${d.diff}</span>
                </div>
            </div>
        `).join('');
    } else {
        disagEl.innerHTML = '<p class="text-xs text-slate-500">No major disagreements (difference >= 2) found.</p>';
    }

    // Render Recommendations
    const recsEl = document.getElementById('modal-recs');
    if (item.recommendations && item.recommendations.length > 0) {
        recsEl.innerHTML = item.recommendations.slice(0, 8).map(r => `
            <div class="flex items-center justify-between p-2 rounded bg-slate-800/60 border border-slate-700/50">
                <a href="https://myanimelist.net/anime/${r.id}" target="_blank" class="text-sm font-medium text-white hover:text-blue-400 truncate max-w-[300px]">
                    ${r.title}
                </a>
                <span class="px-2 py-0.5 bg-green-900/60 text-green-300 rounded text-xs font-bold">
                    Rated ${r.score}/10
                </span>
            </div>
        `).join('');
    } else {
        recsEl.innerHTML = '<p class="text-xs text-slate-500">No new recommendations available from this user.</p>';
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
