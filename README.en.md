<div align="center">

# 🛡️ AgentGuard

**One YAML rule file, two exits: CI regression testing + runtime guardrails for your AI agents.**
**一份 YAML 规则，同时管 AI Agent 的 CI 测试和线上护栏。**

[![tests](https://img.shields.io/badge/tests-33%2F33_passing-brightgreen)](#) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE) [![node](https://img.shields.io/badge/node-%E2%89%A518-green)](#) [![zero build](https://img.shields.io/badge/build-none_·_plain_JS-orange)](#)

**You know this incident script by heart:**

> Monday: tweaked the system prompt, feels better → ship it
> Wednesday: support tickets pour in — the agent misused tools (user only asked about shipping status, it issued a refund) → rollback
> Friday: root cause is Monday's change, but the traces are long gone

Today there are two paths, and both are broken: **CI evals** (promptfoo-style) can't guard production; **production guardrails** (NeMo-style) live in a separate rule set from your tests — fix one, forget the other.

**AgentGuard wires both paths to the same rule file — `where` is the only switch.**

[English](./README.en.md) · [中文](./README.md)

</div>

---

## Up and running in 30 seconds

Not published to npm yet — use from source:

```bash
git clone https://github.com/Davin-06/agentguard.git && cd agentguard
npm install

# 0. Scaffold: example rule + example incident trace (never overwrites existing files)
npx agentguard init          # equivalent to node src/cli.js init

# 1. CI gate: the example incident gets caught, exit code 1
npx agentguard check --rules agentguard-rules --trace traces

# 2. Watch the same rule block a duplicate refund at runtime (auto-learns + mock upstream)
node demo-guard.mjs
```

To get a global `agentguard` command: run `npm link` once (or `npm install -g .`), then replace `npx agentguard` with `agentguard` everywhere below.

Then feed it your own incident traces:

```bash
# 3. Grow candidate rules out of an incident trace (preview only, nothing written)
agentguard learn --trace examples/traces/refund_incident.json
#   [90%] refund-incident-idempotent-refund-order — refund_order called multiple times with the same order_id
#         · turns 7 & 9 share order_id='A1001'
#   [82%] refund-incident-forbid-refund-order — destructive tool called in a read-only-intent session
# Preview: 2 candidates above threshold (0.7). Confirm, then add --apply to write.

# 4. Confirmed? Write them to agentguard-rules/
agentguard learn --trace examples/traces/refund_incident.json --apply

# 5. CI gate: violations → exit code 1, blocked before merge
agentguard check --rules agentguard-rules --trace examples/traces/refund_incident.json

# 6. Runtime guardrail: deploy as an MCP transparent proxy, blocks per tool call
agentguard guard --rules agentguard-rules --upstream "node your-mcp-server.js"
```

## One rule file, two exits

A rule is a plain YAML file in your repo (`examples/rules/refund-safety.yaml`):

```yaml
rule: refund-safety
when:
  intent_any: ["shipping", "logistics", "order", "status"]   # user is just asking about shipping
then:
  forbid_tool: refund_order                      # then issuing a refund is never OK
  allow_tool: [query_order, get_logistics]       # only these read-only tools are allowed
  idempotent:
    tool: refund_order
    key: "${order_id}"                           # never refund the same order twice
where:
  ci: true        # ← acts as an assertion in CI
  runtime: true   # ← acts as a guardrail in production
```

`where` is the only switch. One file: `ci: true` blocks the PR before merge; `runtime: true` blocks the agent before the tool call.

## The five things it can assert

All assertions are **deterministic** — deliberately no LLM-as-judge. A gate that false-positives gets switched off by the team within a week.

| Assertion | Catches | CI (check) | Runtime (guard) | promptfoo export |
|---|---|---|---|---|
| `forbid_tool` | called a forbidden tool | ✅ | ✅ | ✅ `not-trajectory:tool-used` |
| `allow_tool` | called a tool outside the whitelist | ✅ | ✅ | ❌ no whitelist primitive |
| `require_tool` | never called a required tool (any-of) | ✅ | — (no session-end hook) | ✅ single tool; multi-tool goes to manual (splitting into multiple asserts flips any-of into all-of) |
| `max_tool_calls` | suspected infinite loop | ✅ | ✅ (counted at the proxy) | ✅ `trajectory:max-tool-calls` |
| `idempotent` | same transaction executed twice (refund/charge) | ✅ | ✅ (in-session state) | ❌ needs business transaction-key semantics |

`idempotent` and (roadmap) `memory_persistence` are the real deltas over existing tools:

- **idempotent** needs to know which argument identifies one transaction — that's business semantics, generic eval frameworks can't reach it.
- **memory_persistence** (forgot the constraint stated in turn 2 by turn 20) is a per-turn assertion; existing tools only offer whole-conversation relevance — there is no "must still remember turn 2 at turn 20" primitive anywhere.

## Where rules come from: grown out of incidents

```bash
$ agentguard learn --trace examples/traces/refund_incident.json

  [90%] refund-incident-idempotent-refund-order — refund_order called multiple times with the same order_id
        · turns 7 & 9 share order_id='A1001'
  [82%] refund-incident-forbid-refund-order — destructive tool called in a read-only-intent session
        · matched read-only intent keywords: shipping / logistics / order (suggested intent_any)
Preview: 2 candidates above threshold (0.7). Confirm, then add --apply to write.
```

**Why human confirmation is mandatory**: deciding "which step was wrong" is a semantic question, and heuristics misjudge. So it only offers candidates + confidence + evidence; `--apply` writes. Any tool claiming "one-click trace-to-test" is dodging exactly this hard part. It also auto-excludes some false positives: if the user explicitly asked for the refund, that call won't be reported as an incident.

Three heuristics today (large sessions are optimized — 3000 duplicate calls resolve in under a second):
1. **Idempotency violations** (calls with fully identical args; auto-picks an `*_id`-style arg as the transaction key, confidence 0.85–0.9)
2. **Read-only intent × destructive tool** (0.82, built-in extensible action verb lexicon)
3. **Call loops** (same tool > 5 times per session, 0.75, tune the limit by hand)

## It doesn't fight for territory — it's a translation layer

It doesn't try to become the next standard (promptfoo owns CI assertions, NeMo owns runtime interception). Instead it's a translator: you maintain one rule file, it emits native config for tools you already use:

```bash
agentguard export --to promptfoo   # → not-trajectory:tool-used assertions
```

**What can't be translated is listed explicitly** (`allow_tool`, `idempotent`, conditional `when.intent_any` rules, any-of `require_tool`) — never silently emitted as config that looks right but never fires.

## guard: deploying the runtime guardrail

guard is an **MCP stdio transparent proxy**: to the agent client it looks like a normal MCP server; to the real MCP server it looks like a normal client. It only intercepts `tools/call`:

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

- Blocks return a JSON-RPC error (code `-32001`) carrying the rule name, assertion type, and evidence; clients surface it as an MCP error.
- Every decision is appended to an audit log (JSONL, `--audit`, default `agentguard-audit.jsonl`; first line is a `decision: "open"` probe record). **If the audit path isn't writable, guard refuses to start** — a guardrail without an audit trail is no guardrail.
- check runs a typo lint: tools referenced by rules but never seen in any trace get called out (such a rule has never fired — false safety).
- **Honest boundary**: the MCP proxy cannot see user chat messages, so `when.intent_any` rules only take effect when the caller injects intent via `_meta.agentguard.intent` in the `tools/call` params; otherwise they're skipped (one startup warning). `require_tool` is CI-only.

## Wiring up CI

`.github/workflows/agentguard.yml` (full example in `examples/`):

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
      # --trace accepts a directory (recursive); --strict treats duplicate rule names (multi-team governance) as errors
      - run: agentguard check --rules ./agentguard-rules --trace ./traces --strict
```

The trace format (v1) — see `examples/traces/refund_incident.json` — is a stream of session events: `user` / `assistant` / `tool_call` / `tool_result`. An OTel GenAI semantic-conventions converter is on the roadmap.

## When you don't need it

- Your agent is single-turn Q&A and doesn't call tools → promptfoo is enough
- You only measure answer quality (RAG accuracy, tone) → DeepEval / Langfuse
- Your agent never performs irreversible actions (no payments, deletions, messages) → a gate adds little value

It's genuinely valuable in exactly one scenario: **the agent can cause irreversible damage, and you ship changes often.** That's when the "CI can't guard production, production has no tests" gap becomes your incident source.

## Project layout

```
src/
  cli.js             entry & arg parsing (--help on every subcommand)
  rule.js            rule loading/validation/serialization (single doc, multi-doc, arrays, nested dirs)
  trace.js           trace v1 loading & validation (tolerates BOM)
  engine.js          deterministic assertion engine (CI full-trace eval + runtime per-call)
  learn.js           three incident heuristics → candidates (confidence + evidence, O(n) grouping)
  exportPromptfoo.js translation layer: translates what it can, names what it can't
  guard.js           MCP stdio transparent proxy + audit preflight & audit log
test/                node:test: unit + CLI e2e + real-process guard e2e + first-user journey + big-project scenarios
examples/            example rule, incident trace, GitHub Actions workflow
```

## Roadmap

- `memory_persistence` assertion (per-turn memory primitive: `fact_key` + `expect_remember`)
- OTel GenAI trace converter; Langfuse/LangSmith export readers
- `export --to nemo` (runtime guardrail config)
- Secrets exfiltration interception (outbound arg scanning for .env contents / keys)
- Durable idempotency state across restarts; multi-upstream gateway mode; `learn --watch`

## Limitations (honest list)

- `learn`'s heuristics cover typical incident shapes only; patterns below the confidence threshold are intentionally not reported.
- guard's idempotency/counters live in process memory: **restarting the proxy resets them** (the same transaction key called once before and once after a restart won't be caught). Persistence is on the roadmap.
- guard's `--upstream`: on Windows it goes through the shell (quoted paths supported); on POSIX it's split on whitespace — wrap complex commands in a script.
- trace v1 is a custom format; until the OTel converter lands you must export it yourself (it's plain JSON).
- promptfoo trajectory assertion type names — always double-check against current promptfoo docs.
- Audit log truncates args over 300 chars (log-bomb protection); full payloads live in upstream logs; secrets redaction is on the roadmap.
- Chinese output may garble on legacy Windows consoles — run `chcp 65001` first.

## License

MIT
