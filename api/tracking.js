const { initDb, getDb } = require('./_db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await initDb();
    const sql = getDb();

    // Each stock is unique — query stocks table directly + snapshot history
    const rows = await sql`
      SELECT
        s.id,
        s.name,
        s.exchange,
        s.code,
        s.market,
        s.up_pct,
        s.down_pct,
        s.channel_from,
        s.channel_to,
        s.price_type,
        s.price,
        s.price_date,
        s.first_report_date,
        s.last_report_date,
        s.report_count,
        -- price at first snapshot that has a price
        (SELECT snap.price FROM snapshots snap
          WHERE snap.stock_id = s.id AND snap.price IS NOT NULL
          ORDER BY snap.report_date ASC LIMIT 1)             AS first_price,
        (SELECT snap.price_type FROM snapshots snap
          WHERE snap.stock_id = s.id AND snap.price IS NOT NULL
          ORDER BY snap.report_date ASC LIMIT 1)             AS first_price_type,
        (SELECT snap.report_date FROM snapshots snap
          WHERE snap.stock_id = s.id AND snap.price IS NOT NULL
          ORDER BY snap.report_date ASC LIMIT 1)             AS first_price_date,
        -- price at latest snapshot that has a price
        (SELECT snap.price FROM snapshots snap
          WHERE snap.stock_id = s.id AND snap.price IS NOT NULL
          ORDER BY snap.report_date DESC LIMIT 1)            AS latest_price,
        (SELECT snap.price_type FROM snapshots snap
          WHERE snap.stock_id = s.id AND snap.price IS NOT NULL
          ORDER BY snap.report_date DESC LIMIT 1)            AS latest_price_type,
        -- latest channel state
        (SELECT snap.channel_to FROM snapshots snap
          WHERE snap.stock_id = s.id
          ORDER BY snap.report_date DESC LIMIT 1)            AS latest_channel_to,
        (SELECT snap.channel_from FROM snapshots snap
          WHERE snap.stock_id = s.id
          ORDER BY snap.report_date DESC LIMIT 1)            AS latest_channel_from,
        -- full snapshot history for sparkline
        (SELECT json_agg(
          json_build_object(
            'date',        snap.report_date,
            'price',       snap.price,
            'channel_to',  snap.channel_to
          ) ORDER BY snap.report_date ASC
        ) FROM snapshots snap WHERE snap.stock_id = s.id)    AS snapshots
      FROM stocks s
      ORDER BY s.last_report_date DESC, s.market, s.name
    `;

    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
