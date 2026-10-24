// 深色 / 浅色模式切换，选择保存在 localStorage
(function () {
  var btn = document.querySelector('.theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var root = document.documentElement;
    var isDark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    var next = isDark ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch (e) {}
  });
})();

// 文章目录高亮当前阅读的章节
(function () {
  var links = document.querySelectorAll('.toc a.toc-link');
  if (!links.length || !('IntersectionObserver' in window)) return;

  var map = {};
  links.forEach(function (a) {
    var id = decodeURIComponent(a.getAttribute('href').slice(1));
    var el = document.getElementById(id);
    if (el) map[id] = { link: a, el: el };
  });

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('active'); });
        var item = map[entry.target.id];
        if (item) item.link.classList.add('active');
      });
    },
    { rootMargin: '-80px 0px -70% 0px' }
  );

  Object.keys(map).forEach(function (id) { observer.observe(map[id].el); });
})();
