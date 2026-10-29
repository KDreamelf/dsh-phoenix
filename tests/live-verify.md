# 真实环境验证记录

自动化测试只用假宿主。这份文档记录的是**真实 DSH 进程**上的验证，可以被你重新跑一遍复核。

环境：DSH 0.2.1-rc.2（`dsh` CLI），Windows，Node 22。

## 准备

一个隔离的测试 profile，**不碰你的主 profile**：

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

`fake-crashy` 是一个故意从定时器抛错的 fixture（6 秒后触发 `throw`），它会绕过插件层所有 catch，直接落到进程的 `uncaughtException`。没有守卫时这会让宿主 `exit(1)`。

## 验证 1：进程存活

```bash
rm -f ~/.dsh/cordis.patch.yml
dsh --profile phoenix-dev --no-open --port 3090
```

约 6 秒后 fixture 抛错。期望：

- stderr 出现 `dsh-phoenix: contained uncaughtException from fake-crashy; quarantined row fake-crashy ...`
- **没有** `dsh: fatal uncaught exception`（那是 fail-loud 的信号）
- web 仍在监听：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3090/
# 401 —— 401 是浏览器信任围栏，说明服务活着
```

记录到的结果：`HTTP 401`，进程存活。

## 验证 2：只隔离肇事行

```bash
cat ~/.dsh/cordis.patch.yml
```

期望恰好是一个托管块，只有一个 id：

```yaml
# >>> dsh-phoenix quarantine — managed, do not edit between these markers
- id: "fake-crashy"
  disabled: true
# <<< dsh-phoenix quarantine
```

**关键点**：这里是 home 层，不是你的 profile。你 profile 里的 `cordis.patch.yml`（provider 住的地方）一个字节都没动。

记录到的结果与上面一致。

## 验证 3：归因日志

```bash
cat ~/.dsh/logs/crash-guard/$(date +%F).jsonl
```

期望有一条 `kind` 为 `uncaughtException` 的记录，`package` 为 `fake-crashy`，`decision` 为 `quarantined`，并带完整 stack。

注意这次是 `link:` 安装——栈里的路径是 `E:/.../test-fixtures/fake-crashy/index.js`，**没有 `node_modules` 段**。它由路径段归因命中，这是归因的第二条路径。

## 验证 4：隔离在下次启动生效

再启动一次：

```bash
dsh --profile phoenix-dev --no-open --port 3091
```

期望：正常打印 `dsh web: http://...`，**不再有崩溃记录**（fixture 已被跳过）。

记录到的结果：正常启动，崩溃记录数仍为 1。

## 验证 5：CLI

```bash
node bin.js status      # quarantine: fake-crashy
node bin.js doctor      # 归因 + 最小覆盖补丁
node bin.js logs 3
node bin.js path
node bin.js restore --all
cat ~/.dsh/cordis.patch.yml   # 必须是 []，不能是空文件
```

`restore --all` 之后文件内容必须是 `[]`（3 字节）。

**这一条是回归重点**：空文件会被 patch 加载器拒绝（`yaml.load("")` → `undefined`，而加载器要求顶层是数组），所以「撤销隔离」曾经会「砖化下次启动」。开发时真的写出过这个 bug，现在两处写入都保证留下 `[]`。

## 验证 6：客户端模块接线

```bash
dsh --profile phoenix-dev --no-open --port 3093
```

取到启动日志里的 URL 后：

```bash
URL="http://127.0.0.1:3093/?token=..."
curl -s -L -c /tmp/pj.txt -b /tmp/pj.txt "$URL" -o /tmp/page.html

# boot payload 里应有这一条
grep -o '{"id":"dsh-phoenix"[^}]*}' /tmp/page.html
# {"id":"dsh-phoenix","url":"plugins/??dsh-phoenix/client.js&rev=...","inject":[],"immediately":true}

# combo bundle 能取到且语法有效
curl -s -b /tmp/pj.txt "http://127.0.0.1:3093/plugins/??dsh-phoenix/client.js&rev=<rev>" -o /tmp/combo.js
node --check /tmp/combo.js
```

记录到的结果：HTTP 200，7570 字节，`node --check` 通过，致命签名（`SlotAssemblyError`、`no locale face is installed`、`Maximum update depth`）都在产物里。

这一步只证明**模块被正确注册和分发**。实际的白屏救援要在浏览器里触发，本机没有浏览器控制，属于未验证项——可以在真实页面上用 `?phoenix=rescue` 手动确认覆盖层。

## 清理

```bash
rm -f ~/.dsh/cordis.patch.yml
rm -rf ~/.dsh/logs/crash-guard
```

验证完成后 home 层应恢复到「文件不存在」的原始状态。

## 未验证项（诚实清单）

| 项 | 原因 |
|---|---|
| 浏览器里真实的白屏救援 | 无浏览器控制；只能证明模块分发与产物有效 |
| P1 超时在真实会话里的效果 | 需要真实 agent 循环 + 一个会挂死的工具；seam 层已由测试覆盖 |
| 原生崩溃 / OOM / SIGKILL | 进程内守卫**不覆盖**，需要外部 supervisor |
| 启动期崩溃的 `doctor` 归因 | 需要人为构造 patch 解析失败；`doctor` 逻辑已由单元测试覆盖 |
