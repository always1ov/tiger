// 触发 GitHub Actions workflow_dispatch 来更新收盘价
// Vercel 环境变量:
//   GITHUB_PAT   — GitHub Personal Access Token（需要 actions:write 权限）

const OWNER    = 'always1ov';
const REPO     = 'tiger';
const WORKFLOW = 'update_prices.yml';
const REF      = 'main';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const pat = process.env.GITHUB_PAT;
  if (!pat) {
    return res.status(503).json({ ok: false, error: '未配置 GITHUB_PAT，请在 Vercel 环境变量中添加' });
  }

  const { market, password } = req.body || {};
  if (password !== process.env.SUBMIT_PASSWORD) {
    return res.status(401).json({ ok: false, error: '密码错误' });
  }
  if (!['cn','hk','us','all'].includes(market)) {
    return res.status(400).json({ ok: false, error: '未知市场' });
  }

  const resp = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: REF, inputs: { market } }),
    }
  );

  // 204 = 触发成功
  if (resp.status === 204) {
    return res.json({ ok: true, msg: `${market.toUpperCase()} 更新任务已触发，GitHub Actions 运行中…` });
  }

  const text = await resp.text();
  return res.status(resp.status).json({ ok: false, error: `GitHub API 错误 ${resp.status}: ${text}` });
};
