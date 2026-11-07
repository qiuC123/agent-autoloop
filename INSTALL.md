# 安装说明（写给 Agent）

用户请你装好 Agent 自动化中台。先安装，再走一遍提问和继续处理；能自己做的直接做。

## 安装

支持 macOS、Linux、Windows 10/11。需要 Node.js 24 或更新、Git，以及一个已经登录的命令行 Agent。macOS / Linux 另需 curl，Windows 需要系统自带的 Windows PowerShell 5.1、Windows Script Host（JScript）和 .NET Framework 4.x 编译器。

先检查 `node --version`。Homebrew 的 `node@24` 默认不进 PATH，装好后还要运行 `export PATH="$(brew --prefix node@24)/bin:$PATH"`；需要长期生效时再写入用户的 shell 配置。不要替用户登录，也不要读取或复制登录凭据。

本仓库已公开，安装脚本和代码都可匿名下载，不需要 GitHub 账号、登录或 GitHub CLI（`gh`）。下面的命令安装并启用登录后常驻服务。macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.ps1 | iex
```

Windows 常驻用当前用户的计划任务：登录触发，加每 5 分钟无限重复的时间触发；使用交互登录令牌，不保存密码、不提权，未登录时不运行。任务名按数据目录区分，`IgnoreNew` 保证只跑一个 runner；runner 意外退出后由下一次重复触发恢复。runner 负责恢复 `up`：所有退出码按 1–60 秒退避重启，连续健康 5 分钟重置退避；每 15 秒探测本机身份通道，连续 5 分钟无回应只强杀 `up`，保留独立 Agent，不依赖计划任务的失败重试。日志在数据目录的 `logs/up.log`。服务保留安装终端的 PATH 和 `HOME`、`USERPROFILE`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`XDG_CONFIG_HOME` 中已有的目录设置；没有复制 Agent 凭据。修改这些目录或 PATH 后重新运行 `agent-autoloop service install`。

Windows 任务通过系统 `wscript.exe` 隐藏启动 runner，并等待、返回其退出码，不弹控制台窗口。升级后运行一次 `agent-autoloop service install` 替换旧的直接 Node 动作；重装前旧任务仍能运行、查询和移除。交互登录令牌、最低权限和触发器不变。

三个平台的 `agent-autoloop service install` 都会记住 `AGENT_AUTOLOOP_RULES` 指定的自定义规则路径（相对路径按安装时的工作目录转成绝对路径），并在成功后打印规则文件位置；重装采用当前环境的新值，取消设置后重装则移除旧值，恢复使用数据目录下的 `rules.json`。

GitHub Issue 轮询和 PR 交付等功能另需已登录的 `gh`，按对应场景说明配置；运行 Agent 也仍需该 Agent 自己的登录或授权。

启用飞书通道需要 **lark-cli 1.0.99 或更新版本**，以支持从标准输入读取卡片 JSON（`--content -`）；1.0.96 不支持此参数。

用户指定本地仓库时，用该目录的安装脚本，并把 `AGENT_AUTOLOOP_REPO` 设成它的绝对路径。不要下载 GitHub 的旧脚本，也不要用未提交的文件冒充已安装版本；安装器克隆的是本地仓库的 HEAD。

下面以 `/path/to/agent-autoloop` 为例，使用已经登录的 Codex：

```bash
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex
```

Windows 对应写法（从该仓库运行；只在当前 PowerShell 进程加载脚本）：

```powershell
$env:AGENT_AUTOLOOP_REPO = 'C:/code/agent-autoloop'
& ([scriptblock]::Create((Get-Content -Raw -Encoding UTF8 'C:/code/agent-autoloop/install.ps1'))) --agent codex
```

`--agent claude` 选择 Claude Code；只有其他 CLI 时加 `--command 'hermes chat -q {prompt}'`。不指定时会检测本机安装的 Agent，第一种作为试跑对象。

Windows 的接单子进程初始化超过 300 秒或处理进度心跳中断超过 120 秒时，`up` 会记录原因并强制以非零状态退出，由服务 runner 重启。看门狗同样只结束 `up`，libuv Job 回收 worker、通道和卡住的非 detached 原生子孙；detached Agent 托管器继续运行，供新 worker 按持久化 Job 名认领。`service stop` 先写私有 `service.stopped` 标记，再停止 runner 和 `up`，卡死或 runner 已死时也能保存停止意图；重复触发、重新登录、重启电脑均保持停止，直到再次 `service install`。前台 `up` 不清除此标记，也不带自动恢复。升级后执行一次 `service install` 替换旧 runner 并重写任务 XML；旧任务归属校验、`service.json` 格式不变，成功注册后才清除停止标记。实测和阈值说明见 [Windows 服务恢复调查](docs/windows-service-resilience.md)。

程序装进 `~/.agent-autoloop/app`，配置和记录留在 `~/.agent-autoloop`（Windows 的 `~` 是 `USERPROFILE`）。默认打开桌面通知；没有图形会话时安静跳过，问题仍能用 `agent-autoloop status` 查看。命令优先放在 PATH 中的 `~/.local/bin`，否则选 PATH 里第一个可写目录，不用 sudo、不覆盖其他程序；Windows 生成 `.cmd` 入口，不修改系统 PATH，没有位置时使用安装器打印的完整路径。

安装器和中台启动时都会把数据目录设为 `0700`，Windows 则设置只有当前用户可访问的 ACL，包括已有目录，保护数据库、密钥及控制记录；本轮 Agent 资料目录按下文单独授权。运行时 ACL 使用系统 .NET 编译的私有辅助程序，身份查询、编译目录保护、编译及权限设置每次限 30 秒，仅超时重试一次；本轮准备失败交回 failed，不继续写秘密，不再为 ACL 启动 PowerShell。密钥文件在 POSIX 是 `0600`，Windows 同样限制当前用户。升级后同步重启中台与接单程序；新版 `status` 使用中台提供的费用汇总。

升级时若投影格式有变化，会自动从旧日志逐条重建，历史多时首次启动需要等待；之后正常启动直接复用投影。原日志和已有卡片链接保留，不需要手动迁移。

使用回执 `notice.fyi: true` 只告知卡片前，同步升级中台和接单程序；旧版本会拒绝该字段。它复用已有报告卡片与数据库字段，无需改表，旧通知仍是待办。新卡片没有按钮、不需要结案；普通 `notice` 仍用于需要本人做事的情况。

## 临时 HOME、CI 或没有服务管理器

使用临时 HOME 时不要装系统服务，不改真实用户的 shell 配置和 Agent 配置。保留调用者给定的 `AGENT_AUTOLOOP_HOME`；用真实 `CODEX_HOME` 只为了沿用已经完成的 Codex 登录。

在临时环境中选一个空闲端口，运行本地安装脚本，随后启动中台：

```bash
port=$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex --no-service --port "$port"
agent-autoloop up
```

Windows 临时环境不必运行安装器，直接用源码入口，不创建计划任务或改 Agent 配置：

```powershell
$env:AGENT_AUTOLOOP_HOME = 'C:/temp/agent-autoloop-home'
node C:/code/agent-autoloop/bin/agent-autoloop.ts init --agent codex --no-service --port 3351
node C:/code/agent-autoloop/bin/agent-autoloop.ts up
```

测试假扮用户时同时设置临时 `HOME` 和 `USERPROFILE`；只隔离引擎资料、沿用本机 Agent 登录时只设置 `AGENT_AUTOLOOP_HOME`。Windows 的 `cwd` 可用盘符绝对路径、UNC、`~/` 和 `~\`；拒绝 `C:relative` 这类盘符相对路径。脚本 Agent 显式写 `node.exe` 和脚本路径，不依赖 shebang。`service status` 查看后台状态，`service stop` 通过私有控制口停止中台并保留计划任务和停止标记（再次 `service install` 才恢复），`service remove` 再删除自己的任务。在跑的 Agent 保留给重启后的接单程序认领；要停止任务本身用 `stop <轮次>`。

`up` 会一直运行。在 Agent 的命令工具里保留它返回的运行中会话，再用另一条命令完成验证；不要用 `nohup … &` 代替，命令工具可能在退出时清理后台进程。看到监听地址后再运行验证命令；启动失败就先处理该会话里的错误。

PATH 没有命令时，把 `agent-autoloop` 换成安装器打印的完整路径。临时测试使用假的 `osascript`、`notify-send`，不要发送真实消息；不要给已在线的飞书应用再开监听。

## 验证

先查看安装和连接情况，再用真实 Agent 跑完整问答：

```bash
agent-autoloop --version
agent-autoloop doctor
agent-autoloop try
```

`try` 会使用用户的模型额度。在非交互终端，它打印问题和 `agent-autoloop answer` 命令后退出；这是正常等待，不是失败。把问题转给用户，按他的选择回答，再运行 `agent-autoloop status`，看到“试跑通过”才算接通。仅为安装验证时，可以选择第二项绿色完成试跑。

Claude 要委托 Codex 处理网页时，可用[浏览器交接模板](examples/recipes/browser-handoff/README.md)，先配置现成入口，再验收首次调用与原会话续办。模板不安装浏览器驱动、不自动放宽 Claude 命令权限。

任务还需要网页操作时，另按[浏览器接入](docs/plugins.md#浏览器接入)用同一后台启动方式核实实际页面和会话接续。`try` 只证明问答流程；中台不自动提供浏览器连接或修改 Agent 的工具配置。需要本人恢复连接、登录或验证时，保留待验收项并交 `ask`（规则设了 `ask: false` 时改用 `notice` 或规则允许的事件），不要反复重跑已完成的业务。

没有安装系统服务时，`doctor` 会显示服务未运行；检查中台、Agent 和桌面通道是否在线即可，不要为了消除这条提示安装真实服务。

升级卡片更新功能时，中台、内置通道及协议 schema 应一起更新。首次启动按已有格式指纹机制从日志重建投影；旧卡片的内容版本从 1 起算，记录和链接保留。第三方通道可继续不传回答版本；升级后应保存显示版本并在回答时带回，见[通道协议](docs/protocol.md#通道把卡片送到你面前)。

## 写第一条规则

安装验证完成后，按用户希望自动处理的事从 [README 的场景模板](README.md#拿来即用的场景模板)选一个，再照[配置手册](skills/agent-autoloop/SKILL.md)写规则；用户还没指定用途时再问。用 `agent-autoloop check` 检查；改动几秒内生效。

国内业务可从反馈处理、网站巡检、飞书周报与业务摘要三套模板开始。它们默认飞书本人私聊；替换占位符后，配置和业务资料留在私有目录，不提交到仓库。模板不替用户新建凭据或扩大飞书权限。

桌面通知只在这台电脑上显示。需要别的通道时，先确认接收位置，再按配置手册接入。不要直接测试发信或发群消息。`access` 的含义见[插件说明](docs/plugins.md#access-实际能做什么)，不要替用户扩大权限。

## 部署时保持维护

支持维护 API 的引擎可先用本人密钥向 `POST /v1/maintenance` 发送 `drain`（带将来的 `deadline`），保存返回的 `id`；有 unknown 且结果不会回来时，本人核实旧执行已停止和实际业务状态，再用 `stop <轮次>` 或该轮通知的“已处理”按未完成结束；`GET` 看到 `claimed=0`、`unknown=0` 后，以该 ID 发送 `hold`，成功后再停服务、更新和启动。新进程仍保持 held；核对 `problem=null`、状态与生效规则的 `rules_version` / `rules_hash` 后，以同一 ID 显式 `resume`。到期不会自动恢复，要核对后 `renew` 再 resume。首次升级前的旧引擎尚不支持此流程；完整请求见[维护协议](docs/protocol.md#持久维护闸门)。

`<home>/maintenance.json` 是宿主控制文件，不手动删除或改成 normal；缺损会关闭新领取，状态会说明问题。数据库中的宿主初始化标记让重启和投影重建也能识别文件丢失。备份、恢复时一起保留 `maintenance.json`、`hub.db` 和 `master.key`。

## 卸载

卸载程序，默认保留规则、密钥和记录：

```bash
agent-autoloop uninstall
```

终端里确认后才执行；非交互运行时加 `--yes` 跳过确认，数据同样保留。它只停自己的服务和进程、删除指向自身的命令及 Skill 链接，以及安装目录里的 `app`。其他同名文件不动；数据目录不删除。

临时安装验证完，用 `agent-autoloop uninstall --yes` 停掉本次进程，再清掉自己创建的临时目录。不要卸载用户已经在用的中台。

## 文档

- [配置手册](skills/agent-autoloop/SKILL.md)：接事件插件、通道、多台电脑和交付流水线。
- [协议](docs/protocol.md)：HTTP、回执、事实日志和故障恢复。
- [插件](docs/plugins.md)：三个可运行的最小例子。
- [安全边界](SECURITY.md)：密钥、执行权限和交付审查。

开发检查用 `npm test`、`npm run typecheck`、`npm run format:check`，完整故障与性能检查用 `npm run test:nightly`。备份同时保留 `hub.db`、`maintenance.json` 和 `master.key`；后者在 POSIX 权限应为 0600，Windows ACL 应只允许当前用户访问。

Windows Codex 插件按当前权限模式和登录环境运行 `codex sandbox`，取得实际用户 SID 后，只授权本轮的 `agent/` 资料目录：`read` 只读，默认 `edit` 可读写。父目录里的 worker 轮次凭据、退出标记及启动参数不共享；`hub.db`、`master.key`、`secrets.env`、`config.json` 仍只由当前用户读取。不会修改沙箱配置或自动改用 `full`。
