'use strict';
// Чиста логіка без Electron: розбір CSV, зіставлення рядків таблиці,
// розрахунок зарплати, запис XLSX. Тестується `npm test`.

const zlib = require('zlib');

// ---------- Статуси ----------
const STATUS = {
  ok: 'Виконано',
  refused: 'Відмова',
  cancelled: 'Скасовано',
  nodata: 'Немає даних',
  checking: 'Перевіряється',
};

// Працівники зі списку-валідації у стовпці B поточних таблиць.
const DEFAULT_EMPLOYEES = ['Горбенко', 'Левченко', 'Товкес', 'Гаєвська', 'Настя', 'Корнійчук'];

// ---------- CSV ----------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

// ---------- Google Таблиці ----------
// Посилання на таблицю -> адреса експорту CSV (без входу, якщо доступ «усім за посиланням»).
function sheetExportUrl(url) {
  const m = /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(url || '');
  if (!m) return null;
  const gid = /[?#&]gid=(\d+)/.exec(url);
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv` + (gid ? `&gid=${gid[1]}` : '');
}

function parseAmount(v) {
  if (v == null) return null;
  const s = String(v).replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100) / 100;
}

function statusFromText(t, d) {
  const s = (t || '').trim();
  const dd = (d || '').trim().toUpperCase();
  if (/^ОК/i.test(s)) return 'ok';
  if (/ОТКАЗ|ВІДМОВ|ВОЗВРАТ|ПОВЕРН/i.test(s) || dd === 'ОТКАЗ' || dd === 'ВОЗВРАТ') return 'refused';
  if (/ОТМЕНА|СКАСОВ/i.test(s) || dd === 'ОТМЕНА') return 'cancelled';
  if (/не найден|не знайден/i.test(s) || dd === 'НЕТ ДАННЫХ') return 'nodata';
  return 'checking';
}

// Рядок аркуша «Лист2» (без заголовків):
// B товар, C номер ТТН/замовлення, D сума або ОТКАЗ/ОТМЕНА/НЕТ ДАННЫХ,
// G/I/K/M суми НП/Rozetka/Prom/Епіцентр, Q/R/S канал, T підсумковий статус.
function mapSheetRow(cols, opts) {
  const col = (i) => (cols[i] == null ? '' : String(cols[i]).trim());
  // Простий аркуш «номер + сума» (як «Лист 1 мама»): A номер, B сума, далі порожньо.
  if (col(0) && parseAmount(col(1)) != null && !cols.slice(2).some((c) => c != null && String(c).trim())) {
    const a = col(0);
    if (!/\d{6,}/.test(a)) return null; // рядок-заголовок
    const isRozetka = /розетка|rozetka/i.test(a);
    return {
      employeeId: opts.employeeId,
      product: '',
      number: a.replace(/розетка|rozetka/ig, '').replace(/\s+/g, ' ').trim(),
      amount: parseAmount(col(1)),
      channel: isRozetka ? 'Rozetka' : '',
      status: STATUS[opts.defaultStatus] ? opts.defaultStatus : 'ok',
      date: opts.date,
    };
  }
  const product = col(1);
  const number = col(2).replace(/\s+/g, ' ');
  const d = col(3);
  if (!product && !number) return null;
  let amount = parseAmount(d);
  if (amount == null) {
    for (const i of [10, 8, 12, 6]) { // K Prom, I Rozetka, M Епіцентр, G НП
      const a = parseAmount(col(i));
      if (a) { amount = a; break; }
    }
  }
  const channel = col(16) || col(17) || col(18) || '';
  const status = statusFromText(col(19), d);
  return {
    employeeId: opts.employeeId,
    product,
    number,
    amount: amount == null ? 0 : amount,
    channel,
    status,
    date: opts.date,
  };
}

function importRows(rows, opts) {
  const out = [];
  for (const r of rows) {
    const o = mapSheetRow(r, opts);
    if (o) out.push(o);
  }
  return out;
}

// Злиття імпортованих замовлень у наявні: ключ — працівник + номер.
// Повертає {added, updated, orders}. Статус/суму оновлює, дату й товар лишає.
function mergeOrders(existing, incoming, nextId) {
  const byKey = new Map();
  for (const o of existing) if (o.number) byKey.set(o.employeeId + '|' + o.number, o);
  let added = 0, updated = 0;
  const orders = existing.slice();
  for (const inc of incoming) {
    const key = inc.employeeId + '|' + inc.number;
    const cur = inc.number ? byKey.get(key) : null;
    if (cur) {
      if (cur.status !== inc.status || cur.amount !== inc.amount || cur.channel !== inc.channel) {
        cur.status = inc.status; cur.amount = inc.amount; cur.channel = inc.channel; updated++;
      }
    } else {
      const o = Object.assign({}, inc, { id: nextId() });
      orders.push(o);
      if (o.number) byKey.set(key, o);
      added++;
    }
  }
  return { added, updated, orders };
}

// ---------- Розрахунок ----------
function monthOf(date) { return (date || '').slice(0, 7); }

// period: 'YYYY-MM' або '' (увесь час). Повертає рядок на кожного працівника.
function calcSalary(data, period) {
  const rate = Number(data.settings.ratePercent) || 0;
  const rows = [];
  for (const e of data.employees) {
    const r = e.ratePercent == null || e.ratePercent === '' ? rate : Number(e.ratePercent);
    const orders = data.orders.filter((o) => o.employeeId === e.id && (!period || monthOf(o.date) === period));
    const done = orders.filter((o) => o.status === 'ok');
    const sumDone = round2(done.reduce((s, o) => s + (Number(o.amount) || 0), 0));
    rows.push({
      employeeId: e.id,
      name: e.name,
      ratePercent: r,
      total: orders.length,
      done: done.length,
      refused: orders.filter((o) => o.status === 'refused').length,
      cancelled: orders.filter((o) => o.status === 'cancelled').length,
      nodata: orders.filter((o) => o.status === 'nodata').length,
      checking: orders.filter((o) => o.status === 'checking').length,
      sumDone,
      salary: round2(sumDone * r / 100),
    });
  }
  return rows;
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---------- XLSX (мінімальний zip + SpreadsheetML, без бібліотек) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) { // files: [{name, data(Buffer)}]
  const parts = [], central = [];
  let offset = 0;
  const dosTime = 0, dosDate = (1 << 5) | 1 | ((2024 - 1980) << 9);
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(8, 10); cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, end]);
}

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(i) {
  let s = '';
  i++;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

// sheets: [{name, rows: [[...]]}]; числа пишуться числами, решта — текстом; перший рядок жирний.
function buildXlsx(sheets) {
  const files = [];
  const sheetXml = (rows) => {
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    rows.forEach((r, ri) => {
      x += `<row r="${ri + 1}">`;
      r.forEach((v, ci) => {
        if (v == null || v === '') return;
        const ref = colName(ci) + (ri + 1);
        const st = ri === 0 ? ' s="1"' : '';
        if (typeof v === 'number') x += `<c r="${ref}"${st}><v>${v}</v></c>`;
        else x += `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
      });
      x += '</row>';
    });
    return x + '</sheetData></worksheet>';
  };
  files.push({ name: '[Content_Types].xml', data:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '</Types>' });
  files.push({ name: '_rels/.rels', data:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>' });
  files.push({ name: 'xl/workbook.xml', data:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((s, i) => `<sheet name="${xmlEsc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>' });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>' });
  files.push({ name: 'xl/styles.xml', data:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>' });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) }));
  return zip(files);
}

module.exports = {
  STATUS, DEFAULT_EMPLOYEES,
  parseCsv, toCsv, sheetExportUrl, parseAmount, statusFromText, mapSheetRow, importRows, mergeOrders,
  calcSalary, monthOf, round2, buildXlsx, crc32,
};
