# Windows 服务恢复调查

Windows 服务由计划任务在登录时启动，恢复由 `host/windows-service.ts` 的 runner 负责。不能把动作的非零退出码当作计划任务必然重启的保证。

## 计划任务实测

2026-11-05，Windows 11、Node 24.14.0。仅创建一个名字带随机 UUID 的临时任务，使用当前用户的 `InteractiveToken`、`LeastPrivilege`、`IgnoreNew`、无运行时限、`AllowHardTerminate=false`，`RestartOnFailure` 为 `PT1M`、999 次。通过 Task Scheduler COM 注册并读回 XML，手动 `Run`；动作直接启动 Node，向临时 JSONL 追加时间和 PID 后退出。两轮之间删除并重新注册同名临时任务，不改任何已有任务。

| 动作退出码 | 观察时间 | 启动次数 | 最后状态 / LastTaskResult |
|---|---|---|---|
| `1` | 150.31 秒 | 1 | Ready / `1` |
| `0xC000013A`（有符号 `-1073741510`） | 150.27 秒 | 1 | Ready / `0xC000013A` |

两轮都没有在配置的一分钟后重启。最后删除临时任务，并按精确名称确认剩余 0 个。这个结果说明本机、上述启动方式下不能依赖该设置恢复动作进程；不把它推论为所有 Windows 版本和触发方式的统一行为。生产 XML 保留原有失败策略，作为额外措施，正常恢复不再依赖它。[RestartInterval 文档](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-restartinterval)

测试套件不注册计划任务；`service-windows.test.ts` 继续注入任务命令。真实任务实测不是安装或持续集成的一部分。

## runner 的职责与停止

- `up` 自行退出，包括 0、普通非零码、`0xC000013A`，以及启动失败，均重新启动。连续失败退避为 1、2、4、8、16、32、60 秒，之后最多每 60 秒一次；连续健康 5 分钟后重置。
- runner 每 15 秒异步探测已有的本机身份管道，每次最多 2 秒。必须同时匹配私有 token、`up.pid` 和本轮直接启动的子进程 PID；不访问远程 URL，也不把其他安装或旧进程的回应算作健康。
- 从启动或最后一次有效回应起，连续 5 分钟无回应，runner 用 `taskkill /PID <本轮子进程> /T /F` 结束整个 `up` 进程树，确认退出后再退避启动。结束失败会记录并继续尝试，旧进程未退出时不再启动第二个。最迟发现时间还包含一个探测周期及请求期限。
- 5 分钟容纳了启动时的 ACL 编译、原有 30 秒 worker 启动、120 秒 worker 进度检查，以及现场一分钟级的资源争用。长时间 Agent 任务和 50 秒领活在别的进程或异步请求里，不需要阻塞 hub 主线程；该期限不限制 Agent 任务总时长。
- runner 有独立的 `service.pid` 和带 token 的控制管道。`service stop` 先停止 runner，再停止 `up`，退避期间和 hub 卡死时仍能生效。普通停止先请求 `up` 正常退出，5 秒内未退出则强杀 `up`，保留独立 Agent；健康看门狗按要求结束整树，包含其独立 Agent。两种路径在日志中分开记录。
- `up` 保持非 detached 子进程，runner 被强杀时 Node/libuv 会回收它和非独立子孙；独立 Agent 仍按原有持久记录恢复。runner 忽略 `SIGINT`、`SIGBREAK`。不承诺抵抗强杀、注销、关机或控制台关闭：Windows 的关闭事件有系统终止期限，JS 信号监听不能取消它。[控制台事件说明](https://learn.microsoft.com/en-us/windows/console/handlerroutine)

服务配置、任务名和任务动作参数兼容旧版；新增的控制文件不是业务状态，不改变 HTTP、密钥或事实日志。已经启动的旧 runner 仍是旧代码，升级后需主动运行一次 `service install` 才会进入新的看管循环。前台 `up` 不带 runner，仍需自行重启。本次开发没有对真实服务执行升级或重启。

## `0xC000013A` 能说明什么

代码审查没有找到 runner 或 `up` 主动调用 `GenerateConsoleCtrlEvent` 的地方。回归测试在新建的隐藏控制台里，向测试进程发送真实 `CTRL_BREAK`：没有处理器时得到 `0xC000013A`；新 runner 收到真实 Ctrl+C 和 Ctrl+Break 后仍能回答控制请求，并恢复被事件结束的 `up`。信号只送到该临时控制台，不送到测试主进程或用户终端。

因此可以复现这种退出机制，不能确认现场发送者或具体事件类型。退出码也能由程序显式返回；仅凭 LastTaskResult 不能证明有人按了 Ctrl+C。现场来源仍是**待确认**，需要当时的控制台事件记录或系统追踪。[默认控制处理器](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler)

## ACL 与同步调用

`private.ts` 不再启动 PowerShell，改用 `host/windows-acl.cs`：每个进程首次使用时在随机私有目录编译一次，随后复用可执行文件。使用系统 .NET Framework 4.x，无新增运行时依赖；不执行跨进程共享的缓存程序。编译目录先用系统 `whoami.exe` 取得 SID，再用 `icacls.exe` 去掉继承、只授权当前用户；目录原本为空。正常退出删除编译目录，临时测试 home 的最终清理也包含强杀留下的目录。

辅助程序沿用原来的 .NET DACL 操作：目录/文件关闭继承、仅本人完全控制；重写已有文件前移除显式外部授权；只给已验证的 sandbox 用户 SID 本轮资料的读或读写权限，恢复 `context.json` 继承，撤销共享仍传播到资料文件。不设置 Owner，不要求 `WRITE_OWNER`。直接 `icacls /restore` 的本机普通用户试验返回 1300，不能作为这里替换整个 DACL 的实现；只用它的普通权限命令保护新建空编译目录。[icacls 文档](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)

主线程剩余同步子进程都是启动时的私有权限准备：身份查询、编译目录保护和一次 ACL 操作各限 5 秒，首次编译限 30 秒。权限操作失败即报错，不继续写秘密、不把失败目录加入已保护缓存。这些发生在 HTTP 开始接收请求之前；接单循环的 ACL、命令探测和 Job 操作继续留在 worker 子进程。保留同步接口避免把安全检查与后续文件写入拆成可穿插的两步。

Git 版本读取已改异步并限 5 秒；Windows 命令入口及 `test:quick` 改为异步 `spawn`，不对正常长驻进程设短命令期限。其余生产、测试、示例中的 `execFileSync` / `spawnSync` 均有有限超时：通常 30 秒，Git 安装/更新 120 秒，浏览器交接示例允许与 worker 相同的 3 小时任务时长。计划任务查询仍用 PowerShell（30 秒），仅在服务管理 CLI 中执行；Windows 桌面通知本来就是异步 PowerShell（30 秒），不在 ACL 路径中。

## 为什么计划任务里的 PowerShell 慢

现场提供的现象是同步 ACL PowerShell 等待 66 秒至 4 分钟以上、CPU 时间约 0.4 秒，而交互终端的同参数调用约 0.4–0.6 秒。这支持“在等待”而非持续计算的判断，但不能定位等待对象。

AMSI / Defender 扫描、.NET 初始化、模块自动加载、证书吊销查询、不同登录环境及控制台/管道句柄等待都属于**待确认**的候选。`-NoProfile` 只跳过用户 profile，不能消除全部初始化或扫描；PowerShell 5.1 会把脚本块交给 AMSI。[PowerShell 安全机制](https://learn.microsoft.com/en-us/powershell/scripting/learn/security-features)

此前已验证的跨线程句柄继承竞争见 [worker 启动调查](windows-worker-startup.md)。本次现场不能直接归为同一个原因；需要对卡住的 PowerShell 抓线程栈及相关 ETW / Process Monitor 记录才能区分。没有关闭 Defender、AMSI、模块加载或证书检查，也没有改全局系统设置。修复移除这条 PowerShell 启动路径，并给剩余原生调用设期限，不依赖猜定某一种原因。

## 验证

先失败后通过：任何退出码恢复、卡在真实同步原生调用时回收树、主动停止不再重启、禁止 ACL 启动 PowerShell、Git 调用不阻塞事件循环。原有真实 DACL 测试继续覆盖 Modify-only owner、已有文件外部授权、只读/读写 Agent 授权与撤销。控制台试验和服务回归都只使用临时 home、假进程及私有管道，不连接真实业务。

2026-11-05 本机验证：

- `npm test -- --test-concurrency=2` 完整退出 0：356 项，347 通过、9 项平台跳过、0 失败，包括 20 万步固定种子模拟、5,040 条卡片路径和 40,320 条调度路径。只限制并行测试文件数，没有减少模拟或穷举规模。
- 最后补的“任务查询超时不能继续覆盖注册”守卫，在完整测试已加载对应文件之后加入；最终版本的服务、看管与卸载三文件另跑 17/17 通过，包含该守卫的先红后绿验证。
- 最终 `npm run typecheck` 与 `npm run format:check` 均退出 0。
- `npm run test:nightly` 完整退出 0，包含 1,000 次真实 SIGKILL、36/36 个有效变异检出（没有存活或无效变异）、1,000 个同时等待的连接全部完成，以及另一次 20 万步固定种子模拟。

Windows 性能指标按现有规则只记录观察：冷启动 888 毫秒，空闲内存 87.74 MB，千连接内存 174.67 MB，持久化写入 168 次/秒，派发 P99 25.71 毫秒；保持逐条提交与 SQLite `synchronous=FULL`。
