---
name: douyin-agent
description: douyin-agent 项目（抖音私信采集 + MCP）的当前事实与坑。用户提到 douyin-agent、抖音私信、私信面板、MCP 工具、media/raw_url、时间戳、清理时看这个。
---

# douyin-agent 现状（2026-11-03）

项目：`~/shit-projects/douyin-agent`，systemd 用户单元 `douyin-agent.service`，
FastAPI + Playwright（headless Chromium，CDP 9222），登录态 `data/browser-profile`。

## 已经做完的

1. **自动抓正文**：`scan_once` 列表预览一变就 `open_conversation` + `extract_messages`，最多 2 个会话，5 秒一轮。
2. **媒体采集**：纯图片是 data URI → 解码落 `data/media/<cid>/<sha1前16>.webp`；表情存签名 https URL。mime 用魔数嗅探（抖音声明 png 实际 webp）。同消息按内容指纹去重。
3. **raw_url**：所有 media 返回带 `raw_url`（token 已拼），`curl -sL` 直接拿字节。`GET /api/media/<msg_id>/raw?i=0`。**不要再返回本机 path。**
4. **批量**：`douyin_media(msg_ids: [...])`，≤50，返回 `{count, items}`；单 `msg_id` 形状不变。
5. **时间戳**：`msgtime.py` 解析「今天/昨天/前天/周X/M月D日/xx:xx」，带 `ts_precision`。2026-11-03 做过 id 重排（按 cid+ts），**旧 cursor 全部失效**。
6. **清理**：`/api/media/stats`；上限 500MB（`DA_MEDIA_MAX_MB`）；启动 + 每小时；孤儿优先 → 消息 ts → created_at；淘汰后保留行只清 path。
7. **日志脱敏**：query 抹成 `?<redacted>`，token 不进 journal。

## 硬坑

- 抖音会话列表是**虚拟滚动**，`conv_names` 只包含当前渲染的十几个。要给不在列表里的会话发消息，必须先在页面上滚动找到它（`/tmp/find_conv.py` 那套），否则报「会话不在最近一次扫描列表里」。
- 手动 `/api/send` 面板路径要 `confirm: true`。
- 网页端不渲染时间气泡的历史消息，`ts_updated` 恒为 0，补不了，别当 bug 修。
- 表情签名 URL 的 host 每次加载都变，按 URL 去重必然失效。
- 修改 `web.py` 的 f-string 里写 JSON 示例时，`{{` / `}}` 很容易多一个，导致服务起不来。改完必须 `py_compile` + 重启确认 active。
- `pkill -f "xxx"` 会匹配自己的 ssh 命令行 → 用 `kill <PID>`。

## 常用

```sh
cd ~/shit-projects/douyin-agent
./run.sh restart | status | log
curl -s localhost:8000/api/state
curl -s localhost:8000/api/media/stats
sqlite3 data/agent.db "select count(*), sum(case when ts>0 then 1 else 0 end) from message;"
```

手机侧靠 `/data/adb/service.d/93-douyin-nat.sh` 把旧 IP 的 8000 转到当前 IP，换网自动重扫，不用改客户端配置。
