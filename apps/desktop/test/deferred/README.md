# 挂起测试（上游 v0.15.10 同步期间移出主套件）

这些测试断言的 fork 功能面在合并中暂时挂起，待 Phase 6 Task 0（fork 能力重挂载）完成后
移回 `test/`（`node --test test/*.test.mjs` 不递归子目录）。移动不删除断言——恢复时它们
就是现成的验收基准。

| 文件 | 挂起原因 |
|---|---|
| expert-mention-dispatch | @专家/@团队 派发：Composer plus 菜单（上游 Composer 模块化版暂无） |
| expert-foreground | 前台专家 persona 注入点（原 index.ts hook 待重挂） |
| org-settings | 设置「组织」tab（settings-search 三 tab 暂删） |
| token-usage-settings | 设置「用量」tab（同上） |
| composer-paste-files / composer-send-state | Composer 会话附加/队列优先级行为（上游 promote 模型对齐后重验） |
| sidebar-footer | 侧栏底部组织按钮 + 通知中心组合 |
| settings-general | settings 导航含 experts/org/usage 三目的地的断言 |
