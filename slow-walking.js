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
        width: '200', height: '200',
        playerVars: { autoplay: 0, controls: 0, playsinline: 1 },
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
    if (e.data === YT.PlayerState.PLAYING && e.target === musicPlayer) {
        applyMusicMode();
    }
    if (e.data === YT.PlayerState.ENDED) {
        if (e.target === musicPlayer) {
            const t = currentTrack();
            const isPlaylist = t && t.playlistId;
            if (!isPlaylist || state.musicMode === 'repeat-one') {
                e.target.seekTo(0);
                e.target.playVideo();
            }
            // else YouTube handles looping/shuffle via setLoop/setShuffle
        } else {
            e.target.seekTo(0);
            e.target.playVideo();
        }
    }
}

function currentTrack() {
    return tracks.find(t => t.id === state.trackId) || null;
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
}

function selectTrack(id, autoplay = true) {
    const t = tracks.find(x => x.id === id);
    if (!t) return;
    state.trackId = id;
    save(STORE.state, state);
    if (musicPlayer && playersReady.music) {
        if (t.playlistId) {
            musicPlayer.loadPlaylist({ list: t.playlistId, listType: 'playlist', index: 0 });
            setTimeout(applyMusicMode, 800);
        } else {
            musicPlayer.loadVideoById({ videoId: t.videoId });
        }
        musicPlayer.setVolume(state.musicVol);
        if (!autoplay) musicPlayer.pauseVideo();
    }
    document.getElementById('now-track').innerHTML = '<i class="fa-solid fa-music"></i>' + escapeHtml(t.name);
    document.getElementById('now-track').classList.remove('now-empty');
    renderList('track');
    refreshPlayButton();
    refreshSaveButton();
    updateMusicControls();
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
    const filter = state[filterKey];
    const activeId = kind === 'walk' ? state.walkId : state.trackId;
    const container = document.getElementById(kind === 'walk' ? 'walk-list' : 'track-list');
    const filtered = filter === 'all' ? items : items.filter(i => (i.tags || []).includes(filter));
    if (filtered.length === 0) {
        const sources = SOURCES[kind] || [];
        const links = sources.map(s =>
            `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener" style="color:var(--cosmic-purple);text-decoration:none;">${escapeHtml(s.label)} <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:0.65rem;"></i></a>`
        ).join(' &middot; ');
        const hint = items.length === 0
            ? `Library empty. Browse ${links} &mdash; copy a video URL, then hit <strong>+ Add</strong>.`
            : `No matches for this filter.`;
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
            <button class="item-del" data-del="${escapeHtml(item.id)}" aria-label="Delete"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `).join('');
    container.querySelectorAll('.item').forEach(el => {
        el.addEventListener('click', e => {
            if (e.target.closest('[data-del]')) return;
            kind === 'walk' ? selectWalk(el.dataset.id) : selectTrack(el.dataset.id);
        });
    });
    container.querySelectorAll('[data-del]').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            removeItem(kind, b.dataset.del);
        });
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

/* ── Add modal ── */
let addKind = null;
function openAddModal(kind) {
    addKind = kind;
    document.getElementById('modal-title').textContent = kind === 'walk' ? 'Add a walk' : 'Add a track';
    document.getElementById('modal-url').value = '';
    document.getElementById('modal-name').value = '';
    document.getElementById('modal-tags').value = kind === 'walk' ? 'seoul' : 'joji';
    document.getElementById('modal-bg').classList.add('show');
    setTimeout(() => document.getElementById('modal-url').focus(), 50);
}
function closeAddModal() {
    document.getElementById('modal-bg').classList.remove('show');
    addKind = null;
}
function commitAdd() {
    const url  = document.getElementById('modal-url').value;
    const name = document.getElementById('modal-name').value.trim();
    const tags = document.getElementById('modal-tags').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const ref = parseYouTubeRef(url);
    if (!ref) { alert('Could not parse a YouTube video or playlist ID from that URL.'); return; }
    if (!name) { alert('Please give it a name.'); return; }
    if (addKind === 'walk' && !ref.videoId) { alert('Walks need a video URL (not just a playlist).'); return; }
    const item = {
        id: `${addKind === 'walk' ? 'w' : 't'}_${Date.now()}`,
        name,
        videoId: ref.videoId,
        tags,
    };
    if (addKind === 'track' && ref.playlistId) {
        item.playlistId = ref.playlistId;
        if (!item.tags.includes('playlist')) item.tags.push('playlist');
    }
    if (addKind === 'walk') {
        walks.push(item); save(STORE.walks, walks);
        renderFilters('walk'); renderList('walk');
    } else {
        tracks.push(item); save(STORE.tracks, tracks);
        renderFilters('track'); renderList('track');
    }
    closeAddModal();
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
    document.getElementById('modal-save').addEventListener('click', commitAdd);
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
    updateMusicControls();
});
