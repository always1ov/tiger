# 定时任务设置

## Crontab（Linux / Mac）

```bash
# 编辑 crontab
crontab -e

# A股：周一至周五 15:10（北京时间）更新
10 15 * * 1-5 cd /path/to/tiger && python scripts/update_prices.py --cn >> logs/prices.log 2>&1

# 港股：周一至周五 16:15（北京时间）更新
15 16 * * 1-5 cd /path/to/tiger && python scripts/update_prices.py --hk >> logs/prices.log 2>&1
```

## .env 配置

在 `scripts/` 目录或项目根目录创建 `.env`：

```
DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require
```

## 依赖安装

```bash
pip install thsdk psycopg2-binary python-dotenv
```
