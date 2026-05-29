const { initDb, getDb } = require('./_db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { password } = req.query;
  if (password !== process.env.SUBMIT_PASSWORD) {
    return res.status(401).json({ error: '密码错误' });
  }

  await initDb();
  const sql = getDb();

  const rows = await sql`
    SELECT exchange, market, count(*) AS cnt,
           array_agg(code ORDER BY code) AS codes
    FROM stocks
    GROUP BY exchange, market
    ORDER BY market, exchange
  `;

  return res.json(rows);
};
