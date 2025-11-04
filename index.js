// index.js
require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { Pool } = require('pg');
const fs = require('fs');

const config = {
  channelAccessToken: process.env.LINE_TOKEN,
  channelSecret: process.env.LINE_SECRET,
};
const line = new Client(config);

// ---------- PG (Neon) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// สร้างตารางครั้งแรก
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries(
      id SERIAL PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      type TEXT CHECK(type IN ('center','advance')) NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT,
      ts TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB ok');
})();

// ---------- Time helpers ----------
function dayRange(dateStr){
  const d0 = new Date(dateStr);
  const s = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 0,0,0);
  const e = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 23,59,59);
  return { start: s.toISOString(), end: e.toISOString() };
}
function monthRange(ym){
  const [y,m] = ym.split('-').map(Number);
  const s = new Date(y, m-1, 1, 0,0,0);
  const e = new Date(y, m, 0, 23,59,59);
  return { start: s.toISOString(), end: e.toISOString() };
}
function todayRange(){
  const d = new Date().toISOString().slice(0,10);
  return dayRange(d);
}
function dateMinusDays(days){
  const d = new Date();
  d.setDate(d.getDate() - days);
  return dayRange(d.toISOString().slice(0,10));
}
function allRange(){
  return { start: '1970-01-01T00:00:00.000Z', end: new Date().toISOString() };
}

// ---------- Parser ----------
function parseMessage(text){
  const t = text.trim();

  // กลาง / ส่วนตัว (ไม่ต้องเว้นวรรค)
  let m = t.match(/^กลาง\s*(\d+)\s*(.*)?$/i);
  if (m) return { type: 'center', amount: +m[1], note: m[2]?.trim() || '' };
  m = t.match(/^ส่วนตัว\s*(\d+)\s*(.*)?$/i);
  if (m) return { type: 'advance', amount: +m[1], note: m[2]?.trim() || '' };

  // ลบ / ยืนยันลบ
  m = t.match(/^ลบ\s*#(\d+)$/i);
  if (m) return { cmd: 'del', id: +m[1] };
  m = t.match(/^ยืนยัน\s*(\d+)$/i);
  if (m) return { cmd: 'confirmdel', id: +m[1] };

  // สรุป
  if (/^สรุปวันนี้$/i.test(t)) return { cmd: 'sum', scope: 'today' };
  m = t.match(/^สรุป\s+(\d{4}-\d{2}-\d{2})$/i);
  if (m) return { cmd: 'sum', scope: 'day', date: m[1] };
  m = t.match(/^สรุปเดือน\s+(\d{4}-\d{2})$/i);
  if (m) return { cmd: 'sum', scope: 'month', ym: m[1] };
  if (/^สรุปทั้งหมด$/i.test(t)) return { cmd: 'sum', scope: 'all' };
  m = t.match(/^สรุปย้อนหลัง\s*(\d+)\s*วัน$/i);
  if (m) return { cmd: 'sumPast', days: +m[1] };

  // ดูรายการ
  m = t.match(/^ดูรายการ\s+(\d{4}-\d{2}-\d{2})$/i);
  if (m) return { cmd: 'list', scope: 'day', date: m[1] };
  m = t.match(/^ดูรายการเดือน\s+(\d{4}-\d{2})$/i);
  if (m) return { cmd: 'list', scope: 'month', ym: m[1] };
  if (/^ดูรายการล่าสุด$/i.test(t)) return { cmd: 'recent' };

  // ยูทิลิตี้
  if (/^รีเซ็ตเดือนนี้$/i.test(t)) return { cmd: 'resetMonth' };
  if (/^backup$/i.test(t)) return { cmd: 'backup' };

  return null;
}

// ---------- DB helpers ----------
async function insertEntry(groupId, userId, type, amount, note){
  const r = await pool.query(
    `INSERT INTO entries (group_id,user_id,type,amount,note)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [groupId,userId,type,amount,note]
  );
  return r.rows[0].id;
}
async function deleteEntry(groupId, id){
  const r = await pool.query(`DELETE FROM entries WHERE id=$1 AND group_id=$2`, [id, groupId]);
  return r.rowCount > 0;
}
async function sumByRange(groupId, startISO, endISO){
  const r = await pool.query(
    `SELECT user_id, type, amount FROM entries
     WHERE group_id=$1 AND ts BETWEEN $2 AND $3`,
    [groupId, startISO, endISO]
  );
  const rows = r.rows;
  const center = rows.filter(x=>x.type==='center').reduce((a,b)=>a+b.amount,0);
  const per = {};
  for (const x of rows.filter(x=>x.type==='advance')) per[x.user_id]=(per[x.user_id]||0)+x.amount;

  const ids = Object.keys(per);
  const uA = ids[0] || null;
  const uB = ids[1] || null;
  const advanceA = uA ? per[uA] : 0;
  const advanceB = uB ? per[uB] : 0;
  const settle = (advanceA - advanceB) / 2; // >0 = B คืน A

  return { center, per, uA, uB, advanceA, advanceB, settle };
}
async function recentEntries(groupId){
  const r = await pool.query(
    `SELECT id,type,amount,note,to_char(ts,'YYYY-MM-DD HH24:MI') AS time
     FROM entries
     WHERE group_id=$1
     ORDER BY id DESC
     LIMIT 5`,
    [groupId]
  );
  return r.rows;
}
async function listEntriesByRange(groupId, startISO, endISO, limit = 50){
  const r = await pool.query(
    `SELECT id,user_id,type,amount,note,to_char(ts,'YYYY-MM-DD HH24:MI') AS time
     FROM entries
     WHERE group_id=$1 AND ts BETWEEN $2 AND $3
     ORDER BY ts ASC
     LIMIT $4`,
    [groupId, startISO, endISO, limit]
  );
  return r.rows;
}
async function resetMonth(groupId){
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth()+1, 0, 23,59,59);
  const r = await pool.query(
    `DELETE FROM entries WHERE group_id=$1 AND ts BETWEEN $2 AND $3`,
    [groupId, start.toISOString(), end.toISOString()]
  );
  return r.rowCount;
}
async function exportCSV(groupId){
  const r = await pool.query(
    `SELECT id,type,amount,note,to_char(ts,'YYYY-MM-DD HH24:MI') AS time
     FROM entries
     WHERE group_id=$1
     ORDER BY id`,
    [groupId]
  );
  const csv = "id,type,amount,note,time\n" +
    r.rows.map(x => `${x.id},${x.type},${x.amount},"${(x.note||'').replace(/"/g,'""')}",${x.time}`).join("\n");
  fs.writeFileSync("backup.csv", csv); // เก็บเป็นไฟล์ในเซิร์ฟเวอร์ (ดาวน์โหลดจาก logs/terminal ได้)
  return csv;
}

// ---------- name cache ----------
const nameCache = new Map();
async function getDisplayName(source, userId){
  if (nameCache.has(userId)) return nameCache.get(userId);
  try {
    let prof;
    if (source.type==='group' && source.groupId)
      prof = await line.getGroupMemberProfile(source.groupId, userId);
    else if (source.type==='room' && source.roomId)
      prof = await line.getRoomMemberProfile(source.roomId, userId);
    else
      prof = await line.getProfile(userId);
    const name = prof?.displayName || userId.slice(0,6);
    nameCache.set(userId, name);
    return name;
  } catch {
    const fb = userId.slice(0,6);
    nameCache.set(userId, fb);
    return fb;
  }
}
async function hydrateNamesForRows(source, rows){
  const uniq = [...new Set(rows.map(r=>r.user_id))];
  await Promise.all(uniq.map(uid => getDisplayName(source, uid)));
  return rows.map(r => ({ ...r, display: nameCache.get(r.user_id) || r.user_id.slice(0,6) }));
}

// ---------- app ----------
const app = express();
app.get('/', (_,res)=>res.send('ok'));

app.post('/webhook', middleware(config), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

async function handleEvent(event){
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const source = event.source;
  const gid = source.groupId || source.roomId || source.userId;
  const uid = source.userId;
  const p = parseMessage(event.message.text);

  if (!p) {
    return line.replyMessage(event.replyToken, { type:'text',
      text: 'ตัวอย่าง: "กลาง100 ค่าน้ำ", "ส่วนตัว120 กาแฟ", "สรุปวันนี้", "สรุป 2025-11-04", "สรุปเดือน 2025-11", "สรุปทั้งหมด", "สรุปย้อนหลัง3วัน", "ดูรายการ 2025-11-04", "ดูรายการเดือน 2025-11", "ดูรายการล่าสุด", "ลบ #123", "ยืนยัน123", "รีเซ็ตเดือนนี้", "backup"' });
  }

  // กลาง / ส่วนตัว (บันทึก)
  if (p.type) {
    const id = await insertEntry(gid, uid, p.type, p.amount, p.note);
    const name = await getDisplayName(source, uid);
    const label = p.type==='center' ? 'บัญชีกลาง' : 'ส่วนตัวออกก่อน';
    return line.replyMessage(event.replyToken, { type:'text',
      text: `บันทึกแล้ว #${id} · ${label} · ${p.amount} · ${p.note||'-'} (โดย ${name})` });
  }

  // ลบ / ยืนยันลบ
  if (p.cmd === 'del') {
    return line.replyMessage(event.replyToken, { type:'text',
      text: `ต้องการลบรายการ #${p.id} ใช่ไหม? (พิมพ์ ยืนยัน${p.id} เพื่อลบ)` });
  }
  if (p.cmd === 'confirmdel') {
    const ok = await deleteEntry(gid, p.id);
    return line.replyMessage(event.replyToken, { type:'text',
      text: ok ? `ลบรายการ #${p.id} แล้ว` : `ไม่พบรายการ #${p.id}` });
  }

  // สรุป (วันนี้/วัน/เดือน/ทั้งหมด/ย้อนหลังXวัน)
  if (p.cmd === 'sum' || p.cmd === 'sumPast') {
    let range;
    if (p.scope==='today') range = todayRange();
    else if (p.scope==='day') range = dayRange(p.date);
    else if (p.scope==='month') range = monthRange(p.ym);
    else if (p.scope==='all') range = allRange();
    else if (p.cmd==='sumPast') range = dateMinusDays(p.days);

    const { center, per, uA, uB, advanceA, advanceB, settle } =
      await sumByRange(gid, range.start, range.end);

    const nameA = uA ? await getDisplayName(source, uA) : 'A';
    const nameB = uB ? await getDisplayName(source, uB) : 'B';
    const whoPays =
      settle>0 ? `${nameB} ต้องคืน ${nameA} = ${Math.abs(settle)}`
    : settle<0 ? `${nameA} ต้องคืน ${nameB} = ${Math.abs(settle)}`
    : `ไม่ต้องคืนกัน`;

    const lines = Object.entries(per)
      .map(([id,sum]) => `• ${(nameCache.get(id) || id.slice(0,6))}: ${sum}`);
    const others = lines.length ? `\nรายการออกก่อนรวม:\n${lines.join('\n')}` : '';

    const header = (p.scope==='all') ? 'สรุปทั้งหมด' : 'สรุป';
    const text =
`${header}:
- กลางรวม: ${center}
- ออกก่อนของ ${nameA}: ${advanceA}
- ออกก่อนของ ${nameB}: ${advanceB}
- เคลียร์กัน: ${whoPays}${others}`;

    return line.replyMessage(event.replyToken, { type:'text', text });
  }

  // ดูรายการตามวัน/เดือน
  if (p.cmd === 'list') {
    const range = (p.scope==='day') ? dayRange(p.date) : monthRange(p.ym);
    const rows = await listEntriesByRange(gid, range.start, range.end);
    if (!rows.length) {
      return line.replyMessage(event.replyToken, { type:'text', text:'ไม่พบรายการในช่วงนี้' });
    }
    const withNames = await hydrateNamesForRows(source, rows);
    const text = withNames
      .map(r => `#${r.id} ${r.type==='center'?'กลาง':'ส่วนตัว'} ${r.amount} ${r.note||''} (${r.time} · โดย ${r.display})`)
      .join('\n');
    return line.replyMessage(event.replyToken, { type:'text', text });
  }

  // ดูรายการล่าสุด
  if (p.cmd === 'recent') {
    const rows = await recentEntries(gid);
    if (!rows.length) return line.replyMessage(event.replyToken, { type:'text', text:'ยังไม่มีรายการ' });
    const text = rows
      .map(r=>`#${r.id} ${r.type==='center'?'กลาง':'ส่วนตัว'} ${r.amount} ${r.note||''} (${r.time})`)
      .join('\n');
    return line.replyMessage(event.replyToken, { type:'text', text });
  }

  // รีเซ็ตเดือนนี้
  if (p.cmd === 'resetMonth') {
    const count = await resetMonth(gid);
    return line.replyMessage(event.replyToken, { type:'text', text:`ล้างข้อมูลเดือนนี้ ${count} รายการแล้ว` });
  }

  // สำรองข้อมูล (preview 10 บรรทัดแรก)
  if (p.cmd === 'backup') {
    const csv = await exportCSV(gid);
    const preview = csv.split('\n').slice(0, 11).join('\n'); // header + 10 rows
    const text = preview + '\n...(บันทึกไฟล์ชื่อ backup.csv บนเซิร์ฟเวอร์แล้ว)';
    return line.replyMessage(event.replyToken, { type:'text', text });
  }
}

// ---------- start server ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

// กัน container หลับ (Railway free)
setInterval(() => console.log('Bot alive', new Date().toISOString()), 60_000);
