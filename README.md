# dsh-phoenix（不死鸟）

> 受伤可以，死亡不行。

DSH 默认是 **fail-loud**：任何未捕获异常或未处理拒绝都会让宿主进程 `exit(1)`。桌面端看到这个退出后，唯一提供的恢复动作是「禁用第三方插件、备份 profile patch 并重启」——它把 `cordis.patch.yml` 整个改名归档，**连带你的所有供应商配置一起消失**，然后用出厂模板重建一个空壳。

一个插件的坏定时器，代价可以是你的全部配置。

不死鸟把「进程死亡」换成「**崩溃页等你决定 + 只隔离出事的那一行 + 换一个干净进程**」。

## 它怎么工作

### 1 · 进程守卫

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

### 2 · 崩溃页（核心）

捕获到致命错误时，**进程不退出**，而是把宿主已经开着的 HTTP 服务里挂一个页面：`/phoenix/crash`。

那是一个**自包含的 HTML 文档**，不依赖 React——因为 React 树可能已经被卸载了，这时候任何用 React 写的 UI 都跟着一起消失。页面是普通 HTTP 响应，浏览器照常渲染。

页面显示肇事插件的**图标、名称、版本、安装路径、介绍、完整错误栈**，然后给你三个选择：

| 按钮 | 行为 |
|---|---|
| **给个机会** | 什么都不改，直接换进程重启 |
| **停职** | 往 home 层写该行 `disabled: true`，然后换进程重启 |
| **开除** | 同上，另外记一条待卸载（见下方说明） |

**为什么必须"先隔离再重启"**：直接 `location.reload()` 会对着同一个坏进程重新加载，照样崩。所以顺序是「写隔离 → 换进程 → 页面重载」，重载后连上的是干净宿主。

**支持 `?phoenix=rescue`** 手动唤起这个页面。

### 3 · 白屏救援

`SlotAssemblyError` 会被渲染器的错误边界**故意重新抛出**，React 随后卸载整棵树——整页纯色，连用 React 写的救援 UI 也一起消失。

所以这一层用原生 `window` 监听 + 原生 DOM 覆盖层，活在 React 树之外。只在命中致命签名时出现（`SlotAssemblyError`、`root` 未注册、缺 `hookContext`、缺 locale face、缺 session adapter、最大更新深度），正常的一格崩溃不会打扰你。

也支持控制台里的 `window.__DSH_PHOENIX__.force()`。

## 为什么没有工具超时

这是刻意的，不是漏做。

DSH 不给工具设墙上时钟超时是有意的：**一个跑三小时的 cargo 编译、一个监听好几天的抢票脚本，都是正常用法**。管超时会把这些合法工作杀掉。长时间任务本来就有正确的去处——后台作业系统。

至于"用户按了取消但工具不理"，那是会话卡死，属于**受伤**：卡死之后重启就恢复，而重启现在是一次点击的事。用杀长任务去换这个场景不值得。

## 做不到什么（诚实边界）

| 场景 | 为什么 | 出路 |
|---|---|---|
| 原生崩溃（node-pty / koffi FFI 故障） | 进程直接被 Windows 终止，没有 JS 栈 | 外部 supervisor |
| V8 OOM abort | `Allocation failed` 不可 catch | 外部 supervisor |
| `SIGKILL` / 断电 | JS 无法运行 | 外部 supervisor |
| 启动期失败（`!!js` 抛错、patch 解析失败、import 失败） | 那时本插件还没加载 | 下面的 CLI |
| 没有任何 HTTP 服务在跑 | 崩溃页没地方挂 | CLI；或先隔离再手动重开 |
| 会话卡死（工具不理取消） | 这是受伤，不是死亡 | 重启 |

**关于「开除」**：崩溃态下**不会**立刻删包，而且这跟 DSH 自己的设计一致。

真正能干净卸载的入口只有一个：

```js
ctx.get('pluginManager').removeBundle(name)
```

它是 `@Remote` 装饰的正式服务方法，**插件管理页面上的「卸载」按钮调的就是它**（`dsh-client-ui-plugin-manager/lib/client.js:1174`），`plugin_manager` 工具也是同一个。它按正确顺序做完整套：取消选中 → reload → 确认没有活着的 fiber 仍占用它贡献的行 → pnpm remove → 发布并 reload。拒绝时给出具名原因：

| 失败码 | 含义 |
|---|---|
| `not-removable` | 这个 bundle 不能从当前 profile 移除 |
| `stop-profile` | 没有 HMR 且它正在运行，必须先停 profile |
| `bundle-in-use` | 仍有活着的 fiber 占用它贡献的行 |

**`dsh plugin remove` 不是这个。** 那条命令只是把参数转发给 pnpm（`dsh/lib/plugin-BiveYA7h.js:63-93`），它会删掉文件但**不会**把 bundle 从 `dsh.profile.bundles` 里摘掉，于是留下一个选中了已不存在 bundle 的坏 profile。

所以「开除」= 先隔离（保证下次一定起得来）+ 记录待卸载，真正的卸载由插件在**下次干净启动后**自动执行：那时进程健康、肇事行已禁用、HMR 就绪，正好满足 `removeBundle` 的全部前提。失败会留在队列里等下次重试，并记下具体原因。

还有一个容易踩的细节：`removeBundle` **不会抛异常**。`PluginManager.change()` 把预期失败折进返回值（`application: 'failed'` + `error.code`）。只包 `try/catch` 会把每次拒绝都当成成功——清空队列、谎报"已移除"。本插件按返回值判定，并由测试锁住。

## CLI

启动期崩溃时，插件救不了自己，用 CLI：

```bash
dsh-phoenix status          # 隔离了哪些行、待卸载队列、是否支持自动重启
dsh-phoenix doctor          # 归因最近一次失败，打印最小覆盖补丁
dsh-phoenix restore <rowId> # 解除某一行
dsh-phoenix restore --all   # 全部解除
dsh-phoenix logs [n]        # 最近的被拦截失败
dsh-phoenix finalize        # 查看待卸载队列（实际卸载在下次启动自动执行）
dsh-phoenix prune           # 清理 30 天前的日志
dsh-phoenix path            # 打印 patch 与日志位置
```

`finalize` 只报告，不执行——原因见上面「关于开除」。队列由插件在下次启动后自行清空。

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
```

崩溃页的行为不需要配置：有致命错误就挂住宿主，等你决定。

## 一个必须记住的坑

`restore --all` 释放最后一行时，**必须留下 `[]` 而不能留空文件**。加载器要求 patch 文件顶层是数组，而 `yaml.load("")` 得到 `undefined` —— 空文件会让「撤销隔离」变成「砖化下次启动」。

开发时这个 bug 真的写出来过，现在由 `tests/run.mjs` 锁住。

## 测试

```bash
node tests/run.mjs
```

33 项，覆盖归因（含 `link:` 路径、前缀误匹配、恶意 `toString`、cause 环）、隔离写入（provider 保留、块幂等、空文件回归、磁盘往返）、崩溃页（HTML 转义、三按钮、无法归因时禁用动作按钮、选择校验）、恢复流程（无 webserver 降级、三路由注册与卸载、停职先写隔离再换进程、开除排队卸载）、元数据（从栈帧定位包目录、图标内联）、自重启（只拒绝真正的 Electron 主进程）、**卸载**（折叠失败不算成功、`applied`/`restart-required` 都算成功、失败留队、拒绝卸载自己、无 pluginManager 时不删任何东西）、插件行为（只隔离肇事者、官方包受保护、卸载还原宿主 handler）、客户端救援（致命签名才绘制、幂等、卸载清理）。

有一条实测记录在 `tests/live-verify.md`：崩溃 → 崩溃页 200 → 点停职 → 隔离落盘 → 新进程起来（不同 PID，创建时间对得上）→ 不再崩溃。

## 安装

**注意**：`desktop` profile 由 Electron 独占管理，CLI 拒绝操作它（`dsh --profile desktop --dump-config` 会报 `profile "desktop" is managed exclusively by the Electron application`）。所以装进桌面端只能：

- 走应用内的插件管理器，或
- 手工改 `~/.dsh/profiles/desktop/package.json`：

```json
"dependencies": { "dsh-phoenix": "link:E:/CodeProgram/杂项/系统安装与PE工具/dsh-phoenix" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-phoenix"] } }
```

**先别装进主 profile。** 这个插件接管的是 `uncaughtException`，装之前应当在独立 profile 里跑一遍 `tests/live-verify.md` 的流程，确认它和你的其它插件能共存。

独立 profile 里这样装：

```bash
dsh plugin --profile <name> add "E:/CodeProgram/杂项/系统安装与PE工具/dsh-phoenix"
```

## 许可

MIT
