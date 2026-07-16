(function () {
    'use strict';

    var token = String((window.CF_ANALYTICS || {}).token || '').trim();
    if (!token) return;

    var script = document.createElement('script');
    script.defer = true;
    script.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    script.setAttribute('data-cf-beacon', JSON.stringify({ token: token }));
    document.head.appendChild(script);
})();
