"""
每日收盘后自动更新监控股票最新价格
thsdk 游客模式，用 search_symbols 获取准确 THSCODE

收盘时间（北京时间）:
  A股:  15:00  → 建议 15:10 运行
  港股: 16:00  → 建议 16:15 运行
  美股: 次日 04:00（夏令时）/ 05:00（冬令时）→ 建议 04:30 / 05:30 运行

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

BATCH_SLEEP = 1.0   # 每次请求间隔（秒）


# ── 数据库 ────────────────────────────────────────────────────────────────────

def get_db():
    return psycopg2.connect(DB_URL)


def fetch_all_stocks(conn) -> list[dict]:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT id, name, exchange, code, market, thscode
            FROM stocks
            WHERE code IS NOT NULL AND code != ''
            ORDER BY market, exchange, code
        """)
        return cur.fetchall()


def ensure_thscode_column(conn):
    """如果 thscode 列不存在则添加"""
    with conn.cursor() as cur:
        cur.execute("""
            ALTER TABLE stocks ADD COLUMN IF NOT EXISTS thscode TEXT
        """)
    conn.commit()


def save_thscode(conn, stock_id: int, thscode: str):
    with conn.cursor() as cur:
        cur.execute("UPDATE stocks SET thscode = %s WHERE id = %s", (thscode, stock_id))
    conn.commit()


def write_price(conn, stock_id: int, price: float, price_date: str):
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE stocks SET price = %s, price_date = %s, updated_at = NOW()
            WHERE id = %s
        """, (price, price_date, stock_id))
        cur.execute("""
            UPDATE snapshots SET price = %s, price_date = %s
            WHERE stock_id = %s AND report_date = %s
        """, (price, price_date, stock_id, price_date))
    conn.commit()


# ── THSCODE 解析 ──────────────────────────────────────────────────────────────

def resolve_thscode(ths, stock: dict) -> str | None:
    """
    优先用数据库缓存的 thscode。
    没有则用 search_symbols 查询，选最匹配的结果并缓存。
    """
    # 已缓存
    if stock.get("thscode"):
        return stock["thscode"]

    name     = stock["name"]
    code     = stock["code"]
    market   = (stock["market"] or "").lower()
    exchange = (stock["exchange"] or "").upper()

    try:
        resp = ths.search_symbols(code)
        results = resp.data or []
    except Exception as e:
        print(f"  search_symbols({code}) 失败: {e}")
        return None

    if not results:
        print(f"  search_symbols({code}) 无结果")
        return None

    print(f"  search_symbols({code}) 返回 {len(results)} 条: {[r.get('THSCODE') for r in results[:5]]}")

    # 按市场过滤选最合适的
    def score(r):
        mkt = r.get("MarketDisplay", "")
        ts  = r.get("THSCODE", "")
        s = 0
        if "美股" in market or exchange in ("US", "NASDAQ", "NYSE"):
            if any(x in mkt for x in ["纳斯达克", "纽交所", "美股", "NYSE", "NASDAQ"]): s += 10
        elif "港" in market or exchange == "HK":
            if "港" in mkt: s += 10
        elif exchange == "SH":
            if "沪" in mkt: s += 10
        elif exchange == "SZ":
            if "深" in mkt: s += 10
        elif "A" in market:
            if any(x in mkt for x in ["沪", "深"]): s += 5
        # 代码完全匹配加分
        if ts.endswith(code.upper()) or ts.endswith(code.lstrip("0")): s += 5
        return s

    best = max(results, key=score)
    thscode = best.get("THSCODE")
    print(f"  选定 THSCODE: {thscode}  市场: {best.get('MarketDisplay')}")
    return thscode


# ── 价格提取 ──────────────────────────────────────────────────────────────────

def get_price_from_df(df) -> float | None:
    if df is None or df.empty:
        return None
    row = df.iloc[0]
    for col in ("最新价", "收盘价", "现价", "close", "Close", "last", "price"):
        v = row.get(col)
        if v is not None and str(v) not in ("", "nan", "None", "--", "0"):
            try:
                f = float(v)
                if f > 0:
                    return f
            except (ValueError, TypeError):
                pass
    print(f"  列名: {list(df.columns)}, 首行: {row.to_dict()}")
    return None


# ── 日期计算 ──────────────────────────────────────────────────────────────────

def cn_hk_price_date() -> str:
    now = datetime.now(TZ_CN)
    d = now.date()
    if now.weekday() == 5:
        d -= timedelta(days=1)
    elif now.weekday() == 6:
        d -= timedelta(days=2)
    elif now.weekday() == 0 and now.hour < 15:
        d -= timedelta(days=3)
    return d.isoformat()


def us_price_date() -> str:
    now_us = datetime.now(TZ_US)
    d = now_us.date() if now_us.hour >= 16 else (now_us - timedelta(days=1)).date()
    if d.weekday() == 5:
        d -= timedelta(days=1)
    elif d.weekday() == 6:
        d -= timedelta(days=2)
    return d.isoformat()


# ── 通用更新逻辑 ───────────────────────────────────────────────────────────────

def _update_market(conn, stocks: list[dict], market_fn_name: str, tag: str, price_date: str):
    if not stocks:
        print(f"{tag} 无标的")
        return

    ok = 0
    with THS() as ths:
        market_fn = getattr(ths, market_fn_name)
        for s in stocks:
            thscode = resolve_thscode(ths, s)
            if not thscode:
                print(f"  跳过 {s['name']}（无法解析 THSCODE）")
                time.sleep(BATCH_SLEEP)
                continue

            # 缓存 THSCODE 到数据库
            if not s.get("thscode"):
                save_thscode(conn, s["id"], thscode)

            try:
                resp = market_fn(thscode, "基础数据")
                price = get_price_from_df(resp.df)
                if price:
                    write_price(conn, s["id"], price, price_date)
                    print(f"  ✅ {s['name']} ({thscode}): {price}")
                    ok += 1
                else:
                    print(f"  ⚠ {s['name']} ({thscode}): 无价格数据")
            except Exception as e:
                print(f"  ❌ {s['name']} ({thscode}): {e}")

            time.sleep(BATCH_SLEEP)

    print(f"{tag} 完成：{ok}/{len(stocks)} 只写入")


# ── 各市场入口 ────────────────────────────────────────────────────────────────

def update_cn(conn):
    stocks = [s for s in fetch_all_stocks(conn)
              if s["exchange"] in ("SH", "SZ")]
    _update_market(conn, stocks, "market_data_cn", "[CN]", cn_hk_price_date())


def update_hk(conn):
    stocks = [s for s in fetch_all_stocks(conn)
              if s["exchange"] == "HK"]
    _update_market(conn, stocks, "market_data_hk", "[HK]", cn_hk_price_date())


def update_us(conn):
    stocks = [s for s in fetch_all_stocks(conn)
              if s["market"] and "美股" in s["market"]]
    _update_market(conn, stocks, "market_data_us", "[US]", us_price_date())


# ── 入口 ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cn",  action="store_true")
    parser.add_argument("--hk",  action="store_true")
    parser.add_argument("--us",  action="store_true")
    args = parser.parse_args()

    any_flag = args.cn or args.hk or args.us
    do_cn = args.cn or not any_flag
    do_hk = args.hk or not any_flag
    do_us = args.us or not any_flag

    conn = get_db()
    try:
        ensure_thscode_column(conn)
        if do_cn: update_cn(conn)
        if do_hk: update_hk(conn)
        if do_us: update_us(conn)
    finally:
        conn.close()

    print("全部完成")


if __name__ == "__main__":
    main()
