<div align="center">

# 🛡️ AgentGuard

**一份 YAML 规则，同时管 AI Agent 的 CI 测试和线上护栏。**
**One YAML rule file, two exits: CI regression testing + runtime guardrails for your AI agents.**

[![tests](https://img.shields.io/badge/tests-33%2F33_passing-brightgreen)](#) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE) [![node](https://img.shields.io/badge/node-%E2%89%A518-green)](#) [![zero build](https://img.shields.io/badge/build-none_·_纯_JavaScript-orange)](#)

**你一定见过这个事故剧本：**

> 周一：改了 system prompt，感觉更好了 → 上线
> 周三：客服反馈 Agent 开始乱调工具（用户只是问物流，它给人退款了）→ 回滚
> 周五：找到是周一那次改动引起的，但 trace 已经滚掉了

现有的两条路都不通：**CI 评测**（promptfoo 这类）管不住线上；**线上护栏**（NeMo 这类）和测试是两套规则，改一处忘一处。

**AgentGuard 把这两条路接到同一份规则上 —— `where` 是唯一开关。**

[中文](./README.md) · [English](./README.en.md)

</div>

---

## 30 秒上手

本项目尚未发布到 npm，从源码使用：

```bash
git clone https://github.com/Davin-06/agentguard.git && cd agentguard
npm install

# 0. 一键脚手架：生成示例规则 + 示例事故 trace（已有文件不覆盖）
npx agentguard init          # 等价于 node src/cli.js init

# 1. CI 卡点：示例事故应被抓到，退出码 1
npx agentguard check --rules agentguard-rules --trace traces

# 2. 60 秒看同一份规则在线上拦住重复退款（自动 learn 示例规则 + 起 mock 上游）
node demo-guard.mjs
```

想让 `agentguard` 成为全局命令：`npm link` 一次（或 `npm install -g .`），之后下述命令里的 `npx agentguard` 都可以直接写 `agentguard`。

然后把你自己的事故 trace 喂进去：

```bash
# 3. 从事故 trace 里长出候选规则（预览不落盘）
agentguard learn --trace examples/traces/refund_incident.json
#   [90%] refund-incident-idempotent-refund-order — refund_order 用同一 order_id 被调用了多次
#         · turns 7 & 9 share order_id='A1001'
#   [82%] refund-incident-forbid-refund-order — 检测到只读意图的会话中调用了破坏性工具
# 预览模式：2 条候选达到阈值（阈值 0.7）。确认无误后加 --apply 写入

# 4. 确认无误，写入 agentguard-rules/
agentguard learn --trace examples/traces/refund_incident.json --apply

# 5. CI 卡点：违规即退出码 1，合并前拦住
agentguard check --rules agentguard-rules --trace examples/traces/refund_incident.json

# 6. 线上护栏：作为 MCP 透明代理部署，逐调用拦截
agentguard guard --rules agentguard-rules --upstream "node your-mcp-server.js"
```

## 一份规则，两个出口

规则就是仓库里一份普通的 YAML（`examples/rules/refund-safety.yaml`）：

```yaml
rule: refund-safety
when:
  intent_any: ["到货", "物流", "订单", "status"]   # 用户只是在问物流
then:
  forbid_tool: refund_order                      # 那就绝不能调退款
  allow_tool: [query_order, get_logistics]       # 只允许这两个只读工具
  idempotent:
    tool: refund_order
    key: "${order_id}"                           # 同一订单不许重复退款
where:
  ci: true        # ← 在 CI 里当断言
  runtime: true   # ← 在生产里当护栏
```

`where` 是唯一开关。同一份文件，`ci: true` 就在合并前拦住你，`runtime: true` 就在工具调用前拦住 Agent。

## 它能断言的五件事

全部是**确定性**断言，刻意不用 LLM 当裁判 —— 会误报的门禁，一周内就会被团队关掉。

| 断言 | 抓什么 | CI（check） | 线上（guard） | promptfoo 导出 |
|---|---|---|---|---|
| `forbid_tool` | 调了不该调的工具 | ✅ | ✅ | ✅ `not-trajectory:tool-used` |
| `allow_tool` | 调了白名单之外的工具 | ✅ | ✅ | ❌ 无白名单原语 |
| `require_tool` | 该调的没调（any-of：至少调过其一） | ✅ | —（无会话结束时机） | ✅ 单工具可导；多工具转人工（拆多条会变 all-of，语义反转） |
| `max_tool_calls` | 疑似无限循环 | ✅ | ✅（按代理计数） | ✅ `trajectory:max-tool-calls` |
| `idempotent` | 同一笔事务重复执行（退款/扣款） | ✅ | ✅（会话内状态） | ❌ 需业务事务键语义 |

`idempotent` 与（路线图中的）`memory_persistence` 是相对现有工具的真实增量：

- **idempotent** 需要知道哪个参数标识一笔事务 —— 这是业务语义，通用 eval 框架够不着。
- **memory_persistence**（第 20 轮忘了第 2 轮说过的约束）是 per-turn 断言，现有工具只有整段对话的 conversation-relevance，没有「第 20 轮必须还记得第 2 轮的事实」这个原语。

## 规则从哪来：从事故里长出来

```bash
$ agentguard learn --trace examples/traces/refund_incident.json

  [90%] refund-incident-idempotent-refund-order — refund_order 用同一 order_id 被调用了多次
        · turns 7 & 9 share order_id='A1001'
  [82%] refund-incident-forbid-refund-order — 检测到只读意图的会话中调用了破坏性工具 refund_order
        · 命中只读意图关键词：到货 / 物流 / 订单（intent_any 建议）
预览模式：2 条候选达到阈值（阈值 0.7）。确认无误后加 --apply 写入
```

**为什么必须人工确认**：判断「哪一步是错的」是语义问题，启发式会误判。所以它只给候选 + 置信度 + 证据，加 `--apply` 才落盘。任何声称「一键把 trace 变成测试」的方案，都在回避这个难点。它也会自动排除一部分误判：用户明确说过「退款」，就不会把那次调用报成事故。

当前三个启发式（大会话已做性能优化，3000 次重复调用秒级完成）：
1. **幂等违规**（全参数相同的重复调用，自动挑选 `*_id` 类参数当事务键，置信度 0.85–0.9）
2. **只读意图 × 破坏性工具**（0.82，内置可扩展的动作词表）
3. **调用循环**（同一工具单会话超 5 次，0.75，上限值需人工调整）

## 它不抢地盘，当翻译层

它不打算成为下一个标准（promptfoo 已占住 CI 断言，NeMo 已占住运行时拦截）。所以它做翻译层 —— 你维护一份规则，它生成你已经在用的工具的原生配置：

```bash
agentguard export --to promptfoo   # → not-trajectory:tool-used 等断言
```

**翻不过去的部分会逐条明说**（`allow_tool`、`idempotent`、含 `when.intent_any` 的条件断言、多工具 `require_tool` 的 any-of 语义），而不是生成看起来对、实际不触发的配置。

## guard：运行时怎么部署

guard 是一个 **MCP stdio 透明代理**：对 Agent 客户端它是普通 MCP server，对真实 MCP server 它是普通客户端，只拦截 `tools/call`：

```json
{
  "mcpServers": {
    "payment": {
      "command": "agentguard",
      "args": ["guard", "--rules", "/path/to/agentguard-rules",
               "--upstream", "node payment-mcp-server.js"]
    }
  }
}
```

- 拦截时返回 JSON-RPC 错误（code `-32001`），消息带上规则名、断言类型和证据；客户端会显示为 MCP error。
- 每笔判定写入审计日志（JSONL，`--audit` 指定，默认 `agentguard-audit.jsonl`；首行是 `decision: "open"` 的探针记录）。**审计路径不可写时 guard 拒绝启动**——没有审计的护栏等于没有护栏。
- check 会做一次拼写 lint：规则里引用、但从未在任何 trace 中出现的工具会被点名（那种规则从未生效过，是假安全）。
- **诚实的边界**：MCP 代理看不到用户聊天消息，`when.intent_any` 规则只有在调用方通过 `tools/call` 参数的 `_meta.agentguard.intent` 注入意图提示时才生效，否则跳过（启动时告警一次）。`require_tool` 仅在 CI 有意义。

## CI 怎么接

`.github/workflows/agentguard.yml`（完整示例在 `examples/`）：

```yaml
name: agentguard
on: [pull_request]
jobs:
  agent-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install -g .
      # --trace 给目录会递归检查全部 .json；--strict 下规则名冲突（多团队共治）直接拒绝
      - run: agentguard check --rules ./agentguard-rules --trace ./traces --strict
```

trace 格式（v1）见 `examples/traces/refund_incident.json`：session 事件流，`user` / `assistant` / `tool_call` / `tool_result` 四种事件。OTel GenAI 语义规范的转换器在路线图里。

## 什么时候你不需要它

- 你只有单轮问答 Agent，不调工具 → 用 promptfoo 就够了
- 你只想测回答质量（RAG 准不准、语气对不对）→ 用 DeepEval / Langfuse
- 你的 Agent 从不执行不可逆操作（不发钱、不删数据、不发消息）→ 门禁的价值很低

它真正值钱的场景只有一个：**Agent 能造成不可逆后果，而你又改得很勤。**这时候「CI 拦不住线上、线上没测试」的裂缝就是事故来源。

## 项目结构

```
src/
  cli.js             入口与参数解析（每个子命令支持 --help）
  rule.js            规则加载/校验/序列化（单文档、多文档、数组、递归子目录皆可）
  trace.js           trace v1 格式加载与校验（容忍 BOM）
  engine.js          确定性断言引擎（CI 全量评估 + runtime 单次判定）
  learn.js           三个事故启发式 → 候选规则（置信度 + 证据，O(n) 分组）
  exportPromptfoo.js 翻译层：能翻的翻，翻不过的明说
  guard.js           MCP stdio 透明代理 + 审计预检与审计日志
test/                node:test：单元 + CLI e2e + guard 真进程 e2e + 新用户旅程 + 大项目场景
examples/            规则示例、事故 trace、GitHub Actions 工作流
```

## 路线图

- `memory_persistence` 断言（per-turn 记忆原语，`fact_key` + `expect_remember`）
- OTel GenAI trace 格式转换器；Langfuse/LangSmith 导出读取
- `export --to nemo`（运行时护栏配置）
- 敏感信息外发拦截（出站参数扫描 .env 内容/密钥）
- guard 幂等状态持久化（跨重启）；多上游网关形态；`learn --watch`

## 局限（诚实清单）

- `learn` 的启发式只覆盖典型事故形态；置信度低于阈值的模式它宁可不报。
- guard 的幂等/计数状态只存在于代理进程内存里：**代理重启即清零**（同一事务键在重启前后各调一次不会被拦）。跨重启持久化在路线图里。
- guard 的 `--upstream`：Windows 走 shell 解析（支持引号路径）；POSIX 按空格切分，命令里带引号参数请包一层脚本。
- trace v1 是自定义格式；OTel 转换器落地前，需要自己导出（JSON 一看就懂）。
- 导出到 promptfoo 的 trajectory 断言类型名请以 promptfoo 当前文档为准。
- 审计日志对超过 300 字符的参数做截断（防日志爆炸），完整内容要看上游日志；敏感信息脱敏在路线图里。
- Windows 控制台如遇中文乱码，先 `chcp 65001`。

## License

MIT
