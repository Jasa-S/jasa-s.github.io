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

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
        if (!localStorage.getItem('theme')) applyTheme(e.matches);
    });

    if (btn) {
        btn.addEventListener('click', function () {
            var isDark = !bd.classList.contains('dark');
            applyTheme(isDark);
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
        });
    }

    var yearEl = document.getElementById('copy-year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
