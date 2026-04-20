(function () {
    var bd   = document.body;
    var icon = document.getElementById('theme-icon');
    var btn  = document.getElementById('theme-toggle');

    function applyTheme(dark) {
        bd.classList.toggle('dark', dark);
        if (icon) icon.className = dark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    }

    var stored = localStorage.getItem('theme');
    if (stored) {
        applyTheme(stored === 'dark');
    } else {
        applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
    }

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
        if (!localStorage.getItem('theme')) applyTheme(e.matches);
    });

    if (btn) {
        btn.addEventListener('click', function () {
            var isDark = bd.classList.toggle('dark');
            if (icon) icon.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
        });
    }

    var yearEl = document.getElementById('copy-year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();
})();
