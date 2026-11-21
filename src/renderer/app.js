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
// Статус: бейдж + рядком нижче деталь (що сказав перевізник або кабінет); повний опис — у підказці.
const NP_SHORT = { 1: 'Створено, ще не відправлено', 2: 'Накладну видалено', 3: 'Номер не знайдено' };
const RD_ERROR = /^HTTP|з’єднання|не знайдено/;
// Сума — оголошена вартість НП (передплата, накладеного платежу немає): видно, звідки сума.
function statusDetail(track, order) {
  const d = statusDetailBase(track, order);
  return track && track.amountSource === 'Нова Пошта (оголошена вартість)' && order && order.status === 'ok' ? `${d} · сума — оголошена вартість НП` : d;
}
function statusDetailBase(track, order) {
  if (order && order.invalid) return `Неправильний рядок: ${order.invalid}`;
  if (order && !order.number && !order.orderId) return 'Немає ТТН чи номера замовлення';
  if (order && order.status === 'nodata' && track && track.noAmount) {
    const announced = track.np && track.np.announced;
    return `Суми немає (НП: передплата) — впишіть суму${announced ? `; оголошена вартість НП ${announced} грн` : ''}`;
  }
  if (order && order.dup) return 'Дубль ТТН у таблиці — сума врахована в першому рядку';
  if (!track) return '';
  const np = track.np, rd = track.rd, mp = track.mp;
  if (np && np.status && np.code !== '3') return `Нова Пошта: ${NP_SHORT[np.code] || np.status}${np.received ? ` (${np.received})` : ''}`;
  if (rd && rd.status && !RD_ERROR.test(rd.status)) return `Rozetka Delivery: ${rd.status}${rd.date ? ` (${rd.date})` : ''}`;
  if (mp && mp.status) return `${mp.channel || mp.kind}: ${mp.status}`;
  if (rd && rd.status) return `Rozetka Delivery: ${rd.status}`;
  if (np && np.status) return `Нова Пошта: ${np.status}`;
  return order && order.status === 'nodata' && track.checked ? 'Номер ніде не знайдено' : '';
}
// Як lib.statusLabel: «Перевіряється» — лише поки ніхто не відповів, інакше «В дорозі» (перевізник) або «В обробці» (маркетплейс).
const CHECKING_GROUP = 'В дорозі / в обробці';
function statusLabel(status, track) {
  if (status !== 'checking') return STATUS[status] || status;
  const t = track || {};
  if ((t.np && t.np.code && t.np.code !== '3') || (t.rd && t.rd.status && !RD_ERROR.test(t.rd.status))) return 'В дорозі';
  return t.mp ? 'В обробці' : STATUS.checking;
}
// як lib.statusRank / lib.orderCompare
function statusRank(o) {
  const t = o.track || {};
  if (o.status === 'ok') return 0;
  if (o.status === 'nodata') return o.invalid ? 3 : t.np && t.np.code === '1' ? 2 : 1;
  if (o.status === 'refused') return t.problem === 'ВОЗВРАТ' ? 6 : 5;
  if (o.status === 'cancelled') return 7;
  return 4; // checking: в дорозі / в обробці
}
const orderCompare = (a, b) => statusRank(a) - statusRank(b) || ((data.employees.find((e) => e.id === a.employeeId) || {}).name || '').localeCompare((data.employees.find((e) => e.id === b.employeeId) || {}).name || '', 'uk')
  || (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id);
const badge = (status, label) => `<span class="badge ${status}">${esc(label || STATUS[status] || status)}</span>`;
// o — замовлення або відправлення: {status, track, number, orderId}.
const statusCell = (o, note) => `<td class="status-cell" title="${esc(note || '')}">${badge(o.status, statusLabel(o.status, o.track))}<div class="detail clip">${esc(statusDetail(o.track, o))}</div></td>`;
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
const orderMonth = (o) => o.month || monthOf(o.date); // як lib.orderMonth: вставлене — місяць вкладки таблиці
const monthLabel = (m) => {
  const names = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
  const [y, mm] = m.split('-');
  return `${names[Number(mm) - 1] || mm} ${y}`;
};
const empName = (id) => (data.employees.find((e) => e.id === id) || {}).name || '—';

function months() {
  const set = new Set(data.orders.map(orderMonth).filter(Boolean));
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
    const orders = data.orders.filter((o) => o.employeeId === e.id && o.source === state.salarySource && (!period || orderMonth(o) === period));
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
  const orders = data.orders.filter((o) => o.employeeId === id && o.source === state.salarySource && (!state.salaryPeriod || orderMonth(o) === state.salaryPeriod))
    .sort(orderCompare);
  $('#salaryDetailTitle').textContent = `${empName(id)} — ${state.salaryPeriod ? monthLabel(state.salaryPeriod) : 'увесь час'}, ${SOURCE[state.salarySource]} (${orders.length})`;
  box.querySelector('tbody').innerHTML = orders.map((o) => `<tr><td class="nowrap">${o.date}</td><td class="product"><div class="clip" title="${esc(o.product)}">${esc(o.product)}</div></td>${numCells(o)}
    <td class="num">${fmt(o.amount)}</td><td>${esc(o.channel)}</td>${statusCell(o, trackTitle(o))}</tr>`).join('')
    || '<tr><td colspan="7" class="hint">Замовлень немає</td></tr>';
}

// ---------- Замовлення ----------
function renderOrders() {
  fillEmployeeSelect($('#fEmployee'), true);
  const fPeriodSel = $('#fPeriod');
  const curPeriod = fPeriodSel.dataset.set ? fPeriodSel.value : '';
  fillPeriodSelect(fPeriodSel, curPeriod, 'Усі'); fPeriodSel.dataset.set = '1';
  const fStatus = $('#fStatus');
  if (fStatus.options.length === 1) fStatus.innerHTML += Object.entries(Object.assign({}, STATUS, { checking: CHECKING_GROUP })).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#ordersTitle').textContent = `Замовлення: ${SOURCE[state.ordersSource]}`;
  const emp = Number($('#fEmployee').value) || null, period = fPeriodSel.value, st = fStatus.value, q = $('#fSearch').value.trim().toLowerCase();
  const list = data.orders.filter((o) => o.source === state.ordersSource && (!emp || o.employeeId === emp) && (!period || orderMonth(o) === period) && (!st || o.status === st)
    && (!q || (o.product || '').toLowerCase().includes(q) || (o.number || '').toLowerCase().includes(q) || (o.orderId || '').toLowerCase().includes(q)))
    .sort(orderCompare);
  $('#ordersTable tbody').innerHTML = list.slice(0, 2000).map((o) => `<tr data-id="${o.id}">
    <td><input type="checkbox" class="sel" data-id="${o.id}" ${state.selected.has(o.id) ? 'checked' : ''}></td>
    <td class="nowrap">${o.date}</td><td>${esc(empName(o.employeeId))}</td><td class="product"><div class="clip" title="${esc(o.product)}">${esc(o.product)}</div></td>${numCells(o)}
    <td class="num">${fmt(o.amount)}</td><td class="nowrap">${esc(o.channel)}</td>${statusCell(o, trackTitle(o))}
    <td><button class="small secondary edit" data-id="${o.id}">Змінити</button></td></tr>`).join('')
    || `<tr><td colspan="10" class="hint">${state.ordersSource === 'auto' ? 'Замовлень немає. Зберіть їх з кабінетів у вкладці «Відправлення» або зачекайте на автоматичне оновлення.' : 'Замовлень немає. Вставте рядки з таблиці або номери вище.'}</td></tr>`;
  $('#ordersCount').textContent = `Показано ${Math.min(list.length, 2000)} з ${list.length} (у наборі ${data.orders.filter((o) => o.source === state.ordersSource).length}, усього в базі ${data.orders.length})`;
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
    <td class="num">${fmt(it.amount)}</td>${statusCell(it, it.note)}
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
  const orderFilters = () => ({ source: state.ordersSource, employee: $('#fEmployee').value || undefined, period: $('#fPeriod').value || undefined, status: $('#fStatus').value || undefined, q: $('#fSearch').value.trim() || undefined });
  const exportOrders = async (format) => { const r = await window.api.exportOrders({ format, filters: orderFilters() }); if (r) alert(`Збережено ${r.count} замовлень: ${r.path}`); };
  $('#ordersXlsx').addEventListener('click', () => exportOrders('xlsx'));
  $('#ordersCsv').addEventListener('click', () => exportOrders('csv'));

  // Замовлення
  ['#fEmployee', '#fPeriod', '#fStatus'].forEach((s) => $(s).addEventListener('change', renderOrders));
  $('#fSearch').addEventListener('input', renderOrders);
  // Нова Пошта
  const ttnStatus = (msg, cls) => { const el = $('#ttnStatus'); el.textContent = msg; el.className = 'status ' + (cls || ''); };
  const errMsg = (e) => (e.message || String(e)).replace(/^.*Error: /, '');
  $('#ttnAddBtn').addEventListener('click', async () => {
    const numbers = $('#ttnNumbers').value.trim();
    if (!data.employees.length) return ttnStatus('Спочатку додайте працівника й прив’яжіть до нього кабінети в Налаштуваннях', 'err');
    if (!numbers) return ttnStatus('Вставте номер ТТН', 'err');
    ttnStatus('Шукаю в Новій Пошті та на маркетплейсах…');
    $('#ttnAddBtn').disabled = true;
    try {
      const r = await window.api.npAdd({ numbers });
      const counted = r.added + r.updated + r.unchanged;
      const parts = [`Додано: ${r.added}, оновлено: ${r.updated}, без змін: ${r.unchanged}.`];
      if (r.noEmployee.length) parts.push(`Не додано — не знайдено в кабінетах працівників (чиє це?): ${r.noEmployee.join(', ')}.`);
      if (r.notFound.length) parts.push(`Не знайдено ніде: ${r.notFound.join(', ')}.`);
      if (r.noAmount.length) parts.push(`Без суми (вкажіть вручну): ${r.noAmount.length}.`);
      if (r.errors.length) parts.push(`Помилки кабінетів: ${r.errors.join('; ')}.`);
      ttnStatus(parts.join(' '), counted ? 'ok' : 'err');
      if (counted) $('#ttnNumbers').value = '';
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

  // Вставка з таблиці: спершу попередній перегляд сіткою (нічого не записується), запис — лише за «Порахувати».
  // З буфера береться text/html (таблиця Google Таблиць чи Excel: клітинка = клітинка), текст — запасний варіант.
  const pasteStatus = (msg, cls) => { const el = $('#pasteStatus'); el.textContent = msg; el.className = 'status ' + (cls || ''); };
  let pasteHtml = ''; // таблиця з останньої вставки; будь-яка правка поля руками її скидає і закриває перегляд
  // Текст з буфера як є: поле введення замінює самотній \r у клітинці («товар \r») на перенос рядка, і рядок таблиці
  // розривався на два (уламок «Саперний мультитул золотий» без ТТН, 2026-11-19). Значення поля — лише після правки руками.
  let pasteRaw = null;
  const pastePayload = () => ({ text: pasteRaw != null ? pasteRaw : $('#pasteText').value, html: pasteHtml, month: $('#pasteMonth').value });
  const PASTE_STATE = { new: 'буде додано', existing: 'уже в базі — оновиться', added: 'додано', updated: 'оновлено', unchanged: 'без змін' };
  const colName = (i) => (i < 26 ? '' : String.fromCharCode(64 + Math.floor(i / 26))) + String.fromCharCode(65 + (i % 26));
  const renderPasteGrid = (r, done) => {
    const cols = Math.max(1, ...r.rows.map((x) => x.cells.length));
    $('#pasteGrid thead').innerHTML = `<tr><th class="num">№</th>${Array.from({ length: cols }, (_, i) => `<th>${colName(i)}</th>`).join('')}<th class="calc">Номер ТТН</th><th class="calc">Працівник</th><th class="calc num">Сума</th><th class="calc">Стан</th></tr>`;
    $('#pasteGrid tbody').innerHTML = r.rows.map((x) => {
      const bad = !!x.reason; // неправильний рядок: запишеться з позначкою
      const who = x.employee ? esc(x.employee) + (x.employeeGuess ? ' <span class="muted" title="Так записано в базі; остаточно визначить кабінет">(з бази)</span>' : '')
        : (bad ? '' : '<span class="muted">визначить кабінет</span>');
      const status = x.status ? ' · ' + badge(x.status, x.statusLabel) : '';
      return `<tr class="${bad ? 'bad' : ''}"><td class="num">${x.row}</td>${Array.from({ length: cols }, (_, i) => `<td class="cell">${esc(x.cells[i] || '')}</td>`).join('')}
        <td class="calc nowrap">${esc(x.number)}</td><td class="calc">${who}</td><td class="calc num">${x.amount == null ? '—' : fmt(x.amount)}</td>
        <td class="calc">${PASTE_STATE[x.state] + (bad ? ` · <b>неправильний: ${esc(x.reason)}</b>` : '') + status + (x.dupOf ? ` · <span class="muted">дубль рядка ${x.dupOf}</span>` : '') + (x.number ? '' : ' · <span class="muted">немає ТТН</span>')}</td></tr>`;
    }).join('');
    // рядків у буфері N → записів N: кожен рядок — свій запис; не записується лише рядок без працівника
    const counted = done ? `записано ${r.counted} (додано ${r.added}, оновлено ${r.updated}, без змін ${r.unchanged})` : `буде записано ${r.counted} (нових ${r.new}, уже в базі ${r.existing})`;
    $('#pasteTotals').textContent = `Рядків у буфері ${r.total} → ${counted}` + (r.duplicates ? ` · дублів ТТН ${r.duplicates}` : '') + (r.invalid.length ? ` · з них неправильних ${r.invalid.length}` : '');
    const ms = [...new Set([r.month, ...months()])].filter(Boolean).sort().reverse();
    $('#pasteMonth').innerHTML = '<option value="">за датою замовлення</option>' + ms.map((m) => `<option value="${m}">${monthLabel(m)}</option>`).join('');
    $('#pasteMonth').value = r.month; $('#pasteMonth').disabled = done;
    $('#pasteOnlyBad').checked = false; $('#pasteOnlyBad').parentElement.classList.toggle('hidden', !r.invalid.length);
    $('#pastePreview .sheet').classList.remove('only-bad');
    $('#pasteCount').classList.toggle('hidden', done || !r.counted);
    $('#pasteCancel').textContent = done ? 'Закрити' : 'Скасувати';
    $('#pastePreview').classList.remove('hidden');
  };
  const closePastePreview = () => $('#pastePreview').classList.add('hidden');
  const previewPaste = async () => {
    if (!$('#pasteText').value.trim() && !pasteHtml) return pasteStatus('Вставте клітинки з таблиці', 'err');
    closePastePreview();
    try {
      renderPasteGrid(await window.api.importPaste(Object.assign({ preview: true }, pastePayload(), { month: undefined })), false);
      pasteStatus('Перевірте, що розпізнано, і місяць вкладки таблиці. Кожен рядок стане окремим записом; червоні запишуться з позначкою «Неправильний рядок». У базу нічого не записано, доки не натиснете «Порахувати».');
    } catch (e) { pasteStatus('Помилка: ' + errMsg(e), 'err'); }
  };
  $('#pasteText').addEventListener('paste', (e) => {
    const html = e.clipboardData.getData('text/html');
    pasteHtml = /<table\b/i.test(html) ? html : '';
    pasteRaw = e.clipboardData.getData('text/plain');
    e.preventDefault(); $('#pasteText').value = pasteRaw; // вставлене замінює поле: перегляд показує саме цю вставку
    setTimeout(previewPaste, 0);
  });
  $('#pasteText').addEventListener('input', () => { pasteHtml = ''; pasteRaw = null; closePastePreview(); }); // текст правили руками — таблиця з буфера вже не про нього
  $('#pasteBtn').addEventListener('click', previewPaste);
  $('#pasteOnlyBad').addEventListener('change', (e) => $('#pastePreview .sheet').classList.toggle('only-bad', e.target.checked));
  const pasteBusy = (on) => { for (const id of ['#pasteCount', '#pasteText', '#pasteBtn', '#pasteCancel', '#pasteMonth']) $(id).disabled = on; }; // під час підрахунку нова вставка неможлива
  $('#pasteCancel').addEventListener('click', () => { closePastePreview(); pasteStatus(''); });
  $('#pasteCount').addEventListener('click', async () => {
    pasteStatus('Шукаю в Новій Пошті та на маркетплейсах… (для сотень рядків — кілька хвилин)'); pasteBusy(true);
    try {
      const r = await window.api.importPaste(pastePayload());
      renderPasteGrid(r, true);
      const parts = ['Готово.'];
      if (r.notFound.length) parts.push(`Не знайдено ніде (лишились як «Немає даних»): ${r.notFound.length} — ${r.notFound.slice(0, 20).join(', ')}${r.notFound.length > 20 ? '…' : ''}.`);
      if (r.noAmount.length) parts.push(`Без суми: ${r.noAmount.length}.`);
      if (r.errors.length) parts.push(`Помилки кабінетів: ${r.errors.join('; ')}.`);
      pasteStatus(parts.join(' '), r.counted ? 'ok' : 'err');
      pasteHtml = ''; pasteRaw = null;
      if (r.counted) $('#pasteText').value = '';
      reload(r.data);
    } catch (e) { pasteStatus('Помилка: ' + errMsg(e), 'err'); }
    finally { pasteBusy(false); }
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
