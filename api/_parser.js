// Fallback local regex parser
export function parseLocal(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Parse header: 【市场】日期 来源
  let market = '', report_date = '', source = '';
  const headerMatch = text.match(/【([^】]+)】\s*(\d{4}-\d{2}-\d{2})\s+(.+)/);
  if (headerMatch) {
    market = headerMatch[1].trim();
    report_date = headerMatch[2].trim();
    source = headerMatch[3].trim();
  }

  const items = [];
  let current = null;

  for (const line of lines) {
    // Stock header: 名称(EXCHANGE.CODE) :
    const stockMatch = line.match(/^(.+?)\(([A-Z]+)\.([^)]+)\)\s*[:：]/);
    if (stockMatch) {
      if (current) items.push(current);
      current = {
        name: stockMatch[1].trim(),
        exchange: stockMatch[2].trim(),
        code: stockMatch[3].trim(),
        up_pct: null,
        down_pct: null,
        channel_from: null,
        channel_to: null,
        price_type: null,
        price: null,
        price_date: null
      };
      continue;
    }
    if (!current) continue;

    // 上涨配置:X%,下跌配置:Y%
    const pctMatch = line.match(/上涨配置[:：]([\d.]+)%.*下跌配置[:：]([\d.]+)%/);
    if (pctMatch) {
      current.up_pct = parseFloat(pctMatch[1]);
      current.down_pct = parseFloat(pctMatch[2]);
      continue;
    }

    // 通道变化:X => Y
    const channelMatch = line.match(/通道变化[:：](.+?)\s*=>\s*(.+)/);
    if (channelMatch) {
      current.channel_from = channelMatch[1].trim();
      current.channel_to = channelMatch[2].trim();
      continue;
    }

    // 当前价格:数字
    const curPriceMatch = line.match(/当前价格[:：]([\d.]+)/);
    if (curPriceMatch) {
      current.price_type = '当前价格';
      current.price = parseFloat(curPriceMatch[1]);
      continue;
    }

    // 关键价格:数字(日期)
    const keyPriceMatch = line.match(/关键价格[:：]([\d.]+)(?:\((\d{4}-\d{2}-\d{2})\))?/);
    if (keyPriceMatch) {
      current.price_type = '关键价格';
      current.price = parseFloat(keyPriceMatch[1]);
      current.price_date = keyPriceMatch[2] || null;
      continue;
    }
  }

  if (current) items.push(current);

  return { market, report_date, source, items };
}
