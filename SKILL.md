---
name: mt-farmer
description: "私有站点种子自动收割——逐页遍历、下载种子、添加到 Transmission 做种"
---

# MT Farmer – 私有站点种子收割

逐页浏览站点种子列表（按体积升序），自动下载 .torrent 并导入 Transmission 做种。

**核心特性：** 🔄 断点续传（segment/page/row） · 📐 体积分页法（突破 100 页窗口） · 🧹 自动清理 · 📅 每日/每小时限速 · 🔴 SIGINT 安全退出

## 前置条件

- OpenClaw browser plugin + CDP bridge
- Node.js v18+
- Transmission RPC 可访问
- 目标站点账号已登录（cookie 在 OpenClaw browser profile）

## 配置

通过环境变量，无配置文件：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BROWSE_URL` | — | 单个浏览页 URL（建议含体积升序排序） |
| `BROWSE_URL_LIST` | — | 多个 URL，换行或逗号分隔 |
| `DRY_RUN` | `true` | 只扫描不下载 |
| `DOWNLOADS_ENABLED` | `false` | 启用下载 |
| `ACK_SITE_RULES` | `false` | 确认遵守站点规则 |
| `TR_URL` | — | Transmission RPC 地址（下载时必填） |
| `TR_USER` | — | Transmission 用户名 |
| `TR_PASS` | — | Transmission 密码 |
| `SEGMENT_MAX_TORRENT_BYTES` | `367001600` (350MiB) | 超过则结束当前分段 |
| `SEGMENT_MIN_TORRENT_BYTES` | `0` (关闭) | 跳过低于此值的种子 |
| `DAILY_LIMIT` | `950` | 每日下载上限 |
| `HOURLY_LIMIT` | `90` | 每小时下载上限 |
| `BETWEEN_TORRENT` | `45000` | 种子间等待 (ms) |
| `MAX_PAGES` | `100` | 每个 URL 最大页数 |
| `CHECKPOINT_FILE` | `~/.mt_farmer_checkpoint.json` | 断点文件 |
| `LOG_FILE` | `~/.mt_farmer.log` | 日志文件 |
| `DL_DIR` | `/tmp/mt_downloads` | .torrent 临时目录 |

兼容旧变量名 `MT_BROWSE` / `MT_BROWSE_LIST`。

## 用法

### Dry-run 扫描（默认）

```bash
BROWSE_URL_LIST="$(cat browse-urls.txt)" \
node scripts/mt_farmer.js
```

### 正式下载

```bash
DRY_RUN=false \
DOWNLOADS_ENABLED=true \
ACK_SITE_RULES=true \
BROWSE_URL_LIST="$(cat browse-urls.txt)" \
TR_URL='http://x.x.x.x:50040/transmission/rpc' \
TR_USER='admin' TR_PASS='secret' \
SEGMENT_MIN_TORRENT_BYTES=220200960 \
SEGMENT_MAX_TORRENT_BYTES=367001600 \
node scripts/mt_farmer.js
```

## 100 页窗口突破

部分站点搜索结果限制前 100 页。用站点筛选条件（分类、日期、促销状态等）拆成多个 URL，通过 `BROWSE_URL_LIST` 依次跑：

```bash
BROWSE_URL_LIST='https://example.invalid/browse?sort=size:ascend&...filter-a
https://example.invalid/browse?sort=size:ascend&...filter-b' \
DRY_RUN=false DOWNLOADS_ENABLED=true ACK_SITE_RULES=true \
TR_URL=... TR_USER=... TR_PASS=... \
node scripts/mt_farmer.js
```

checkpoint 记录 `segment/page/row`，中断后从当前切片继续。

### URL 生成辅助

```bash
BASE_BROWSE_URL='https://example.invalid/browse?sort=size:ascend&...your-filter' \
START_YEAR=2015 END_YEAR=2026 TZ_OFFSET=10 \
npm run build:half-year-urls > browse-urls.txt
```
