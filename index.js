require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const { Pool } = require('pg');

const lineConfig = { channelAccessToken: process.env.LINE_TOKEN, channelSecret: process.env.LINE_SECRET };
const line = new Client(lineConfig);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// 1. SETUP DB (รองรับทศนิยม และประเภท debt)
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries(
      id SERIAL PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      type     TEXT CHECK(type IN ('center','advance','debt')) NOT NULL,
      amount   NUMERIC(10,2) NOT NULL,
      note     TEXT,
      ts       TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Database Ready');
})().catch(console.error);

// 2. HELPERS
function fmtNum(n) {
  const num = parseFloat(n);
  return num % 1 === 0 ? num.toString() : num.toFixed(2);
}

// แก้บัคทศนิยม และเพิ่มระบบติดเงิน
function parseMessage(text) {
  const t = text.trim();
  
  // ลบรายการ
  let m = t.match(/^ลบ\s*#?(\d+)$/i);
  if (m) return { cmd: 'del', id: parseInt(m[1]) };

  // สรุป
  if (/^สรุปวันนี้$/i.test(t)) return { cmd: 'sum', scope: 'today' };
  if (/^สรุปทั้งหมด$/i.test(t)) return { cmd: 'sum_all' };

  // ติดเงิน (Debt): "ติด แมว 20.5"
  m = t.match(/^ติด\s+(.+)$/i);
  if (m) {
    const parts = m[1].trim().split(/\s+/);
    let amount, note;
    if (!isNaN(parts[0])) { amount = parseFloat(parts[0]); note = parts.slice(1).join(' '); }
    else if (!isNaN(parts[parts.length-1])) { amount = parseFloat(parts.pop()); note = parts.join(' '); }
    if (amount) return { type: 'debt', amount, note: note || 'ไม่ระบุชื่อ' };
  }

  // บันทึกปกติ: "กลาง 100.5" / "ส่วนตัว 20.5"
  m = t.match(/^(กลาง|ส่วนตัว)\s*([0-9]*\.?[0-9]+)\s*(.*)?$/i);
  if (m) return { type: m[1]==='กลาง'?'center':'advance', amount: parseFloat(m[2]), note: (m[3]||'').trim() };

  return null;
}

// 3. SETTLEMENT LOGIC (ใครโอนให้ใคร)
function computeSettlement(per) {
  const ids = Object.keys(per);
  if (!ids.length) return { shareText: '0', transfers: [] };
  const total = ids.reduce((s, id) => s + per[id], 0);
  const share = total / ids.length;
  const nets = ids.map(id => ({ id, net: per[id] - share }));
  const creditors = nets.filter(x => x.net > 0).sort((a,b) => b.net - a.net);
  const debtors = nets.filter(x => x.net < 0).sort((a,b) => a.net - b.net);
  const transfers = [];
  let i = 0, j = 0;
  while (i < creditors.length && j < debtors.length) {
    const amt = Math.min(creditors[i].net, -debtors[j].net);
    if (amt > 0.01) transfers.push({ from: debtors[j].id, to: creditors[i].id, amount: amt });
    creditors[i].net -= amt; debtors[j].net += amt;
    if (creditors[i].net <= 0.01) i++; if (debtors[j].net >= -0.01) j++;
  }
  return { shareText: fmtNum(share), transfers };
}

// 4. LINE HANDLER
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const gid = event.source.groupId || event.source.userId;
  const p = parseMessage(event.message.text);

  if (!p) return;

  try {
    if (p.type) {
      const r = await pool.query(`INSERT INTO entries (group_id,user_id,type,amount,note) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [gid, event.source.userId, p.type, p.amount, p.note]);
      return line.replyMessage(event.replyToken, { type: 'text', text: `✅ บันทึก #${r.rows[0].id}\n${p.type==='debt'?'💸 ติดเงิน':p.type==='center'?'💰 กลาง':'👤 ส่วนตัว'}: ${fmtNum(p.amount)}\nโน้ต: ${p.note||'-'}` });
    }

    if (p.cmd === 'sum' || p.cmd === 'sum_all') {
      const sql = p.cmd === 'sum_all' ? `SELECT * FROM entries WHERE group_id=$1` : `SELECT * FROM entries WHERE group_id=$1 AND ts >= CURRENT_DATE`;
      const { rows } = await pool.query(sql, [gid]);
      
      const center = rows.filter(r => r.type === 'center').reduce((a, b) => a + parseFloat(b.amount), 0);
      const debts = rows.filter(r => r.type === 'debt');
      const per = {};
      rows.filter(r => r.type === 'advance').forEach(r => { per[r.user_id] = (per[r.user_id] || 0) + parseFloat(r.amount); });

      const { shareText, transfers } = computeSettlement(per);
      const debtLines = Object.entries(debts.reduce((a,b)=>{a[b.note]=(a[b.note]||0)+parseFloat(b.amount); return a;}, {})).map(([n,v])=>`• ${n}: ${fmtNum(v)}`);

      let msg = `📊 สรุป (${p.cmd==='sum'?'วันนี้':'ทั้งหมด'})\nกลาง: ${fmtNum(center)}\nหารส่วนตัว: ${shareText}/คน\n\n💸 ติดเงินเรา:\n${debtLines.length?debtLines.join('\n'):'- ไม่มี -'}`;
      if (transfers.length) {
        msg += `\n\n🤝 เคลียร์บัญชี:`;
        for (const t of transfers) {
          const from = (await line.getProfile(t.from).catch(()=>({displayName:t.from.slice(0,4)}))).displayName;
          const to = (await line.getProfile(t.to).catch(()=>({displayName:t.to.slice(0,4)}))).displayName;
          msg += `\n• ${from} -> ${to}: ${fmtNum(t.amount)}`;
        }
      }
      return line.replyMessage(event.replyToken, { type: 'text', text: msg });
    }

    if (p.cmd === 'del') {
      await pool.query(`DELETE FROM entries WHERE id=$1 AND group_id=$2`, [p.id, gid]);
      return line.replyMessage(event.replyToken, { type: 'text', text: `🗑 ลบรายการ #${p.id} แล้ว` });
    }
  } catch (e) { console.error(e); }
}

const app = express();
app.post('/webhook', middleware(lineConfig), (req, res) => { Promise.all(req.body.events.map(handleEvent)).then(() => res.sendStatus(200)); });
app.listen(process.env.PORT || 3000);