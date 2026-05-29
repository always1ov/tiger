"""
每日收盘后自动更新监控股票最新价格
腾讯行情 API，零依赖、无鉴权、港美A通吃

安装依赖:
  pip install psycopg2-binary

使用:
  python update_prices.py           # 更新全部
  python update_prices.py --cn      # 仅 A股
  python update_prices.py --hk      # 仅港股
  python update_prices.py --us      # 仅美股

环境变量:
  DATABASE_URL=postgresql://...
"""

import argparse
import os
import re
import time
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

TZ_CN = ZoneInfo("Asia/Shanghai")
TZ_US = ZoneInfo("America/New_York")
DB_URL = os.environ["DATABASE_URL"]

SLEEP = 0.5   # 每次请求间隔（秒），避免被限速


# ── 腾讯行情 ──────────────────────────────────────────────────────────────────

def fetch_tencent(market: str, code: str) -> dict | None:
    """
    market: "sh"/"sz"=A股, "hk"=港股, "us"=美股
    code:   数字或 ticker，如 "600519" / "03986" / "AAPL"
    返回: {price: float, date: str} 或 None
    """
    url = f"https://qt.gtimg.cn/q={market}{code}"
    try:
        req = urllib.request.Request(url, headers={"Referer": "https://finance.qq.com"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode("gbk")
        match = re.search(r'"(.+)"', raw)
        if not match:
            return None
        f = match.group(1).split("~")
        if len(f) < 36:
            return None
        price = float(f[3])
        date  = f[30][:10]
        if not price or not date:
            return None
        return {"price": price, "date": date}
    except Exception as e:
        print(f"    腾讯行情({market}{code}) 失败: {e}")
        return None


# ── 数据库 ────────────────────────────────────────────────────────────────────

def get_db():
    return psycopg2.connect(DB_URL)


def fetch_stocks(conn, filter_fn) -> list[dict]:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT id, name, exchange, code, market
            FROM stocks
            WHERE code IS NOT NULL AND code != ''
            ORDER BY market, exchange, code
        """)
        return [r for r in cur.fetchall() if filter_fn(r)]


def write_price(conn, stock_id: int, price: float, price_date: str):
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE stocks SET price=%s, price_date=%s, updated_at=NOW()
            WHERE id=%s
        """, (price, price_date, stock_id))
        cur.execute("""
            UPDATE snapshots SET price=%s, price_date=%s
            WHERE stock_id=%s AND report_date=%s
        """, (price, price_date, stock_id, price_date))
    conn.commit()


# ── 公共更新循环 ──────────────────────────────────────────────────────────────

def _run(conn, stocks: list[dict], tag: str, get_market_code):
    """
    get_market_code(stock) -> (market_prefix, code) 或 None
    """
    if not stocks:
        print(f"{tag} 无标的，跳过")
        return
    ok = 0
    for s in stocks:
        mc = get_market_code(s)
        if not mc:
            print(f"  跳过 {s['name']}（无法确定市场代码）")
            continue
        market, code = mc
        r = fetch_tencent(market, code)
        if r:
            write_price(conn, s["id"], r["price"], r["date"])
            print(f"  ✅ {s['name']} ({market}{code}): {r['price']}  [{r['date']}]")
            ok += 1
        else:
            print(f"  ⚠ {s['name']} ({market}{code}): 无数据")
        time.sleep(SLEEP)
    print(f"{tag} 完成：{ok}/{len(stocks)} 只写入")


# ── 三市场入口 ────────────────────────────────────────────────────────────────

def update_cn(conn):
    PREFIX = {"SH": "sh", "SZ": "sz"}
    stocks = fetch_stocks(conn, lambda s: s["exchange"] in PREFIX)
    _run(conn, stocks, "[CN]",
         lambda s: (PREFIX[s["exchange"]], s["code"]))


def update_hk(conn):
    stocks = fetch_stocks(conn, lambda s: s["exchange"] == "HK")
    _run(conn, stocks, "[HK]",
         lambda s: ("hk", s["code"].lstrip("0").zfill(5)))


def update_us(conn):
    stocks = fetch_stocks(conn, lambda s: s["market"] and "美股" in s["market"])
    _run(conn, stocks, "[US]",
         lambda s: ("us", s["code"]))


# ── 入口 ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cn", action="store_true")
    parser.add_argument("--hk", action="store_true")
    parser.add_argument("--us", action="store_true")
    args = parser.parse_args()

    any_flag = args.cn or args.hk or args.us

    conn = get_db()
    try:
        if args.cn or not any_flag: update_cn(conn)
        if args.hk or not any_flag: update_hk(conn)
        if args.us or not any_flag: update_us(conn)
    finally:
        conn.close()

    print("全部完成")


if __name__ == "__main__":
    main()
