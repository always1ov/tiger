"""
每日收盘后自动更新监控股票最新价格
thsdk 游客模式，无需账户配置

安装依赖:
  pip install thsdk psycopg2-binary

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
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras
from thsdk import THS

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

TZ_CN = ZoneInfo("Asia/Shanghai")
TZ_US = ZoneInfo("America/New_York")
DB_URL = os.environ["DATABASE_URL"]

SLEEP = 0.5   # 每次请求间隔（秒）

# ── 正确的 THSCODE 前缀（来自官方示范代码）────────────────────────────────────
# HK:  UHKG + 5位代码（补前导零）  如 UHKG00700
# A股: USHA + 6位代码（沪）        如 USHA600519
#      USZA + 6位代码（深）        如 USZA300033
# 美股: 用 search_symbols 确定前缀，NASDAQ=UNQQ，NYSE 等各异

CN_PREFIX  = {"SH": "USHA", "SZ": "USZA"}
HK_PREFIX  = "UHKG"
HK_CODELEN = 5


# ── 数据库 ────────────────────────────────────────────────────────────────────

def get_db():
    return psycopg2.connect(DB_URL)


def ensure_thscode_column(conn):
    with conn.cursor() as cur:
        cur.execute("ALTER TABLE stocks ADD COLUMN IF NOT EXISTS thscode TEXT")
    conn.commit()


def fetch_all_stocks(conn) -> list[dict]:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT id, name, exchange, code, market,
                   COALESCE(thscode, '') AS thscode
            FROM stocks
            WHERE code IS NOT NULL AND code != ''
            ORDER BY market, exchange, code
        """)
        return cur.fetchall()


def save_thscode(conn, stock_id: int, thscode: str):
    with conn.cursor() as cur:
        cur.execute("UPDATE stocks SET thscode=%s WHERE id=%s", (thscode, stock_id))
    conn.commit()


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


# ── THSCODE 解析 ──────────────────────────────────────────────────────────────

def resolve_thscode(ths, stock: dict) -> str | None:
    """
    有缓存直接返回；否则用 search_symbols 查找并缓存。
    """
    if stock["thscode"]:
        return stock["thscode"]

    code     = stock["code"]
    exchange = (stock["exchange"] or "").upper()
    market   = (stock["market"] or "").lower()

    # A股和港股可以直接拼，不用 search_symbols
    if exchange in CN_PREFIX:
        return f"{CN_PREFIX[exchange]}{code}"
    if exchange == "HK":
        # 先去掉前导零再补齐，避免重复前导零
        return f"{HK_PREFIX}{code.lstrip('0').zfill(HK_CODELEN)}"

    # 美股等用 search_symbols 确定准确前缀
    try:
        resp    = ths.search_symbols(code)
        results = resp.data or []
    except Exception as e:
        print(f"    search_symbols({code}) 失败: {e}")
        return None

    if not results:
        print(f"    search_symbols({code}) 无结果")
        return None

    # 选美股相关的第一条
    for r in results:
        mkt = r.get("MarketDisplay", "")
        if any(x in mkt for x in ["纳斯达克", "纽交所", "美股", "NYSE", "NASDAQ"]):
            ts = r.get("THSCODE", "")
            print(f"    search_symbols({code}) → {ts} [{mkt}]")
            return ts

    # 没匹配到则取第一条
    ts = results[0].get("THSCODE", "")
    print(f"    search_symbols({code}) → {ts} [{results[0].get('MarketDisplay')}]（默认第一条）")
    return ts


# ── 日期计算 ──────────────────────────────────────────────────────────────────

def cn_hk_date() -> str:
    now = datetime.now(TZ_CN)
    d   = now.date()
    if d.weekday() == 5: d -= timedelta(days=1)
    elif d.weekday() == 6: d -= timedelta(days=2)
    elif d.weekday() == 0 and now.hour < 15: d -= timedelta(days=3)
    return d.isoformat()


def us_date() -> str:
    now = datetime.now(TZ_US)
    d   = now.date() if now.hour >= 16 else (now - timedelta(days=1)).date()
    if d.weekday() == 5: d -= timedelta(days=1)
    elif d.weekday() == 6: d -= timedelta(days=2)
    return d.isoformat()


# ── 更新逻辑 ──────────────────────────────────────────────────────────────────

def _update(conn, stocks: list[dict], market_key: str, tag: str, price_date: str):
    if not stocks:
        print(f"{tag} 无标的，跳过")
        return

    fn_map = {"cn": "market_data_cn", "hk": "market_data_hk", "us": "market_data_us"}
    fn_name = fn_map[market_key]
    ok = 0

    with THS() as ths:
        fn = getattr(ths, fn_name)
        for s in stocks:
            thscode = resolve_thscode(ths, s)
            if not thscode:
                print(f"  跳过 {s['name']}（无法获取 THSCODE）")
                continue

            # 缓存到数据库
            if not s["thscode"] and thscode:
                save_thscode(conn, s["id"], thscode)

            try:
                resp = fn(thscode, "基础数据")
                if resp and resp.data:
                    d     = resp.data[0]
                    price = d.get("价格") or d.get("最新价") or d.get("收盘价")
                    if price:
                        price = float(price)
                        write_price(conn, s["id"], price, price_date)
                        print(f"  ✅ {s['name']} ({thscode}): {price}")
                        ok += 1
                    else:
                        print(f"  ⚠ {s['name']} ({thscode}): 字段未找到 keys={list(d.keys())}")
                else:
                    print(f"  ⚠ {s['name']} ({thscode}): resp.data 为空")
            except Exception as e:
                print(f"  ❌ {s['name']} ({thscode}): {e}")

            time.sleep(SLEEP)

    print(f"{tag} 完成：{ok}/{len(stocks)} 只写入（日期 {price_date}）")


def update_cn(conn):
    stocks = [s for s in fetch_all_stocks(conn) if s["exchange"] in ("SH", "SZ")]
    _update(conn, stocks, "cn", "[CN]", cn_hk_date())


def update_hk(conn):
    stocks = [s for s in fetch_all_stocks(conn) if s["exchange"] == "HK"]
    _update(conn, stocks, "hk", "[HK]", cn_hk_date())


def update_us(conn):
    stocks = [s for s in fetch_all_stocks(conn)
              if s["market"] and "美股" in s["market"]]
    _update(conn, stocks, "us", "[US]", us_date())


# ── 入口 ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cn", action="store_true")
    parser.add_argument("--hk", action="store_true")
    parser.add_argument("--us", action="store_true")
    args = parser.parse_args()

    any_flag = args.cn or args.hk or args.us

    conn = get_db()
    try:
        ensure_thscode_column(conn)
        if args.cn or not any_flag: update_cn(conn)
        if args.hk or not any_flag: update_hk(conn)
        if args.us or not any_flag: update_us(conn)
    finally:
        conn.close()

    print("全部完成")


if __name__ == "__main__":
    main()
