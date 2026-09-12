# dsh-usage-stats-long

为 **DeepSeek Harness** 提供精确的 Token 用量统计：一个宿主插件、三个模型工具、一个命令行工具，以及一个自包含的交互式看板。

[English](README.md)

```
$ dsh-usage-stats summary --since 7d --lang zh

# Token 用量报告

## 总体概况

| 会话数 | 计费模型调用 | 轮次 | 步数 | 模型路由 | 项目数 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 24 | 782 | 5 | 782 | 2 | 3 |

| 未命中缓存输入 | 缓存读取 | 缓存写入 | 输出 | 推理（含在输出内） | 提示词 tokens | 总 tokens | 缓存命中率 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,284,991 | 138,204,672 | 0 | 214,553 | 41,208 | 139,489,663 | 139,704,216 | 99.1% |
```

## 这里的“精确”指什么

本项目每一个数字，都是**模型提供方为某次真实计费调用返回的用量记录**，直接读自 Harness 落盘的会话日志。没有任何数字是从文本估算出来的。

这与 Harness 自带的上下文计量器有意不同：`ctx.tokenMeter` 用「四字符≈一个 token」的启发式回答*“我的上下文还剩下多少”*——这对压缩和占用率展示是正确的工具，但对用量报表则是错的。本项目读的是日志的另一半：`assistant/message` 与 `compaction/summary` 上由提供方给出的精确计数。

| 计数 | 含义 |
|---|---|
| `inputTokens` | **未命中缓存**的提示词 tokens；缓存部分不会被混入。 |
| `cacheReadTokens` | 提供方从缓存中命中的提示词 tokens。 |
| `cacheWriteTokens` | 提供方写入缓存的提示词 tokens。 |
| `outputTokens` | 完整输出，已包含推理内容。 |
| `reasoningTokens` | 输出中的推理部分，**不会**再叠加到总量上。 |
| `totalTokens` | 提供方给出的精确总计；若未提供，则由各分项相加并在报表中标注。 |

四条规则保证了总计可信，且每条都有测试覆盖：

1. **一次计费调用只记一次。** 成功的步（step）只写入一条带用量的 `assistant/message`；被重试的尝试写入不带用量的 `assistant/attempt`。因此把带用量的事件相加，绝不会把重试重复计费。
2. **分叉日志不重复计父会话。** 被 resume 或 fork 的日志会重放一段继承前缀，那部分父会话已经付过费。最后一个 `session/end-seed` 之前的所有内容都不计入轮次、步数与调用。
3. **推导出的总计会被标注。** 提供方未给出 `totalTokens` 时，总计由各分项相加，并用 `*` 标出——绝不会冒充提供方的精确值。
4. **绝不编造费用。** 内置价格表为空。没有你提供的费率，费用列保持 `-`，并明确列出哪些模型未配置价格。

完整的推导过程（含如何与一份独立实现的对照验证）见 [docs/accuracy.md](docs/accuracy.md)。

## 安装

```sh
# 从本地目录安装
dsh plugin --profile web add /绝对路径/dsh-usage-stats-long

# 或从 GitHub 安装（pnpm 询问时请授权 prepare 脚本）
dsh plugin --profile web add github:ddxl123/dsh-usage-stats-long
dsh --profile web --dump-config   # 应能看到 "# == dsh-usage-stats-long" 层
dsh --profile web
```

组合包只插入一行宿主插件行：

```yaml
- id: usage-stats
  name: 'dsh-usage-stats-long'
  config:
    sessionsRoot: ''      # 默认 $DSH_HOME/sessions
    priceBookPath: ''     # 用于费用列的 JSON 价格表
    cacheSize: 256        # 两次查询之间保留的已折叠会话数
    registerTools: true
```

可以在 `$DSH_HOME/cordis.patch.yml` 或 `--patch` 覆盖层中改这些值；patch 会替换整行 `config`，因此需要重述你需要的每一个键。

**环境要求。** Node ≥ 22.15（引擎需要解码 zstd）。以下二者之一：`PATH` 中有 `zstd` 命令（最快，推荐），或者什么都不装——内置的逐帧解码器是纯 Node 实现。`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools` 来自你的 Harness 安装，它们是 peer 依赖，不会被重复打包。

## 使用

### 模型工具

插件注册三个工具，按“要问的问题”拆分：

| 工具 | 用途 |
|---|---|
| `usage_stats` | 聚合用量：筛选、分组、分区输出、费用。 |
| `usage_sessions` | 有哪些会话、可以按什么筛选（模型、提供方、项目、类型、预设）。 |
| `usage_calls` | 精确的逐次调用明细，一行一次计费调用。 |

可以直接这样问：

- *“这周我用了多少 token？按模型拆分。”*
- *“昨天哪个项目花得最多？”*
- *“把最贵的十次调用列出来，带上会话和步号。”*
- *“比较 deepseek-flash 和 deepseek-v4.1-flash 的缓存命中率。”*

### 筛选条件

所有入口都用同一套选择器，因此同一问题在工具调用、命令行和看板里可以用同样的方式收窄：

| 筛选 | 取值 |
|---|---|
| `since` / `until` | ISO 时间、`YYYY-MM-DD`（只写日期表示整天），或相对区间：`90m`、`24h`、`7d`、`2w`、`3mo` |
| session | 精确 id，或无歧义前缀，例如 `45ee17c8` |
| `model` | `provider/model`、单独的 `model`、单独的 `provider`，或 `provider/*` |
| `provider`、`project`、`cwd` | 名称／路径白名单 |
| `kind` | `session`（顶层会话）或 `subagent` |
| `agentPreset` | 预设名 |
| `search` | 匹配 id、标题、工作目录或预设的子串 |
| `minTokens` | 丢弃用量低于阈值的会话 |

### 命令行

```sh
dsh-usage-stats summary --since 7d
dsh-usage-stats models --model deepseek-flash --lang zh
dsh-usage-stats projects --since 30d
dsh-usage-stats sessions --limit 50
dsh-usage-stats timeline --limit 14              # 终端柱状图
dsh-usage-stats turns --session 45ee17c8         # 按轮次明细
dsh-usage-stats calls --session 45ee17c8 --limit 100
dsh-usage-stats calls --order size --limit 10    # 最贵的调用在前
dsh-usage-stats export --out usage.json          # 导出整份报告 JSON
dsh-usage-stats dashboard --out usage.html       # 交互式看板
dsh-usage-stats filters --since 7d               # 打印解析后的筛选条件
```

全局参数：`--sessions-root`、`--prices`、`--detail`、`--granularity`、`--lang`、`--limit`、`--out`、`--json`、`--no-color`、`--quiet`、`--help`。

### 看板

`dsh-usage-stats dashboard --out usage.html` 写出**单个自包含 HTML 文件**：没有 CDN、不需要构建、写完之后不再访问网络。可以直接用 `file://` 打开，也可以提交进仓库或发给别人，离线可用。

内含八个视图——总览、按模型、按项目、按会话、时间分布、调用明细、文本报告、诊断——支持日期／模型／项目／类型／文本筛选、点击表头排序、点击任意会话展开其按轮次明细，并可把当前筛选结果导出为 JSON。

### 费用

价格会变、且各路由不同，因此不内置任何价格：

```sh
cp prices.example.json prices.json   # 然后填入你实际支付的费率
dsh-usage-stats summary --prices ./prices.json
```

```yaml
- id: usage-stats
  name: 'dsh-usage-stats-long'
  config:
    priceBookPath: '/绝对路径/prices.json'
```

```json
{
  "prices": {
    "provider-a/model-x": { "input": 0.27, "output": 1.10, "cacheRead": 0.027 },
    "*": { "input": 1.0, "output": 2.0, "cacheRead": 0.1, "cacheWrite": 0.5 }
  }
}
```

费率单位为「美元 / 百万 tokens」。键按最具体优先匹配：`provider/model` → `model` → `*`。没有任何匹配的模型会被标为未定价，而不是按 0 计费。

## 开发

```sh
node scripts/link-harness-deps.mjs   # 从你的 Harness 安装目录软链 @deepseek-ai/*
npm test                             # 107 个测试，无需联网、无需下载夹具
npm run lint
```

测试套件包含一项**对照测试**：一份独立编写、刻意写得朴素的折叠实现，读取同样的字节，必须给出完全一致的计数——逐次调用、逐个路由都一致。可以用真实语料运行：

```sh
DSH_REAL_SESSIONS=~/.dsh/sessions npm test
```

## 代码结构

```
lib/core/          与宿主无关的引擎 —— 不依赖 Cordis、不依赖服务，只处理普通数据
  reader.js          日志发现 + 多帧 zstd 解码
  fold.js            一份会话日志 -> 精确、可归属的模型调用
  filters.js         筛选条件的编译与应用
  aggregate.js       汇总与时间序列
  pricing.js         可选价格表
  render-text.js     面向工具与终端的 markdown
  render-html.js     自包含看板
lib/host/          插件层：usageStats 服务 + 模型工具
lib/cli/           命令行入口
```

引擎完全不了解 Harness，这正是模型工具、命令行与看板能共用同一份实现、因而共用同一组数字的原因。插件层只在其外面加上缓存、取消与状态上报，从不重新计算任何总计。

## 许可证

MIT
