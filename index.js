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

// สร้างตาราง
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

// ---------- Helpers ----------
function parseMessage(text){
  const t = text.trim();

  // --- เพิ่มฟีเจอร์บันทึก ---
  let m = t.match(/^กลาง\s*(\d+)\s*(.*)?$/i);
  if (m) return { type: 'center', amount: +m[1], note: m[2]?.trim() || '' };

  m = t.match(/^ส่วนตัว\s*(\d+)\s*(.*)?$/i);
  if (m) return { type: 'advance', amount: +m[1], note: m[2]?.trim() || '' };

  // --- ลบ / ยืนยัน ---
  m = t.match(/^ลบ\s*#(\d+)$/i);
  if (m) return { cmd: 'askDel', id: +m[1] };

  m = t.match(/^ยืนยัน(\d+)$/i);
  if (m) return { cmd: 'del', id: +m[1] };

  // --- สรุป ---
  if (/^สรุปวันนี้$/i.test(t)) return { cmd: 'sum', scope: 'today' };
  m = t.match(/^สรุป\s+(\d{4}-\d{2}-\d{2})$/i);
  if (m) return { cmd: 'sum', scope: 'day', date: m[1] };
  m = t.match(/^สรุปเดือน\s+(\d{4}-\d{2})$/i);
  if (m) return { cmd: 'sum', scope: 'month', ym: m[1] };
  if (/^สรุปทั้งหมด$/i.test(t)) return { cmd: 'sum', scope: 'all' };
  m = t.match(/^สรุปย้อนหลัง(\d+)วัน$/i);
  if (m) return { cmd: 'sum', scope: 'past', days: +m[1] };

  // --- ดูรายการ ---
  if (/^ดูรายการล่าสุด$/i.test(t)) return { cmd: 'list', scope: 'latest' };
  m = t.match(/^ดูรายการ\s+(\d{4}-\d{2}-\d{2})$/i);
  if (m) return { cmd: 'list', scope: 'day', date: m[1] };
  m = t.match(/^ดูรายการเดือน\s+(\d{4}-\d{2})$/i);
  if (m) return { cmd: 'list', scope: 'month', ym: m[1] };

  if (/^รีเซ็ตเดือนนี้$/i.test(t)) return { cmd: 'resetMonth' };
  if (/^backup$/i.test(t)) return { cmd: 'backup' };

  return null;
}

function rangeFrom(type, val){
  const now = new Date();
  if (type === 'day') {
    const d = new Date(val);
    return [new Date(d.setHours(0,0,0)), new Date(d.setHours(23,59,59))];
  }
  if (type === 'month') {
    const [y,m] = val.split('-').map(Number);
    return [new Date(y,m-1,1,0,0,0), new Date(y,m,0,23,59,59)];
  }
  if (type === 'past') {
    const end = now;
    const start = new Date();
    start.setDate(start.getDate() - val);
    return [start, end];
  }
  if (type === 'today') {
    const start = new Date();
    start.setHours(0,0,0);
    const end = new Date();
    end.setHours(23,59,59);
    return [start,end];
  }
  return [new Date('1970-01-01'), new Date()];
}

// ---------- DB ----------
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

async function sumByRange(groupId, start, end){
  const r = await pool.query(
    `SELECT user_id, type, amount FROM entries
     WHERE group_id=$1 AND ts BETWEEN $2 AND $3`,
    [groupId, start.toISOString(), end.toISOString()]
  );
  const rows = r.rows;
  const center = rows.filter(x=>x.type==='center').reduce((a,b)=>a+b.amount,0);
  const per = {};
  for (const x of rows.filter(x=>x.type==='advance')) per[x.user_id]=(per[x.user_id]||0)+x.amount;
  return {center, per};
}

async function listEntries(groupId, start, end){
  const r = await pool.query(
    `SELECT id,type,amount,note,to_char(ts,'YYYY-MM-DD HH24:MI') as time
     FROM entries WHERE group_id=$1 AND ts BETWEEN $2 AND $3
     ORDER BY ts DESC LIMIT 20`,
    [groupId,start.toISOString(),end.toISOString()]
  );
  return r.rows;
}

// ---------- LINE BOT ----------
const app = express();
app.get('/', (_,res)=>res.send('ok'));
app.post('/webhook', middleware(config), async (req,res)=>{
  await Promise.all(req.body.events.map(handleEvent));
  res.sendStatus(200);
});

async function handleEvent(event){
  if (event.type!=='message' || event.message.type!=='text') return;
  const gid = event.source.groupId || event.source.roomId || event.source.userId;
  const uid = event.source.userId;
  const p = parseMessage(event.message.text);

  if (!p){
    const help = [
      '📒 คู่มือจดเงินแบบเร็ว\n',
      '➕ บันทึก',
      '• กลาง100 ค่าน้ำ',
      '• ส่วนตัว120 กาแฟ',
      '',
      '📊 สรุป',
      '• สรุปวันนี้',
      '• สรุป 2025-11-04',
      '• สรุปเดือน 2025-11',
      '• สรุปย้อนหลัง3วัน',
      '• สรุปทั้งหมด',
      '',
      '🧾 รายการ',
      '• ดูรายการ 2025-11-04',
      '• ดูรายการเดือน 2025-11',
      '• ดูรายการล่าสุด',
      '',
      '🧹 จัดการ',
      '• ลบ #123 / ยืนยัน123',
      '• รีเซ็ตเดือนนี้',
      '• backup'
    ].join('\n');

    return line.replyMessage(event.replyToken, { type:'text', text: help });
  }

  // ---------- ลบ ----------
  if (p.cmd === 'askDel') {
    return line.replyMessage(event.replyToken, { type:'text', text: `ต้องการลบรายการ #${p.id} ใช่ไหม? (พิมพ์ ยืนยัน${p.id} เพื่อลบ)` });
  }
  if (p.cmd === 'del') {
    const ok = await deleteEntry(gid, p.id);
    return line.replyMessage(event.replyToken, { type:'text', text: ok ? `✅ ลบรายการ #${p.id} แล้ว` : `❌ ไม่พบรายการ #${p.id}` });
  }

  // ---------- บันทึก ----------
  if (p.type) {
    const id = await insertEntry(gid, uid, p.type, p.amount, p.note);
    const label = p.type==='center' ? 'บัญชีกลาง' : 'ส่วนตัวออกก่อน';
    return line.replyMessage(event.replyToken, { type:'text', text:`บันทึกแล้ว #${id} · ${label} · ${p.amount} · ${p.note||'-'}` });
  }

  // ---------- สรุป ----------
  if (p.cmd === 'sum') {
    const [start,end] = rangeFrom(p.scope, p.date||p.ym||p.days);
    const {center,per} = await sumByRange(gid,start,end);
    const perList = Object.entries(per).map(([id,amt])=>`• ${id.slice(0,6)}: ${amt}`).join('\n') || '-';
    const total = center + Object.values(per).reduce((a,b)=>a+b,0);
    const txt = `📊 สรุปช่วง ${start.toISOString().slice(0,10)} ถึง ${end.toISOString().slice(0,10)}\n\nกลางรวม: ${center}\nรวมส่วนตัว: ${Object.values(per).reduce((a,b)=>a+b,0)}\nรวมทั้งหมด: ${total}\n\nออกก่อนรายคน:\n${perList}`;
    return line.replyMessage(event.replyToken, { type:'text', text: txt });
  }

  // ---------- ดูรายการ ----------
  if (p.cmd === 'list') {
    const [start,end] = rangeFrom(p.scope,p.date||p.ym);
    const rows = await listEntries(gid,start,end);
    if (!rows.length)
      return line.replyMessage(event.replyToken,{type:'text',text:'ไม่มีรายการในช่วงนี้'});
    const lines = rows.map(r=>`#${r.id} · ${r.type==='center'?'กลาง':'ส่วนตัว'} · ${r.amount} · ${r.note||'-'} (${r.time})`);
    return line.replyMessage(event.replyToken,{type:'text',text:'🧾 รายการล่าสุด\n'+lines.join('\n')});
  }
}

app.listen(process.env.PORT||3000,()=>console.log('listening on',process.env.PORT||3000));
