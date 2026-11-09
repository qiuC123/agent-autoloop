# 写插件

先看 [README 的内置插件目录](../README.md#插件体系四个方向都能自由替换)选择已有实现；需要扩展时，从下面三个可运行的最小模板开始，替换业务部分：

| 模板 | 已经演示了什么 | 你要替换什么 |
|---|---|---|
| [Agent 模板](../examples/plugins/hello-agent/agent.ts) | 用 `echo` 模拟执行，读取输出与会话编号 | 新 Agent 的启动命令和输出解析 |
| [通道模板](../examples/plugins/hello-channel/channel.ts) | 领卡片、写到文件、报告送达；通过命令行回答 | 目标平台的发送、更新和回答回调 |
| [事件插件模板](../examples/plugins/hello-source/source.ts) | 验证 HMAC-SHA256 签名，把模拟订单转换成事件 | 业务系统的验签方式和字段映射 |

事件插件、接单程序、通道和命令行共用同一套 HTTP + JSON 接口。只用 Shell 接协议，可以看 [接单脚本](../examples/worker.sh) 和 [通道脚本](../examples/channel.sh)：设置中台地址与密钥后运行，需要 `curl`、`jq`。它们适合演示短任务；长任务使用内置接单程序的心跳、停止和恢复能力。

一个插件就是一个目录，入口为 `agent.ts`、`channel.ts` 或 `source.ts`。只用 `node:` 模块和自己目录里的文件，类型在插件里声明；不要相对引用引擎源码。

用 `agent-autoloop add <git 地址>` 安装到 `~/.agent-autoloop/plugins/<仓库名>`，也接受本地 Git 仓库。它只克隆，不装依赖、不跑安装脚本、不自动更新。加载时会执行插件，安装目录的同名插件优先。

## 先跑起来

在引擎目录运行这条命令：它把三个例子分别装进临时中台，实际走完验签、派活、运行、通知和报告，退出后清理。

```bash
node --disable-warning=ExperimentalWarning --test --test-name-pattern='agent-autoloop add' tests/example-plugins.test.ts
```

## Agent 插件

从 [hello-agent/agent.ts](../examples/plugins/hello-agent/agent.ts) 开始。它用 `echo` 代替模型，克隆到别处也能运行。

| 导出对象的方法 | 作用 |
|---|---|
| `command(turn)` | 返回命令参数数组；参数不作为 shell 代码执行 |
| `read(stdout, code, stderr)` | 返回 `text`、`session`、`usage`、`error`、`finished`；运行中 `code` 为 `null` |
| `link(session)` | 可选，会话链接；支持会话的插件可只重写错误回执 |
| `check()` | 可选，能用返回 `null`，否则返回下一步怎么做 |

规则的 `workspace: "run"` 由接单程序落实为 `<cwd>/run-<run id>`；插件收到的 `turn.cwd` 和环境变量 `AGENT_AUTOLOOP_WORKSPACE` 已是实际目录。不设时两者仍是展开 `~` 后的规则 `cwd`。

`turn` 包含 `prompt`、`session`、`resume`、`cwd`、`access`、`model`、`effort`、`command`、`contextFile`、`folder`。`contextFile` 是资料文件，受限 CLI 需要允许读取 `folder`。`read` 要能处理未写完的输出；CLI 真正完成后才返回 `text`。

在规则里选择这个插件：

```json
{ "name": "Hello", "worker": "my-computer", "use": "hello-agent", "access": "read" }
```

只需要打印最后一条消息时，用内置 `command` 加参数数组即可，不必写插件。

### 浏览器接入

浏览器工具装在运行 Agent 的电脑上，由该 CLI 的工具配置或项目 Skill 提供。Codex 插件启动的是后台 [`codex exec`](https://developers.openai.com/codex/noninteractive/)；可以使用它已配置的 [MCP 工具](https://developers.openai.com/codex/mcp/)，不能只凭桌面应用能打开网页就认定后台也能访问同一浏览器。

Claude 委托 Codex 的完整规则、Skill 和参数调用脚本见[浏览器交接模板](../examples/recipes/browser-handoff/README.md)。入口命令、目标与允许操作由本人配置；网页助手返回证据和会话编号，主任务负责业务与回执。

已有专用浏览器入口时，在规则的 `prompt` 或 `skill` 写明实际命令、会话接续方式和允许的操作。只交网页步骤，返回看到的内容、操作结果和阻塞原因；主任务负责业务和中台回执。浏览器入口不是必装组件，中台不捆绑某台电脑的脚本，也不自动修改 CLI 的工具配置。

需要网页验收的任务，要用同一后台启动方式实际打开目标页面，核对内容并接续一次会话。缺少可用入口或需要本人恢复连接、登录、验证时，保留未验收项，用现有 `ask` 等待恢复（规则设了 `ask: false` 时改用 `notice` 或规则允许的事件）；不要写“没跑成”触发重派，也不能把 HTTP 查询当作已经完成网页验收。

## 通道插件

从 [hello-channel/channel.ts](../examples/plugins/hello-channel/channel.ts) 开始。它把卡片写进文件，用命令行回答。

默认导出异步函数，参数是 `{ hub, options, log, signal }`；`options` 来自 `config.json`，不含中台密钥。

| 调用 | 作用 |
|---|---|
| `hub.nextCard(50)` | 长轮询领卡片，没卡片返回 `{ card: null }` |
| `hub.delivered(id, version, ref)` | 报告送达，保存外部消息编号 |
| `hub.failed(id, version, error)` | 报告发送失败 |
| `hub.answer(id, { choice, version, by, ref })` | 转交回答；核对回答人和原消息 |

送达时保存 `card.version`，把它放进每个选项按钮和文字提交按钮的回调值；回答时带回当时看到的版本，不能临时读取最新版本来替换。文字输入用 `{text, version, by, ref}`，可选 `card.input` 是标签和提示，缺省用“别的想法”。`version < content_version` 会返回 409“卡片已更新，请重看”；提示点击者重看，不因拒答重发整张卡片。旧通道省略 version 仍可用，但无法防止旧内容误答。

`ref` 为空就发新消息，有值就更新原消息；不能更新时只报告。没报告的卡片一分钟后重派。`signal` 中止时退出，函数异常退出后由外壳重启。

只告知卡片 `fyi: true` 从创建起就是 `state: "closed"`、`options: []`，也要照常送达，不能添加“已处理”或其他按钮、文字输入框。飞书复用关闭通知的无交互渲染并更新原消息；Webhook 发标题和正文、不附回答链接；桌面标题为“Agent 告诉你一件事”，不能更新时只报告。旧中台可能不带 `fyi`，按原有状态和选项渲染仍兼容。`delivery` 是 Agent 插件，其审查问题需要本人修复，继续使用普通 `notice`。

在 `rules.json` 登记通道、用 `agent-autoloop key new channel cards` 取密钥，再把下面这项放进 `config.json` 的 `channels`，重启中台：

```json
{ "cards": { "use": "hello-channel", "key": "通道密钥", "file": "/tmp/cards.txt" } }
```

能收回调的通道要在规则里设置 `answerers`；只能发文字的通道设置 `links: true`，发送 `card.link`。拿到链接的人能回答这张卡片。

通道和中台共用一个 Node 进程，外部调用应异步等待。内置飞书通道的用户查询、发送和更新均异步调用 CLI，发送期间中台仍能接收事件和心跳。

### 飞书文字输入与过期反馈

飞书通道需要 **lark-cli 1.0.99 或更新版本**。发送和更新卡片均通过标准输入传入 JSON；1.0.96 不接受发送时的 `--content -`，会报 `--content is not valid JSON: -`。1.0.99 已通过 `--dry-run` 验证该参数；下述 1.0.96 的回调文档核对不代表通道兼容该旧版本。

内置飞书通道按 [2.0 表单](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container)与[输入框](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/input)使用根级 `form`、具名 `input` 和 `form_action_type: "submit"` 按钮。选项回调为 `{card, choice, version}`，文字提交为 `{card, text: true, version}`；从 CLI 输出的 JSON 字符串 `form_value` 中读 `answer_text`，空白或非字符串不提交。只有 open ask 展示文字框。

本机核对 `lark-cli 1.0.96` 的 `event consume card.action.trigger --help`、`event schema card.action.trigger` 和[官方回调文档](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-card-action-reply.md)：SDK 在 3 秒内自动回应 `{code:200}`，consume 只输出 NDJSON，没有回传 toast 的接口；延迟更新要求整张卡片。因此只在中台明确返回过期内容的 409 时，用 `im +messages-reply --message-id <原消息> --as bot --text "卡片已更新，请重看"` 提示。401、无效输入和其他错误仍报告日志，不向未经核验的消息回复。整个核对只读帮助与文档，测试用假 CLI；新表单 JSON 未经过真机验证。

## 事件插件

从 [hello-source/source.ts](../examples/plugins/hello-source/source.ts) 开始。它检查 `x-shop-signature` 中的 HMAC-SHA256，再把订单变成事件。

默认导出同步函数，参数为 `{ headers, body, secret }`。先验签，再解析原文；返回事件数组，无事返回 `[]`，拒绝请求就抛异常。事件插件只翻译，不发请求。

在 `rules.json` 登记来源：

```json
{ "shop": { "name": "商店", "adapter": "hello-source" } }
```

请求地址是 `/v1/in/shop`；秘密放在 `secrets.env` 的 `AGENT_AUTOLOOP_SECRET_SHOP`，不写进规则。事件必须有稳定的 `id` 和合法的 `type`，可带 `subject`、`summary`、`detail`、`link`，上限见[协议](protocol.md#来源把世界变成事件)。

来源能直接发标准 JSON 时不必写插件，用来源密钥调用 `POST /v1/events` 即可。

## access 实际能做什么

`access` 由插件翻译，不是中台提供的系统沙箱。以下是未额外放宽本机权限时的行为。

| 插件 | `read` | `edit` | `full` |
|---|---|---|---|
| Codex | `read-only`：能跑 shell，不能写文件，命令默认不能联网 | `workspace-write`：能跑 shell、写工作目录和临时目录，命令默认不能联网 | `danger-full-access`：能写文件、跑 shell、联网，无审批 |
| Claude Code | `plan`：能读文件和运行只读命令；其他命令取决于自动审批及本机规则 | `acceptEdits`：再允许目录内文件编辑和常见文件操作；任意 shell 或联网仍需放行 | `bypassPermissions`：跳过工具审批，没有额外系统隔离 |

Codex 的三个档位已用插件命令实跑；Claude Code 依据[官方权限说明](https://code.claude.com/docs/en/permission-modes)整理，没有调用模型实跑。Codex 的命令网络限制与托管搜索、MCP 不是同一个边界，详见[官方沙箱说明](https://learn.chatgpt.com/docs/agent-approvals-security)。用户的 CLI 配置可能改变上述能力；`read` 也不代表读不到本机密钥。

场景模板据此选权限：早报用 `edit` 写本地文件，issue 用 `edit` 改代码并让固定脚本联网取正文，告警用 `read` 看代码和事件附带的调用栈。反馈处理和飞书摘要用 `edit`，网站排查用 `read`；固定巡检与飞书读取脚本负责联网，摘要 Agent 只读完整快照。`command` 和固定脚本以本机账号运行，不受 `access` 约束。

## 一致性测试

在引擎目录运行协议的现有 HTTP 检查，全部使用临时数据和随机端口：

```bash
node --disable-warning=ExperimentalWarning --test tests/conformance.test.ts
```

检查其他中台实现时，用 `agent-autoloop conformance <测试地址> --config <测试凭据文件>`，文件格式见[协议](protocol.md#一致性和复现)。它会写事件和卡片，只对专用测试中台运行。

插件本身的完整接入测试见 [tests/example-plugins.test.ts](../tests/example-plugins.test.ts)。用其他语言写独立进程也可以，参考 [curl/jq 通道](../examples/channel.sh)和[接单程序](../examples/worker.sh)。

Windows 等需要为沙箱准备资料访问的 Agent 插件可提供同步可选的 `prepare(turn, env)`：接单程序在 `command(turn)` 前调用，`env` 是实际启动进程使用的清洗后环境。Windows 的 `turn.folder` 是本轮 `agent/` 资料子目录，包含 context 和输出；父目录里的轮次凭据及退出标记不能授权给 Agent。旧插件无需实现此方法，POSIX 资料路径保持不变。
