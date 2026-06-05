---
name: mt-farmer
description: "合规优先的私有站点浏览助手：默认 dry-run 审阅，支持分段浏览；仅在站点规则允许时可显式启用 Transmission 导入。"
---

# 私有站点浏览助手

这个 skill 用于本地、合规优先地审阅私有站点分页列表。默认是 dry-run，不会下载。

## 操作规则

- 不要硬编码站点域名、账号标识、passkey、cookie、内网 IP 或真实浏览 URL。
- 从本地环境变量传入 `BROWSE_URL` 或 `BROWSE_URL_LIST`。
- 除非用户明确确认目标站点允许对应自动化，否则保持 `DRY_RUN=true`。
- 主动下载必须同时设置：
  - `DRY_RUN=false`
  - `DOWNLOADS_ENABLED=true`
  - `ACK_SITE_RULES=true`
- 如果页面出现验证码、警告、限流、异常跳转或账号风险提示，立即停止。

## 本地输入

| 变量 | 说明 |
|---|---|
| `BROWSE_URL` 或 `BROWSE_URL_LIST` | 本地浏览 URL，建议使用体积升序排序。 |
| `TR_URL`, `TR_USER`, `TR_PASS` | Transmission RPC 凭据，仅主动下载时需要。 |
| `DAILY_LIMIT`, `HOURLY_LIMIT` | 保守的每日/每小时上限，应低于站点规则上限。 |
| `SEGMENT_MAX_TORRENT_BYTES` | 当前候选项超过该体积时结束当前分段。 |
| `SEGMENT_MIN_TORRENT_BYTES` | 可选的最小体积阈值，用于跳过已覆盖区间。 |

脚本仍兼容旧变量 `MT_BROWSE` 和 `MT_BROWSE_LIST`，但公开示例不要使用这些名称。

## 安全试跑

```bash
BROWSE_URL_LIST="$(cat private-browse-list.txt)" \
DRY_RUN=true \
node scripts/mt_farmer.js
```

## 主动运行

仅在检查站点规则和账号权限后使用：

```bash
BROWSE_URL_LIST="$(cat private-browse-list.txt)" \
DRY_RUN=false \
DOWNLOADS_ENABLED=true \
ACK_SITE_RULES=true \
TR_URL='http://127.0.0.1:9091/transmission/rpc' \
TR_USER='transmission-user' \
TR_PASS='transmission-password' \
node scripts/mt_farmer.js
```

## 分段

如果浏览结果存在固定页数窗口，请使用目标站点页面已有筛选条件拆分结果。优先使用分类、日期、编码、分辨率、促销状态等筛选。不要依赖请求可见窗口之外的页码。

本地生成半年度日期分段：

```bash
BASE_BROWSE_URL='https://example.invalid/browse?sort=size%3Aascend&...your-local-filter' \
START_YEAR=2015 END_YEAR=2026 TZ_OFFSET=10 \
npm run build:half-year-urls > private-browse-list.txt
```

## 隐私

分享任何输出前，移除账号名、profile 链接、分享率、上传/下载统计、奖励数值、邀请码数量、cookie、passkey、真实站点域名、真实浏览 URL、Transmission 地址和内网 IP。
