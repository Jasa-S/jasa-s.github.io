(function () {
    'use strict';

    // ── Cache (1 hour TTL) ──
    var CACHE_TTL_MS = 60 * 60 * 1000;
    function cacheGet(key) {
        try {
            var raw = localStorage.getItem(key);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (!parsed || !parsed.t || Date.now() - parsed.t > CACHE_TTL_MS) return null;
            return parsed.v;
        } catch (e) { return null; }
    }
    function cacheSet(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value }));
        } catch (e) {}
    }

    // ── API helpers ──
    function geocode(name) {
        var url = 'https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name='
            + encodeURIComponent(name);
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error('geocode failed');
            return r.json();
        }).then(function (data) {
            if (!data.results || !data.results.length) throw new Error('city not found');
            var h = data.results[0];
            return {
                lat: h.latitude,
                lon: h.longitude,
                name: h.name,
                admin: h.admin1 || '',
                country: h.country || ''
            };
        });
    }

    function reverseGeocode(lat, lon) {
        // Open-Meteo doesn't offer reverse geocoding; use a nearby city search fallback.
        return Promise.resolve({
            lat: lat, lon: lon,
            name: 'Current location', admin: '', country: ''
        });
    }

    function fetchWeather(lat, lon) {
        var url = 'https://api.open-meteo.com/v1/forecast'
            + '?latitude=' + lat + '&longitude=' + lon
            + '&hourly=cloudcover,uv_index,visibility'
            + '&daily=sunrise,sunset'
            + '&forecast_days=7&timezone=auto';
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error('weather failed');
            return r.json();
        });
    }

    // ── Time helpers ──
    function parseISOLocal(s) {
        // Accepts "2026-04-19T06:38" (no tz) or "2026-04-19T06:38:00+02:00".
        // Return Date representing the same wall-clock moment.
        return new Date(s);
    }
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }
    function fmtTime(d) {
        if (!d || isNaN(d.getTime())) return '—';
        return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    function addMinutes(d, mins) { return new Date(d.getTime() + mins * 60000); }
    function sameHour(a, b) {
        return a.getFullYear() === b.getFullYear()
            && a.getMonth() === b.getMonth()
            && a.getDate() === b.getDate()
            && a.getHours() === b.getHours();
    }
    function dayKey(d) {
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
    var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // ── Lighting model ──
    // Classify hour relative to sunrise/sunset. Returns {phase, score, color}.
    function classifyHour(hourDate, sunrise, sunset, cloudPct) {
        // Use hour midpoint so the label represents the average condition across the hour.
        var t = hourDate.getTime() + 30 * 60000;
        var rise = sunrise.getTime();
        var set = sunset.getTime();
        var HOUR = 3600000;
        var HALF = 1800000;

        var phase, base;
        if (t >= rise && t < rise + HOUR) { phase = 'golden-am'; base = 10; }
        else if (t >= set - HOUR && t < set) { phase = 'golden-pm'; base = 10; }
        else if (t >= rise - HALF && t < rise) { phase = 'blue-am'; base = 8; }
        else if (t >= set && t < set + HALF) { phase = 'blue-pm'; base = 8; }
        else if (t >= rise - HOUR && t < rise - HALF) { phase = 'twilight-am'; base = 6; }
        else if (t >= set + HALF && t < set + HOUR) { phase = 'twilight-pm'; base = 6; }
        else if (t >= rise && t <= set) { phase = 'day'; base = 4; }
        else { phase = 'night'; base = 1; }

        // Cloud modifier: moderate clouds (30-60%) can enhance golden hour.
        var cloud = Math.max(0, Math.min(100, cloudPct || 0));
        var mod = 0;
        if (phase === 'golden-am' || phase === 'golden-pm') {
            if (cloud < 20) mod = 0;
            else if (cloud < 55) mod = 0.5;
            else if (cloud < 80) mod = -2;
            else mod = -4;
        } else if (phase === 'blue-am' || phase === 'blue-pm') {
            if (cloud < 40) mod = 0;
            else if (cloud < 75) mod = -1;
            else mod = -3;
        } else if (phase === 'day') {
            if (cloud < 25) mod = 1;
            else if (cloud > 80) mod = -1;
        }
        var score = Math.max(0, Math.min(10, base + mod));
        return { phase: phase, score: score, color: colorFor(phase, cloud) };
    }

    function colorFor(phase, cloud) {
        // Base HSL per phase, desaturated by cloud cover.
        var h, s, l;
        switch (phase) {
            case 'golden-am':
            case 'golden-pm': h = 35; s = 90; l = 60; break;
            case 'blue-am':
            case 'blue-pm':   h = 220; s = 70; l = 55; break;
            case 'twilight-am':
            case 'twilight-pm': h = 280; s = 40; l = 45; break;
            case 'day':       h = 45; s = 10; l = 90; break;
            case 'night':
            default:          h = 230; s = 40; l = 15; break;
        }
        var desat = Math.min(0.65, (cloud || 0) / 100 * 0.7);
        s = Math.round(s * (1 - desat));
        return 'hsl(' + h + ',' + s + '%,' + l + '%)';
    }

    // ── Rendering ──
    var content = document.getElementById('content');
    var statusEl = document.getElementById('status');

    function showStatus(html) {
        statusEl.classList.remove('hidden');
        statusEl.innerHTML = html;
    }
    function hideStatus() {
        statusEl.classList.add('hidden');
        statusEl.innerHTML = '';
    }
    function showSkeleton() {
        hideStatus();
        content.innerHTML =
            '<div class="skeleton" style="height:9rem; margin-bottom:1.5rem;"></div>'
          + '<div class="skeleton" style="height:5rem; margin-bottom:1.5rem;"></div>'
          + '<div class="skeleton" style="height:7rem; margin-bottom:1.5rem;"></div>'
          + '<div class="skeleton" style="height:5rem;"></div>';
    }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Module state so date switches don't re-fetch.
    var currentPlace = null;
    var currentWeather = null;
    var selectedDate = null;

    function locationNow(weather) {
        // Shift Date.now() by (location offset − browser offset) so .getHours()
        // on the resulting Date reads the location's wall-clock time.
        var utcOffsetSec = weather.utc_offset_seconds || 0;
        var browserOffsetSec = -new Date().getTimezoneOffset() * 60;
        return new Date(Date.now() + (utcOffsetSec - browserOffsetSec) * 1000);
    }

    function render(place, weather, dateStr) {
        var nowLoc = locationNow(weather);
        var todayKey = dayKey(nowLoc);

        var dayIndex = weather.daily.time.indexOf(dateStr);
        if (dayIndex < 0) { dayIndex = 0; dateStr = weather.daily.time[0]; }
        var isToday = (dateStr === todayKey);

        var sunrise = parseISOLocal(weather.daily.sunrise[dayIndex]);
        var sunset = parseISOLocal(weather.daily.sunset[dayIndex]);
        var solarNoon = new Date((sunrise.getTime() + sunset.getTime()) / 2);

        var goldenAmStart = sunrise;
        var goldenAmEnd = addMinutes(sunrise, 60);
        var goldenPmStart = addMinutes(sunset, -60);
        var goldenPmEnd = sunset;
        var bluePmStart = sunset;
        var bluePmEnd = addMinutes(sunset, 30);

        // ── Header / summary ──
        var locLabel = esc(place.name)
            + (place.admin && place.admin !== place.name ? ', ' + esc(place.admin) : '')
            + (place.country ? ' · ' + esc(place.country) : '');
        var tzAbbr = weather.timezone_abbreviation || 'local';
        var prettyDate = parseISOLocal(dateStr + 'T12:00:00');
        var dateLabel = isToday ? 'Today' : prettyDate.toLocaleDateString(undefined,
            { weekday: 'long', month: 'short', day: 'numeric' });

        var summaryHtml =
            '<div class="sun-card">'
          + '<p class="sun-location"><i class="fa-solid fa-location-dot"></i> ' + locLabel
          + '  ·  ' + esc(dateLabel) + '</p>'
          + '<div class="sun-grid">'
          + sunItem('Sunrise', fmtTime(sunrise), 'blue-am')
          + sunItem('Golden AM', fmtTime(goldenAmStart) + '–' + fmtTime(goldenAmEnd), 'golden-am')
          + sunItem('Solar noon', fmtTime(solarNoon), 'day')
          + sunItem('Golden PM', fmtTime(goldenPmStart) + '–' + fmtTime(goldenPmEnd), 'golden-pm')
          + sunItem('Blue hour', fmtTime(bluePmStart) + '–' + fmtTime(bluePmEnd), 'blue-pm')
          + sunItem('Sunset', fmtTime(sunset), 'golden-pm')
          + '</div>'
          + '<p class="local-time-note">All times shown in ' + esc(tzAbbr) + ' (local to ' + esc(place.name) + ')</p>'
          + '</div>';

        // ── Hourly timeline (selected date) ──
        var hourlyTimes = weather.hourly.time;
        var hourlyCloud = weather.hourly.cloudcover;
        var hours = [];
        for (var i = 0; i < hourlyTimes.length; i++) {
            var hd = parseISOLocal(hourlyTimes[i]);
            if (dayKey(hd) === dateStr) {
                var cls = classifyHour(hd, sunrise, sunset, hourlyCloud[i]);
                hours.push({ date: hd, cloud: hourlyCloud[i], cls: cls });
            }
        }

        var best = findBestWindow(hours);
        var bestLabel = isToday ? 'Best photo walk window today' : 'Best photo walk window';

        var bestHtml = '';
        if (best) {
            bestHtml =
                '<div class="best-window">'
              + '<div>'
              + '<p class="best-window-label">' + esc(bestLabel) + '</p>'
              + '<div class="best-window-time">'
              + fmtTime(best.start) + ' – ' + fmtTime(best.end) + '</div>'
              + '<p class="best-window-note">' + esc(best.note) + '</p>'
              + '</div>'
              + '<div class="best-window-score">' + best.score.toFixed(1) + '<small>/10</small></div>'
              + '</div>';
        }

        // ── Hourly scroll ──
        var hourHtml = '<p class="section-title">Hour by hour</p><div class="hour-scroll" id="hour-scroll">';
        for (var j = 0; j < hours.length; j++) {
            var h = hours[j];
            var isNow = isToday && sameHour(h.date, nowLoc);
            hourHtml +=
                '<div class="hour-card' + (isNow ? ' now' : '') + '">'
              + '<div class="hour-time">' + pad2(h.date.getHours()) + ':00</div>'
              + '<div class="hour-swatch" style="background:' + h.cls.color + '"></div>'
              + '<div class="hour-score">' + h.cls.score.toFixed(1) + '<small>/10</small></div>'
              + '<div class="hour-cloud"><i class="fa-solid fa-cloud" style="opacity:0.6"></i>'
              + Math.round(h.cloud) + '%</div>'
              + '</div>';
        }
        hourHtml += '</div>';

        // ── 7-day forecast ──
        var sevenHtml = '<p class="section-title">Next 7 days · click to view any day</p><div class="day-strip">';
        for (var d = 0; d < weather.daily.time.length && d < 7; d++) {
            var dIso = weather.daily.time[d];
            var dayDate = parseISOLocal(dIso + 'T12:00:00');
            var dRise = parseISOLocal(weather.daily.sunrise[d]);
            var dSet = parseISOLocal(weather.daily.sunset[d]);
            var dayHours = [];
            for (var k = 0; k < hourlyTimes.length; k++) {
                var hh = parseISOLocal(hourlyTimes[k]);
                if (dayKey(hh) === dIso) {
                    var c = classifyHour(hh, dRise, dSet, hourlyCloud[k]);
                    if (c.phase === 'golden-pm' || c.phase === 'golden-am') {
                        dayHours.push(c.score);
                    }
                }
            }
            var avg = dayHours.length
                ? dayHours.reduce(function (a, b) { return a + b; }, 0) / dayHours.length
                : 0;
            var pct = Math.round(avg * 10);
            var selClass = dIso === dateStr ? ' selected' : '';
            sevenHtml +=
                '<button type="button" class="day-cell' + selClass + '" data-date="' + esc(dIso) + '" aria-label="View ' + esc(dIso) + '">'
              + '<div class="day-name">' + WEEKDAYS[dayDate.getDay()] + '</div>'
              + '<div class="day-score">' + avg.toFixed(1) + '</div>'
              + '<div class="day-bar"><div class="day-bar-fill" style="width:' + pct + '%"></div></div>'
              + '<div class="day-times">' + fmtTime(addMinutes(dSet, -60)) + '<br>' + fmtTime(dSet) + '</div>'
              + '</button>';
        }
        sevenHtml += '</div>';

        content.innerHTML = summaryHtml + bestHtml + hourHtml + sevenHtml;

        // Scroll timeline to current hour on load.
        var scrollEl = document.getElementById('hour-scroll');
        var nowCard = scrollEl && scrollEl.querySelector('.hour-card.now');
        if (scrollEl && nowCard) {
            scrollEl.scrollLeft = Math.max(0, nowCard.offsetLeft - 16);
        }
    }

    function renderWithDate(dateStr) {
        if (!currentWeather || !currentPlace) return;
        selectedDate = dateStr;
        var dateInput = document.getElementById('date-input');
        if (dateInput.value !== dateStr) dateInput.value = dateStr;
        render(currentPlace, currentWeather, dateStr);
    }

    function sunItem(label, value, phase) {
        var color = colorFor(phase, 0);
        return '<div class="sun-item">'
             + '<p class="sun-label"><span class="sun-swatch" style="background:' + color + '"></span>'
             + esc(label) + '</p>'
             + '<div class="sun-value">' + esc(value) + '</div>'
             + '</div>';
    }

    function findBestWindow(hours) {
        if (!hours.length) return null;
        // Scan for the contiguous stretch of ≥2 hours with highest mean score (and min score ≥ 6).
        var best = null;
        for (var i = 0; i < hours.length; i++) {
            var sum = 0, minS = 10;
            for (var j = i; j < hours.length; j++) {
                sum += hours[j].cls.score;
                minS = Math.min(minS, hours[j].cls.score);
                var len = j - i + 1;
                if (len >= 2 && minS >= 6) {
                    var avg = sum / len;
                    if (!best || avg > best.avg || (avg === best.avg && len > best.len)) {
                        best = { i: i, j: j, avg: avg, len: len };
                    }
                }
            }
        }
        if (!best) {
            // Fallback: single highest-scoring hour
            var top = 0;
            for (var k = 1; k < hours.length; k++) {
                if (hours[k].cls.score > hours[top].cls.score) top = k;
            }
            var hk = hours[top];
            return {
                start: hk.date,
                end: addMinutes(hk.date, 60),
                score: hk.cls.score,
                note: labelForPhase(hk.cls.phase)
            };
        }
        var s = hours[best.i].date;
        var e = addMinutes(hours[best.j].date, 60);
        var phases = {};
        for (var m = best.i; m <= best.j; m++) {
            phases[hours[m].cls.phase] = (phases[hours[m].cls.phase] || 0) + 1;
        }
        var topPhase = Object.keys(phases).sort(function (a, b) { return phases[b] - phases[a]; })[0];
        return { start: s, end: e, score: best.avg, note: labelForPhase(topPhase) };
    }

    function labelForPhase(p) {
        return ({
            'golden-am': 'Morning golden hour',
            'golden-pm': 'Evening golden hour',
            'blue-am': 'Morning blue hour',
            'blue-pm': 'Evening blue hour',
            'twilight-am': 'Dawn twilight',
            'twilight-pm': 'Dusk twilight',
            'day': 'Daylight',
            'night': 'Night'
        })[p] || 'Best light';
    }

    // ── Flow ──
    function applyWeather(place, weather) {
        currentPlace = place;
        currentWeather = weather;
        var todayLocal = dayKey(locationNow(weather));
        // Clamp selectedDate to available range; default to today-at-location.
        var available = weather.daily.time;
        if (!selectedDate || available.indexOf(selectedDate) === -1) {
            selectedDate = available.indexOf(todayLocal) !== -1 ? todayLocal : available[0];
        }
        var dateInput = document.getElementById('date-input');
        dateInput.min = available[0];
        dateInput.max = available[available.length - 1];
        dateInput.value = selectedDate;
        render(place, weather, selectedDate);
    }

    function loadFor(place) {
        showSkeleton();
        // Reset to today-at-location when loading a new place.
        selectedDate = null;
        var cacheKey = 'oro_' + place.lat.toFixed(3) + '_' + place.lon.toFixed(3);
        var cached = cacheGet(cacheKey);
        if (cached && cached.weather) {
            try {
                applyWeather(place, cached.weather);
                return;
            } catch (e) { /* fall through */ }
        }
        fetchWeather(place.lat, place.lon).then(function (weather) {
            cacheSet(cacheKey, { weather: weather });
            applyWeather(place, weather);
            try {
                localStorage.setItem('oro_last_place', JSON.stringify(place));
            } catch (e) {}
        }).catch(function (err) {
            content.innerHTML = '';
            showStatus(
                '<i class="fa-solid fa-triangle-exclamation"></i>'
              + 'Could not load forecast — please try again.'
            );
        });
    }

    // ── Events ──
    document.getElementById('search-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var name = document.getElementById('city-input').value.trim();
        if (!name) return;
        showSkeleton();
        geocode(name).then(loadFor).catch(function () {
            content.innerHTML = '';
            showStatus(
                '<i class="fa-solid fa-magnifying-glass"></i>'
              + 'City not found — try another name.'
            );
        });
    });

    document.getElementById('date-input').addEventListener('change', function (e) {
        if (e.target.value) renderWithDate(e.target.value);
    });

    // Delegate clicks on day cells (rendered inside #content).
    content.addEventListener('click', function (e) {
        var cell = e.target.closest('.day-cell');
        if (cell && cell.dataset.date) renderWithDate(cell.dataset.date);
    });

    document.getElementById('geo-btn').addEventListener('click', function () {
        if (!navigator.geolocation) {
            showStatus('<i class="fa-solid fa-ban"></i>Geolocation not supported.');
            return;
        }
        showSkeleton();
        navigator.geolocation.getCurrentPosition(function (pos) {
            reverseGeocode(pos.coords.latitude, pos.coords.longitude).then(loadFor);
        }, function () {
            content.innerHTML = '';
            showStatus(
                '<i class="fa-solid fa-location-dot"></i>'
              + 'Location permission denied.'
            );
        }, { timeout: 8000, maximumAge: 600000 });
    });

    // ── Initial load: last searched place, else Frankfurt. ──
    var initial = null;
    try {
        var raw = localStorage.getItem('oro_last_place');
        if (raw) initial = JSON.parse(raw);
    } catch (e) {}
    if (!initial) {
        initial = { lat: 50.1109, lon: 8.6821, name: 'Frankfurt', admin: 'Hesse', country: 'Germany' };
    }
    document.getElementById('city-input').value = initial.name || '';
    loadFor(initial);
})();
