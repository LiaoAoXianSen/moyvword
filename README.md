# Moyvword（摸鱼背词横条）

当前发布基线：v46。它是一个 Electron 单词学习工具，主窗口负责词库、计划和设置，桌面横条负责低打扰学习。

## 先看这里

- 最新便携包：`dist/摸鱼背词横条-v46.exe`
- 项目交接与迁移说明：[`PROJECT_HANDOFF.md`](PROJECT_HANDOFF.md)
- 维护、数据和测试细节：[`PROJECT_HANDOFF.md`](PROJECT_HANDOFF.md) 的“维护导航”及后续章节。
- 当前调度真相：同一天内，只有第一次计划内评分会更新长期记忆；后续重刷只做当天巩固。
- v46 起学习数据优先读取项目/程序根目录的 `data/moyu-vocab.sqlite`；C 盘 `AppData\\Roaming\\moyu-vocab-strip\\moyu-vocab.sqlite` 只作兜底镜像，设置里可选择额外备份目录。

## 当前功能

- 主窗口词库、词本管理、导入、搜索、在线查词、学习记录和设置。
- 桌面横条、自动发音、音量、老板键和全局快捷键。
- 四档评分：不认识、模糊、认识、熟知。
- 墨墨式当日调度：到期复习全量优先；剩余目标自动填新词；手动/随机选择可替换自动新词。
- SQLite 本地持久化、程序目录主数据、C 盘兜底镜像、自定义备份目录和旧 JSON 迁移。

## 快捷键

- `Alt+A` 上一个
- `Alt+S` 发音
- `Alt+D` 下一个
- `Alt+Z` 不认识
- `Alt+X` 模糊
- `Alt+C` 认识
- `Alt+V` 熟知
- `Alt+Q` 隐藏/显示横条
- `Alt+W` 查单词
- `Alt+E` 显示主窗口
- `Alt+R` 不再出现
- `Alt+F` 看答案

## 本地运行

```powershell
npm install
npm start
```

## 打包

```powershell
npm run dist
```

打包名由 `package.json` 的 `build.artifactName` 控制。每次发布按版本递增，例如 v44 后发布 v45，避免覆盖正在运行的旧 EXE。发布目录只保留最新 5 个 EXE。

## 最小检查

```powershell
node --check src/store.js
node --check src/scheduler.js
node --check src/main.js
node --check src/app.js
npm run dist
```
