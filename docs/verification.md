# 验证记录

自动化测试只用假宿主。这份文档是**真实 DSH 进程**上的验证，可以照着复跑。

环境：DSH 0.2.1-rc.2（`dsh` CLI），Windows，Node 22。

## 准备

一个隔离的测试 profile，**不要用 desktop**：

```bash
mkdir -p ~/.dsh/profiles/phoenix-dev
cd ~/.dsh/profiles/phoenix-dev
printf '[]\n' > cordis.yml
printf '[]\n' > cordis.patch.yml
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
EOF
```

`package.json`：

```json
{
  "name": "dsh-profile-phoenix-dev",
  "private": true,
  "dependencies": {
    "dsh-phoenix": "link:E:/CodeProgram/杂项/系统安装与PE工具/dsh-phoenix",
    "fake-crashy": "link:E:/CodeProgram/杂项/系统安装与PE工具/test-fixtures/fake-crashy"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-phoenix",
        "fake-crashy"
      ]
    }
  }
}
```

```bash
pnpm install --ignore-scripts
```

`fake-crashy` 故意从定时器抛错（6 秒后），绕过插件层所有 catch，直接落到进程的 `uncaughtException`。没有守卫时，宿主会 `exit(1)`。

## 崩溃页全链路

```bash
rm -f ~/.dsh/cordis.patch.yml
rm -rf ~/.dsh/logs/crash-guard
dsh --profile phoenix-dev --no-open --port 3101
```

约 6 秒后 fixture 抛错。期望宿主**不退出**，转而服务崩溃页：

```bash
curl -s -o /tmp/cp.html -w "%{http_code}\n" http://127.0.0.1:3101/phoenix/crash
# 200
grep -o "DSH 崩溃恢复\|给个机会\|停职\|开除\|fake-crashy" /tmp/cp.html
```

点「停职」（等于页面上的按钮被按下）：

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"choice":"disable"}' http://127.0.0.1:3101/phoenix/decide
# {"ok":true,"message":"已禁用：fake-crashy"}
```

期望三件事发生：

1. `~/.dsh/cordis.patch.yml` 出现托管块，只含 `- id: "fake-crashy"` + `disabled: true`
2. **旧进程退出**（后台任务以 exit 1 结束，这是设计行为）
3. **新进程起来**并重新监听同一端口

```bash
sleep 14
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3101/            # 401 = 新进程在服务
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3101/phoenix/crash  # 404 = 新进程不在恢复态
```

### 实测结果（本轮）

| 检查点 | 结果 |
|---|---|
| 崩溃页 | `HTTP 200`，5416 字节，标题与非托管插件名 `fake-crashy` 都在 |
| `/phoenix/status` | `{"ok":true,"recovering":true,"decided":false,…}`，含完整栈 |
| POST disable | `{"ok":true,"message":"已禁用：fake-crashy"}` |
| 隔离落盘 | 托管块只含 `fake-crashy` |
| 旧进程 | 后台任务 exit 1 |
| 新进程 | `HTTP 401`，`/phoenix/crash` 变 404；只有一个新 PID，创建时间正是点停职的那一刻 |
| 新进程记录 | `guard-activated` 的 `quarantinedIds` 已含 `fake-crashy` |
| 二次崩溃 | 无 |

`dsh-phoenix status` 会报告 `auto-restart: available`，它是在插件激活时探一次 `restartCommand()` 得出的——让你事先就知道「停职」能不能真的自动重启。

## 崩溃页外观

`node scripts/preview-crash-page.mjs` 可以用真实渲染函数预览，不崩溃任何东西。

## 隔离生效

再启动一次：

```bash
dsh --profile phoenix-dev --no-open --port 3091
```

期望正常打印 `dsh web: http://...`，**不再有崩溃记录**（fixture 已被跳过）。

## CLI

```bash
node bin.js status      # 隔离列表、待卸载队列、自动重启能力
node bin.js doctor      # 归因 + 最小覆盖补丁
node bin.js logs 3
node bin.js path
node bin.js restore --all
cat ~/.dsh/cordis.patch.yml   # 必须是 []，不能是空文件
```

## 客户端模块接线

```bash
dsh --profile phoenix-dev --no-open --port 3093
```

取启动日志里的 URL 后：

```bash
curl -s -L -c /tmp/pj.txt -b /tmp/pj.txt "http://127.0.0.1:3093/?token=..." -o /tmp/page.html
grep -o '{"id":"dsh-phoenix"[^}]*}' /tmp/page.html
# {"id":"dsh-phoenix","url":"plugins/??dsh-phoenix/client.js&rev=...","inject":[],"immediately":true}

curl -s -b /tmp/pj.txt "http://127.0.0.1:3093/plugins/??dsh-phoenix/client.js&rev=<rev>" -o /tmp/combo.js
node --check /tmp/combo.js
```

实测：HTTP 200，7570 字节，`node --check` 通过，致命签名都在产物里。

## 清理

```bash
rm -f ~/.dsh/cordis.patch.yml
rm -rf ~/.dsh/logs/crash-guard
```

验证完成后 home 层应恢复到「文件不存在」的原始状态。

## 未验证项

| 项 | 原因 |
|---|---|
| Electron 桌面端的复活模式 | `desktop` profile 由 Electron 独占，`dsh-desktop-host` 把 `patchFiles` 写死成 `[]`，没有 `--patch` 入口。桌面端会如实返回 `desktop-profile-is-app-managed`（已翻成中文），并让你手动重开 |
| 「开除」真正执行卸载 | 只验证到「记录待卸载」，`finalizeRemovals` 逻辑由单元测试覆盖，未在真实包上跑过 |
| 组合层故障（见下） | 尚未实现 |

## 桌面端安装实测

在真实的 `desktop` profile 上装过一次（`plugin_manager install_bundle`，link 到工作树），验证到这三件事：

| 检查点 | 结果 |
|---|---|
| 安装回执 | `application: "applied"`，无 warnings |
| 插件是否真的挂上 | `~/.dsh/logs/crash-guard/2026-10-30.jsonl` 出现 `guard-activated` + `composition-scan healthy` |
| 宿主路由是否可达 | `GET http://127.0.0.1:<port>/phoenix/rescue` → `200 {"ok":true,"prepared":null}` |

`/phoenix/crash` 与 `/phoenix/status` 返回 404 是**正确**的：那两个路由只在崩溃托管期间注册。

顺带一个只有实测才看得到的事实：`/phoenix/rescue` 没有走 `/api` 那道浏览器信任栅栏，未带 token 的请求也能到达（`/` 是 401，`/phoenix/rescue` 是 200）。它不返回任何数据，最坏情况是一个本地进程替你准备一次复活——但这一层要不要加校验，是个待定项。

## 已知未覆盖：组合层 / 服务层故障

这类报错不会杀死进程，但会让新对话或某些操作直接失败：

```
提示部分"deployment:persona-prefix"已注册
active Service "directoryPickerController" is unavailable
```

机制：错误在 fiber 内部被 cordis 捕获成 `FAILED`，经 RPC 变成 `RemoteError` 返回界面，**不经过 `uncaughtException`**，所以进程守卫拦不到。

这是后续要补的层。
