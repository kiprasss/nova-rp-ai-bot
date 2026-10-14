/** Упрощённые HTML-фрагменты в структуре XenForo 2.3 (как на forum.grand-rp.su). */

export const THREAD_HTML = `
<html><head><title>Тема | Форум</title></head><body>
<div class="p-breadcrumbs"><ul>
  <li><a href="/"><span>Форумы</span></a></li>
  <li><a href="/forums/1007/"><span>Жалобы</span></a></li>
  <li><a href="/forums/1010/"><span>Жалобы на игроков</span></a></li>
</ul></div>
<h1 class="p-title-value"><span class="label label--orange">Ожидает рассмотрения</span><span class="label-append">&nbsp;</span>5.4 ОП I 54321</h1>
<div class="js-threadStatusField">
  <dl class="pairs pairs--columns pairs--customField" data-field="PlayerReportID2"><dt>Ник игрока</dt><dd>John Doe</dd></dl>
  <dl class="pairs pairs--columns pairs--customField" data-field="PlayerReportSuspect2"><dt>ID нарушителя</dt><dd>54321</dd></dl>
  <dl class="pairs pairs--columns pairs--customField" data-field="PlayerReportDate2"><dt>Дата нарушения</dt><dd>13.10.2026</dd></dl>
  <dl class="pairs pairs--columns pairs--customField" data-field="PlayerReportTime2"><dt>Время нарушения</dt><dd>0,05</dd></dl>
  <dl class="pairs pairs--columns pairs--customField" data-field="PlayerReportProof2"><dt>Доказательства</dt><dd><a href="https://youtu.be/x">https://youtu.be/x</a></dd></dl>
</div>
<article class="message message--post js-post" data-author="Test Author" data-content="post-1819563" id="js-post-1819563">
  <article class="message-body js-selectToQuote"><div>
    <div class="bbWrapper"><b>5.4</b> Запрещено любое намеренное провоцирование сотрудников государственных структур (в том числе и EMS) на погони и задержания. |<b> JAIL от 120 до 180 минут | WARN при повторном нарушении.</b></div>
  </div></article>
</article>
<article class="message message--post js-post" data-author="Admin" data-content="post-1819600" id="js-post-1819600">
  <article class="message-body"><div><div class="bbWrapper">Жалоба одобрена.<br />Игрок будет наказан.</div></div></article>
</article>
<ul class="pageNav-main"><li class="pageNav-page"><a href="/threads/410706/">1</a></li><li class="pageNav-page"><a href="/threads/410706/page-2">2</a></li></ul>
</body></html>`;

export const RULES_TEXT = `1. Общее положение
1.1 При регистрации аккаунта игрок автоматически соглашается с соблюдением всех правил проекта.

2. Игровые аккаунты и никнеймы
2.1. Запрещено иметь более 1 дополнительного аккаунта. | BAN от 30 дней основного аккаунта | BAN навсегда всех дополнительных аккаунтов.

2.2 Ответственность за безопасность игрового аккаунта несет его владелец.
2.3 Запрещена продажа / обмен игровых аккаунтов. | BAN навсегда.
5.4 Запрещено намеренное провоцирование сотрудников государственных структур на погони. | JAIL от 120 до 180 минут | WARN при повторном нарушении.
Дата публикации: 13.10.2026`;

export const FORUM_HTML = `
<html><body>
<h1 class="p-title-value">Жалобы на игроков</h1>
<div class="node-title"><a href="/forums/1011/">Проверенные жалобы на игроков</a></div>
<div class="structItemContainer-group structItemContainer-group--sticky">
  <div class="structItem structItem--thread" data-author="Forum Admin">
    <div class="structItem-title">
      <a href="/forums/1010/?prefix_id=4" class="labelLink"><span class="label">ВАЖНО</span></a>
      <a href="/threads/409510/" data-tp-primary="on">Правила подачи жалоб и репорт-тикетов на игроков</a>
    </div>
    <time class="structItem-latestDate u-dt" datetime="2026-05-15T17:18:07+0300" data-timestamp="1778854687" data-time="17:18">15.05.2026</time>
  </div>
</div>
<div class="structItemContainer-group">
  <div class="structItem structItem--thread" data-author="Test Author">
    <div class="structItem-title"><a href="/threads/5-4-op.410706/" data-tp-primary="on">5.4 ОП I 54321</a></div>
    <time class="structItem-latestDate u-dt" data-timestamp="1791900000">13.10.2026</time>
  </div>
</div>
<ul><li class="pageNav-page"><a href="/forums/1010/">1</a></li><li class="pageNav-page"><a href="/forums/1010/page-7">7</a></li></ul>
</body></html>`;
