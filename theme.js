(function () {
    var bd   = document.body;
    var icon = document.getElementById('theme-icon');
    var btn  = document.getElementById('theme-toggle');

    var html = document.documentElement;

    function applyTheme(dark) {
        bd.classList.toggle('dark', dark);
        html.classList.toggle('dark', dark);
        if (icon) icon.className = dark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    }

    applyTheme(html.classList.contains('dark'));

    var media = window.matchMedia('(prefers-color-scheme: dark)');
    function handleSystemTheme(e) {
        if (!localStorage.getItem('theme')) applyTheme(e.matches);
    }
    if (media.addEventListener) {
        media.addEventListener('change', handleSystemTheme);
    } else if (media.addListener) {
        media.addListener(handleSystemTheme);
    }

    if (btn) {
        btn.addEventListener('click', function () {
            var isDark = !bd.classList.contains('dark');
            applyTheme(isDark);
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
        });
    }

    var bar = document.getElementById('top-bar-direct');
    var mobilePortrait = window.matchMedia('(max-width: 560px) and (orientation: portrait)');
    function alignTopBar() {
        if (!bar) return;
        bar.style.right = mobilePortrait.matches ? '1.5rem' : '';
    }
    alignTopBar();
    if (mobilePortrait.addEventListener) {
        mobilePortrait.addEventListener('change', alignTopBar);
    } else if (mobilePortrait.addListener) {
        mobilePortrait.addListener(alignTopBar);
    }
    window.addEventListener('resize', alignTopBar);

    var cityInput = document.getElementById('city-input');
    if (cityInput) cityInput.placeholder = 'Search';

    var yearEl = document.getElementById('copy-year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();
})();