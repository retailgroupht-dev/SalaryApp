'use strict';
// Логіка вікна. Усі дані приходять з головного процесу через window.api.

const STATUS = { ok: 'Виконано', refused: 'Відмова', cancelled: 'Скасовано', nodata: 'Немає даних', checking: 'Перевіряється' };
const $ = (sel) => document.querySelector(sel);
let data = { settings: {}, employees: [], orders: [] };
let info = {};
const state = { salaryPeriod: null, detailEmployee: null, selected: new Set() };

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
  sel.innerHTML = (withAll ? '<option value="">Усі</option>' : '') + data.employees.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

// ---------- Зарплата ----------
function calcRows(period) {
  const rate = Number(data.settings.ratePercent) || 0;
  return data.employees.map((e) => {
    const r = e.ratePercent == null || e.ratePercent === '' ? rate : Number(e.ratePercent);
    const orders = data.orders.filter((o) => o.employeeId === e.id && (!period || monthOf(o.date) === period));
    const cnt = (s) => orders.filter((o) => o.status === s).length;
    const sumDone = orders.filter((o) => o.status === 'ok').reduce((a, o) => a + (Number(o.amount) || 0), 0);
    const round2 = (n) => Math.round(n * 100) / 100;
    return { e, r, total: orders.length, done: cnt('ok'), refused: cnt('refused'), cancelled: cnt('cancelled'), nodata: cnt('nodata'), checking: cnt('checking'), sumDone: round2(sumDone), salary: round2(sumDone * r / 100) };
  });
}

function renderSalary() {
  state.salaryPeriod = fillPeriodSelect($('#salaryPeriod'), state.salaryPeriod, 'Увесь час');
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
  const orders = data.orders.filter((o) => o.employeeId === id && (!state.salaryPeriod || monthOf(o.date) === state.salaryPeriod))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  $('#salaryDetailTitle').textContent = `${empName(id)} — ${state.salaryPeriod ? monthLabel(state.salaryPeriod) : 'увесь час'} (${orders.length})`;
  box.querySelector('tbody').innerHTML = orders.map((o) => `<tr><td class="nowrap">${o.date}</td><td class="product"><div class="clip" title="${esc(o.product)}">${esc(o.product)}</div></td><td class="nowrap">${esc(o.number)}</td>
    <td class="num">${fmt(o.amount)}</td><td>${esc(o.channel)}</td><td><span class="badge ${o.status}">${STATUS[o.status] || o.status}</span></td></tr>`).join('')
    || '<tr><td colspan="6" class="hint">Замовлень немає</td></tr>';
}

// ---------- Замовлення ----------
function renderOrders() {
  fillEmployeeSelect($('#fEmployee'), true);
  fillEmployeeSelect($('#importEmployee'), false);
  if (!$('#importDate').value) $('#importDate').value = today();
  const fPeriodSel = $('#fPeriod');
  const curPeriod = fPeriodSel.dataset.set ? fPeriodSel.value : '';
  fillPeriodSelect(fPeriodSel, curPeriod, 'Усі'); fPeriodSel.dataset.set = '1';
  const fStatus = $('#fStatus');
  if (fStatus.options.length === 1) fStatus.innerHTML += Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const emp = Number($('#fEmployee').value) || null, period = fPeriodSel.value, st = fStatus.value, q = $('#fSearch').value.trim().toLowerCase();
  const list = data.orders.filter((o) => (!emp || o.employeeId === emp) && (!period || monthOf(o.date) === period) && (!st || o.status === st)
    && (!q || (o.product || '').toLowerCase().includes(q) || (o.number || '').toLowerCase().includes(q)))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  $('#ordersTable tbody').innerHTML = list.slice(0, 2000).map((o) => `<tr data-id="${o.id}">
    <td><input type="checkbox" class="sel" data-id="${o.id}" ${state.selected.has(o.id) ? 'checked' : ''}></td>
    <td class="nowrap">${o.date}</td><td>${esc(empName(o.employeeId))}</td><td class="product"><div class="clip" title="${esc(o.product)}">${esc(o.product)}</div></td><td class="nowrap">${esc(o.number)}</td>
    <td class="num">${fmt(o.amount)}</td><td class="nowrap">${esc(o.channel)}</td><td><span class="badge ${o.status}">${STATUS[o.status] || o.status}</span></td>
    <td><button class="small secondary edit" data-id="${o.id}">Змінити</button></td></tr>`).join('')
    || '<tr><td colspan="9" class="hint">Замовлень немає. Імпортуйте таблицю або додайте вручну.</td></tr>';
  $('#ordersCount').textContent = `Показано ${Math.min(list.length, 2000)} з ${list.length} (усього в базі ${data.orders.length})`;
  const urlRec = (data.settings.sheetUrls || []).find((u) => u.employeeId === Number($('#importEmployee').value));
  if (urlRec && !$('#importUrl').value) $('#importUrl').value = urlRec.url;
}

function openOrderForm(order) {
  const f = $('#orderForm');
  fillEmployeeSelect(f.employeeId, false);
  f.status.innerHTML = Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const o = order || { id: '', employeeId: Number($('#fEmployee').value) || (data.employees[0] || {}).id, date: today(), product: '', number: '', amount: '', channel: '', status: 'ok' };
  $('#orderFormTitle').textContent = order ? 'Змінити замовлення' : 'Нове замовлення';
  f.id.value = o.id; f.employeeId.value = o.employeeId; f.date.value = o.date; f.product.value = o.product;
  f.number.value = o.number; f.amount.value = o.amount; f.channel.value = o.channel; f.status.value = o.status;
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
  renderApiStatus();
}

async function renderApiStatus() {
  const st = await window.api.apiStatus();
  const el = $('#apiStatus');
  if (st.running) { el.textContent = `Працює: ${st.url}`; el.className = 'status ok'; }
  else if (st.error) { el.textContent = `Не запустився: ${st.error}`; el.className = 'status err'; }
  else { el.textContent = 'Вимкнено'; el.className = 'status'; }
  const base = st.url || `http://${$('#apiHost').value || '127.0.0.1'}:${$('#apiPort').value || 8765}`;
  const token = (data.settings.api || {}).token;
  const auth = token ? ` -H "Authorization: Bearer ${token}"` : '';
  $('#apiExample').textContent = [
    `curl${auth} "${base}/api/salary?period=${monthOf(today())}"`,
    `curl${auth} -o зарплата.xlsx "${base}/api/export?format=xlsx&period=${monthOf(today())}"`,
    `curl${auth} -G --data-urlencode "employee=Настя" --data-urlencode "status=ok" "${base}/api/orders"`,
    `curl${auth} -X POST -H "Content-Type: application/json" "${base}/api/orders" \\`,
    `  -d '{"employee":"Настя","number":"20451500000000","amount":350,"status":"ok","channel":"Rozetka"}'`,
  ].join('\n');
  $('#apiRoutes tbody').innerHTML = (st.routes || []).map((r) => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('');
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
function renderAll() { renderSalary(); renderOrders(); renderEmployees(); renderSettings(); }

async function reload(d) { data = d || await window.api.getData(); renderAll(); }

function showTab(name) {
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
}

function bind() {
  document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // Зарплата
  $('#salaryPeriod').addEventListener('change', (e) => { state.salaryPeriod = e.target.value; renderSalary(); });
  $('#salaryTable tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const id = Number(tr.dataset.id);
    state.detailEmployee = state.detailEmployee === id ? null : id;
    renderSalary();
  });
  $('#exportXlsx').addEventListener('click', async () => { const p = await window.api.exportFile({ format: 'xlsx', period: state.salaryPeriod }); if (p) alert('Збережено: ' + p); });
  $('#exportCsv').addEventListener('click', async () => { const p = await window.api.exportFile({ format: 'csv', period: state.salaryPeriod }); if (p) alert('Збережено: ' + p); });

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
    const o = { id: f.id.value, employeeId: f.employeeId.value, date: f.date.value, product: f.product.value, number: f.number.value, amount: f.amount.value, channel: f.channel.value, status: f.status.value };
    $('#modal').classList.add('hidden');
    reload(await window.api.saveOrder(o));
  });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });

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
  $('#checkUpdate').addEventListener('click', async () => setUpdateStatus(await window.api.checkUpdate()));
  $('#installUpdate').addEventListener('click', () => window.api.installUpdate());
  $('#releasesLink').addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(info.releasesUrl); });
  $('#showDataFile').addEventListener('click', (e) => { e.preventDefault(); window.api.showDataFile(); });
  window.api.onUpdateStatus(setUpdateStatus);
}

(async function init() {
  info = await window.api.appInfo();
  $('#versionLabel').textContent = `v${info.version}${info.packaged ? '' : ' (розробка)'}`;
  bind();
  await reload();
})();
