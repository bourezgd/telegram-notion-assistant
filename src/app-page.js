// صفحة «📱 لوحتي» (Telegram Mini App). نص ثابت يُقدَّم من /app؛ البيانات من /app/data بعد التحقق من initData.
// الألوان من لوحة ألوان مُتحقَّق منها (فاتح/داكن)، وكل رسم بمحور واحد، وتلميح عند اللمس.
// (لا تستعمل «${» ولا علامة ` داخل هذا النص)

export const APP_HTML = String.raw`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>لوحتي</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root {
    color-scheme: light;
    --surface-0: #f4f4f2; --surface-1: #fcfcfb; --surface-2: #ecebe7; --border: #e2e1dc;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #8a8983;
    --series-1: #2a78d6; --series-2: #eb6834; --reference: #8a8983;
    --seq-0: #ecebe7; --seq-1: #b7d3f6; --seq-2: #86b6ef; --seq-3: #5598e7; --seq-4: #2a78d6; --seq-5: #1c5cab;
    --good: #0e8a4f; --warn: #b87400; --bad: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --surface-0: #111110; --surface-1: #1a1a19; --surface-2: #262624; --border: #33332f;
      --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8f8e86;
      --series-1: #3987e5; --series-2: #d95926; --reference: #8f8e86;
      --seq-0: #262624; --seq-1: #104281; --seq-2: #184f95; --seq-3: #256abf; --seq-4: #3987e5; --seq-5: #86b6ef;
      --good: #3fb67a; --warn: #e0a02c; --bad: #ef6b6b;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-0: #111110; --surface-1: #1a1a19; --surface-2: #262624; --border: #33332f;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --text-muted: #8f8e86;
    --series-1: #3987e5; --series-2: #d95926; --reference: #8f8e86;
    --seq-0: #262624; --seq-1: #104281; --seq-2: #184f95; --seq-3: #256abf; --seq-4: #3987e5; --seq-5: #86b6ef;
    --good: #3fb67a; --warn: #e0a02c; --bad: #ef6b6b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--surface-0); color: var(--text-primary);
    font: 15px/1.5 -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", Tahoma, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; margin: 4px 0 2px; }
  .sub { color: var(--text-secondary); font-size: 13px; margin-bottom: 14px; }
  section { background: var(--surface-1); border: 1px solid var(--border); border-radius: 14px; padding: 14px; margin-bottom: 12px; }
  h2 { font-size: 16px; margin: 0 0 10px; }
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
  .tile { background: var(--surface-2); border-radius: 10px; padding: 10px; }
  .tile .k { color: var(--text-secondary); font-size: 12px; }
  .tile .v { font-size: 16px; font-weight: 700; margin-top: 2px; white-space: nowrap; }
  .tile .n { color: var(--text-muted); font-size: 12px; }
  .chart { position: relative; height: 220px; }
  .chart.small { height: 180px; }
  .row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
  .row .name { flex: 0 0 38%; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { flex: 1; height: 10px; background: var(--surface-2); border-radius: 5px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--series-1); border-radius: 5px; }
  .row .val { flex: 0 0 auto; font-size: 13px; color: var(--text-secondary); min-width: 64px; text-align: left; }
  .status { font-size: 12px; }
  .heat { display: grid; grid-template-columns: repeat(10, 1fr); gap: 4px; }
  .cell { aspect-ratio: 1; border-radius: 4px; background: var(--seq-0); position: relative; }
  .cell b { position: absolute; bottom: 1px; inset-inline: 0; text-align: center; font-size: 9px; font-weight: 400; color: var(--text-secondary); }
  .cell[data-l="3"] b, .cell[data-l="4"] b, .cell[data-l="5"] b { color: #ffffff; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .cell[data-l="4"] b, :root:not([data-theme="light"]) .cell[data-l="5"] b { color: #0b0b0b; } }
  :root[data-theme="dark"] .cell[data-l="4"] b, :root[data-theme="dark"] .cell[data-l="5"] b { color: #0b0b0b; }
  .legend { display: flex; align-items: center; gap: 4px; color: var(--text-secondary); font-size: 12px; margin-top: 8px; flex-wrap: wrap; }
  .legend i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .muted { color: var(--text-muted); font-size: 13px; }
  .habit { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .habit:last-child { border-bottom: 0; }
  #tip { position: fixed; z-index: 9; pointer-events: none; background: var(--text-primary); color: var(--surface-1);
    font-size: 12px; padding: 4px 8px; border-radius: 6px; display: none; }
  details summary { cursor: pointer; color: var(--text-secondary); font-size: 13px; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
  td, th { padding: 4px 6px; border-bottom: 1px solid var(--border); text-align: right; }
  #err { display: none; }
</style>
</head>
<body>
<main>
  <h1>📱 لوحتي</h1>
  <div class="sub" id="sub">جارٍ التحميل…</div>
  <section id="err"></section>

  <section id="money">
    <h2>💰 المال</h2>
    <div class="tiles" id="tiles"></div>
    <div class="chart"><canvas id="c-months" aria-label="الدخل والمصاريف لستة أشهر"></canvas></div>
    <details><summary>عرض الجدول</summary><table id="t-months"></table></details>
    <h2 style="margin-top:14px" id="cat-title">فئات المصاريف</h2>
    <div id="cats"></div>
  </section>

  <section>
    <h2>✅ إنجاز المهام — آخر 4 أسابيع</h2>
    <div class="chart small"><canvas id="c-weeks" aria-label="نسبة إنجاز المهام"></canvas></div>
  </section>

  <section>
    <h2>📊 الحصة الشهرية لكل جهة</h2>
    <div id="quota"></div>
  </section>

  <section>
    <h2>🕌 الصلاة والأذكار — 30 يومًا</h2>
    <div class="heat" id="heat"></div>
    <div class="legend" id="heat-legend"></div>
    <div class="muted" id="spirit-sum" style="margin-top:6px"></div>
  </section>

  <section>
    <h2>🔥 العادات</h2>
    <div id="habits"></div>
  </section>

  <section id="growth">
    <h2 id="growth-h">👶 النمو</h2>
    <div class="chart small"><canvas id="c-weight" aria-label="الوزن"></canvas></div>
    <div class="chart small" style="margin-top:10px"><canvas id="c-height" aria-label="الطول"></canvas></div>
  </section>
</main>
<div id="tip"></div>
<script>
(function () {
  var tg = window.Telegram && Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); if (tg.colorScheme) document.documentElement.setAttribute('data-theme', tg.colorScheme); }
  var css = function (v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); };
  var fmt = function (n) { return Math.round(n).toLocaleString('en-US') + ' دج'; };
  var esc = function (s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
  var tip = document.getElementById('tip');
  function showTip(e, text) { tip.textContent = text; tip.style.display = 'block'; tip.style.left = Math.min(e.clientX + 10, innerWidth - 160) + 'px'; tip.style.top = (e.clientY - 34) + 'px'; }
  document.addEventListener('pointerdown', function (e) { if (!e.target.closest('[data-tip]')) tip.style.display = 'none'; });

  function baseOptions(extra) {
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = css('--text-secondary');
    var grid = { color: css('--surface-2') };
    var o = {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false, rtl: true, labels: { usePointStyle: true, boxWidth: 8 } }, tooltip: { rtl: true, textDirection: 'rtl' } },
      scales: { x: { grid: { display: false }, border: { color: css('--border') } }, y: { grid: grid, border: { display: false }, beginAtZero: true } }
    };
    return Object.assign(o, extra || {});
  }

  function fail(msg) {
    var el = document.getElementById('err');
    el.style.display = 'block'; el.innerHTML = '⚠️ ' + msg;
    document.getElementById('sub').textContent = '';
    ['money'].forEach(function (id) { document.getElementById(id).style.display = 'none'; });
  }

  var dashK = new URLSearchParams(location.search).get('k') || '';
  if (!(tg && tg.initData) && !dashK) { fail('افتح اللوحة من داخل البوت في تلغرام (زر «📱 لوحتي» أو /dashboard).'); return; }
  fetch('/app/data', { headers: { 'X-Init-Data': (tg && tg.initData) || '', 'X-Dash-Key': dashK } })
    .then(function (r) { if (!r.ok) throw new Error(r.status === 403 ? 'هذه اللوحة لصاحب البوت فقط.' : 'تعذّر تحميل البيانات (' + r.status + ').'); return r.json(); })
    .then(render).catch(function (e) { fail(esc(e.message)); });

  function render(d) {
    document.getElementById('sub').textContent = 'محدّثة كل 10 دقائق · ' + d.today;

    // ── المال
    var cur = d.money.months[d.money.months.length - 1];
    var budget = d.money.budgetOut, saved = cur.income - cur.expense;
    document.getElementById('tiles').innerHTML =
      '<div class="tile"><div class="k">مصاريف ' + esc(d.monthLabel) + '</div><div class="v">' + fmt(cur.expense) + '</div>' +
        (budget ? '<div class="n">' + Math.round(cur.expense / budget * 100) + '% من الميزانية</div>' : '') + '</div>' +
      '<div class="tile"><div class="k">الدخل</div><div class="v">' + fmt(cur.income) + '</div></div>' +
      '<div class="tile"><div class="k">' + (saved >= 0 ? 'الادخار' : 'العجز') + '</div><div class="v" style="color:' + css(saved >= 0 ? '--good' : '--bad') + '">' +
        (saved >= 0 ? '▲ ' : '▼ ') + fmt(Math.abs(saved)) + '</div></div>';
    new Chart(document.getElementById('c-months'), {
      type: 'bar',
      data: { labels: d.money.months.map(function (m) { return m.label; }), datasets: [
        { label: 'الدخل', data: d.money.months.map(function (m) { return m.income; }), backgroundColor: css('--series-1'), borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 18, categoryPercentage: 0.7, barPercentage: 0.85, borderColor: css('--surface-1'), borderWidth: { left: 1, right: 1 } },
        { label: 'المصاريف', data: d.money.months.map(function (m) { return m.expense; }), backgroundColor: css('--series-2'), borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 18, categoryPercentage: 0.7, barPercentage: 0.85, borderColor: css('--surface-1'), borderWidth: { left: 1, right: 1 } }
      ] },
      options: baseOptions({ plugins: { legend: { display: true, position: 'top', align: 'start', rtl: true, labels: { usePointStyle: true, boxWidth: 8 } },
        tooltip: { rtl: true, callbacks: { label: function (c) { return c.dataset.label + ': ' + fmt(c.parsed.y); } } } },
        scales: { x: { reverse: true, grid: { display: false } }, y: { position: 'right', grid: { color: css('--surface-2') }, border: { display: false }, ticks: { callback: function (v) { return v >= 1000 ? (v / 1000) + 'k' : v; } } } } })
    });
    document.getElementById('t-months').innerHTML = '<tr><th>الشهر</th><th>الدخل</th><th>المصاريف</th></tr>' +
      d.money.months.map(function (m) { return '<tr><td>' + esc(m.label) + '</td><td>' + fmt(m.income) + '</td><td>' + fmt(m.expense) + '</td></tr>'; }).join('');
    document.getElementById('cat-title').textContent = 'فئات مصاريف ' + d.monthLabel;
    var maxCat = d.money.byCat.length ? d.money.byCat[0][1] : 0;
    document.getElementById('cats').innerHTML = d.money.byCat.length ? d.money.byCat.map(function (c) {
      return '<div class="row"><span class="name">' + esc(c[0]) + '</span><span class="bar"><i style="width:' + (c[1] / maxCat * 100) + '%"></i></span><span class="val">' + fmt(c[1]) + '</span></div>';
    }).join('') : '<div class="muted">لا مصاريف مسجّلة هذا الشهر.</div>';

    // ── المهام
    new Chart(document.getElementById('c-weeks'), {
      type: 'bar',
      data: { labels: d.weeks.map(function (w, i) { return i === d.weeks.length - 1 ? 'هذا الأسبوع' : 'حتى ' + Number(w.to.slice(8)) + '/' + Number(w.to.slice(5, 7)); }),
        datasets: [{ label: 'الإنجاز', data: d.weeks.map(function (w) { return w.total ? Math.round(w.done / w.total * 100) : 0; }),
          backgroundColor: css('--series-1'), borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 28 }] },
      options: baseOptions({ plugins: { legend: { display: false }, tooltip: { rtl: true, callbacks: { label: function (c) { var w = d.weeks[c.dataIndex]; return c.parsed.y + '% (' + w.done + ' من ' + w.total + ')'; } } } },
        scales: { x: { reverse: true, grid: { display: false } }, y: { position: 'right', min: 0, max: 100, grid: { color: css('--surface-2') }, border: { display: false }, ticks: { callback: function (v) { return v + '%'; } } } } })
    });

    // ── الحصة الشهرية (شريط لكل جهة + حالة بأيقونة ونص، لا باللون وحده)
    document.getElementById('quota').innerHTML = d.quota.length ? d.quota.map(function (g) {
      var pct = g.planned ? Math.round(g.done / g.planned * 100) : 0, pace = g.due ? g.done / g.due : 1;
      var st = pace >= 0.9 ? '🟢 في الموعد' : pace >= 0.7 ? '🟡 متأخر قليلًا' : '🔴 متأخر';
      return '<div class="row" data-tip="1" onclick="void 0"><span class="name">' + esc(g.name) + '</span><span class="bar"><i style="width:' + pct + '%"></i></span>' +
        '<span class="val">' + g.done + '/' + g.planned + '</span></div><div class="status muted">' + st + ' · المستحق حتى اليوم ' + g.due + '</div>';
    }).join('') : '<div class="muted">لا مهام بكمية مربوطة بجهة هذا الشهر.</div>';

    // ── الصلاة والأذكار: خلية لكل يوم، لونها بعدد الصلوات المسجّلة (0–5)
    var heat = document.getElementById('heat');
    heat.innerHTML = d.days.map(function (x, i) {
      var t = x.date.slice(8) + '/' + x.date.slice(5, 7) + ': ' + x.prayers + '/5 صلوات' + (x.am ? ' · أذكار الصباح ✓' : '') + (x.pm ? ' · المساء ✓' : '') + (x.wird ? ' · الورد ' + x.wird + ' ص' : '');
      return '<div class="cell" data-tip="' + esc(t) + '" data-l="' + x.prayers + '" style="background:var(--seq-' + x.prayers + ')"><b>' + Number(x.date.slice(8)) + '</b></div>';
    }).join('');
    heat.querySelectorAll('.cell').forEach(function (c) {
      c.addEventListener('pointerenter', function (e) { showTip(e, c.getAttribute('data-tip')); });
      c.addEventListener('pointerdown', function (e) { showTip(e, c.getAttribute('data-tip')); });
      c.addEventListener('pointerleave', function () { tip.style.display = 'none'; });
    });
    document.getElementById('heat-legend').innerHTML = 'صلوات مسجّلة:' + [0, 1, 2, 3, 4, 5].map(function (n) { return ' <i style="background:var(--seq-' + n + ')"></i>' + n; }).join('');
    var am = d.days.filter(function (x) { return x.am; }).length, pm = d.days.filter(function (x) { return x.pm; }).length;
    var pages = d.days.reduce(function (a, x) { return a + x.wird; }, 0);
    document.getElementById('spirit-sum').textContent = 'أذكار الصباح ' + am + '/30 · المساء ' + pm + '/30' + (pages ? ' · الورد ' + pages + ' صفحة' : '');

    // ── العادات
    document.getElementById('habits').innerHTML = d.habits.length ? d.habits.map(function (h) {
      return '<div class="habit"><span>' + (h.doneToday ? '✅ ' : '▫️ ') + esc(h.name) + '</span><span class="muted">' + (h.streak ? '🔥 ' + h.streak : '—') + (h.best > 1 ? ' · الأطول ' + h.best : '') + '</span></div>';
    }).join('') : '<div class="muted">لا عادات بعد — أضفها من /habits.</div>';

    // ── نمو الطفل: رسمان بمحور واحد لكل منهما، والمتوسط العالمي خط رمادي متقطّع
    var g = d.growth;
    if (!d.child) { document.getElementById('growth').style.display = 'none'; return; }
    document.getElementById('growth-h').textContent = '👶 نمو ' + d.child;
    if (!g || !g.points.length) { document.getElementById('growth').innerHTML = '<h2>👶 نمو ' + esc(d.child) + '</h2><div class="muted">لا قياسات بعد — اكتب في البوت مثلًا: نمو 8.4 70</div>'; return; }
    function growthChart(id, key, unit) {
      var pts = g.points.filter(function (p) { return p[key] != null; }).map(function (p) { return { x: p.m, y: p[key] }; });
      var maxM = Math.min(24, Math.max(12, Math.ceil(Math.max.apply(null, pts.map(function (p) { return p.x; }).concat([0]))) + 2));
      new Chart(document.getElementById(id), {
        type: 'line',
        data: { datasets: [
          { label: d.child + ' (' + unit + ')', data: pts, borderColor: css('--series-1'), backgroundColor: css('--series-1'), borderWidth: 2, pointRadius: 4, pointBorderColor: css('--surface-1'), pointBorderWidth: 2, tension: 0.2 },
          { label: 'متوسط منظمة الصحة للبنات', data: g.who.filter(function (w) { return w.m <= maxM; }).map(function (w) { return { x: w.m, y: w[key] }; }),
            borderColor: css('--reference'), borderWidth: 2, borderDash: [6, 4], pointRadius: 0 }
        ] },
        options: baseOptions({ interaction: { mode: 'nearest', intersect: false },
          plugins: { legend: { display: true, position: 'top', align: 'start', rtl: true, labels: { usePointStyle: true, boxWidth: 8 } },
            tooltip: { rtl: true, callbacks: { title: function (c) { return 'العمر ' + c[0].parsed.x + ' شهر'; }, label: function (c) { return c.dataset.label + ': ' + c.parsed.y + ' ' + unit; } } } },
          scales: { x: { type: 'linear', min: 0, max: maxM, reverse: true, ticks: { stepSize: 2 }, title: { display: true, text: 'العمر (أشهر)' }, grid: { display: false } },
            y: { position: 'right', beginAtZero: false, grid: { color: css('--surface-2') }, border: { display: false }, title: { display: true, text: unit } } } })
      });
    }
    growthChart('c-weight', 'weight', 'كغ');
    growthChart('c-height', 'height', 'سم');
  }
})();
</script>
</body>
</html>`;
