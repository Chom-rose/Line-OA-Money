require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { Pool } = require('pg');

// ---------- LINE config ----------
const lineCfg = {
  channelAccessToken: process.env.LINE_TOKEN,
  channelSecret: process.env.LINE_SECRET,
};
const line = new Client(lineCfg);

// ---------- DB (Postgres / Neon) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries(
      id SERIAL PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      type     TEXT CHECK(type IN ('center','advance')) NOT NULL,
      amount   INTEGER NOT NULL,
      note     TEXT,
      ts       TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB ready');
})().catch(console.error);

// ---------- Name cache ----------
const nameCache = new Map();
async function getDisplayName(source, userId) {
  if (nameCache.has(userId)) return nameCache.get(userId);
  try {
    let prof;
    if (source.groupId) prof = await line.getGroupMemberProfile(source.groupId, userId);
    else if (source.roomId) prof = await line.getRoomMemberProfile(source.roomId, userId);
    else prof = await line.getProfile(userId);
    const name = prof?.displayName || userId.slice(0, 6);
    nameCache.set(userId, name);
    return name;
  } catch {
    const fb = userId.slice(0, 6);
    nameCache.set(userId, fb);
    return fb;
  }
}

// ---------- Parse ----------
function normalizeNum(s) {
  // 1,234 -> 1234
  return s.replace(/[, ]/g, '');
}

function parse(text) {
  const t = text.trim();

  // เพิ่มรายการ: กลาง/ส่วนตัว รองรับติดกันหรือมีช่องว่าง
  // กลาง100โน้ต  | กลาง 100 โน้ต
  let m = t.match(/^กลาง\s*([0-9][0-9,]*)\s*(.*)$/i);
  if (m) return { kind: 'add', type: 'center', amount: +normalizeNum(m[1]), note: (m[2] || '').trim() };

  // ส่วนตัว100อาหาร | ส่วนตัว 100 อาหาร | ส่วนตัว100 7
  m = t.match(/^ส่วนตัว\s*([0-9][0-9,]*)\s*(.*)$/i);
  if (m) return { kind: 'add', type: 'advance', amount: +normalizeNum(m[1]), note: (m[2] || '').trim() };

  // ลบ #123
  m = t.match(/^ลบ\s*#?(\d+)$/i);
  if (m) return { kind: 'delete_req', id: +m[1] };

  // ยืนยัน123
  m = t.match(/^ยืนยัน\s*#?(\d+)$/i);
  if (m) return { kind: 'delete_confirm', id: +m[1] };

  // สรุปวันนี้
  if (/^สรุปวันนี้$/i.test(t)) return { kind: 'sum', mode: 'today' };

  // สรุปย้อนหลัง3วัน
  m = t.match(/^สรุปย้อนหลัง\s*(\d+)\s*วัน$/i);
  if (m) return { kind: 'sum', mode: 'lastNDays', days: +m[1] };

  // สรุป YYYY-MM-DD
  m = t.match(/^สรุป\s*(\d{4}-\d{2}-\d{2})$/i);
  if (m) return { kind: 'sum', mode: 'day', date: m[1] };

  // สรุปเดือน YYYY-MM
  m = t.match(/^สรุปเดือน\s*(\d{4}-\d{2})$/i);
  if (m) return { kind: 'sum', mode: 'month', ym: m[1] };

  // สรุปทั้งหมด
  if (/^สรุปทั้งหมด$/i.test(t)) return { kind: 'sum', mode: 'all' };

  // ดูรายการ YYYY-MM-DD
  m = t.match(/^ดูรายการ\s*(\d{4}-\d{2}-\d{2})$/i);
  if (m) return { kind: 'list', mode: 'day', date: m[1] };

  // ดูรายการเดือน YYYY-MM
  m = t.match(/^ดูรายการเดือน\s*(\d{4}-\d{2})$/i);
  if (m) return { kind: 'list', mode: 'month', ym: m[1] };

  // ดูรายการล่าสุด
  if (/^ดูรายการล่าสุด$/i.test(t)) return { kind: 'list', mode: 'last' };

  return { kind: 'help' };
}

// ---------- Date ranges ----------
function dayRange(dateStr) {
  const d0 = dateStr ? new Date(dateStr) : new Date();
  const s = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 0, 0, 0);
  const e = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 23, 59, 59);
  return { start: s, end: e };
}

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const s = new Date(y, m - 1, 1, 0, 0, 0);
  const e = new Date(y, m, 0, 23, 59, 59);
  return { start: s, end: e };
}

function lastNDaysRange(n) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (n - 1));
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

// ---------- DB helpers ----------
async function insertEntry(groupId, userId, type, amount, note) {
  const r = await pool.query(
    `INSERT INTO entries (group_id,user_id,type,amount,note) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [groupId, userId, type, amount, note]
  );
  return r.rows[0].id;
}

async function deleteEntry(groupId, id) {
  const r = await pool.query(`DELETE FROM entries WHERE id=$1 AND group_id=$2`, [id, groupId]);
  return r.rowCount > 0;
}

async function queryRange(groupId, start, end) {
  const r = await pool.query(
    `SELECT id, user_id, type, amount, note, ts
     FROM entries
     WHERE group_id=$1 AND ts BETWEEN $2 AND $3
     ORDER BY ts ASC`,
    [groupId, start.toISOString(), end.toISOString()]
  );
  return r.rows;
}

// ---------- pending delete ----------
const pendingDelete = new Map(); // key: groupId:userId -> id

// ---------- App ----------
const app = express();
app.get('/', (_, res) => res.send('ok'));
app.post('/webhook', middleware(lineCfg), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

async function handleEvent(ev) {
  if (ev.type !== 'message' || ev.message.type !== 'text') return;

  const src = ev.source;
  const gid = src.groupId || src.roomId || src.userId;
  const uid = src.userId;

  const cmd = parse(ev.message.text);

  // Help text (จัดให้อ่านง่าย)
  if (cmd.kind === 'help') {
    const help =
`🧾 วิธีใช้ (พิมพ์ติดกันหรือเว้นวรรคก็ได้)
• บันทึก: 
  - กลาง100 ค่าน้ำ
  - ส่วนตัว120 กาแฟ / ส่วนตัว120 7
• ลบรายการ:
  - ลบ #123  → ระบบจะขอยืนยัน
  - ยืนยัน123
• สรุป:
  - สรุปวันนี้
  - สรุป 2025-11-04
  - สรุปเดือน 2025-11
  - สรุปย้อนหลัง3วัน
  - สรุปทั้งหมด
• ดูรายการ:
  - ดูรายการ 2025-11-04
  - ดูรายการเดือน 2025-11
  - ดูรายการล่าสุด`;
    return line.replyMessage(ev.replyToken, { type: 'text', text: help });
  }

  // Add entry
  if (cmd.kind === 'add') {
    const id = await insertEntry(gid, uid, cmd.type, cmd.amount, cmd.note || '');
    const label = cmd.type === 'center' ? 'บัญชีกลาง' : 'ส่วนตัว';
    const txt = `บันทึกแล้ว #${id} · ${label} · ${cmd.amount} · ${cmd.note || '-'}`;
    return line.replyMessage(ev.replyToken, { type: 'text', text: txt });
  }

  // Delete request
  if (cmd.kind === 'delete_req') {
    pendingDelete.set(`${gid}:${uid}`, cmd.id);
    const txt = `จะลบ #${cmd.id} ? พิมพ์ "ยืนยัน${cmd.id}" ภายใน 2 นาที`;
    return line.replyMessage(ev.replyToken, { type: 'text', text: txt });
  }

  // Delete confirm
  if (cmd.kind === 'delete_confirm') {
    const key = `${gid}:${uid}`;
    const want = pendingDelete.get(key);
    if (want !== cmd.id) {
      return line.replyMessage(ev.replyToken, { type: 'text', text: 'ไม่พบคำขอลบ หรือเลขไม่ตรง' });
    }
    pendingDelete.delete(key);
    const ok = await deleteEntry(gid, cmd.id);
    return line.replyMessage(ev.replyToken, { type: 'text', text: ok ? `ลบ #${cmd.id} แล้ว` : `ไม่พบ #${cmd.id}` });
  }

  // Sum
  if (cmd.kind === 'sum') {
    let range, title;
    if (cmd.mode === 'today') { range = dayRange(); title = 'วันนี้'; }
    else if (cmd.mode === 'day') { range = dayRange(cmd.date); title = cmd.date; }
    else if (cmd.mode === 'month') { range = monthRange(cmd.ym); title = `เดือน ${cmd.ym}`; }
    else if (cmd.mode === 'lastNDays') { range = lastNDaysRange(cmd.days); title = `ย้อนหลัง ${cmd.days} วัน`; }
    else { // all
      const r = await pool.query(
        `SELECT MIN(ts) AS min, MAX(ts) AS max FROM entries WHERE group_id=$1`,
        [gid]
      );
      if (!r.rows[0].min) {
        return line.replyMessage(ev.replyToken, { type: 'text', text: 'ยังไม่มีข้อมูล' });
      }
      range = { start: new Date(r.rows[0].min), end: new Date(r.rows[0].max) };
      title = 'ทั้งหมด';
    }

    const rows = await queryRange(gid, range.start, range.end);

    const center = rows.filter(x => x.type === 'center')
                       .reduce((a, b) => a + b.amount, 0);

    const per = {};
    for (const x of rows.filter(x => x.type === 'advance')) {
      per[x.user_id] = (per[x.user_id] || 0) + x.amount;
    }
    const perEntries = Object.entries(per);

    const sumAdvance = perEntries.reduce((a, [, v]) => a + v, 0);
    const total = center + sumAdvance;

    const perLines = perEntries.length
      ? await Promise.all(perEntries.map(async ([id, amt]) => {
          const nm = await getDisplayName(src, id);
          return `• ${nm}: ${amt}`;
        }))
      : ['-'];

    const text =
`📊 สรุปช่วง ${title}
กลางรวม: ${center}
รวมส่วนตัว: ${sumAdvance}
รวมทั้งหมด: ${total}

ออกก่อนรายคน:
${perLines.join('\n')}`;

    return line.replyMessage(ev.replyToken, { type: 'text', text });
  }

  // List
  if (cmd.kind === 'list') {
    let range, title;
    if (cmd.mode === 'day') { range = dayRange(cmd.date); title = cmd.date; }
    else if (cmd.mode === 'month') { range = monthRange(cmd.ym); title = `เดือน ${cmd.ym}`; }
    else { // last
      const r = await pool.query(
        `SELECT * FROM entries WHERE group_id=$1 ORDER BY ts DESC LIMIT 10`,
        [gid]
      );
      if (r.rows.length === 0) {
        return line.replyMessage(ev.replyToken, { type: 'text', text: 'ยังไม่มีรายการ' });
      }
      const lines = await Promise.all(r.rows.map(async (x) => {
        const nm = await getDisplayName(src, x.user_id);
        const tag = x.type === 'center' ? 'กลาง' : 'ส่วนตัว';
        const d = new Date(x.ts).toISOString().replace('T', ' ').slice(0, 16);
        return `#${x.id} • ${d}\n- ${tag} ${x.amount} • ${nm} • ${x.note || '-'}`;
      }));
      return line.replyMessage(ev.replyToken, { type: 'text', text: `🧾 รายการล่าสุด (10 รายการ)\n\n${lines.join('\n\n')}` });
    }

    const rows = await queryRange(gid, range.start, range.end);
    if (rows.length === 0) return line.replyMessage(ev.replyToken, { type: 'text', text: 'ไม่พบรายการ' });

    const lines = await Promise.all(rows.map(async (x) => {
      const nm = await getDisplayName(src, x.user_id);
      const tag = x.type === 'center' ? 'กลาง' : 'ส่วนตัว';
      const d = new Date(x.ts).toISOString().replace('T', ' ').slice(0, 16);
      return `#${x.id} • ${d}\n- ${tag} ${x.amount} • ${nm} • ${x.note || '-'}`;
    }));

    return line.replyMessage(ev.replyToken, {
      type: 'text',
      text: `🧾 รายการช่วง ${title}\n\n${lines.join('\n\n')}`
    });
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('listening on', port));
