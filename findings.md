# Findings

- 当前项目位于 `D:\software\摸鱼单词免安装版Release\摸鱼单词Release\moyu-vocab-strip`，外层 Git 仓库存在但所有文件未追踪；不初始化或提交。
- 已实现 v28：FSRS 调度、短循环、按词本每日计划、阶段和负债面板。
- 已废弃链路：覆盖 `dist\摸鱼背词横条 0.1.0.exe` 时会被运行中的测试程序锁定；后续一律输出版本化产物名。
- 功能审计确认在线词书已完成（含网络失败的内置词表回退），不作为本轮重复开发目标。
- 适合继续投入的能力是词书生命周期、备份、轻量统计预测、横条展示控制；云同步、题库模式、离线音频和词根百科暂不进入范围。
- 发布后审计修复：词库列表按当前词本过滤；释义改为纯文本渲染；新建词本会清空旧横条词；SQLite 采用临时文件原子写入与 `.bak` 回退；空词库不再复活示例词；横条位置退出时强制落盘。
- v33 UI 审计结论：主窗口保留现有 DOM/ID 和三视图切换，仅更新 `src/app.css`；1024px 以下将 6 项统计改成 3 列以避免 920px 最小窗口拥挤。侧栏导航与当前单词本使用不同的选中语义，保留独立滚动和底部操作区。
- 2026-07-13：`Alt+W` 已绑定 `lookup`，目前只会打开主窗口并把当前横条单词填进词库搜索框；需要扩展为独立搜词工作流。
- 已验证 `https://api.dictionaryapi.dev/api/v2/entries/en/ability` 可返回 200 JSON，含音标、英文释义、例句和 MP3 链接；可作为当前词本无结果时的在线查询来源。
- 2026-07-13 今日回顾口径：入口只在今日计划完成且存在今日完成计划词时可用；回顾队列来自 `completedPlanItemsToday()`，评分只改 `session.todayReview` 队列，不改 FSRS、日内短循环、今日计划或学习统计。
- 2026-07-14 手动回顾返回规则：`session.manualReturnId` 保存进入“上一词/手动回顾”前的当前词；手动回顾的下一步和评分优先返回它，避免普通选词逻辑跳过原词。
- 2026-07-14 历史序列缺口：`previous()` 会弹出历史词；从手动回顾评分/跳过返回 `manualReturnId` 时，`rememberCurrentForPrevious()` 因手动预览保护跳过入栈，造成后续上一词缺失该词。
- 修复策略：只在手动预览返回它的 `manualReturnId` 时允许当前词重新入历史栈；其他手动浏览仍保持不写入历史，避免产生循环。
- v54 打包异常：Electron Builder 三次显示 portable 目标已生成，但产物随后不在 `dist` 或 `release`；只留下完整的 `win-unpacked` 目录，疑似被本机安全软件删除，不能将解包 EXE 冒充便携包发布。
- 2026-07-14 导航根因：`previous()` 设好 currentId 后，`getState → stats → fillLearningWindow` 会因词已不在学习窗口而把 currentId 清空，`currentWord()` 再 chooseNext 回 live，导致评分后上一词/下一词错乱。
- v55 结构：学习调度只推进 `liveWordId`；浏览用 `trail + index`；`mode=history|manual` 时评分默认不改 FSRS，只回到 live。旧 `history/manualPreviewId/manualReturnId` 仍同步写出以兼容。
