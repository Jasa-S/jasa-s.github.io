(function legendInit() {
    var btn = document.getElementById('legend-toggle');
    var modal = document.getElementById('legend-modal');
    if (!btn || !modal) return;
    var closeBtn = modal.querySelector('.close');
    var backdrop = modal.querySelector('.backdrop');
    function open() {
        modal.hidden = false;
        document.body.style.overflow = 'hidden';
    }
    function close() {
        modal.hidden = true;
        document.body.style.overflow = '';
    }
    btn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (backdrop) backdrop.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !modal.hidden) close();
    });
})();

(function () {
    'use strict';

    var SIGNALS_URL = 'quant/output/signals.json';
    var SVG_NS = 'http://www.w3.org/2000/svg';

    var DATA = null; // populated by render()

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                if (k === 'class') node.className = attrs[k];
                else if (k === 'text') node.textContent = attrs[k];
                else node.setAttribute(k, attrs[k]);
            });
        }
        if (children) {
            children.forEach(function (c) {
                if (c == null) return;
                node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
            });
        }
        return node;
    }

    function fmtPct(x, digits) {
        if (x == null || !isFinite(x)) return '—';
        var d = digits == null ? 1 : digits;
        return (x * 100).toFixed(d).replace('.', ',') + ' %';
    }

    function fmtNum(x, digits) {
        if (x == null || !isFinite(x)) return '—';
        var d = digits == null ? 2 : digits;
        return Number(x).toFixed(d).replace('.', ',');
    }

    function fmtEur(x) {
        if (x == null || !isFinite(x)) return '—';
        return Number(x).toLocaleString(undefined, {
            minimumFractionDigits: 2, maximumFractionDigits: 2
        }) + ' €';
    }

    function fmtTime(iso) {
        if (!iso) return '—';
        try {
            var d = new Date(iso);
            return d.toLocaleString(undefined, {
                year: 'numeric', month: 'short', day: '2-digit',
                hour: '2-digit', minute: '2-digit'
            });
        } catch (e) { return iso; }
    }

    function scoreClass(score) {
        if (score >= 70) return 'high';
        if (score >= 40) return 'mid';
        return 'low';
    }

    function fmtDelta(d) {
        if (d == null || !isFinite(d) || d === 0) return null;
        return (d > 0 ? '+' : '−') + Math.abs(d);
    }

    function deltaClass(d) {
        if (d == null || !isFinite(d) || d === 0) return '';
        return d > 0 ? 'gain' : 'loss';
    }

    var DRIVER_LABELS = {
        momentum: 'mom',
        vol_adj: 'vol-adj',
        trend: 'trend',
        rs: 'RS',
        macd: 'MACD',
        rsi: 'RSI'
    };

    function topDrivers(contribs) {
        if (!contribs) return [];
        var entries = Object.keys(contribs).map(function (k) {
            return { key: k, val: Number(contribs[k]) || 0 };
        });
        entries.sort(function (a, b) { return Math.abs(b.val) - Math.abs(a.val); });
        return entries.slice(0, 4).filter(function (e) { return Math.abs(e.val) >= 0.05; });
    }

    function fmtDriverVal(v) {
        var sign = v >= 0 ? '+' : '−';
        return sign + Math.abs(v).toFixed(1);
    }

    var ANALYST_LABEL = {
        strongBuy: 'STRONG BUY', buy: 'BUY', hold: 'HOLD',
        sell: 'SELL', strongSell: 'STRONG SELL'
    };
    function analystClass(key) {
        if (key === 'strongBuy' || key === 'buy') return 'analyst-buy';
        if (key === 'strongSell' || key === 'sell') return 'analyst-sell';
        return 'analyst-hold';
    }
    function analystLetter(key) {
        if (key === 'strongBuy' || key === 'buy') return 'B';
        if (key === 'strongSell' || key === 'sell') return 'S';
        if (key === 'hold') return 'H';
        return '—';
    }
    function newsClass(label) {
        if (label === 'POS') return 'news-pos';
        if (label === 'NEG') return 'news-neg';
        return 'news-neutral';
    }
    function newsArrow(label) {
        if (label === 'POS') return '+';
        if (label === 'NEG') return '−';
        return '~';
    }

    function rebase(values) {
        if (!values || !values.length) return [];
        var base = values[0] || 1;
        return values.map(function (v) { return (v / base) * 100; });
    }

    function sparkline(seriesList) {
        var w = 120, h = 32, pad = 2;
        var svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'spark');
        svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
        svg.setAttribute('preserveAspectRatio', 'none');
        var nonEmpty = seriesList.filter(function (s) { return s.values && s.values.length > 1; });
        if (!nonEmpty.length) return svg;
        var allMin = Infinity, allMax = -Infinity, maxLen = 0;
        nonEmpty.forEach(function (s) {
            for (var i = 0; i < s.values.length; i++) {
                if (s.values[i] < allMin) allMin = s.values[i];
                if (s.values[i] > allMax) allMax = s.values[i];
            }
            if (s.values.length > maxLen) maxLen = s.values.length;
        });
        var span = (allMax - allMin) || 1;
        nonEmpty.forEach(function (s) {
            var step = (w - pad * 2) / Math.max(1, s.values.length - 1);
            var pts = s.values.map(function (v, i) {
                var x = pad + i * step;
                var y = h - pad - ((v - allMin) / span) * (h - pad * 2);
                return x.toFixed(1) + ',' + y.toFixed(1);
            }).join(' ');
            var line = document.createElementNS(SVG_NS, 'polyline');
            line.setAttribute('points', pts);
            line.setAttribute('fill', 'none');
            line.setAttribute('stroke', s.stroke);
            line.setAttribute('stroke-width', s.width || '1.5');
            line.setAttribute('stroke-linejoin', 'round');
            line.setAttribute('stroke-linecap', 'round');
            if (s.opacity != null) line.setAttribute('opacity', String(s.opacity));
            svg.appendChild(line);
        });
        return svg;
    }

    function holdingCard(t, v, benchSpark) {
        var pills = [];
        pills.push(el('span', { class: 'pill ' + v.verdict.toLowerCase(), text: v.verdict }));
        if (v.holding_action) {
            pills.push(el('span', { class: 'pill ' + v.holding_action.toLowerCase(), text: v.holding_action }));
        }
        if (v.is_pullback) {
            pills.push(el('span', { class: 'pill pullback', text: 'PULLBACK' }));
        }
        if (v.indicators && v.indicators.breakout_20d) {
            pills.push(el('span', { class: 'pill breakout', text: 'BREAKOUT' }));
        }
        if (v.next_earnings_in_days != null && v.next_earnings_in_days >= 0 && v.next_earnings_in_days <= 7) {
            pills.push(el('span', { class: 'pill earnings', text: '⏰ ' + v.next_earnings_in_days + 'd' }));
        }
        var sent = v.sentiment || {};
        if (sent.analyst && sent.analyst.key) {
            pills.push(el('span', {
                class: 'pill ' + analystClass(sent.analyst.key),
                text: ANALYST_LABEL[sent.analyst.key] || sent.analyst.key,
                title: 'Analyst consensus (' + (sent.analyst.n_analysts || 0) + ' analysts)'
            }));
        }
        if (sent.news && sent.news.label) {
            pills.push(el('span', {
                class: 'pill ' + newsClass(sent.news.label),
                text: 'NEWS ' + newsArrow(sent.news.label),
                title: '7d compound ' + (sent.news.compound != null ? sent.news.compound.toFixed(2) : '—')
                    + ' · ' + (sent.news.n_headlines || 0) + ' headlines'
            }));
        }

        var leftBits = [];
        if (v.price_eur != null) {
            leftBits.push(el('span', { text: fmtNum(v.price_eur) + ' €' }));
        }
        if (v.stop_loss_eur != null) {
            leftBits.push(el('span', { text: 'stop ' + fmtNum(v.stop_loss_eur) + ' €' }));
        }

        var rebasedTicker = rebase(v.spark);
        var rebasedBench = rebase(benchSpark || []);
        var spark = sparkline([
            { values: rebasedBench, stroke: 'var(--text-muted)', width: 1, opacity: 0.5 },
            { values: rebasedTicker, stroke: 'var(--cosmic-purple)', width: 1.5 }
        ]);

        var scoreChildren = [String(v.score)];
        var deltaTxt = fmtDelta(v.score_delta_1d);
        if (deltaTxt) {
            scoreChildren.push(el('span', { class: 'delta ' + deltaClass(v.score_delta_1d), text: deltaTxt }));
        }

        var rows = [
            el('div', null, [
                el('div', { class: 'ticker', text: t }),
                el('div', { class: 'name', text: v.name || '' })
            ]),
            el('div', { class: 'score ' + scoreClass(v.score) }, scoreChildren),
            el('div', { class: 'pills' }, pills),
            el('div', { class: 'meta-row' }, [
                el('div', { class: 'left' }, leftBits),
                spark
            ])
        ];

        var drivers = topDrivers(v.factor_contributions);
        if (drivers.length) {
            var driverNodes = [el('span', { class: 'key', text: 'Driver' })];
            drivers.forEach(function (d, i) {
                if (i > 0) driverNodes.push(el('span', { class: 'sep', text: '·' }));
                driverNodes.push(el('span', {
                    class: 'val ' + (d.val >= 0 ? 'gain' : 'loss'),
                    text: (DRIVER_LABELS[d.key] || d.key) + ' ' + fmtDriverVal(d.val)
                }));
            });
            rows.push(el('div', { class: 'drivers' }, driverNodes));
        }

        if (sent.analyst && sent.analyst.target_upside_pct != null) {
            var up = sent.analyst.target_upside_pct;
            rows.push(el('div', { class: 'target-line' }, [
                el('span', { class: 'key', text: 'Analyst target' }),
                el('span', {
                    class: 'val ' + (up >= 0 ? 'gain' : 'loss'),
                    text: (up >= 0 ? '+' : '−') + Math.abs(up * 100).toFixed(0) + ' % vs spot'
                })
            ]));
        }

        if (v.holding_action === 'ADD' && v.suggested_add_eur != null) {
            rows.push(
                el('div', { class: 'add-line' }, [
                    el('span', { class: 'key', text: 'Suggested add' }),
                    el('span', { class: 'val', text: fmtEur(v.suggested_add_eur) })
                ])
            );
        }

        return el('div', { class: 'q-card' }, rows);
    }

    function tableRow(rank, t, v) {
        var trendOk = v.indicators && v.indicators.trend_ok;
        var deltaTxt = fmtDelta(v.score_delta_1d);
        var deltaCell = el('td', { class: 'num delta-cell ' + deltaClass(v.score_delta_1d) });
        deltaCell.textContent = deltaTxt || '—';

        var analyst = v.sentiment && v.sentiment.analyst;
        var news = v.sentiment && v.sentiment.news;
        var sentLetter = analyst && analyst.key ? analystLetter(analyst.key) : '—';
        var sentClass = analyst && analyst.key
            ? (analyst.key === 'strongBuy' || analyst.key === 'buy' ? 'buy'
                : analyst.key === 'strongSell' || analyst.key === 'sell' ? 'sell' : 'hold')
            : '';
        var sentTitle = [];
        if (analyst && analyst.key) {
            sentTitle.push('Analyst: ' + (ANALYST_LABEL[analyst.key] || analyst.key)
                + ' (' + (analyst.n_analysts || 0) + ')');
        }
        if (news && news.label) {
            sentTitle.push('News: ' + news.label
                + ' ' + (news.compound != null ? news.compound.toFixed(2) : ''));
        }
        var sentCell = el('td', {
            class: 'num sent-cell ' + sentClass,
            title: sentTitle.join(' · ') || ''
        });
        sentCell.textContent = sentLetter;

        return el('tr', { 'data-sector': v.sector || '', 'data-score': String(v.score) }, [
            el('td', { class: 'num', text: String(rank) }),
            el('td', { class: 'ticker-cell' }, [
                document.createTextNode(t),
                el('div', { class: 'sector', text: v.sector || '' })
            ]),
            el('td', { class: 'sector', text: v.sector || '' }),
            el('td', { class: 'num score-cell ' + scoreClass(v.score), text: String(v.score) }),
            deltaCell,
            el('td', { class: 'num', text: fmtNum(v.indicators && v.indicators.rsi14, 1) }),
            el('td', { class: 'num', text: fmtPct(v.indicators && v.indicators.mom_12_1, 1) }),
            el('td', { class: 'num', text: fmtPct(v.indicators && v.indicators.rs_6m, 1) }),
            el('td', { class: 'num', text: trendOk ? '✓' : '✗' }),
            sentCell
        ]);
    }

    function renderRegime(data) {
        var banner = document.getElementById('regime-banner');
        if (!data.regime) { banner.hidden = true; return; }
        banner.hidden = false;
        var on = data.regime === 'RISK_ON';
        banner.className = 'regime-banner ' + (on ? 'on' : 'off');
        var icon = on ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';
        var label = on ? 'Risk on' : 'Risk off';
        var desc = on
            ? 'Benchmark trend is intact (' + (data.benchmark || 'SPY') + ' score ' + (data.regime_score != null ? data.regime_score : '—') + ').'
            : 'Benchmark in downtrend — BUY signals downgraded to WATCH.';
        banner.innerHTML = '';
        banner.appendChild(el('i', { class: 'fa-solid ' + icon }));
        banner.appendChild(el('span', { class: 'label', text: label }));
        banner.appendChild(el('span', { class: 'desc', text: desc }));
    }

    function renderMovers(data) {
        var section = document.getElementById('movers-section');
        if (!section) return;
        var entries = Object.keys(data.tickers || {}).map(function (t) {
            var v = data.tickers[t];
            return {
                t: t,
                score: v.score,
                delta: v.score_delta_1d,
                verdict: v.verdict,
                action: v.holding_action,
                prior_verdict: v.prior_verdict,
                prior_action: v.prior_action,
                is_holding: v.is_holding
            };
        });

        var risers = entries
            .filter(function (e) { return typeof e.delta === 'number' && e.delta > 0; })
            .sort(function (a, b) { return b.delta - a.delta; })
            .slice(0, 5);
        var fallers = entries
            .filter(function (e) { return typeof e.delta === 'number' && e.delta < 0; })
            .sort(function (a, b) { return a.delta - b.delta; })
            .slice(0, 5);
        var changes = entries.filter(function (e) {
            var verdictChanged = e.prior_verdict && e.verdict !== e.prior_verdict;
            var actionChanged = e.is_holding && e.prior_action != null && e.action !== e.prior_action;
            return verdictChanged || actionChanged;
        }).slice(0, 5);

        if (!risers.length && !fallers.length && !changes.length) {
            section.hidden = true;
            return;
        }
        section.hidden = false;

        function fillCard(id, items, formatter) {
            var card = document.getElementById(id);
            if (!card) return;
            var rows = card.querySelector('.rows');
            rows.innerHTML = '';
            if (!items.length) {
                rows.appendChild(el('div', { class: 'empty', text: '—' }));
                return;
            }
            items.forEach(function (e) { rows.appendChild(formatter(e)); });
        }

        fillCard('movers-risers', risers, function (e) {
            return el('div', { class: 'row' }, [
                el('span', { class: 'tk', text: e.t }),
                el('span', { class: 'val gain', text: fmtDelta(e.delta) + ' → ' + e.score })
            ]);
        });
        fillCard('movers-fallers', fallers, function (e) {
            return el('div', { class: 'row' }, [
                el('span', { class: 'tk', text: e.t }),
                el('span', { class: 'val loss', text: fmtDelta(e.delta) + ' → ' + e.score })
            ]);
        });
        fillCard('movers-changes', changes, function (e) {
            var label;
            if (e.is_holding && e.prior_action != null && e.action !== e.prior_action) {
                label = (e.prior_action || '—') + ' → ' + (e.action || '—');
            } else {
                label = (e.prior_verdict || '—') + ' → ' + (e.verdict || '—');
            }
            return el('div', { class: 'row' }, [
                el('span', { class: 'tk', text: e.t }),
                el('span', { class: 'val', text: label })
            ]);
        });
    }

    function renderHeatmap(data) {
        var heatmap = document.getElementById('heatmap');
        heatmap.innerHTML = '';
        var bySector = {};
        Object.keys(data.tickers || {}).forEach(function (t) {
            var v = data.tickers[t];
            var s = v.sector || 'Other';
            if (!bySector[s]) bySector[s] = [];
            bySector[s].push(v.score);
        });
        var rows = Object.keys(bySector)
            .filter(function (s) { return bySector[s].length >= 2; })
            .map(function (s) {
                var scores = bySector[s];
                var avg = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
                return { sector: s, avg: avg, count: scores.length };
            })
            .sort(function (a, b) { return b.avg - a.avg; });
        rows.forEach(function (r) {
            var cell = el('div', { class: 'cell' });
            var hue = Math.max(0, Math.min(120, (r.avg - 30) * 2));
            cell.style.borderColor = 'hsla(' + hue + ', 70%, 45%, 0.45)';
            cell.style.background = 'hsla(' + hue + ', 70%, 45%, 0.08)';
            cell.appendChild(el('div', { class: 'name', text: r.sector }));
            cell.appendChild(el('div', { class: 'avg', text: r.avg.toFixed(0) }));
            cell.appendChild(el('div', { class: 'count', text: r.count + ' names' }));
            heatmap.appendChild(cell);
        });
        document.getElementById('heatmap-section').hidden = rows.length === 0;
    }

    function applyFilters() {
        var sector = document.getElementById('filter-sector').value;
        var minScore = parseInt(document.getElementById('filter-min-score').value, 10);
        var rows = document.querySelectorAll('#buys-table tbody tr');
        rows.forEach(function (tr) {
            var trSector = tr.getAttribute('data-sector') || '';
            var trScore = parseInt(tr.getAttribute('data-score') || '0', 10);
            var hide = (sector && trSector !== sector) || (!isNaN(minScore) && trScore < minScore);
            tr.style.display = hide ? 'none' : '';
        });
    }

    function exportCsv() {
        if (!DATA || !DATA.tickers) return;
        var rows = [['ticker', 'sector', 'score', 'score_delta_1d', 'verdict', 'is_holding', 'action', 'rsi14', 'mom_12_1', 'rs_6m', 'trend_ok', 'analyst_key', 'target_upside_pct', 'news_label', 'news_compound']];
        Object.keys(DATA.tickers).forEach(function (t) {
            var v = DATA.tickers[t];
            var ind = v.indicators || {};
            var s = v.sentiment || {};
            var a = s.analyst || {};
            var n = s.news || {};
            rows.push([
                t,
                v.sector || '',
                v.score,
                v.score_delta_1d != null ? v.score_delta_1d : '',
                v.verdict,
                v.is_holding ? 'true' : 'false',
                v.holding_action || '',
                ind.rsi14 != null ? ind.rsi14 : '',
                ind.mom_12_1 != null ? ind.mom_12_1 : '',
                ind.rs_6m != null ? ind.rs_6m : '',
                ind.trend_ok ? 'true' : 'false',
                a.key || '',
                a.target_upside_pct != null ? a.target_upside_pct : '',
                n.label || '',
                n.compound != null ? n.compound : ''
            ]);
        });
        var csv = rows.map(function (r) {
            return r.map(function (c) {
                var s = String(c);
                return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            }).join(',');
        }).join('\n');
        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'quant-signals-' + (DATA.generated_at || '').slice(0, 10) + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function populateSectorFilter(data) {
        var sel = document.getElementById('filter-sector');
        sel.innerHTML = '<option value="">All</option>';
        var sectors = new Set();
        Object.keys(data.tickers || {}).forEach(function (t) {
            var s = data.tickers[t].sector;
            if (s) sectors.add(s);
        });
        Array.from(sectors).sort().forEach(function (s) {
            var opt = document.createElement('option');
            opt.value = s; opt.textContent = s;
            sel.appendChild(opt);
        });
    }

    function bottomRankedTickers(data, count) {
        if (data.ranked_avoid && data.ranked_avoid.length) {
            return data.ranked_avoid.slice(0, count);
        }
        return Object.keys(data.tickers || {})
            .filter(function (t) {
                var score = data.tickers[t] && data.tickers[t].score;
                return typeof score === 'number' && isFinite(score);
            })
            .sort(function (a, b) {
                var scoreDiff = data.tickers[a].score - data.tickers[b].score;
                return scoreDiff || a.localeCompare(b);
            })
            .slice(0, count);
    }

    function render(data) {
        DATA = data;
        document.getElementById('meta-updated').innerHTML =
            '<i class="fa-regular fa-clock" style="margin-right:0.375rem;"></i>' + fmtTime(data.generated_at);
        document.getElementById('meta-fx').innerHTML =
            '<i class="fa-solid fa-arrow-right-arrow-left" style="margin-right:0.375rem;"></i>EUR/USD ' + fmtNum(data.fx_eur_usd, 4);
        document.getElementById('meta-universe').innerHTML =
            '<i class="fa-solid fa-list" style="margin-right:0.375rem;"></i>' + data.universe_size + ' tickers';

        renderRegime(data);

        var benchSpark = data.benchmark_spark || [];
        var pgrid = document.getElementById('portfolio-grid');
        pgrid.innerHTML = '';
        var holdingTickers = (data.holdings_summary || []).map(function (h) { return h.ticker; });
        if (holdingTickers.length === 0) {
            holdingTickers = Object.keys(data.tickers || {})
                .filter(function (t) { return data.tickers[t].is_holding; });
        }
        holdingTickers.forEach(function (t) {
            var v = data.tickers[t];
            if (v) pgrid.appendChild(holdingCard(t, v, benchSpark));
        });

        var buysBody = document.querySelector('#buys-table tbody');
        buysBody.innerHTML = '';
        (data.ranked_buys || []).forEach(function (t, i) {
            var v = data.tickers[t];
            if (v) buysBody.appendChild(tableRow(i + 1, t, v));
        });

        var avoidBody = document.querySelector('#avoid-table tbody');
        avoidBody.innerHTML = '';
        bottomRankedTickers(data, 10).forEach(function (t, i) {
            var v = data.tickers[t];
            if (v) avoidBody.appendChild(tableRow(i + 1, t, v));
        });

        renderMovers(data);
        renderHeatmap(data);
        populateSectorFilter(data);

        document.getElementById('filter-sector').addEventListener('change', applyFilters);
        document.getElementById('filter-min-score').addEventListener('input', applyFilters);
        document.getElementById('export-csv').addEventListener('click', exportCsv);
    }

    function showEmpty(msg) {
        var hidden = ['portfolio-section', 'buys-section', 'avoid-section', 'heatmap-section', 'movers-section'];
        hidden.forEach(function (id) {
            var n = document.getElementById(id);
            if (n) n.hidden = true;
        });
        var empty = document.getElementById('empty-state');
        empty.hidden = false;
        if (msg) {
            var p = empty.querySelector('p.muted');
            if (p) p.textContent = msg;
        }
    }

    fetch(SIGNALS_URL + '?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(render)
        .catch(function (err) {
            console.warn('signals fetch failed:', err);
            showEmpty();
        });
})();
