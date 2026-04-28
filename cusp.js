(function () {
    'use strict';

    var STORAGE_KEY = 'cusp.milestones.v1';
    var PERM_KEY    = 'cusp.notifPermAsked.v1';
    var DEFAULT_OFFSETS_DAYS = [30, 7, 1, 0];
    var DAY_MS = 86400000;
    var MAX_TIMEOUT = 2147483000;

    var state = [];
    var saveTimer = null;
    var cardRefs = new Map();
    var notifTimers = new Map();
    var openEditId = null;

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
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) { state = []; return; }
            var parsed = JSON.parse(raw);
            state = Array.isArray(parsed) ? parsed.filter(isValidMilestone) : [];
        } catch (e) {
            console.warn('CUSP: could not parse storage, resetting.', e);
            state = [];
        }
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
        var m = {
            id: uid(),
            title: data.title,
            targetMs: data.targetMs,
            createdMs: Date.now(),
            emoji: data.emoji || '',
            color: data.color || '#7C3AED',
            notify: { enabled: false, offsetsDays: DEFAULT_OFFSETS_DAYS.slice(), firedKeys: [] }
        };
        state.push(m);
        save();
        render();
        return m;
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
        card.className = 'm-card' + (isReached ? ' reached' : '');
        card.dataset.id = m.id;
        card.style.borderLeftColor = m.color || '#7C3AED';

        var emojiHtml = m.emoji
            ? '<span class="m-emoji">' + esc(m.emoji) + '</span>' : '';

        var bellIcon = m.notify && m.notify.enabled ? 'fa-bell' : 'fa-bell-slash';
        var bellTitle = isReached
            ? 'Notifications (reached)'
            : (m.notify && m.notify.enabled
                ? 'Reminders on (fire while CUSP is open)'
                : 'Turn on reminders (fire while CUSP is open)');

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
                + bellHtml
                + '<button class="icon-btn js-edit" aria-label="Edit" title="Edit"><i class="fa-solid fa-pen"></i></button>'
                + '<button class="icon-btn js-delete" aria-label="Delete" title="Delete"><i class="fa-solid fa-trash"></i></button>'
              + '</div>'
            + '</div>'
            + '<p class="m-target">' + esc(formatTarget(m.targetMs)) + '</p>'
            + '<div class="m-count js-count"></div>'
            + '<div class="m-bar"><div class="m-bar-fill js-bar" style="background:' + esc(m.color || '#7C3AED') + ';"></div></div>'
            + '<div class="m-meta">'
              + '<span class="js-pct">0%</span>'
              + '<span>' + (isReached ? 'Reached' : 'Started ' + esc(new Date(m.createdMs).toLocaleDateString())) + '</span>'
            + '</div>'
            + buildEditFormHtml(m);

        wireCardEvents(card, m);
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

    function wireCardEvents(card, m) {
        var bell = card.querySelector('.js-bell');
        if (bell) bell.addEventListener('click', function () { toggleNotify(m.id); });

        card.querySelector('.js-delete').addEventListener('click', function () {
            if (confirm('Delete "' + m.title + '"?')) deleteMilestone(m.id);
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
            updateMilestone(m.id, {
                title: title, targetMs: t, emoji: emoji, color: color
            });
        });
        form.querySelector('.js-edit-cancel').addEventListener('click', function () {
            openEditId = null;
            render();
        });
    }

    function render() {
        var now = Date.now();
        var upcoming = [];
        var reached  = [];
        state.forEach(function (m) {
            (m.targetMs > now ? upcoming : reached).push(m);
        });
        upcoming.sort(function (a, b) { return a.targetMs - b.targetMs; });
        reached.sort(function (a, b) { return b.targetMs - a.targetMs; });

        cardRefs.clear();

        var upList = document.getElementById('upcoming-list');
        var rList  = document.getElementById('reached-list');
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

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            tickAll(true);
            scanMissedNotifs();
            rescheduleAll();
        }
    });

    load();
    wireForm();
    render();
    scanMissedNotifs();
    requestAnimationFrame(loop);
})();
