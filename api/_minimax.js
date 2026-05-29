async function formatWithMinimax(text) {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('No MINIMAX_API_KEY');

  const systemPrompt = `You are a financial data parser. Parse stock report text into structured JSON.
Output ONLY valid JSON, no markdown, no explanation.

Output format:
{
  "market": "string (market label, e.g. 港A, 港美大A)",
  "report_date": "YYYY-MM-DD",
  "source": "string (analyst/source name)",
  "items": [
    {
      "name": "normalized Chinese stock name",
      "exchange": "HK|SH|SZ|US|etc",
      "code": "numeric or alphanumeric code",
      "up_pct": number or null,
      "down_pct": number or null,
      "channel_from": "state before =>",
      "channel_to": "state after =>",
      "price_type": "当前价格|关键价格|null",
      "price": number or null,
      "price_date": "YYYY-MM-DD or null"
    }
  ]
}

Rules:
- Normalize stock names: remove extra spaces, unify common aliases (e.g. 科创50/科创板50 -> 科创50)
- channel_from and channel_to come from "通道变化: X => Y"
- price_type is 当前价格 or 关键价格 based on label in text
- price_date only for 关键价格 with date in parentheses
- If a field is missing, use null`;

  const resp = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'MiniMax-Text-01',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      temperature: 0.1,
      max_tokens: 4096
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`MiniMax API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from MiniMax');

  // Strip markdown code fences if present
  const cleaned = content.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { formatWithMinimax };
