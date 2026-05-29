function parseLocal(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // ── Header: 【市场】日期 来源 ──────────────────────────────────────────────
  let market = '', report_date = '', source = '';

  // Try ISO date: 【市场】 2026-05-29 来源
  let headerMatch = text.match(/【([^】]+)】\s*(\d{4}-\d{2}-\d{2})\s+(.+)/);
  // Try slash date: 【市场】 2026/05/29 来源
  if (!headerMatch) {
    const m = text.match(/【([^】]+)】\s*(\d{4})[\/.](\d{2})[\/.](\d{2})\s+(.+)/);
    if (m) headerMatch = [null, m[1], `${m[2]}-${m[3]}-${m[4]}`, m[5]];
  }
  // Try Chinese date: 【市场】 2026年05月29日 来源
  if (!headerMatch) {
    const m = text.match(/【([^】]+)】\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s+(.+)/);
    if (m) headerMatch = [null, m[1], `${m[2]}-${m[3].padStart(2,'0')}-${m[4].padStart(2,'0')}`, m[5]];
  }

  if (headerMatch) {
    market      = headerMatch[1].trim();
    report_date = headerMatch[2].trim();
    // source is everything on that line after date; trim off any trailing separators
    source = headerMatch[3].trim().replace(/[-—–\s]+$/, '');
  }

  const items = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('===') || line.startsWith('———')) continue;

    // ── Stock header ──────────────────────────────────────────────────────────
    // Case 1: 名称(EXCHANGE.CODE) :    e.g. 兆易创新(HK.03986) :
    const m1 = line.match(/^(.+?)\(([A-Za-z]+)\.([^)]+)\)\s*[:：]/);
    if (m1) {
      if (current) items.push(current);
      current = newItem(m1[1], m1[2].toUpperCase(), m1[3]);
      continue;
    }
    // Case 2: 名称(CODE) :            e.g. Robinhood(HOOD) :  or  兆易创新(03986) :
    const m2 = line.match(/^(.+?)\(([^)]+)\)\s*[:：]/);
    if (m2) {
      if (current) items.push(current);
      // Detect if code looks like an exchange-prefixed code without dot (rare)
      current = newItem(m2[1], null, m2[2]);
      continue;
    }

    if (!current) continue;

    // ── 上涨配置 / 下跌配置 ───────────────────────────────────────────────────
    // Same line: 上涨配置:6.0%,下跌配置:6.0%
    const pctSame = line.match(/上涨配置[:：]([\d.]+)%[,，\s]+下跌配置[:：]([\d.]+)%/);
    if (pctSame) {
      current.up_pct   = parseFloat(pctSame[1]);
      current.down_pct = parseFloat(pctSame[2]);
      continue;
    }
    // Separate lines
    const upOnly  = line.match(/^上涨配置[:：]([\d.]+)%/);
    const dnOnly  = line.match(/^下跌配置[:：]([\d.]+)%/);
    if (upOnly) { current.up_pct   = parseFloat(upOnly[1]);  continue; }
    if (dnOnly) { current.down_pct = parseFloat(dnOnly[1]);  continue; }

    // ── 通道变化 ──────────────────────────────────────────────────────────────
    // With arrow: 通道变化:X => Y
    const chChange = line.match(/通道变化[:：](.+?)\s*=>\s*(.+)/);
    if (chChange) {
      current.channel_from = chChange[1].trim();
      current.channel_to   = chChange[2].trim();
      continue;
    }
    // No arrow (staying in same state): 通道变化:上涨趋势
    const chStay = line.match(/^通道变化[:：]([^=>]+)$/);
    if (chStay) {
      const state = chStay[1].trim();
      current.channel_from = state;
      current.channel_to   = state;
      continue;
    }

    // ── 价格 ──────────────────────────────────────────────────────────────────
    // 当前价格:738.5
    const curPrice = line.match(/当前价格[:：]([\d,.]+)/);
    if (curPrice) {
      current.price_type = '当前价格';
      current.price      = parseFloat(curPrice[1].replace(/,/g, ''));
      continue;
    }
    // 关键价格:1896.0369(2026-05-25)
    const keyPrice = line.match(/关键价格[:：]([\d,.]+)(?:\((\d{4}-\d{2}-\d{2})\))?/);
    if (keyPrice) {
      current.price_type = '关键价格';
      current.price      = parseFloat(keyPrice[1].replace(/,/g, ''));
      current.price_date = keyPrice[2] || null;
      continue;
    }
    // 价格:738.5 (generic fallback)
    const genPrice = line.match(/^价格[:：]([\d,.]+)/);
    if (genPrice && !current.price) {
      current.price_type = '当前价格';
      current.price      = parseFloat(genPrice[1].replace(/,/g, ''));
      continue;
    }
  }

  if (current) items.push(current);
  return { market, report_date, source, items };
}

function newItem(name, exchange, code) {
  return {
    name:         name.trim(),
    exchange:     exchange || null,
    code:         code.trim(),
    up_pct:       null,
    down_pct:     null,
    channel_from: null,
    channel_to:   null,
    price_type:   null,
    price:        null,
    price_date:   null,
  };
}

module.exports = { parseLocal };
