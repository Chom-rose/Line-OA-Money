require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { Pool } = require('pg');

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

pool.query('select 1').then(()=>console.log('DB ok')).catch(console.error);


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
})();

// ---------- parsers ----------
function parseMessage(text){
  const t = text.trim();
  let m = t.match(/^(กลาง)\s+(\d+)(?:\s+(.+))?$/i);
  if (m) return { type: 'center', amount: +m[2], note: m[3] || '' };
  m = t.match(/^(ส่วนตัว)\s+(\d+)(?:\s+(.+))?$/i);
  if (m) return { type: 'advance', amount: +m[2], note: m[3] || '' };
  if (/^สรุปวันนี้$/i.test(t)) return { cmd: 'sum', scope: 'today' };
  m = t.match(/^สรุป\s+(\d{4}-\d{2}-\d{2})$/i);
  if (m) return { cmd: 'sum', scope: 'day', date: m[1] };
  m = t.match(/^สรุปเดือน\s+(\d{4}-\d{2})$/i);
  if (m) return { cmd: 'sum', scope: 'month', ym: m[1] };
  m = t.match(/^ลบ\s+#(\d+)$/i);
  if (m) return { cmd: 'del', id: +m[1] };
  return null;
}
function dayRange(dateStr){
  const d0 = new Date(dateStr);
  const s = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 0,0,0);
  const e = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 23,59,59);
  return { start: s.toISOString(), end: e.toISOString() };
}
function monthRange(ym){
  const [y,m] = ym.split('-').map(Number);
  const s = new Date(y, m-1, 1, 0,0,0);
  const e = new Date(y, m,   0, 23,59,59);
  return { start: s.toISOString(), end: e.toISOString() };
}
function todayRange(){
  const d = new Date().toISOString().slice(0,10);
  return dayRange(d);
}

// ---------- DB helpers ----------
async function insertEntry(groupId, userId, type, amount, note){
  const q = `INSERT INTO entries (group_id,user_id,type,amount,note)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`;
  const r = await pool.query(q, [groupId,userId,type,amount,note]);
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
      text: 'ตัวอย่าง: "กลาง 450 ค่าน้ำ", "ส่วนตัว 120 กาแฟ", "สรุปวันนี้", "สรุป 2025-11-01", "สรุปเดือน 2025-11", "ลบ #123"' });
  }

  if (p.type) {
    const id = await insertEntry(gid, uid, p.type, p.amount, p.note);
    const label = p.type==='center' ? 'บัญชีกลาง' : 'ส่วนตัวออกก่อน';
    return line.replyMessage(event.replyToken, { type:'text',
      text: `บันทึกแล้ว #${id} · ${label} · ${p.amount} · ${p.note||'-'}` });
  }

  if (p.cmd === 'del') {
    const ok = await deleteEntry(gid, p.id);
    return line.replyMessage(event.replyToken, { type:'text',
      text: ok ? `ลบรายการ #${p.id} แล้ว` : `ไม่พบรายการ #${p.id}` });
  }

  if (p.cmd === 'sum') {
    let range;
    if (p.scope==='today') range = todayRange();
    else if (p.scope==='day') range = dayRange(p.date);
    else range = monthRange(p.ym);

    const { center, per, uA, uB, advanceA, advanceB, settle } =
      await sumByRange(gid, range.start, range.end);

    const nameA = uA ? await getDisplayName(source, uA) : 'A';
    const nameB = uB ? await getDisplayName(source, uB) : 'B';
    const whoPays =
      settle>0 ? `${nameB} ต้องคืน ${nameA} = ${Math.abs(settle)}`
    : settle<0 ? `${nameA} ต้องคืน ${nameB} = ${Math.abs(settle)}`
    : `ไม่ต้องคืนกัน`;

    const lines = Object.entries(per).map(([id,sum]) => `• ${(nameCache.get(id) || id.slice(0,6))}: ${sum}`);
    const others = lines.length ? `\nรายการออกก่อนรวม:\n${lines.join('\n')}` : '';

    const text =
`สรุป:
- กลางรวม: ${center}
- ออกก่อนของ ${nameA}: ${advanceA}
- ออกก่อนของ ${nameB}: ${advanceB}
- เคลียร์กัน: ${whoPays}${others}`;

    return line.replyMessage(event.replyToken, { type:'text', text });
  }
}

app.listen(process.env.PORT || 3000, () =>
  console.log('listening on', process.env.PORT || 3000)
);
