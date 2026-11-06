# Windows 服务恢复调查

2026-11-06 ACL 超时修复：下面早期实测中的 5 秒 ACL / 30 秒 worker 启动期限已被替代。ACL 身份查询、目录保护、编译和设置均为每次 30 秒，仅超时重试一次；worker 初始化限 300 秒以容纳这四步，之后的实际进度心跳仍限 120 秒。

回归重现了两条失败路径：领取后先更换 claim，再在异常处理外创建私有目录和保存 `entry.json`；这里的 ACL 超时被外层当成网络错误，循环继续但没有本轮记录，后续心跳漏报该轮，租约到期成为 unknown。准备阶段已保存任务时，错误原本能变成 failed；但保存 failed 的私有文件再次失败会向外抛出，在后续检查循环中还会令接单进程退出。这是代码与故障注入验证的路径，不据此认定某一次现场超时的底层 Windows 原因。

现在准备操作纳入本轮失败处理；只有私有任务记录写入成功才启动 Agent。无法保存的凭据、进程状态或结果暂留内存，继续报告本轮心跳并重试保存/交回，收到确认或不可重试拒收后才丢弃。进程已启动后的记录失败不会被误报为业务 failed；无法核实仍在运行的进程时保留心跳、稍后检查。`failed` 仍按既有协议延迟重派，通常在 state 中表现为带失败次数和原因的 queued。权限失败绝不退化为不设权限写文件。若存储和网络同时不可用，且 worker 又被强杀，纯内存记录仍可能丢失；unknown 的本人结束动作处理无法再恢复结果的轮次。

Windows 服务由计划任务在登录时和每 5 分钟触发 runner，`up` 的恢复由 `host/windows-service.ts` 的 runner 负责。不能把动作的非零退出码当作计划任务必然重启的保证。

## 计划任务实测

2026-11-05，Windows 11、Node 24.14.0。仅创建一个名字带随机 UUID 的临时任务，使用当前用户的 `InteractiveToken`、`LeastPrivilege`、`IgnoreNew`、无运行时限、`AllowHardTerminate=false`，`RestartOnFailure` 为 `PT1M`、999 次。通过 Task Scheduler COM 注册并读回 XML，手动 `Run`；动作直接启动 Node，向临时 JSONL 追加时间和 PID 后退出。两轮之间删除并重新注册同名临时任务，不改任何已有任务。

| 动作退出码 | 观察时间 | 启动次数 | 最后状态 / LastTaskResult |
|---|---|---|---|
| `1` | 150.31 秒 | 1 | Ready / `1` |
| `0xC000013A`（有符号 `-1073741510`） | 150.27 秒 | 1 | Ready / `0xC000013A` |

两轮都没有在配置的一分钟后重启。最后删除临时任务，并按精确名称确认剩余 0 个。这个结果说明本机、上述启动方式下不能依赖该设置恢复动作进程；不把它推论为所有 Windows 版本和触发方式的统一行为。生产 XML 保留原有失败策略，作为额外措施，正常恢复不再依赖它。[RestartInterval 文档](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-restartinterval)

测试套件不注册计划任务；`service-windows.test.ts` 继续注入任务命令。真实任务实测不是安装或持续集成的一部分。

### runner 被强杀后的重复触发

同日返工只创建一个新的随机名临时任务，采用生产 XML 的登录触发与 `TimeTrigger`、`PT5M` 重复间隔、`IgnoreNew` 和原有权限设置。仅把首次时间触发提前到注册后 15 秒，以便观察；没有调用手动 `Run`。重复周期不指定 `Duration` 或 `EndBoundary`，表示无限重复。[重复期限说明](https://learn.microsoft.com/en-us/windows/win32/taskschd/repetitionpattern-duration)

临时 Node 动作于 08:49:58.908 UTC 首次启动；等待约 20 秒并核对动作进程身份后，只强杀该动作。第二次于 08:54:59.894 UTC 自动启动：间隔 300.986 秒，强杀后恢复 279.464 秒，状态 Running。最后删除临时任务、结束测试动作，按精确任务名核对剩余 0 个。没有操作已有任务。

生产时间触发从安装后 5 分钟开始，另保留登录触发；安装会立即 `Run`，当次登录内也有后续时间触发。每次到点，已有 runner 就由 `IgnoreNew` 忽略，runner 不在则启动；恢复目标是下一次 5 分钟触发。系统休眠、用户未登录或调度繁忙仍可延迟执行，间隔不是硬实时期限。这里的实测与前面的“手动 Run 后依赖失败重试”是两种不同机制。

## runner 的职责与停止

- `up` 自行退出，包括 0、普通非零码、`0xC000013A`，以及启动失败，均重新启动。连续失败退避为 1、2、4、8、16、32、60 秒，之后最多每 60 秒一次；连续健康 5 分钟后重置。
- runner 每 15 秒异步探测已有的本机身份管道，每次最多 2 秒。必须同时匹配私有 token、`up.pid` 和本轮直接启动的子进程 PID；不访问远程 URL，也不把其他安装或旧进程的回应算作健康。
- 从启动或最后一次有效回应起，连续 5 分钟无回应，runner 仅对直接启动的 `up` 调用 `child.kill("SIGKILL")`，确认退出后再退避启动，不调用 `taskkill /T`。libuv Job 回收 worker、通道及卡住的非 detached 原生子孙；detached Agent Job 托管器继续运行，等新 worker 按持久化 Job 名认领，避免中断已经运行数小时的任务。结束失败会记录并继续尝试，旧进程未退出时不再启动第二个。最迟发现时间还包含一个探测周期及请求期限。
- 5 分钟容纳了启动时的 ACL 编译、worker 启动准备（其独立看门狗现为 300 秒）、120 秒 worker 进度检查，以及现场一分钟级的资源争用。长时间 Agent 任务和 50 秒领活在别的进程或异步请求里，不需要阻塞 hub 主线程；该期限不限制 Agent 任务总时长。
- runner 有独立的 `service.pid` 和带 token 的控制管道。`service stop` 先写私有 `service.stopped` 标记，再停止 runner 和 `up`，退避期间、runner 已退出或 hub 卡死时也保存停止意图。普通停止先请求 `up` 正常退出，5 秒内未退出则只强杀 `up`；普通停止和健康看门狗都保留独立 Agent。
- runner 启动时发现停止标记就退出 0，不创建 `up`；重复触发、重新登录、重启电脑均保持停止。恢复使用 `service install`：先验证旧任务归属，成功覆盖 XML 后才删除停止标记并启动。没有新增 `service start` 命令；直接前台 `up` 不清除标记。
- `up` 保持非 detached 子进程，runner 被强杀时 Node/libuv 会回收它和非独立子孙；独立 Agent 仍按原有持久记录恢复。runner 忽略 `SIGINT`、`SIGBREAK`。强杀、注销、关机或控制台关闭仍可能结束 runner；未主动 stop 且用户保持登录时，由下一次重复触发补起。Windows 关闭事件有系统终止期限，JS 信号监听不能取消它。[控制台事件说明](https://learn.microsoft.com/en-us/windows/console/handlerroutine)

服务配置、任务名和任务动作参数兼容旧版；归属校验仍核对动作程序、参数、目录及用户，不把新增触发器当作旧任务不属于本程序的理由。控制文件和停止标记不改变 HTTP、密钥或事实日志。升级后需主动运行一次 `service install` 替换旧 runner 并覆盖旧 XML，启用重复触发。前台 `up` 不带 runner，仍需自行重启。本次开发没有对真实服务执行升级或重启。

## `0xC000013A` 能说明什么

代码审查没有找到 runner 或 `up` 主动调用 `GenerateConsoleCtrlEvent` 的地方。回归测试在新建的隐藏控制台里，向测试进程发送真实 `CTRL_BREAK`：没有处理器时得到 `0xC000013A`；新 runner 收到真实 Ctrl+C 和 Ctrl+Break 后仍能回答控制请求，并恢复被事件结束的 `up`。信号只送到该临时控制台，不送到测试主进程或用户终端。

因此可以复现这种退出机制，不能确认现场发送者或具体事件类型。退出码也能由程序显式返回；仅凭 LastTaskResult 不能证明有人按了 Ctrl+C。现场来源仍是**待确认**，需要当时的控制台事件记录或系统追踪。[默认控制处理器](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler)

## ACL 与同步调用

`private.ts` 不再启动 PowerShell，改用 `host/windows-acl.cs`：每个进程首次使用时在随机私有目录编译一次，随后复用可执行文件。使用系统 .NET Framework 4.x，无新增运行时依赖；不执行跨进程共享的缓存程序。编译目录先用系统 `whoami.exe` 取得 SID，再用 `icacls.exe` 去掉继承、只授权当前用户；目录原本为空。正常退出删除编译目录，临时测试 home 的最终清理也包含强杀留下的目录。

辅助程序沿用原来的 .NET DACL 操作：目录/文件关闭继承、仅本人完全控制；重写已有文件前移除显式外部授权；只给已验证的 sandbox 用户 SID 本轮资料的读或读写权限，恢复 `context.json` 继承，撤销共享仍传播到资料文件。不设置 Owner，不要求 `WRITE_OWNER`。直接 `icacls /restore` 的本机普通用户试验返回 1300，不能作为这里替换整个 DACL 的实现；只用它的普通权限命令保护新建空编译目录。[icacls 文档](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)

hub 主线程剩余同步子进程都是启动时的私有权限准备：身份查询、编译目录保护、编译和 ACL 操作每次限 30 秒，仅 ETIMEDOUT 重试一次。权限操作失败即报错，不继续写秘密、不把失败目录加入已保护缓存。这些发生在 HTTP 开始接收请求之前；接单循环的 ACL、命令探测和 Job 操作继续留在 worker 子进程。保留同步接口避免把安全检查与后续文件写入拆成可穿插的两步。

Git 版本读取已改异步并限 5 秒；Windows 命令入口及 `test:quick` 改为异步 `spawn`，不对正常长驻进程设短命令期限。其余生产、测试、示例中的 `execFileSync` / `spawnSync` 均有有限超时：通常 30 秒，Git 安装/更新 120 秒，浏览器交接示例允许与 worker 相同的 3 小时任务时长。计划任务查询仍用 PowerShell（30 秒），仅在服务管理 CLI 中执行；Windows 桌面通知本来就是异步 PowerShell（30 秒），不在 ACL 路径中。

## 为什么计划任务里的 PowerShell 慢

现场提供的现象是同步 ACL PowerShell 等待 66 秒至 4 分钟以上、CPU 时间约 0.4 秒，而交互终端的同参数调用约 0.4–0.6 秒。这支持“在等待”而非持续计算的判断，但不能定位等待对象。

AMSI / Defender 扫描、.NET 初始化、模块自动加载、证书吊销查询、不同登录环境及控制台/管道句柄等待都属于**待确认**的候选。`-NoProfile` 只跳过用户 profile，不能消除全部初始化或扫描；PowerShell 5.1 会把脚本块交给 AMSI。[PowerShell 安全机制](https://learn.microsoft.com/en-us/powershell/scripting/learn/security-features)

此前已验证的跨线程句柄继承竞争见 [worker 启动调查](windows-worker-startup.md)。本次现场不能直接归为同一个原因；需要对卡住的 PowerShell 抓线程栈及相关 ETW / Process Monitor 记录才能区分。没有关闭 Defender、AMSI、模块加载或证书检查，也没有改全局系统设置。修复移除这条 PowerShell 启动路径，并给剩余原生调用设期限，不依赖猜定某一种原因。

## 空闲时的主线程检查

新增现场：2026-11-05 08:08–08:10 UTC，`bfb09f9` 服务在没有新 run 和事件时出现通道和 worker 超时；`/healthz` 5 秒超时，15 秒能回，同时运行多组全量测试及 nightly、CPU 很满。本次只读检查以下代码，没有读取真实数据库、运行日志或对在线服务加探针。

- `host/server.ts` 按最近到期项或长轮询期限安排定时器，到期同步执行 `hub.tick()`、唤醒轮询并重新计算期限；没有固定间隔遍历全部历史日志。`kernel/decide.ts` 的 tick 仍同步处理规则、未触发定时器和到期事项，耗时取决于资料量。
- `host/runtime.ts:reloadRules` 每次 tick 做同步 `statSync`；只有 mtime 变化才同步读文件、解析和校验规则。正常空闲不反复重读未修改规则，也不运行 ACL。
- 没有 run 或事件不等于没有写入：`kernel/http.ts` 的工作轮询和通道轮询分别记录 `heartbeat`、`channelSeen`。它们通过 `host/runtime.ts`、`kernel/store.ts` 使用主线程 `DatabaseSync`、`BEGIN IMMEDIATE` 与 `synchronous=FULL` 提交；无事实的操作也经过同步事务。锁等待配置为 `busy_timeout=5000`，磁盘同步和 CPU 争用也可能拖长事件循环停顿。
- `/healthz` 的路由正文只返回状态，但此前的 `callFrom()` 仍同步取得 view/config，不能绕过前面的主线程阻塞或数据库查询。投递重试走同一同步数据库路径；内置通道的 HTTP、命令调用及重试暂停是异步的，未发现空闲时的同步 PowerShell、阻塞式 sleep 或持续忙循环。

这些路径在 `bfb09f9` 与本次版本间未改变。结论是**找到空闲仍会执行的同步工作，但没有证据定位这一次长停顿**；高负载下的资源争用可能与同步数据库/文件 I/O 一起放大延迟，不能写成“空闲没有同步阻塞，所以必然只是 CPU 忙”。本次保留原事务和持久化语义，不据猜测改内核；精确归因仍需发生当时的栈或耗时记录。

## 验证

先失败后通过：任何退出码恢复、卡在真实同步原生调用时回收非 detached 子孙并保留 detached 孙进程、主动停止后再次启动 runner 仍不恢复（包括 runner 已先被强杀）、重复触发 XML、旧任务重新安装及注册失败保留停止标记。上一轮还覆盖禁止 ACL 启动 PowerShell和 Git 调用不阻塞事件循环。原有真实 DACL 测试继续覆盖 Modify-only owner、已有文件外部授权、只读/读写 Agent 授权与撤销。控制台试验和服务回归只使用临时 home、假进程及私有管道，不连接真实业务；每次清理保留下来的测试 Agent。

2026-11-05 第一轮 `f0015ac` 的本机验证记录（以下不冒充返工后的结果）：

- `npm test -- --test-concurrency=2` 完整退出 0：356 项，347 通过、9 项平台跳过、0 失败，包括 20 万步固定种子模拟、5,040 条卡片路径和 40,320 条调度路径。返工时发现，这种追加参数的写法把选项放在文件列表之后，本机 Node 没有按预期限制文件并发；本条成功结果和完整覆盖仍成立，但不再称它为限并发验证。
- 最后补的“任务查询超时不能继续覆盖注册”守卫，在完整测试已加载对应文件之后加入；最终版本的服务、看管与卸载三文件另跑 17/17 通过，包含该守卫的先红后绿验证。
- 最终 `npm run typecheck` 与 `npm run format:check` 均退出 0。
- `npm run test:nightly` 完整退出 0，包含 1,000 次真实 SIGKILL、36/36 个有效变异检出（没有存活或无效变异）、1,000 个同时等待的连接全部完成，以及另一次 20 万步固定种子模拟。

Windows 性能指标按现有规则只记录观察：冷启动 888 毫秒，空闲内存 87.74 MB，千连接内存 174.67 MB，持久化写入 168 次/秒，派发 P99 25.71 毫秒；保持逐条提交与 SQLite `synchronous=FULL`。

同日返工后的最终验证：

- 四个新增行为回归先失败后通过；服务、看管、安装、卸载和 worker-process 八个测试文件完整通过 27/27。
- 最终完整套件使用 `node --disable-warning=ExperimentalWarning --test --test-concurrency=1 tests/*.test.ts`，即 `npm test` 的全部文件与入口，仅把限并发选项正确放到文件列表之前。退出 0：358 项，349 通过、9 项平台跳过、0 失败；20 万步模拟、5,040 条卡片路径、40,320 条调度路径全部通过，没有缩减规模。
- 此前追加参数的 `npm test` 尝试未通过：文件实际并发时出现启动观察窗超时。看管夹具原本把 5 分钟压成 1.5 秒，却没有缩短真实原生辅助程序的启动；现改为 5 秒并观察健康进程 5.5 秒。生产期限和行为断言不变，worker 原有启动断言未放宽；最终串行全量包含这些用例。
- `npm run typecheck`、`npm run format:check` 通过。本轮按服务返工范围没有重跑 nightly；上面的 nightly 结果仅属于 `f0015ac`。
