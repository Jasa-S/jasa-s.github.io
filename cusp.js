(function () {
    'use strict';

    var STORAGE_KEY    = 'cusp.milestones.v2';
    var STORAGE_KEY_V1 = 'cusp.milestones.v1';
    var MANUAL_SORT_KEY = 'cusp.manualSort.v1';
    var PERM_KEY    = 'cusp.notifPermAsked.v1';
    var DEFAULT_OFFSETS_DAYS = [30, 7, 1, 0];
    var DAY_MS = 86400000;
    var MAX_TIMEOUT = 2147483000;
    var UNDO_MS = 6000;

    var state = [];
    var manualSort = false;
    var saveTimer = null;
    var cardRefs = new Map();
    var notifTimers = new Map();
    var openEditId = null;
    var pendingDelete = null;   // { milestone, idx, timer }
    var dragState = null;       // { id, srcEl }

    function uid() {
        return 'm_' + Math.random().toString(36).slice(2, 10);
    }

    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function load() {
        try {
            manualSort = localStorage.getItem(MANUAL_SORT_KEY) === '1';
        } catch (e) { manualSort = false; }

        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                var parsed = JSON.parse(raw);
                state = Array.isArray(parsed) ? parsed.filter(isValidMilestone).map(applyDefaults) : [];
                return;
            }
            // migrate from v1
            var rawV1 = localStorage.getItem(STORAGE_KEY_V1);
            if (rawV1) {
                var parsedV1 = JSON.parse(rawV1);
                state = Array.isArray(parsedV1) ? parsedV1.filter(isValidMilestone).map(applyDefaults) : [];
                save();
                try { localStorage.removeItem(STORAGE_KEY_V1); } catch (e) {}
                return;
            }
            state = [];
        } catch (e) {
            console.warn('CUSP: could not parse storage, resetting.', e);
            state = [];
        }
    }

    function applyDefaults(m) {
        if (m.pinned === undefined) m.pinned = false;
        if (m.order === undefined)  m.order  = 0;
        if (m.recur === undefined)  m.recur  = null;
        return m;
    }

    function isValidMilestone(m) {
        return m && typeof m.id === 'string'
            && typeof m.title === 'string'
            && typeof m.targetMs === 'number' && isFinite(m.targetMs)
            && typeof m.createdMs === 'number' && isFinite(m.createdMs);
    }

    function save() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            } catch (e) {
                console.warn('CUSP: could not save to storage.', e);
            }
        }, 200);
    }

    function addMilestone(data) {
        var maxOrder = state.reduce(function (a, x) { return Math.max(a, x.order || 0); }, 0);
        var m = {
            id: uid(),
            title: data.title,
            targetMs: data.targetMs,
            createdMs: Date.now(),
            emoji: data.emoji || '',
            color: data.color || '#7C3AED',
            pinned: false,
            order:  maxOrder + 1,
            recur:  null,
            notify: { enabled: false, offsetsDays: DEFAULT_OFFSETS_DAYS.slice(), firedKeys: [] }
        };
        state.push(m);
        save();
        render();
        return m;
    }

    function setManualSort(v) {
        manualSort = !!v;
        try { localStorage.setItem(MANUAL_SORT_KEY, manualSort ? '1' : '0'); } catch (e) {}
    }

    function togglePin(id) {
        var m = state.find(function (x) { return x.id === id; });
        if (!m) return;
        m.pinned = !m.pinned;
        save();
        render();
    }

    function updateMilestone(id, patch) {
        var idx = state.findIndex(function (m) { return m.id === id; });
        if (idx < 0) return;
        state[idx] = Object.assign({}, state[idx], patch);
        if (patch.targetMs !== undefined) {
            state[idx].notify = Object.assign({}, state[idx].notify, { firedKeys: [] });
        }
        save();
        render();
    }

    function deleteMilestone(id) {
        state = state.filter(function (m) { return m.id !== id; });
        clearNotifTimers(id);
        save();
        render();
    }

    function toggleNotify(id) {
        var m = state.find(function (x) { return x.id === id; });
        if (!m) return;
        if (!m.notify.enabled) {
            ensureNotifPermission().then(function (granted) {
                if (granted) {
                    m.notify.enabled = true;
                    save();
                    render();
                } else {
                    flashError('Notifications were not granted by your browser.');
                }
            });
        } else {
            m.notify.enabled = false;
            clearNotifTimers(id);
            save();
            render();
        }
    }

    function ensureNotifPermission() {
        if (!('Notification' in window)) {
            return Promise.resolve(false);
        }
        if (Notification.permission === 'granted') return Promise.resolve(true);
        if (Notification.permission === 'denied') return Promise.resolve(false);
        try { localStorage.setItem(PERM_KEY, '1'); } catch (e) {}
        return Notification.requestPermission().then(function (p) {
            return p === 'granted';
        });
    }

    function offsetKey(daysBefore) { return String(daysBefore); }

    function fireNotif(m, daysBefore) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        var title, body;
        var when = new Date(m.targetMs).toLocaleString();
        if (daysBefore === 0) {
            title = (m.emoji ? m.emoji + ' ' : '') + m.title + ' — reached!';
            body  = 'Target reached at ' + when + '.';
        } else if (daysBefore === 1) {
            title = (m.emoji ? m.emoji + ' ' : '') + '1 day to go: ' + m.title;
            body  = 'Target: ' + when + '.';
        } else {
            title = (m.emoji ? m.emoji + ' ' : '') + daysBefore + ' days to go: ' + m.title;
            body  = 'Target: ' + when + '.';
        }
        try { new Notification(title, { body: body, tag: 'cusp-' + m.id + '-' + daysBefore }); }
        catch (e) { /* ignore */ }
    }

    function scheduleNotifs(m) {
        clearNotifTimers(m.id);
        if (!m.notify || !m.notify.enabled) return;
        if (!('Notification' in window) || Notification.permission !== 'granted') return;

        var now = Date.now();
        var timers = [];
        var fired = m.notify.firedKeys || [];
        m.notify.offsetsDays.forEach(function (d) {
            var key = offsetKey(d);
            if (fired.indexOf(key) >= 0) return;
            var fireAt = m.targetMs - d * DAY_MS;
            var delta  = fireAt - now;
            if (delta < 0) {
                fireNotif(m, d);
                m.notify.firedKeys.push(key);
                save();
                return;
            }
            if (delta > MAX_TIMEOUT) return;
            var t = setTimeout((function (mm, dd, kk) {
                return function () {
                    fireNotif(mm, dd);
                    if (mm.notify.firedKeys.indexOf(kk) < 0) {
                        mm.notify.firedKeys.push(kk);
                        save();
                    }
                };
            }(m, d, key)), delta);
            timers.push(t);
        });
        if (timers.length) notifTimers.set(m.id, timers);
    }

    function clearNotifTimers(id) {
        var timers = notifTimers.get(id);
        if (timers) timers.forEach(function (t) { clearTimeout(t); });
        notifTimers.delete(id);
    }

    function rescheduleAll() {
        notifTimers.forEach(function (timers) {
            timers.forEach(function (t) { clearTimeout(t); });
        });
        notifTimers.clear();
        state.forEach(scheduleNotifs);
    }

    function scanMissedNotifs() {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        var now = Date.now();
        var changed = false;
        state.forEach(function (m) {
            if (!m.notify || !m.notify.enabled) return;
            m.notify.offsetsDays.forEach(function (d) {
                var key = offsetKey(d);
                if (m.notify.firedKeys.indexOf(key) >= 0) return;
                var fireAt = m.targetMs - d * DAY_MS;
                if (fireAt <= now) {
                    fireNotif(m, d);
                    m.notify.firedKeys.push(key);
                    changed = true;
                }
            });
        });
        if (changed) save();
    }

    function formatDuration(ms) {
        if (ms <= 0) return null;
        var totalS = Math.floor(ms / 1000);
        var d = Math.floor(totalS / 86400);
        var h = Math.floor((totalS % 86400) / 3600);
        var m = Math.floor((totalS % 3600) / 60);
        var s = totalS % 60;
        return { d: d, h: h, m: m, s: s };
    }

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }
    function dDisplay(d) { return d > 9999 ? '>9999' : String(d); }

    function pct(createdMs, targetMs, now) {
        var span = targetMs - createdMs;
        if (span <= 0) return 100;
        var p = ((now - createdMs) / span) * 100;
        return Math.max(0, Math.min(100, p));
    }

    function formatTarget(ms) {
        var d = new Date(ms);
        return d.toLocaleString(undefined, {
            weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    }

    function toLocalDatetimeInput(ms) {
        var d = new Date(ms);
        var pad = function (n) { return n < 10 ? '0' + n : n; };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
            + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function buildCardEl(m, isReached) {
        var card = document.createElement('div');
        card.className = 'm-card' + (isReached ? ' reached' : '') + (m.pinned ? ' pinned' : '');
        card.dataset.id = m.id;
        card.style.borderLeftColor = m.color || '#7C3AED';
        if (!isReached) card.draggable = true;

        var emojiHtml = m.emoji
            ? '<span class="m-emoji">' + esc(m.emoji) + '</span>' : '';

        var bellIcon = m.notify && m.notify.enabled ? 'fa-bell' : 'fa-bell-slash';
        var bellTitle = isReached
            ? 'Notifications (reached)'
            : (m.notify && m.notify.enabled
                ? 'Reminders on (fire while CUSP is open)'
                : 'Turn on reminders (fire while CUSP is open)');

        var pinHtml = isReached ? '' : (
            '<button class="icon-btn js-pin ' + (m.pinned ? 'active' : '') + '"'
            + ' aria-label="' + (m.pinned ? 'Unpin' : 'Pin to top') + '"'
            + ' title="' + (m.pinned ? 'Pinned to top — click to unpin' : 'Pin to top') + '">'
            + '<i class="fa-solid fa-thumbtack"></i></button>'
        );

        var bellHtml = isReached ? '' : (
            '<button class="icon-btn js-bell ' + (m.notify && m.notify.enabled ? 'active' : '') + '"'
            + ' aria-label="Toggle reminders" title="' + esc(bellTitle) + '">'
            + '<i class="fa-solid ' + bellIcon + '"></i></button>'
        );

        card.innerHTML =
            '<div class="m-head">'
              + '<div class="m-title-wrap">'
                + emojiHtml
                + '<h3 class="m-title">' + esc(m.title) + '</h3>'
              + '</div>'
              + '<div class="m-actions">'
                + pinHtml
                + bellHtml
                + '<button class="icon-btn js-edit" aria-label="Edit" title="Edit"><i class="fa-solid fa-pen"></i></button>'
                + '<button class="icon-btn js-delete" aria-label="Delete" title="Delete"><i class="fa-solid fa-trash"></i></button>'
              + '</div>'
            + '</div>'
            + '<p class="m-target js-target">' + esc(formatTarget(m.targetMs)) + '</p>'
            + '<div class="m-count js-count"></div>'
            + '<div class="m-bar"><div class="m-bar-fill js-bar" style="background:' + esc(m.color || '#7C3AED') + ';"></div></div>'
            + '<div class="m-meta">'
              + '<span class="js-pct">0%</span>'
              + '<span>' + (isReached ? 'Reached' : 'Started ' + esc(new Date(m.createdMs).toLocaleDateString())) + '</span>'
            + '</div>'
            + buildEditFormHtml(m);

        wireCardEvents(card, m, isReached);
        return card;
    }

    function buildEditFormHtml(m) {
        return '<form class="edit-form js-edit-form' + (openEditId === m.id ? ' open' : '') + '">'
            + '<input type="text" class="add-input js-edit-title" value="' + esc(m.title) + '" maxlength="80" aria-label="Title">'
            + '<input type="datetime-local" class="add-input js-edit-when" value="' + esc(toLocalDatetimeInput(m.targetMs)) + '" aria-label="Target">'
            + '<input type="text" class="add-input add-emoji js-edit-emoji" value="' + esc(m.emoji || '') + '" maxlength="4" placeholder="🎯" aria-label="Emoji">'
            + '<input type="color" class="add-color js-edit-color" value="' + esc(m.color || '#7C3AED') + '" aria-label="Color">'
            + '<button type="submit" class="btn"><i class="fa-solid fa-check"></i>Save</button>'
            + '<button type="button" class="btn js-edit-cancel"><i class="fa-solid fa-xmark"></i>Cancel</button>'
            + '</form>';
    }

    function wireCardEvents(card, m, isReached) {
        var bell = card.querySelector('.js-bell');
        if (bell) bell.addEventListener('click', function () { toggleNotify(m.id); });

        var pin = card.querySelector('.js-pin');
        if (pin) pin.addEventListener('click', function () { togglePin(m.id); });

        card.querySelector('.js-delete').addEventListener('click', function () {
            startSoftDelete(m.id);
        });

        card.querySelector('.js-edit').addEventListener('click', function () {
            openEditId = openEditId === m.id ? null : m.id;
            render();
        });

        var form = card.querySelector('.js-edit-form');
        form.addEventListener('submit', function (ev) {
            ev.preventDefault();
            var title = form.querySelector('.js-edit-title').value.trim();
            var whenS = form.querySelector('.js-edit-when').value;
            var emoji = form.querySelector('.js-edit-emoji').value.trim();
            var color = form.querySelector('.js-edit-color').value;
            if (!title) return;
            var t = whenS ? new Date(whenS).getTime() : NaN;
            if (!isFinite(t)) return;
            openEditId = null;
            saveEditInPlace(m.id, card, isReached, {
                title: title, targetMs: t, emoji: emoji, color: color
            });
        });
        form.querySelector('.js-edit-cancel').addEventListener('click', function () {
            openEditId = null;
            render();
        });

        if (!isReached) wireDrag(card, m);
    }

    function saveEditInPlace(id, card, wasReached, patch) {
        var idx = state.findIndex(function (x) { return x.id === id; });
        if (idx < 0) return;
        var cur = state[idx];
        var crossesPartition = wasReached !== (patch.targetMs <= Date.now());
        var rescheduleNeeded = patch.targetMs !== cur.targetMs;

        cur.title    = patch.title;
        cur.targetMs = patch.targetMs;
        cur.emoji    = patch.emoji;
        cur.color    = patch.color;
        if (rescheduleNeeded) cur.notify.firedKeys = [];
        save();

        if (crossesPartition) { render(); return; }

        // partial DOM update — no flicker
        card.style.borderLeftColor = patch.color || '#7C3AED';
        var titleEl = card.querySelector('.m-title');
        if (titleEl) titleEl.textContent = patch.title;
        var targetEl = card.querySelector('.js-target');
        if (targetEl) targetEl.textContent = formatTarget(patch.targetMs);
        var bar = card.querySelector('.js-bar');
        if (bar) bar.style.background = patch.color || '#7C3AED';

        // emoji span: replace or insert/remove
        var titleWrap = card.querySelector('.m-title-wrap');
        var emojiEl = card.querySelector('.m-emoji');
        if (patch.emoji && emojiEl) emojiEl.textContent = patch.emoji;
        else if (patch.emoji && !emojiEl && titleWrap) {
            var span = document.createElement('span');
            span.className = 'm-emoji';
            span.textContent = patch.emoji;
            titleWrap.insertBefore(span, titleWrap.firstChild);
        }
        else if (!patch.emoji && emojiEl) emojiEl.remove();

        // close edit form, refresh edit-form values for next open
        var form = card.querySelector('.js-edit-form');
        if (form) {
            form.classList.remove('open');
            form.querySelector('.js-edit-title').value = patch.title;
            form.querySelector('.js-edit-when').value  = toLocalDatetimeInput(patch.targetMs);
            form.querySelector('.js-edit-emoji').value = patch.emoji || '';
            form.querySelector('.js-edit-color').value = patch.color || '#7C3AED';
        }

        // refresh tick refs lastStr so countdown re-renders next tick
        var refs = cardRefs.get(id);
        if (refs) refs.lastStr = '';
        tickAll(true);

        if (rescheduleNeeded) {
            clearNotifTimers(id);
            scheduleNotifs(cur);
        }
    }

    function render() {
        var now = Date.now();
        var upcoming = [];
        var reached  = [];
        state.forEach(function (m) {
            (m.targetMs > now ? upcoming : reached).push(m);
        });
        var byManual = function (a, b) { return (a.order || 0) - (b.order || 0); };
        var byDate   = function (a, b) { return a.targetMs - b.targetMs; };
        upcoming.sort(function (a, b) {
            if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
            return manualSort ? byManual(a, b) : byDate(a, b);
        });
        reached.sort(function (a, b) { return b.targetMs - a.targetMs; });

        cardRefs.clear();

        var upList = document.getElementById('upcoming-list');
        var rList  = document.getElementById('reached-list');
        var resetPill = document.getElementById('sort-reset');
        if (resetPill) resetPill.hidden = !manualSort || upcoming.length === 0;
        upList.textContent = '';
        rList.textContent  = '';

        upcoming.forEach(function (m) {
            var el = buildCardEl(m, false);
            upList.appendChild(el);
            cardRefs.set(m.id, {
                countEl: el.querySelector('.js-count'),
                barEl:   el.querySelector('.js-bar'),
                pctEl:   el.querySelector('.js-pct'),
                lastStr: ''
            });
        });
        reached.forEach(function (m) {
            var el = buildCardEl(m, true);
            rList.appendChild(el);
            var countEl = el.querySelector('.js-count');
            countEl.classList.add('reached-text');
            countEl.textContent = 'Reached!';
            el.querySelector('.js-bar').style.width = '100%';
            el.querySelector('.js-pct').textContent = '100%';
        });

        document.getElementById('upcoming-count').textContent = upcoming.length;
        document.getElementById('reached-count').textContent  = reached.length;
        document.getElementById('upcoming-section').hidden    = upcoming.length === 0;
        document.getElementById('reached-section').hidden     = reached.length === 0;
        document.getElementById('empty-state').hidden         = state.length !== 0;

        tickAll(true);
        rescheduleAll();
    }

    function renderCount(refs, dur) {
        if (!dur) {
            var s = 'reached';
            if (refs.lastStr === s) return;
            refs.lastStr = s;
            refs.countEl.classList.add('reached-text');
            refs.countEl.textContent = 'Reached!';
            return;
        }
        var s2 = dDisplay(dur.d) + ':' + pad2(dur.h) + ':' + pad2(dur.m) + ':' + pad2(dur.s);
        if (refs.lastStr === s2) return;
        refs.lastStr = s2;
        refs.countEl.classList.remove('reached-text');
        refs.countEl.innerHTML =
              '<span class="seg"><span class="num">' + dDisplay(dur.d) + '</span><span class="lbl">d</span></span>'
            + '<span class="sep">:</span>'
            + '<span class="seg"><span class="num">' + pad2(dur.h) + '</span><span class="lbl">h</span></span>'
            + '<span class="sep">:</span>'
            + '<span class="seg"><span class="num">' + pad2(dur.m) + '</span><span class="lbl">m</span></span>'
            + '<span class="sep">:</span>'
            + '<span class="seg"><span class="num">' + pad2(dur.s) + '</span><span class="lbl">s</span></span>';
    }

    function tickAll(force) {
        if (!force && document.hidden) return;
        var now = Date.now();
        var anyJustReached = false;

        cardRefs.forEach(function (refs, id) {
            var m = state.find(function (x) { return x.id === id; });
            if (!m) return;
            var remain = m.targetMs - now;
            if (remain <= 0) {
                renderCount(refs, null);
                refs.barEl.style.width = '100%';
                refs.pctEl.textContent = '100%';
                anyJustReached = true;
                return;
            }
            var dur = formatDuration(remain);
            renderCount(refs, dur);
            var p = pct(m.createdMs, m.targetMs, now);
            refs.barEl.style.width = p.toFixed(2) + '%';
            refs.pctEl.textContent = Math.floor(p) + '%';
        });

        if (anyJustReached) {
            scanMissedNotifs();
            setTimeout(render, 50);
        }
    }

    var lastSec = 0;
    function loop() {
        var sec = Math.floor(Date.now() / 1000);
        if (sec !== lastSec) {
            lastSec = sec;
            tickAll(false);
        }
        requestAnimationFrame(loop);
    }

    function flashError(msg) {
        var el = document.getElementById('add-error');
        if (!el) return;
        el.textContent = msg;
        clearTimeout(flashError._t);
        flashError._t = setTimeout(function () { el.textContent = ''; }, 4000);
    }

    function wireForm() {
        var form  = document.getElementById('add-form');
        var title = document.getElementById('add-title');
        var when  = document.getElementById('add-when');
        var emoji = document.getElementById('add-emoji');
        var color = document.getElementById('add-color');
        var err   = document.getElementById('add-error');

        var d = new Date(Date.now() + 60 * 60 * 1000);
        d.setSeconds(0, 0);
        when.value = toLocalDatetimeInput(d.getTime());

        form.addEventListener('submit', function (ev) {
            ev.preventDefault();
            err.textContent = '';
            var t = title.value.trim();
            if (!t) { flashError('Give the milestone a title.'); title.focus(); return; }
            if (!when.value) { flashError('Pick a target date and time.'); when.focus(); return; }
            var ms = new Date(when.value).getTime();
            if (!isFinite(ms)) { flashError('That date does not look valid.'); return; }
            addMilestone({
                title: t,
                targetMs: ms,
                emoji: emoji.value.trim(),
                color: color.value || '#7C3AED'
            });
            if (ms < Date.now()) {
                flashError('Heads up: that date is in the past — it will appear in Reached.');
            }
            title.value = '';
            emoji.value = '';
            var d2 = new Date(Date.now() + 60 * 60 * 1000);
            d2.setSeconds(0, 0);
            when.value = toLocalDatetimeInput(d2.getTime());
            title.focus();
        });
    }

    function startSoftDelete(id) {
        var idx = state.findIndex(function (x) { return x.id === id; });
        if (idx < 0) return;
        // commit any prior pending delete first so undo only ever rescues the most recent
        commitPendingDelete();

        var removed = state[idx];
        state.splice(idx, 1);
        clearNotifTimers(id);
        save();
        render();

        var timer = setTimeout(commitPendingDelete, UNDO_MS);
        pendingDelete = { milestone: removed, idx: idx, timer: timer };
        showToast('Deleted “' + removed.title + '”', 'Undo', undoSoftDelete);
    }

    function undoSoftDelete() {
        if (!pendingDelete) return;
        clearTimeout(pendingDelete.timer);
        var insertAt = Math.min(pendingDelete.idx, state.length);
        state.splice(insertAt, 0, pendingDelete.milestone);
        pendingDelete = null;
        save();
        render();
        hideToast();
    }

    function commitPendingDelete() {
        if (!pendingDelete) return;
        clearTimeout(pendingDelete.timer);
        pendingDelete = null;
        hideToast();
    }

    function showToast(msg, actionLabel, onAction) {
        var t = document.getElementById('toast');
        if (!t) return;
        t.innerHTML = '';
        var span = document.createElement('span');
        span.textContent = msg;
        t.appendChild(span);
        if (actionLabel && onAction) {
            var btn = document.createElement('button');
            btn.className = 'toast-action';
            btn.type = 'button';
            btn.textContent = actionLabel;
            btn.addEventListener('click', onAction);
            t.appendChild(btn);
        }
        t.classList.add('show');
        clearTimeout(showToast._t);
        showToast._t = setTimeout(hideToast, UNDO_MS + 250);
    }

    function hideToast() {
        var t = document.getElementById('toast');
        if (t) t.classList.remove('show');
    }

    function wireDrag(card, m) {
        card.addEventListener('dragstart', function (ev) {
            dragState = { id: m.id, srcEl: card };
            card.classList.add('dragging');
            try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', m.id); } catch (e) {}
        });
        card.addEventListener('dragend', function () {
            card.classList.remove('dragging');
            document.querySelectorAll('.m-card.drop-before, .m-card.drop-after').forEach(function (el) {
                el.classList.remove('drop-before', 'drop-after');
            });
            dragState = null;
        });
        card.addEventListener('dragover', function (ev) {
            if (!dragState || dragState.id === m.id) return;
            ev.preventDefault();
            var rect = card.getBoundingClientRect();
            var midpoint = rect.top + rect.height / 2;
            card.classList.toggle('drop-before', ev.clientY < midpoint);
            card.classList.toggle('drop-after',  ev.clientY >= midpoint);
        });
        card.addEventListener('dragleave', function () {
            card.classList.remove('drop-before', 'drop-after');
        });
        card.addEventListener('drop', function (ev) {
            if (!dragState || dragState.id === m.id) return;
            ev.preventDefault();
            var rect = card.getBoundingClientRect();
            var dropAfter = ev.clientY >= rect.top + rect.height / 2;
            applyReorder(dragState.id, m.id, dropAfter);
        });
    }

    function applyReorder(srcId, dstId, dropAfter) {
        // build current upcoming order from DOM
        var upList = document.getElementById('upcoming-list');
        var ids = [].slice.call(upList.querySelectorAll('.m-card')).map(function (el) { return el.dataset.id; });
        var srcIdx = ids.indexOf(srcId);
        if (srcIdx >= 0) ids.splice(srcIdx, 1);
        var dstIdx = ids.indexOf(dstId);
        if (dstIdx < 0) dstIdx = ids.length - 1;
        ids.splice(dropAfter ? dstIdx + 1 : dstIdx, 0, srcId);

        // assign sequential order values to upcoming, leave reached untouched
        ids.forEach(function (id, i) {
            var m = state.find(function (x) { return x.id === id; });
            if (m) m.order = i + 1;
        });
        setManualSort(true);
        save();
        render();
    }

    function resetSortToDate() {
        setManualSort(false);
        render();
    }

    function wireKeyboard() {
        document.addEventListener('keydown', function (ev) {
            var tag = (ev.target && ev.target.tagName) || '';
            var inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ev.target.isContentEditable;

            if (ev.key === 'Escape') {
                if (openEditId) { openEditId = null; render(); ev.preventDefault(); return; }
                if (pendingDelete) { undoSoftDelete(); ev.preventDefault(); return; }
                if (inField && tag === 'INPUT') ev.target.blur();
                return;
            }
            if (inField) return;
            if (ev.key === 'n' || ev.key === '/') {
                var t = document.getElementById('add-title');
                if (t) { ev.preventDefault(); t.focus(); }
            }
        });
    }

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            tickAll(true);
            scanMissedNotifs();
            rescheduleAll();
        }
    });

    load();
    wireForm();
    wireKeyboard();
    var resetBtn = document.getElementById('sort-reset');
    if (resetBtn) resetBtn.addEventListener('click', resetSortToDate);
    render();
    scanMissedNotifs();
    requestAnimationFrame(loop);
})();
