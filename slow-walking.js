/* Slow Walking — pair a walking video with a music track or playlist on YouTube. */

const STORE = {
    walks: 'slow-walking.walks',
    tracks: 'slow-walking.tracks',
    pairs: 'slow-walking.pairs',
    state: 'slow-walking.state',
    apiKey: 'slow-walking.apiKey',
    walkChannels: 'slow-walking.walkChannels',
    trackChannels: 'slow-walking.trackChannels',
};

const SOURCES = {
    walk:  [{ label: 'Seoul Walker', url: 'https://www.youtube.com/@SeoulWalker/videos' }],
    track: [
        { label: 'Joji',   url: 'https://www.youtube.com/@JojiOfficial/videos' },
        { label: 'Giveon', url: 'https://www.youtube.com/@Giveon/videos' },
    ],
};
const SEED_WALKS = [
    {
        id: 'w_seed_seoul_night',
        name: 'Seoul Night Drive Downtown',
        videoId: 'e3pEdcNRFs0',
        tags: ['seoul', 'night'],
    },
];
const SEED_TRACKS = [
    {
        id: 't_seed_smithereens',
        name: 'SMITHEREENS',
        videoId: 'NgsWGfUlwJI',
        playlistId: 'PLzjD-HnzMfXLBCR6jPEE3_gDfQ_XEk7o2',
        tags: ['playlist'],
    },
];

/* ── Persistent state helpers ── */
function load(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
}
function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let walks  = load(STORE.walks, SEED_WALKS);
let tracks = load(STORE.tracks, SEED_TRACKS);
let pairs  = load(STORE.pairs, []);
let walkChannels  = load(STORE.walkChannels, []);
let trackChannels = load(STORE.trackChannels, []);
const DEFAULT_STATE = {
    walkId: null, trackId: null,
    walkFilter: 'all', trackFilter: 'all',
    walkSearch: '', trackSearch: '',
    musicVol: 70, cityVol: 15,
    musicMode: 'shuffle', // shuffle | sequential | repeat-one
};
let state  = Object.assign({}, DEFAULT_STATE, load(STORE.state, {}));

/* ── YouTube URL parsing ── */
function parseYouTubeRef(input) {
    if (!input) return null;
    const trimmed = input.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return { videoId: trimmed, playlistId: null, channel: null };
    let videoId = null, playlistId = null, channel = null;
    const v = trimmed.match(/(?:v=|\/embed\/|youtu\.be\/|\/shorts\/|\/live\/)([a-zA-Z0-9_-]{11})/);
    if (v) videoId = v[1];
    const l = trimmed.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (l) playlistId = l[1];
    const handle = trimmed.match(/youtube\.com\/@([^\/?#&\s]+)/i);
    const cid    = trimmed.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/i);
    const cust   = trimmed.match(/youtube\.com\/c\/([^\/?#&\s]+)/i);
    const userU  = trimmed.match(/youtube\.com\/user\/([^\/?#&\s]+)/i);
    if (handle)      channel = { handle: decodeURIComponent(handle[1]) };
    else if (cid)    channel = { id: cid[1] };
    else if (cust)   channel = { handle: decodeURIComponent(cust[1]) };
    else if (userU)  channel = { username: decodeURIComponent(userU[1]) };
    else if (/^@[^\s\/?#&]+$/.test(trimmed)) channel = { handle: trimmed.slice(1) };
    if (!videoId && !playlistId && !channel) return null;
    return { videoId, playlistId, channel };
}

/* ── YouTube IFrame players ── */
let walkPlayer = null;
let musicPlayer = null;
let playersReady = { walk: false, music: false };

// iOS only allows one audible <video> at a time. To play walk + music
// simultaneously we keep the walk video muted so the music carries audio.
const isIOS =
    /iPad|iPhone|iPod/.test(navigator.platform) ||
    (navigator.userAgent.includes('Mac') && 'ontouchend' in document);

function silenceWalkOnIOS() {
    if (!isIOS || !walkPlayer || !playersReady.walk) return;
    try { walkPlayer.mute(); } catch {}
    try { walkPlayer.setVolume(0); } catch {}
}

window.onYouTubeIframeAPIReady = function () {
    walkPlayer = new YT.Player('yt-walk', {
        width: '100%', height: '100%',
        playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
            onReady: () => {
                playersReady.walk = true;
                walkPlayer.setVolume(state.cityVol);
                silenceWalkOnIOS();
                tryRestoreSelection();
            },
            onStateChange: handlePlayerStateChange,
        },
    });
    musicPlayer = new YT.Player('yt-music', {
        width: '100%', height: '100%',
        playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
            onReady: () => {
                playersReady.music = true;
                musicPlayer.setVolume(state.musicVol);
                tryRestoreSelection();
            },
            onStateChange: handlePlayerStateChange,
        },
    });
};

function tryRestoreSelection() {
    if (!playersReady.walk || !playersReady.music) return;
    if (state.walkId)  selectWalk(state.walkId, false);
    if (state.trackId) selectTrack(state.trackId, false);
    refreshPlayButton();
}

function handlePlayerStateChange(e) {
    refreshPlayButton();
    if (e.data === YT.PlayerState.PLAYING) {
        if (e.target === musicPlayer) applyMusicMode();
        acquireWakeLock();
        if (e.target === musicPlayer) startTitlePolling();
        updateMediaSession();
    }
    if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) {
        if (!isAnythingPlaying()) {
            releaseWakeLock();
            stopTitlePolling();
            restoreTabTitle();
        }
    }
    if (e.data === YT.PlayerState.ENDED) {
        const dur = (e.target.getDuration && e.target.getDuration()) || 0;
        const ct  = (e.target.getCurrentTime && e.target.getCurrentTime()) || 0;
        if (dur <= 0 || ct < dur - 1.5) return;
        if (e.target === musicPlayer) {
            const t = currentTrack();
            const isPlaylist = t && t.playlistId;
            if (!isPlaylist || state.musicMode === 'repeat-one') {
                e.target.seekTo(0);
                e.target.playVideo();
            }
        } else {
            e.target.seekTo(0);
            e.target.playVideo();
        }
    }
}

function isAnythingPlaying() {
    const wp = walkPlayer  && playersReady.walk  && walkPlayer.getPlayerState  && walkPlayer.getPlayerState()  === YT.PlayerState.PLAYING;
    const mp = musicPlayer && playersReady.music && musicPlayer.getPlayerState && musicPlayer.getPlayerState() === YT.PlayerState.PLAYING;
    return wp || mp;
}

function currentTrack() {
    return tracks.find(t => t.id === state.trackId) || null;
}
function currentWalk() {
    return walks.find(w => w.id === state.walkId) || null;
}

function applyMusicMode() {
    if (!musicPlayer || !playersReady.music) return;
    const t = currentTrack();
    if (!t || !t.playlistId) return;
    try {
        if (state.musicMode === 'shuffle') {
            musicPlayer.setShuffle(true);
            musicPlayer.setLoop(true);
        } else if (state.musicMode === 'sequential') {
            musicPlayer.setShuffle(false);
            musicPlayer.setLoop(true);
        } else if (state.musicMode === 'repeat-one') {
            musicPlayer.setShuffle(false);
            musicPlayer.setLoop(false);
        }
    } catch {}
}

/* ── Wake Lock ── */
let wakeLock = null;
async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (wakeLock) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {}
}
async function releaseWakeLock() {
    try { if (wakeLock) await wakeLock.release(); } catch {}
    wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isAnythingPlaying()) acquireWakeLock();
});

/* ── Media Session + tab title + current-track polling ── */
const ORIGINAL_TITLE = 'Slow Walking';
let titlePollId = null;
let lastPolledTitle = '';

function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.setActionHandler('play',  togglePlay);
        navigator.mediaSession.setActionHandler('pause', togglePlay);
        navigator.mediaSession.setActionHandler('nexttrack', skipTrack);
    } catch {}
}

function updateMediaSession(forcedTitle) {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    const t = currentTrack();
    const w = currentWalk();
    if (!t) return;
    const title = forcedTitle || lastPolledTitle || t.name;
    const artwork = t.videoId ? [{ src: thumbUrl(t.videoId), sizes: '320x180', type: 'image/jpeg' }] : [];
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title,
            artist: t.name,
            album: w ? w.name : 'Slow Walking',
            artwork,
        });
    } catch {}
}

function startTitlePolling() {
    stopTitlePolling();
    pollMusicTitle();
    titlePollId = setInterval(pollMusicTitle, 2500);
}
function stopTitlePolling() {
    if (titlePollId) { clearInterval(titlePollId); titlePollId = null; }
}
function pollMusicTitle() {
    if (!musicPlayer || !playersReady.music) return;
    let data = null;
    try { data = musicPlayer.getVideoData && musicPlayer.getVideoData(); } catch {}
    if (!data || !data.title) return;
    if (data.title === lastPolledTitle) return;
    lastPolledTitle = data.title;
    const t = currentTrack();
    if (t && t.playlistId) updateNowTrackDisplay(data.title, true);
    updateTabTitle(data.title);
    updateMediaSession(data.title);
}
function updateNowTrackDisplay(title, isPlaylistTrack) {
    const el = document.getElementById('now-track');
    if (!el) return;
    const t = currentTrack();
    if (!t) return;
    const icon = '<i class="fa-solid fa-music"></i>';
    if (isPlaylistTrack) {
        el.innerHTML = icon + escapeHtml(title) + ' <span style="opacity:0.55;">· ' + escapeHtml(t.name) + '</span>';
    } else {
        el.innerHTML = icon + escapeHtml(title);
    }
    el.classList.remove('now-empty');
}
function updateTabTitle(songName) {
    document.title = songName ? ('♫ ' + songName + ' · ' + ORIGINAL_TITLE) : ORIGINAL_TITLE;
}
function restoreTabTitle() {
    document.title = ORIGINAL_TITLE;
}

/* ── Selection ── */
function selectWalk(id, autoplay = true) {
    const w = walks.find(x => x.id === id);
    if (!w) return;
    state.walkId = id;
    save(STORE.state, state);
    const placeholder = document.getElementById('video-placeholder');
    if (placeholder) placeholder.remove();
    if (walkPlayer && playersReady.walk) {
        walkPlayer.loadVideoById({ videoId: w.videoId });
        walkPlayer.setVolume(state.cityVol);
        silenceWalkOnIOS();
        if (!autoplay) walkPlayer.pauseVideo();
    }
    document.getElementById('now-walk').textContent = w.name;
    document.getElementById('now-walk').classList.remove('now-empty');
    renderList('walk');
    refreshPlayButton();
    refreshSaveButton();
    encodeHash();
    updateMediaSession();
}

function selectTrack(id, autoplay = true) {
    const t = tracks.find(x => x.id === id);
    if (!t) return;
    const prevId = state.trackId;
    state.trackId = id;
    save(STORE.state, state);
    lastPolledTitle = '';
    const wasPlaying = musicPlayer && playersReady.music && musicPlayer.getPlayerState
        && musicPlayer.getPlayerState() === YT.PlayerState.PLAYING && prevId && prevId !== id;

    function loadIt() {
        if (!musicPlayer || !playersReady.music) return;
        if (t.playlistId) {
            musicPlayer.loadPlaylist({ list: t.playlistId, listType: 'playlist', index: 0 });
            setTimeout(applyMusicMode, 800);
        } else {
            musicPlayer.loadVideoById({ videoId: t.videoId });
        }
        if (!autoplay) musicPlayer.pauseVideo();
        setTimeout(() => fadeMusic(0, state.musicVol, 600), 250);
    }

    if (wasPlaying) {
        fadeMusic(state.musicVol, 0, 400, loadIt);
    } else {
        if (musicPlayer && playersReady.music) musicPlayer.setVolume(state.musicVol);
        loadIt();
    }
    silenceWalkOnIOS();

    document.getElementById('now-track').innerHTML = '<i class="fa-solid fa-music"></i>' + escapeHtml(t.name);
    document.getElementById('now-track').classList.remove('now-empty');
    const mini = document.getElementById('music-mini');
    if (mini) mini.classList.add('has-track');
    renderList('track');
    refreshPlayButton();
    refreshSaveButton();
    updateMusicControls();
    encodeHash();
    updateMediaSession();
}

/* ── Playback ── */
function refreshPlayButton() {
    const btn = document.getElementById('play-btn');
    const icon = btn.querySelector('i');
    const hasAny = state.walkId || state.trackId;
    btn.disabled = !hasAny;
    const isPlaying =
        (walkPlayer  && playersReady.walk  && walkPlayer.getPlayerState  && walkPlayer.getPlayerState()  === YT.PlayerState.PLAYING) ||
        (musicPlayer && playersReady.music && musicPlayer.getPlayerState && musicPlayer.getPlayerState() === YT.PlayerState.PLAYING);
    icon.className = isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play';
}
function refreshSaveButton() {
    const btn = document.getElementById('save-btn');
    btn.disabled = !(state.walkId && state.trackId);
}

function togglePlay() {
    const isPlaying =
        (walkPlayer  && playersReady.walk  && walkPlayer.getPlayerState  && walkPlayer.getPlayerState()  === YT.PlayerState.PLAYING) ||
        (musicPlayer && playersReady.music && musicPlayer.getPlayerState && musicPlayer.getPlayerState() === YT.PlayerState.PLAYING);
    if (isPlaying) {
        if (state.walkId  && walkPlayer)  walkPlayer.pauseVideo();
        if (state.trackId && musicPlayer) musicPlayer.pauseVideo();
    } else {
        if (state.walkId  && walkPlayer)  walkPlayer.playVideo();
        if (state.trackId && musicPlayer) musicPlayer.playVideo();
    }
    setTimeout(refreshPlayButton, 200);
}

/* ── Volume ── */
function bindVolume(sliderId, valueId, kind) {
    const s = document.getElementById(sliderId);
    const v = document.getElementById(valueId);
    s.value = kind === 'music' ? state.musicVol : state.cityVol;
    v.textContent = s.value;
    s.addEventListener('input', () => {
        const val = parseInt(s.value, 10);
        v.textContent = val;
        if (kind === 'music') {
            state.musicVol = val;
            if (musicPlayer && playersReady.music) musicPlayer.setVolume(val);
        } else {
            state.cityVol = val;
            if (walkPlayer && playersReady.walk) {
                walkPlayer.setVolume(val);
                silenceWalkOnIOS();
            }
        }
        save(STORE.state, state);
    });
}

/* ── Lists ── */
function thumbUrl(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uniqueTags(items) {
    const set = new Set();
    items.forEach(i => (i.tags || []).forEach(t => set.add(t)));
    return Array.from(set).sort();
}

function renderFilters(kind) {
    const items = kind === 'walk' ? walks : tracks;
    const filterKey = kind === 'walk' ? 'walkFilter' : 'trackFilter';
    const container = document.getElementById(kind === 'walk' ? 'walk-filters' : 'track-filters');
    const tags = ['all', ...uniqueTags(items)];
    container.innerHTML = tags.map(t => `
        <button class="filter-pill ${state[filterKey] === t ? 'active' : ''}" data-filter="${escapeHtml(t)}">${escapeHtml(t)}</button>
    `).join('');
    container.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
            state[filterKey] = b.dataset.filter;
            save(STORE.state, state);
            renderList(kind);
            renderFilters(kind);
        });
    });
}

let listMode = { walk: 'normal', track: 'normal' }; // 'normal' | 'sort' | 'select'
let selected = { walk: new Set(), track: new Set() };
let pendingDelete = { kind: null, id: null, timeout: null };

function setListMode(kind, mode) {
    listMode[kind] = mode;
    if (mode !== 'select') selected[kind].clear();
    document.querySelectorAll(`[data-mode-toggle="${kind}"]`).forEach(b => {
        b.classList.toggle('active', b.dataset.target === mode);
    });
    const search = document.getElementById(kind === 'walk' ? 'walk-search' : 'track-search');
    if (search) search.disabled = mode === 'sort';
    const filters = document.getElementById(kind === 'walk' ? 'walk-filters' : 'track-filters');
    if (filters) filters.style.display = mode === 'sort' ? 'none' : '';
    renderList(kind);
    updateBulkBar(kind);
}

function updateBulkBar(kind) {
    const bar = document.getElementById(kind === 'walk' ? 'walk-bulk' : 'track-bulk');
    if (!bar) return;
    bar.classList.toggle('show', listMode[kind] === 'select');
    const count = selected[kind].size;
    bar.querySelector('.bulk-count').textContent = `${count} selected`;
}

function renderList(kind) {
    const items = kind === 'walk' ? walks : tracks;
    const filterKey = kind === 'walk' ? 'walkFilter' : 'trackFilter';
    const searchKey = kind === 'walk' ? 'walkSearch' : 'trackSearch';
    const mode = listMode[kind];
    const filter = mode === 'sort' ? 'all' : state[filterKey];
    const search = mode === 'sort' ? '' : (state[searchKey] || '').trim().toLowerCase();
    const activeId = kind === 'walk' ? state.walkId : state.trackId;
    const container = document.getElementById(kind === 'walk' ? 'walk-list' : 'track-list');
    let filtered = filter === 'all' ? items : items.filter(i => (i.tags || []).includes(filter));
    if (search) filtered = filtered.filter(i => (i.name || '').toLowerCase().includes(search));
    if (filtered.length === 0) {
        const sources = SOURCES[kind] || [];
        const links = sources.map(s =>
            `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" style="color:var(--cosmic-purple);text-decoration:none;">${escapeHtml(s.label)} <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:0.65rem;"></i></a>`
        ).join(' &middot; ');
        const hint = items.length === 0
            ? `Library empty. Browse ${links} &mdash; copy a video URL, then hit <strong>+ Add</strong>.`
            : (search ? `No matches for "${escapeHtml(search)}".` : `No matches for this filter.`);
        container.innerHTML = `<div style="color:var(--text-muted);font-size:0.8125rem;padding:0.65rem 0.5rem;line-height:1.5;">${hint}</div>`;
        return;
    }
    container.innerHTML = filtered.map((item, idx) => {
        const isFirst = idx === 0;
        const isLast  = idx === filtered.length - 1;
        const checked = selected[kind].has(item.id);
        let actions = '';
        if (mode === 'sort') {
            actions = `
                <button class="item-move" data-move-up="${escapeHtml(item.id)}" aria-label="Move up" ${isFirst ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
                <button class="item-move" data-move-down="${escapeHtml(item.id)}" aria-label="Move down" ${isLast ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
            `;
        } else if (mode === 'select') {
            actions = '';
        } else {
            actions = `
                <button class="item-edit" data-edit="${escapeHtml(item.id)}" aria-label="Edit"><i class="fa-solid fa-pen"></i></button>
                <button class="item-del" data-del="${escapeHtml(item.id)}" aria-label="Delete"><i class="fa-solid fa-xmark"></i></button>
            `;
        }
        const checkbox = mode === 'select'
            ? `<span class="item-check"><i class="fa-solid fa-check"></i></span>` : '';
        const draggable = mode === 'sort' ? 'draggable="true"' : '';
        const cls = [
            'item',
            (mode !== 'select' && item.id === activeId) ? 'active' : '',
            (mode === 'select' && checked) ? 'selected' : '',
        ].filter(Boolean).join(' ');
        return `
            <div class="${cls}" data-id="${escapeHtml(item.id)}" ${draggable}>
                ${checkbox}
                <div class="item-thumb" style="background-image:url('${thumbUrl(item.videoId)}')"></div>
                <div class="item-meta">
                    <div class="item-name">${escapeHtml(item.name)}</div>
                    <div class="item-tags">${(item.tags || []).map(escapeHtml).join(' · ')}</div>
                </div>
                ${actions}
            </div>
        `;
    }).join('');
    bindItemEvents(kind);
}

function bindItemEvents(kind) {
    const container = document.getElementById(kind === 'walk' ? 'walk-list' : 'track-list');
    const mode = listMode[kind];
    container.querySelectorAll('.item').forEach(el => {
        el.addEventListener('click', e => {
            if (mode === 'sort') return;
            if (mode === 'select') {
                toggleSelected(kind, el.dataset.id);
                return;
            }
            if (e.target.closest('[data-del]') || e.target.closest('[data-edit]')) return;
            kind === 'walk' ? selectWalk(el.dataset.id) : selectTrack(el.dataset.id);
        });
        if (mode === 'sort') wireDrag(el, kind);
    });
    container.querySelectorAll('[data-del]').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            requestDelete(kind, b.dataset.del, b);
        });
    });
    container.querySelectorAll('[data-edit]').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            openEditModal(kind, b.dataset.edit);
        });
    });
    container.querySelectorAll('[data-move-up]').forEach(b => {
        b.addEventListener('click', e => { e.stopPropagation(); moveItem(kind, b.dataset.moveUp, -1); });
    });
    container.querySelectorAll('[data-move-down]').forEach(b => {
        b.addEventListener('click', e => { e.stopPropagation(); moveItem(kind, b.dataset.moveDown, +1); });
    });
}

function toggleSelected(kind, id) {
    if (selected[kind].has(id)) selected[kind].delete(id);
    else selected[kind].add(id);
    renderList(kind);
    updateBulkBar(kind);
}

function moveItem(kind, id, dir) {
    const arr = kind === 'walk' ? walks : tracks;
    const i = arr.findIndex(x => x.id === id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    save(kind === 'walk' ? STORE.walks : STORE.tracks, arr);
    renderList(kind);
}

function wireDrag(el, kind) {
    el.addEventListener('dragstart', e => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', el.dataset.id);
        el.classList.add('dragging');
        document.body.classList.add('internal-drag');
    });
    el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        document.body.classList.remove('internal-drag');
        document.querySelectorAll('.item.drop-above, .item.drop-below').forEach(x => {
            x.classList.remove('drop-above', 'drop-below');
        });
    });
    el.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = el.getBoundingClientRect();
        const above = (e.clientY - rect.top) < rect.height / 2;
        el.classList.toggle('drop-above', above);
        el.classList.toggle('drop-below', !above);
    });
    el.addEventListener('dragleave', () => {
        el.classList.remove('drop-above', 'drop-below');
    });
    el.addEventListener('drop', e => {
        e.preventDefault();
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId || draggedId === el.dataset.id) return;
        const rect = el.getBoundingClientRect();
        const above = (e.clientY - rect.top) < rect.height / 2;
        reorderTo(kind, draggedId, el.dataset.id, above);
    });
}

function reorderTo(kind, draggedId, targetId, above) {
    const arr = kind === 'walk' ? walks : tracks;
    const from = arr.findIndex(x => x.id === draggedId);
    if (from < 0) return;
    const [item] = arr.splice(from, 1);
    let to = arr.findIndex(x => x.id === targetId);
    if (to < 0) { arr.splice(from, 0, item); return; }
    if (!above) to += 1;
    arr.splice(to, 0, item);
    save(kind === 'walk' ? STORE.walks : STORE.tracks, arr);
    renderList(kind);
}

function bulkDelete(kind) {
    const ids = Array.from(selected[kind]);
    if (!ids.length) return;
    if (kind === 'walk') {
        walks = walks.filter(w => !ids.includes(w.id));
        save(STORE.walks, walks);
        if (ids.includes(state.walkId)) state.walkId = null;
    } else {
        tracks = tracks.filter(t => !ids.includes(t.id));
        save(STORE.tracks, tracks);
        if (ids.includes(state.trackId)) state.trackId = null;
    }
    pairs = pairs.filter(p => walks.find(w => w.id === p.walkId) && tracks.find(t => t.id === p.trackId));
    save(STORE.pairs, pairs);
    save(STORE.state, state);
    selected[kind].clear();
    setListMode(kind, 'normal');
    renderFilters(kind); renderPairs(); renderMoods();
    flashMessage(`Deleted ${ids.length} ${kind === 'walk' ? 'walk' : 'track'}${ids.length === 1 ? '' : 's'}`);
}

function requestDelete(kind, id, btn) {
    if (pendingDelete.timeout) clearTimeout(pendingDelete.timeout);
    if (pendingDelete.kind === kind && pendingDelete.id === id) {
        pendingDelete = { kind: null, id: null, timeout: null };
        removeItem(kind, id);
        return;
    }
    pendingDelete = { kind, id };
    btn.classList.add('confirming');
    btn.title = 'Click again to delete';
    pendingDelete.timeout = setTimeout(() => {
        btn.classList.remove('confirming');
        btn.title = 'Delete';
        pendingDelete = { kind: null, id: null, timeout: null };
    }, 2000);
}

function bindSearch(inputId, kind) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const key = kind === 'walk' ? 'walkSearch' : 'trackSearch';
    el.value = state[key] || '';
    let debounce;
    el.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            state[key] = el.value;
            save(STORE.state, state);
            renderList(kind);
        }, 120);
    });
}

function removeItem(kind, id) {
    if (kind === 'walk') {
        walks = walks.filter(w => w.id !== id);
        save(STORE.walks, walks);
        if (state.walkId === id) state.walkId = null;
    } else {
        tracks = tracks.filter(t => t.id !== id);
        save(STORE.tracks, tracks);
        if (state.trackId === id) state.trackId = null;
    }
    save(STORE.state, state);
    renderFilters(kind); renderList(kind); renderPairs();
}

/* ── Add / Edit / Bulk modal ── */
let modalMode = null;     // 'add' | 'edit' | 'bulk'
let modalKind = null;     // 'walk' | 'track'
let editId = null;

function setModalUiMode(mode) {
    const single = document.getElementById('modal-url');
    const bulk   = document.getElementById('modal-url-bulk');
    const nameLabel = document.getElementById('modal-name-label');
    const nameInput = document.getElementById('modal-name');
    const toggleRow = document.getElementById('modal-toggle-row');
    const toggleBtn = document.getElementById('modal-toggle-bulk');
    const urlLabel  = document.getElementById('modal-url-label');
    if (mode === 'bulk') {
        single.style.display = 'none';
        bulk.style.display = '';
        nameLabel.style.display = 'none';
        nameInput.style.display = 'none';
        urlLabel.textContent = 'Paste YouTube URLs';
        toggleBtn.textContent = 'Single add';
    } else {
        single.style.display = '';
        bulk.style.display = 'none';
        nameLabel.style.display = '';
        nameInput.style.display = '';
        urlLabel.textContent = 'YouTube URL or video ID';
        toggleBtn.textContent = 'Bulk add (paste many)';
    }
    if (mode === 'edit') {
        toggleRow.style.display = 'none';
    } else {
        toggleRow.style.display = '';
    }
}

function openAddModal(kind) {
    modalMode = 'add';
    modalKind = kind;
    editId = null;
    document.getElementById('modal-title').textContent = kind === 'walk' ? 'Add a walk' : 'Add a track';
    document.getElementById('modal-url').value = '';
    document.getElementById('modal-url').disabled = false;
    document.getElementById('modal-url-bulk').value = '';
    document.getElementById('modal-name').value = '';
    document.getElementById('modal-tags').value = kind === 'walk' ? 'seoul' : 'joji';
    document.getElementById('modal-save').textContent = 'Add';
    setModalUiMode('add');
    document.getElementById('modal-bg').classList.add('show');
    setTimeout(() => {
        document.getElementById('modal-url').focus();
        trySmartPasteIntoModal();
    }, 50);
}
function openEditModal(kind, id) {
    const list = kind === 'walk' ? walks : tracks;
    const item = list.find(x => x.id === id);
    if (!item) return;
    modalMode = 'edit';
    modalKind = kind;
    editId = id;
    document.getElementById('modal-title').textContent = kind === 'walk' ? 'Edit walk' : 'Edit track';
    const urlField = document.getElementById('modal-url');
    urlField.value = item.playlistId
        ? `https://www.youtube.com/playlist?list=${item.playlistId}`
        : (item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : '');
    urlField.disabled = true;
    document.getElementById('modal-name').value = item.name;
    document.getElementById('modal-tags').value = (item.tags || []).join(', ');
    document.getElementById('modal-save').textContent = 'Save';
    setModalUiMode('edit');
    document.getElementById('modal-bg').classList.add('show');
    setTimeout(() => document.getElementById('modal-name').focus(), 50);
}
function openBulkModal(kind) {
    modalMode = 'bulk';
    modalKind = kind;
    editId = null;
    document.getElementById('modal-title').textContent = kind === 'walk' ? 'Bulk add walks' : 'Bulk add tracks';
    document.getElementById('modal-url-bulk').value = '';
    document.getElementById('modal-tags').value = kind === 'walk' ? 'seoul' : '';
    document.getElementById('modal-save').textContent = 'Add all';
    setModalUiMode('bulk');
    document.getElementById('modal-bg').classList.add('show');
    setTimeout(() => document.getElementById('modal-url-bulk').focus(), 50);
}
function closeAddModal() {
    document.getElementById('modal-bg').classList.remove('show');
    document.getElementById('modal-url').disabled = false;
    modalMode = null; modalKind = null; editId = null;
}
function setupModalToggle() {
    const btn = document.getElementById('modal-toggle-bulk');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (!modalKind) return;
        if (modalMode === 'bulk') openAddModal(modalKind);
        else openBulkModal(modalKind);
    });
}

function commitModal() {
    if (modalMode === 'edit') return commitEdit();
    if (modalMode === 'bulk') return commitBulk();
    return commitAdd();
}
function commitAdd() {
    const url  = document.getElementById('modal-url').value;
    const name = document.getElementById('modal-name').value.trim();
    const tags = document.getElementById('modal-tags').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const ref = parseYouTubeRef(url);
    if (!ref) { alert('Could not parse a YouTube video or playlist ID from that URL.'); return; }
    if (!name) { alert('Please give it a name.'); return; }
    if (modalKind === 'walk' && !ref.videoId) { alert('Walks need a video URL (not just a playlist).'); return; }
    const item = {
        id: `${modalKind === 'walk' ? 'w' : 't'}_${Date.now()}`,
        name,
        videoId: ref.videoId,
        tags,
    };
    if (modalKind === 'track' && ref.playlistId) {
        item.playlistId = ref.playlistId;
        if (!item.tags.includes('playlist')) item.tags.push('playlist');
    }
    if (modalKind === 'walk') {
        walks.push(item); save(STORE.walks, walks);
        renderFilters('walk'); renderList('walk');
    } else {
        tracks.push(item); save(STORE.tracks, tracks);
        renderFilters('track'); renderList('track');
    }
    renderMoods();
    closeAddModal();
}
function commitEdit() {
    if (!editId || !modalKind) return;
    const list = modalKind === 'walk' ? walks : tracks;
    const item = list.find(x => x.id === editId);
    if (!item) { closeAddModal(); return; }
    const name = document.getElementById('modal-name').value.trim();
    const tags = document.getElementById('modal-tags').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!name) { alert('Please give it a name.'); return; }
    item.name = name;
    item.tags = tags;
    save(modalKind === 'walk' ? STORE.walks : STORE.tracks, list);
    if (modalKind === 'walk' && state.walkId === editId) {
        document.getElementById('now-walk').textContent = name;
    }
    if (modalKind === 'track' && state.trackId === editId) {
        document.getElementById('now-track').innerHTML = '<i class="fa-solid fa-music"></i>' + escapeHtml(name);
    }
    renderFilters(modalKind); renderList(modalKind); renderPairs(); renderMoods();
    closeAddModal();
}
function commitBulk() {
    const text = document.getElementById('modal-url-bulk').value;
    const tags = document.getElementById('modal-tags').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) { alert('Paste at least one URL.'); return; }
    let added = 0, skipped = 0;
    for (const line of lines) {
        const ref = parseYouTubeRef(line);
        if (!ref) { skipped++; continue; }
        if (modalKind === 'walk' && !ref.videoId) { skipped++; continue; }
        const baseName = (modalKind === 'walk' ? 'Walk ' : 'Track ') + (ref.videoId || ref.playlistId).slice(0, 6);
        const item = {
            id: `${modalKind === 'walk' ? 'w' : 't'}_${Date.now()}_${added}`,
            name: baseName,
            videoId: ref.videoId,
            tags: tags.slice(),
        };
        if (modalKind === 'track' && ref.playlistId) {
            item.playlistId = ref.playlistId;
            if (!item.tags.includes('playlist')) item.tags.push('playlist');
        }
        if (modalKind === 'walk') walks.push(item); else tracks.push(item);
        added++;
    }
    save(STORE.walks, walks); save(STORE.tracks, tracks);
    renderFilters(modalKind); renderList(modalKind); renderMoods();
    closeAddModal();
    if (skipped) alert(`Added ${added}, skipped ${skipped} (couldn't parse).`);
}

/* ── Pairings ── */
let pendingPairDelete = { id: null, timeout: null };

function renderPairs() {
    const container = document.getElementById('pair-list');
    if (pairs.length === 0) {
        container.innerHTML = `<div class="pair-empty">Save a walk + track combo and it shows up here.</div>`;
        return;
    }
    container.innerHTML = pairs.map(p => {
        const w = walks.find(x => x.id === p.walkId);
        const t = tracks.find(x => x.id === p.trackId);
        if (!w || !t) return '';
        return `
            <div class="pair-card" data-pair="${escapeHtml(p.id)}" draggable="true">
                <button class="pair-del" data-pair-del="${escapeHtml(p.id)}" aria-label="Delete" title="Delete"><i class="fa-solid fa-xmark"></i></button>
                <button class="pair-rename" data-pair-rename="${escapeHtml(p.id)}" aria-label="Rename" title="Rename"><i class="fa-solid fa-pen"></i></button>
                <div class="pair-name" data-pair-name="${escapeHtml(p.id)}">${escapeHtml(p.name)}</div>
                <div class="pair-detail">${escapeHtml(w.name)} · ${escapeHtml(t.name)}</div>
            </div>
        `;
    }).join('');
    container.querySelectorAll('.pair-card').forEach(el => {
        el.addEventListener('click', e => {
            if (e.target.closest('[data-pair-del]') || e.target.closest('[data-pair-rename]')) return;
            if (e.target.closest('[data-pair-name][contenteditable="true"]')) return;
            const p = pairs.find(x => x.id === el.dataset.pair);
            if (!p) return;
            selectWalk(p.walkId);
            selectTrack(p.trackId);
        });
        wirePairDrag(el);
    });
    container.querySelectorAll('[data-pair-del]').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            requestPairDelete(b.dataset.pairDel, b);
        });
    });
    container.querySelectorAll('[data-pair-rename]').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            beginPairRename(b.dataset.pairRename);
        });
    });
}

function beginPairRename(id) {
    const el = document.querySelector(`[data-pair-name="${CSS.escape(id)}"]`);
    if (!el) return;
    el.contentEditable = 'true';
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    const original = el.textContent;
    const finish = (commit) => {
        el.contentEditable = 'false';
        el.removeEventListener('blur', onBlur);
        el.removeEventListener('keydown', onKey);
        const next = el.textContent.trim();
        if (commit && next && next !== original) {
            const p = pairs.find(x => x.id === id);
            if (p) {
                p.name = next;
                save(STORE.pairs, pairs);
                flashMessage('Renamed pairing');
            }
        } else {
            el.textContent = original;
        }
    };
    const onBlur = () => finish(true);
    const onKey  = (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); el.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); el.textContent = original; el.blur(); }
    };
    el.addEventListener('blur', onBlur);
    el.addEventListener('keydown', onKey);
}

function requestPairDelete(id, btn) {
    if (pendingPairDelete.timeout) clearTimeout(pendingPairDelete.timeout);
    if (pendingPairDelete.id === id) {
        pendingPairDelete = { id: null, timeout: null };
        pairs = pairs.filter(p => p.id !== id);
        save(STORE.pairs, pairs);
        renderPairs();
        return;
    }
    pendingPairDelete.id = id;
    btn.classList.add('confirming');
    btn.title = 'Click again to delete';
    pendingPairDelete.timeout = setTimeout(() => {
        btn.classList.remove('confirming');
        btn.title = 'Delete';
        pendingPairDelete = { id: null, timeout: null };
    }, 2000);
}

function wirePairDrag(el) {
    el.addEventListener('dragstart', e => {
        if (e.target && e.target.getAttribute && e.target.getAttribute('contenteditable') === 'true') {
            e.preventDefault();
            return;
        }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', el.dataset.pair);
        el.classList.add('dragging');
        document.body.classList.add('internal-drag');
    });
    el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        document.body.classList.remove('internal-drag');
        document.querySelectorAll('.pair-card.drop-before, .pair-card.drop-after').forEach(x => {
            x.classList.remove('drop-before', 'drop-after');
        });
    });
    el.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = el.getBoundingClientRect();
        const before = (e.clientX - rect.left) < rect.width / 2;
        el.classList.toggle('drop-before', before);
        el.classList.toggle('drop-after', !before);
    });
    el.addEventListener('dragleave', () => {
        el.classList.remove('drop-before', 'drop-after');
    });
    el.addEventListener('drop', e => {
        e.preventDefault();
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId || draggedId === el.dataset.pair) return;
        const rect = el.getBoundingClientRect();
        const before = (e.clientX - rect.left) < rect.width / 2;
        const from = pairs.findIndex(p => p.id === draggedId);
        if (from < 0) return;
        const [moved] = pairs.splice(from, 1);
        let to = pairs.findIndex(p => p.id === el.dataset.pair);
        if (to < 0) { pairs.splice(from, 0, moved); return; }
        if (!before) to += 1;
        pairs.splice(to, 0, moved);
        save(STORE.pairs, pairs);
        renderPairs();
    });
}
function savePair() {
    if (!state.walkId || !state.trackId) return;
    const w = walks.find(x => x.id === state.walkId);
    const t = tracks.find(x => x.id === state.trackId);
    const defaultName = `${w.name.split(/[,—-]/)[0].trim()} + ${t.name.split('—')[0].trim()}`;
    const name = prompt('Name this pairing:', defaultName);
    if (!name) return;
    pairs.unshift({ id: `p_${Date.now()}`, name, walkId: state.walkId, trackId: state.trackId });
    save(STORE.pairs, pairs);
    renderPairs();
}

/* ── View toggle ── */
function applyView(cinema) {
    document.body.classList.toggle('view-cinema', cinema);
    const icon = document.getElementById('view-icon');
    if (icon) icon.className = cinema ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
    try { localStorage.setItem('slow-walking.view', cinema ? 'cinema' : 'split'); } catch {}
}

/* ── Music mode (shuffle / sequential / repeat-one) ── */
const MODE_ORDER = ['shuffle', 'sequential', 'repeat-one'];
const MODE_META = {
    'shuffle':     { icon: 'fa-shuffle',       label: 'Shuffle' },
    'sequential':  { icon: 'fa-repeat',        label: 'Loop list' },
    'repeat-one':  { icon: 'fa-arrow-rotate-right', label: 'Repeat one' },
};

function updateMusicControls() {
    const t = currentTrack();
    const isPlaylist = !!(t && t.playlistId);
    const wrap = document.getElementById('music-controls');
    if (wrap) wrap.style.display = isPlaylist ? '' : 'none';
    const modeBtn = document.getElementById('mode-btn');
    if (modeBtn) {
        const meta = MODE_META[state.musicMode] || MODE_META.shuffle;
        modeBtn.querySelector('i').className = 'fa-solid ' + meta.icon;
        modeBtn.title = meta.label;
        modeBtn.setAttribute('aria-label', meta.label);
    }
}

function cycleMusicMode() {
    const i = MODE_ORDER.indexOf(state.musicMode);
    state.musicMode = MODE_ORDER[(i + 1) % MODE_ORDER.length];
    save(STORE.state, state);
    updateMusicControls();
    applyMusicMode();
}

function skipTrack() {
    if (!musicPlayer || !playersReady.music) return;
    const t = currentTrack();
    if (!t) return;
    if (t.playlistId) {
        try { musicPlayer.nextVideo(); } catch {}
    } else {
        musicPlayer.seekTo(0);
        musicPlayer.playVideo();
    }
}

/* ── Mini-player (video is hidden by default; toggle shows it for ads) ── */
function setupMiniPlayer() {
    const tab = document.getElementById('music-mini-tab');
    const mini = document.getElementById('music-mini');
    const videoBtn = document.getElementById('video-btn');
    if (!mini) return;
    const setVisible = (visible) => {
        mini.classList.toggle('show-video', visible);
        if (videoBtn) {
            videoBtn.querySelector('i').className = visible ? 'fa-solid fa-eye-slash' : 'fa-regular fa-eye';
            videoBtn.title = visible ? 'Hide music video' : 'Show video (e.g. to skip an ad)';
        }
    };
    if (videoBtn) videoBtn.addEventListener('click', () => setVisible(!mini.classList.contains('show-video')));
    if (tab) tab.addEventListener('click', () => setVisible(false));
}

/* ── Channel-as-deck ── */
let browseMode = { walk: null, track: null }; // { channelId, name, uploadsPlaylistId, items, nextPageToken }

function renderChannelChips() {
    ['walk', 'track'].forEach(kind => {
        const container = document.getElementById(kind === 'walk' ? 'walk-channels' : 'track-channels');
        if (!container) return;
        const list = kind === 'walk' ? walkChannels : trackChannels;
        if (list.length === 0) { container.innerHTML = ''; return; }
        const active = browseMode[kind] && browseMode[kind].channelId;
        container.innerHTML = list.map(c => `
            <button class="channel-chip ${c.channelId === active ? 'active' : ''}" data-cid="${escapeHtml(c.channelId)}">
                <i class="fa-solid fa-tower-broadcast"></i>${escapeHtml(c.name)}
            </button>
        `).join('');
        container.querySelectorAll('.channel-chip').forEach(b => {
            b.addEventListener('click', () => enterBrowseMode(kind, b.dataset.cid));
        });
    });
}

async function enterBrowseMode(kind, channelId) {
    if (browseMode[kind] && browseMode[kind].channelId === channelId) {
        exitBrowseMode(kind);
        return;
    }
    if (!getApiKey()) {
        const proceed = confirm('Browsing channel uploads needs a YouTube API key. Set one now?');
        if (proceed) promptApiKey();
        return;
    }
    const list = kind === 'walk' ? walkChannels : trackChannels;
    const ch = list.find(c => c.channelId === channelId);
    if (!ch) return;
    browseMode[kind] = { channelId, name: ch.name, uploadsPlaylistId: ch.uploadsPlaylistId, items: [], nextPageToken: null };
    const banner = document.getElementById(kind === 'walk' ? 'walk-banner' : 'track-banner');
    banner.style.display = '';
    banner.innerHTML = `Browsing <strong>${escapeHtml(ch.name)}</strong> <button data-exit="${kind}">Back to library</button>`;
    banner.querySelector('[data-exit]').addEventListener('click', () => exitBrowseMode(kind));
    const listEl = document.getElementById(kind === 'walk' ? 'walk-list' : 'track-list');
    listEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.8125rem;padding:0.65rem 0.5rem;">Loading uploads&hellip;</div>`;
    document.getElementById(kind === 'walk' ? 'walk-filters' : 'track-filters').style.display = 'none';
    renderChannelChips();
    try {
        const { items, nextPageToken } = await ytChannelUploads(ch.uploadsPlaylistId);
        browseMode[kind].items = items;
        browseMode[kind].nextPageToken = nextPageToken;
        renderBrowseList(kind);
    } catch (e) {
        listEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.8125rem;padding:0.65rem 0.5rem;">${escapeHtml(e.message)}</div>`;
    }
}

function exitBrowseMode(kind) {
    browseMode[kind] = null;
    document.getElementById(kind === 'walk' ? 'walk-banner' : 'track-banner').style.display = 'none';
    document.getElementById(kind === 'walk' ? 'walk-filters' : 'track-filters').style.display = '';
    renderChannelChips();
    renderList(kind);
}

function renderBrowseList(kind) {
    const bm = browseMode[kind];
    if (!bm) return;
    const listEl = document.getElementById(kind === 'walk' ? 'walk-list' : 'track-list');
    if (bm.items.length === 0) {
        listEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.8125rem;padding:0.65rem 0.5rem;">No uploads found.</div>`;
        return;
    }
    const cards = bm.items.map((it, idx) => {
        const sn = it.snippet || {};
        const vid = (sn.resourceId && sn.resourceId.videoId) || '';
        const thumb = vid ? `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` : '';
        const alreadySaved = (kind === 'walk' ? walks : tracks).some(x => x.videoId === vid);
        return `
            <div class="item" data-browse-idx="${idx}">
                <div class="item-thumb" style="background-image:url('${thumb}')"></div>
                <div class="item-meta">
                    <div class="item-name">${escapeHtml(sn.title || '')}</div>
                    <div class="item-tags">${escapeHtml(bm.name)}</div>
                </div>
                <button class="item-edit" data-pin="${idx}" title="${alreadySaved ? 'Already saved' : 'Save to library'}" ${alreadySaved ? 'disabled' : ''}>
                    <i class="fa-solid ${alreadySaved ? 'fa-check' : 'fa-thumbtack'}"></i>
                </button>
            </div>
        `;
    }).join('');
    const more = bm.nextPageToken
        ? `<div class="discover-loadmore"><button id="${kind}-more">Load more</button></div>` : '';
    listEl.innerHTML = cards + more;
    listEl.querySelectorAll('[data-browse-idx]').forEach(el => {
        el.addEventListener('click', e => {
            if (e.target.closest('[data-pin]')) return;
            playBrowseItem(kind, parseInt(el.dataset.browseIdx, 10));
        });
    });
    listEl.querySelectorAll('[data-pin]').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            pinBrowseItem(kind, parseInt(b.dataset.pin, 10));
        });
    });
    const moreBtn = document.getElementById(kind + '-more');
    if (moreBtn) moreBtn.addEventListener('click', () => loadMoreBrowse(kind));
}

async function loadMoreBrowse(kind) {
    const bm = browseMode[kind];
    if (!bm || !bm.nextPageToken) return;
    try {
        const { items, nextPageToken } = await ytChannelUploads(bm.uploadsPlaylistId, bm.nextPageToken);
        bm.items = [...bm.items, ...items];
        bm.nextPageToken = nextPageToken;
        renderBrowseList(kind);
    } catch (e) { alert(e.message); }
}

function playBrowseItem(kind, idx) {
    const bm = browseMode[kind];
    if (!bm) return;
    const it = bm.items[idx];
    if (!it) return;
    const sn = it.snippet || {};
    const vid = sn.resourceId && sn.resourceId.videoId;
    if (!vid) return;
    const list = kind === 'walk' ? walks : tracks;
    let existing = list.find(x => x.videoId === vid);
    if (!existing) {
        existing = {
            id: `${kind === 'walk' ? 'w' : 't'}_${Date.now()}`,
            name: sn.title || 'Untitled',
            videoId: vid,
            tags: [],
        };
        list.push(existing);
        save(kind === 'walk' ? STORE.walks : STORE.tracks, list);
    }
    if (kind === 'walk') selectWalk(existing.id); else selectTrack(existing.id);
}

function pinBrowseItem(kind, idx) {
    const bm = browseMode[kind];
    if (!bm) return;
    const it = bm.items[idx];
    if (!it) return;
    const sn = it.snippet || {};
    const vid = sn.resourceId && sn.resourceId.videoId;
    if (!vid) return;
    const list = kind === 'walk' ? walks : tracks;
    if (list.some(x => x.videoId === vid)) { flashMessage('Already saved'); return; }
    const item = {
        id: `${kind === 'walk' ? 'w' : 't'}_${Date.now()}`,
        name: sn.title || 'Untitled',
        videoId: vid,
        tags: [],
    };
    list.push(item);
    save(kind === 'walk' ? STORE.walks : STORE.tracks, list);
    renderBrowseList(kind);
    flashMessage('Saved to library');
}

/* ── Discover modal ── */
let discoverState = {
    type: 'video',
    query: '',
    results: [],
    nextPageToken: null,
    activeChannel: null, // { channelId, title, uploadsPlaylistId }
    channelNextPageToken: null,
};

function openDiscover() {
    if (!getApiKey()) {
        const proceed = confirm('Discover needs a free YouTube API key. Set one now?');
        if (proceed) promptApiKey();
        return;
    }
    document.getElementById('discover-bg').classList.add('show');
    setTimeout(() => document.getElementById('discover-input').focus(), 50);
    renderChannelBookmarks();
}
function closeDiscover() {
    document.getElementById('discover-bg').classList.remove('show');
}

function switchDiscoverTab(tab) {
    document.querySelectorAll('.discover-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('tab-search').style.display   = tab === 'search'   ? '' : 'none';
    document.getElementById('tab-channels').style.display = tab === 'channels' ? '' : 'none';
}

let discoverDebounce;
function bindDiscover() {
    document.getElementById('discover-btn').addEventListener('click', openDiscover);
    document.getElementById('discover-close').addEventListener('click', closeDiscover);
    document.getElementById('discover-bg').addEventListener('click', e => {
        if (e.target.id === 'discover-bg') closeDiscover();
    });
    document.getElementById('tags-close').addEventListener('click', closeTagsModal);
    document.getElementById('tags-bg').addEventListener('click', e => {
        if (e.target.id === 'tags-bg') closeTagsModal();
    });
    document.querySelectorAll('.discover-tab').forEach(b => {
        b.addEventListener('click', () => switchDiscoverTab(b.dataset.tab));
    });
    const input = document.getElementById('discover-input');
    const typeSelect = document.getElementById('discover-type');
    input.addEventListener('input', () => {
        clearTimeout(discoverDebounce);
        discoverDebounce = setTimeout(() => runDiscoverSearch(input.value, typeSelect.value), 350);
    });
    typeSelect.addEventListener('change', () => runDiscoverSearch(input.value, typeSelect.value));

    document.getElementById('channel-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') addChannelBookmark(e.target.value, 'walk');
    });
    document.getElementById('channel-add-walk').addEventListener('click', () => {
        addChannelBookmark(document.getElementById('channel-input').value, 'walk');
    });
    document.getElementById('channel-add-track').addEventListener('click', () => {
        addChannelBookmark(document.getElementById('channel-input').value, 'track');
    });
}

async function runDiscoverSearch(query, type, append = false) {
    discoverState.query = query;
    discoverState.type = type;
    const container = document.getElementById('discover-results');
    if (!query) { container.innerHTML = '<div class="discover-empty">Type a query to search YouTube.</div>'; return; }
    if (!append) container.innerHTML = '<div class="discover-empty">Searching&hellip;</div>';
    try {
        const { items, nextPageToken } = await ytSearch(query, type, append ? discoverState.nextPageToken : '');
        const merged = append ? [...discoverState.results, ...items] : items;
        discoverState.results = merged;
        discoverState.nextPageToken = nextPageToken;
        let durations = {};
        if (type === 'video') {
            const ids = items.map(it => it.id.videoId).filter(Boolean);
            try { durations = await ytVideoDurations(ids); } catch {}
        }
        renderDiscoverResults(durations);
    } catch (e) {
        container.innerHTML = `<div class="discover-empty">${escapeHtml(e.message)}</div>`;
    }
}

function renderDiscoverResults(durationMap) {
    const container = document.getElementById('discover-results');
    if (discoverState.results.length === 0) {
        container.innerHTML = '<div class="discover-empty">No matches.</div>';
        return;
    }
    const dm = durationMap || {};
    const cards = discoverState.results.map((it, idx) => {
        const isVideo = it.id && it.id.videoId;
        const isPlaylist = it.id && it.id.playlistId;
        const isChannel = it.id && it.id.channelId;
        const sn = it.snippet || {};
        const thumb = (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default || {}).url) || '';
        const subtitle = isChannel ? 'Channel' : (sn.channelTitle || '');
        const duration = isVideo ? (dm[it.id.videoId] || '') : (isPlaylist ? 'Playlist' : '');
        let actions = '';
        if (isVideo) {
            actions = `
                <button data-act="add-walk" data-idx="${idx}">+ Walks</button>
                <button data-act="add-track" data-idx="${idx}">+ Music</button>
                <button data-act="play" data-idx="${idx}" title="Play preview"><i class="fa-solid fa-play"></i></button>
            `;
        } else if (isPlaylist) {
            actions = `<button data-act="add-track" data-idx="${idx}">+ Music</button>`;
        } else if (isChannel) {
            actions = `
                <button data-act="ch-walk"  data-idx="${idx}">+ Walks ch.</button>
                <button data-act="ch-track" data-idx="${idx}">+ Music ch.</button>
                <button data-act="ch-open"  data-idx="${idx}">Open</button>
            `;
        }
        const durBadge = duration ? `<span class="discover-duration">${escapeHtml(duration)}</span>` : '';
        return `
            <div class="discover-card">
                <div class="discover-thumb" style="background-image:url('${escapeHtml(thumb)}')">${durBadge}</div>
                <div class="discover-meta">
                    <div class="discover-name">${escapeHtml(sn.title || '')}</div>
                    <div class="discover-sub">${escapeHtml(subtitle)}</div>
                </div>
                <div class="discover-actions">${actions}</div>
            </div>
        `;
    }).join('');
    const more = discoverState.nextPageToken
        ? `<div class="discover-loadmore"><button id="discover-more">Load more</button></div>` : '';
    container.innerHTML = cards + more;
    container.querySelectorAll('.discover-actions button').forEach(b => {
        b.addEventListener('click', () => handleDiscoverAction(b.dataset.act, parseInt(b.dataset.idx, 10)));
    });
    const moreBtn = document.getElementById('discover-more');
    if (moreBtn) moreBtn.addEventListener('click', () => runDiscoverSearch(discoverState.query, discoverState.type, true));
}

function handleDiscoverAction(act, idx) {
    const it = discoverState.results[idx];
    if (!it) return;
    const sn = it.snippet || {};
    if (act === 'add-walk' || act === 'add-track') {
        const kind = act === 'add-walk' ? 'walk' : 'track';
        const videoId = (it.id && it.id.videoId) || null;
        const playlistId = (it.id && it.id.playlistId) || null;
        const item = {
            id: `${kind === 'walk' ? 'w' : 't'}_${Date.now()}`,
            name: sn.title || 'Untitled',
            videoId, tags: [],
        };
        if (kind === 'track' && playlistId) { item.playlistId = playlistId; item.tags.push('playlist'); }
        if (kind === 'walk') { walks.push(item); save(STORE.walks, walks); renderFilters('walk'); renderList('walk'); selectWalk(item.id); }
        else { tracks.push(item); save(STORE.tracks, tracks); renderFilters('track'); renderList('track'); selectTrack(item.id); }
        renderMoods();
        flashMessage(`Added "${sn.title}"`);
    } else if (act === 'play') {
        const videoId = it.id && it.id.videoId;
        if (!videoId) return;
        const item = { id: `tmp_${Date.now()}`, name: sn.title || 'Untitled', videoId, tags: [] };
        walks.push(item); save(STORE.walks, walks);
        renderFilters('walk'); renderList('walk');
        selectWalk(item.id);
        closeDiscover();
    } else if (act === 'ch-walk' || act === 'ch-track') {
        addChannelByItem(it, act === 'ch-walk' ? 'walk' : 'track');
    } else if (act === 'ch-open') {
        openChannelInDiscover((it.id || {}).channelId, sn.title);
    }
}

async function addChannelByItem(it, kind) {
    const cid = (it.id && it.id.channelId) || (it.snippet && it.snippet.channelId);
    if (!cid) return;
    try {
        const res = await ytResolveChannel(cid);
        addChannelEntry(kind, res);
    } catch (e) { alert('Could not add channel: ' + e.message); }
}

async function addChannelBookmark(input, kind) {
    if (!input.trim()) return;
    try {
        const res = await ytResolveChannel(input.trim());
        addChannelEntry(kind, res);
        document.getElementById('channel-input').value = '';
    } catch (e) { alert('Could not add channel: ' + e.message); }
}

function addChannelEntry(kind, res) {
    const list = kind === 'walk' ? walkChannels : trackChannels;
    if (list.find(c => c.channelId === res.channelId)) {
        flashMessage('Already bookmarked');
        return;
    }
    list.push({
        id: `c_${Date.now()}`,
        name: res.title,
        channelId: res.channelId,
        uploadsPlaylistId: res.uploadsPlaylistId,
        thumbnail: res.thumbnail,
    });
    save(kind === 'walk' ? STORE.walkChannels : STORE.trackChannels, list);
    renderChannelBookmarks();
    renderChannelChips();
    flashMessage(`Bookmarked ${res.title}`);
}

function renderChannelBookmarks() {
    const container = document.getElementById('channel-bookmarks');
    if (!container) return;
    const all = [
        ...walkChannels.map(c  => ({ ...c, kind: 'walk' })),
        ...trackChannels.map(c => ({ ...c, kind: 'track' })),
    ];
    if (all.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = all.map(c => `
        <div class="discover-card">
            <div class="discover-thumb" style="background-image:url('${escapeHtml(c.thumbnail || '')}')"></div>
            <div class="discover-meta">
                <div class="discover-name">${escapeHtml(c.name)}</div>
                <div class="discover-sub">${c.kind === 'walk' ? 'Walks channel' : 'Music channel'}</div>
            </div>
            <div class="discover-actions">
                <button data-act="open" data-cid="${escapeHtml(c.channelId)}">Browse</button>
                <button data-act="remove" data-kind="${c.kind}" data-cid="${escapeHtml(c.channelId)}">Remove</button>
            </div>
        </div>
    `).join('');
    container.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
            if (b.dataset.act === 'open') {
                const ch = all.find(x => x.channelId === b.dataset.cid);
                if (ch) openChannelInDiscover(ch.channelId, ch.name, ch.uploadsPlaylistId);
            } else {
                removeChannelBookmark(b.dataset.kind, b.dataset.cid);
            }
        });
    });
}
function removeChannelBookmark(kind, channelId) {
    if (kind === 'walk')  walkChannels  = walkChannels.filter(c  => c.channelId !== channelId);
    if (kind === 'track') trackChannels = trackChannels.filter(c => c.channelId !== channelId);
    save(STORE.walkChannels, walkChannels);
    save(STORE.trackChannels, trackChannels);
    renderChannelBookmarks();
    renderChannelChips();
}

async function openChannelInDiscover(channelId, title, uploadsPlaylistId) {
    switchDiscoverTab('search');
    document.getElementById('discover-input').value = '';
    const container = document.getElementById('discover-results');
    container.innerHTML = `<div class="discover-empty">Loading uploads from ${escapeHtml(title || 'channel')}&hellip;</div>`;
    try {
        let upl = uploadsPlaylistId;
        if (!upl) {
            const res = await ytResolveChannel(channelId);
            upl = res.uploadsPlaylistId;
        }
        const { items, nextPageToken } = await ytChannelUploads(upl);
        discoverState.activeChannel = { channelId, title, uploadsPlaylistId: upl };
        discoverState.channelNextPageToken = nextPageToken;
        const mapped = items.map(it => ({
            id: { videoId: it.snippet.resourceId && it.snippet.resourceId.videoId },
            snippet: it.snippet,
        }));
        discoverState.results = mapped;
        discoverState.nextPageToken = null;
        const ids = mapped.map(m => m.id.videoId).filter(Boolean);
        let durations = {};
        try { durations = await ytVideoDurations(ids); } catch {}
        renderDiscoverResults(durations);
    } catch (e) {
        container.innerHTML = `<div class="discover-empty">${escapeHtml(e.message)}</div>`;
    }
}


const YT_API = 'https://www.googleapis.com/youtube/v3';
const ytCache = new Map();
async function ytApi(path, params) {
    const key = getApiKey();
    if (!key) throw new Error('No API key');
    const cacheKey = path + ':' + JSON.stringify(params);
    if (ytCache.has(cacheKey)) return ytCache.get(cacheKey);
    const url = `${YT_API}/${path}?` + new URLSearchParams({ ...params, key }).toString();
    const r = await fetch(url);
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`YouTube API ${r.status}: ${body.slice(0, 200)}`);
    }
    const json = await r.json();
    ytCache.set(cacheKey, json);
    return json;
}

async function ytSearch(query, type = 'video', pageToken = '') {
    if (!query) return { items: [], nextPageToken: null };
    const params = { part: 'snippet', maxResults: 20, q: query, type };
    if (pageToken) params.pageToken = pageToken;
    const data = await ytApi('search', params);
    return { items: data.items || [], nextPageToken: data.nextPageToken || null };
}

async function ytVideoDurations(ids) {
    if (!ids.length) return {};
    const data = await ytApi('videos', { part: 'contentDetails', id: ids.join(',') });
    const map = {};
    (data.items || []).forEach(it => { map[it.id] = parseISODuration(it.contentDetails.duration); });
    return map;
}

function parseISODuration(iso) {
    if (!iso) return '';
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return '';
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2] || '0', 10);
    const s = parseInt(m[3] || '0', 10);
    if (h) return `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${min}:${String(s).padStart(2, '0')}`;
}

async function ytResolveChannel(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) throw new Error('Empty input');
    const ref = parseYouTubeRef(trimmed) || {};
    let ch = ref.channel;
    if (!ch) {
        if (/^UC[a-zA-Z0-9_-]{20,}$/.test(trimmed)) ch = { id: trimmed };
        else if (/^@/.test(trimmed)) ch = { handle: trimmed.slice(1) };
    }
    if (!ch && ref.videoId && !ref.channel) {
        throw new Error('That looks like a video URL — paste the channel URL or @handle');
    }
    const tryFetch = async (params) => {
        const data = await ytApi('channels', { part: 'snippet,contentDetails', ...params });
        return (data.items || [])[0];
    };
    let item = null;
    if (ch && ch.id) item = await tryFetch({ id: ch.id });
    else if (ch && ch.handle) {
        item = await tryFetch({ forHandle: '@' + ch.handle });
        if (!item) item = await tryFetch({ forHandle: ch.handle });
    }
    else if (ch && ch.username) item = await tryFetch({ forUsername: ch.username });
    if (!item) {
        const query = ch && (ch.handle || ch.username) ? (ch.handle || ch.username) : trimmed;
        const search = await ytApi('search', { part: 'snippet', maxResults: 1, type: 'channel', q: query });
        const hit = (search.items || [])[0];
        if (hit && hit.id && hit.id.channelId) item = await tryFetch({ id: hit.id.channelId });
    }
    if (!item) throw new Error('Channel not found');
    return {
        channelId: item.id,
        title: item.snippet.title,
        thumbnail: (item.snippet.thumbnails && (item.snippet.thumbnails.default || {}).url) || '',
        uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    };
}

async function ytChannelUploads(uploadsPlaylistId, pageToken = '') {
    const params = { part: 'snippet', maxResults: 20, playlistId: uploadsPlaylistId };
    if (pageToken) params.pageToken = pageToken;
    const data = await ytApi('playlistItems', params);
    return { items: data.items || [], nextPageToken: data.nextPageToken || null };
}

/* ── Tag manager ── */
let pendingTagDelete = { tag: null, timeout: null };

function openTagsModal() {
    document.getElementById('tags-bg').classList.add('show');
    renderTagsList();
}
function closeTagsModal() {
    document.getElementById('tags-bg').classList.remove('show');
}

function renderTagsList() {
    const counts = {};
    walks.forEach(w => (w.tags || []).forEach(t => {
        counts[t] = counts[t] || { walks: 0, tracks: 0 };
        counts[t].walks++;
    }));
    tracks.forEach(tr => (tr.tags || []).forEach(t => {
        counts[t] = counts[t] || { walks: 0, tracks: 0 };
        counts[t].tracks++;
    }));
    const tags = Object.keys(counts).sort((a, b) => a.localeCompare(b));
    const container = document.getElementById('tags-list');
    if (!tags.length) {
        container.innerHTML = '<div class="discover-empty">No tags in your library yet.</div>';
        return;
    }
    container.innerHTML = tags.map(t => {
        const c = counts[t];
        const sub = [];
        if (c.walks)  sub.push(`${c.walks} walk${c.walks === 1 ? '' : 's'}`);
        if (c.tracks) sub.push(`${c.tracks} track${c.tracks === 1 ? '' : 's'}`);
        return `
            <div class="tag-row" data-tag="${escapeHtml(t)}">
                <input type="text" class="tag-name" value="${escapeHtml(t)}" data-orig="${escapeHtml(t)}">
                <span class="tag-count">${sub.join(' · ')}</span>
                <button class="tag-del" data-tag-del="${escapeHtml(t)}">Delete</button>
            </div>
        `;
    }).join('');
    container.querySelectorAll('input.tag-name').forEach(inp => {
        const commit = () => {
            const oldName = inp.dataset.orig;
            const newName = inp.value.trim();
            if (!newName || newName === oldName) { inp.value = oldName; return; }
            renameTag(oldName, newName);
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
            if (e.key === 'Escape') { inp.value = inp.dataset.orig; inp.blur(); }
        });
    });
    container.querySelectorAll('[data-tag-del]').forEach(b => {
        b.addEventListener('click', () => requestTagDelete(b.dataset.tagDel, b));
    });
}

function renameTag(oldName, newName) {
    let touched = 0;
    const replace = (it) => {
        if (!it.tags || !it.tags.includes(oldName)) return;
        it.tags = [...new Set(it.tags.map(t => t === oldName ? newName : t))];
        touched++;
    };
    walks.forEach(replace);
    tracks.forEach(replace);
    save(STORE.walks, walks);
    save(STORE.tracks, tracks);
    if (state.walkFilter  === oldName) { state.walkFilter  = newName; }
    if (state.trackFilter === oldName) { state.trackFilter = newName; }
    save(STORE.state, state);
    renderFilters('walk'); renderFilters('track');
    renderList('walk');    renderList('track');
    renderMoods();
    renderTagsList();
    flashMessage(`Renamed “${oldName}” → “${newName}” (${touched} item${touched === 1 ? '' : 's'})`);
}

function requestTagDelete(tag, btn) {
    if (pendingTagDelete.timeout) clearTimeout(pendingTagDelete.timeout);
    if (pendingTagDelete.tag === tag) {
        pendingTagDelete = { tag: null, timeout: null };
        deleteTag(tag);
        return;
    }
    pendingTagDelete.tag = tag;
    btn.classList.add('confirming');
    btn.textContent = 'Confirm?';
    pendingTagDelete.timeout = setTimeout(() => {
        btn.classList.remove('confirming');
        btn.textContent = 'Delete';
        pendingTagDelete = { tag: null, timeout: null };
    }, 2000);
}

function deleteTag(tag) {
    const strip = (it) => {
        if (!it.tags) return;
        it.tags = it.tags.filter(t => t !== tag);
    };
    walks.forEach(strip);
    tracks.forEach(strip);
    save(STORE.walks, walks);
    save(STORE.tracks, tracks);
    if (state.walkFilter  === tag) state.walkFilter  = 'all';
    if (state.trackFilter === tag) state.trackFilter = 'all';
    save(STORE.state, state);
    renderFilters('walk'); renderFilters('track');
    renderList('walk');    renderList('track');
    renderMoods();
    renderTagsList();
    flashMessage(`Removed tag “${tag}”`);
}

/* ── YouTube API key ── */
function getApiKey() { return load(STORE.apiKey, ''); }
function promptApiKey() {
    const current = getApiKey();
    const next = prompt(
        'Paste your YouTube Data API v3 key.\n\n' +
        'Get one free at console.cloud.google.com → Credentials.\n' +
        'Restrict it to your domain via HTTP referrer.\n\n' +
        'Leave empty and press OK to remove it.',
        current
    );
    if (next === null) return;
    save(STORE.apiKey, next.trim());
    updateDiscoverButton();
    flashMessage(next.trim() ? 'API key saved' : 'API key cleared');
}
function updateDiscoverButton() {
    const btn = document.getElementById('discover-btn');
    if (!btn) return;
    btn.classList.toggle('has-key', !!getApiKey());
}

/* ── Share Target / drag-drop / smart paste ── */
function handleShareTarget() {
    const params = new URLSearchParams(location.search);
    const candidate = params.get('shared_url') || params.get('shared_text') || params.get('url') || params.get('text');
    if (!candidate) return;
    const urlMatch = candidate.match(/https?:\/\/[^\s]+/);
    const url = urlMatch ? urlMatch[0] : candidate;
    const ref = parseYouTubeRef(url);
    if (!ref) return;
    try { history.replaceState(null, '', location.pathname + location.hash); } catch {}
    const kind = ref.playlistId ? 'track' : 'walk';
    openAddModalPrefilled(kind, url, params.get('shared_title') || params.get('title') || '');
}

function setupDragDrop() {
    let dragCount = 0;
    document.addEventListener('dragenter', e => {
        if (!e.dataTransfer) return;
        if (document.body.classList.contains('internal-drag')) return;
        if (![...e.dataTransfer.types].some(t => t === 'text/plain' || t === 'text/uri-list')) return;
        dragCount++;
        document.body.classList.add('dragging');
    });
    document.addEventListener('dragleave', () => {
        dragCount = Math.max(0, dragCount - 1);
        if (dragCount === 0) document.body.classList.remove('dragging');
    });
    document.addEventListener('dragover', e => { e.preventDefault(); });
    document.addEventListener('drop', e => {
        e.preventDefault();
        dragCount = 0;
        document.body.classList.remove('dragging');
        const dt = e.dataTransfer;
        if (!dt) return;
        const text = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
        const ref = parseYouTubeRef(text);
        if (!ref) return;
        const kind = ref.playlistId ? 'track' : 'walk';
        openAddModalPrefilled(kind, text.trim(), '');
    });
}

function setupGlobalPaste() {
    if (window.matchMedia && window.matchMedia('(hover: none)').matches) return;
    document.addEventListener('paste', e => {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        const text = e.clipboardData && e.clipboardData.getData('text');
        if (!text) return;
        const ref = parseYouTubeRef(text);
        if (!ref) return;
        const kind = ref.playlistId ? 'track' : 'walk';
        openAddModalPrefilled(kind, text.trim(), '');
    });
}

function openAddModalPrefilled(kind, url, name) {
    openAddModal(kind);
    const urlField = document.getElementById('modal-url');
    if (urlField) urlField.value = url || '';
    if (name) {
        const nameField = document.getElementById('modal-name');
        if (nameField) nameField.value = name;
    }
    fetchOEmbedTitle(url);
}

async function fetchOEmbedTitle(url) {
    if (!url) return;
    const ref = parseYouTubeRef(url);
    if (!ref || (!ref.videoId && !ref.playlistId)) return;
    const nameField = document.getElementById('modal-name');
    if (!nameField || nameField.value.trim()) return;
    try {
        const r = await fetch('https://noembed.com/embed?url=' + encodeURIComponent(url));
        if (!r.ok) return;
        const data = await r.json();
        if (data && data.title && !nameField.value.trim()) nameField.value = data.title;
    } catch {}
}

async function trySmartPasteIntoModal() {
    if (!navigator.clipboard || !navigator.clipboard.readText) return;
    try {
        const text = await navigator.clipboard.readText();
        if (!text) return;
        const ref = parseYouTubeRef(text);
        if (!ref) return;
        const urlField = document.getElementById('modal-url');
        const nameField = document.getElementById('modal-name');
        if (!urlField || urlField.value.trim()) return;
        urlField.value = text.trim();
        if (nameField && !nameField.value.trim()) fetchOEmbedTitle(text.trim());
    } catch {}
}

/* ── Surprise me ── */
function doSurprise() {
    const wPool = state.walkFilter === 'all' ? walks : walks.filter(w => (w.tags || []).includes(state.walkFilter));
    const tPool = state.trackFilter === 'all' ? tracks : tracks.filter(t => (t.tags || []).includes(state.trackFilter));
    if (wPool.length === 0 && tPool.length === 0) return;
    if (wPool.length) selectWalk(wPool[Math.floor(Math.random() * wPool.length)].id);
    if (tPool.length) selectTrack(tPool[Math.floor(Math.random() * tPool.length)].id);
}

/* ── Mood presets ── */
const MOODS = [
    { name: 'Late night',   icon: 'fa-moon',          walkTag: 'night',    trackTag: 'all' },
    { name: 'City lights',  icon: 'fa-city',          walkTag: 'seoul',    trackTag: 'playlist' },
    { name: 'Rainy stroll', icon: 'fa-cloud-rain',    walkTag: 'rain',     trackTag: 'all' },
    { name: 'Reset',        icon: 'fa-rotate-left',   walkTag: 'all',      trackTag: 'all' },
];
function moodApplicable(m) {
    if (m.walkTag === 'all' && m.trackTag === 'all') return true;
    const walkTags  = new Set(); walks.forEach(w => (w.tags || []).forEach(t => walkTags.add(t)));
    const trackTags = new Set(); tracks.forEach(t => (t.tags || []).forEach(t => trackTags.add(t)));
    if (m.walkTag !== 'all'  && !walkTags.has(m.walkTag)) return false;
    if (m.trackTag !== 'all' && !trackTags.has(m.trackTag)) return false;
    return true;
}
function renderMoods() {
    const wrap = document.getElementById('moods');
    if (!wrap) return;
    const usable = MOODS.filter(moodApplicable);
    if (usable.length <= 1) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = '<span class="moods-label">Moods</span>' + usable.map((m, i) =>
        `<button class="mood-pill" data-mood="${i}"><i class="fa-solid ${m.icon}"></i>${escapeHtml(m.name)}</button>`
    ).join('');
    wrap.querySelectorAll('[data-mood]').forEach(b => {
        b.addEventListener('click', () => {
            const m = usable[parseInt(b.dataset.mood, 10)];
            if (!m) return;
            state.walkFilter  = m.walkTag;
            state.trackFilter = m.trackTag;
            save(STORE.state, state);
            renderFilters('walk'); renderList('walk');
            renderFilters('track'); renderList('track');
        });
    });
}

/* ── Sleep timer ── */
let sleepTimerId = null;
let sleepEndAt = 0;
let sleepTickId = null;
function setSleepTimer(minutes) {
    cancelSleepTimer();
    if (!minutes) return;
    sleepEndAt = Date.now() + minutes * 60 * 1000;
    sleepTimerId = setTimeout(() => {
        if (walkPlayer)  try { walkPlayer.pauseVideo(); } catch {}
        if (musicPlayer) try { musicPlayer.pauseVideo(); } catch {}
        cancelSleepTimer();
    }, minutes * 60 * 1000);
    document.getElementById('sleep-btn').classList.add('sleep-active');
    sleepTickId = setInterval(updateSleepBadge, 1000);
    updateSleepBadge();
}
function cancelSleepTimer() {
    if (sleepTimerId) { clearTimeout(sleepTimerId); sleepTimerId = null; }
    if (sleepTickId)  { clearInterval(sleepTickId);  sleepTickId  = null; }
    sleepEndAt = 0;
    const btn = document.getElementById('sleep-btn');
    if (btn) btn.classList.remove('sleep-active');
    const badge = document.getElementById('sleep-countdown');
    if (badge) badge.style.display = 'none';
}
function updateSleepBadge() {
    const badge = document.getElementById('sleep-countdown');
    if (!badge) return;
    const remaining = Math.max(0, sleepEndAt - Date.now());
    if (remaining <= 0) { badge.style.display = 'none'; return; }
    const mins = Math.ceil(remaining / 60000);
    badge.textContent = mins + 'm';
    badge.style.display = '';
}

/* ── Crossfade ── */
function fadeMusic(from, to, ms, after) {
    if (!musicPlayer || !playersReady.music) { if (after) after(); return; }
    const start = performance.now();
    function tick(now) {
        const p = Math.min(1, (now - start) / ms);
        const v = Math.round(from + (to - from) * p);
        try { musicPlayer.setVolume(v); } catch {}
        if (p < 1) requestAnimationFrame(tick);
        else if (after) after();
    }
    requestAnimationFrame(tick);
}

/* ── URL-hash sharing ── */
function encodeHash() {
    if (!state.walkId && !state.trackId) return;
    const parts = [];
    if (state.walkId)  parts.push('w=' + encodeURIComponent(state.walkId));
    if (state.trackId) parts.push('t=' + encodeURIComponent(state.trackId));
    parts.push('mv=' + state.musicVol);
    parts.push('cv=' + state.cityVol);
    parts.push('mode=' + state.musicMode);
    const next = '#' + parts.join('&');
    if (location.hash !== next) {
        try { history.replaceState(null, '', next); } catch { location.hash = next; }
    }
}
function restoreFromHash() {
    if (!location.hash) return;
    const params = new URLSearchParams(location.hash.slice(1));
    const w = params.get('w'), t = params.get('t');
    const mv = parseInt(params.get('mv'), 10), cv = parseInt(params.get('cv'), 10);
    const mode = params.get('mode');
    if (Number.isFinite(mv)) {
        state.musicVol = mv;
        const slider = document.getElementById('music-vol'); const val = document.getElementById('music-vol-val');
        if (slider) slider.value = mv; if (val) val.textContent = mv;
    }
    if (Number.isFinite(cv)) {
        state.cityVol = cv;
        const slider = document.getElementById('city-vol'); const val = document.getElementById('city-vol-val');
        if (slider) slider.value = cv; if (val) val.textContent = cv;
    }
    if (mode && MODE_ORDER.includes(mode)) state.musicMode = mode;
    save(STORE.state, state);
    if (w && walks.find(x => x.id === w))  state.walkId  = w;
    if (t && tracks.find(x => x.id === t)) state.trackId = t;
    save(STORE.state, state);
    updateMusicControls();
    if (playersReady.walk && playersReady.music) tryRestoreSelection();
}
function copySessionLink() {
    encodeHash();
    const link = location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(() => {
            flashMessage('Link copied');
        }).catch(() => prompt('Copy this link:', link));
    } else {
        prompt('Copy this link:', link);
    }
}
function flashMessage(text) {
    let el = document.getElementById('flash-msg');
    if (!el) {
        el = document.createElement('div');
        el.id = 'flash-msg';
        el.style.cssText = 'position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);background:var(--text-main);color:var(--bg);padding:0.5rem 1rem;border-radius:999px;font-size:0.78rem;z-index:1500;opacity:0;transition:opacity 0.2s;';
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(flashMessage._t);
    flashMessage._t = setTimeout(() => { el.style.opacity = '0'; }, 1600);
}

/* ── Export / Import ── */
function exportLibrary() {
    const payload = { version: 1, exportedAt: new Date().toISOString(), walks, tracks, pairs };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `slow-walking-library-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}
function importLibraryFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const data = JSON.parse(reader.result);
            if (!data || (!Array.isArray(data.walks) && !Array.isArray(data.tracks))) throw new Error('bad format');
            const existingW = new Set(walks.map(w => w.id));
            const existingT = new Set(tracks.map(t => t.id));
            const existingP = new Set(pairs.map(p => p.id));
            (data.walks  || []).forEach(w => { if (w && w.id && w.videoId && !existingW.has(w.id)) walks.push(w); });
            (data.tracks || []).forEach(t => { if (t && t.id && (t.videoId || t.playlistId) && !existingT.has(t.id)) tracks.push(t); });
            (data.pairs  || []).forEach(p => { if (p && p.id && !existingP.has(p.id)) pairs.push(p); });
            save(STORE.walks, walks); save(STORE.tracks, tracks); save(STORE.pairs, pairs);
            renderFilters('walk');  renderList('walk');
            renderFilters('track'); renderList('track');
            renderPairs(); renderMoods();
            flashMessage('Library imported');
        } catch (e) {
            alert('Import failed: ' + e.message);
        }
    };
    reader.readAsText(file);
}

/* ── Top-bar wiring ── */
function setupTopBar() {
    document.getElementById('surprise-btn').addEventListener('click', doSurprise);

    const sleepBtn = document.getElementById('sleep-btn');
    const sleepPop = document.getElementById('sleep-popover');
    sleepBtn.addEventListener('click', e => {
        e.stopPropagation();
        sleepPop.classList.toggle('show');
        document.getElementById('settings-menu').classList.remove('show');
    });
    sleepPop.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            const mins = parseInt(b.dataset.sleep, 10);
            if (mins > 0) setSleepTimer(mins);
            else cancelSleepTimer();
            sleepPop.classList.remove('show');
        });
    });

    const settingsBtn = document.getElementById('settings-btn');
    const settingsMenu = document.getElementById('settings-menu');
    settingsBtn.addEventListener('click', e => {
        e.stopPropagation();
        settingsMenu.classList.toggle('show');
        sleepPop.classList.remove('show');
    });
    settingsMenu.querySelectorAll('[data-action]').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            const action = b.dataset.action;
            settingsMenu.classList.remove('show');
            if (action === 'export') exportLibrary();
            else if (action === 'import') document.getElementById('import-file').click();
            else if (action === 'bulk-walk')  openBulkModal('walk');
            else if (action === 'bulk-track') openBulkModal('track');
            else if (action === 'copy-link') copySessionLink();
            else if (action === 'api-key')   promptApiKey();
            else if (action === 'manage-tags') openTagsModal();
        });
    });

    document.getElementById('import-file').addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        if (file) importLibraryFromFile(file);
        e.target.value = '';
    });

    document.addEventListener('click', () => {
        sleepPop.classList.remove('show');
        settingsMenu.classList.remove('show');
    });
}

/* ── Wire it up ── */
document.addEventListener('DOMContentLoaded', () => {
    const savedView = localStorage.getItem('slow-walking.view');
    applyView(savedView === 'cinema');

    document.getElementById('view-toggle').addEventListener('click', () => {
        applyView(!document.body.classList.contains('view-cinema'));
    });

    bindVolume('music-vol', 'music-vol-val', 'music');
    bindVolume('city-vol',  'city-vol-val',  'city');
    if (isIOS) {
        const citySlider = document.getElementById('city-vol');
        const cityVal    = document.getElementById('city-vol-val');
        if (citySlider) {
            citySlider.disabled = true;
            citySlider.value = 0;
            citySlider.title = 'iOS only allows one audible video at a time — the walk plays silently.';
        }
        if (cityVal) cityVal.textContent = '–';
        state.cityVol = 0;
    }

    document.getElementById('play-btn').addEventListener('click', togglePlay);
    document.getElementById('save-btn').addEventListener('click', savePair);
    document.getElementById('mode-btn').addEventListener('click', cycleMusicMode);
    document.getElementById('skip-btn').addEventListener('click', skipTrack);

    document.querySelectorAll('[data-add]').forEach(b => {
        b.addEventListener('click', () => openAddModal(b.dataset.add));
    });

    document.querySelectorAll('[data-mode-toggle]').forEach(b => {
        b.addEventListener('click', () => {
            const kind = b.dataset.modeToggle;
            const target = b.dataset.target;
            setListMode(kind, listMode[kind] === target ? 'normal' : target);
        });
    });
    document.querySelectorAll('[data-bulk]').forEach(b => {
        b.addEventListener('click', () => {
            const kind = b.dataset.bulk;
            if (b.dataset.action === 'delete') bulkDelete(kind);
            else setListMode(kind, 'normal');
        });
    });
    document.getElementById('modal-cancel').addEventListener('click', closeAddModal);
    document.getElementById('modal-save').addEventListener('click', commitModal);

    let urlDebounce;
    document.getElementById('modal-url').addEventListener('input', e => {
        clearTimeout(urlDebounce);
        urlDebounce = setTimeout(() => fetchOEmbedTitle(e.target.value.trim()), 400);
    });
    document.getElementById('modal-bg').addEventListener('click', e => {
        if (e.target.id === 'modal-bg') closeAddModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && document.getElementById('modal-bg').classList.contains('show')) closeAddModal();
        if (e.key === ' ' && e.target === document.body) { e.preventDefault(); if (state.walkId || state.trackId) togglePlay(); }
    });

    renderFilters('walk'); renderList('walk');
    renderFilters('track'); renderList('track');
    renderPairs();
    renderMoods();
    updateMusicControls();
    setupMediaSession();
    setupMiniPlayer();
    setupTopBar();
    setupModalToggle();
    bindSearch('walk-search', 'walk');
    bindSearch('track-search', 'track');
    restoreFromHash();
    handleShareTarget();
    setupDragDrop();
    setupGlobalPaste();
    bindDiscover();
    updateDiscoverButton();
    renderChannelChips();
});
