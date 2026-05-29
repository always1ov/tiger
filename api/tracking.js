const { initDb, getDb } = require('./_db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await initDb();
    const sql = getDb();

    // Aggregate each unique stock across all report dates
    const rows = await sql`
      SELECT
        i.code,
        i.exchange,
        i.market,
        -- latest name (names may be normalized over time)
        (array_agg(i.name ORDER BY i.report_date DESC))[1]          AS name,
        MIN(i.report_date)                                           AS first_date,
        MAX(i.report_date)                                           AS latest_date,
        COUNT(DISTINCT i.report_date)                                AS days_tracked,
        -- price at first observation that has a price
        (array_agg(i.price       ORDER BY i.report_date ASC)
          FILTER (WHERE i.price IS NOT NULL))[1]                     AS first_price,
        (array_agg(i.price_type  ORDER BY i.report_date ASC)
          FILTER (WHERE i.price IS NOT NULL))[1]                     AS first_price_type,
        (array_agg(i.report_date ORDER BY i.report_date ASC)
          FILTER (WHERE i.price IS NOT NULL))[1]                     AS first_price_date,
        -- price at latest observation that has a price
        (array_agg(i.price       ORDER BY i.report_date DESC)
          FILTER (WHERE i.price IS NOT NULL))[1]                     AS latest_price,
        (array_agg(i.price_type  ORDER BY i.report_date DESC)
          FILTER (WHERE i.price IS NOT NULL))[1]                     AS latest_price_type,
        (array_agg(i.report_date ORDER BY i.report_date DESC)
          FILTER (WHERE i.price IS NOT NULL))[1]                     AS latest_price_date,
        -- latest channel state
        (array_agg(i.channel_to   ORDER BY i.report_date DESC))[1]  AS latest_channel_to,
        (array_agg(i.channel_from ORDER BY i.report_date DESC))[1]  AS latest_channel_from,
        -- all channel snapshots for sparkline
        json_agg(
          json_build_object(
            'date', i.report_date,
            'price', i.price,
            'channel_to', i.channel_to
          ) ORDER BY i.report_date ASC
        ) AS snapshots
      FROM items i
      GROUP BY i.code, i.exchange, i.market
      ORDER BY MAX(i.report_date) DESC, i.market, MIN(i.name)
    `;

    return res.json(rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
