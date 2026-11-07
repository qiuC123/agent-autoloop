# Windows 接单启动调查

后续服务恢复已改由 runner 看管，不再依赖本文原先描述的计划任务失败重启；ACL 也已去掉 PowerShell。下文保留当时的调查证据，后续 ACL 超时修复将初始化期限改为 300 秒，进度期限仍为 120 秒。当前行为见 [Windows 服务恢复调查](windows-service-resilience.md)。

根因是同一进程内跨线程创建子进程时的 Windows 管道句柄继承竞争。`up` 改用接单子进程，隔离句柄表，同时保留启动和进度监督。

## 根因与证据

原先 Windows 的 `up` 在主线程启动通道，在 worker 线程中运行 `createWorker`。后者初始化时通过同步 PowerShell 设置目录 ACL，运行中也会同步执行 ACL、命令查找和 Job 辅助程序。

Windows 的 `CreateProcess` 在启用句柄继承时可把进程内的可继承句柄交给新子进程。并发启动的长期通道消费者可能拿到同步短命令的管道写端；短命令已经退出，消费者却继续持有写端，`execFileSync` 等不到 EOF。用户的现场观察是：hub 可访问、worker 卡在启动日志之前且不响应 inspector；只结束长期消费者后，worker 随即启动。这也可能发生在运行中的通道重连期间。[CreateProcess 文档](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)

本机为 Windows、Node 24.14.0、libuv 1.51.0。该版本 libuv 使用继承句柄的 `CreateProcessW`；跨线程的创建过程没有共享串行队列。[libuv Windows 实现](https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c)

此前没有长期通道消费者的随机 home、随机端口、强杀后立即重启测试为 0/224 停滞；它缺少这次确认的竞争条件，不能证明线程方案安全。现在不再把 `SHARE_ENV` 或 TypeScript 加载器当作已确认根因。

## 先红后绿

```powershell
node --disable-warning=ExperimentalWarning scripts/windows-handle-race.ts threads 20
node --disable-warning=ExperimentalWarning scripts/windows-handle-race.ts processes 20
node --disable-warning=ExperimentalWarning --test tests/worker-process.test.ts tests/worker-startup.test.ts
```

底层探针每轮让 worker 执行真实的短命 `execFileSync(node -e "")`，另一执行上下文同时启动 8 个长期 Node 消费者；短命令限时 1500 ms，消费者有额外的清理期限。线程模式 19/20 超时（95%），独立进程模式 0/20。它是可重复运行的诊断脚本，复现停滞时返回非零；CI 不要求未来 Node 版本永远保留这个底层缺陷。

真实 `up` 的回归使用临时安装、真实数据库和 HTTP，加一个启动 32 个长期 Node 子进程的假通道；在同步准备前增加 4 个真实短命令扩大竞争窗口，不注入永久等待。旧线程实现首次运行即失败：HTTP 响应正常，11 秒观察期内没有启动日志、worker 未上线。改成子进程后连续 3 次都在消费者释放前完成启动。测试保留旧线程识别条件，方便在修复前后运行同一用例。

全量并行负载下，消费者的释放定时器可能晚于观察窗口；测试核对消费者确已启动、worker 已上线且没有等到释放后才启动，不要求释放日志必须在窗口内出现。

另外两个先红后绿的生命周期用例证明 worker 有独立 PID；`up` 强杀或正常退出时，卡在真实同步原生调用中的 worker 和辅助子进程都被回收，而 detached 模拟 Agent 仍存活。测试只清理自己记录的 PID。

原有监督回归继续覆盖：模块加载阻塞、准备阻塞、真实原生调用阻塞、领活停滞、持续健康进度、断网重试、异常和退出码 0。测试将 30 秒/120 秒监督期限缩短为 5 秒；不添加生产配置开关。新增回归由现有 Windows CI job 的测试发现规则直接运行，其他平台跳过 Windows 专属用例。

## 修复与寿命

Windows 现在用非 detached 的 `fork` 启动 `worker/process.ts`，通过 IPC 传配置和进度，继承 stdout/stderr 与启动时的环境。独立进程保留 Windows 环境变量不区分大小写的语义，也继续让同步准备不阻塞 hub；父进程后续的环境修改不再实时共享。不改 ACL、Agent 托管、HTTP、密钥、调度或数据格式。

选择进程隔离，是因为它覆盖 worker 中现在和以后新增的同步命令；把所有 spawn 转交主线程则必须约束每个插件和第三方调用。Node/libuv 自带的 Windows Job 负责非 detached 子进程随父进程死亡回收；IPC 断开也触发正常退出。独立 Agent 仍通过已有的 detached guardian 托管，不被这层 Job 回收。

30 秒启动期限和 120 秒实际处理进度心跳保持不变。超时同步写 stderr，强制让 `up` 非零退出，交给已有服务失败重启；worker 自行退出（包括 0）或异常也让 `up` 失败。选择退出而不是原地重建 worker，避免旧执行者状态未清理时同时接单；恢复继续使用已有日志和 worker 记录。长时间没有进度的合法操作也受该期限约束。

验证只使用临时 home、回环随机端口和假通道，没有连接真实服务、发送消息或修改计划任务。两份 README、INSTALL、SKILL 与协议已同步；SECURITY、示例入口和架构拓扑仍适用。

## 最终验证

`npm test`：335 项，326 通过、9 个平台条件跳过、0 失败，包括全部 12 项启动/监督/进程隔离回归、20 万步固定种子模拟、5040 条卡片路径和 40320 条调度路径。最终测试断言修正后重新完整运行，通过。

`npm run typecheck`、`npm run format:check`、`npm run test:nightly` 均通过。nightly 包括 1000 次真实强杀、35/35 个有效变异检出（无无效变异）、1000 个并发长轮询全部应答，以及性能脚本中的 20 万步模拟；Windows 性能指标保持 `report-only`。没有执行真实服务重启验收。
