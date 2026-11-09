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
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

// Злиття доданих замовлень у наявні: ключ — працівник + номер.
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

// Деталь статусу для таблиці: що саме сказав перевізник (Нова Пошта, Rozetka Delivery), інакше —
// статус у кабінеті маркетплейсу. Довгі фрази НП скорочуються.
const NP_SHORT = { 1: 'Створено, ще не відправлено', 2: 'Накладну видалено', 3: 'Номер не знайдено' };
function statusDetail(track) {
  if (!track) return '';
  const np = track.np, rd = track.rd, mp = track.mp;
  if (np && np.status && np.code !== '3') return `Нова Пошта: ${NP_SHORT[np.code] || np.status}${np.received ? ` (${np.received})` : ''}`;
  if (rd && rd.status && !/^HTTP|з’єднання|не знайдено/.test(rd.status)) return `Rozetka Delivery: ${rd.status}${rd.date ? ` (${rd.date})` : ''}`;
  if (mp && mp.status) return `${mp.channel || mp.kind}: ${mp.status}`;
  if (rd && rd.status) return `Rozetka Delivery: ${rd.status}`;
  if (np && np.status) return `Нова Пошта: ${np.status}`;
  return '';
}

// Два набори замовлень: 'auto' — веде програма (кабінети маркетплейсів), 'manual' — з таблиці або вставки.
const SOURCE = { auto: 'Авто (кабінети)', manual: 'Таблиця (вручну)' };

// period: 'YYYY-MM' або '' (увесь час); source: 'auto' | 'manual' | '' (обидва). Повертає рядок на кожного працівника.
function calcSalary(data, period, source) {
  const rate = Number(data.settings.ratePercent) || 0;
  const rows = [];
  for (const e of data.employees) {
    const r = e.ratePercent == null || e.ratePercent === '' ? rate : Number(e.ratePercent);
    const orders = data.orders.filter((o) => o.employeeId === e.id && (!period || monthOf(o.date) === period) && (!source || o.source === source));
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
  SOURCE, statusDetail, toCsv, mergeOrders,
  calcSalary, monthOf, round2, buildXlsx, crc32,
};
