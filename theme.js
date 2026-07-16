(function () {
    'use strict';
    var body = document.body;
    var html = document.documentElement;
    var media = window.matchMedia('(prefers-color-scheme: dark)');

    function applyTheme(dark) {
        body.classList.toggle('dark', dark);
        html.classList.toggle('dark', dark);
    }

    applyTheme(media.matches);

    function handleSystemTheme(e) {
        applyTheme(e.matches);
    }
    if (media.addEventListener) {
        media.addEventListener('change', handleSystemTheme);
    } else if (media.addListener) {
        media.addListener(handleSystemTheme);
    }

    var cityInput = document.getElementById('city-input');
    if (cityInput) cityInput.placeholder = 'Search';

    var yearEl = document.getElementById('copy-year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
