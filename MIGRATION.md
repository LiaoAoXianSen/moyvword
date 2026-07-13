# Moyvword 迁移说明

## 本次迁移内容

本目录由原 Electron 工程复制而来，保留了：

- `src/`：全部业务源码。
- `assets/`：图标和打包资源。
- `README.md`、`PROJECT_HANDOFF.md`、`task_plan.md`、`progress.md`、`findings.md`：项目文档和历史。
- `release/摸鱼背词横条-v44.exe`：当前可运行便携包。
- `data/moyu-vocab.sqlite` 与 `data/moyu-vocab.sqlite.bak`：迁移时刻的学习数据备份。
- `data/legacy/moyu-vocab-data.json`：旧格式归档，仅用于历史恢复。

未带入的可再生成内容：`node_modules/`、历史 `dist` 版本、`dist/win-unpacked/`、临时解包目录和 Chromium 缓存。

## 运行时数据位置

当前代码仍使用下面的 Electron 用户数据目录：

```text
C:\Users\lihao\AppData\Roaming\moyu-vocab-strip\
```

因此，`data/` 是安全备份，不会自动覆盖正在使用的数据。这样做能避免新目录中的副本在应用运行时覆盖新学习记录。

## 恢复学习数据

仅在数据损坏或迁移到新电脑时执行：

1. 退出所有“摸鱼背词横条”进程。
2. 备份当前 `AppData\Roaming\moyu-vocab-strip` 目录。
3. 将项目 `data/moyu-vocab.sqlite` 和 `data/moyu-vocab.sqlite.bak` 复制到该目录。
4. 启动 v44，检查词本数量、今日计划和最近学习记录。

不要在应用仍在运行时覆盖 SQLite 文件。

## 从源码构建

```powershell
cd D:\project\moyvword
npm install
npm run dist
```

当前应用显示名与打包文件名保持为“摸鱼背词横条”，这是为了保证已有数据路径和用户使用习惯不发生变化。`package.json` 的 npm 项目名已经改为 `moyvword`。

## 清理旧目录前的验收

1. `node --check src/store.js`、`src/scheduler.js`、`src/main.js`、`src/app.js` 均成功。
2. `npm run dist` 成功生成便携包。
3. 运行 v44 或新构建包，确认已有词本和学习记录存在。
4. 对比本目录 `data/` 与 AppData 中 SQLite 的文件大小或哈希。
5. 上述检查完成前，旧目录仅作为回滚副本，不能删除。

## 本次执行结果

- 已复制源码、文档、v44 和 SQLite 主库/备份。
- 已在 `D:\project\moyvword` 执行 `npm install`。
- 已通过所有关键 Node 语法检查和 `npm run dist`。
- 新构建的 `dist/摸鱼背词横条-v44.exe` 已校验并写入 `release/摸鱼背词横条-v44.exe`。
- 原项目目录和历史版本尚未删除，仍可回滚。
