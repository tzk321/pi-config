# pi-config

我平时用的 [pi](https://github.com/earendil-works/pi)（终端 coding agent）配置、扩展和本地包。
仓库里的东西通过软链接进 `~/.pi/agent/`，**不包含**会话记录、记忆、凭据。

## 内容

| 路径 | 说明 |
| --- | --- |
| `agent/AGENTS.md` | 协作规则：授权边界、GitHub 访问、开发工作流、上下文成本管理 |
| `agent/settings.json` | pi 设置：默认工具、codemode、powerline、默认模型、插件列表。**是副本不是软链**（含设备相关项） |
| `agent/extensions/` | 自写扩展 |
| `agent/local-packages/` | 本地 pi 包（`pi-tidy-tree`） |
| `agent/skills/` | 技能 |
| `lens/config.json` | pi-lens 的保守配置：留 LSP，关格式化/自动修复/测试/额外扫描器。放到 `~/.pi-lens/config.json` 才生效 |

## 扩展

| 扩展 | 作用 |
| --- | --- |
| `image-paste-preview.ts` | 粘贴图片时在输入框上方实时预览；发送后在消息下方留一张图片卡片 |
| `ttft-status.ts` | 状态栏显示每次模型请求的首字用时（TTFT），`/ttft` 切换；和 pi-token-speed 分工（那边只管 TPS） |
| `message-edit/index.ts` | 选一条历史用户消息，编辑后从那里 fork |
| `local-tool-policy.ts` | 关掉 pi-lens 的自动装 LSP/工具，并把 qmd 固定到本地 CPU 后端 |

### image-paste-preview

pi 粘贴图片时只会把剪贴板存成 `/tmp/pi-clipboard-<uuid>.png`、把路径当纯文本插进输入框，终端看不到图。这个扩展补上显示：

- **输入阶段**：编辑器里出现图片路径（粘贴或手打都行）就在输入框上方预览，清空即收起。
- **发送之后**：在该条用户消息下面追加一条只用于显示的 custom entry，渲染成图片卡片。它不进模型上下文，重启会话重放历史时会重画。

依赖终端的图形协议（kitty、iTerm2 等），不支持的终端里什么都不做。单张上限 40 列 × 12 行，一次最多 3 张，超过 20 MB 忽略；路径里不能有空格（纯文本扫描，不解析 shell 转义）。

## 部署

```sh
git clone https://github.com/tzk321/pi-config ~/pi-config
ln -sfn ~/pi-config/agent/AGENTS.md       ~/.pi/agent/AGENTS.md
ln -sfn ~/pi-config/agent/extensions      ~/.pi/agent/extensions
ln -sfn ~/pi-config/agent/skills          ~/.pi/agent/skills
ln -sfn ~/pi-config/agent/local-packages  ~/.pi/agent/local-packages
mkdir -p ~/.pi-lens && cp ~/pi-config/lens/config.json ~/.pi-lens/config.json   # 可选
```

`agent/settings.json` 按需手动复制到 `~/.pi/agent/settings.json`。

## 兼容

- 针对 pi 1.4.x 写的。扩展里 `import` 的 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 由 pi 以虚拟模块提供，仓库不需要 `npm install`。
- `agent/extensions/image-paste-preview.ts`、`ttft-status.ts`、`message-edit` 只在 pi 以交互模式跑、且终端支持图形/真彩时才有实际效果。

## 第三方来源

- `agent/skills/skill-creator`：Anthropic 的 [skills](https://github.com/anthropics/skills) 里的 skill-creator 拷贝，Apache-2.0，原 LICENSE 保留。
- `agent/local-packages/pi-tidy-tree`：pi-tidy 的本地副本，上游 [Andy8647/pi-tidy](https://github.com/Andy8647/pi-tidy)，MIT，原 LICENSE 保留。
- `agent/skills/typst-author`、`agent/skills/bing-fallback`：随本机配置一起维护的技能。

## 许可

自写部分未声明许可，保留所有权利。第三方内容（见上）遵循各自 LICENSE。
SB IS TZK
