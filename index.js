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

// สร้างตาราง (ปรับ amount เป็น NUMERIC เพื่อรับทศนิยม)
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries(
      id SERIAL PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      type     TEXT CHECK(type IN ('center','advance')) NOT NULL,
      amount   NUMERIC(10,2) NOT NULL,
      note     TEXT,
      ts       TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Database ready');
})().catch(console.error);

/* ---------- Helpers: time & format ---------- */
const TH_TZ = '+07:00'; // เวลาไทย

function pad(n) {
  return n.toString().padStart(2, '0');
}

// Format เงินให้สวยงาม (มีทศนิยมถ้าจำเป็น)
function fmtNum(n) {
  const num = parseFloat(n);
  if (Number.isInteger(num)) return num.toString();
  return num.toFixed(2);
}

// dayRange นับตามวันไทย (00:00–23:59:59 ที่ +07:00)
function dayRange(dateStr) {
  const start = new Date(`${dateStr}T00:00:00.000${TH_TZ}`);
  const end   = new Date(`${dateStr}T23:59:59.999${TH_TZ}`);
  return { start: start.toISOString(), end: end.toISOString(), label: dateStr };
}

// monthRange นับตามเดือนไทย
function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();

  const start = new Date(`${y}-${pad(m)}-01T00:00:00.000${TH_TZ}`);
  const end   = new Date(`${y}-${pad(m)}-${pad(lastDay)}T23:59:59.999${TH_TZ}`);

  return { start: start.toISOString(), end: end.toISOString(), label: `เดือน ${ym}` };
}

// todayRange ใช้ "วันนี้" ตามเวลาไทย
function todayRange() {
  const now = new Date();
  const th = new Date(now.getTime() + 7 * 60 * 60 * 1000); // shift เป็นเวลาไทย
  const ds = `${th.getUTCFullYear()}-${pad(th.getUTCMonth() + 1)}-${pad(th.getUTCDate())}`;
  return dayRange(ds);
}

// แปลง timestamp เป็นสตริงวันเวลา + เดือน (คิดตามเวลาไทย)
function toYMDHM(ts) {
  const base = new Date(ts);
  const d = new Date(base.getTime() + 7 * 60 * 60 * 1000); // shift เป็นเวลาไทย

  const y  = d.getUTCFullYear();
  const m  = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());

  return {
    ym: `${y}-${m}`,
    ymdhm: `${y}-${m}-${dd} ${hh}:${mm}`,
  };
}

function splitChunks(str, size = 1800) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

/* ---------- Parse user input ---------- */
function parseMessage(text) {
  const t = text.trim();

  // บันทึก: รองรับทศนิยม (เช่น 100.50)
  // Regex: จับตัวเลขที่เป็น int หรือ float
  let m = t.match(/^(กลาง|ส่วนตัว)\s*([0-9]+(?:\.[0-9]+)?)\s*(.*)?$/i);
  if (m) {
    return {
      type: m[1] === 'กลาง' ? 'center' : 'advance',
      amount: parseFloat(m[2]),
      note: (m[3] || '').trim(),
    };
  }

  // ลบรายการ
  m = t.match(/^ลบ\s*#?(\d+)$/i);
  if (m) return { cmd: 'del', id: +m[1] };

  // สรุป (ช่วงเวลา)
  if (/^สรุปวันนี้$/i.test(t)) return { cmd: 'sum', scope: 'today' };
  m = t.match(/^สรุป\s+(\d{4}-\d{2}-\d{2})$/i);
  if (m) return { cmd: 'sum', scope: 'day', date: m[1] };
  m = t.match(/^สรุปเดือน\s+(\d{4}-\d{2})$/i);
  if (m) return { cmd: 'sum', scope: 'month', ym: m[1] };

  // สรุปทั้งหมด (ทุกเดือน)
  if (/^สรุปทั้งหมด$/i.test(t)) return { cmd: 'sum_all' };

  // ดูรายการทั้งหมด
  m = t.match(/^ดูรายการทั้งหมด(?:\s*(\d+))?$/i);
  if (m) return { cmd: 'list_all', limit: m[1] ? +m[1] : 300 };

  return null;
}

/* ---------- Aggregation & DB helpers ---------- */
function aggregate(rows) {
  // pg driver อาจคืนค่า numeric เป็น string จึงต้อง parseFloat เสมอ
  const center = rows
    .filter((r) => r.type === 'center')
    .reduce((a, b) => a + parseFloat(b.amount), 0);

  const per = {};
  for (const r of rows) {
    if (r.type === 'advance') {
      const val = parseFloat(r.amount);
      per[r.user_id] = (per[r.user_id] || 0) + val;
    }
  }
  const advanceSum = Object.values(per).reduce((a, b) => a + b, 0);
  return { center, per, advanceSum, total: center + advanceSum };
}

async function sumByRange(groupId, startISO, endISO) {
  const r = await pool.query(
    `SELECT user_id, type, amount
       FROM entries
      WHERE group_id=$1 AND ts BETWEEN $2 AND $3`,
    [groupId, startISO, endISO]
  );
  return aggregate(r.rows);
}

async function sumAll(groupId) {
  const r = await pool.query(
    `SELECT user_id, type, amount
       FROM entries
      WHERE group_id=$1`,
    [groupId]
  );
  return aggregate(r.rows);
}

async function listAllEntries(groupId, limit = 300) {
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

/* ---------- Settlement helper (หารส่วนตัวให้เท่ากัน) ---------- */
function computeSettlement(per) {
  const ids = Object.keys(per);
  if (!ids.length) return { shareText: '0', transfers: [] };

  const total = ids.reduce((s, id) => s + per[id], 0);
  const n = ids.length;
  const share = total / n;
  
  // Nets: ใครจ่ายเกิน (+) หรือจ่ายขาด (-)
  const nets = ids.map((id) => ({
    id,
    net: per[id] - share, 
  }));

  const creditors = nets.filter((x) => x.net > 0).sort((a, b) => b.net - a.net);
  const debtors = nets.filter((x) => x.net < 0).sort((a, b) => a.net - b.net);

  const transfers = [];
  let i = 0;
  let j = 0;

  while (i < creditors.length && j < debtors.length) {
    const c = creditors[i];
    const d = debtors[j];
    const amount = Math.min(c.net, -d.net);
    const clean = Math.round(amount * 100) / 100;

    if (clean > 0.005) {
      transfers.push({
        from: d.id,
        to: c.id,
        amount: clean,
      });
    }
    c.net -= amount;
    d.net += amount;

    if (c.net <= 0.005) i++;
    if (d.net >= -0.005) j++;
  }

  return { shareText: fmtNum(share), transfers };
}

/* ---------- Name cache ---------- */
const nameCache = new Map();

async function getDisplayName(source, userId) {
  if (nameCache.has(userId)) return nameCache.get(userId);
  try {
    let prof;
    if (source.type === 'group' && source.groupId)
      prof = await line.getGroupMemberProfile(source.groupId, userId);
    else if (source.type === 'room' && source.roomId)
      prof = await line.getRoomMemberProfile(source.roomId, userId);
    else
      prof = await line.getProfile(userId);

    const name = prof?.displayName || userId.slice(0, 6);
    nameCache.set(userId, name);
    return name;
  } catch {
    const fb = userId.slice(0, 6);
    nameCache.set(userId, fb);
    return fb;
  }
}

async function hydrateNames(rows, source) {
  const uniq = [...new Set(rows.map((r) => r.user_id))];
  await Promise.all(uniq.map((uid) => getDisplayName(source, uid)));
  return rows.map((r) => ({
    ...r,
    display: nameCache.get(r.user_id) || r.user_id.slice(0, 6),
  }));
}

function groupByMonth(rows) {
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
app.get('/', (_, res) => res.send('ok'));

app.post('/webhook', middleware(lineConfig), async (req, res) => {
  // ใช้ try-catch กันบอทล่มเวลามี Error แปลกๆ
  try {
    await Promise.all(req.body.events.map(handleEvent));
  } catch (err) {
    console.error('Webhook Error:', err);
  }
  res.sendStatus(200);
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const source = event.source;
  const gid = source.groupId || source.roomId || source.userId;
  const uid = source.userId;
  const p = parseMessage(event.message.text);

  // 🧾 Help text
  if (!p) {
    // แสดง Help เฉพาะพิมพ์คำว่า "คู่มือ" หรือ "help" เพื่อไม่ให้รก (หรือจะลบเงื่อนไขนี้เพื่อให้เด้งตลอดก็ได้)
    if (!/^(คู่มือ|help|วิธีใช้)$/i.test(event.message.text.trim())) return;
    
    const help = [
      '📒 คู่มือจดเงิน (รองรับทศนิยม)',
      '',
      '➕ บันทึก',
      '• กลาง100.50 ค่าน้ำ',
      '• ส่วนตัว120 กาแฟ',
      '• ส่วนตัว0 ชื่อ (หลอกระบบให้นับคนหาร)',
      '',
      '📊 สรุป',
      '• สรุปวันนี้',
      '• สรุป 2025-11-04',
      '• สรุปเดือน 2025-11',
      '• สรุปทั้งหมด',
      '',
      '🧾 รายการ',
      '• ดูรายการทั้งหมด',
      '• ลบ #123',
    ].join('\n');
    return line.replyMessage(event.replyToken, { type: 'text', text: help });
  }

  try {
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
        type: 'text',
        text: `บันทึกแล้ว #${id} · ${label} · ${fmtNum(p.amount)} · ${p.note || '-'}`,
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
        type: 'text',
        text: ok ? `ลบรายการ #${p.id} แล้ว` : `ไม่พบรายการ #${p.id}`,
      });
    }

    // 📊 สรุป (รวม Logic)
    if (p.cmd === 'sum' || p.cmd === 'sum_all') {
      let data;
      let title;

      if (p.cmd === 'sum_all') {
        data = await sumAll(gid);
        title = 'ทั้งหมด';
      } else {
        let range;
        if (p.scope === 'today') range = todayRange();
        else if (p.scope === 'day') range = dayRange(p.date);
        else range = monthRange(p.ym);
        
        data = await sumByRange(gid, range.start, range.end);
        title = range.label;
      }

      const { center, per, advanceSum, total } = data;

      // ออกก่อนรายคน
      const lines = [];
      for (const [id, sum] of Object.entries(per)) {
        const name = await getDisplayName(source, id);
        lines.push(`• ${name}: ${fmtNum(sum)}`);
      }

      // คำนวณเคลียร์บัญชี
      const { shareText, transfers } = computeSettlement(per);

      const transferLines = [];
      for (const t of transfers) {
        const fromName = await getDisplayName(source, t.from);
        const toName = await getDisplayName(source, t.to);
        transferLines.push(`• ${fromName} → ${toName}: ${fmtNum(t.amount)}`);
      }

      const text = `📊 สรุป: ${title}
กลางรวม: ${fmtNum(center)}
รวมส่วนตัว (advance): ${fmtNum(advanceSum)}
รวมทั้งหมด: ${fmtNum(total)}
เฉลี่ยส่วนตัวต่อคน (${Object.keys(per).length} คน): ${shareText}

รายการคนออกก่อน:
${lines.length ? lines.join('\n') : '• -'}

เคลียร์บัญชี:
${transferLines.length ? transferLines.join('\n') : '• -'}

*หมายเหตุ: ระบบหารเฉพาะคนที่มีรายการจ่าย ถ้าใครไม่ได้จ่ายแต่ต้องหาร ให้พิมพ์ "ส่วนตัว0 ชื่อ"`;

      return line.replyMessage(event.replyToken, { type: 'text', text });
    }

    // 🧾 ดูรายการทั้งหมด
    if (p.cmd === 'list_all') {
      const limit = Math.max(1, Math.min(p.limit || 300, 2000));
      const rows = await listAllEntries(gid, limit);
      if (!rows.length) {
        return line.replyMessage(event.replyToken, {
          type: 'text',
          text: 'ยังไม่มีรายการ',
        });
      }

      const withNames = await hydrateNames(rows, source);
      const grouped = groupByMonth(withNames);
      const months = Object.keys(grouped).sort();

      let text = '🧾 รายการล่าสุด (' + rows.length + ')\n';

      for (const ym of months) {
        text += `\n📅 ${ym}\n`;
        for (const r of grouped[ym]) {
          const { ymdhm } = toYMDHM(r.ts);
          const tag = r.type === 'center' ? 'กลาง' : 'ส่วนตัว';
          text += `- ${ymdhm} #${r.id} ${tag} ${fmtNum(r.amount)} ${r.display} ${
            r.note || ''
          }\n`;
        }
      }

      const chunks = splitChunks(text, 1800).slice(0, 5);
      const messages = chunks.map((c) => ({ type: 'text', text: c }));
      return line.replyMessage(event.replyToken, messages);
    }
    
  } catch (error) {
    console.error('Logic Error:', error);
    return line.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '❌ เกิดข้อผิดพลาดในระบบ: ' + error.message 
    });
  }
}

/* ---------- Start Server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 listening on', PORT));