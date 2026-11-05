# Agent Autoloop

**Let your command-line agents pick up work and follow it through in the background — staying quiet when they can handle it, and sending you a card only when a decision is yours to make.**

[中文](README.md) | **English**

[Get started](#get-started) · [Recipes](#ready-to-use-recipes) · [Plugins](#plugin-ecosystem-swap-any-of-the-four-sides) · [Kernel](#four-kernel-mechanisms) · [Docs](#documentation)

![Architecture](docs/architecture.en.svg)

## What problem does it solve?

Most of us use command-line agents like Claude Code or Codex by babysitting a terminal: you type a prompt, watch it run, and answer its questions. Close the window or walk away, and the work stops.

**Agent Autoloop** turns your command-line agents into a background loop. At the center is a deterministic **kernel** with zero runtime dependencies. Around it, event sources, agents, notification channels, and even CI/CD delivery pipelines are all swappable **plugins**.

- **One machine, one install command.** Runs on macOS, Linux, or Windows. No cloud server or inbound ports required.
- **Connect a new agent in one line.** No SDK, no agent source code to fork. Any CLI tool that takes a prompt and prints a final reply can plug in.
- **No web dashboard.** Cards reach you on Feishu, DingTalk, WeCom, Slack, Discord, or desktop notifications when you are needed. Everything else is one command away.

## Get started

Works on macOS, Linux, and Windows 10/11. You need Node 24, Git, and at least one command-line agent already signed in; no GitHub account required. You can also hand the [installation guide](INSTALL.md) to your agent and let it install everything for you.

macOS / Linux (also requires curl):

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

Windows (PowerShell 5.1 or later):

```powershell
irm https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.ps1 | iex
```

Windows uses a scheduled task triggered when the current user signs in, without administrator privileges. Logs go to `~/.agent-autoloop/logs/up.log`. Installation preserves the terminal PATH and agent configuration directories, using the user's existing login; run `agent-autoloop service install` again after changing them. With `--no-service`, run `agent-autoloop up` in a terminal. `agent-autoloop service status` checks the background service; `service stop` stops the engine while preserving startup at the next login, and `service remove` also removes the scheduled task. `agent-autoloop stop <round>` stops a round's entire agent process tree. Shell examples require their corresponding shell; native Windows command agents use explicit `node.exe` / `.exe` commands and arguments.

On Windows, the Codex plugin probes the actual sandbox user SID with the current `codex sandbox` configuration. Only the turn's `agent/` data directory is shared: read access for `read`, read/write for the default `edit`. Hub databases, keys, configuration and worker control records remain owner-only. No user group is granted access, and the plugin never switches to `full`.

On Windows, `up` runs its worker in a child process, isolating synchronous commands from the hub event loop and channel child-process handles. If the worker does not initialize within 30 seconds or stops making progress for 120 seconds, `up` logs the reason and exits nonzero so the scheduled task can restart it. The worker child is reaped with `up`; detached agents remain available for recovery. Foreground runs need a manual restart; see the [protocol](docs/protocol.md).

On all three platforms, `agent-autoloop service install` remembers a custom rules path set with `AGENT_AUTOLOOP_RULES` and prints its absolute path; reinstall after changing or unsetting the variable to update the service.

Then run a real loop with your own agent — ask, exit while it waits, make the call, resume:

```bash
agent-autoloop try
```

> CLI output and default notification strings are currently in Chinese.

Here is the actual output from Codex in a non-interactive terminal:

```text
事件发出去了，Agent 开始干活……

Agent 结束了这一轮，问了你一个问题。它现在不占进程、不花 Token。

【等你决定】#1 试跑：选一个颜色
这是一次试跑，选哪个都行。
  1. 蓝色
  2. 绿色
回答：agent-autoloop answer 1 <序号>
答完运行 agent-autoloop status，能看到它接着把活干完。
```

In an interactive terminal, just type the option number. In a non-interactive terminal, run `agent-autoloop answer 1 2` to pick green. Then `agent-autoloop status` shows that the agent resumed its conversation and finished, along with rounds, tokens, and cost for today and the past seven days ([how they are counted](skills/agent-autoloop/SKILL.md#看情况回答)).

## How a piece of work flows

The numbers match the diagram above:

1. **An event comes in.** A 9:00 AM schedule, a new GitHub issue, or a production alert becomes a standard event sent to the kernel.
2. **Dispatched by your rules.** Your rules decide which agent handles it and in which folder. New events for the same subject while it is queued merge into one round.
3. **Work one round and exit.** The agent puts its result in its final message, and the process exits.
4. **Asks only when needed.** For sensitive actions like deleting data, restarting a service, spending money, or messaging people, the kernel sends you a card through Feishu or a desktop notification. While you take your time, no agent process runs and no tokens are spent.
5. **One tap resumes it.** Your answer picks up the original conversation and finishes the job.

Anything the agent can handle alone takes the auto-loop at the top of the diagram: finish outright, or schedule a follow-up check (say, in 30 minutes) without bothering you.

## Day-to-day usage

### Write your rules (`rules.json`)

No glue code needed. Open `~/.agent-autoloop/rules.json` and, under `rules`, declare **what happened, who handles it, and where they work**. Set `to` to a name already under `agents`. For example, write a brief every morning at 9:

```json
{
  "name": "Morning brief",
  "when": { "cron": "0 9 * * *" },
  "to": "codex",
  "cwd": "~/notes",
  "prompt": "Summarize yesterday's notes and commits into today's brief."
}
```

External events work the same way once the source is connected. To hand new GitHub issues to Codex, first register `github` under `sources` ([guide](skills/agent-autoloop/SKILL.md#接一个事件插件)):

```json
{
  "name": "Handle issues",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "codex",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

Changes take effect within seconds of saving. Run `agent-autoloop check` to validate. If you make a mistake, the hub keeps running the previous valid rules and sends you a card pointing out the error.

Set `"ask": false` on a rule to forbid question cards: the engine rejects each receipt `ask` while applying other fields normally. Explain owner decisions with `notice` or emit an event permitted by the rule. Omitting `ask` or setting it to `true` preserves existing behavior; existing cards and answers are unchanged.

### How agents talk back to the hub

The hub asks only one thing of an agent: **put your result in your final message**. When the job is done, a one-line conclusion is enough. To ask you something, the agent appends an `agent-autoloop` block:

````text
Order checked. We have enough stock in the warehouse.

```agent-autoloop
{
  "ask": [{
    "title": "How should we ship it?",
    "text": "Both options can go out today.",
    "options": ["Courier", "Pickup"],
    "key": "shipping",
    "input": "Other requests"
  }]
}
```
````

Besides `ask`, receipts can send notifications (`notice`), resolve open cards (`resolve`), schedule follow-up checks (`later`), and emit new events (`events`). If the JSON is invalid, the hub has the agent rewrite just that final message in the same session, without repeating completed work. If rewriting also fails, it keeps the original conclusion and tells you the receipt was not applied.

For information that needs no human action, write `{"notice":[{"title":"Handed off to the agent","text":"The result will arrive as a card","key":"handoff","fyi":true}]}`. This reuses the existing report card: no buttons, closed from creation, excluded from pending counts and `context.open`, with same-key content updates. Ordinary `notice` still means the owner must do something and retains its acknowledgement button. FYIs and actionable cards have separate lifecycles; old cards are unchanged. The existing 24-hour first-delivery window applies, measured from creation even after edits; delivered messages can still update later. Upgrade both hub and worker before using `fyi`; older versions reject the new receipt field. See the [protocol](docs/protocol.md#agent领活干活交回执).

Submitting an open `ask` / `notice` again with the same key and kind in the same thread updates that card when its content changes; identical content is not resent. Feishu and the card page accept both options and free text. Optional `input` sets the text field label (up to 20 Unicode code points), defaulting to “别的想法” (other thoughts). Answers carry the displayed version; outdated content is rejected with “卡片已更新，请重看” (the card has changed; please review it). Legacy channels may still omit the version; see the [protocol](docs/protocol.md#通道把卡片送到你面前) for compatibility.

### Pause claims for deployment

The owner-only `GET /v1/maintenance` and `POST /v1/maintenance` provide a persistent gate. Send `{"action":"drain","deadline":"<future ISO timestamp>"}` to stop new claims; the host returns a fresh `id`. Existing claims can still be recovered by the same worker and claim ID, including before `started`. Heartbeats, results, cancellation, events, cron, deferred checks, answers and card delivery continue normally.

When `claimed` and `unknown` are both zero, send `{"action":"hold","id":"<returned id>"}`. Queued work, open questions and future checks need not be empty. A nonempty count returns 409. Stop the service, update it, restart, and verify the reported mode and accepted rules before sending `{"action":"resume","id":"<same id>"}`. Restart preserves `held`. A stale ID cannot release a later maintenance cycle; repeating entry while active, the same renewal, or the current resume is idempotent. Entry never regresses held to draining.

Every successful request returns `mode`, `id`, `entered_at`, `deadline`, `claimed`, `unknown`, `expired`, `problem`, `rules_version` and `rules_hash`. The hash is SHA-256 of the UTF-8 `JSON.stringify` of the accepted, parsed rules including defaults, not the file bytes. Invalid rules leave the previous version and hash visible. Deadline expiry only flags external verification; it never reopens the gate. After checking, renew with `{"action":"renew","id":"<same id>","deadline":"<future ISO timestamp>"}` before resuming. Renewals cannot shorten the deadline. Resume may also cancel draining; it always requires the current ID.

The host atomically replaces `<home>/maintenance.json` under the same SQLite transaction boundary as claims and rechecks it on every long-poll wakeup. Only the deterministic `environment.allowNewClaims` boolean enters the kernel. Missing, unreadable or invalid files report `draining`, null identity/timestamps and a `problem`, and block new work; repair access and start a new drain cycle after verification. A host-only initialization marker in SQLite distinguishes legacy installations (initialized to normal once) from a subsequently lost file, including after projection rebuilds. Back up the file with the database. Business fact formats, claim snapshots, rule identities and legacy worker responses are unchanged. Engines predating this feature do not have this endpoint. See the [full protocol](docs/protocol.md#持久维护闸门).

## Ready-to-use recipes

Each recipe includes rules, a task Skill, and setup instructions (written in Chinese).

| Task | Included workflow |
|---|---|
| [Morning brief](examples/recipes/morning-brief/README.md) | Summarize local notes and Git commits at 8 AM by default; write `briefs/YYYY-MM-DD.md` |
| [GitHub issues](examples/recipes/github-issues/README.md) | Poll every five minutes, edit code locally, and notify you to review; no commits, pushes, or issue replies |
| [Production alerts](examples/recipes/ops-alerts/README.md) | Receive an error, investigate local code, ask before restarting, and continue after your answer |
| [User feedback](examples/recipes/feedback/README.md) | Re-read current feedback, fix, deliver and verify, then prepare a reply; ask you in Feishu and resume after your answer |
| [Website watch](examples/recipes/website-watch/README.md) | Check status and expected content every five minutes; wake the agent on a new incident, keep ongoing failures quiet, and update the card on recovery |
| [Feishu weekly and business brief](examples/recipes/feishu-brief/README.md) | Read selected reports and tables with your permissions at 6 PM Sunday; summarize locally and send only a short summary to Feishu |
| [PR delivery](skills/agent-autoloop/SKILL.md#交付流水线) | Add `deliver` to a PR to review it, wait for CI, merge, wait for deployment, and verify the live version |

**To enable one:** open its instructions, put the task Skill in your agent's skills directory, merge the sample rules into `~/.agent-autoloop/rules.json`, replace worker names and paths, then run `agent-autoloop check`.

Feedback, website watch, and Feishu briefs default to Asia/Shanghai and send only to the owner's private Feishu chat. Sample data is fictional; scripts and receipts have been verified only with local HTTP and a fake Feishu CLI, not run end to end on a live account.

More: [Claude-to-Codex browser handoff](examples/recipes/browser-handoff/README.md), [weekly code cleanup](examples/skills/weekly-sweep/SKILL.md), [ship a PR](examples/skills/ship-pr/SKILL.md).

## Plugin ecosystem: swap any of the four sides

Built-in plugins ship with the program and are enabled through configuration. Use `agent-autoloop add <git URL>` for third-party plugins.

| Side | Built in | Setup |
|---|---|---|
| **Events**: how work is found | [GitHub Webhook](plugins/github/source.ts), [HTTP API](docs/protocol.md#来源把世界变成事件), [cron rules](skills/agent-autoloop/SKILL.md#改规则), [issue polling script](examples/watch-github-issues.sh) | [Guide](skills/agent-autoloop/SKILL.md#接一个事件插件) |
| **Agents**: who does the work | [Claude Code](plugins/claude/agent.ts), [Codex](plugins/codex/agent.ts), [ACP](plugins/acp/agent.ts), [generic command](plugins/command/agent.ts) | [Guide](skills/agent-autoloop/SKILL.md#接一个-agent) |
| **Channels**: how cards reach you | [Desktop notifications](plugins/desktop/channel.ts) (on by default), [Feishu](plugins/feishu/channel.ts), [DingTalk / WeCom / Slack / Discord](plugins/webhook/templates.ts) | [Guide](skills/agent-autoloop/SKILL.md#接一个通道) |
| **Delivery**: CI/CD as a plugin | [`delivery`](plugins/delivery/delivery.ts) | [Guide](skills/agent-autoloop/SKILL.md#交付流水线) |

**What has been tested:** Claude Code, Codex, and ACP (with the official Codex ACP adapter) have run multi-turn Q&A and session resumption across processes. Feishu has run real delivery, button callbacks, and card updates. The four webhook templates have only been checked against local mock servers. These text channels answer through a link, so `hub.publicUrl` must be reachable from your phone or computer.

**Other CLI agents connect in one line.** Set `use: "command"` and pass a command array; `{prompt}` is a single argument, never evaluated as shell code. These commands come from each tool's official docs, and we have not run each of them yet:

| Agent | Command |
|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md#dsh-headless) | `dsh --profile headless {prompt}` |
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/cli) | `hermes chat -q {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/headless) | `codebuddy -p {prompt}` |

**Delivery pipeline.** Add the `deliver` label to a GitHub PR and it follows through to release: **review → wait for CI → merge → wait for deploy → verify the live version**. Settings are read only from `main`, and PR code is never checked out or run on the worker machine. Queueing, concurrency, and retries come from the kernel.

**Write your own.** Start from the runnable [agent](examples/plugins/hello-agent/agent.ts), [channel](examples/plugins/hello-channel/channel.ts), and [event](examples/plugins/hello-source/source.ts) templates and the [plugin guide](docs/plugins.md). For web tasks, read [browser access](docs/plugins.md#浏览器接入) first. The CLI and [MCP](skills/agent-autoloop/SKILL.md#mcp-与密钥撤销) can also inspect and answer cards.

The Feishu channel requires **lark-cli 1.0.99 or newer** to read card JSON from standard input (`--content -`); version 1.0.96 does not support this argument. The new Feishu 2.0 text form and stale-answer feedback have been checked against official documentation and a fake CLI, but have not been verified with a live Feishu account.

## Four kernel mechanisms

The kernel is about 1,700 lines with zero runtime dependencies. It reads no clock, uses no randomness, and makes no outbound requests; plugins connect in, and credentials stay with the plugins that use them. Identical inputs always give identical results. It brings four proven systems patterns to command-line agents:

- **Zero-cost wait**: The process exits while waiting for your call, and the waiting state lives in SQLite, so the agent does not stay alive. If you reply three days later, no agent process runs and no tokens are spent in the meantime — only the lightweight hub waits in the background; your answer resumes the original conversation.
- **Event sourcing**: All state is derived from an append-only fact log, committed in the same SQLite transaction as its indexes before the hub replies. Confirmed facts survive `SIGKILL` (whole-machine power loss is not separately tested), every run can be traced with a single command, and format changes rebuild from the log without migration scripts.
- **Code / data split**: Like parameterized SQL. Issue titles, bodies, and other external text are written only to a local data file, never into the prompt, which carries only character-checked types, IDs, and links; `rules.json` alone decides which agent runs, in which folder, and with what access. Events carrying `cwd`, `agent`, or `access` fields are rejected outright.
- **Hop circuit breaker**: Like packet TTL in networking. Events returned by an agent can dispatch more agents, and the hop count keeps growing — across human questions and scheduled follow-ups too — and an agent cannot reset it. Past 8 hops, the kernel records the event, stops dispatching, and sends you a notice card.

### Check it yourself

Run these from `~/.agent-autoloop/app`:

| What it checks | Command |
|---|---|
| The full story of any round | `agent-autoloop why 1` |
| 200,000 simulated steps of network loss, dropped packets, crashes, and duplicate requests, reproducible from one seed | `node sim/random.ts 24301 200000` |
| 1,000 process kills with no acknowledged record lost | `node sim/crash.ts 1000 12648430` |
| The benchmarks below | `npm run benchmark` |

```text
第 1 轮 · 演示
11-03 20:47:25  规则版本 #1
11-03 20:47:25  触发事件：来源 local · 类型 demo.start · 对象 example
11-03 20:47:25  local 领取（演示程序）
11-03 20:47:25  结束：演示完成
```

### Benchmarks

Apple M5 Pro, 24 GB, Node 24.21.0. Each write is a separate request, acknowledged only after its transaction is durable. The performance limits in `npm run benchmark` remain enforced on POSIX platforms, so another machine may report a miss. Windows keeps the same measurement method, sampling, event counts, and connection creation, reporting all measured values without applying the M5 performance limits. Output includes `platform`, CPU model `machine`, and `budgetPolicy: "report-only"` (`"enforced"` on POSIX).

Windows must still establish 1,000 real, concurrently waiting long polls and receive 1,000 successful responses. Simulation, crash, mutation, and other correctness checks remain mandatory. Cold start, idle and loaded RSS, durable throughput, dispatch p99, and simulation duration and throughput are all still reported.

| Metric | Measured |
|---|---:|
| Cold start | 88.78 ms |
| Idle memory | 59.94 MB RSS |
| 1,000 concurrent waiting polls | 170.49 MB RSS |
| Durable writes | 2,394 events/s |
| Dispatch p99 | 1.82 ms |
| Startup at 1.1 million facts | 99.8 ms |
| Kernel lines (with comments and blanks) | 1,651 |
| Runtime dependencies | 0 |

As history grows, the status summary slows down and the log and indexes keep using disk. The first start after a format change rebuilds from the log, which took 43.1 seconds for 1.1 million facts. [Full numbers and method](docs/protocol.md#历史增长实测) (in Chinese).

## Usage and provider terms

The hub invokes command-line tools you have already installed and signed into on your machine; it never reads or exports their credentials. Model usage is billed to your own account under each provider's terms.

For automated workloads, providers generally recommend using API keys rather than personal subscription quotas (which are designed around interactive personal use — see [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) and [OpenAI](https://learn.chatgpt.com/docs/auth)). Use API keys if you are running services for others. This project is independent and is not affiliated with or endorsed by those providers.

## Documentation

- [Installation guide](INSTALL.md)
- [Configuration & delivery pipeline manual](skills/agent-autoloop/SKILL.md)
- [Writing plugins](docs/plugins.md)
- [Full HTTP protocol specification](docs/protocol.md)
- [Security boundaries](SECURITY.md)
- [Contributing and community](CONTRIBUTING.md)
- [Development guidelines](AGENTS.md)

<details>
<summary><strong>Repository layout</strong></summary>

| Location | Contents |
|---|---|
| `kernel/` | Decisions, fact log, projections, deadlines, rule matching, endpoint behavior, and card forms |
| `host/` | Node HTTP, files and SQLite connections, clock, configuration, background services, and plugin loading |
| `protocol/` | Wire formats, JSON Schema, input validation, HTTP client, and conformance checks |
| `worker/` | Claim work, run agents, handle heartbeats and cancellation, read and submit receipts |
| `cli/`, `bin/` | User commands and entry point: status, answers, `why`, MCP, updates, and uninstall |
| `plugins/` | Built-in agent, event, channel, and delivery plugins |
| `examples/recipes/` | Complete recipes with rules, a task Skill, and setup instructions |
| `examples/plugins/`, `examples/skills/`, `examples/*.sh` | Minimal plugin templates, standalone task guides, and Shell examples |
| `skills/agent-autoloop/` | The hub's configuration and operation manual, also made available to agents during installation |
| `docs/` | Protocol, plugin guide, and Chinese / English architecture diagrams |
| `tests/`, `sim/` | Everyday behavior tests, simulation, enumeration, crash tests, and mutation checks |
| `scripts/`, `.github/workflows/` | Performance and real-agent checks, installation smoke scripts, and Linux / macOS / Windows CI |
| Root documents, `install.sh`, and `install.ps1` | Chinese / English READMEs, installation, security, development guidelines, license, and installers |

Start reading at `bin/agent-autoloop.ts` → `cli/main.ts`, then follow the feature into `host/`, `worker/`, or `plugins/`. Read the [protocol](docs/protocol.md) for kernel design. Similarly named files serve different layers: `host/http.ts` adapts Node requests while `kernel/http.ts` defines endpoint behavior; `protocol/rules.ts` validates input while `kernel/rules.ts` defines rule types and matching.

</details>

[MIT License](LICENSE)
