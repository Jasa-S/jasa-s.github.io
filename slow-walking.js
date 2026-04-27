/* Slow Walking — pair a walking video with a music track or playlist on YouTube. */

const STORE = {
    walks: 'slow-walking.walks',
    tracks: 'slow-walking.tracks',
    pairs: 'slow-walking.pairs',
    state: 'slow-walking.state',
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
        videoId: 'SRpMapyw6Aw',
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
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return { videoId: trimmed, playlistId: null };
    let videoId = null, playlistId = null;
    const v = trimmed.match(/(?:v=|\/embed\/|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
    if (v) videoId = v[1];
    const l = trimmed.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (l) playlistId = l[1];
    if (!videoId && !playlistId) return null;
    return { videoId, playlistId };
}

/* ── YouTube IFrame players ── */
let walkPlayer = null;
let musicPlayer = null;
let playersReady = { walk: false, music: false };

window.onYouTubeIframeAPIReady = function () {
    walkPlayer = new YT.Player('yt-walk', {
        width: '100%', height: '100%',
        playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
            onReady: () => {
                playersReady.walk = true;
                walkPlayer.setVolume(state.cityVol);
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
            if (walkPlayer && playersReady.walk) walkPlayer.setVolume(val);
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

function renderList(kind) {
    const items = kind === 'walk' ? walks : tracks;
    const filterKey = kind === 'walk' ? 'walkFilter' : 'trackFilter';
    const searchKey = kind === 'walk' ? 'walkSearch' : 'trackSearch';
    const filter = state[filterKey];
    const search = (state[searchKey] || '').trim().toLowerCase();
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
    container.innerHTML = filtered.map(item => `
        <div class="item ${item.id === activeId ? 'active' : ''}" data-id="${escapeHtml(item.id)}">
            <div class="item-thumb" style="background-image:url('${thumbUrl(item.videoId)}')"></div>
            <div class="item-meta">
                <div class="item-name">${escapeHtml(item.name)}</div>
                <div class="item-tags">${(item.tags || []).map(escapeHtml).join(' · ')}</div>
            </div>
            <button class="item-edit" data-edit="${escapeHtml(item.id)}" aria-label="Edit"><i class="fa-solid fa-pen"></i></button>
            <button class="item-del" data-del="${escapeHtml(item.id)}" aria-label="Delete"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `).join('');
    container.querySelectorAll('.item').forEach(el => {
        el.addEventListener('click', e => {
            if (e.target.closest('[data-del]') || e.target.closest('[data-edit]')) return;
            kind === 'walk' ? selectWalk(el.dataset.id) : selectTrack(el.dataset.id);
        });
    });
    container.querySelectorAll('[data-del]').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            removeItem(kind, b.dataset.del);
        });
    });
    container.querySelectorAll('[data-edit]').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            openEditModal(kind, b.dataset.edit);
        });
    });
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
    setTimeout(() => document.getElementById('modal-url').focus(), 50);
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
            <div class="pair-card" data-pair="${escapeHtml(p.id)}">
                <button class="pair-del" data-pair-del="${escapeHtml(p.id)}" aria-label="Delete"><i class="fa-solid fa-xmark"></i></button>
                <div class="pair-name">${escapeHtml(p.name)}</div>
                <div class="pair-detail">${escapeHtml(w.name)} · ${escapeHtml(t.name)}</div>
            </div>
        `;
    }).join('');
    container.querySelectorAll('.pair-card').forEach(el => {
        el.addEventListener('click', e => {
            if (e.target.closest('[data-pair-del]')) return;
            const p = pairs.find(x => x.id === el.dataset.pair);
            if (!p) return;
            selectWalk(p.walkId);
            selectTrack(p.trackId);
        });
    });
    container.querySelectorAll('[data-pair-del]').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            pairs = pairs.filter(p => p.id !== b.dataset.pairDel);
            save(STORE.pairs, pairs);
            renderPairs();
        });
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

/* ── Mini-player ── */
function setupMiniPlayer() {
    const tab = document.getElementById('music-mini-tab');
    const mini = document.getElementById('music-mini');
    const chev = document.getElementById('music-mini-chevron');
    if (!tab || !mini) return;
    tab.addEventListener('click', () => {
        const collapsed = mini.classList.toggle('collapsed');
        if (chev) chev.className = collapsed ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
    });
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

    document.getElementById('play-btn').addEventListener('click', togglePlay);
    document.getElementById('save-btn').addEventListener('click', savePair);
    document.getElementById('mode-btn').addEventListener('click', cycleMusicMode);
    document.getElementById('skip-btn').addEventListener('click', skipTrack);

    document.querySelectorAll('[data-add]').forEach(b => {
        b.addEventListener('click', () => openAddModal(b.dataset.add));
    });
    document.getElementById('modal-cancel').addEventListener('click', closeAddModal);
    document.getElementById('modal-save').addEventListener('click', commitModal);
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
});
