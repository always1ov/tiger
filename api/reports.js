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

    // ── GET: reports grouped by date, items from snapshots+stocks ─────────────
    if (req.method === 'GET') {
      const reports = await sql`
        SELECT
          r.id, r.market, r.report_date, r.source,
          json_agg(
            json_build_object(
              'id',           s.id,
              'name',         s.name,
              'exchange',     s.exchange,
              'code',         s.code,
              'up_pct',       snap.up_pct,
              'down_pct',     snap.down_pct,
              'channel_from', snap.channel_from,
              'channel_to',   snap.channel_to,
              'price_type',   snap.price_type,
              'price',        snap.price,
              'price_date',   snap.price_date
            ) ORDER BY s.name
          ) FILTER (WHERE s.id IS NOT NULL) AS items
        FROM reports r
        LEFT JOIN snapshots snap ON snap.report_id = r.id
        LEFT JOIN stocks s ON s.id = snap.stock_id
        GROUP BY r.id
        ORDER BY r.report_date DESC, r.id DESC
      `;
      return res.json(reports);
    }

    // ── POST: parse text → upsert stocks → upsert snapshots ──────────────────
    if (req.method === 'POST') {
      const { text, password } = req.body || {};
      if (password !== process.env.SUBMIT_PASSWORD) {
        return res.status(401).json({ error: '密码错误' });
      }
      if (!text || !text.trim()) {
        return res.status(400).json({ error: '文本不能为空' });
      }

      let parsed, usedAI = false;
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

      // Upsert report record
      const [report] = await sql`
        INSERT INTO reports (market, report_date, source, raw_text)
        VALUES (${market}, ${report_date}, ${source}, ${text})
        ON CONFLICT (market, report_date, source)
        DO UPDATE SET raw_text = EXCLUDED.raw_text
        RETURNING id
      `;

      let inserted = 0, updated = 0, skipped = 0;

      for (const item of (items || [])) {
        if (!item.code) { skipped++; continue; }

        const exchange = item.exchange || '';

        // 1. Upsert stock (global unique entity)
        const [stock] = await sql`
          INSERT INTO stocks (name, exchange, code, market,
            up_pct, down_pct, channel_from, channel_to,
            price_type, price, price_date,
            first_report_date, last_report_date, report_count, updated_at)
          VALUES (
            ${item.name}, ${exchange}, ${item.code}, ${market},
            ${item.up_pct ?? null}, ${item.down_pct ?? null},
            ${item.channel_from || null}, ${item.channel_to || null},
            ${item.price_type || null}, ${item.price ?? null}, ${item.price_date || null},
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

        // 2. Upsert snapshot for this date
        const result = await sql`
          INSERT INTO snapshots (stock_id, report_id, report_date, market, source,
            up_pct, down_pct, channel_from, channel_to, price_type, price, price_date)
          VALUES (
            ${stock.id}, ${report.id}, ${report_date}, ${market}, ${source},
            ${item.up_pct ?? null}, ${item.down_pct ?? null},
            ${item.channel_from || null}, ${item.channel_to || null},
            ${item.price_type || null}, ${item.price ?? null}, ${item.price_date || null}
          )
          ON CONFLICT (stock_id, report_date) DO UPDATE SET
            report_id    = EXCLUDED.report_id,
            market       = EXCLUDED.market,
            source       = EXCLUDED.source,
            up_pct       = EXCLUDED.up_pct,
            down_pct     = EXCLUDED.down_pct,
            channel_from = EXCLUDED.channel_from,
            channel_to   = EXCLUDED.channel_to,
            price_type   = EXCLUDED.price_type,
            price        = EXCLUDED.price,
            price_date   = EXCLUDED.price_date
          RETURNING (xmax = 0) AS is_insert
        `;

        if (result[0]?.is_insert) inserted++;
        else updated++;
      }

      return res.json({ ok: true, inserted, updated, skipped, usedAI, reportId: report.id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
