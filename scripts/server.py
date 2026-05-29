"""
本地价格更新触发服务
在你的服务器/Mac 上运行，接收来自 Vercel 的触发请求

安装:
  pip install fastapi uvicorn thsdk psycopg2-binary python-dotenv

启动:
  python server.py
  # 或后台运行:
  nohup python server.py > logs/server.log 2>&1 &

如果在本地用 ngrok 暴露:
  ngrok http 8765
  然后把 ngrok URL 填到 Vercel 环境变量 PRICE_SERVER_URL
"""

import os
import threading
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

# 复用 update_prices 里的逻辑
from update_prices import update_cn, update_hk, update_us, get_db

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["POST"], allow_headers=["*"])

PASSWORD   = os.environ["SUBMIT_PASSWORD"]
TZ_CN      = ZoneInfo("Asia/Shanghai")
TZ_US      = ZoneInfo("America/New_York")

# 防止同一市场并发触发
_locks = {"cn": threading.Lock(), "hk": threading.Lock(), "us": threading.Lock()}
_status: dict[str, str] = {}   # market → 最后一次结果摘要


class TriggerReq(BaseModel):
    password: str


@app.post("/trigger/{market}")
def trigger(market: str, req: TriggerReq):
    if market not in ("cn", "hk", "us"):
        raise HTTPException(404, "未知市场")
    if req.password != PASSWORD:
        raise HTTPException(401, "密码错误")

    lock = _locks[market]
    if not lock.acquire(blocking=False):
        return {"ok": False, "msg": f"{market.upper()} 正在更新中，请稍候"}

    def run():
        try:
            conn = get_db()
            try:
                if market == "cn":
                    update_cn(conn)
                elif market == "hk":
                    update_hk(conn)
                elif market == "us":
                    update_us(conn)
                _status[market] = f"成功 · {datetime.now(TZ_CN).strftime('%H:%M:%S')}"
            finally:
                conn.close()
        except Exception as e:
            _status[market] = f"失败: {e}"
        finally:
            lock.release()

    threading.Thread(target=run, daemon=True).start()
    return {"ok": True, "msg": f"{market.upper()} 更新已在后台启动"}


@app.get("/status")
def status():
    return _status


if __name__ == "__main__":
    port = int(os.environ.get("PRICE_SERVER_PORT", 8765))
    print(f"价格更新服务启动在 http://0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
