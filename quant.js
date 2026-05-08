(function () {
    'use strict';

    var SIGNALS_URL = 'quant/output/signals.json';
    var SVG_NS = 'http://www.w3.org/2000/svg';

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

    function sparkline(values) {
        var w = 120, h = 32, pad = 2;
        var svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'spark');
        svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
        svg.setAttribute('preserveAspectRatio', 'none');
        if (!values || values.length < 2) return svg;
        var min = Math.min.apply(null, values);
        var max = Math.max.apply(null, values);
        var span = (max - min) || 1;
        var step = (w - pad * 2) / (values.length - 1);
        var pts = values.map(function (v, i) {
            var x = pad + i * step;
            var y = h - pad - ((v - min) / span) * (h - pad * 2);
            return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
        var line = document.createElementNS(SVG_NS, 'polyline');
        line.setAttribute('points', pts);
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke', 'var(--cosmic-purple)');
        line.setAttribute('stroke-width', '1.5');
        line.setAttribute('stroke-linejoin', 'round');
        line.setAttribute('stroke-linecap', 'round');
        svg.appendChild(line);
        return svg;
    }

    function holdingCard(t, v) {
        var pills = [];
        pills.push(el('span', { class: 'pill ' + v.verdict.toLowerCase(), text: v.verdict }));
        if (v.holding_action) {
            pills.push(el('span', { class: 'pill ' + v.holding_action.toLowerCase(), text: v.holding_action }));
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

        return el('div', { class: 'q-card' }, [
            el('div', null, [
                el('div', { class: 'ticker', text: t }),
                el('div', { class: 'name', text: v.name || '' })
            ]),
            el('div', { class: 'score ' + scoreClass(v.score), text: String(v.score) }),
            el('div', { class: 'pills' }, pills),
            el('div', { class: 'meta-row' }, [
                el('div', { class: 'left' }, leftBits),
                sparkline(v.spark)
            ])
        ]);
    }

    function tableRow(rank, t, v) {
        var trendOk = v.indicators && v.indicators.trend_ok;
        return el('tr', null, [
            el('td', { class: 'num', text: String(rank) }),
            el('td', { class: 'ticker-cell' }, [
                document.createTextNode(t),
                el('div', { class: 'sector', text: v.sector || '' })
            ]),
            el('td', { class: 'sector', text: v.sector || '' }),
            el('td', { class: 'num score-cell ' + scoreClass(v.score), text: String(v.score) }),
            el('td', { class: 'num', text: fmtNum(v.indicators && v.indicators.rsi14, 1) }),
            el('td', { class: 'num', text: fmtPct(v.indicators && v.indicators.mom_12_1, 1) }),
            el('td', { class: 'num', text: trendOk ? '✓' : '✗' })
        ]);
    }

    function render(data) {
        document.getElementById('meta-updated').innerHTML =
            '<i class="fa-regular fa-clock" style="margin-right:0.375rem;"></i>' + fmtTime(data.generated_at);
        document.getElementById('meta-fx').innerHTML =
            '<i class="fa-solid fa-arrow-right-arrow-left" style="margin-right:0.375rem;"></i>EUR/USD ' + fmtNum(data.fx_eur_usd, 4);
        document.getElementById('meta-universe').innerHTML =
            '<i class="fa-solid fa-list" style="margin-right:0.375rem;"></i>' + data.universe_size + ' tickers';

        var pgrid = document.getElementById('portfolio-grid');
        pgrid.innerHTML = '';
        var holdingTickers = (data.holdings_summary || []).map(function (h) { return h.ticker; });
        if (holdingTickers.length === 0) {
            holdingTickers = Object.keys(data.tickers || {})
                .filter(function (t) { return data.tickers[t].is_holding; });
        }
        holdingTickers.forEach(function (t) {
            var v = data.tickers[t];
            if (v) pgrid.appendChild(holdingCard(t, v));
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
    }

    function showEmpty(msg) {
        var hidden = ['portfolio-section', 'buys-section', 'avoid-section'];
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
