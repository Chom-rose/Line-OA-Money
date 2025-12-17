require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { Pool } = require('pg');

/* ==========================================================
   1. CONFIG & SETUP
   ========================================================== */
const lineConfig = {
  channelAccessToken: process.env.LINE_TOKEN,
  channelSecret: process.env.LINE_SECRET,
};
const line = new Client(lineConfig);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ==========================================================
   DATABASE MIGRATION & INIT (โซนแก้ Database)
   ========================================================== */
(async () => {
  try {
    console.log('🔄 Checking Database Structure...');

    // 1. สร้างตารางถ้ายังไม่มี (สำหรับคนเริ่มใหม่)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS entries(
        id SERIAL PRIMARY KEY,
        group_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        type     TEXT NOT NULL, 
        amount   NUMERIC(10,2) NOT NULL,
        note     TEXT,
        ts       TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 2. ปรับปรุงตารางเดิม (MIGRATION)
    // - เปลี่ยน amount ให้รับทศนิยมได้ (ถ้าของเดิมเป็น int จะ error)
    await pool.query(`ALTER TABLE entries ALTER COLUMN amount TYPE NUMERIC(10,2);`);
    
    // - แก้กฎ (Constraint) ให้รองรับ 'debt' (ติดเงิน)
    //   ต้องลบกฎเก่าออกก่อน (ชื่อ default มักจะเป็น entries_type_check)
    await pool.query(`ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_type_check;`);
    //   สร้างกฎใหม่
    await pool.query(`
      ALTER TABLE entries 
      ADD CONSTRAINT entries_type_check 
      CHECK (type IN ('center','advance','debt'));
    `);

    console.log('✅ Database is ready & Updated (Decimal & Debt support)');
  } catch (err) {
    console.error('⚠️ Database Warning:', err.message);
    // โปรแกรมจะทำงานต่อได้แม้จะมี Warning (เช่น กรณีแก้ไปแล้ว)
  }
})();

/* ==========================================================
   2. HELPERS (Time, Format, Parse)
   ========================================================== */
const TH_TZ = '+07:00';

function pad(n) { return n.toString().padStart(2, '0'); }

function fmtNum(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return "0";
  return num % 1 === 0 ? num.toString() : num.toFixed(2);
}

function dayRange(dateStr) {
  const start = new Date(`${dateStr}T00:00:00.000${TH_TZ}`);
  const end   = new Date(`${dateStr}T23:59:59.999${TH_TZ}`);
  return { start: start.toISOString(), end: end.toISOString(), label: dateStr };
}

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const start = new Date(`${y}-${pad(m)}-01T00:00:00.000${TH_TZ}`);
  const end   = new Date(`${y}-${pad(m)}-${pad(lastDay)}T23:59:59.999${TH_TZ}`);
  return { start: start.toISOString(), end: end.toISOString(), label: `เดือน ${ym}` };
}

function todayRange() {
  const now = new Date();
  const th = new Date(now.getTime() + 7 * 60 * 60 * 1000); 
  const ds = `${th.getUTCFullYear()}-${pad(th.getUTCMonth() + 1)}-${pad(th.getUTCDate())}`;
  return dayRange(ds);
}

function toYMDHM(ts) {
  const base = new Date(ts);
  const d = new Date(base.getTime() + 7 * 60 * 60 * 1000); 
  const y  = d.getUTCFullYear();
  const m  = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  return { ym: `${y}-${m}`, ymdhm: `${y}-${m}-${dd} ${hh}:${mm}` };
}

function splitChunks(str, size = 1800) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

function parseMessage(text) {
  const t = text.trim();

  // ระบบติดเงิน: "ติด แมว 20.5"
  let m = t.match(/^ติด\s+(.+)$/i);
  if (m) {
    const parts = m[1].trim().split(/\s+/);
    let amount, note;
    if (!isNaN(parts[0])) { amount = parseFloat(parts[0]); note = parts.slice(1).join(' '); }
    else if (!isNaN(parts[parts.length-1])) { amount = parseFloat(parts.pop()); note = parts.join(' '); }
    if (amount !== undefined) return { type: 'debt', amount, note: note || 'ไม่ระบุชื่อ' };
  }

  // บันทึกรายการ
  m = t.match(/^(กลาง|ส่วนตัว)\s*([0-9]*\.?[0-9]+)\s*(.*)?$/i);
  if (m) {
    return {
      type: m[1] === 'กลาง' ? 'center' : 'advance',
      amount: parseFloat(m[2]),
      note: (m[3] || '').trim(),
    };
  }

  // คำสั่งสรุปต่างๆ
  m = t.match(/^ลบ\s*#?(\d+)$/i);
  if (m) return { cmd: 'del', id: parseInt(m[1]) };
  if (/^สรุปวันนี้$/i.test(t)) return { cmd: 'sum', scope: 'today' };
  m = t.match(/^สรุป\s+(\d{4}-\d{2}-\d{2})$/i);
  if (m) return { cmd: 'sum', scope: 'day', date: m[1] };
  m = t.match(/^สรุปเดือน\s+(\d{4}-\d{2})$/i);
  if (m) return { cmd: 'sum', scope: 'month', ym: m[1] };
  if (/^สรุปทั้งหมด$/i.test(t)) return { cmd: 'sum_all' };
  m = t.match(/^ดูรายการทั้งหมด(?:\s*(\d+))?$/i);
  if (m) return { cmd: 'list_all', limit: m[1] ? +m[1] : 300 };

  return null;
}

/* ==========================================================
   3. LOGIC (DB & Calculation)
   ========================================================== */

async function aggregate(rows) {
  const center = rows.filter(r => r.type === 'center').reduce((a, b) => a + parseFloat(b.amount), 0);
  const debts = rows.filter(r => r.type === 'debt');
  const per = {};
  for (const r of rows) {
    if (r.type === 'advance') {
      const val = parseFloat(r.amount);
      per[r.user_id] = (per[r.user_id] || 0) + val;
    }
  }
  const advanceSum = Object.values(per).reduce((a, b) => a + b, 0);
  return { center, per, advanceSum, total: center + advanceSum, debts };
}

function computeSettlement(per) {
  const ids = Object.keys(per);
  if (!ids.length) return { shareText: '0', transfers: [] };
  const total = ids.reduce((s, id) => s + per[id], 0);
  const share = total / ids.length;
  const nets = ids.map((id) => ({ id, net: per[id] - share }));
  const creditors = nets.filter((x) => x.net > 0).sort((a, b) => b.net - a.net);
  const debtors = nets.filter((x) => x.net < 0).sort((a, b) => a.net - b.net);
  const transfers = [];
  let i = 0, j = 0;
  while (i < creditors.length && j < debtors.length) {
    const amount = Math.min(creditors[i].net, -debtors[j].net);
    if (amount > 0.01) transfers.push({ from: debtors[j].id, to: creditors[i].id, amount: Math.round(amount * 100) / 100 });
    creditors[i].net -= amount; debtors[j].net += amount;
    if (creditors[i].net <= 0.01) i++; if (debtors[j].net >= -0.01) j++;
  }
  return { shareText: fmtNum(share), transfers };
}

/* ==========================================================
   4. NAME CACHE
   ========================================================== */
const nameCache = new Map();
async function getDisplayName(source, userId) {
  if (nameCache.has(userId)) return nameCache.get(userId);
  try {
    let prof;
    if (source.type === 'group') prof = await line.getGroupMemberProfile(source.groupId, userId);
    else prof = await line.getProfile(userId);
    const name = prof?.displayName || userId.slice(0, 6);
    nameCache.set(userId, name);
    return name;
  } catch { return userId.slice(0, 6); }
}

async function hydrateNames(rows, source) {
  const uniq = [...new Set(rows.map((r) => r.user_id))];
  await Promise.all(uniq.map((uid) => getDisplayName(source, uid)));
  return rows.map((r) => ({ ...r, display: nameCache.get(r.user_id) || r.user_id.slice(0, 6) }));
}

/* ==========================================================
   5. EXPRESS SERVER & HANDLERS
   ========================================================== */
const app = express();
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  try { await Promise.all(req.body.events.map(handleEvent)); } catch (err) { console.error(err); }
  res.sendStatus(200);
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const gid = event.source.groupId || event.source.userId;
  const p = parseMessage(event.message.text);

  if (!p) {
    if (/^(คู่มือ|help|วิธีใช้)$/i.test(event.message.text.trim())) {
      const help = "📒 วิธีใช้\n• กลาง 100.50 ค่าน้ำ\n• ส่วนตัว 20.25 ข้าว\n• ติด แมว 50 (แมวติดเงินเรา)\n• สรุปวันนี้ / สรุปเดือน 2025-12\n• ดูรายการทั้งหมด\n• ลบ #ID";
      return line.replyMessage(event.replyToken, { type: 'text', text: help });
    }
    return;
  }

  try {
    // 1. บันทึก
    if (p.type) {
      const r = await pool.query(`INSERT INTO entries (group_id,user_id,type,amount,note) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [gid, event.source.userId, p.type, p.amount, p.note]);
      const tags = { center: 'บัญชีกลาง', advance: 'ส่วนตัวออกก่อน', debt: 'ติดเงินเรา' };
      return line.replyMessage(event.replyToken, { type: 'text', text: `บันทึกแล้ว #${r.rows[0].id} · ${tags[p.type]} · ${fmtNum(p.amount)} · ${p.note || '-'}` });
    }

    // 2. ลบ
    if (p.cmd === 'del') {
      await pool.query(`DELETE FROM entries WHERE id=$1 AND group_id=$2`, [p.id, gid]);
      return line.replyMessage(event.replyToken, { type: 'text', text: `ลบรายการ #${p.id} แล้ว` });
    }

    // 3. สรุป
    if (p.cmd === 'sum' || p.cmd === 'sum_all') {
      let rows, title;
      if (p.cmd === 'sum_all') {
        const r = await pool.query(`SELECT * FROM entries WHERE group_id=$1`, [gid]);
        rows = r.rows; title = "ทั้งหมด";
      } else {
        const range = p.scope === 'today' ? todayRange() : p.scope === 'day' ? dayRange(p.date) : monthRange(p.ym);
        const r = await pool.query(`SELECT * FROM entries WHERE group_id=$1 AND ts BETWEEN $2 AND $3`, [gid, range.start, range.end]);
        rows = r.rows; title = range.label;
      }

      const { center, per, advanceSum, total, debts } = await aggregate(rows);
      const { shareText, transfers } = computeSettlement(per);
      
      const transferLines = [];
      for (const t of transfers) {
        const from = await getDisplayName(event.source, t.from);
        const to = await getDisplayName(event.source, t.to);
        transferLines.push(`• ${from} → ${to}: ${fmtNum(t.amount)}`);
      }

      const debtSum = debts.reduce((a, b) => { a[b.note] = (a[b.note] || 0) + parseFloat(b.amount); return a; }, {});
      const debtLines = Object.entries(debtSum).map(([n, v]) => `• ${n}: ${fmtNum(v)}`);

      const text = `📊 สรุป: ${title}\nกลาง: ${fmtNum(center)}\nส่วนตัวรวม: ${fmtNum(advanceSum)}\nรวมทั้งหมด: ${fmtNum(total)}\nเฉลี่ยต่อคน: ${shareText}\n\n💸 ติดเงินเรา:\n${debtLines.length ? debtLines.join('\n') : '-'}\n\n🤝 เคลียร์บัญชี:\n${transferLines.length ? transferLines.join('\n') : '-'}`;
      return line.replyMessage(event.replyToken, { type: 'text', text });
    }

    // 4. ดูรายการ
    if (p.cmd === 'list_all') {
      const r = await pool.query(`SELECT * FROM entries WHERE group_id=$1 ORDER BY ts ASC LIMIT $2`, [gid, p.limit]);
      if (!r.rows.length) return line.replyMessage(event.replyToken, { type: 'text', text: 'ยังไม่มีรายการ' });
      const withNames = await hydrateNames(r.rows, event.source);
      let text = `🧾 รายการล่าสุด (${r.rows.length})\n`;
      for (const row of withNames) {
        const tag = row.type === 'center' ? 'กลาง' : row.type === 'debt' ? 'หนี้' : 'ส่วนตัว';
        text += `- #${row.id} [${tag}] ${fmtNum(row.amount)} ${row.display} ${row.note || ''}\n`;
      }
      const chunks = splitChunks(text);
      return line.replyMessage(event.replyToken, chunks.map(c => ({ type: 'text', text: c })));
    }
  } catch (err) { console.error(err); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 listening on', PORT));