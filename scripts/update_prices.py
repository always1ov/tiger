"""
每日收盘后自动更新监控股票最新价格
- A股: 15:05 后运行（沪深收盘 15:00）
- 港股: 16:10 后运行（港股收盘 16:00）

安装依赖:
  pip install thsdk psycopg2-binary python-dotenv

使用:
  python update_prices.py          # 更新全部（A股 + 港股）
  python update_prices.py --cn     # 仅 A股
  python update_prices.py --hk     # 仅港股

环境变量 (放在 .env 或直接 export):
  DATABASE_URL=postgresql://...
"""

import argparse
import os
import time
from datetime import date, datetime
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from thsdk import THS

load_dotenv()

TZ = ZoneInfo("Asia/Shanghai")
DB_URL = os.environ["DATABASE_URL"]

# ── 交易所代码 → THSCODE 前缀 ─────────────────────────────────────────────────
EXCHANGE_PREFIX = {
    "SH":  "USHA",   # 沪A
    "SZ":  "USZA",   # 深A
    "HK":  "USHK",   # 港股
}

# 一批最多传多少只（THS 建议不超过 200，保守用 100）
BATCH_SIZE = 100

# 批次间暂停秒数，避免触发限速
BATCH_SLEEP = 1.5


def get_db():
    return psycopg2.connect(DB_URL)


def fetch_stocks(conn, markets: list[str]) -> list[dict]:
    """从 stocks 表取出需要更新的股票，只取指定交易所"""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, name, exchange, code
            FROM stocks
            WHERE exchange = ANY(%s) AND code IS NOT NULL AND code != ''
            ORDER BY exchange, code
            """,
            (markets,),
        )
        return cur.fetchall()


def to_thscode(exchange: str, code: str) -> str | None:
    prefix = EXCHANGE_PREFIX.get(exchange.upper())
    if not prefix:
        return None
    # 港股代码补齐 5 位
    if exchange.upper() == "HK":
        code = code.lstrip("0").zfill(5)
    return f"{prefix}{code}"


def update_prices(conn, updates: list[tuple]):
    """
    updates: [(stock_id, price, price_date), ...]
    同时更新 stocks 表的 price/price_date，以及当天 snapshot（如已存在）
    """
    if not updates:
        return
    today = date.today().isoformat()
    with conn.cursor() as cur:
        for stock_id, price, price_date in updates:
            # 更新 stocks 当前价格
            cur.execute(
                """
                UPDATE stocks
                SET price = %s, price_date = %s, updated_at = NOW()
                WHERE id = %s
                """,
                (price, price_date, stock_id),
            )
            # 如果今天已有 snapshot，顺便把价格也更新进去
            cur.execute(
                """
                UPDATE snapshots
                SET price = %s, price_date = %s
                WHERE stock_id = %s AND report_date = %s
                """,
                (price, price_date, stock_id, today),
            )
    conn.commit()


# ── A股 & ETF（沪深）批量更新 ─────────────────────────────────────────────────

def update_cn(conn):
    stocks = fetch_stocks(conn, ["SH", "SZ"])
    if not stocks:
        print("[CN] 无 A 股标的")
        return

    # 构建 thscode → stock_id 映射
    code_map = {}
    for s in stocks:
        thscode = to_thscode(s["exchange"], s["code"])
        if thscode:
            code_map[thscode] = s["id"]

    thscodes = list(code_map.keys())
    today = date.today().isoformat()
    updates = []

    print(f"[CN] 共 {len(thscodes)} 只，分批请求（每批 {BATCH_SIZE} 只）…")

    with THS() as ths:
        for i in range(0, len(thscodes), BATCH_SIZE):
            batch = thscodes[i : i + BATCH_SIZE]
            try:
                resp = ths.market_data_cn(batch, "基础数据")
                for row in resp.data:
                    thscode = row.get("THSCODE") or row.get("代码") or ""
                    price   = row.get("最新价") or row.get("收盘价")
                    if not thscode or price is None:
                        continue
                    stock_id = code_map.get(thscode)
                    if stock_id:
                        updates.append((stock_id, float(price), today))
                print(f"  批次 {i//BATCH_SIZE + 1}: 获取 {len(batch)} 只，成功 {len(updates) - sum(1 for _ in updates[:i])} 只")
            except Exception as e:
                print(f"  批次 {i//BATCH_SIZE + 1} 失败: {e}")
            if i + BATCH_SIZE < len(thscodes):
                time.sleep(BATCH_SLEEP)

    update_prices(conn, updates)
    print(f"[CN] 更新完成：{len(updates)} 只")


# ── 港股批量更新 ───────────────────────────────────────────────────────────────

def update_hk(conn):
    stocks = fetch_stocks(conn, ["HK"])
    if not stocks:
        print("[HK] 无港股标的")
        return

    code_map = {}
    for s in stocks:
        thscode = to_thscode(s["exchange"], s["code"])
        if thscode:
            code_map[thscode] = s["id"]

    thscodes = list(code_map.keys())
    today = date.today().isoformat()
    updates = []

    print(f"[HK] 共 {len(thscodes)} 只，分批请求（每批 {BATCH_SIZE} 只）…")

    with THS() as ths:
        for i in range(0, len(thscodes), BATCH_SIZE):
            batch = thscodes[i : i + BATCH_SIZE]
            try:
                resp = ths.market_data_hk(batch, "基础数据")
                for row in resp.data:
                    thscode = row.get("THSCODE") or row.get("代码") or ""
                    price   = row.get("最新价") or row.get("收盘价")
                    if not thscode or price is None:
                        continue
                    stock_id = code_map.get(thscode)
                    if stock_id:
                        updates.append((stock_id, float(price), today))
                print(f"  批次 {i//BATCH_SIZE + 1}: 获取 {len(batch)} 只")
            except Exception as e:
                print(f"  批次 {i//BATCH_SIZE + 1} 失败: {e}")
            if i + BATCH_SIZE < len(thscodes):
                time.sleep(BATCH_SLEEP)

    update_prices(conn, updates)
    print(f"[HK] 更新完成：{len(updates)} 只")


# ── 入口 ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="更新监控股票收盘价")
    parser.add_argument("--cn", action="store_true", help="仅更新 A股")
    parser.add_argument("--hk", action="store_true", help="仅更新港股")
    args = parser.parse_args()

    do_cn = args.cn or (not args.cn and not args.hk)
    do_hk = args.hk or (not args.cn and not args.hk)

    conn = get_db()
    try:
        if do_cn:
            update_cn(conn)
        if do_hk:
            update_hk(conn)
    finally:
        conn.close()

    print("全部完成")


if __name__ == "__main__":
    main()
