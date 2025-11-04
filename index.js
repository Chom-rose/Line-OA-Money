require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { Pool } = require('pg');

/* ---------- LINE config ---------- */
const lineConfig = {
  channelAccessToken: process.env.LINE_TOKEN,
  channelSecret: process.env.LINE_SECRET,
};
const line = new Client(lineConfig);

/* ---------- Postgres (Neon / Railway) ---------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// สร้างตารางถ้ายังไม่มี
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
  console.log('✅ Database ready');
})().catch(console.error);

/* ---------- Helpers: time & format ---------- */
function pad(n) { return n.toString().padStart(2, '0'); }

function dayRange(dateStr){
  const d = new Date(dateStr);
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0);
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23,59,59);
  return { start: s.toISOString(), end: e.toISOString(), label: dateStr };
}
function monthRange(ym){
  const [y,m] = ym.split('-').map(Number);
  const s = new Date(y, m-1, 1, 0,0,0);
  const e = new Date(y, m,   0, 23,59,59);
  return { start: s.toISOString(), end: e.toISOString(), label: `เดือน ${ym}` };
}
function todayRange(){
  const d = new Date();
  const ds = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  return dayRange(ds);
}
function toYMDHM(ts){
  const d = new Date(ts);
  const y  = d.getFullYear();
  const m  = pad(d.getMonth()+1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return { ym: `${y}-${m}`, ymdhm: `${y}-${m}-${dd} ${hh}:${mm}` };
}
function splitChunks(str, size = 1800){
  const out = [];
  for (let i=0; i<str.length; i+=size) out.push(str.slice(i, i+size));
  return out;
}

/* ---------- Parse user input ---------- */
function parseMessage(text){
  const t = text.trim();

  // บันทึก: กลาง/ส่วนตัว (ไม่ต้องเว้นวรรคก็ได้)
  let m = t.match(/^(กลาง|ส่วนตัว)\s*([0-9]+)\s*(.*)?$/i);
  if (m) {
    return {
      type: m[1] === 'กลาง' ? 'center' : 'advance',
      amount: +m[2],
      note: (m[3] || '').trim(),
    };
  }

  // ลบรายการ
  m = t.match(/^ลบ\s*#?(\d+)$/i);
  if (m) return { cmd:'del', id:+m[1] };

  // สรุป (ช่วงเวลา)
  if (/^สรุปวันนี้$/i.test(t)) return { cmd:'sum', scope:'today' };
  m = t.match(/^สรุป\s+(\d{4}-\d{2}-\d{2})$/i);
  if (m) return { cmd:'sum', scope:'day',   date:m[1] };
  m = t.match(/^สรุปเดือน\s+(\d{4}-\d{2})$/i);
  if (m) return { cmd:'sum', scope:'month', ym:m[1] };

  // สรุปทั้งหมด (ทุกเดือน)
  if (/^สรุปทั้งหมด$/i.test(t)) return { cmd:'sum_all' };

  // ดูรายการทั้งหมด (ใส่จำนวนได้ เช่น ดูรายการทั้งหมด 500)
  m = t.match(/^ดูรายการทั้งหมด(?:\s*(\d+))?$/i);
  if (m) return { cmd:'list_all', limit: m[1] ? +m[1] : 300 };

  return null;
}

/* ---------- Aggregation & DB helpers ---------- */
function aggregate(rows){
  const center = rows.filter(r=>r.type==='center')
                     .reduce((a,b)=>a + b.amount, 0);
  const per = {};
  for (const r of rows) if (r.type==='advance')
    per[r.user_id] = (per[r.user_id]||0) + r.amount;
  const advanceSum = Object.values(per).reduce((a,b)=>a+b, 0);
  return { center, per, advanceSum, total: center + advanceSum };
}

async function sumByRange(groupId, startISO, endISO){
  const r = await pool.query(
    `SELECT user_id, type, amount
       FROM entries
      WHERE group_id=$1 AND ts BETWEEN $2 AND $3`,
    [groupId, startISO, endISO]
  );
  return aggregate(r.rows);
}
async function sumAll(groupId){
  const r = await pool.query(
    `SELECT user_id, type, amount
       FROM entries
      WHERE group_id=$1`,
    [groupId]
  );
  return aggregate(r.rows);
}
async function listAllEntries(groupId, limit = 300){
  const r = await pool.query(
    `SELECT id, user_id, type, amount, note, ts
       FROM entries
      WHERE group_id=$1
      ORDER BY ts ASC
      LIMIT $2`,
    [groupId, limit]
  );
  return r.rows;
}

/* ---------- Name cache ---------- */
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
async function hydrateNames(rows, source){
  const uniq = [...new Set(rows.map(r=>r.user_id))];
  await Promise.all(uniq.map(uid => getDisplayName(source, uid)));
  return rows.map(r => ({ ...r, display: nameCache.get(r.user_id) || r.user_id.slice(0,6) }));
}
function groupByMonth(rows){
  // { 'YYYY-MM': [rows...] }
  const bucket = {};
  for (const r of rows) {
    const { ym } = toYMDHM(r.ts);
    if (!bucket[ym]) bucket[ym] = [];
    bucket[ym].push(r);
  }
  return bucket;
}

/* ---------- Express app ---------- */
const app = express();
app.get('/', (_,res)=>res.send('ok'));
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

async function handleEvent(event){
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const source = event.source;
  const gid = source.groupId || source.roomId || source.userId;
  const uid = source.userId;
  const p = parseMessage(event.message.text);

  // 🧾 Help text
  if (!p) {
    const help = [
      '📒 คู่มือจดเงินแบบเร็ว',
      '',
      '➕ บันทึก',
      '• กลาง100 ค่าน้ำ',
      '• ส่วนตัว120 กาแฟ',
      '• กลาง1507  (ได้ ไม่ต้องมีเว้นวรรค)',
      '• ส่วนตัว100อาหาร  (ได้เช่นกัน)',
      '',
      '📊 สรุป',
      '• สรุปวันนี้',
      '• สรุป 2025-11-04',
      '• สรุปเดือน 2025-11',
      '• สรุปทั้งหมด (รวมทุกเดือน)',
      '',
      '🧾 รายการ',
      '• ดูรายการทั้งหมด  (เช่น ดูรายการทั้งหมด 500)',
      '',
      '🧹 จัดการ',
      '• ลบ #123'
    ].join('\n');
    return line.replyMessage(event.replyToken, { type:'text', text: help });
  }

  // ➕ บันทึก
  if (p.type) {
    const r = await pool.query(
      `INSERT INTO entries (group_id,user_id,type,amount,note)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [gid, uid, p.type, p.amount, p.note]
    );
    const id = r.rows[0].id;
    const label = p.type === 'center' ? 'บัญชีกลาง' : 'ส่วนตัวออกก่อน';
    return line.replyMessage(event.replyToken, {
      type:'text',
      text:`บันทึกแล้ว #${id} · ${label} · ${p.amount} · ${p.note||'-'}`
    });
  }

  // 🗑️ ลบ
  if (p.cmd === 'del') {
    const r = await pool.query(
      `DELETE FROM entries WHERE id=$1 AND group_id=$2`,
      [p.id, gid]
    );
    const ok = r.rowCount > 0;
    return line.replyMessage(event.replyToken, {
      type:'text',
      text: ok ? `ลบรายการ #${p.id} แล้ว` : `ไม่พบรายการ #${p.id}`
    });
  }

  // 📊 สรุปช่วงเวลา (วันนี้/วัน/เดือน)
  if (p.cmd === 'sum') {
    let range;
    if (p.scope==='today') range = todayRange();
    else if (p.scope==='day') range = dayRange(p.date);
    else range = monthRange(p.ym);

    const { center, per, advanceSum, total } =
      await sumByRange(gid, range.start, range.end);

    const lines = [];
    for (const [id,sum] of Object.entries(per)) {
      const name = await getDisplayName(source, id);
      lines.push(`• ${name}: ${sum}`);
    }

    const text =
`📊 สรุปช่วง ${range.label}
กลางรวม: ${center}
รวมส่วนตัว: ${advanceSum}
รวมทั้งหมด: ${total}

ออกก่อนรายคน:
${lines.length ? lines.join('\n') : '• -'}`;

    return line.replyMessage(event.replyToken, { type:'text', text });
  }

  // 📊 สรุปทั้งหมด (ทุกเดือน ทุกปี)
  if (p.cmd === 'sum_all') {
    const { center, per, advanceSum, total } = await sumAll(gid);

    const lines = [];
    for (const [id,sum] of Object.entries(per)) {
      const name = await getDisplayName(source, id);
      lines.push(`• ${name}: ${sum}`);
    }

    const text =
`📊 สรุปช่วง ทั้งหมด
กลางรวม: ${center}
รวมส่วนตัว: ${advanceSum}
รวมทั้งหมด: ${total}

ออกก่อนรายคน:
${lines.length ? lines.join('\n') : '• -'}`;

    return line.replyMessage(event.replyToken, { type:'text', text });
  }

  // 🧾 ดูรายการทั้งหมด (กลุ่มรายเดือน + วันเวลา)
  if (p.cmd === 'list_all') {
    const limit = Math.max(1, Math.min(p.limit || 300, 2000)); // กันไม่ให้ดึงหนักเกิน
    const rows = await listAllEntries(gid, limit);
    if (!rows.length) {
      return line.replyMessage(event.replyToken, { type:'text', text:'ยังไม่มีรายการ' });
    }

    const withNames = await hydrateNames(rows, source);
    const grouped   = groupByMonth(withNames);

    const months = Object.keys(grouped).sort(); // เก่า → ใหม่
    let text = '🧾 ดูรายการทั้งหมด (สูงสุด ' + limit + ' รายการ)\n';

    for (const ym of months) {
      text += `\n📅 ${ym}\n`;
      for (const r of grouped[ym]) {
        const { ymdhm } = toYMDHM(r.ts);
        const tag = r.type === 'center' ? 'กลาง' : 'ส่วนตัว';
        text += `- ${ymdhm} · #${r.id} · ${tag} ${r.amount} · ${r.display} · ${r.note || '-'}\n`;
      }
    }

    // LINE จำกัดความยาวข้อความ → แบ่งเป็นหลายชิ้น (สูงสุด 5 ข้อความใน reply เดียว)
    const chunks = splitChunks(text, 1800).slice(0, 5);
    const messages = chunks.map(c => ({ type:'text', text:c }));
    return line.replyMessage(event.replyToken, messages);
  }
}

/* ---------- Start Server ---------- */
// แนะนำตั้ง ENV บน Railway/Server: TZ=Asia/Bangkok เพื่อเวลาถูกต้องตามไทย
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 listening on', PORT));
