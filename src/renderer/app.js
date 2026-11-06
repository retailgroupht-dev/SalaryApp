'use strict';
// Логіка вікна. Усі дані приходять з головного процесу через window.api.

const STATUS = { ok: 'Виконано', refused: 'Відмова', cancelled: 'Скасовано', nodata: 'Немає даних', checking: 'Перевіряється' };
const SOURCE = { auto: 'авто (кабінети)', manual: 'таблиця (вручну)' };
const $ = (sel) => document.querySelector(sel);
let data = { settings: {}, employees: [], orders: [] };
let info = {};
const state = { salaryPeriod: null, salarySource: 'auto', ordersSource: 'auto', detailEmployee: null, selected: new Set(), formNp: null, formKind: '', formSource: 'manual', shipments: [], shSelected: new Set() };
// Підпис до статусу: що сказали джерела (Нова Пошта, маркетплейс, Rozetka Delivery).
// ТТН і № замовлення: клік копіює в буфер; без ТТН — «—».
const copyCell = (v, title) => (v ? `<span class="copy" data-copy="${esc(v)}" title="${esc(title || v)}. Натисніть, щоб скопіювати">${esc(v)}</span>` : '<span class="muted">—</span>');
const numCells = (o) => `<td class="nowrap">${copyCell(o.number, 'ТТН')}</td><td class="nowrap">${copyCell(o.orderId, '№ замовлення в кабінеті')}</td>`;
let toastTimer = null;
function toast(text) {
  const el = $('#toast'); el.textContent = text; el.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 1500);
}
const trackTitle = (o) => (o.track && o.track.note ? `${o.track.note}. Перевірено ${o.track.checked || ''}` : '');
const KIND_NAMES = { np: 'Нова Пошта', prom: 'Prom.ua', rozetka: 'Rozetka', epicentr: 'Епіцентр' };

const fmt = (n) => (Number(n) || 0).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const monthOf = (d) => (d || '').slice(0, 7);
const monthLabel = (m) => {
  const names = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
  const [y, mm] = m.split('-');
  return `${names[Number(mm) - 1] || mm} ${y}`;
};
const empName = (id) => (data.employees.find((e) => e.id === id) || {}).name || '—';

function months() {
  const set = new Set(data.orders.map((o) => monthOf(o.date)).filter(Boolean));
  set.add(monthOf(today()));
  return [...set].sort().reverse();
}

function fillPeriodSelect(sel, current, allLabel) {
  const ms = months();
  sel.innerHTML = `<option value="">${allLabel}</option>` + ms.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
  sel.value = current != null && (current === '' || ms.includes(current)) ? current : ms[0];
  return sel.value;
}

function fillEmployeeSelect(sel, withAll) {
  const cur = sel.value;
  sel.innerHTML = (withAll ? `<option value="">${withAll === 'shared' ? 'Усі (спільний)' : 'Усі'}</option>` : '') + data.employees.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

// ---------- Зарплата ----------
function calcRows(period) {
  const rate = Number(data.settings.ratePercent) || 0;
  return data.employees.map((e) => {
    const r = e.ratePercent == null || e.ratePercent === '' ? rate : Number(e.ratePercent);
    const orders = data.orders.filter((o) => o.employeeId === e.id && o.source === state.salarySource && (!period || monthOf(o.date) === period));
    const cnt = (s) => orders.filter((o) => o.status === s).length;
    const sumDone = orders.filter((o) => o.status === 'ok').reduce((a, o) => a + (Number(o.amount) || 0), 0);
    const round2 = (n) => Math.round(n * 100) / 100;
    return { e, r, total: orders.length, done: cnt('ok'), refused: cnt('refused'), cancelled: cnt('cancelled'), nodata: cnt('nodata'), checking: cnt('checking'), sumDone: round2(sumDone), salary: round2(sumDone * r / 100) };
  });
}

function renderSalary() {
  state.salaryPeriod = fillPeriodSelect($('#salaryPeriod'), state.salaryPeriod, 'Увесь час');
  state.salarySource = SOURCE[data.settings.salarySource] ? data.settings.salarySource : 'auto';
  $('#salarySource').value = state.salarySource;
  const rows = calcRows(state.salaryPeriod);
  $('#salaryTable tbody').innerHTML = rows.map((x) => `
    <tr class="clickable ${state.detailEmployee === x.e.id ? 'selected' : ''}" data-id="${x.e.id}">
      <td>${esc(x.e.name)}</td><td class="num">${x.r}</td><td class="num">${x.total}</td><td class="num">${x.done}</td>
      <td class="num">${x.refused}</td><td class="num">${x.cancelled}</td><td class="num">${x.nodata}</td><td class="num">${x.checking}</td>
      <td class="num">${fmt(x.sumDone)}</td><td class="num"><b>${fmt(x.salary)}</b></td>
    </tr>`).join('') || '<tr><td colspan="10" class="hint">Немає працівників</td></tr>';
  const t = rows.reduce((a, x) => ({ total: a.total + x.total, done: a.done + x.done, sumDone: a.sumDone + x.sumDone, salary: a.salary + x.salary }), { total: 0, done: 0, sumDone: 0, salary: 0 });
  $('#salaryTable tfoot').innerHTML = `<tr><td>Разом</td><td></td><td class="num">${t.total}</td><td class="num">${t.done}</td><td colspan="4"></td><td class="num">${fmt(t.sumDone)}</td><td class="num">${fmt(t.salary)}</td></tr>`;
  renderSalaryDetail();
}

function renderSalaryDetail() {
  const box = $('#salaryDetail');
  const id = state.detailEmployee;
  if (!id || !data.employees.some((e) => e.id === id)) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const orders = data.orders.filter((o) => o.employeeId === id && o.source === state.salarySource && (!state.salaryPeriod || monthOf(o.date) === state.salaryPeriod))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  $('#salaryDetailTitle').textContent = `${empName(id)} — ${state.salaryPeriod ? monthLabel(state.salaryPeriod) : 'увесь час'}, ${SOURCE[state.salarySource]} (${orders.length})`;
  box.querySelector('tbody').innerHTML = orders.map((o) => `<tr><td class="nowrap">${o.date}</td><td class="product"><div class="clip" title="${esc(o.product)}">${esc(o.product)}</div></td>${numCells(o)}
    <td class="num">${fmt(o.amount)}</td><td>${esc(o.channel)}</td><td><span class="badge ${o.status}" title="${esc(trackTitle(o))}">${STATUS[o.status] || o.status}</span></td></tr>`).join('')
    || '<tr><td colspan="7" class="hint">Замовлень немає</td></tr>';
}

// ---------- Замовлення ----------
function renderOrders() {
  fillEmployeeSelect($('#fEmployee'), true);
  fillEmployeeSelect($('#importEmployee'), false);
  fillEmployeeSelect($('#ttnEmployee'), false);
  if (!$('#importDate').value) $('#importDate').value = today();
  const fPeriodSel = $('#fPeriod');
  const curPeriod = fPeriodSel.dataset.set ? fPeriodSel.value : '';
  fillPeriodSelect(fPeriodSel, curPeriod, 'Усі'); fPeriodSel.dataset.set = '1';
  const fStatus = $('#fStatus');
  if (fStatus.options.length === 1) fStatus.innerHTML += Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#ordersTitle').textContent = `Замовлення: ${SOURCE[state.ordersSource]}`;
  const emp = Number($('#fEmployee').value) || null, period = fPeriodSel.value, st = fStatus.value, q = $('#fSearch').value.trim().toLowerCase();
  const list = data.orders.filter((o) => o.source === state.ordersSource && (!emp || o.employeeId === emp) && (!period || monthOf(o.date) === period) && (!st || o.status === st)
    && (!q || (o.product || '').toLowerCase().includes(q) || (o.number || '').toLowerCase().includes(q) || (o.orderId || '').toLowerCase().includes(q)))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  $('#ordersTable tbody').innerHTML = list.slice(0, 2000).map((o) => `<tr data-id="${o.id}">
    <td><input type="checkbox" class="sel" data-id="${o.id}" ${state.selected.has(o.id) ? 'checked' : ''}></td>
    <td class="nowrap">${o.date}</td><td>${esc(empName(o.employeeId))}</td><td class="product"><div class="clip" title="${esc(o.product)}">${esc(o.product)}</div></td>${numCells(o)}
    <td class="num">${fmt(o.amount)}</td><td class="nowrap">${esc(o.channel)}</td><td><span class="badge ${o.status}" title="${esc(trackTitle(o))}">${STATUS[o.status] || o.status}</span></td>
    <td><button class="small secondary edit" data-id="${o.id}">Змінити</button></td></tr>`).join('')
    || `<tr><td colspan="10" class="hint">${state.ordersSource === 'auto' ? 'Замовлень немає. Зберіть їх з кабінетів у вкладці «Відправлення» або зачекайте на автоматичне оновлення.' : 'Замовлень немає. Імпортуйте аркуш таблиці або вставте рядки вище.'}</td></tr>`;
  $('#ordersCount').textContent = `Показано ${Math.min(list.length, 2000)} з ${list.length} (у наборі ${data.orders.filter((o) => o.source === state.ordersSource).length}, усього в базі ${data.orders.length})`;
  const urlRec = (data.settings.sheetUrls || []).find((u) => u.employeeId === Number($('#importEmployee').value));
  if (urlRec && !$('#importUrl').value) $('#importUrl').value = urlRec.url;
}

function openOrderForm(order) {
  const f = $('#orderForm');
  fillEmployeeSelect(f.employeeId, false);
  f.status.innerHTML = Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const o = order || { id: '', employeeId: Number($('#fEmployee').value) || (data.employees[0] || {}).id, date: today(), product: '', number: '', orderId: '', kind: '', source: state.ordersSource, amount: '', channel: '', status: 'ok' };
  state.formSource = o.source || state.ordersSource;
  $('#orderFormTitle').textContent = `${order ? 'Змінити' : 'Нове'} замовлення — ${SOURCE[state.formSource]}`;
  f.id.value = o.id; f.employeeId.value = o.employeeId; f.date.value = o.date; f.product.value = o.product;
  f.number.value = o.number; f.orderId.value = o.orderId || ''; f.amount.value = o.amount; f.channel.value = o.channel; f.status.value = o.status;
  state.formNp = o.track || null; state.formKind = o.kind || '';
  $('#orderNpInfo').textContent = trackTitle(o);
  $('#modal').classList.remove('hidden');
  f.product.focus();
}

// ---------- Працівники ----------
function renderEmployees() {
  $('#employeesTable tbody').innerHTML = data.employees.map((e) => `<tr data-id="${e.id}">
    <td><input class="emp-name" value="${esc(e.name)}"></td>
    <td class="num"><input class="emp-rate" type="number" step="0.1" min="0" value="${e.ratePercent == null ? '' : e.ratePercent}" placeholder="${data.settings.ratePercent}"></td>
    <td class="num">${data.orders.filter((o) => o.employeeId === e.id).length}</td>
    <td><button class="small danger secondary emp-del" data-id="${e.id}">Видалити</button></td></tr>`).join('')
    || '<tr><td colspan="4" class="hint">Додайте працівників</td></tr>';
}

function collectEmployees() {
  return [...document.querySelectorAll('#employeesTable tbody tr[data-id]')].map((tr) => ({
    id: Number(tr.dataset.id), name: tr.querySelector('.emp-name').value, ratePercent: tr.querySelector('.emp-rate').value,
  }));
}

// ---------- Налаштування / оновлення ----------
function renderSettings() {
  $('#ratePercent').value = data.settings.ratePercent;
  $('#appVersion').textContent = `Версія ${info.version || ''}`;
  $('#dataFile').textContent = info.dataFile || '';
  const a = data.settings.api || {};
  $('#apiEnabled').checked = !!a.enabled;
  $('#apiHost').value = a.host || '127.0.0.1';
  $('#apiPort').value = a.port || 8765;
  $('#apiToken').value = a.token || '';
  renderAccounts();
  const au = data.settings.auto || {};
  $('#autoEnabled').checked = !!au.enabled;
  $('#autoHours').value = String(au.hours || 6);
  renderAutoStatus();
  renderApiStatus();
}

function renderAutoStatus(extra) {
  const au = data.settings.auto || {};
  const el = $('#autoStatus');
  el.textContent = extra || (au.lastRun ? `Останнє оновлення ${au.lastRun}: ${au.lastResult}` : (au.enabled ? 'Ще не виконувалось' : 'Вимкнено'));
  el.className = 'status ' + (extra ? '' : (au.lastResult && au.lastResult.includes('помилок') ? 'err' : 'ok'));
}

function renderAccounts(tests) {
  const list = data.settings.accounts || [];
  $('#accountsTable tbody').innerHTML = list.map((a, i) => {
    const t = tests && tests[i];
    const empSel = `<select class="acc-emp" data-i="${i}"><option value="">Усі (спільний)</option>${data.employees.map((e) => `<option value="${e.id}" ${a.employeeId === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>`;
    return `<tr data-i="${i}"><td>${KIND_NAMES[a.kind] || a.kind}</td><td><input class="acc-name" data-i="${i}" value="${esc(a.name)}" style="width:100%"></td><td>${empSel}</td><td class="nowrap" title="${esc(a.token)}">…${esc(a.token.slice(-6))}</td>
    <td class="${t ? (t.ok ? 'ok' : 'err') : ''}">${t ? esc(t.message) : ''}</td><td><button class="small danger secondary acc-del" data-i="${i}">Видалити</button></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="hint">Кабінетів немає. Додайте ключ або імпортуйте зі скрипта таблиці.</td></tr>';
  fillEmployeeSelect($('#accEmployee'), 'shared');
  fillEmployeeSelect($('#accImportEmployee'), 'shared');
}

// ---------- Відправлення ----------
function renderShipments() {
  fillEmployeeSelect($('#shEmployee'), true);
  const sel = $('#shPeriod');
  if (!sel.options.length) {
    const d = new Date(); const ms = [];
    for (let i = 0; i < 8; i++) { ms.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); d.setMonth(d.getMonth() - 1); }
    sel.innerHTML = ms.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
  }
  const list = state.shipments;
  $('#shTable tbody').innerHTML = list.map((it, i) => `<tr>
    <td><input type="checkbox" class="sh-sel" data-i="${i}" ${state.shSelected.has(i) ? 'checked' : ''}></td>
    <td class="nowrap">${it.date}</td><td>${esc(it.employee)}</td><td class="nowrap">${esc(it.channel)}</td>
    <td><div class="clip" title="${esc(it.product)}">${esc(it.product)}</div></td>${numCells(it)}
    <td class="num">${fmt(it.amount)}</td><td><span class="badge ${it.status}" title="${esc(it.note)}">${STATUS[it.status] || it.status}</span></td>
    <td>${it.inBase ? 'так' : ''}</td></tr>`).join('')
    || '<tr><td colspan="10" class="hint">Нічого не зібрано.</td></tr>';
  $('#shAdd').disabled = !state.shSelected.size;
  $('#shAdd').textContent = state.shSelected.size ? `Додати в замовлення (${state.shSelected.size})` : 'Додати в замовлення';
}

async function renderApiStatus() {
  const st = await window.api.apiStatus();
  const el = $('#apiStatus');
  if (st.running) { el.textContent = `Працює: ${st.url}`; el.className = 'status ok'; }
  else if (st.error) { el.textContent = `Не запустився: ${st.error}`; el.className = 'status err'; }
  else { el.textContent = 'Вимкнено'; el.className = 'status'; }
  if (!$('#apiDocs').classList.contains('hidden')) renderDocs();
}

async function renderDocs() {
  $('#apiDocs').innerHTML = markdownToHtml(await window.api.apiDocs());
}

// Мінімальний Markdown → HTML для документації: заголовки, абзаци, списки, таблиці,
// блоки коду, `код`, **жирний**.
function markdownToHtml(md) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const lines = md.split('\n');
  let html = '', i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++; html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`; continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    if (h) { html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (l.startsWith('|')) {
      const rows = []; while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const body = rows.filter((r) => !/^\|\s*-{3,}/.test(r));
      html += '<table><thead><tr>' + cells(body[0]).map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
        body.slice(1).map((r) => '<tr>' + cells(r).map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
      continue;
    }
    if (/^\s*-\s+/.test(l)) {
      const items = []; while (i < lines.length && /^\s*-\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*-\s+/, ''));
      html += '<ul>' + items.map((x) => `<li>${inline(x)}</li>`).join('') + '</ul>'; continue;
    }
    if (!l.trim()) { i++; continue; }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#|```|\||\s*-\s)/.test(lines[i])) para.push(lines[i++]);
    html += `<p>${inline(para.join(' '))}</p>`;
  }
  return html;
}

function setUpdateStatus(u) {
  const el = $('#updateStatus'), bar = $('#updateBar'), inst = $('#installUpdate');
  const msgs = {
    checking: 'Перевіряю…', available: `Є нова версія ${u.version || ''}, завантажую…`, none: 'У вас остання версія.',
    downloading: `Завантаження ${u.percent || 0}%`, downloaded: `Версію ${u.version || ''} завантажено. Перезапустіть, щоб оновити.`,
    error: `Не вдалося перевірити оновлення: ${u.message || ''}`,
  };
  el.textContent = msgs[u.status] || '';
  el.className = 'status ' + (u.status === 'error' ? 'err' : u.status === 'downloaded' ? 'ok' : '');
  if (u.status === 'downloaded') {
    inst.classList.remove('hidden');
    bar.classList.remove('hidden');
    bar.innerHTML = `Нова версія ${esc(u.version || '')} готова<button id="installUpdateBar">Перезапустити</button>`;
    $('#installUpdateBar').onclick = () => window.api.installUpdate();
  }
}

// ---------- Загальне ----------
function renderAll() { renderSalary(); renderOrders(); renderShipments(); renderEmployees(); renderSettings(); }

async function reload(d) { data = d || await window.api.getData(); renderAll(); }

function showTab(name) {
  const section = SOURCE[name] ? 'orders' : name;
  if (SOURCE[name]) { state.ordersSource = name; document.body.dataset.source = name; state.selected.clear(); renderOrders(); }
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + section));
}

function bind() {
  document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // Зарплата
  $('#salaryPeriod').addEventListener('change', (e) => { state.salaryPeriod = e.target.value; renderSalary(); });
  $('#salarySource').addEventListener('change', async (e) => { data.settings = await window.api.saveSettings({ salarySource: e.target.value }); renderSalary(); });
  $('#salaryTable tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const id = Number(tr.dataset.id);
    state.detailEmployee = state.detailEmployee === id ? null : id;
    renderSalary();
  });
  $('#exportXlsx').addEventListener('click', async () => { const p = await window.api.exportFile({ format: 'xlsx', period: state.salaryPeriod, source: state.salarySource }); if (p) alert('Збережено: ' + p); });
  $('#exportCsv').addEventListener('click', async () => { const p = await window.api.exportFile({ format: 'csv', period: state.salaryPeriod, source: state.salarySource }); if (p) alert('Збережено: ' + p); });
  $('#compareBtn').addEventListener('click', async () => {
    const period = $('#fPeriod').value;
    if (!period) return alert('Виберіть період у фільтрі «Період» — звірка робиться за місяць');
    const r = await window.api.compareFile({ format: 'xlsx', period });
    if (!r) return;
    const t = r.totals;
    alert(`Звірка за ${monthLabel(period)}: збіг ${t['збіг'] || 0}, лише в авто ${t['лише в авто'] || 0}, лише в таблиці ${t['лише в таблиці'] || 0}, різний статус ${t['різний статус'] || 0}, різна сума ${t['різна сума'] || 0}, різний працівник ${t['різний працівник'] || 0}.\nЗбережено: ${r.path}`);
  });

  // Замовлення
  ['#fEmployee', '#fPeriod', '#fStatus'].forEach((s) => $(s).addEventListener('change', renderOrders));
  $('#fSearch').addEventListener('input', renderOrders);
  $('#importEmployee').addEventListener('change', () => {
    const rec = (data.settings.sheetUrls || []).find((u) => u.employeeId === Number($('#importEmployee').value));
    $('#importUrl').value = rec ? rec.url : '';
  });
  const importStatus = (msg, cls) => { const el = $('#importStatus'); el.textContent = msg; el.className = 'status ' + (cls || ''); };
  const afterImport = (r) => {
    if (!r) { importStatus('Скасовано'); return; }
    importStatus(`Прочитано рядків: ${r.parsed}. Додано нових: ${r.added}, оновлено статус/суму: ${r.updated}.`, 'ok');
    reload(r.data);
  };
  $('#importUrlBtn').addEventListener('click', async () => {
    const url = $('#importUrl').value.trim(), employeeId = Number($('#importEmployee').value);
    if (!employeeId) return importStatus('Спочатку додайте працівника', 'err');
    if (!url) return importStatus('Вставте посилання на таблицю', 'err');
    importStatus('Завантажую…');
    $('#importUrlBtn').disabled = true;
    try { afterImport(await window.api.importUrl({ url, employeeId, date: $('#importDate').value, defaultStatus: $('#importDefaultStatus').value })); }
    catch (e) { importStatus('Помилка: ' + (e.message || e).replace(/^.*Error: /, ''), 'err'); }
    finally { $('#importUrlBtn').disabled = false; }
  });
  $('#importFileBtn').addEventListener('click', async () => {
    const employeeId = Number($('#importEmployee').value);
    if (!employeeId) return importStatus('Спочатку додайте працівника', 'err');
    try { afterImport(await window.api.importFile({ employeeId, date: $('#importDate').value, defaultStatus: $('#importDefaultStatus').value })); }
    catch (e) { importStatus('Помилка: ' + (e.message || e), 'err'); }
  });
  // Нова Пошта
  const ttnStatus = (msg, cls) => { const el = $('#ttnStatus'); el.textContent = msg; el.className = 'status ' + (cls || ''); };
  const errMsg = (e) => (e.message || String(e)).replace(/^.*Error: /, '');
  $('#ttnAddBtn').addEventListener('click', async () => {
    const employeeId = Number($('#ttnEmployee').value), numbers = $('#ttnNumbers').value.trim();
    if (!employeeId) return ttnStatus('Спочатку додайте працівника', 'err');
    if (!numbers) return ttnStatus('Вставте номер ТТН', 'err');
    ttnStatus('Шукаю в Новій Пошті та на маркетплейсах…');
    $('#ttnAddBtn').disabled = true;
    try {
      const r = await window.api.npAdd({ employeeId, numbers });
      const parts = [`Додано: ${r.added}, оновлено: ${r.updated}.`];
      if (r.notFound.length) parts.push(`Не знайдено ніде: ${r.notFound.join(', ')}.`);
      if (r.noAmount.length) parts.push(`Без суми (вкажіть вручну): ${r.noAmount.length}.`);
      if (r.errors.length) parts.push(`Помилки кабінетів: ${r.errors.join('; ')}.`);
      ttnStatus(parts.join(' '), r.added + r.updated ? 'ok' : 'err');
      if (r.added + r.updated) $('#ttnNumbers').value = '';
      reload(r.data);
    } catch (e) { ttnStatus('Помилка: ' + errMsg(e), 'err'); }
    finally { $('#ttnAddBtn').disabled = false; }
  });
  const refreshStatus = (msg, cls) => { const el = $('#refreshStatus'); el.textContent = msg; el.className = 'status ' + (cls || ''); el.style.margin = '0'; };
  $('#refreshNp').addEventListener('click', async () => {
    const p = { source: state.ordersSource, employee: $('#fEmployee').value || undefined, period: $('#fPeriod').value || undefined, status: $('#fStatus').value || undefined, q: $('#fSearch').value.trim() || undefined, withDate: $('#refreshWithDate').checked };
    refreshStatus('Перевіряю в Новій Пошті та на маркетплейсах…');
    $('#refreshNp').disabled = true;
    try {
      const r = await window.api.npRefresh(p);
      const parts = [`Перевірено: ${r.checked}, змінено: ${r.updated}.`];
      if (r.notFound.length) parts.push(`Не знайдено ніде: ${r.notFound.length}.`);
      if (r.skipped) parts.push(`Без номера (пропущено): ${r.skipped}.`);
      if (r.errors.length) parts.push(`Помилки кабінетів: ${r.errors.join('; ')}.`);
      refreshStatus(parts.join(' '), 'ok');
      reload(r.data);
    } catch (e) { refreshStatus('Помилка: ' + errMsg(e), 'err'); }
    finally { $('#refreshNp').disabled = false; }
  });
  $('#orderTrack').addEventListener('click', async () => {
    const f = $('#orderForm'), number = f.number.value.trim(), info = $('#orderNpInfo');
    if (!number) { info.textContent = 'Введіть номер ТТН'; return; }
    info.textContent = 'Шукаю…';
    try {
      const r = await window.api.npTrack(number);
      const t = r.results[0];
      if (!t || !t.found) { info.textContent = 'Не знайдено ні в Новій Пошті, ні на маркетплейсах' + (r.errors.length ? ` (${r.errors.join('; ')})` : ''); return; }
      f.status.value = t.status;
      if (t.amount != null) f.amount.value = t.amount;
      if (t.channel) f.channel.value = t.channel;
      if (!f.product.value && t.product) f.product.value = t.product;
      if (t.date && !f.id.value) f.date.value = t.date;
      state.formNp = { checked: today(), note: t.note, problem: t.problem, np: t.np, mp: t.mp, rd: t.rd };
      info.textContent = t.note + (t.amount == null ? '. Суми немає — вкажіть вручну' : '');
    } catch (e) { info.textContent = 'Помилка: ' + errMsg(e); }
  });

  // Вставка з таблиці
  const pasteStatus = (msg, cls) => { const el = $('#pasteStatus'); el.textContent = msg; el.className = 'status ' + (cls || ''); };
  $('#pasteBtn').addEventListener('click', async () => {
    const text = $('#pasteText').value;
    if (!text.trim()) return pasteStatus('Вставте рядки з таблиці', 'err');
    pasteStatus('Шукаю в Новій Пошті та на маркетплейсах…'); $('#pasteBtn').disabled = true;
    try {
      const r = await window.api.importPaste(text);
      const parts = [`Рядків: ${r.parsed}. Додано: ${r.added}, оновлено: ${r.updated}.`];
      if (r.notFound.length) parts.push(`Не знайдено ніде: ${r.notFound.join(', ')}.`);
      if (r.noAmount.length) parts.push(`Без суми: ${r.noAmount.length}.`);
      if (r.unknown.length) parts.push(`Пропущено рядків: ${r.unknown.length} (${r.unknown.slice(0, 3).map((u) => `«${u.line.slice(0, 40)}» — ${u.reason}`).join('; ')}${r.unknown.length > 3 ? '…' : ''}).`);
      if (r.errors.length) parts.push(`Помилки кабінетів: ${r.errors.join('; ')}.`);
      pasteStatus(parts.join(' '), r.added + r.updated ? 'ok' : 'err');
      if (r.added + r.updated) $('#pasteText').value = '';
      reload(r.data);
    } catch (e) { pasteStatus('Помилка: ' + errMsg(e), 'err'); }
    finally { $('#pasteBtn').disabled = false; }
  });

  // Відправлення
  const shStatus = (msg, cls) => { const el = $('#shStatus'); el.textContent = msg; el.className = 'status ' + (cls || ''); };
  $('#shCollect').addEventListener('click', async () => {
    shStatus('Збираю з кабінетів і звіряю з Новою Поштою… (до кількох хвилин)'); $('#shCollect').disabled = true;
    try {
      const r = await window.api.shipmentsCollect({ employee: $('#shEmployee').value || undefined, period: $('#shPeriod').value });
      state.shipments = r.items; state.shSelected = new Set(r.items.map((_, i) => i)); $('#shSelectAll').checked = true;
      const sum = r.items.filter((x) => x.status === 'ok').reduce((a, x) => a + (Number(x.amount) || 0), 0);
      const parts = [`Зібрано: ${r.items.length} (виконано ${r.items.filter((x) => x.status === 'ok').length} на ${fmt(sum)}, уже в базі ${r.items.filter((x) => x.inBase).length}).`];
      if (r.errors.length) parts.push(`Помилки: ${r.errors.join('; ')}.`);
      shStatus(parts.join(' '), r.errors.length ? 'err' : 'ok');
      renderShipments();
    } catch (e) { shStatus('Помилка: ' + errMsg(e), 'err'); }
    finally { $('#shCollect').disabled = false; }
  });
  $('#shTable tbody').addEventListener('change', (e) => {
    const cb = e.target.closest('input.sh-sel'); if (!cb) return;
    const i = Number(cb.dataset.i); if (cb.checked) state.shSelected.add(i); else state.shSelected.delete(i);
    renderShipments();
  });
  $('#shSelectAll').addEventListener('change', (e) => { state.shSelected = new Set(e.target.checked ? state.shipments.map((_, i) => i) : []); renderShipments(); });
  $('#shAdd').addEventListener('click', async () => {
    const items = [...state.shSelected].map((i) => state.shipments[i]).filter(Boolean);
    if (!items.length) return;
    try {
      const r = await window.api.shipmentsAdd(items);
      shStatus(`Додано: ${r.added}, оновлено: ${r.updated}.`, 'ok');
      for (const it of items) it.inBase = true;
      reload(r.data);
    } catch (e) { shStatus('Помилка: ' + errMsg(e), 'err'); }
  });

  $('#addOrder').addEventListener('click', () => openOrderForm(null));
  $('#ordersTable tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('button.edit');
    if (btn) { openOrderForm(data.orders.find((o) => o.id === Number(btn.dataset.id))); return; }
    const cb = e.target.closest('input.sel');
    if (cb) { const id = Number(cb.dataset.id); if (cb.checked) state.selected.add(id); else state.selected.delete(id); }
  });
  $('#selectAll').addEventListener('change', (e) => {
    document.querySelectorAll('#ordersTable input.sel').forEach((cb) => { cb.checked = e.target.checked; const id = Number(cb.dataset.id); if (cb.checked) state.selected.add(id); else state.selected.delete(id); });
  });
  $('#deleteSelected').addEventListener('click', async () => {
    const ids = [...state.selected].filter((id) => data.orders.some((o) => o.id === id));
    if (!ids.length) return alert('Нічого не вибрано');
    if (!confirm(`Видалити замовлень: ${ids.length}?`)) return;
    state.selected.clear(); $('#selectAll').checked = false;
    reload(await window.api.deleteOrders(ids));
  });
  $('#orderCancel').addEventListener('click', () => $('#modal').classList.add('hidden'));
  $('#orderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const o = { id: f.id.value, employeeId: f.employeeId.value, date: f.date.value, product: f.product.value, number: f.number.value, orderId: f.orderId.value, kind: state.formKind, source: state.formSource, amount: f.amount.value, channel: f.channel.value, status: f.status.value, track: state.formNp };
    $('#modal').classList.add('hidden');
    reload(await window.api.saveOrder(o));
  });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
  // Клік по ТТН або № замовлення — у буфер обміну.
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('.copy'); if (!el) return;
    await window.api.copyText(el.dataset.copy);
    toast(`Скопійовано: ${el.dataset.copy}`);
  });

  // Працівники
  $('#addEmployee').addEventListener('click', async () => {
    const name = $('#newEmployeeName').value.trim();
    if (!name) return;
    const list = collectEmployees(); list.push({ id: 0, name, ratePercent: '' });
    $('#newEmployeeName').value = '';
    reload(await window.api.saveEmployees(list));
  });
  $('#newEmployeeName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#addEmployee').click(); });
  $('#employeesTable tbody').addEventListener('change', async () => reload(await window.api.saveEmployees(collectEmployees())));
  $('#employeesTable tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button.emp-del'); if (!btn) return;
    const id = Number(btn.dataset.id);
    const n = data.orders.filter((o) => o.employeeId === id).length;
    if (!confirm(`Видалити працівника «${empName(id)}»${n ? ` разом із ${n} замовленнями` : ''}?`)) return;
    reload(await window.api.saveEmployees(collectEmployees().filter((x) => x.id !== id)));
  });

  // Налаштування
  $('#saveSettings').addEventListener('click', async () => {
    const rate = Number($('#ratePercent').value);
    if (!Number.isFinite(rate) || rate < 0) return alert('Вкажіть ставку числом');
    data.settings = await window.api.saveSettings({ ratePercent: rate });
    renderAll();
  });
  $('#saveApi').addEventListener('click', async () => {
    const apiCfg = { enabled: $('#apiEnabled').checked, host: $('#apiHost').value.trim() || '127.0.0.1', port: Number($('#apiPort').value) || 8765, token: $('#apiToken').value.trim() };
    if (apiCfg.enabled && apiCfg.host !== '127.0.0.1' && apiCfg.host !== 'localhost' && !apiCfg.token && !confirm('API буде доступний з мережі без ключа. Продовжити?')) return;
    try { data.settings = await window.api.saveSettings({ api: apiCfg }); renderSettings(); }
    catch (e) { alert((e.message || String(e)).replace(/^.*Error: /, '')); }
  });
  const accStatus = (msg, cls) => { const el = $('#accStatus'); el.textContent = msg; el.className = 'status ' + (cls || ''); };
  const saveAccounts = async (list) => { try { data.settings = await window.api.saveSettings({ accounts: list }); renderAccounts(); } catch (e) { accStatus('Помилка: ' + errMsg(e), 'err'); } };
  $('#saveAuto').addEventListener('click', async () => {
    try { data.settings = await window.api.saveSettings({ auto: { enabled: $('#autoEnabled').checked, hours: Number($('#autoHours').value) } }); renderAutoStatus(); }
    catch (e) { alert(errMsg(e)); }
  });
  $('#syncNow').addEventListener('click', async () => {
    renderAutoStatus('Збираю з кабінетів і перевіряю… (до кількох хвилин)'); $('#syncNow').disabled = true;
    try { const r = await window.api.syncRun(); await reload(r.data); if (r.errors && r.errors.length) renderAutoStatus(`${data.settings.auto.lastResult}. Помилки: ${r.errors.join('; ')}`); }
    catch (e) { renderAutoStatus('Помилка: ' + errMsg(e)); }
    finally { $('#syncNow').disabled = false; }
  });
  window.api.onSyncDone(async () => { await reload(); });
  $('#accAdd').addEventListener('click', async () => {
    const token = $('#accToken').value.trim();
    if (!token) return accStatus('Вставте ключ', 'err');
    await saveAccounts([...(data.settings.accounts || []), { kind: $('#accKind').value, name: $('#accName').value.trim(), token, employeeId: $('#accEmployee').value ? Number($('#accEmployee').value) : null }]);
    $('#accToken').value = ''; $('#accName').value = '';
    accStatus('Кабінет додано', 'ok');
  });
  $('#accountsTable tbody').addEventListener('change', async (e) => {
    const sel = e.target.closest('select.acc-emp'), inp = e.target.closest('input.acc-name');
    if (!sel && !inp) return;
    const list = (data.settings.accounts || []).map((a) => Object.assign({}, a));
    if (sel) list[Number(sel.dataset.i)].employeeId = sel.value ? Number(sel.value) : null;
    if (inp) list[Number(inp.dataset.i)].name = inp.value.trim();
    await saveAccounts(list);
    renderOrders(); renderSalary();
  });
  $('#accountsTable tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button.acc-del'); if (!btn) return;
    const list = (data.settings.accounts || []).slice(); const a = list[Number(btn.dataset.i)];
    if (!confirm(`Видалити кабінет «${a.name}»?`)) return;
    list.splice(Number(btn.dataset.i), 1);
    await saveAccounts(list);
  });
  $('#accTest').addEventListener('click', async () => {
    accStatus('Перевіряю кабінети…'); $('#accTest').disabled = true;
    try { const r = await window.api.accountsTest(); renderAccounts(r); accStatus(`Перевірено: ${r.length}, помилок: ${r.filter((x) => !x.ok).length}`, r.every((x) => x.ok) ? 'ok' : 'err'); }
    catch (e) { accStatus('Помилка: ' + errMsg(e), 'err'); }
    finally { $('#accTest').disabled = false; }
  });
  $('#accImportToggle').addEventListener('click', () => $('#accImport').classList.toggle('hidden'));
  $('#accImportBtn').addEventListener('click', async () => {
    try {
      const r = await window.api.accountsImport({ text: $('#accScript').value, employeeId: $('#accImportEmployee').value ? Number($('#accImportEmployee').value) : null });
      data.settings = r.settings; renderAccounts(); $('#accScript').value = ''; $('#accImport').classList.add('hidden');
      accStatus(`Знайдено ключів у скрипті: ${r.parsed}, додано нових: ${r.added}`, 'ok');
    } catch (e) { accStatus('Помилка: ' + errMsg(e), 'err'); }
  });
  $('#toggleDocs').addEventListener('click', async () => {
    const box = $('#apiDocs');
    box.classList.toggle('hidden');
    $('#toggleDocs').textContent = box.classList.contains('hidden') ? 'Показати документацію' : 'Сховати документацію';
    if (!box.classList.contains('hidden')) await renderDocs();
  });
  $('#saveDocs').addEventListener('click', async () => { const p = await window.api.apiDocsSave(); if (p) alert('Збережено: ' + p); });
  $('#checkUpdate').addEventListener('click', async () => setUpdateStatus(await window.api.checkUpdate()));
  $('#installUpdate').addEventListener('click', () => window.api.installUpdate());
  $('#releasesLink').addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(info.releasesUrl); });
  $('#showDataFile').addEventListener('click', (e) => { e.preventDefault(); window.api.showDataFile(); });
  const backupStatus = (msg, cls) => { const el = $('#backupStatus'); el.textContent = msg; el.className = 'status ' + (cls || ''); };
  $('#backupSave').addEventListener('click', async () => {
    try { const p = await window.api.backupSave(); if (p) backupStatus('Збережено: ' + p, 'ok'); }
    catch (e) { backupStatus('Помилка: ' + errMsg(e), 'err'); }
  });
  $('#backupRestore').addEventListener('click', async () => {
    if (!confirm('Відновлення замінить усі поточні дані (замовлення, працівників, ключі) даними з файлу. Продовжити?')) return;
    try {
      const r = await window.api.backupRestore();
      if (!r) return;
      backupStatus(`Відновлено: працівників ${r.employees}, замовлень ${r.orders}`, 'ok');
      reload(r.data);
    } catch (e) { backupStatus('Помилка: ' + errMsg(e), 'err'); }
  });
  window.api.onUpdateStatus(setUpdateStatus);
}

(async function init() {
  info = await window.api.appInfo();
  $('#versionLabel').textContent = `v${info.version}${info.packaged ? '' : ' (розробка)'}`;
  document.body.dataset.source = state.ordersSource;
  bind();
  await reload();
})();
