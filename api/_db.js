const { neon } = require('@neondatabase/serverless');

let sql;
function getDb() {
  if (!sql) sql = neon(process.env.DATABASE_URL);
  return sql;
}

async function initDb() {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      market TEXT NOT NULL,
      report_date DATE NOT NULL,
      source TEXT NOT NULL,
      raw_text TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      report_id INTEGER REFERENCES reports(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      exchange TEXT,
      code TEXT NOT NULL,
      up_pct NUMERIC,
      down_pct NUMERIC,
      channel_from TEXT,
      channel_to TEXT,
      price_type TEXT,
      price NUMERIC,
      price_date DATE,
      market TEXT NOT NULL,
      report_date DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(market, report_date, code)
    )
  `;
}

module.exports = { getDb, initDb };
