const { initDb, getDb } = require('./_db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await initDb();
    const sql = getDb();

    if (req.method === 'POST') {
      const body = req.body || {};
      const { password, name, exchange, code, up_pct, down_pct,
              channel_from, channel_to, price_type, price, price_date,
              market, report_date, source } = body;

      if (password !== process.env.SUBMIT_PASSWORD) {
        return res.status(401).json({ error: '密码错误' });
      }
      if (!code || !market || !report_date || !name) {
        return res.status(400).json({ error: '代码、名称、市场、日期为必填项' });
      }

      const srcName = source || '手动';
      const existing = await sql`
        SELECT id FROM reports
        WHERE market=${market} AND report_date=${report_date} AND source=${srcName}
        LIMIT 1
      `;
      let reportId;
      if (existing.length > 0) {
        reportId = existing[0].id;
      } else {
        const [r] = await sql`
          INSERT INTO reports (market, report_date, source)
          VALUES (${market}, ${report_date}, ${srcName})
          RETURNING id
        `;
        reportId = r.id;
      }

      try {
        const [row] = await sql`
          INSERT INTO items (
            report_id, name, exchange, code,
            up_pct, down_pct, channel_from, channel_to,
            price_type, price, price_date, market, report_date
          ) VALUES (
            ${reportId}, ${name}, ${exchange || null}, ${code},
            ${up_pct || null}, ${down_pct || null},
            ${channel_from || null}, ${channel_to || null},
            ${price_type || null}, ${price || null}, ${price_date || null},
            ${market}, ${report_date}
          ) RETURNING *
        `;
        return res.json({ ok: true, item: row });
      } catch (e) {
        if (e.code === '23505') {
          return res.status(409).json({ error: '该市场+日期+代码已存在' });
        }
        throw e;
      }
    }

    if (req.method === 'DELETE') {
      const { id, password, type } = req.body || {};
      if (password !== process.env.SUBMIT_PASSWORD) {
        return res.status(401).json({ error: '密码错误' });
      }
      if (type === 'report') {
        await sql`DELETE FROM reports WHERE id=${id}`;
      } else {
        await sql`DELETE FROM items WHERE id=${id}`;
      }
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
