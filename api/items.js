import { initDb, getDb } from './_db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  await initDb();
  const sql = getDb();

  if (req.method === 'POST') {
    const { password, ...item } = req.body || {};
    if (password !== process.env.SUBMIT_PASSWORD) {
      return res.status(401).json({ error: '密码错误' });
    }

    const { name, exchange, code, up_pct, down_pct,
            channel_from, channel_to, price_type, price, price_date,
            market, report_date, source } = item;

    if (!code || !market || !report_date) {
      return res.status(400).json({ error: '代码、市场、日期为必填项' });
    }

    // Ensure a report exists for this market+date+source combo
    let reportId;
    const existing = await sql`
      SELECT id FROM reports WHERE market=${market} AND report_date=${report_date} AND source=${source || '手动'}
      LIMIT 1
    `;
    if (existing.length > 0) {
      reportId = existing[0].id;
    } else {
      const [r] = await sql`
        INSERT INTO reports (market, report_date, source)
        VALUES (${market}, ${report_date}, ${source || '手动'})
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
          ${reportId}, ${name}, ${exchange}, ${code},
          ${up_pct || null}, ${down_pct || null},
          ${channel_from}, ${channel_to},
          ${price_type}, ${price || null}, ${price_date || null},
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

  res.status(405).json({ error: 'Method not allowed' });
}
