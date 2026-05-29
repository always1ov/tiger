const { initDb, getDb } = require('./_db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await initDb();
    const sql = getDb();

    // ── POST: manual add / update single stock ─────────────────────────────────
    if (req.method === 'POST') {
      const { password, name, exchange, code, up_pct, down_pct,
              channel_from, channel_to, price_type, price, price_date,
              market, report_date, source } = req.body || {};

      if (password !== process.env.SUBMIT_PASSWORD) {
        return res.status(401).json({ error: '密码错误' });
      }
      if (!code || !market || !report_date || !name) {
        return res.status(400).json({ error: '代码、名称、市场、日期为必填项' });
      }

      const srcName  = source || '手动';
      const exChange = exchange || '';

      // Upsert report record
      const [report] = await sql`
        INSERT INTO reports (market, report_date, source)
        VALUES (${market}, ${report_date}, ${srcName})
        ON CONFLICT (market, report_date, source) DO UPDATE SET market = EXCLUDED.market
        RETURNING id
      `;

      // Upsert stock (global unique entity)
      const [stock] = await sql`
        INSERT INTO stocks (name, exchange, code, market,
          up_pct, down_pct, channel_from, channel_to,
          price_type, price, price_date,
          first_report_date, last_report_date, report_count, updated_at)
        VALUES (
          ${name}, ${exChange}, ${code}, ${market},
          ${up_pct || null}, ${down_pct || null},
          ${channel_from || null}, ${channel_to || null},
          ${price_type || null}, ${price || null}, ${price_date || null},
          ${report_date}, ${report_date}, 1, NOW()
        )
        ON CONFLICT (exchange, code) DO UPDATE SET
          name              = EXCLUDED.name,
          market            = EXCLUDED.market,
          up_pct            = EXCLUDED.up_pct,
          down_pct          = EXCLUDED.down_pct,
          channel_from      = EXCLUDED.channel_from,
          channel_to        = EXCLUDED.channel_to,
          price_type        = EXCLUDED.price_type,
          price             = EXCLUDED.price,
          price_date        = EXCLUDED.price_date,
          last_report_date  = GREATEST(stocks.last_report_date, EXCLUDED.last_report_date),
          first_report_date = LEAST(stocks.first_report_date, EXCLUDED.first_report_date),
          report_count      = stocks.report_count + 1,
          updated_at        = NOW()
        RETURNING id
      `;

      // Upsert snapshot
      const result = await sql`
        INSERT INTO snapshots (stock_id, report_id, report_date, market, source,
          up_pct, down_pct, channel_from, channel_to, price_type, price, price_date)
        VALUES (
          ${stock.id}, ${report.id}, ${report_date}, ${market}, ${srcName},
          ${up_pct || null}, ${down_pct || null},
          ${channel_from || null}, ${channel_to || null},
          ${price_type || null}, ${price || null}, ${price_date || null}
        )
        ON CONFLICT (stock_id, report_date) DO UPDATE SET
          report_id    = EXCLUDED.report_id,
          up_pct       = EXCLUDED.up_pct,
          down_pct     = EXCLUDED.down_pct,
          channel_from = EXCLUDED.channel_from,
          channel_to   = EXCLUDED.channel_to,
          price_type   = EXCLUDED.price_type,
          price        = EXCLUDED.price,
          price_date   = EXCLUDED.price_date
        RETURNING (xmax = 0) AS is_insert
      `;

      const action = result[0]?.is_insert ? '新增' : '已更新';
      return res.json({ ok: true, action, stockId: stock.id });
    }

    // ── DELETE: remove stock entirely or just one snapshot ────────────────────
    if (req.method === 'DELETE') {
      const { id, password, type } = req.body || {};
      if (password !== process.env.SUBMIT_PASSWORD) {
        return res.status(401).json({ error: '密码错误' });
      }

      if (type === 'report') {
        // Delete the report; snapshots SET NULL on report_id, stocks untouched
        await sql`DELETE FROM reports WHERE id = ${id}`;
      } else if (type === 'stock') {
        // Delete the stock + all its snapshots (CASCADE)
        await sql`DELETE FROM stocks WHERE id = ${id}`;
      } else {
        // Delete a single snapshot
        await sql`DELETE FROM snapshots WHERE id = ${id}`;
      }
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
