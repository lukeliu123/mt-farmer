# mt-farmer

私有站点种子批量收割工具。逐页遍历种子列表（按体积升序），自动下载 `.torrent` 并导入 Transmission 做种。

**核心特性：** 🔄 断点续传（segment/page/row） · 📐 体积分页法（突破 100 页窗口） · 🧹 自动清理 · 📅 每日/每小时限速 · 🔴 SIGINT 安全退出

## 运行方式

两种模式，功能一致：

| 方式 | 文件 | 依赖 |
|------|------|------|
| OpenClaw / CDP | `scripts/mt_farmer.js` | OpenClaw browser plugin |
| Puppeteer 独立 | `scripts/mt_farmer_standalone.js` | Puppeteer |

## 快速开始

```bash
# 安装
npm install

# Dry-run 扫描（只看不下载，验证配置）
BROWSE_URL_LIST="$(cat browse-urls.txt)" \
npm run start:openclaw

# 正式下载
DRY_RUN=false \
DOWNLOADS_ENABLED=true \
ACK_SITE_RULES=true \
BROWSE_URL_LIST="$(cat browse-urls.txt)" \
TR_URL='http://your-nas:9091/transmission/rpc' \
TR_USER='user' TR_PASS='pass' \
SEGMENT_MIN_TORRENT_BYTES=220200960 \
SEGMENT_MAX_TORRENT_BYTES=367001600 \
npm run start:openclaw
```

> ⚠️ 默认 `DRY_RUN=true`。正式下载需同时设置三个开关：`DRY_RUN=false` + `DOWNLOADS_ENABLED=true` + `ACK_SITE_RULES=true`。

## 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BROWSE_URL` | — | 单个浏览页 URL（建议含体积升序排序） |
| `BROWSE_URL_LIST` | — | 多个 URL，换行或逗号分隔 |
| `DRY_RUN` | `true` | 只扫描不下载 |
| `DOWNLOADS_ENABLED` | `false` | 启用下载（需配合 `DRY_RUN=false`） |
| `ACK_SITE_RULES` | `false` | 确认遵守站点规则 |
| `TR_URL` | — | Transmission RPC 地址 |
| `TR_USER` | — | Transmission 用户名 |
| `TR_PASS` | — | Transmission 密码 |
| `SEGMENT_MAX_TORRENT_BYTES` | `367001600` (350MiB) | 超过此体积则结束当前分段 |
| `SEGMENT_MIN_TORRENT_BYTES` | `0` (关闭) | 跳过低于此体积的种子 |
| `DAILY_LIMIT` | `1200` | 每日下载上限 |
| `HOURLY_LIMIT` | `90` | 每小时下载上限 |
| `BETWEEN_TORRENT` | `45000` | 种子间等待 (ms) |
| `MAX_PAGES` | `100` | 每个 URL 最大页数 |
| `CHECKPOINT_FILE` | `~/.mt_farmer_checkpoint.json` | 断点文件 |
| `LOG_FILE` | `~/.mt_farmer.log` | 日志文件 |
| `DL_DIR` | `/tmp/mt_downloads` | .torrent 临时目录 |

兼容旧变量名 `MT_BROWSE` / `MT_BROWSE_LIST`。

## 100 页窗口突破

部分站点搜索结果限制前 100 页可见。使用站点筛选条件（分类、发布时间、促销状态等）将结果集拆成多个 URL，通过 `BROWSE_URL_LIST` 依次处理。

仓库提供半年度 URL 生成辅助脚本：

```bash
BASE_BROWSE_URL='https://example.invalid/browse?sort=size%3Aascend&...your-filter' \
START_YEAR=2015 END_YEAR=2026 TZ_OFFSET=10 \
npm run build:half-year-urls > browse-urls.txt
```

## License

MIT

---

**隐私提醒：** 不要将真实 URL、cookie、passkey、账号信息、日志或截图提交到 issue 或 PR。
