# 协议

整个系统是一个循环，三个口子。

```
          事件                领活
  来源 ─────────▶  中台  ◀───────── 接单程序 ── Agent
                   ▲ │
              回答 │ │ 卡片
                   │ ▼
                  通道 ◀──▶ 你
```

**中台的内核不主动连接任何东西。** 来源、接单程序、通道都是它们自己连进来：内核不用知道它们在哪、用什么语言写、是哪家的产品，也不保管它们的凭据；你的电脑不用开放任何端口。协议就是下面这份 HTTP + JSON，写一个新插件只要会发 HTTP 请求。

一台电脑上用时，一条 `up` 命令把三样都启动起来，它们之间照样走这份协议。

Windows 的接单程序在独立子进程里运行：设置文件权限、编译和等待 Job Object 托管器时，不阻塞中台接收请求或处理定时器。独立句柄表也避免了主进程启动通道消费者时继承接单程序同步命令的管道、让同步调用一直等不到 EOF。子进程继承启动时的环境（包括已加载的 `secrets.env` 和公开 URL），保留 Windows 不区分大小写的查找语义；不再实时共享父进程后续的环境修改。日志仍输出到 `up` 的 stdout/stderr，worker 配置经私有 IPC 传入，不出现在命令行中。HTTP 字段、密钥、插件入口和持久化格式不变；其他平台沿用原有执行方式。

`up` 监督接单子进程：创建后 300 秒内必须完成模块加载、目录准备和旧输出清理，之后处理进度心跳不能中断超过 120 秒。心跳来自本轮准备、私有记录保存或失败处理完成，以及处理旧任务、交回执、领活请求返回和处理循环完成，不靠独立定时器假报存活。领活正常可等待 50 秒，请求超时再留 30 秒，失败重试暂停 30 秒；这些都容纳在心跳期限内。能完成失败处理的网络故障仍走原有重试和断联通知。

超时先同步写日志，再强制结束当前 `up` 进程并返回非零状态，由 Windows 服务 runner 恢复。接单子进程出错或自行退出（包括退出码 0）也让 `up` 报错退出。子进程不设置 `detached`，由 Node/libuv 的 Windows Job 随父进程关闭回收，连同它的非独立辅助进程；即使卡在同步原生调用中也不必等待 JavaScript 处理退出。正常 IPC 断开时子进程也会退出。原有 detached Agent 托管器仍独立运行，不被这层回收终止，重启按原来的日志和 worker 记录恢复。前台运行需自行重启。根因、复现命令和验证见 [Windows 接单启动调查](windows-worker-startup.md)。

Windows 计划任务在登录时启动 runner，另用 `TimeTrigger` 每 5 分钟无限重复触发，`IgnoreNew` 保留正在运行的实例。动作使用由 `SystemRoot` 解析的绝对路径 `System32\wscript.exe`，参数为 `//B //E:JScript "<launcher.js>" "<node>" ...`；随引擎发布的 `host/windows-service-launcher.js` 用 `WScript.Shell.Run(cmd, 0, true)` 隐藏并等待 Node，`WScript.Quit` 返回其退出码。不经 `cmd.exe`，不改变交互登录令牌、最低权限或其他任务设置。时间触发从安装后 5 分钟开始，不必等下次登录；runner 意外退出时由下一次触发恢复，不依赖 `RestartOnFailure`。runner 对 `up` 所有退出码按 1、2、4、8、16、32、60 秒退避重启，连续健康 5 分钟重置。它每 15 秒异步探测既有身份管道（2 秒期限），同时核对 token 和本轮子进程 PID；从启动或最后有效回应起连续 5 分钟无回应，仅对直接启动的 `up` 执行 `SIGKILL`。libuv Job 回收其非 detached 子孙，detached Agent 托管器保留，新 worker 根据持久化 Job 名认领。长任务在其他进程里，不占用 hub 事件循环。runner 忽略 Ctrl+C / Ctrl+Break；隐藏启动没有可供误关的控制台窗口，强杀仍由重复触发恢复。未登录时不运行，休眠或资源繁忙可能推迟调度，5 分钟是触发间隔。

`service stop` 先在私有 home 写 `service.stopped`，再通过独立 service 身份管道停止看管，请求 `up` 正常退出；5 秒仍不退出则强杀 `up`，保留独立 Agent。退避期间、runner 已退出或 hub 卡死时也能保存停止意图。以后 runner 一见标记便退出 0，不启动 `up`；重复触发、重新登录及重启电脑都保持停止。`service install` 仍核对旧任务归属，成功重写 XML 后才清除标记并启动；直接前台 `up` 不清除标记。ACL 使用私有 .NET 辅助程序；身份查询、编译目录保护、编译和 ACL 设置每次限 30 秒，仅超时重试一次，权限错误直接失败，不再同步启动 PowerShell；Git 版本查询改成异步。归属核对同时接受旧版直接 Node 与新版隐藏动作，各自严格匹配完整程序和参数，再核对目录、用户及描述；安装、状态查询和移除共用此判断。旧任务及服务配置兼容，HTTP 与持久日志不变，升级后需运行一次 `service install` 换成隐藏启动。临时任务实测、同步调用清单和未确认的现场原因见 [Windows 服务恢复调查](windows-service-resilience.md)。

**中台没有界面。** 你和它打交道靠通道和命令行。想要一个页面或大屏，用「本人」一节的几个请求自己做，它和命令行是同等的客户端。

## 六个词

| 词 | 是什么 |
|---|---|
| **事件** | 发生了一件事：来源、编号、类型、对象、一句话、详情、回原处的链接。时间到了是事件，你点了卡片也是事件。 |
| **规则** | 写在 `rules.json` 里：什么事件，交给哪个 Agent，在哪个目录，用哪个 Skill，什么时候告诉你。 |
| **事项** | 同一条规则下同一个对象的事。事件归进事项，卡片、到期复查、会话都挂在事项上。规则没写 `parallel` 时，整条规则是一个事项。 |
| **一轮** | 一次执行：领一批事件，交一份回执，然后结束。一轮会结束，事项会继续。 |
| **回执** | Agent 的最后一条消息。它想让中台做的事全写在这里，这一轮结束时在一个事务里一次生效。 |
| **卡片** | 给你看的东西。提问让你选或写回答，事项接着往前走；普通通知让你处理后结案；只告知的卡片没有按钮，也不算待办。 |

## 六条原则

1. **注意力最贵。** 默认安静。没事不说话，能自己做的自己做完，只有规则写明要先问的事、确实需要本人解除的阻塞才打断你。
2. **一切都是事件。** 外部系统、时间、到期复查、你的决定，走的是同一条路。
3. **一切都连进来。** 内核没有对外的请求。凭据留在用它的地方，出事的范围也留在那里。
4. **Agent 就是一个进程。** 给它提示词，它打印最后一条消息。Claude Code、Codex、任何命令行 Agent、一段脚本、一条 CI 流水线都一样，不需要 SDK。要启动远端工作的进程，负责跟到真正做完才退出。
5. **一轮不等人。** 要问你就结束这一轮，收到回答后再开始处理，尽量接着原来的会话。等你的时候不占进程、不花 Token，重启也不丢。
6. **规则才是指令。** 事件决定不了交给谁、在哪个目录、用哪个 Skill、给什么权限，这些只由规则决定。别人写的话不进提示词，只放进标明“是资料”的文件。这挡不住所有提示注入，但把最坏的结果限制在规则给定的范围里。

## 规则

```jsonc
{
  "timezone": "Asia/Shanghai",                       // 定时和“今天”用的时区，默认系统时区
  "askFirst": ["删数据", "停服", "花钱", "对外发消息"],  // 只有这几类事 Agent 才先问你
  "sources":  { "shop": { "name": "shop" }, "github": { "name": "GitHub", "adapter": "github" } },
  "agents": {
    "claude": { "name": "Claude Code", "worker": "mac-mini", "use": "claude", "model": "…", "effort": "high", "access": "edit" },
    "cursor": { "name": "Cursor", "worker": "mac-mini", "use": "command", "command": ["agent", "-p", "--trust", "{prompt}"] }
  },
  "channels": { "feishu": { "name": "飞书", "answerers": ["ou_xxx"] } },
  "rules": [{
    "name": "处理告警",
    "when": { "source": "shop", "types": ["alert.*"] },   // 或 { "cron": "0 9 * * *" }
    "to": "claude", "cwd": "~/code/shop", "skill": "run-ops", "prompt": "按其中……一节处理。",
    "group": "ops",                                        // 同一组一次一轮，默认就是规则名
    "parallel": 3,                                         // 写了就按对象分事项：同一对象一次一轮，这一组最多 3 轮
    "tell": "needed",                                      // always 每次 / needed 只在有卡片时（默认）/ never 不推送
    "emits": { "source": "shop", "types": ["pr.*"] }      // 回执里能发什么事件，不写就不能发
  }],
  "elsewhere": [{ "name": "每周清理", "source": "shop", "to": "claude", "cron": "0 6 * * 0", "where": "Claude 应用的定时任务" }]
}
```

`elsewhere` 是在别处定时跑的任务：中台不启动它们，只在 `agent-autoloop status` 里列出来，它们要找你时用 `POST /v1/tell`。规则写错了，文件改动不生效，旧规则继续跑，并推一张卡片告诉你错在哪。

规则可写 `"ask": false` 禁止新建提问卡片；只接受布尔值，不写或 `true` 保持原行为。回执中每个 `ask` 都会被拒绝并记入 `rejected`（`what: "ask"`），`notice`、`events`、`resolve`、`later` 照常处理。需要本人决定的事用 `notice` 说明或按规则交出事件。此开关不关闭旧卡片，也不清除已有回答或会话。

Rule field `ask` is an optional boolean: `false` rejects each receipt question without creating a card; omitted or `true` preserves existing behavior. Other receipt fields still apply. Existing cards, answers and sessions are unchanged.

排队和等待重试的任务在领取时一起采用最新的 Agent、目录、提示词和权限；换了 Agent 就不带旧 Agent 的会话。已经领取的任务保留领取时的 Job 配置和接单程序，重复 claim、心跳、停止和重启恢复都不随规则更新换人。事件已经归属的事项不重新拆分或合并；回执中的提问许可、事件许可和通知方式仍按提交时的规则核验。

工作目录接受 Unix 绝对路径、`~/`，以及 Windows 盘符绝对路径（`C:/work`、`C:\work`）、UNC（`\\server\share\work`）和 `~\`；拒绝 `C:work`、`\work` 等含糊的相对路径。HTTP 字段不变，目录仍由可信规则指定。

规则可选写 `"workspace": "run"`（只接受 `"run"`）：把 `cwd` 当作已存在的根目录，接单程序自动创建 `<cwd>/run-<工作区所属 run id>` 并在那里启动 Agent；`~` 照旧展开。同一件事的续跑（重试、回答、定时器）和回执修复都在同一个文件夹，新的任务分开。不写时仍直接在 `cwd` 运行。代理环境变量 `AGENT_AUTOLOOP_WORKSPACE` 始终是实际工作目录。

工作区 id 是 run 的 `workspace_run`，没有就用自己的 id。发卡片或设置定时器时，与 session 一起记录工作区 id 和 Agent；回答或到期创建新 run 时，仅同一个 Agent 继承工作区与会话，多次续跑一直沿用第一轮的文件夹。未上报 session 也继承工作区。事件并入排队 run 时保留继承信息；失败合并排队 run 时，带回其 resume 和工作区。换 Agent 时清除继承，规则修改 `cwd` 时采用新根目录；事项和 run 的生命周期不变。

投影格式指纹随查询列定义变化，升级从原事实日志重建，不改写历史事实。旧 run 缺少工作区字段时使用自己的 id；旧卡片可用 `run_id` 找到发卡目录；旧定时器没有 Agent 和工作区记录：照旧续接原会话，工作目录用续跑 run 自己的 id。

目录不会自动清理，保留策略由使用者决定。例如：

```json
{
  "name": "整理资料",
  "when": { "cron": "0 9 * * *" },
  "to": "codex",
  "cwd": "~/work",
  "workspace": "run",
  "prompt": "整理本轮资料，在当前工作目录保存结果。"
}
```

## 来源：把世界变成事件

```
POST /v1/events                    Authorization: Bearer <来源的密钥>
{ "id": "12:new", "type": "feedback.new", "subject": "#12", "summary": "…", "detail": "…", "link": "https://…" }
→ 200 { "event": 34, "duplicate": false, "routed": ["处理意见"] }
```

- `id` 和 `type` 必填。同一来源同一 `id` 只记一次，所以来源尽管重发。
- `subject` 只能是标识符（字母、数字和 `# . _ : / @ -`），`link` 只能是纯 ASCII 网址，因为它们会进提示词。`summary`、`detail` 不进提示词。
- 没有规则匹配的事件也留着，`agent-autoloop status` 看得到。

三种别的进法，到中台都是同一种事件：

- **定时**：规则写 `cron`。错过的（比如电脑合盖了）醒来只补最近的一次。重复的时刻（夏令时）只跑第一次，不存在的时刻跳过。
- **别人家的 Webhook**：`POST /v1/in/<来源>`。来源配了 `adapter`，就交给 `plugins/<adapter>/source.ts` 里的函数验签、翻译成事件，它只翻译，不发请求。验签用的秘密放在 `secrets.env`，不进 `rules.json`。
- **轮询**：不用连公网，没新东西不花 Token。规则定时叫一段脚本（也是一个 Agent），脚本在回执的 `events` 里交回新事件。事件的 `id` 要稳定，读的范围可以重叠，中台会去重；脚本要在回执交出去之后才推进自己的游标，或者干脆不留游标。

来源或 `elsewhere` 任务有话要直接告诉你（不用 Agent 处理）：

```
POST /v1/tell    { "key": "weekly-44", "text": "…" }              Authorization: Bearer <来源的密钥>
POST /v1/tell    { "task": "每周清理", "key": "x", "text": "…" }   Authorization: Bearer <接单程序的密钥>
→ 200 { "card": 56, "duplicate": false }
```

## Agent：领活、干活、交回执

每台电脑上有一个接单程序，它只往外连。一台接单程序可以服务多个 Agent。

```
GET /v1/work?claim=<这次领活的编号>&wait=50&running=7,8&capacity=1    Authorization: Bearer <接单程序的密钥>
→ 200 { "job": null | Job, "cancel": [7] }
```

- 没活时最多等 `wait` 秒，新活一来立即返回。`running` 是手上在跑的，同时也是心跳。`capacity=0` 只报到、不领活。
- 响应丢了，用同一个 `claim` 再来一次，拿回的是同一份活。
- 本人开启维护后不再发新 claim；同一 worker 已领取的同一 claim 仍可重取。心跳、回执、取消和卡片不受维护影响，响应字段不变。
- `cancel` 是要停掉的。POSIX 接单程序先向整个进程组发停止信号，10 秒后仍有进程运行就强制结束；Windows 用 Job Object 立即结束整个进程树。确认没有活进程后才交 `outcome: "cancelled"`，这个事项才放开。停止期间重启接单程序也继续这一步。
- Windows 10/11 使用系统 .NET Framework 4.x 编译私有目录中的进程托管器。进程在创建时原子加入禁止脱离的 Job，唯一的长期 Job 句柄由托管器持有，关闭即终止整树；因此外部强杀托管器也清理子孙。重启根据持久化的随机 Job 名检查和停止，不凭可能重用的 PID。启动参数文件的独占锁覆盖尚未创建 Job 的阶段；恢复方拿到同一锁后才可撤销迟到启动，不能先释放轮次再让旧托管器执行业务。中台自身退出不会关闭独立托管器，重启可认领原有 Agent。Windows Codex 插件用同一启动环境与权限模式运行 `codex sandbox`，探测实际工具用户 SID，只给该 SID 本轮 `agent/` 资料目录的读权限（`read`）或读写权限（`edit`）。context 和输出在资料目录，轮次凭据、退出标记和启动参数仍在私有父目录；hub 数据库、主密钥、秘密及配置不共享。不按账号名或用户组猜测身份，不修改全局沙箱配置或自动改用完整权限。PATH 和登录目录继承启动终端，npm Node shim 解析为 Node 参数，不经过命令解释器；其他 batch 命令请明确写 `node` 与脚本或使用原生程序。

```jsonc
// Job：一轮的全部。token 只对这一轮的这一次执行有效。
{
  "run": 12, "token": "…", "attempt": 1,
  "rule": { "name": "处理告警", "cwd": "~/code/shop", "skill": "run-ops", "prompt": "按其中……处理。" },
  "agent": { "id": "claude", "name": "Claude Code", "use": "claude", "model": "…", "effort": "high", "access": "edit" },
  "session": null,       // 尽量接着的会话：重派时是上一次的，回答来了是提问那一轮的。接不上就开新的，所以它只是优化
  "askFirst": ["删数据", "…"],
  "context": {           // 接单程序把它写成文件交给 Agent，都是资料
    "events":  [{ "id", "source", "sourceName", "type", "subject", "summary", "detail", "link", "receivedAt" }],
    "answers": [{ "card", "title", "options", "choice", "text", "about", "by", "at" }],  // 这一轮要接着做的决定
    "timers":  [{ "key", "about", "at" }],                                               // 这一轮到期的复查
    "waiting": [{ "key", "about", "at" }],                                               // 这个事项还没到期的复查
    "open":    [{ "card", "title", "text", "at" }],                                      // 同来源同组还没收尾的卡片
    "decided": [{ "card", "title", "choice", "at" }]                                     // 这个事项定过的事，只对当时那件事有效
  }
}
```

`Job.rule.workspace` 是可选的 `"run"`，由可信规则传给接单程序；仅此模式附带 `Job.workspaceRun`，表示工作区所属 run id。未设置模式时省略两个字段，旧规则的 Job JSON 不变。接单程序使用 `workspaceRun` 拼目录，旧 Job 缺少该字段时回退到 `run`。该模式要求接单程序同步升级，旧接单程序可能忽略新字段或不能沿用工作区。事件不能指定 `workspace`、`workspaceRun` 或目录。run id 和工作区 id 在拼路径前必须是正整数，生成目录的父路径必须等于根目录的绝对路径；根目录符号链接和 junction 沿用原有文件系统解析，不另加限制。

`Job.rule.ask` 是可选布尔值，供接单程序按领取时的规则生成提示；不写时保持旧提示原文。新增字段不改变缺省规则的 Job JSON，旧接单程序即使仍提示提问，内核也会拒绝禁用规则的 `ask`。

```
POST /v1/runs/12/started   Authorization: Bearer <token>   { "session": "…", "link": "claude://…" }
POST /v1/runs/12/result    Authorization: Bearer <token>   Result
→ 200 { "rejected": [{ "card": 9, "reason": "不在本轮核对范围" }] }
```

```jsonc
// Result
{
  "outcome": "done" | "nothing" | "failed" | "cancelled",
  "summary": "一句话", "error": "没跑成的原因", "session": "…",
  "usage": { "input": 0, "output": 0, "cached": 0, "cost": 0 },
  // 下面就是回执，一个事务里一次生效
  "ask":     [{ "title", "text", "options": ["…", "…"], "recommend": 0, "about": "留给接着干的自己", "key": "这件事的固定名字", "input": "返工意见" }],
  "notice":  [{ "title", "text", "key", "fyi": true }], // fyi 可选；只告知才写 true，需要本人做事时不写或写 false
  "resolve": [{ "card": 3, "reason": "在哪核实了已解决" }],
  "later":   [{ "key": "…", "at": "2026-11-05T09:00:00+08:00", "about": "到时候查什么" }, { "key": "…", "cancel": true }],
  "events":  [{ "id", "type", "subject", "summary", "detail", "link" }]
}
```

- 结果可以重放：响应丢了，同一个 token 再交一次同样的内容，得到同样的确认；内容不同返回 409。
- `failed` 会重派，所以它只带 `notice`，其余的不生效。
- 只是让人知道、不需要人做事时，用 `notice` 的可选布尔字段 `fyi: true`，例如 `{"notice":[{"title":"已交给 Agent","text":"结果会用卡片告诉你","key":"handoff","fyi":true}]}`。复用 `/v1/tell` 和 `tell: "always"` 运行报告已有的 `fyi` 卡片：从创建起就是 `kind: "notice"`、`state: "closed"`，没有按钮，不进 `context.open` 或待办统计，不需要 `resolve`，回答不会唤醒事项。仍按规则的 `tell` 送达，`never` 不推送；`failed` 回执也可带它。
- 要本人亲自做事才用普通 `notice`（省略 `fyi` 或写 `false`），保留“已处理”按钮。非布尔 `fyi` 会被拒绝。只告知不会自动完成实际业务，也不能当作本人批准。
- 需要本人恢复连接、登录或身份验证时，用 `done` 结束本轮并交 `ask`，不交 `failed`。`done` 表示本轮结束，未完成的事项由卡片继续跟进，不代表网页已经验收。同一阻塞已有 `open` 卡片时不重复提问，不用 `later` 定时重试；`waiting` 里同一阻塞已有的复查用 `cancel` 取消。保留已完成业务，`about` 写清恢复后只做哪些剩余步骤。
- `usage` 由接单程序上报本次执行的用量，包含这次执行的回执重写；每一项都可以没有：`input`、`output`、`cached` 是 Token 数，`cost` 是美元。中台把同一轮各次执行的已报数值相加，重复提交不重复计费；没有上报的字段保持缺省，不当成零。`agent-autoloop status` 按完成时间汇总今天和最近 7 天已结束的轮次，没上报的轮数如实写出来。升级不重算旧回执，升级前已经被覆盖的累计值不会自动补回。
- 回执 `ask` / `notice` 的 `key` 范围是这个事项。同 key、同 kind 的卡片还开着时，`title`、`text`、`options`、`recommend`、`about`、`input` 任一变化就更新原卡：`version` 加一，`content_version` 设为这个新版本。省略可选字段会清除旧值；内容相同不加版本、不重发。不同 kind 仍按重复处理；关闭后再交是新卡；`once` 通知及系统通知的行为不变。
- 只告知的回执卡片虽然一直是 `closed`，同事项、同 key 仍按内容更新原卡，保留创建时间和各通道的 `ref`，相同内容不重发。它与同 key 的普通通知或提问各自独立：不会关闭旧待办，也不会把告知改成待办。不写 key 时沿用标题和正文的摘要作 key，内容变化会建新卡。沿用报告卡片的 24 小时首发窗口（按创建时间）：未送达通道超过一天不补发，包括后来更新的卡片；已经送达的通道仍能原地更新。没有原地更新能力的通道照旧只报告新版本。
- 内容更新保留卡片编号、创建时间、回答链接和原提问的事项、会话归属，各通道保留原 `ref`，重新获得发送尝试（包括之前已放弃的通道）。恢复投递后追上最新版本；重试再次耗尽仍会放弃，首次送达前已经关闭的卡片仍不发。
- 回执事实的 `meta.cards` 列出 `{card, action}`，`action` 为 `created`、`updated` 或 `duplicate`；重复提交同一回执不再写事实。严格校验日志的客户端需同步新版 schema，旧事实不要求有 `meta`。
- 兼容：数据库已保存 `fyi`，无需改表或迁移；旧卡片及旧日志语义不变，旧回执仍建普通通知。`Card.fyi` 是新增布尔输出，旧中台可能省略；通道仍可按 `state` 和 `options` 渲染。使用新回执前需升级中台与接单程序，旧版会拒绝该字段。
- `ask.input` 是可选的文字框标签，1–20 个 Unicode 码点，不能全是空白；不写时显示“别的想法”。卡片页与飞书都把它用作标签和提示，文字提交仍是 `{text}`。
- `resolve` 只能结同来源、同组、这一轮领活前就有的卡片，越界的写进 `rejected`，不影响这一轮的结果。
- `later` 的 `key` 范围是这个事项，同一个 `key` 再写一次就是改时间。
- `events` 的来源由规则的 `emits` 决定，回执改不了。

以上需要提问的说明只适用于允许 `ask` 的规则；`ask: false` 时改用 `notice` 或规则允许的事件，不能自行执行需要本人决定的事。

### Agent 只需要做一件事

接单程序把提示词交给 Agent，Agent 的最后一条消息就是回执：

````
第一行一句话结论。可自动重试的临时失败写「没跑成：原因」，需要本人恢复的阻塞写「待你处理：原因」并交 ask，没事可做写「没事可做：原因」。其余结束本轮，事项由回执继续跟进。

```agent-autoloop
{ "ask": [ … ], "notice": [ … ], "resolve": [ … ], "later": [ … ], "events": [ … ] }
```
````

代码块可有可无。Agent 不需要装任何东西、不需要连中台，所以沙箱里的、云端的 Agent 也能接。

回执写错不重做业务：接单程序接着原会话，只让它把最后一条消息重写一遍，最多两次。还是读不懂，或重写进程启动失败、报错、超时、没有输出，就保留原业务消息第一行的结局，回执作废，推一张卡片告诉你原文在哪；补回执失败不会把已完成的业务变成自动重试。

### 接一个新 Agent

规则里写一行，任何能打印最后一条消息的命令都行，退出码不是 0 就算没跑成：

```json
{ "name": "Hermes", "worker": "mac-mini", "use": "command", "command": ["hermes", "chat", "-Q", "-q", "{prompt}"] }
```

想要会话接续、打开会话的链接、用量统计，就在 `plugins/<名字>/agent.ts` 写一个文件（见 `plugins/claude/agent.ts`）：

```ts
export default {
  prepare: (run, env) => {},                              // 可选：启动前准备资料访问，env 与实际进程一致
  command: (run) => [...],                                // 这一轮的命令行，run.resume 是要接着的会话
  read: (output) => ({ text, session, usage, finished }), // 从输出里读出最后一条消息和会话
  link: (session) => "…",                                 // 可选：打开这个会话的链接
};
```

专用插件的 `access` 三档，翻译成各自 CLI 的权限：`read` 只读，`edit` 只改工作目录（默认），`full` 完整权限、不审批。只读不等于读不到密钥，要隔离密钥请用系统账号或容器。`command` 只传命令参数，不替任意程序限制权限。

浏览器由 Agent 的运行环境提供。Codex 使用后台 `codex exec`，不能假定桌面应用的浏览器连接自动可用；使用该轮实际可用的浏览器工具，或规则、Skill 明确配置的入口。入口只处理网页步骤并接续自己的会话，业务和回执仍由主任务负责。中台不附带浏览器桥接，不安装或授权浏览器工具；接入验收见[插件说明](plugins.md#浏览器接入)。

## 通道：把卡片送到你面前

通道是一个往外连的小程序。

```
GET /v1/cards/next?wait=50    Authorization: Bearer <通道的密钥>
→ 200 { "card": null | Card }

// Card：这张卡片现在的样子。内容和状态都能更新；content_version 只随内容变化
{ "id": 56, "version": 2, "content_version": 2, "input": "返工意见", "ref": null, "kind": "ask", "state": "open",
  "title": "…", "text": "…", "options": ["…", "…"], "recommend": 0,
  "choice": null, "answer": null, "result": null, "link": null }
```

- `ref` 是空的就发一条新的；不是空的就把那条改成现在的样子，改不了就直接报告。
- 发完报告：`POST /v1/cards/56/delivered { "version": 2, "ref": "om_xxx" }`。没报告的过一分钟会再给你。**支持幂等键的平台，发新消息只用卡片编号，不带版本**。平台不支持时无法保证去重，Webhook 模板可能在报告丢失后重发。
- 发不出去：`POST /v1/cards/56/failed { "version": 2, "error": "…" }`。第一次发送隔得越来越久地重试，一小时后放弃（卡片还开着，`agent-autoloop status` 看得到）；通道一直没来领不算在内。
- 还没送达就已经解决的卡片不再打扰你。
- 你点了：`POST /v1/cards/56/answer { "choice": 1, "version": 2, "by": "ou_xxx", "ref": "om_xxx" }`。只有第一次算数，`by` 要在这个通道的 `answerers` 里，`ref` 要和送达的那条一致。送达时保存 `version`，回答时原样带回；文字回答用 `text` 替代 `choice`。普通通知有一个“已处理”按钮，点了就结案；`fyi: true` 的只告知卡片始终 `closed`、`options: []`，通道不能添加按钮或文字输入框。

`answer.version` 可选，提供时必须是正的安全整数。身份与原消息核对通过后，小于当前 `content_version` 就返回 HTTP 409，`error` 为“卡片已更新，请重看”，不记录回答、不唤醒事项；仅状态变化不提高 `content_version`。省略版本保持旧行为，旧通道可逐步升级，但没有防止旧内容误答的保证。卡片页的每个表单都带隐藏 `version`；交互式 `try` 和 MCP 回答也可携带所显示版本。飞书选项与表单提交均携带版本，过期提示回复在原消息下，不因拒答重发整张卡片。

最小的通道只要十几行：领卡片、发文字和 `link`、报告。`link` 只给配了 `"links": true` 的通道，其他通道这里是 `null`。它打开一个不跑脚本的普通表单页，这张卡片的文字和按钮都在上面，谁拿到链接谁就能答，有效期 7 天，适合只会发文字的群机器人、邮件。能发按钮、能收回调的通道（比如飞书）用按钮，身份由平台核验，更安全。一台电脑上用时 `link` 是本机地址，手机打不开，要手机批请把中台放到有公网地址的机器上，并配好 `publicUrl`。

## 本人：看全局、回答、结案、停止

```
GET  /v1/state              Authorization: Bearer <本人的密钥>
→ 200 { "totals", "cards", "recentCards", "agents", "channels", "sources", "lines", "elsewhere", "runs", "nextBefore", "unrouted" }

POST /v1/cards/56/answer    { "choice": 1, "version": 2 } 或 { "text": "别的想法", "version": 2 }
POST /v1/cards/56/resolve   { "reason": "不用决定了，因为……" }
POST /v1/runs/12/cancel     {}
```

`agent-autoloop status`、`answer`、`resolve`、`stop` 就是这几个请求。`/v1/state` 一次给最近 60 轮，`?before=<nextBefore>` 翻更早的。

取消 queued 立即结束，取消 claimed 仍由接单程序停止进程后交回结果。unknown 则由本人核实旧执行已停止及业务状态后确认按未完成结束，终态为 `cancelled`，不自动重做。通知正文说明“已处理”的这一作用，按钮和请求字段不变，旧通知也可处理；通道仍核对回答者和原消息，带权限的卡片链接沿用原授权范围。worker 和 Agent 的凭据不能代本人取消或回答。本人结束后，原 token 的迟到结果沿用 HTTP 401 拒收，worker 记录拒收并放下本地结果，不修改终态、不应用回执或再次派发。已有终态及 queued、claimed 的取消语义不变，无需数据迁移。

`/v1/state` 的 `spending.today`、`spending.week` 独立于分页，按规则时区的今天和过去 7 × 24 小时的完成时间汇总。每项含 `rounds`、`tokens`、`cost`、`missingTokens`、`missingCost`，后两项是没报对应用量的轮数；从未开始就取消的轮次不计入。旧请求和响应字段保持不变，旧客户端可以忽略新增字段；新版 `status` 需要中台一起更新，不再逐页读取历史来算费用。

Windows 后台使用当前用户的计划任务，`InteractiveToken`、最低权限、`IgnoreNew` 单实例；不存密码，不改系统 PATH。任务在登录时和每 5 分钟触发 runner；`up` 的退避重启和健康超时回收由 runner 负责，保留独立 Agent，计划任务的一分钟失败重试只作额外措施。安装时保留终端 PATH，登录状态仍由 Agent 自己读取。启动日志追加到 `logs/up.log`。同一数据目录用带随机凭据的本地命名管道拒绝第二个中台和第二个 runner；`service stop` 保存跨登录和重启的停止标记，再通过独立 service 管道停止看管和中台，`service install` 恢复。`service remove` 删除属于当前安装的任务并停止中台；卸载保留数据。

三个平台的服务安装都会保存当前 `AGENT_AUTOLOOP_RULES` 的绝对路径，未设置时不保存覆盖值，仍从数据目录读取 `rules.json`；重装会更新或移除旧覆盖值。`service install` 成功后显示规则文件位置。Windows 沿用 `service.json` 的 `agentHomes`，已有手动写入的 `AGENT_AUTOLOOP_RULES` 仍有效。

安装与卸载不改变 HTTP 协议。`agent-autoloop --version` 显示包版本与提交；`agent-autoloop uninstall` 确认后移除自身程序、链接和服务，始终保留规则、密钥和记录；`--yes` 只跳过确认。

### 持久维护闸门

本人用同一个地址读状态和切换模式；其他种类的密钥、轮次 token 和卡片链接都不能操作它。

```jsonc
// Authorization: Bearer <本人的密钥>
GET /v1/maintenance
// 200（示例中的 id 每次新维护由宿主生成）
{ "mode": "draining", "id": "2d84c800-03ea-4d45-8b10-938628a08bc0",
  "entered_at": "2026-11-05T02:00:00.000Z", "deadline": "2026-11-05T03:00:00.000Z",
  "claimed": 1, "unknown": 0, "expired": false, "problem": null,
  "rules_version": 42, "rules_hash": "<SHA-256>" }

POST /v1/maintenance
{ "action": "drain", "deadline": "2026-11-05T03:00:00.000Z" }
{ "action": "hold", "id": "<上面返回的 id>" }
{ "action": "renew", "id": "<同一个 id>", "deadline": "2026-11-05T04:00:00.000Z" }
{ "action": "resume", "id": "<同一个 id>" }
// 每个对象是一次独立请求；成功都返回与 GET 相同的状态。
```

| 动作 / 状态 | 约定 |
|---|---|
| `drain` → `draining` | 原子关闭新领取，生成新 `id`，期限必须在将来；已在维护中就返回当前状态，不换 ID、不延长期限、不从 held 退回 draining |
| `hold` → `held` | 必须匹配 ID，且 `claimed=0`、`unknown=0`；否则 409。领取后还没报 started 的也算 claimed；queued、等回答和 later 不要求清空 |
| `renew` | 匹配 ID，保持模式及 entered_at；只能延长到将来或重复当前期限，不能缩短。重复同一续期无额外作用 |
| `resume` → `normal` | 只有当前 ID 可以恢复；期限已到返回 409，需外部核对后续期再恢复。正常状态保留最后一次 ID，重复 resume 成功；旧 ID 解不开下一次维护 |
| 期限到了 | `expired=true`，只是要求外部核对，绝不自动恢复；仍可排空并进入 held |
| 文件缺失、不可读或非法 | `mode=draining`、`id/entered_at/deadline=null`、`problem` 如实说明，不能新领取。本人核对并修复文件访问后，可重新 drain 建立新 ID；不能拿旧 ID 直接 resume |

事件、cron、later 和本人回答照常持久入队；卡片照常送达，已领取任务继续心跳、报 started、交结果和处理取消。失联但仍为 claimed 的同一 claim 可重取，既有 token 轮换及回执重放规则不变；unknown 尚未由本人结束时，迟到结果照常收。若不会再有结果，本人核实旧执行已停止及实际业务状态后，用 `POST /v1/runs/:id/cancel`、CLI `stop <轮次>`、MCP `stop`，或在该轮“不确定”通知上点“已处理”，将该轮按未完成结束（`cancelled`），写入 `finished_at` 和“本人确认按未完成结束”，并关闭对应通知。确认 `claimed=0`、`unknown=0` 后即可 hold；单纯 resolve 卡片不改变轮次状态。`drain` 和 `hold` 立即返回，不让 Agent 等排空。

`rules_version` 是当前生效配置在事实日志中的版本，`rules_hash` 是该配置（解析并补齐默认值后）的 `JSON.stringify` UTF-8 内容的 SHA-256，不是磁盘文件原文的哈希。坏规则未被接受时，两者仍指向旧配置。部署方应比较部署前后版本、哈希与预期配置，并同时检查 `problem`、计数和模式；HTTP 200 本身不是规则已生效或排空的证明。

宿主在既有 `execute` / SQLite `BEGIN IMMEDIATE` 串行边界内鉴权、读取 `<home>/maintenance.json`、判断计数并原子替换文件；claim 在同一边界内重新读取文件，给 `decide` 的 `environment.allowNewClaims` 传布尔值。长轮询每次唤醒都重新走这个入口。内核只在找不到已领取的同一 claim 时检查这个输入，不读文件或时钟；缺省输入保留旧内核调用行为。文件写入先同步临时文件、再 rename，POSIX 还同步目录；重启不会清除 held。

首次接入此功能且文件不存在时，宿主创建 `normal`，三个时间/身份字段为 null；SQLite 的宿主表 `host_maintenance` 只记“已经初始化”，用于区分旧安装与后来丢失的文件，投影重建不清除此标记。维护模式以文件为准，不写业务事实、不改既有日志格式、不改变规则身份或领取快照。备份保留维护文件和数据库；升级前已有的客户端无需改协议。部署顺序是 drain → 确认无 claimed/unknown 后 hold → 停服、更新、重启 → 核对状态与生效规则 → 用保存的 ID 显式 resume。首次升级到支持维护的版本前，旧引擎尚无这个口子。

## 失败时会怎样

| 出了什么事 | 会怎样 |
|---|---|
| 来源把同一条事件发了两遍 | 只记一次 |
| 领活的响应丢了 | 同一个 `claim` 拿回同一份活 |
| 交结果的响应丢了 | 重放得到同样的确认 |
| Agent 没跑成 | 5 分钟后重派，每次翻倍，最长 1 小时；期间来的同一事项的事件并进这一轮；连续第 3 次告诉你 |
| 需要本人恢复浏览器连接、登录或验证 | 本轮结束，保留已完成业务和待验收项，用问题卡片等回答，不自动重派 |
| 原会话接不上 | 开新会话，靠资料文件接着干 |
| 回执写错 | 只重写回执，不重做业务 |
| 接单程序重启 | 在跑的 Agent 不受影响，回来接着盯 |
| 接单程序在线，但 5 分钟没报手上的某一轮 | 标成“不确定”，放开这一组，告诉你；本人核实后可按未完成结束，此前的迟到结果照常收 |
| 接单程序整台不见了 | 活留着不放开，10 分钟后告诉你一次，回来后这张卡片自动收尾 |
| 中台重启 | 全在 SQLite 里，大家自动重连 |
| 定时错过了 | 醒来只补最近一次 |
| 你点了两次，或者两边同时点 | 只算第一次 |
| 提问之后问题自己好了 | 后面的 Agent 核实后在 `resolve` 里结掉，卡片自动改成“不用决定了” |
| 规则写错了 | 旧规则继续跑，告诉你错在哪 |

这是“至少一次”的系统：Agent 可能被叫两次，所以 Skill 里有副作用的动作要先核实当前状态。

## 谁能做什么

| 凭据 | 能做 | 不能做 |
|---|---|---|
| 来源的密钥 | 以自己的名义发事件、发消息 | 冒充别的来源，领活 |
| 接单程序的密钥 | 领交给它的活；以交给它的 `elsewhere` 任务的名义发消息 | 碰别人的活，发事件 |
| 一轮的 token | 报告这一轮的这一次执行 | 碰别的轮次 |
| 通道的密钥 | 领卡片、报告、转达 `answerers` 的回答 | 其他一切 |
| 带权限的卡片链接 | 回答这一张卡片 | 其他一切 |
| 本人的密钥 | 看全部、回答、结案、停止、控制维护 | 发事件，领活，改规则（规则只在文件里） |

普通访问密钥只保存 SHA-256；本机主密钥另存 `master.key`。接单程序不把中台密钥放进 Agent 的提示词或资料文件，文件系统的访问范围由 Agent 权限决定。

## 日志与确定性

每次被接受的输入产生一批事实，`commit` 在 SQLite WAL + FULL 的同一个事务里完成判断、追加日志并让 `evolve` 更新视图，提交完成才应答。规则版本、密钥哈希、领活、回执和回答都在日志里；日志从不存轮次 token、卡片链接 token 或中台主密钥。主密钥由外壳保存在本机文件，轮次 token 和卡片链接用 HMAC 分别推导。重复 claim 仍重新签发 token，上一份立即失效，保持现有行为。

`decide(view, input, now, environment)` 不改传入视图和输入。`evolve(view, facts)` 是唯一的持久投影写入者；时钟、规则文件、随机材料、网络和单一定时器由外壳提供。事实包含版本、序号、时间、种类和规范化记录变更，重放不重新运行规则。视图通过 SQLite 索引按需读取；一次判断只保留本次改动，不复制整表，不在 JavaScript 中常驻全部历史。日志、投影、日志游标、编号高水位及派生索引一起提交；删掉记录也不复用其编号。正常启动直接打开投影。外壳自动计算投影实现、查询列定义和能力派生实现的格式指纹；旧版没有游标或指纹不匹配时，在同一事务内逐条读取日志、重建投影和索引，不能覆盖期间的新提交，不一次把日志读进内存。首次升级可能需要等待重建；不改旧事实，不需要数据迁移。模拟使用同一套投影和判断实现，数据库放在内存中。

Node 请求转换层保持在 50 行内；文件、SQLite 连接、监听和定时器也由外壳提供。

`GET /v1/stream?after=42` 仅接受本人的密钥，返回 SSE：`id` 是日志序号，`event: fact`，`data` 是事实 JSON。断线用 `Last-Event-ID` 或 `after` 从下一条继续；从 0 读全量，按订阅者读取速度逐条发送，不预先缓存全部日志。不给订阅者发送密钥哈希或能力凭据。

`GET /v1/runs/42/why` 仅接受本人的密钥，返回与本轮事件、每次执行的规则版本、领取、回执、卡片回答有关的事实。命令行 `agent-autoloop why 42` 使用同一接口，时间按本机时区显示为 `MM-DD HH:mm:ss`，默认显示事件、规则版本、领取者、起止时间、会话、回执、回答和接续轮次的时间线，不打印规则正文；`agent-autoloop why 42 --json` 输出原始事实。解释查询通过记录与日志序号的索引定位事实。这些接口沿用本人的访问权限。内部回答和定时事件遇到已存在的编号时按序加后缀，保持来源与编号唯一，不覆盖来源的事件。

## 一致性和复现

插件入口统一为 `plugins/<名字>/agent.ts`、`channel.ts` 或 `source.ts`，先找安装目录，再找引擎内置目录。`agent-autoloop add <git 地址>` 将插件仓库克隆到安装目录的 `plugins/<仓库名>`，仓库根目录直接放入口文件，不自动更新，不执行安装脚本。插件是本人安装的可信代码，事件不能指定插件路径。

事件接受可选的 `hops`，非负安全整数，缺省为 0。回执事件强制使用本轮所有事件最大 hops 加 1；提问的回答和 later 定时延续原深度。超过 8 的事件仍记录但不派发，并产生通知；重复提交不重复通知。这是中台内处理链的限制，外部来源直接发出的新事件可以从 0 开始。旧日志没有 hops 时按 0 读取。旧卡片缺少 `content_version` 时重放为 1（创建版本，不取当前状态版本），缺少 `input` 时为 `null`。投影格式指纹变化触发现有的自动重建，不改旧日志，也不写迁移。

`DELETE /v1/keys/<source|worker|channel|owner>/<名字>` 只接受本人密钥，返回 `{ok:true}`。`agent-autoloop key remove <种类> <名字>` 调用正在运行的中台，删除立即唤醒并拒绝该密钥的长轮询，关闭日志订阅。已领取的一轮继续用独立的轮次 token 交结果。

`protocol/schema.json` 使用 JSON Schema 2020-12，定义事件、回执、任务、卡片和日志的格式。`agent-autoloop conformance <测试地址> --config <文件>` 走真实 HTTP；文件包含 `keys`（source、worker、channel、owner 四把测试密钥）、能匹配测试规则的 `eventType` 和通道允许的 `answerer`。规则要能把该来源和类型交给该接单程序，`parallel` 至少为 2，通道要限制回答人。检查会写入事件和卡片，只在专用测试中台运行；同一个测试中台可以连续检查。各来源的签名格式由对应插件的测试检查。

文字上限按 Unicode 码点计算。`usage` 必须是数值非负且有限的对象，不能是数组；`later.at` 必须是真实日期的 ISO 日期时间，带 `Z` 或时区偏移。回执先核验整体，再执行。

`npm test` 包含种子 24301 的 200000 步模拟，以及两台接单程序、两条来源事件、一张问题卡片的全部 8!（40320）种动作顺序；另检查卡片更新、旧版本回答、当前版本文字回答、结案、两通道投递、重启的全部 7!（5040）种顺序。模拟每 128 步换一个独立场景，每个场景结束前停止故障并把工作处理完；每次状态转换都检查不变量和完整日志重放；随机动作包含同 key 内容更新与旧版本回答，核对带版本的已接受回答不早于当时的内容版本、恢复后可投递的更新在各通道追上最新版。定时事件由真实到期表触发，恢复后检查到期任务没有遗留。它证明这些有限场景，不代表任意大小状态空间已被穷尽。单独复现：`node sim/random.ts 24301 200000`、`node sim/enumerate.ts`。

`npm run test:nightly` 做 1000 次真进程 SIGKILL、包括只告知卡片在内的可执行内核变异和性能检查。崩溃用真 SQLite WAL + FULL，核对已确认序号、完整性、视图、重放和重复提交；它测进程退出，不模拟整机断电。变异漏过的名字和比例直接输出，不能用语法错误算检出；`receipt-fyi` 故意丢掉回执的告知标记，必须被行为测试检出。`node sim/crash.ts 1000 12648430` 和 `node sim/mutate.ts` 可分别复现。

模拟的正确性检查必须通过；模拟速度只是开发效率的观察指标。性能检查使用逐条 HTTP 写入，事务落盘后才应答。空闲 RSS 和千连接负载 RSS 分开测；检查实现见 `scripts/metrics.ts`，实测数字见 README。Windows 只报告性能数字，不按 M5 预算判定；POSIX 预算检查不变，所有平台仍需通过 1000 个真实同时等待连接及成功响应等正确性检查。大历史量（结果见[历史增长实测](#历史增长实测)）用 `node scripts/history.ts 1000 10000 100000` 验证真实业务、HTTP 响应、慢速日志订阅、强杀重试和完整重建；每个场景含两轮任务、提问、投递、回答和定时复查，逐笔 WAL + FULL 提交。请求走真实 HTTP，每类操作测 30 次取中位数，状态汇总测一次；持续写入、空闲及请求负载内存分别报告，不手动触发 GC。

### ACP 和 MCP

`use: "acp"` 配合 `command: ["某个 ACP 程序", "启动参数"]` 使用 stdio ACP v1。桥接先初始化，再新建或加载会话；加载时重放的历史不算这一轮的回复，思考和工具输出不进回执。只有 `end_turn` 且有最后一条文字消息才算完成。会话编号交给中台保存。没有声明文件读写、终端或交互登录能力，Agent 用自己的工具；需要登录时先用它自己的命令行登录。

权限只选一次性的选项：`read` 允许结构化的读和搜索，`edit` 再允许工作目录内的编辑（核对符号链接），`full` 允许其他操作。未提供相应选项就取消。权限依赖 Agent 遵守 ACP，不提供额外的系统隔离。核对依据：[初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[会话](https://agentclientprotocol.com/protocol/v1/session-setup)、[工具权限](https://agentclientprotocol.com/protocol/v1/tool-calls)。

`agent-autoloop mcp` 提供 stdio MCP，固定支持 [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) 版，不支持 2026-07-28 的无握手协议。工具为 `status`、`why`、`answer`、`resolve`、`stop`、`emit`、`tell`；按本机已有的本人或来源密钥展示工具。它调用同样的 HTTP 接口，不直接改数据库；密钥留在本机 `config.json`。MCP 客户端把程序设为 `node`，参数设为引擎的绝对路径 `bin/agent-autoloop.ts` 和 `mcp`，环境里指定 `AGENT_AUTOLOOP_HOME`。标准输出只写 JSON-RPC。

### 通道模板与命令行示例

Webhook 通道的 `config.json` 配置使用 `use: "webhook"`、`url` 和 `platform`，后者可选 `dingtalk`、`wecom`、`slack`、`discord`。不写 platform 时可用 `body` 自定义模板，字符串里的 `{text}` 替换为卡片内容。四个模板对照官方文档：[钉钉](https://open.dingtalk.com/document/orgapp/custom-bot-send-message-type)、[企微](https://developer.work.weixin.qq.com/document/path/91770)、[Slack](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)、[Discord](https://discord.com/developers/docs/resources/webhook#execute-webhook)。钉钉和企微检查响应的 `errcode`，Slack 检查 `ok`；Discord 禁止文字触发提及。超过企微 2048 字节或 Discord 2000 字的卡片会报告失败，不截断问题或回答链接。Webhook 本身没有幂等保证，消息发送成功但报告丢失时可能重发。

桌面通知 `desktop` 是新安装默认打开的通道：macOS 用 `osascript`，Linux 用 `notify-send`，Windows 用 PowerShell 和系统 `NotifyIcon`。通知标题是“Agent 问你一个问题”，正文是卡片标题和“运行 agent-autoloop status 查看”；POSIX 文字通过 `--` 后的参数传入，Windows 以 UTF-8 Base64 参数交给固定脚本，均不拼进脚本。Windows 的显示由用户通知设置决定，无需注册应用。没有图形会话时不调用通知程序，报告 `skipped-<卡片编号>`，不反复打扰；卡片仍可通过命令行查看和回答。有图形会话但通知命令不存在或失败时报告 `failed`，由中台安排重试。卡片更新只报告，不重复弹出。

`examples/worker.ts` 和 `examples/channel.ts` 可用 Node 24 在三个平台运行；POSIX 另有只用 shell 内置命令、curl、jq 的 `.sh` 版本。设置 `AGENT_AUTOLOOP_URL`、`AGENT_AUTOLOOP_KEY` 后运行；`AGENT_AUTOLOOP_ONCE=1` 只领一次。接单示例交回 `AGENT_AUTOLOOP_RECEIPT` 中的 JSON，默认交回完成；通道示例把卡片输出到终端，再报告送达。它们是短任务示例，不适合长任务；长任务使用 `worker/` 的心跳、停止和恢复。`tests/examples.test.ts` 在通过协议一致性检查的临时中台上实际运行两个脚本，覆盖提问、送达、回答、继续和错误密钥。

## 业务场景模板

`examples/recipes/` 提供七套场景。反馈处理、网站巡检和飞书周报与业务摘要默认使用飞书本人私聊与 `Asia/Shanghai`；都是现有规则、通道和 `command` 的组合，没有增加协议字段或内核产品知识。

反馈来源只负责唤醒同一事项，当前业务状态和授权从可信接口重新读取。网站检查以本规则未关闭的异常通知卡片作为故障记录：首次失败发通知及排查事件，持续失败安静，恢复结案并发恢复事件；手动关闭未恢复卡片后仍失败会重新报告。飞书采集完整读取后写私有快照并发事件，摘要核对快照编号，旧事件不使用新资料；采集与摘要同组串行。只有本人身份可读的数据参与汇总，不把不可见当成未提交。

浏览器交接模板是主任务对已安装入口的参数调用，不新增协议或浏览器驱动。可信配置固定命令、目标与允许操作，续办使用入口实际返回的 Codex 会话编号；网页内容和外部事件不能改这些范围。连接、登录或验证受阻时由主任务 `ask` 并结束本轮，回答后只继续剩余网页步骤，浏览器助手不再次委派或独立结案。

反馈、巡检和飞书摘要的脚本使用本地假 HTTP 和假飞书 CLI 验证，不调用真实业务数据、不发真消息。公开样例不含内部地址、账号或业务记录；用户替换后的资料不应提交到仓库。结构与通道职责未变，架构图沿用现有三口协议。

## 结构与预算

一条只追加的事实日志是业务状态的来源；视图可重建，重放不重新执行规则。cron、later、重试、租约和离线判断共用到期表，外壳只安排下一次到期的定时器。接口是 HTTP + JSON；专用 CLI、MCP、来源、接单程序和通道都使用同一组接口。

| 目录 | 职责 |
|---|---|
| `kernel/` | 确定性决策、演进、日志、到期、规则匹配、请求处理、卡片表单 |
| `host/` | Node HTTP、文件与 SQLite 连接、时钟、配置、后台服务和插件加载 |
| `protocol/` | 类型、JSON Schema、输入校验、HTTP 客户端与一致性检查 |
| `worker/` | 接单、Agent 进程、心跳与停止、回执读取和提交 |
| `cli/`、`bin/` | 用户命令、MCP 与命令行启动入口 |
| `plugins/` | Agent、事件、通道和交付插件，统一发现入口 |
| `examples/recipes/` | 完整场景的规则、任务 Skill 与启用说明 |
| `examples/plugins/`、`examples/skills/`、`examples/*.sh` | 最小插件、独立任务手册和 curl/jq 示例 |
| `skills/agent-autoloop/` | 中台的正式配置与操作手册，供用户和 Agent 使用 |
| `docs/` | 通信协议、插件开发说明与架构图 |
| `tests/` | 日常行为测试及测试辅助代码 |
| `sim/` | 固定种子模拟、有界穷举、强杀与变异 |
| `scripts/`、`.github/workflows/` | 性能与真机验证、安装冒烟和跨平台 CI |

现成场景与内置插件的入口见 [README](../README.md#拿来即用的场景模板)，开发模板见[写插件](plugins.md)。插件文件名仍使用协议中的 `source.ts`，对应面向用户的“事件插件”。

| 检查 | 上限或下限 |
|---|---|
| Node 运行时依赖 | 0 |
| 冷启动到监听 | POSIX ≤150 ms；Windows 只报告 |
| 启动后空闲 1 秒 RSS | POSIX ≤60.4 MB；Windows 只报告；负载 RSS 单列观测 |
| 逐条 HTTP 提交、落盘后应答 | POSIX ≥2000 条/秒；Windows 只报告 |
| 事件到等待者领活 p99 | POSIX ≤10 ms；Windows 只报告 |
| 同时长轮询 | ≥1000 |
| 模拟吞吐 | 记录耗时和步数，不设速度门槛 |

性能预算来自 Apple M5 Pro 上的本地检查，不代表其他机器的容量；POSIX 保持严格检查。Windows 使用同一测法、采样、事务、事件数和连接创建方式，完整输出性能数字，并以 `platform`、CPU 型号 `machine` 和 `budgetPolicy: "report-only"` 标明只报告（POSIX 为 `"enforced"`）；模拟、强杀、变异及千连接正确性检查仍须通过。Node 24.21.0 的原基线也会超过 60 MB，空闲内存预算按实测峰值 60.394 MB 取到 60.4 MB；不通过改变采样时间或主动触发 GC 降低读数。最新实测、机器、完整复现命令在 README。日志只追加，不压缩，磁盘占用仍随历史增长。常驻内存不保存全部历史，待处理工作及返回结果仍会占用内存；统计总量仍需遍历数据库索引。没有总览页、工作流画布、Agent 记忆、模型路由、多租户或插件市场。

### 历史增长实测

Apple M5 Pro、24 GB、Node 24.21.0，用 `node scripts/history.ts 1000 10000 100000` 复现：

| 已完成任务轮数（约） | 事实条数（约） | 正常启动 | 空闲 RSS | 领活 HTTP 中位数 | 状态汇总 |
|---|---:|---:|---:|---:|---:|
| 2,000 | 11,000 | 84.7 ms | 59.1 MB | 0.89 ms | 11.2 ms |
| 20,000 | 110,000 | 83.2 ms | 58.9 MB | 0.84 ms | 83.6 ms |
| 200,000 | 1,100,000 | 99.8 ms | 59.1 MB | 0.82 ms | 927.1 ms |

- 110 万条事实时，收事件、去重、交结果、心跳、空闲通道轮询和 `why` 的请求中位数为 0.39–0.69 ms；进程被强杀后正常恢复约 101 ms。
- 内存：持续写入历史时最高约 282 MB；业务请求加一个慢速日志订阅约 75 MB。
- 会随历史变大的：状态汇总耗时，以及日志和索引占的磁盘。
- 格式变化后首次启动要从日志全量重建：110 万条用时 43.1 秒，峰值约 141 MB，重建前后数据一致。平时重启不重放。
- 20 万步模拟（观察项）：93.8 秒，2131 步/秒。

## 交付插件

交付是 `plugins/delivery` 的普通 Agent 进程，内核不认识它。项目仍用 `ops/delivery.json`，标签仍是 `deliver`、`deliver-attended`、`deliver-review`、`ask-owner`，提交状态仍为 `delivery`。审查状态默认 `agent-review`，由 `review.status` 修改；命令由 `review.command` 修改。设置格式、规则与 Ship 示例见[配置手册](../skills/agent-autoloop/SKILL.md#交付流水线)。

来源只给事件，仓库与执行命令由中台规则固定。内置 `poll.ts` 读取待处理标签，以“仓库、事项、标签记录、当前提交”生成稳定事件编号，不另存游标。无标签、关闭且未合并、fork 或非 main 目标不启动交付。每个 PR 一个事项，并发由规则 `parallel` 和接单程序容量控制；进程失败使用中台的 5 分钟起重试和连续失败通知，不另建队列、槽位、失败计数或通知服务。

| 步骤 | 必须满足 |
|---|---|
| 读取设置 | 用本轮 main 的固定提交读项目设置和审查要点，不读 PR 里的版本 |
| 同步 | PR 已包含 main；缺少时请求 GitHub 同步后结束这一轮，由中台重试 |
| 审查 | 裸 Git 对象转文字差异；只审分支自己的提交，排除干净合入 main 的变化，保留冲突解决；普通内部文档可略过模型 |
| 审查进程 | 不检出 PR，不执行其中的代码、测试、设置或 hooks；默认 Codex 忽略用户配置和记忆，只读独立快照 |
| 完整检查 | 草稿先转 ready；只接受当前提交最新一次 pull_request 工作流和指定 job 都完成且成功，草稿或 skipped job 不算 |
| 合并 | 再读 PR head、main 和标签；变化就重来；检查通过后才写可配置的审查状态，按已审查 SHA 合并 |
| 自动合并与响应丢失 | 先关闭已有自动合并并读回确认；合并响应丢失先看是否已经合并，不盲目再提交；清标签失败也读回确认是否已移除 |
| 发布 | 等一个覆盖合并提交的 Ship 成功，再核对健康版本；健康 HTTP 200 不能覆盖 Ship 失败或尚未完成 |
| 后续发布 | 新版覆盖且确实上线可以完成旧交付；已经完成的交付不因后来的失败发布倒退 |

`deliver-review` 审查通过就结束并移除交付标签，不代表已检查、合并或上线；在等待检查期间加上这个标签，合并前也会停在只审查，不写允许合并的审查状态。审查发现问题写 `delivery=failure`，交回问题；`deliver-attended` 不额外产生通知卡片。普通 issue 的 `ask-owner` 只将可读正文变成问题卡片，去掉代码块和本机路径，答复后移除标签。不向 GitHub 发评论，不建立 PR 说明里的多轮审查账本，也不支持用“已处理”文字豁免发现的问题；新提交重新审查。

已经合并的 PR 直接继续跟踪 Ship 和健康检查。默认最多跟踪 30 分钟，超时交给中台重试；没有健康设置的项目明确报告只完成合并。发布范围对比**健康版本到目标提交的整个差异**：只有普通内部文档变化可跳过，可执行位、符号链接、重命名到外部路径、未知历史都要求发布；后来只有文档变化不能让尚未完成的代码发布被跳过。

Ship 使用本引擎仓库的 `plugins/delivery/action.yml`，项目固定到发布后的完整提交。Action 只输出 `release` 和 `superseded`，项目已有发布步骤根据输出运行。它与交付进程共用 `project.ts` 的范围与健康判断，不在项目里长期复制工具。

普通健康 URL 只允许 HTTPS。测试时必须显式传 `--test-local-health`，Action 同样要 `test-local-health: 'true'`，才接受 `http://127.0.0.1`；不接受其他 HTTP 地址。GitHub 合并规则由项目维护者设置。
