# 工作原理

给想了解内部机制的人。只想用的话不需要读这个。

## 它拦的是什么

DSH 默认是 **fail-loud**：`dsh-app-boot` 安装的 `installFailLoud` 把任何未捕获异常或未处理拒绝直接变成 `process.exit(1)`（`dsh-app-boot/lib/index.js:4216-4253`，在 `dsh/lib/profile-boot-*.js:286` 安装）。

进程退出后，桌面壳提供唯一恢复动作：`disableAllPlugins()`（`_desktop/lib/main.js:3585`）→ `sanitizeProfile()`（`:3531`）：

```js
renameSync(patchPath, backupPath);   // cordis.patch.yml → .bak-<时间戳>
writeProfileBundles(profileDir, manifest, WEB_PROFILE.bundles);
```

因为 provider 定义就写在 `cordis.patch.yml` 里，这一步等于**连带所有模型配置一起归档**。bundle 列表被重写成出厂模板，于是得到那个光秃秃的壳。

不死鸟接管这两个进程级 handler，把「死亡」换成「归因 + 隔离 + 换进程」。

## 三个组成部分

### 1. 进程守卫

启动时快照并摘下 `unhandledRejection` / `uncaughtException`，换成自己的处理器；卸载时把原样 handler 装回去，保证可逆、且不影响其它观察者。

归因走两条路径：

- 栈里出现 `node_modules/<包名>/` 的帧 → 直接取包名
- `link:` 安装（真实路径不在 `node_modules` 下，例如开发者本地 checkout）→ 用路径段匹配已挂载行的包根

隔离写到 **home 层**（`$DSH_HOME/cordis.patch.yml`），因为层级顺序是：

```
bundle patches → profile cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch overlays
```

home 层覆盖 profile 层，所以只加一行 `disabled: true` 就够，而 profile 文件一个字节不动。

保护名单：`@deepseek-ai/` 官方包、`cordis:*` 结构行、本插件自身、核心服务行永不自动隔离。熔断：单次运行最多隔离 2 行。

### 2. 崩溃页

致命错误发生时进程**不退出**，而是在宿主已经开着的 HTTP 服务上挂三条路由（`ctx.get('webServer')`，注意服务键是 `webServer` 大写 S）：

| 路由 | 用途 |
|---|---|
| `GET /phoenix/crash` | 崩溃页本身 |
| `GET /phoenix/status` | 当前故障的 JSON |
| `POST /phoenix/decide` | 提交选择 |

页面是**自包含的 HTML**，不依赖 React。这一点是必须的：`SlotAssemblyError` 会被渲染器的错误边界故意重抛，React 随后卸载整棵树，任何用 React 写的救援 UI 都会跟着消失。普通 HTTP 响应不受影响。

页面数据来源：从错误栈最深的那
个文件路径向上找最近的 `package.json`，读 `name` / `version` / `description` / `icon`，以及 `locale/en.json` 的 `meta`。图标以 data URL 内联。

**必须"先隔离再重启"**：直接 `location.reload()` 会对着同一个坏进程重新加载，照样崩。

### 3. 换进程

宿主决定完之后，用同一个可执行文件和 argv 拉起一个 detached 子进程，然后自己退出。

为什么不能只 reload 页面：DSH 自己在 fail-loud 的注释里写了，一个在中途抛错的监听器如果被恢复运行，会留下**静默错误的状态**。所以真正的重置必须是换进程。

判据细节：`ELECTRON_RUN_AS_NODE=1` 时那个进程就是普通 Node（argv[1] 是脚本），**可以**被替换；只有真正的 Electron 主进程（`process.versions.electron` 存在且不在 as-node 模式）才拒绝。

## 复活模式 = 安全模式

归因失败时，崩溃页给的不是「禁用所有插件」，而是**一次性的安全模式**：

```
dsh --profile <你的> --patch <logs/crash-guard/resurrection.patch.yml> --port <空闲端口>
```

那条 overlay 只做一件事：把 `--patch` 能看见的非官方行 `disabled: true`。四个性质：

| 性质 | 靠什么保证 |
|---|---|
| **只这一次** | overlay 写在 `$DSH_HOME/logs/crash-guard/` 下，只能通过 `--patch` 进入那一个进程；profile 层和 home 层一个字节都不写。关掉重开就是正常启动 |
| **供应商不动** | provider 配置是官方行（`llm-pi-ai` / `llm-deepseek` / `agent-default-model`）的 `config` 字段，而那些行在 `keepRow` 里无条件保留。所以新会话里 AI 是活的 |
| **它自己也留着** | `ALWAYS_KEEP = new Set(['phoenix'])`。丢了监护仪的安全模式，第二次出事没人救 |
| **插件自建的供应商会消失** | 那是插件退场的连带结果，不是本插件删除的；且只可能发生在该插件被停用之后 |

判据是**行的归属**，不是供应商的身份。你在设置里配的「幻日模型」「闲鱼」这类第三方接口，全都写在官方行的 `config` 里 —— **身份是第三方的，位置是官方的**，所以按行归属判定天然保住它们。这也是为什么不需要一张"供应商豁免名单"：名单会腐坏，结构不会。

桌面端没有 `--patch` 入口（`dsh-desktop-host` 把 `patchFiles` 写死成 `[]`），也不能替 Electron 另开窗口，所以那条路径返回 `desktop-profile-is-app-managed`，并由 `describeRescueFailure` 翻成人话。**机器码绝不给操作员看**：它既不是诊断，也不是出路。

## 「开除」为什么不立刻执行

真正能干净卸载的入口只有一个：

```js
ctx.get('pluginManager').removeBundle(name)
```

它是 `@Remote` 装饰的服务方法，**插件管理页面的「卸载」按钮调的就是它**（`dsh-client-ui-plugin-manager/lib/client.js:1174`）。它按正确顺序做完整套：取消选中 → reload → 确认没有活着
的 fiber 仍占用它贡献的行 → pnpm remove → 发布并 reload。

拒绝时给出具名原因：`not-removable`、`stop-profile`（无 HMR 且正在运行）、`bundle-in-use`（仍有 fiber 占用）。

**`dsh plugin remove` 不是这个。** 那条命令只是把参数转发给 pnpm（`dsh/lib/plugin-BiveYA7h.js:63-93`），会删掉文件但不会把 bundle 从 `dsh.profile.bundles` 摘掉，留下一个选中了不存在 bundle 的坏 profile。

所以「开除」= 先隔离（保证下次起得来）+ 记录待卸载，真正的卸载在**下次干净启动后**由插件自动执行：那时进程健康、肇事行已禁用、HMR 就绪，正好满足 `removeBundle` 的全部前提。

还有一个坑：`removeBundle` **不抛异常**。`PluginManager.change()` 把预期失败折进返回值（`application: 'failed'` + `error.code`）。只包 `try/catch` 会把每次拒绝都当成成功——清空队列、谎报"已移除"。本插件按返回值判定。

## 为什么没有工具超时

刻意不做。

DSH 不给工具设墙上时钟超时是有意的：**跑三小时的 cargo 编译、监听好几天的抢票脚本，都是正常用法**。加超时会杀掉合法工作。长任务有正确的去处——后台作业系统。

至于「用户点了取消但工具不理」，那是会话卡死，属于受伤：重启就恢复，而重启现在是一次点击的事。用杀长任务去换这个场景不值得。

## 覆盖不到的故障

| 场景 | 为什么 | 出路 |
|---|---|---|
| 原生崩溃（node-pty / koffi FFI） | Windows 直接终止进程，没有 JS 栈 | 外部 supervisor |
| V8 OOM abort | `Allocation failed` 不可 catch | 外部 supervisor |
| `SIGKILL` / 断电 | JS 无法运行 | 外部 supervisor |
| 启动期失败 | 那时本插件还没加载 | CLI `doctor` |
| **组合层 / 服务层故障** | 被 cordis 捕获成 fiber 失败，经 RPC 返回，**不经过进程级 handler** | 见下 |

最后一条值得单独说。典型形态是这类报错：

```
提示部分"deployment:persona-prefix"已注册
active Service "directoryPickerController" is unavailable
```

它们不杀死进程，但会让某些操作（新对话、目录选择）直接失败。**目前的进程守卫拦不到它们**，因为错误在 fiber 内部就被 cordis 捕获了，走的是 RPC 而不是 `uncaughtException`。

这类问题属于「完全阻塞」范畴，是后续要补的层。

## 一个必须记住的坑

`restore --all` 释放最后一行时，**必须留下 `[]` 而不能留空文件**。加载器要求 patch 文件顶层是数组，而 `yaml.load("")` 得到 `undefined` —— 空文件会让「撤销隔离」变成「砖化下次启动」。

开发时真的写出过这个 bug，现在由测试锁住。
