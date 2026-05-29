# 定时任务设置

## 收盘时间对应北京时间

| 市场 | 收盘（当地） | 北京时间 | 建议运行时间 |
|------|-------------|----------|-------------|
| A股  | 15:00 CST   | 15:00    | 15:10       |
| 港股 | 16:00 HKT   | 16:00    | 16:15       |
| 美股 | 16:00 ET    | 次日 04:00（夏令时）/ 05:00（冬令时） | 次日 04:30 / 05:30 |

## 第一次使用前：探测美股字段

```bash
python scripts/update_prices.py --probe
```

会逐个尝试 `USNAS` / `USNYSE` 等前缀，打印出实际可用的字段名。
如果和脚本里默认的前缀不符，修改 `EXCHANGE_PREFIX["US"]` 对应的值。

## Crontab（Linux / Mac）

```bash
crontab -e
```

```
# A股：周一至周五 15:10
10 15 * * 1-5  cd /path/to/tiger && python scripts/update_prices.py --cn >> logs/prices.log 2>&1

# 港股：周一至周五 16:15
15 16 * * 1-5  cd /path/to/tiger && python scripts/update_prices.py --hk >> logs/prices.log 2>&1

# 美股：周二至周六 04:30（夏令时，3月-11月）
30 4 * * 2-6   cd /path/to/tiger && python scripts/update_prices.py --us >> logs/prices.log 2>&1

# 美股：周二至周六 05:30（冬令时，11月-3月）
# 30 5 * * 2-6  cd /path/to/tiger && python scripts/update_prices.py --us >> logs/prices.log 2>&1
```

## 依赖安装

```bash
pip install thsdk psycopg2-binary python-dotenv
```

## .env 配置

```
DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require
```
