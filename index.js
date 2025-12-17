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
   DATABASE INIT
   ========================================================== */
(async () => {
  try {
    console.log('🔄 Checking Database Structure...');
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
    
    await pool.query(`ALTER TABLE entries ALTER COLUMN amount TYPE NUMERIC(10,2);`);
    await pool.query(`ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_type_check;`);
    await pool.query(`
      ALTER TABLE entries 
      ADD CONSTRAINT entries_type_check 
      CHECK (type IN ('center','advance','debt'));
    `);

    console.log('✅ Database is ready');
  } catch (err) { console.error('⚠️ Database Warning:', err.message); }
})();

/* ==========================================================
   2. HELPERS
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

function splitChunks(str, size = 1800) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

function parseMessage(text) {
  const t = text.trim();
  const parts = t.split(/\s+/);

  // 1. ระบบติดเงิน
  const debtIndex = parts.indexOf('ติด');
  if (debtIndex !== -1) {
    const numIndex = parts.findIndex(p => !isNaN(parseFloat(p)));
    if (numIndex !== -1) {
      const amount = parseFloat(parts[numIndex]);
      const noteParts = parts.filter((_, i) => i !== debtIndex && i !== numIndex);
      return { type: 'debt', amount, note: noteParts.join(' ') || 'ไม่ระบุชื่อ' };
    }
  }

  // 2. บันทึกรายจ่าย (กลาง / ส่วนตัว)
  const m = t.match(/^(กลาง|ส่วนตัว)\s*([0-9]*\.?[0-9]+)\s*(.*)?$/i);
  if (m) {
    return {
      type: m[1] === 'กลาง' ? 'center' : 'advance',
      amount: parseFloat(m[2]),
      note: (m[3] || '').trim(),
    };
  }

  // 3. คำสั่งทั่วไป
  let cmdMatch = t.match(/^ลบ\s*#?(\d+)$/i);
  if (cmdMatch) return { cmd: 'del', id: parseInt(cmdMatch[1]) };
  if (/^สรุปวันนี้$/i.test(t)) return { cmd: 'sum', scope: 'today' };
  cmdMatch = t.match(/^สรุป\s+(\d{4}-\d{2}-\d{2})$/i);
  if (cmdMatch) return { cmd: 'sum', scope: 'day', date: cmdMatch[1] };
  cmdMatch = t.match(/^สรุปเดือน\s+(\d{4}-\d{2})$/i);
  if (cmdMatch) return { cmd: 'sum', scope: 'month', ym: cmdMatch[1] };
  if (/^สรุปทั้งหมด$/i.test(t)) return { cmd: 'sum_all' };
  cmdMatch = t.match(/^ดูรายการทั้งหมด(?:\s*(\d+))?$/i);
  if (cmdMatch) return { cmd: 'list_all', limit: cmdMatch[1] ? +cmdMatch[1] : 300 };

  return null;
}

/* ==========================================================
   3. LOGIC
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
   4. NAME UTILS
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
   5. SERVER
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
      const help = 
`📒 **คู่มือการใช้งาน**
------------------
1. **หารค่าใช้จ่าย**
   • "กลาง 100 ค่าน้ำ" (กองกลางจ่าย)
   • "ส่วนตัว 50 ขนม" (ออกก่อน/หารคืน)

2. **ระบบติดหนี้**
   • "Fia ติด 500"
   • "ติด แมว 20"

3. **ดูสรุป**
   • "สรุปวันนี้"
   • "สรุปเดือน 2025-12"
   • "สรุปทั้งหมด"

4. **อื่นๆ**
   • "ดูรายการทั้งหมด"
   • "ลบ #12"`;
      return line.replyMessage(event.replyToken, { type: 'text', text: help });
    }
    return;
  }

  try {
    // 1. บันทึก
    if (p.type) {
      const r = await pool.query(`INSERT INTO entries (group_id,user_id,type,amount,note) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [gid, event.source.userId, p.type, p.amount, p.note]);
      const tags = { center: '💸 กองกลางจ่าย', advance: '🙋‍♂️ ออกให้ก่อน', debt: '📝 ติดเงินเรา' };
      let replyText = `บันทึกแล้ว #${r.rows[0].id} · ${tags[p.type]}`;
      if (p.type === 'debt') replyText += ` (ลูกหนี้: ${p.note})`;
      replyText += ` · ${fmtNum(p.amount)}`;
      return line.replyMessage(event.replyToken, { type: 'text', text: replyText });
    }

    // 2. ลบ
    if (p.cmd === 'del') {
      await pool.query(`DELETE FROM entries WHERE id=$1 AND group_id=$2`, [p.id, gid]);
      return line.replyMessage(event.replyToken, { type: 'text', text: `ลบรายการ #${p.id} แล้ว` });
    }

    // 3. สรุป (ปรับปรุงใหม่ตามที่ขอ)
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
      
      // --- สร้างลิสต์รายการคนออกก่อน (Payer List) ---
      const payerLines = [];
      const payerIds = Object.keys(per).sort((a, b) => per[b] - per[a]); // เรียงตามยอดเงินมาก->น้อย
      for (const id of payerIds) {
        const name = await getDisplayName(event.source, id);
        payerLines.push(`• ${name}: ${fmtNum(per[id])}`);
      }
      const peopleCount = payerIds.length;

      // สร้างลิสต์รายการโอนคืน
      const transferLines = [];
      for (const t of transfers) {
        const from = await getDisplayName(event.source, t.from);
        const to = await getDisplayName(event.source, t.to);
        transferLines.push(`• ${from} → ${to}: ${fmtNum(t.amount)}`);
      }

      // สร้างลิสต์รายการติดหนี้
      const debtSum = debts.reduce((a, b) => { 
        const name = b.note || 'ไม่ระบุชื่อ';
        a[name] = (a[name] || 0) + parseFloat(b.amount); 
        return a; 
      }, {});
      const debtLines = Object.entries(debtSum).map(([n, v]) => `• ${n}: ${fmtNum(v)}`);

      // จัดรูปแบบข้อความตอบกลับ
      const text = `📊 สรุป: ${title}\n` +
                   `กลางรวม: ${fmtNum(center)}\n` +
                   `รวมส่วนตัว (advance): ${fmtNum(advanceSum)}\n` +
                   `รวมทั้งหมด: ${fmtNum(total)}\n` +
                   `เฉลี่ยส่วนตัวต่อคน (${peopleCount} คน): ${shareText}\n\n` +

                   `รายการคนออกก่อน:\n` +
                   `${payerLines.length ? payerLines.join('\n') : '-'}\n\n` +

                   `🤝 เคลียร์บัญชี (คืนคนออกก่อน):\n${transferLines.length ? transferLines.join('\n') : '-'}\n\n` +

                   `💸 ติดเงินเรา (ยืม):\n${debtLines.length ? debtLines.join('\n') : '-'}\n\n` +
                   
                   `*หมายเหตุ: ระบบหารเฉพาะคนที่มีรายการจ่าย ถ้าใครไม่ได้จ่ายแต่ต้องหาร ให้พิมพ์ "ส่วนตัว 0"`;

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