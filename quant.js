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

    function rebase(values) {
        if (!values || !values.length) return [];
        var base = values[0] || 1;
        return values.map(function (v) { return (v / base) * 100; });
    }

    function sparkline(seriesList) {
        // seriesList: array of { values, stroke, opacity }
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

        var pnlClass = v.drawdown_vs_basis != null && v.drawdown_vs_basis >= 0 ? 'gain' : 'loss';
        var leftBits = [];
        if (v.drawdown_vs_basis != null) {
            leftBits.push(el('span', { class: pnlClass, text: (v.drawdown_vs_basis >= 0 ? '+' : '') + fmtPct(v.drawdown_vs_basis) }));
        }
        if (v.weight != null) {
            leftBits.push(el('span', { text: 'wt ' + fmtPct(v.weight, 0) }));
        }
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

        var rows = [
            el('div', null, [
                el('div', { class: 'ticker', text: t }),
                el('div', { class: 'name', text: v.name || '' })
            ]),
            el('div', { class: 'score ' + scoreClass(v.score), text: String(v.score) }),
            el('div', { class: 'pills' }, pills),
            el('div', { class: 'meta-row' }, [
                el('div', { class: 'left' }, leftBits),
                spark
            ])
        ];

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
        return el('tr', { 'data-sector': v.sector || '', 'data-score': String(v.score) }, [
            el('td', { class: 'num', text: String(rank) }),
            el('td', { class: 'ticker-cell' }, [
                document.createTextNode(t),
                el('div', { class: 'sector', text: v.sector || '' })
            ]),
            el('td', { class: 'sector', text: v.sector || '' }),
            el('td', { class: 'num score-cell ' + scoreClass(v.score), text: String(v.score) }),
            el('td', { class: 'num', text: fmtNum(v.indicators && v.indicators.rsi14, 1) }),
            el('td', { class: 'num', text: fmtPct(v.indicators && v.indicators.mom_12_1, 1) }),
            el('td', { class: 'num', text: fmtPct(v.indicators && v.indicators.rs_6m, 1) }),
            el('td', { class: 'num', text: trendOk ? '✓' : '✗' })
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

    function renderPortfolio(data) {
        var section = document.getElementById('pnl-section');
        var p = data.portfolio;
        if (!p || p.value_eur == null) { section.hidden = true; return; }
        section.hidden = false;
        document.getElementById('pnl-value').textContent = fmtEur(p.value_eur);
        var pnlClass = (p.pnl_eur != null && p.pnl_eur >= 0) ? 'gain' : 'loss';
        var pnlEl = document.getElementById('pnl-pnl');
        pnlEl.className = 'pnl-pnl ' + pnlClass;
        var sign = (p.pnl_eur != null && p.pnl_eur >= 0) ? '+' : '';
        pnlEl.textContent = sign + fmtEur(p.pnl_eur) + '  (' + sign + fmtPct(p.pnl_pct) + ')';

        var bars = document.getElementById('pnl-bars');
        bars.innerHTML = '';
        var holdings = (p.by_holding || []).slice();
        var maxAbs = holdings.reduce(function (m, h) {
            return Math.max(m, Math.abs(h.pnl_pct || 0));
        }, 0.05);
        holdings.forEach(function (h) {
            var pct = h.pnl_pct || 0;
            var fillCls = pct >= 0 ? 'gain' : 'loss';
            var widthPct = Math.min(100, Math.abs(pct) / maxAbs * 100);
            var leftPct = pct >= 0 ? 50 : 50 - widthPct / 2;
            // Center-anchored bar: positive grows right from 50%, negative grows left.
            var barFill = el('div', { class: 'fill ' + fillCls });
            barFill.style.width = (widthPct / 2) + '%';
            barFill.style.left = (pct >= 0 ? 50 : 50 - widthPct / 2) + '%';
            var bar = el('div', { class: 'bar' }, [barFill]);
            bars.appendChild(el('div', { class: 'pnl-bar-row' }, [
                el('span', { class: 'ticker', text: h.ticker }),
                bar,
                el('span', { class: 'pct ' + fillCls, text: (pct >= 0 ? '+' : '') + fmtPct(pct) })
            ]));
        });

        var warn = document.getElementById('sector-warn');
        var over = data.over_concentrated_sectors || [];
        if (over.length === 0) { warn.hidden = true; }
        else {
            warn.hidden = false;
            warn.innerHTML = '';
            warn.appendChild(el('i', { class: 'fa-solid fa-triangle-exclamation', style: 'margin-right:0.4rem;' }));
            warn.appendChild(document.createTextNode(
                'Concentrated in: ' + over.map(function (s) {
                    var pct = data.sector_concentration[s];
                    return s + ' (' + fmtPct(pct, 0) + ')';
                }).join(', ')
            ));
        }
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
            // Color ramp: 0 -> red, 50 -> amber, 100 -> green
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
        var rows = [['ticker', 'sector', 'score', 'verdict', 'is_holding', 'action', 'rsi14', 'mom_12_1', 'rs_6m', 'trend_ok']];
        Object.keys(DATA.tickers).forEach(function (t) {
            var v = DATA.tickers[t];
            var ind = v.indicators || {};
            rows.push([
                t,
                v.sector || '',
                v.score,
                v.verdict,
                v.is_holding ? 'true' : 'false',
                v.holding_action || '',
                ind.rsi14 != null ? ind.rsi14 : '',
                ind.mom_12_1 != null ? ind.mom_12_1 : '',
                ind.rs_6m != null ? ind.rs_6m : '',
                ind.trend_ok ? 'true' : 'false'
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

    function render(data) {
        DATA = data;
        document.getElementById('meta-updated').innerHTML =
            '<i class="fa-regular fa-clock" style="margin-right:0.375rem;"></i>' + fmtTime(data.generated_at);
        document.getElementById('meta-fx').innerHTML =
            '<i class="fa-solid fa-arrow-right-arrow-left" style="margin-right:0.375rem;"></i>EUR/USD ' + fmtNum(data.fx_eur_usd, 4);
        document.getElementById('meta-universe').innerHTML =
            '<i class="fa-solid fa-list" style="margin-right:0.375rem;"></i>' + data.universe_size + ' tickers';

        renderRegime(data);
        renderPortfolio(data);

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
        (data.ranked_avoid || []).forEach(function (t, i) {
            var v = data.tickers[t];
            if (v) avoidBody.appendChild(tableRow(i + 1, t, v));
        });

        renderHeatmap(data);
        populateSectorFilter(data);

        document.getElementById('filter-sector').addEventListener('change', applyFilters);
        document.getElementById('filter-min-score').addEventListener('input', applyFilters);
        document.getElementById('export-csv').addEventListener('click', exportCsv);
    }

    function showEmpty(msg) {
        var hidden = ['portfolio-section', 'buys-section', 'avoid-section', 'heatmap-section', 'pnl-section'];
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
