// 代理到外部价格更新服务（scripts/server.py）
// 在 Vercel 环境变量中设置 PRICE_SERVER_URL
// 例: http://your-vps-ip:8765 或 ngrok URL

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const serverUrl = process.env.PRICE_SERVER_URL;
  if (!serverUrl) {
    return res.status(503).json({ ok: false, error: '价格更新服务未配置（PRICE_SERVER_URL 未设置）' });
  }

  try {
    if (req.method === 'GET') {
      const resp = await fetch(`${serverUrl}/status`, { signal: AbortSignal.timeout(8000) });
      return res.json(await resp.json());
    }

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
      return res.status(resp.ok ? 200 : resp.status).json(data);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    const offline = e.name === 'TimeoutError' || e.code === 'ECONNREFUSED' || e.cause?.code === 'ECONNREFUSED';
    return res.status(503).json({
      ok: false,
      error: offline ? '价格更新服务未启动，请先运行 scripts/server.py' : e.message
    });
  }
};
