

## Lab 3-3：CloudBase 全栈部署实践

### 3.1 实验目标

1. 理解"上云"意味着什么——从本地运行到公网访问
2. 用 CloudBase 静态网站托管 + 云函数替代本地开发服务器
3. 掌握 CloudBase AI ToolKit（MCP）+ Skills 的 AI 原生部署工作流
4. 完成至少一项 CloudBase 相关拓展
5. 形成"本地开发 vs 云端部署"的工程化认识

### 3.3 环境准备

| # | 步骤 | 说明 |
|---|------|------|
| E.1 | 注册 CloudBase 开通免费环境 | 个人版（免费），地域推荐上海 |
| E.2 | 记录环境 ID | 形如 your-env-xxxxxx |
| E.3 | 安装 Node.js 18.15+ | `node --version` |
| E.4 | 安装 CloudBase CLI | `npm install -g @cloudbase/cli` |
| E.5 | 登录 CLI | `tcb login` |
| E.6 | 配置 MCP（`.trae/mcp.json`） | cloudbase MCP server |
| E.7 | 安装 CloudBase Skills | `npx skills add tencentcloudbase/cloudbase-skills -y` |

---

### 阶段一：v2.0 重组结构 + 后端迁移到云函数

**核心目标：** 把 Lab 3-2 的后端逻辑迁移到 CloudBase 云函数，前端能通过公网 URL 调用

| # | 任务 | 详细要求 |
|---|------|----------|
| V2.0.1 | 重组项目结构 | frontend/ + cloudfunctions/ + cloudbaserc.json |
| V2.0.2 | 将 Lab 3-2 后端接口逐一迁移为云函数 | plan/、weather/、chat/ 等 |
| V2.0.3 | 每个云函数处理 CORS 预检（OPTIONS） | 使用 corsHeaders() 模板 |
| V2.0.4 | 配置环境变量（LLM_API_KEY、WEATHER_KEY 等） | 在控制台配置，不写进代码 |
| V2.0.5 | 部署云函数并创建 HTTP 触发器 | 使用 Skills 或 `tcb fn deploy --all` |
| V2.0.6 | 更新前端调用地址 | localhost → 云函数公网 URL |
| V2.0.7 | 本地验证：前端 + 云函数联调通过 | - |

**后端迁移路线选择：**
- **路线 A（推荐入门）：** 用 AI 辅助把 Python 后端改写为 Node.js 云函数
- **路线 B（保留原语言）：** 使用 CloudBase CloudRun 部署 Docker 容器

**Git 提交：** `feat: v2.0 后端迁移至 CloudBase 云函数`

---

### 阶段二：v2.1 前端部署上线 + 安全收紧

**核心目标：** 前端发布到静态托管，得到公网 URL，完成安全加固

| # | 任务 | 详细要求 |
|---|------|----------|
| V2.1.1 | 构建前端（如 Vue/React 需 `npm run build`） | 输出 dist/ 目录 |
| V2.1.2 | 部署前端到静态托管 | 使用 Skills 或 `tcb hosting deploy` |
| V2.1.3 | 获取静态托管 URL | 格式 `https://your-env-xxxxxx.tcloudbaseapp.com` |
| V2.1.4 | 收紧 CORS | `*` → 静态托管域名 |
| V2.1.5 | 高德地图 Key 白名单 | 添加静态托管域名 |
| V2.1.6 | 手机端验证 | 新建规划→选点→查天气→保存 全流程截图 |
| V2.1.7 | 资源监控截图 | 云函数调用次数、静态托管流量 |

**安全检查清单（必须逐项打勾并附证据）：**
- [ ] git 仓库搜索无真实 Key（sk-、Bearer、apikey、KEY=）
- [ ] .env、.env.local 已加入 .gitignore，仓库只有 .env.example
- [ ] 前端代码只剩高德 JS API 的 Web 端 Key，控制台已配域名白名单
- [ ] 所有云函数 CORS 已收紧到静态托管域名
- [ ] 云函数环境变量在控制台配置，未硬编码

**Git 提交：** `feat: v2.1 前端部署至 CloudBase 静态托管，全链路上线`

---

### 阶段三：v2.2 自主拓展（至少 1 项）

**核心目标：** 利用 CloudBase 能力做拓展，深化对云原生能力的理解

| 方向 | 难度 | 说明 |
|------|------|------|
| 云数据库持久化 | 中 | 把规划数据迁移到 CloudBase 云数据库（NoSQL） |
| 内置大模型 | 易 | AI 总结改用 CloudBase 内置 DeepSeek/Hunyuan |
| 流式 AI 回复 | 中 | 云函数返回 SSE，前端 EventSource 增量渲染 |
| 历史规划列表 | 中 | 跨设备查看历史规划 |
| CI/CD 自动部署 | 中 | GitHub Actions + CloudBase CLI |

**要求：**
- 报告中说明选择原因、设计思路、AI 协作中的关键偏差与修正
- 拓展功能与 v2.1 兼容
- 至少 1 次独立 Git 提交：`feat: v2.2 {拓展简述}`

---

### 3.4 Lab 3-3 交付要求

1. 项目代码（frontend/ + cloudfunctions/ + 配置文件）
2. 公网访问 URL（写在 README 顶部）
3. 手机端访问截图（规划创建 + AI 辅助总结）
4. CloudBase 控制台截图（环境概览、云函数列表、资源监控）
5. MCP 配置（`.trae/mcp.json`）
6. Skills 调用截图（至少 1 张）
7. AI 协作记录（关键 Prompt + AI 回复 + "我手改了什么"标注）
8. 安全检查清单（逐项打勾 + 证据）
9. `git log --oneline` 截图（体现 v2.0 → v2.2 完整提交链）
10. 实验总结（重点回答 4 个问题——见下文）

---

### 3.5 Lab 3-3 实验总结问题

1. 把 Lab 3-2 的后端"搬上云"，遇到的最大阻力是什么？怎么解决的？
2. 与"本地运行后端"相比，CloudBase 云函数有哪些明显的好处？有哪些限制或不方便的地方？
3. Skills/MCP 在本次部署中哪些步骤真正提速了？哪些步骤反而需要你"接管"才能搞定？
4. 阶段三自主拓展时的设计思路，以及 AI 协作中遇到的关键偏差与修正方法

### 3.6 评分标准（100 分）

| 维度 | 占比 | 说明 |
|------|------|------|
| 阶段一：后端迁移至云函数 | 30% | 所有接口正常工作，前端无本地后端依赖，无硬编码 Key |
| 阶段二：前端部署上线 | 30% | 公网 URL 真实可访问，手机端可用，CORS 与安全清单完成 |
| 阶段三：自主拓展 | 15% | 至少 1 项拓展功能，与 v2.1 兼容 |
| Skills/MCP 与标注 | 10% | MCP 配置 + Skills 截图齐全，"AI 生成 vs 手写"标注到位 |
| 版本管理与目录规范 | 5% | 三阶段提交链清晰，目录与命名符合要求 |
| 实验总结 | 10% | 总结具体、有反思 |


## 五、建议的 Git 提交节奏

```

### Lab 3-3 提交链
```
feat: v2.0 后端迁移至 CloudBase 云函数
feat: v2.1 前端部署至 CloudBase 静态托管，全链路上线
feat: v2.2 {自主拓展简述}
```

