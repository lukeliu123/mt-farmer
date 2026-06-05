# 私有站点浏览助手

这是一个合规优先的本地浏览辅助工具，用于审阅私有站点的分页列表、估算候选种子体积，并在站点规则允许的前提下，可选择把下载到的 `.torrent` 文件导入 Transmission。

公开版本默认非常保守：

- 默认 `DRY_RUN=true`，只扫描和记录候选项，不点击下载。
- 主动下载必须同时设置 `DRY_RUN=false DOWNLOADS_ENABLED=true ACK_SITE_RULES=true`。
- 仓库不内置任何站点域名、账号、cookie、passkey、内网地址或真实浏览 URL。
- 浏览 URL 必须由你在本地通过环境变量传入。

## 合规优先

请只在目标站点规则和账号权限明确允许的情况下使用本项目。如果目标站点禁止自动化、批量下载、脚本浏览或第三方工具，请不要启用主动下载模式。

建议的使用原则：

- 先用 dry-run 扫描，确认页面、过滤条件和日志正常。
- 每小时、每日限额应明显低于站点规则上限。
- 不要对同一账号并行运行多个浏览/下载会话。
- 遇到验证码、警告横幅、异常跳转、限流迹象或账号风险提示时立即停止。
- 不要把真实 URL、cookie、passkey、账号信息、上传/下载统计、日志、截图提交到仓库或 issue。

## 功能

- 支持多个浏览 URL 分段处理，适合结果窗口有限的站点。
- 支持按候选种子体积结束当前分段，避免后续条目过大。
- 支持最小体积阈值，用于跳过已覆盖的小体积区间。
- 内置保守的每小时/每日计数器。
- 支持按 `segment/page/row` 断点续跑。
- 导入 Transmission 后清理临时 `.torrent` 文件。
- 两种运行方式：
  - `scripts/mt_farmer.js`：OpenClaw/CDP 工作流。
  - `scripts/mt_farmer_standalone.js`：Puppeteer 工作流。

## 配置

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `BROWSE_URL` | 空 | 单个本地浏览 URL。建议使用站点自己的体积升序排序。 |
| `BROWSE_URL_LIST` | 空 | 多个浏览 URL，支持换行或逗号分隔。 |
| `DRY_RUN` | `true` | 只扫描不下载。只有在规则允许时才设为 `false`。 |
| `DOWNLOADS_ENABLED` | `false` | 主动下载的额外安全开关。 |
| `ACK_SITE_RULES` | `false` | 确认你已阅读并会遵守目标站点规则。 |
| `TR_URL` | 空 | Transmission RPC 地址。主动下载时必填。 |
| `TR_USER` | 空 | Transmission RPC 用户名。主动下载时必填。 |
| `TR_PASS` | 空 | Transmission RPC 密码。主动下载时必填。 |
| `DAILY_LIMIT` | `950` | 每日下载请求上限。请按站点规则下调。 |
| `HOURLY_LIMIT` | `90` | 每小时下载请求上限。请按站点规则下调。 |
| `BETWEEN_TORRENT` | `45000` | 候选项之间的等待时间，单位毫秒。 |
| `MAX_PAGES` | `100` | 每个浏览 URL 最多处理页数。 |
| `SEGMENT_MAX_TORRENT_BYTES` | `367001600` | 当前候选项超过该体积时结束当前分段。 |
| `SEGMENT_MIN_TORRENT_BYTES` | `0` | 跳过低于该体积的候选项；`0` 表示关闭。 |
| `MAX_BYTES` | 运行版本决定 | 估算新增体积达到该值后停止。 |
| `CHECKPOINT_FILE` | `~/.mt_farmer_checkpoint.json` | 断点文件。 |
| `LOG_FILE` | `~/.mt_farmer.log` | 本地日志文件。 |
| `DL_DIR` | `/tmp/mt_downloads` | 临时下载目录。 |

脚本仍兼容旧环境变量 `MT_BROWSE` 和 `MT_BROWSE_LIST`，但公开文档统一使用更通用的 `BROWSE_URL` / `BROWSE_URL_LIST`。

## 安全试跑

```bash
npm install

BROWSE_URL_LIST="$(cat private-browse-list.txt)" \
DRY_RUN=true \
npm run start:openclaw
```

## 主动下载

只有在目标站点规则和你的账号权限允许时才使用：

```bash
BROWSE_URL_LIST="$(cat private-browse-list.txt)" \
DRY_RUN=false \
DOWNLOADS_ENABLED=true \
ACK_SITE_RULES=true \
TR_URL='http://127.0.0.1:9091/transmission/rpc' \
TR_USER='transmission-user' \
TR_PASS='transmission-password' \
npm run start:openclaw
```

## 拆分大型结果集

有些站点只展示搜索结果的前 N 页。不要简单把 `MAX_PAGES` 调大来绕过这个限制。更稳妥的做法是使用站点页面已有的筛选条件，把列表拆成更小的浏览 URL，例如分类、发布时间、促销状态、编码、分辨率等。

仓库提供一个本地半年度 URL 生成器。它不会包含或推断任何真实站点域名：

```bash
BASE_BROWSE_URL='https://example.invalid/browse?sort=size%3Aascend&...your-local-filter' \
START_YEAR=2015 \
END_YEAR=2026 \
TZ_OFFSET=10 \
npm run build:half-year-urls > private-browse-list.txt
```

不要提交 `private-browse-list.txt`。

## 隐私检查清单

分享日志、截图或 issue 前，请移除：

- 账号名、profile 链接、邀请码数量、分享率、上传量、下载量、积分/奖励数值。
- cookie、passkey、真实站点域名、真实浏览 URL。
- Transmission 地址、内网 IP、用户名和密码。
- 任何能把仓库关联到具体站点或具体账号的截图细节。

建议使用 `https://example.invalid/browse?...` 这类合成示例。

## License

MIT
