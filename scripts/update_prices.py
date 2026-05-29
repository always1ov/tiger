"""
每日收盘后自动更新监控股票最新价格

收盘时间（北京时间）:
  A股:  15:00  → 建议 15:10 运行
  港股: 16:00  → 建议 16:15 运行
  美股: 次日 04:00（夏令时）/ 05:00（冬令时）→ 建议 04:30 / 05:30 运行

安装依赖:
  pip install thsdk psycopg2-binary python-dotenv

使用:
  python update_prices.py           # 更新全部
  python update_prices.py --cn      # 仅 A股
  python update_prices.py --hk      # 仅港股
  python update_prices.py --us      # 仅美股
  python update_prices.py --probe   # 打印第一只美股的原始返回字段（调试用）

环境变量 (.env 或 export):
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
    pass  # GitHub Actions 直接用环境变量，不需要 .env

TZ_CN = ZoneInfo("Asia/Shanghai")
TZ_US = ZoneInfo("America/New_York")

DB_URL = os.environ["DATABASE_URL"]

# ── 交易所代码 → THSCODE 前缀 ─────────────────────────────────────────────────
# 美股前缀第一次运行建议先跑 --probe 确认实际值
EXCHANGE_PREFIX = {
    "SH":      "USHA",    # 沪A
    "SZ":      "USZA",    # 深A
    "HK":      "USHK",    # 港股
    "US":      "USNAS",   # 美股（纳斯达克，大多数科技股）
    "NASDAQ":  "USNAS",
    "NYSE":    "USNYSE",
}

# 港股代码默认补齐位数
HK_CODE_LEN = 5

# 一批最多传多少只（保守 100，避免限速）
BATCH_SIZE = 100

# 批次间暂停（秒）
BATCH_SLEEP = 1.5


# ── 数据库操作 ────────────────────────────────────────────────────────────────

def get_db():
    return psycopg2.connect(DB_URL)


def fetch_stocks(conn, exchanges: list[str]) -> list[dict]:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, name, exchange, code
            FROM stocks
            WHERE exchange = ANY(%s) AND code IS NOT NULL AND code != ''
            ORDER BY exchange, code
            """,
            (exchanges,),
        )
        return cur.fetchall()


def fetch_us_stocks(conn) -> list[dict]:
    """美股：exchange 可能是 US / NASDAQ / NYSE / 空字符串，统一捞出来"""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, name, exchange, code, market
            FROM stocks
            WHERE market ILIKE '%美股%'
              AND code IS NOT NULL AND code != ''
            ORDER BY code
            """
        )
        return cur.fetchall()


def update_prices(conn, updates: list[tuple], price_date: str):
    """
    updates: [(stock_id, price), ...]
    更新 stocks.price / price_date，以及当天已有的 snapshot
    """
    if not updates:
        return
    with conn.cursor() as cur:
        for stock_id, price in updates:
            cur.execute(
                """
                UPDATE stocks
                SET price = %s, price_date = %s, updated_at = NOW()
                WHERE id = %s
                """,
                (price, price_date, stock_id),
            )
            cur.execute(
                """
                UPDATE snapshots
                SET price = %s, price_date = %s
                WHERE stock_id = %s AND report_date = %s
                """,
                (price, price_date, stock_id, price_date),
            )
    conn.commit()


def extract_price(row: dict) -> float | None:
    """兼容不同 THS SDK 版本的字段名"""
    for key in ("最新价", "收盘价", "close", "Close", "price", "Price"):
        v = row.get(key)
        if v is not None:
            try:
                return float(v)
            except (ValueError, TypeError):
                pass
    return None


def extract_thscode(row: dict) -> str:
    for key in ("THSCODE", "thscode", "代码", "code", "Code"):
        v = row.get(key)
        if v:
            return str(v)
    return ""


def _cn_hk_price_date() -> str:
    """A股/港股：15:00/16:00 后取今天，否则取上一个工作日（手动触发时不出错）"""
    now = datetime.now(TZ_CN)
    # 周六(5)周日(6) 或 还没收盘，取最近的工作日
    d = now.date()
    if now.weekday() == 5:          # 周六 → 周五
        d -= timedelta(days=1)
    elif now.weekday() == 6:        # 周日 → 周五
        d -= timedelta(days=2)
    elif now.weekday() == 0 and now.hour < 15:  # 周一未开盘 → 上周五
        d -= timedelta(days=3)
    return d.isoformat()


# ── A股（沪深）─────────────────────────────────────────────────────────────────

def update_cn(conn):
    stocks = fetch_stocks(conn, ["SH", "SZ"])
    if not stocks:
        print("[CN] 无 A股标的")
        return

    print(f"[CN] 数据库原始数据示例: exchange={stocks[0]['exchange']!r} code={stocks[0]['code']!r}")
    code_map = {}
    for s in stocks:
        prefix = EXCHANGE_PREFIX.get(s["exchange"].upper(), "")
        if prefix:
            thscode = f"{prefix}{s['code']}"
            code_map[thscode] = s["id"]

    _batch_update(conn, code_map, "market_data_cn", "[CN]", _cn_hk_price_date())


# ── 港股 ──────────────────────────────────────────────────────────────────────

def update_hk(conn):
    stocks = fetch_stocks(conn, ["HK"])
    if not stocks:
        print("[HK] 无港股标的")
        return

    print(f"[HK] 数据库原始数据示例: exchange={stocks[0]['exchange']!r} code={stocks[0]['code']!r}")
    code_map = {}
    for s in stocks:
        code = s["code"].lstrip("0").zfill(HK_CODE_LEN)
        thscode = f"USHK{code}"
        code_map[thscode] = s["id"]

    _batch_update(conn, code_map, "market_data_hk", "[HK]", _cn_hk_price_date())


# ── 美股 ──────────────────────────────────────────────────────────────────────

def update_us(conn):
    stocks = fetch_us_stocks(conn)
    if not stocks:
        print("[US] 无美股标的")
        return

    # 美股收盘日期：16:00 ET 后取今天，否则退一天，再跳过周末
    now_us = datetime.now(TZ_US)
    close_date = now_us.date() if now_us.hour >= 16 else (now_us - timedelta(days=1)).date()
    # 跳过周末（周六→周五，周日→周五）
    if close_date.weekday() == 5:
        close_date -= timedelta(days=1)
    elif close_date.weekday() == 6:
        close_date -= timedelta(days=2)

    code_map = {}
    for s in stocks:
        exchange = (s["exchange"] or "").upper()
        prefix = EXCHANGE_PREFIX.get(exchange, "USNAS")  # 默认纳斯达克
        thscode = f"{prefix}{s['code'].upper()}"
        code_map[thscode] = s["id"]

    _batch_update(conn, code_map, "market_data_us", "[US]",
                  close_date.isoformat())


def probe_us(conn):
    """打印第一只美股的原始返回字段，用于确认字段名和 THSCODE 前缀"""
    stocks = fetch_us_stocks(conn)
    if not stocks:
        print("[probe] 数据库里没有美股标的")
        return
    s = stocks[0]
    print(f"[probe] 测试股票: {s['name']} exchange={s['exchange']} code={s['code']}")

    for prefix in ("USNAS", "USNYSE", "USAMEX", "US"):
        thscode = f"{prefix}{s['code'].upper()}"
        print(f"  尝试 THSCODE: {thscode}")
        try:
            with THS() as ths:
                resp = ths.market_data_us(thscode, "基础数据")
                if resp.data:
                    print(f"  ✅ 成功！字段: {list(resp.data[0].keys())}")
                    print(f"  原始数据: {resp.data[0]}")
                    return
                else:
                    print(f"  返回空数据")
        except Exception as e:
            print(f"  ❌ 失败: {e}")
        time.sleep(1)

    print("[probe] 所有前缀均失败，请检查 THS 账号权限或代码格式")


# ── 通用批量请求 ───────────────────────────────────────────────────────────────

def _batch_update(conn, code_map: dict, method: str, tag: str, price_date: str):
    thscodes = list(code_map.keys())
    updates = []

    print(f"{tag} 共 {len(thscodes)} 只，分批请求（每批 {BATCH_SIZE} 只）…")

    with THS() as ths:
        fn = getattr(ths, method)
        for i in range(0, len(thscodes), BATCH_SIZE):
            batch = thscodes[i : i + BATCH_SIZE]
            try:
                print(f"  发送 THSCODE: {batch}")
                resp = fn(batch, "基础数据")
                print(f"  resp.data 类型: {type(resp.data)}, 值: {resp.data}")
                rows = resp.data or []
                batch_ok = 0
                for row in rows:
                    thscode = extract_thscode(row)
                    price   = extract_price(row)
                    if not thscode or price is None:
                        continue
                    stock_id = code_map.get(thscode)
                    if stock_id:
                        updates.append((stock_id, price))
                        batch_ok += 1
                print(f"  批次 {i//BATCH_SIZE + 1}: {len(batch)} 只请求，{batch_ok} 只有价格")
            except Exception as e:
                print(f"  批次 {i//BATCH_SIZE + 1} 失败: {e}")
            if i + BATCH_SIZE < len(thscodes):
                time.sleep(BATCH_SLEEP)

    update_prices(conn, updates, price_date)
    print(f"{tag} 更新完成：{len(updates)} 只写入数据库")


# ── 入口 ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="更新监控股票收盘价")
    parser.add_argument("--cn",    action="store_true", help="仅 A股")
    parser.add_argument("--hk",    action="store_true", help="仅港股")
    parser.add_argument("--us",    action="store_true", help="仅美股")
    parser.add_argument("--probe", action="store_true", help="调试：打印美股原始返回字段")
    args = parser.parse_args()

    any_flag = args.cn or args.hk or args.us or args.probe
    do_cn    = args.cn    or not any_flag
    do_hk    = args.hk    or not any_flag
    do_us    = args.us    or not any_flag

    conn = get_db()
    try:
        if args.probe:
            probe_us(conn)
            return
        if do_cn:
            update_cn(conn)
        if do_hk:
            update_hk(conn)
        if do_us:
            update_us(conn)
    finally:
        conn.close()

    print("全部完成")


if __name__ == "__main__":
    main()
