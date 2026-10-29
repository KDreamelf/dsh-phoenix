# dsh-phoenix（不死鸟）

> 受伤可以，死亡不行。

DSH 默认是 **fail-loud**：任何未捕获异常或未处理拒绝都会让宿主进程 `exit(1)`。桌面端看到这个退出后，唯一提供的恢复动作是「禁用第三方插件、备份 profile patch 并重启」——它把 `cordis.patch.yml` 整个改名归档，**连带你的所有供应商配置一起消失**，然后用出厂模板重建一个空壳。

一个插件的坏定时器，代价可以是你的全部配置。

不死鸟把「进程死亡」换成「记录 + 归因 + 只隔离出事的那一行 + 继续运行」。

## 三件事

### P0 · 进程守卫

| 行为 | 说明 |
|---|---|
| 接管 | 启动时快照并摘下 `unhandledRejection` / `uncaughtException`，换成自己的；卸载时原样恢复 |
| 归因 | 两条路径：`node_modules/<包名>/` 的栈帧，或路径段匹配已挂载行的包根（`link:` 安装） |
| 隔离 | 往 **home 层**（`$DSH_HOME/cordis.patch.yml`）写该行 `disabled: true` |
| 熔断 | 单次运行最多隔离 2 行（可配），超出只记录 |
| 保护 | 官方包、结构行（`cordis:*`）、本插件自身、核心服务行永不自动隔离 |
| 日志 | `$DSH_HOME/logs/crash-guard/<本地日期>.jsonl`，含完整栈、cause 链、候选行、决策原因 |
| **绝不触碰** | profile 自己的 `cordis.patch.yml` |

**为什么写 home 层**：层级顺序是 `bundle → profile patch → $DSH_HOME/cordis.patch.yml → --patch`，home 层覆盖 profile 层。所以只加一行 `disabled: true` 就够，你的 provider、apiKeyEnv、模型列表一个字节都不动。

### P1 · 工具超时

DSH 的 `await tool.execute(...)` **没有超时**，而自带的 `dsh-tool-call-timeout-policy` 是**协作式**的——它只在函数体结算**之后**替换结果，对永不结算的函数体无能为力。用户点 Cancel 也只是发一个 abort 信号，不强制关 turn，于是 `phase` 永远停在 `running`，那个会话拒绝任何新工作，**只能重启恢复**。

不死鸟在 `tools/execute` 上以 `prepend: true` 挂一个非协作式竞速：超时抛出 `ToolDeadlineError`，被 `dsh-tools` 的 catch 转成 `toolErrorResult`，**会话继续**。超时同时 abort `exec.signal`，让守规矩的工具自己停下。

被遗弃的 promise 仍在后台跑——这是刻意接受的泄漏，因为一次泄漏的代价远小于一个不可恢复的会话。

> 定时器**故意不加 `unref`**：加了之后 Node 会在超时仍挂起时判定事件循环空闲并退出，恰好毁掉这个守卫要处理的场景（一个永不结算、也不持有其它句柄的工具）。

### P2 · 白屏救援

`SlotAssemblyError` 会被渲染器的错误边界**故意重新抛出**，React 随后卸载整棵树——整页纯色，连用 React 写的救援 UI 也一起消失。

所以救援用原生 `window` 监听 + 原生 DOM 覆盖层，活在 React 树之外。只在命中致命签名时出现（`SlotAssemblyError`、`root` 未注册、缺 `hookContext`、缺 locale face、缺 session adapter、最大更新深度），正常的一格崩溃不会打扰你。

也支持 `?phoenix=rescue` 强制唤起，和控制台里的 `window.__DSH_PHOENIX__.force()`。

## 做不到什么（诚实边界）

| 场景 | 为什么 | 出路 |
|---|---|---|
| 原生崩溃（node-pty / koffi FFI 故障） | 进程直接被 Windows 终止，没有 JS 栈 | 外部 supervisor |
| V8 OOM abort | `Allocation failed` 不可 catch | 外部 supervisor |
| `SIGKILL` / 断电 | JS 无法运行 | 外部 supervisor |
| 启动期失败（`!!js` 抛错、patch 解析失败、import 失败） | 那时本插件还没加载 | 下面的 CLI |
| 工具挂死但超时被配成 `0`/`null` | 那是你明确关掉的 | 改配置 |

## CLI

启动期崩溃时，插件救不了自己，用 CLI：

```bash
dsh-phoenix status          # 隔离了哪些行、多少条记录
dsh-phoenix doctor          # 归因最近一次失败，打印最小覆盖补丁
dsh-phoenix restore <rowId> # 解除某一行
dsh-phoenix restore --all   # 全部解除
dsh-phoenix logs [n]        # 最近的被拦截失败
dsh-phoenix prune           # 清理 30 天前的日志
dsh-phoenix path            # 打印 patch 与日志位置
```

`doctor` 会给出这样一个最小覆盖补丁，**只绕过肇事行**启动：

```bash
dsh --profile <name> --patch ./overlay.yml
```

```yaml
- id: <肇事行 id>
  disabled: true
```

## 配置

```yaml
- id: phoenix
  name: 'dsh-phoenix'
  config:
    enabled: true
    quarantine: true            # 归因成功后写 home 层禁用
    maxQuarantinePerRun: 2      # 熔断，防一次事故连坐
    protectOfficial: true       # @deepseek-ai/ 永不自动禁用
    onUnattributable: log       # log | exit（exit 退回 fail-loud）
    toolDeadline: true          # P1 总开关
    toolTimeoutMs: 1200000      # 默认 20 分钟；0 或 null 关闭
    toolTimeouts:               # 按工具名覆盖
      bash: 3600000
```

## 一个必须记住的坑

`restore --all` 释放最后一行时，**必须留下 `[]` 而不能留空文件**。加载器要求 patch 文件顶层是数组，而 `yaml.load("")` 得到 `undefined` —— 空文件会让「撤销隔离」变成「砖化下次启动」。

开发时这个 bug 真的写出来过，现在由 `tests/run.mjs` 锁住。

## 测试

```bash
node tests/run.mjs
```

25 项，覆盖归因（含 `link:` 路径、前缀误匹配、恶意 `toString`、cause 环）、隔离写入（provider 保留、块幂等、空文件回归、磁盘往返）、工具超时（覆盖优先级、被弃函数体、迟到结果不能覆盖超时、seam 接线）、插件行为（只隔离肇事者、官方包受保护、卸载还原宿主 handler）、客户端救援（致命签名才绘制、幂等、卸载清理）。

## 安装

```bash
dsh plugin --profile <name> add "E:/CodeProgram/杂项/系统安装与PE工具/dsh-phoenix"
```

或开发期用 `link:`：

```json
"dependencies": { "dsh-phoenix": "link:E:/CodeProgram/杂项/系统安装与PE工具/dsh-phoenix" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-phoenix"] } }
```

## 许可

MIT
