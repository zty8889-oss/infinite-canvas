# AI漫剧工作台 · Infinite Canvas

AI漫剧制作工具，纯前端单文件、零依赖、离线可用。

线上：
- 🎬 分镜模式（故事板）：https://zty8889-oss.github.io/infinite-canvas/
- 🧩 节点模式（工作流）：https://zty8889-oss.github.io/infinite-canvas/node.html

## 🎬 分镜模式 index.html
分镜卡 / 角色卡 / 场景卡 / 便利贴 / 文本 / 图片；自动镜号；导出分镜表 CSV；导出整图 PNG；Prompt 一键复制；图片粘贴。

## 🧩 节点模式 node.html（LibTV 风格）
节点式无限画布工作流：

- 节点类型：📝剧本 · 🧑角色三视图 · 🏞场景 · 🖼图像 · 🎞图生视频 · 🔊配音 · 🔗合成 · ✏️文本 · 📤上传
- 双击画布 / 输入「/」→ 节点菜单
- 端口连线（右侧输出 → 左侧输入），数据自上而下流转
- 选中节点 → 右侧属性面板：参数 / 厂商 / 模型 / 拼接后 Prompt / 运行 / 日志
- ⚙ API 设置：多厂商可插拔（本地模拟 / OpenAI兼容 / 硅基流动 / 火山方舟(即梦·Seedance) / 可灵 / LiblibAI / ComfyUI），Key 仅存本地
- 导出/导入工作流 JSON（不含 Key）

### 厂商适配层
`PROVIDERS` 注册表 + 统一协议：每个厂商实现 `run(ctx)` 或声明 `endpoint/parse`（同步）、`async/pollUrl/pollParse`（异步提交-轮询）。
未配置 Key 时用「本地模拟」可跑通全流程；填 Key 或按示例 `makeHttp({...})` 即可接入新厂商。
