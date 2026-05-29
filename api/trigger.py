"""
Vercel Python 函数：直接调用 thsdk 更新收盘价
thsdk 游客模式，无需任何 token 或账户配置

Vercel 环境变量：
  DATABASE_URL      Neon 数据库连接串
  SUBMIT_PASSWORD   操作密码
"""

import json
import os
import sys
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

# 把 scripts/ 加入路径，复用 update_prices 里的函数
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from update_prices import update_cn, update_hk, update_us, get_db

TZ_CN = ZoneInfo("Asia/Shanghai")
PASSWORD = os.environ.get("SUBMIT_PASSWORD", "")

# 记录最后更新状态（Vercel serverless 无持久内存，仅本次请求有效）
_last_status: dict[str, str] = {}


def handler(request):
    """Vercel Python handler"""
    method = request.method

    # CORS
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
    }

    if method == "OPTIONS":
        return Response("", 200, headers)

    # GET → 返回空状态（serverless 无持久状态）
    if method == "GET":
        return Response(json.dumps({}), 200, headers)

    if method != "POST":
        return Response(json.dumps({"error": "Method not allowed"}), 405, headers)

    try:
        body = json.loads(request.body or "{}")
    except Exception:
        return Response(json.dumps({"ok": False, "error": "Invalid JSON"}), 400, headers)

    password = body.get("password", "")
    market   = body.get("market", "")

    if password != PASSWORD:
        return Response(json.dumps({"ok": False, "error": "密码错误"}), 401, headers)

    if market not in ("cn", "hk", "us"):
        return Response(json.dumps({"ok": False, "error": "未知市场"}), 400, headers)

    try:
        conn = get_db()
        try:
            if market == "cn":
                update_cn(conn)
            elif market == "hk":
                update_hk(conn)
            elif market == "us":
                update_us(conn)
        finally:
            conn.close()

        ts = datetime.now(TZ_CN).strftime("%H:%M:%S")
        return Response(
            json.dumps({"ok": True, "msg": f"{market.upper()} 更新完成 · {ts}"}),
            200, headers
        )
    except Exception as e:
        return Response(
            json.dumps({"ok": False, "error": str(e)}),
            500, headers
        )


class Response:
    def __init__(self, body, status=200, headers=None):
        self.body = body
        self.status_code = status
        self.headers = headers or {}
