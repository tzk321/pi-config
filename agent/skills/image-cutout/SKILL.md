---
name: image-cutout
description: 抠图/去背景/做透明背景 PNG，尤其是动漫立绘、插画、商品平涂背景图（紫/粉/白/灰底、带南瓜之类装饰、带地面阴影、带白边/黑边的截图或壁纸）。当用户说"抠图"、"把背景去掉"、"只要人物/角色"、"背景透明"、"做贴纸/表情包素材"、"去掉这个背景"、"alpha 通道/PNG 透明"时使用；也用于批量处理同风格的一批图。内含 isnet-anime 模型 + 背景色键 + 反混合去紫边的完整流程，比直接 rembg.remove() 边缘质量高得多。
---

# image-cutout — 平涂背景抠图（动漫/插画）

用 `isnet-anime` 分割 + 背景色 keying + 洞修补 + 边缘反混合，产出干净软边缘的 RGBA PNG。
原始图**永远不要覆盖**，输出另存（默认 `原名-cutout.png`）。

## 0. 环境（一次性，约 300MB 下载，需先问用户）

```bash
bash ~/pi-config/agent/skills/image-cutout/scripts/bootstrap.sh
# -> ~/.cache/pi-cutout/.venv/bin/python，isnet-anime 权重在 ~/.rembg/models/isnet-anime/
```

已就绪就别重装。后续所有脚本都用这个解释器（系统 python 没有 rembg）：
`~/.cache/pi-cutout/.venv/bin/python`

## 1. 标准流程

先 `cd` 到图片目录，下面的脚本都在 skill 目录：

```bash
S=~/pi-config/agent/skills/image-cutout/scripts
PY=~/.cache/pi-cutout/.venv/bin/python
```

**第 1 步 — 看图 + 定位。** 用 read 工具直接看图，判断：背景是不是平涂/渐变？有没有要一起丢掉的装饰（南瓜、道具、文字、地面阴影）？背景有没有白边/黑边/渐晕？

需要精确坐标时（画 `--paint` 框）**不要猜**，先出坐标网格再读图：

```bash
$PY $S/grid.py in.png --step 100 --out /tmp/grid.png   # 读 /tmp/grid.png 对着数坐标
```

**第 2 步 — 先跑一遍不带 --paint 的基线**，看 `--report` 里 `detached components kept by the model` 列出的孤立块（那通常就是要丢的装饰）：

```bash
$PY $S/cutout.py in.png out-cutout.png --report --preview /tmp/prev.png
```

**第 3 步 — 给要丢的背景杂物加 `--paint` 框**（把可疑区域在喂模型前烧成背景色），再跑：

```bash
$PY $S/cutout.py in.png out-cutout.png \
  --paint 0,0,W,80:bright:240 \          # 顶部白/黑边：用 bright，别用 all（保住探出边的头发）
  --paint 180,65,420,175:color:26:flood \  # 一个装饰：框住它 + 按主色 + 只留碰到框边的连通块
  --paint 0,1880,940,2048:color:24:flood \ # 地面阴影：阴影自己的灰色，不要用 shadow/neutral 模式
  --paint 0,1990,W,H:bright:240 \          # 底部白条
  --report --preview /tmp/prev.png
```

**第 4 步 — 必看预览**：`/tmp/prev.png` 是棋盘格合成图；再抽几处放大对比（白底 + 洋红底最能暴露残留和硬边）：

```bash
$PY $S/zoom.py in.png out-cutout.png X0,Y0,X1,Y1 --zoom 2 --bg white,magenta \
    --out /tmp/z.png     # 面板顺序：原图 | 白底 | 洋红底
```

**第 5 步 — 有旧结果就做回归**（IoU + 差异簇位置）：

```bash
$PY $S/compare.py new.png reference-old-cutout.png
```

**第 6 步 — 交付**：报告输出路径、尺寸、文件大小；需要贴图用途可加 `--crop-tight` 去掉透明边。
原图不动、不删中间产物（除非用户要求）。

## 2. 参数速查

| 参数 | 作用 |
| --- | --- |
| `--bg auto\|R,G,B` | 背景色。auto 用"从边缘 flood 出的最大连通区"判定，能跳过白边/黑边 |
| `--paint x0,y0,x1,y1:MODE[:TOL[:flood]]` | 告诉模型这里就是背景（可重复） |
| `--key-tol / --key-floor / --key-span` | 背景色键的容差与软过渡（默认 34 / 9 / 20） |
| `--contrast LO,SPAN` | alpha 收紧，默认 `0.16,0.66`；边缘太脏调大 LO，太薄调小 |
| `--no-key / --no-holefix / --no-decontam` | 分段排查用（先关掉看原始 mask） |
| `--min-speck N` | 删除 < N px 的碎片（默认 60） |
| `--drop-remote AREA` | 删除面积 ≥ AREA 的**不相连**块（丢装饰的零坐标方案） |
| `--crop-tight` | 裁掉透明边 |
| `--preview / --alpha-out / --report` | 棋盘格预览 / 单独 alpha 图 / 诊断打印 |

`MODE`：`all`(整框涂) `color`(框内主色，自动跳过近白与背景色) `neutral`(低饱和) `bright`(近白) `shadow`(低饱和+中亮度+色相偏离背景)
`:flood` 后缀 = 只保留**碰到框边**的连通块 → 框画大了也不会把角色吃掉。

## 3. 已知坑（都踩过，别再踩）

1. **不要用 `rembg.remove()`**：它的 alpha 被 post_process_mask 二值化了，边缘是阶梯。必须 `sess.predict(img)` 拿 0~255 原始浮点 alpha 自己处理。
2. **白边/黑边会把背景色判成白**：`detect_bg` 已按"最大连通区"投票解决；但边带本身要用 `bright:240` 涂掉，用 `all` 会把探出边外的发丝/呆毛一起切掉。
3. **`color` 模式一定要配 `:flood`**：否则框画大一点就把角色局部（头发、皮肤）当背景涂了。同理**一个框只处理一种杂物**——框里同时有"白色边条 + 灰色阴影"时主色会被白色抢走（近白已自动跳过，但别依赖）。
4. **色键的色相判定必须严**（现为 `cos>0.95 & satr>0.6`）：蓝色/灰蓝色衣服"冷"得像紫色背景，放宽就会出现**横条纹断裂**（鞋面被戳出洞）。
5. **`shadow` 模式会吃掉灰蓝色鞋子**：地面阴影请用 `color` 取阴影自己的灰色 + `:flood`。
6. **头发缝隙里的背景会被模型当主体**：`key_holes` 只处理 ≥120px 的封闭洞，并用"背景色距离 + 冷暖"判定（紫色丢、暖色头发留）。判定不对就 `--no-holefix` 后手工看。
7. **半透明区域（丝袜、纱、玻璃杯）**：alpha 会保在半透明，但放大看会透出底色，属正常；不要在洋红底上把它们当"洞"。
8. **缩放溢色**：脚本已把透明像素填成最近可见色（bleed），别再额外做 alpha bleed。
9. `--paint` 涂掉的内容 = 强制 alpha 0，所以框里若有角色本体，预览里会看到**缺口**——这就是要看预览的原因。

## 4. 验收标准

- 主体（角色 + 明确要保留的道具）完整，无缺口、无被切断的发丝/轮廓
- 背景 100% 透明，无紫/白残边、无光晕、无孤立碎片
- 放大 2 倍看边缘是软过渡（不是 0/255 硬台阶），头发有半透明
- 与上一版结果 IoU ≥ 0.98（有参考时），差异块都能解释

## 5. 实战案例

`~/Pictures/setu/kati.png`（1531x2048，紫色平涂背景 + 3 个南瓜 + 顶部白边 + 底部白条 + 地面阴影 + 5x5 棋盘水印）：

```bash
$PY $S/cutout.py kati.png kati-cutout.png \
  --paint 0,0,1531,80:bright:240 \
  --paint 180,65,420,175:color:26:flood \
  --paint 0,470,400,735:color:26:flood \
  --paint 1240,1640,1531,1890:color \
  --paint 0,1880,940,2048:color:24:flood \
  --paint 0,1990,1531,2048:bright:240 \
  --report --preview /tmp/prev.png
```

结果：`IoU 0.9931`（对手工版参考），软边 4.6 万像素、透明 43.5%。注意右下角那个"灰白色星形物"是**画里本来就有的**，参考版也保留——不要当残留删掉。
