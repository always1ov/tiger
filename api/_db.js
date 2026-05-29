const { neon } = require('@neondatabase/serverless');

let sql;
function getDb() {
  if (!sql) sql = neon(process.env.DATABASE_URL);
  return sql;
}

async function initDb() {
  const sql = getDb();

  // ── reports: one per submission ────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS reports (
      id          SERIAL PRIMARY KEY,
      market      TEXT NOT NULL,
      report_date DATE NOT NULL,
      source      TEXT NOT NULL,
      raw_text    TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(market, report_date, source)
    )
  `;
  // Add constraint for existing deployments
  await sql`
    ALTER TABLE reports
    ADD CONSTRAINT IF NOT EXISTS reports_market_date_source_key
    UNIQUE (market, report_date, source)
  `.catch(() => {});

  // ── stocks: one row per unique stock (exchange + code) ─────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS stocks (
      id               SERIAL PRIMARY KEY,
      name             TEXT NOT NULL,
      exchange         TEXT NOT NULL DEFAULT '',
      code             TEXT NOT NULL,
      market           TEXT NOT NULL DEFAULT '',
      up_pct           NUMERIC,
      down_pct         NUMERIC,
      channel_from     TEXT,
      channel_to       TEXT,
      price_type       TEXT,
      price            NUMERIC,
      price_date       DATE,
      first_report_date DATE,
      last_report_date  DATE,
      report_count     INTEGER DEFAULT 0,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(exchange, code)
    )
  `;

  // ── snapshots: one row per (stock, report_date) — history timeline ─────────
  await sql`
    CREATE TABLE IF NOT EXISTS snapshots (
      id           SERIAL PRIMARY KEY,
      stock_id     INTEGER NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
      report_id    INTEGER REFERENCES reports(id) ON DELETE SET NULL,
      report_date  DATE NOT NULL,
      market       TEXT NOT NULL DEFAULT '',
      source       TEXT,
      up_pct       NUMERIC,
      down_pct     NUMERIC,
      channel_from TEXT,
      channel_to   TEXT,
      price_type   TEXT,
      price        NUMERIC,
      price_date   DATE,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(stock_id, report_date)
    )
  `;

  // ── Migrate existing items table data (one-time, runs only if needed) ──────
  await migrateFromItems(sql);
}

async function migrateFromItems(sql) {
  try {
    // Only run if items table exists and stocks is still empty
    const [hasItems] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'items'
      ) AS has_items,
      EXISTS (SELECT 1 FROM stocks LIMIT 1) AS has_stocks
    `;
    if (!hasItems.has_items || hasItems.has_stocks) return;

    const items = await sql`SELECT i.*, r.source FROM items i LEFT JOIN reports r ON r.id = i.report_id`;
    if (!items.length) return;

    console.log(`Migrating ${items.length} items to stocks+snapshots...`);

    // Group by exchange+code, pick latest record as the canonical stock state
    const byCode = {};
    for (const item of items) {
      const key = `${item.exchange||''}|${item.code}`;
      if (!byCode[key]) byCode[key] = [];
      byCode[key].push(item);
    }

    for (const rows of Object.values(byCode)) {
      rows.sort((a, b) => new Date(b.report_date) - new Date(a.report_date));
      const latest = rows[0];
      const dates  = rows.map(r => new Date(r.report_date));
      const firstDate  = new Date(Math.min(...dates)).toISOString().slice(0,10);
      const latestDate = new Date(Math.max(...dates)).toISOString().slice(0,10);

      const [stock] = await sql`
        INSERT INTO stocks (name, exchange, code, market, up_pct, down_pct,
          channel_from, channel_to, price_type, price, price_date,
          first_report_date, last_report_date, report_count)
        VALUES (
          ${latest.name}, ${latest.exchange||''}, ${latest.code}, ${latest.market||''},
          ${latest.up_pct}, ${latest.down_pct},
          ${latest.channel_from}, ${latest.channel_to},
          ${latest.price_type}, ${latest.price}, ${latest.price_date||null},
          ${firstDate}, ${latestDate}, ${rows.length}
        )
        ON CONFLICT (exchange, code) DO NOTHING
        RETURNING id
      `;
      if (!stock) continue;

      for (const row of rows) {
        await sql`
          INSERT INTO snapshots (stock_id, report_id, report_date, market, source,
            up_pct, down_pct, channel_from, channel_to, price_type, price, price_date)
          VALUES (
            ${stock.id}, ${row.report_id}, ${row.report_date},
            ${row.market||''}, ${row.source||null},
            ${row.up_pct}, ${row.down_pct},
            ${row.channel_from}, ${row.channel_to},
            ${row.price_type}, ${row.price}, ${row.price_date||null}
          )
          ON CONFLICT (stock_id, report_date) DO NOTHING
        `.catch(() => {});
      }
    }

    console.log('Migration complete.');
  } catch (e) {
    console.warn('Migration skipped:', e.message);
  }
}

module.exports = { getDb, initDb };
