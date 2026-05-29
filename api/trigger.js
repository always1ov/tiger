// 代理到本地价格更新服务（scripts/server.py）
// 需要在 Vercel 环境变量中设置 PRICE_SERVER_URL，例如:
//   https://xxxx.ngrok.io  或  http://your-vps-ip:8765

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const serverUrl = process.env.PRICE_SERVER_URL;
  if (!serverUrl) {
    return res.status(503).json({ ok: false, error: '未配置 PRICE_SERVER_URL' });
  }

  try {
    // GET /api/trigger → 查询各市场最后更新状态
    if (req.method === 'GET') {
      const resp = await fetch(`${serverUrl}/status`, { signal: AbortSignal.timeout(8000) });
      const data = await resp.json();
      return res.json(data);
    }

    // POST /api/trigger { market, password }
    if (req.method === 'POST') {
      const { market, password } = req.body || {};
      if (!market) return res.status(400).json({ ok: false, error: '缺少 market 参数' });

      const resp = await fetch(`${serverUrl}/trigger/${market}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);
      return res.json(data);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.code === 'ECONNREFUSED') {
      return res.status(503).json({ ok: false, error: '价格更新服务未启动，请先运行 scripts/server.py' });
    }
    return res.status(500).json({ ok: false, error: e.message });
  }
};
