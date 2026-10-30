# 开发与验证

## 仓库结构

```
index.js              宿主侧插件（进程守卫 + 崩溃页接线）
client.js             Web 侧救援（原生 window 监听 + DOM 覆盖层）
bin.js                CLI：status / doctor / restore / logs / finalize / prune / path
cordis.patch.yml      bundle 补丁，插入 phoenix 行
src/
  attribution.js      把抛错归因到某个插件行
  quarantine.js       home 层隔离写入（含空文件教训）
  crash-page.js       崩溃页渲染（纯字符串，无依赖）
  recovery.js         挂住宿主、三条路由、执行选择
  self-restart.js     换进程
  meta.js             从栈帧定位包目录、读图标/介绍
  finalize.js         在干净启动后执行排队卸载
  log.js              崩溃记录（同步写）
tests/
  run.mjs             33 项自动化测试
  live-verify.md      真实环境验证步骤
scripts/
  preview-crash-page.mjs   本地预览崩溃页，不崩溃任何东西
```

## 跑测试

```bash
node tests/run.mjs
```

测试用假宿主（fake ctx / fake DOM / 临时 `DSH_HOME`），不碰真实环境。

## 预览崩溃页

不崩溃任何东西，用真实渲染函数起一个本地页面：

```bash
node scripts/preview-crash-page.mjs --port 7788
```

浏览器会打开 `http://127.0.0.1:7788/phoenix/crash`。按钮点了只会打印到终端，不会隔离也不会重启。

## 在隔离 profile 里实测

真实环境验证的完整步骤在 [tests/live-verify.md](../tests/live-verify.md)。核心流程：

1. 建一个独立 profile（**不要用 desktop**）
2. 装一个故意抛错的假插件
3. 观察崩溃页能否打开、点「停职」后隔离是否落盘、新进程是否起来

`test-fixtures/fake-crashy/` 就是这个假插件。

## 设计约束（改代码前请先读）

**不要向 `document.body` 追加第二个应用。** 崩溃页用的是原生 DOM 覆盖层，只在命中致命签名时出现，不接管宿主 UI。

**不要在崩溃处理器里执行卸载。** 卸载必须走 `pluginManager.removeBundle`，而它自带 `stop-profile` 和 `bundle-in-use` 两个守卫，明确拒绝卸载运行中的 bundle。排队到下次干净启动是正确做法。

**不要用 try/catch 判断 `removeBundle` 成败。** 它不抛异常，失败折进返回值的 `application: 'failed'` + `error.code`。

**空 patch 文件会砖化下次启动。** 加载器要求顶层是数组，`yaml.load("")` 是 `undefined`。释放最后一行隔离时必须留 `[]`。

**不要给工具加墙上时钟超时。** 长任务是合法用法。

## 提交约定

提交信息说明**为什么**，不是改了什么。如果踩到了某个反直觉的行为，把它写进提交或代码注释——那是下一个人最需要的东西。

## 许可

MIT
