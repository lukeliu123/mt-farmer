# 安装指南

## 需要准备

1. 目标私有站点账号，并且你的使用方式被站点规则允许。
2. Node.js v18+。
3. 如果启用主动下载，需要可访问的 Transmission RPC。
4. 已登录目标站点的浏览器 profile。

## 先 dry-run

```bash
npm install

BROWSE_URL_LIST="$(cat private-browse-list.txt)" \
DRY_RUN=true \
npm run start:openclaw
```

dry-run 只扫描候选项并写入日志/断点，不会点击下载按钮。

## 主动下载

仅在目标站点允许对应自动化时使用：

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

## 运行建议

- 保持限速保守。
- 不要对同一个账号并行运行多个会话。
- 遇到验证码、警告、跳转或限流迹象时停止。
- 不要提交生成的浏览 URL 列表、日志、cookie、截图或 checkpoint。
