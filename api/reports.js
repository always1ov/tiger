const { initDb, getDb } = require('./_db');
const { formatWithMinimax } = require('./_minimax');
const { parseLocal } = require('./_parser');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await initDb();
    const sql = getDb();

    if (req.method === 'GET') {
      const reports = await sql`
        SELECT r.*,
          json_agg(
            json_build_object(
              'id', i.id,
              'name', i.name,
              'exchange', i.exchange,
              'code', i.code,
              'up_pct', i.up_pct,
              'down_pct', i.down_pct,
              'channel_from', i.channel_from,
              'channel_to', i.channel_to,
              'price_type', i.price_type,
              'price', i.price,
              'price_date', i.price_date
            ) ORDER BY i.id
          ) FILTER (WHERE i.id IS NOT NULL) AS items
        FROM reports r
        LEFT JOIN items i ON i.report_id = r.id
        GROUP BY r.id
        ORDER BY r.report_date DESC, r.id DESC
      `;
      return res.json(reports);
    }

    if (req.method === 'POST') {
      const { text, password } = req.body || {};
      if (password !== process.env.SUBMIT_PASSWORD) {
        return res.status(401).json({ error: '密码错误' });
      }
      if (!text || !text.trim()) {
        return res.status(400).json({ error: '文本不能为空' });
      }

      let parsed;
      let usedAI = false;
      try {
        parsed = await formatWithMinimax(text);
        usedAI = true;
      } catch (e) {
        console.warn('MiniMax failed, falling back to local parser:', e.message);
        parsed = parseLocal(text);
      }

      const { market, report_date, source, items } = parsed;
      if (!market || !report_date || !source) {
        return res.status(400).json({ error: '无法解析报告头部信息（市场/日期/来源）' });
      }

      const [report] = await sql`
        INSERT INTO reports (market, report_date, source, raw_text)
        VALUES (${market}, ${report_date}, ${source}, ${text})
        RETURNING id
      `;

      let inserted = 0, skipped = 0;
      for (const item of (items || [])) {
        if (!item.code) { skipped++; continue; }
        try {
          await sql`
            INSERT INTO items (
              report_id, name, exchange, code,
              up_pct, down_pct,
              channel_from, channel_to,
              price_type, price, price_date,
              market, report_date
            ) VALUES (
              ${report.id}, ${item.name}, ${item.exchange || null}, ${item.code},
              ${item.up_pct ?? null}, ${item.down_pct ?? null},
              ${item.channel_from || null}, ${item.channel_to || null},
              ${item.price_type || null}, ${item.price ?? null}, ${item.price_date || null},
              ${market}, ${report_date}
            )
          `;
          inserted++;
        } catch (e) {
          if (e.message && e.message.includes('unique') || e.code === '23505') {
            skipped++;
          } else {
            throw e;
          }
        }
      }

      return res.json({ ok: true, inserted, skipped, usedAI, reportId: report.id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
