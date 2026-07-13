# Moyvword 项目交接

## 当前基线

- 项目目录：`D:\project\moyvword`
- 最新发布：`dist/摸鱼背词横条-v46.exe`
- 技术栈：Electron 31、Node.js、`ts-fsrs`、`sql.js`、原生 HTML/CSS/JavaScript。
- npm 项目名为 `moyvword`；发布名称仍是“摸鱼背词横条”。为保证现有学习数据继续可见，本次迁移不改 `productName`、`appId` 或 Electron 用户数据路径。

## 架构与职责

| 文件 | 责任 |
| --- | --- |
| `src/main.js` | Electron 窗口、托盘、全局快捷键、IPC、在线查词入口。 |
| `src/preload.js` | 渲染层可调用的受限 IPC API。 |
| `src/store.js` | 词本、今日计划、学习队列、同日短循环、统计、导入和数据写入。 |
| `src/scheduler.js` | FSRS 长期卡片计算、静态词难度、保持率和优先级辅助函数。 |
| `src/persistence.js` | SQLite 数据读写、原子写入、`.bak` 回退、旧 JSON 迁移。 |
| `src/app.*` | 主窗口管理界面。 |
| `src/strip.*` | 桌面横条。 |
| `src/word-import.js` | txt/csv/xlsx 导入。 |
| `src/online-wordbooks.js` | 在线词书目录与下载。 |

## 维护导航

### 进程与窗口

应用从 `src/main.js` 启动，创建两个 `BrowserWindow`：

| 窗口 | 文件 | 尺寸和行为 | 用途 |
| --- | --- | --- | --- |
| 主窗口 | `app.html` / `app.js` | 默认 `1080x700`，最小 `920x560` | 词库、词本、计划、设置、查词。 |
| 横条 | `strip.html` / `strip.js` | `520x34`，展开 `520x132` | 无边框、透明、置顶、不进任务栏。 |

- 所有全局快捷键都在 `main.js` 的 `shortcuts` 数组登记；修改快捷键时必须同时检查系统级冲突和 `store.getState().shortcuts` 的显示文本。
- 横条坐标保存在设置的 `stripPosition` 中。窗口移动后会防抖写入；关闭时会强制再保存一次。
- 主窗口关闭不会退出应用，横条和托盘仍保留。应用再次启动时若已存在实例，会显示已有窗口。
- `main.js` 会关闭 GPU，以规避旧环境的 GPU 崩溃；不要在没有回归测试时删除这些启动参数。
- 窗口显式启用 `contextIsolation`、关闭 `nodeIntegration`，并阻止非预期导航和新窗口；HTML 内置 CSP。当前 preload 仍使用 Electron API，因此未开启 `sandbox: true`。
- 全局快捷键注册失败会进入设置页提示，通常是被系统或其他软件占用。

### 渲染层与 IPC

渲染层只能通过 `src/preload.js` 暴露的 `window.moyu` 调用主进程。不要在 `app.js` 或 `strip.js` 直接引入 Node API。

| 类别 | 主要 IPC | 说明 |
| --- | --- | --- |
| 状态与操作 | `state:get`、`action`、`settings:update` | 横条和主窗口的统一状态刷新入口。 |
| 词库 | `words:list`、`word:add/update/delete`、`words:bulk` | 词库分页、编辑、批量操作。 |
| 今日计划 | `plan:get`、`plan:sample-new`、`plan:add-new`、`plan:add-review-words` | 自动计划之外的手动选择。 |
| 词本 | `books:*`、`online-books:*` | 本地词本与在线词书。 |
| 查词 | `lookup:search`、`lookup:save` | 先搜当前词本，未命中才走在线词典。 |
| 文件 | `import:choose`、`backup:save` | 导入与用户主动备份。 |
| 窗口 | `window:move`、`window:strip-size`、`window:main` | 横条移动、展开和主窗口显示。 |

每次会影响学习状态的主进程操作后都应执行 `broadcastState()`；否则主窗口与横条会显示旧状态。

### 词本与单词的边界

- 单词本只决定新词候选来源，学习历史属于单词本身，不属于词本。
- 一个单词可以属于多个词本，字段为 `bookIds`；`bookId` 只是兼容性主归属字段。
- 删除词本只删除归属关系，不能删除已有单词的复习历史；无词本的已学词仍应进入到期复习池。
- `status` 的语义：`new` 未进行首次长期评分，`learning` / `review` 可进入复习，`done` 为用户明确不再出现。
- 切换当前词本只影响后续新词候选来源；当天已经进入计划的单词不会因为切换词本被移除。
- 从词库的“切换到这个单词”只用于手动查看；它不是“加入今日计划”。要把词加入计划必须使用计划/随机/搜词的加入操作。

## 数据模型与持久化

### SQLite 结构

数据库由 `src/persistence.js` 管理，使用 `sql.js` 在内存中操作后导出整个 SQLite 文件。

| 表/键 | 内容 |
| --- | --- |
| `words` | 单词的可查询字段和完整 JSON `payload`。索引用于到期、单词文本和顽固度查询。 |
| `meta.settings` | 设置：每日目标、学习窗口、发音、音量、当前词本、用户记忆系数、横条位置等。 |
| `meta.session` | 当日日期、计划项、学习窗口、手动回顾 ID、当日统计。 |
| `meta.books` | 词本列表。 |
| `meta.studyLog` | 按日期和词本的学习汇总，用于连续天数、预测和记忆系数。 |
| `meta.ui` | 当前单词、浏览历史、答案显示状态。 |

### 写入与恢复不变量

1. v46 起主数据库优先在项目/程序根目录的 `data/moyu-vocab.sqlite`；开发环境对应 `D:\project\moyvword\data\moyu-vocab.sqlite`，打包 EXE 放在 `dist` 或 `release` 时也回到项目根目录读取 `data\moyu-vocab.sqlite`。
2. 保存时先把现有主数据库复制为 `.bak`。
3. 再把导出的新数据库写到 `.tmp`，完成后以重命名替换正式文件。
4. 保存主数据库后，会尽量镜像一份到旧版 C 盘目录 `AppData\\Roaming\\moyu-vocab-strip` 作为兜底；设置里选择的自定义备份目录也会尽量同步 `moyu-vocab.sqlite`。
5. 主数据库缺失时，启动会尝试从 C 盘镜像、镜像 `.bak`、自定义备份目录恢复；主数据库和镜像都存在时默认使用主数据库，不自动覆盖。
6. `moyu-vocab-data.json` 只在 SQLite 尚未初始化时导入一次；不要把它当作最新数据源覆盖 SQLite。

不要手工编辑 SQLite 的 `payload`，除非已经完整备份并理解对应字段。`words` 的常用列只是索引副本，完整状态以 `payload` 为准。

### 重要字段

| 分类 | 字段 | 含义 |
| --- | --- | --- |
| 长期卡片 | `stability`、`difficulty`、`interval`、`due`、`reviewCount`、`lastReviewedAt` | FSRS 计算和跨天复习。 |
| 静态/用户参数 | `wordDifficulty`、`userMemoryCoeff` | 静态词难度与个人间隔修正。 |
| 日内循环 | `dayLoopDate`、`dayLoopDue`、`dayLoopCardsBefore`、`dayLoopPriority`、`dayLoopRemaining` | 仅当天使用，跨日自动失效。 |
| 弱词信号 | `wrongCount`、`hardCount`、`lapseCount` | 影响优先级和错词筛选。 |
| 计划 | `planItems[].type/source/status` | 今日新词/复习来源，以及 pending/completed/cancelled 生命周期。 |

## 评分与计划状态机

### 首次计划内评分

```text
当前计划词
  -> 当天尚未长期评分
  -> rateWord(FSRS)
  -> 难度和用户系数修正跨天间隔
  -> 记录 longTermRatingDate
  -> 不认识/模糊：建立 dayLoop
  -> 认识/熟知：完成计划项并离开当天队列
```

### 当天再次出现

```text
当前计划词已在今天评分
  -> 不调用 rateWord
  -> 不认识/模糊：重置当日循环时间、卡片间隔、优先级和剩余次数
  -> 认识/熟知：清空 dayLoop，完成计划项
```

维护时最重要的断言：日内再次评分前后，`stability`、`difficulty`、`due`、`interval`、`reviewCount`、`lastReviewedAt`、`lapseCount` 必须保持不变。

### 每日计划生命周期

1. 首次读取当天状态时执行 `ensureDailyPlan()`。
2. 先加入所有到期或逾期复习；它们可以超过每日目标。
3. 用 `每日目标 - 已加入到期复习数` 计算自动新词空间。
4. 若昨日首次评分的不确定率达到 35%，自动新词空间减半。
5. 按词面排序加入自动新词；手动选择可替换自动项，但不可挤掉复习项。
6. 未完成计划跨天仍保留；日内循环只在当天有效。

## 外部能力与失败策略

### 查词和音频

- `Alt+W` 打开查词：当前词本命中优先，未命中再请求 DictionaryAPI。
- 在线词典可提供音标、英文释义、例句和 MP3 地址；网络失败应展示可理解的错误，不应破坏本地词库。
- 自动发音和音量存于设置。音频不可用时应静默失败或走已有回退，不能阻断评分。

### 导入与在线词书

- 导入支持 txt、csv、xlsx；解析逻辑集中在 `word-import.js`。
- 在线词书下载进度经 `online-books:progress` 推送给主窗口。
- 导入重复单词时保留原有学习数据，只补充缺失释义并附加词本归属。

## 测试和回归清单

当前仓库没有正式的 `npm test` 脚本；v44-v46 的调度验证使用临时 SQLite 场景和语法检查完成。后续若继续开发，优先把下面四项固化为 Node 测试文件：

1. 首次“模糊”后，同日“认识”不改变长期字段。
2. 手动回顾的所有评分不改变任何调度字段或计划项。
3. 每日目标 50、到期词 60 时，复习计划为 60，新词为 0。
4. 自动新词满额时，手动新词能替换自动新词，且复习项不变。

每次修改后至少执行：

```powershell
node --check src/store.js
node --check src/scheduler.js
node --check src/main.js
node --check src/app.js
node --check src/strip.js
npm run dist
```

## 已知限制和修改风险

- `wordDifficulty` 是本地稳定估算，不是墨墨的全局词频难度数据；替换为真实词频时必须保持旧词的值不变，避免历史间隔突然跳变。
- `dailyNew` 是历史字段名，但 v44 已把它当作“每日总负载参考”。不要只改界面文案而遗漏计划计算。
- `learning` 状态仍来自 FSRS；“当天短循环”要以 `dayLoop*` 判断，不能单靠 `status === 'learning'`。
- `setCurrentWord()` 是手动预览入口。把它改回自动加计划会破坏手动回顾不计入调度的约束。
- 改 `productName` 或 `appId` 可能改变 Electron 用户数据位置；迁移前必须先复制 SQLite 和 `.bak`。

## 调度规则（v44）

### 长期记忆

- 每个词保留 FSRS 长期字段：`stability`、`difficulty`、`due`、`interval`、`reviewCount`、`lastReviewedAt`。
- `wordDifficulty` 是创建单词时固定的静态难度；当前没有外部词频库，因此它由单词长度和形态做稳定估算。
- `userMemoryCoeff` 根据近期首次评分的正确情况缓慢调整，范围为 `0.7` 到 `1.3`。
- 仅当 `longTermRatingDate !== 今天` 时，`store.rate()` 才调用 `rateWord()` 更新长期字段。

### 当日短循环

- 不认识：3 分钟后并至少间隔 2 张卡再出现，默认需要 3 次当日重现机会。
- 模糊：5 分钟后并至少间隔 1 张卡再出现，默认需要 2 次当日重现机会。
- 同日第二次及以后评分只更新 `dayLoop*` 字段，绝不能改 `stability`、`due`、`reviewCount` 等长期字段。
- 认识或熟知会移出当天循环并完成对应的今日计划项。

### 今日计划

- 所有到期或逾期复习都进入当天计划，不受每日目标截断。
- 每日目标是总负载参考；到期复习占用后，剩余容量自动加入新词。
- 昨日不确定率高时，自动新词配额减半。
- 手动/随机加入新词时，优先把同一自动计划项改为手动；若满额，则替换自动新词，绝不替换到期复习。

### 手动回顾

- 从词库点击“切换到这个单词”会设置 `manualPreviewId`。
- 手动回顾的任何评分都不更新长期字段、当日循环或计划完成状态。

## 数据与备份（重要）

v46 起运行时主数据优先读取项目/程序根目录：

```text
开发环境：D:\project\moyvword\data\moyu-vocab.sqlite
打包 EXE 位于 dist/release 时：D:\project\moyvword\data\moyu-vocab.sqlite
其他便携位置：<EXE 所在目录>\data\moyu-vocab.sqlite
```

C 盘仍保留兜底镜像：

```text
C:\Users\lihao\AppData\Roaming\moyu-vocab-strip\moyu-vocab.sqlite
C:\Users\lihao\AppData\Roaming\moyu-vocab-strip\moyu-vocab.sqlite.bak
```

- 迁移或清理前必须先复制主数据库、`.bak`、C 盘镜像和用户选择的自定义备份目录。
- 主数据库缺失时会从 C 盘镜像或自定义备份目录恢复；两边都存在时默认使用程序目录主库。
- 设置页可选择额外备份目录，保存时会尽量同步一份 `moyu-vocab.sqlite` 到该目录。
- `moyu-vocab-data.json` 是旧数据格式迁移来源，不是当前主数据。
- 缓存、GPUCache、Crashpad、Session Storage 可以不迁移。
- 如果未来改 `productName` 或 `appId`，需要确认 C 盘兜底镜像路径是否也要迁移。

## 构建与发布

```powershell
npm install
npm run dist
```

- 构建配置在 `package.json`。
- 每次发布先按递增版本更新 `build.artifactName`，例如 v44 后发布 v45。
- 产物写入 `dist`；只保留最终 EXE 即可，`dist/win-unpacked` 是可再生成目录。
- `dist` 和 `release` 中版本化 EXE 只保留最新 5 个，避免误用旧包。
- 正在运行的 EXE 可能锁定文件，因此不要覆盖旧版发布包。

## 已验证场景

- 同日“模糊 -> 认识”后，长期 `stability/due/reviewCount` 不改变。
- 从词库手动切换后评分，长期字段不改变。
- 每日目标 50、到期词 60 时，60 个都进入复习计划，新词为 0。
- 自动新词填满时，手动挑选的新词可替换自动新词。
- v46 已通过 `node --check` 与 `npm run dist`。
- v45 修复 SQLite 数据版本持久化，避免关闭自动发音后重启被旧版本迁移逻辑重新开启。
- v45 搜索输入增加防抖和手动新词请求时序保护，大词库下减少 IPC 与全量过滤压力。
- v46 修正 portable EXE 临时解包路径问题：当 EXE 位于 `dist` 或 `release` 时，默认读取项目根目录 `data`，C 盘只作兜底镜像。
- v45 将主数据改为程序目录 `data`，并保留 C 盘镜像与可选自定义备份目录。
- v45 对 UI 状态类保存做延迟写入，关键学习数据仍立即保存。
- v45 修正 `dayLoopRemaining` 递减语义、加固 Electron 窗口/CSP、提示快捷键注册失败，并清理快捷键渲染的 `innerHTML`。

## 迁移到 moyvword 的建议顺序

1. 新建目标目录并复制源码（不带 `node_modules`、`.tmp-*`、`dist/win-unpacked`）。
2. 复制 `package.json`、`package-lock.json`、`assets`、`src`、本文件、README 和必要发布 EXE。
3. 备份运行时 SQLite 与 `.bak`；修改应用数据目录前，先验证新程序能够读取副本。
4. 在新目录执行 `npm install`、语法检查、`npm run dist`。
5. 验证 v44 等价功能和学习数据后，再让用户确认清理旧目录与历史 EXE。

## 不要误删

- `src`、`assets`、`package.json`、`package-lock.json`。
- 当前最终产物 `dist/摸鱼背词横条-v46.exe`。
- 用户 SQLite 数据及其 `.bak`。
- `PROJECT_HANDOFF.md`、`README.md`、`progress.md`、`findings.md`。
