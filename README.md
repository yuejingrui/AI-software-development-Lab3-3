# Lab3-3 — 智能出行规划器（CloudBase 全栈部署）

> **公网访问地址**：`https://lab3-3-d5gdcm7qo10ced8af-1427379735.tcloudbaseapp.com`

## 项目简介

智能出行规划器是一个前后端分离的 Web 应用，支持用户创建出行规划、在地图上选择地点、编排多日行程时段、查看天气与风险提示，并通过 AI（DeepSeek-V4-Flash）生成旅行建议。

本项目是 Lab 3-2 的云端迁移版本，后端已从 Python FastAPI 重构为 Node.js 云函数，部署于腾讯云 CloudBase。

## 主要功能

| 模块 | 说明 |
| --- | --- |
| 规划管理 | 创建、编辑、删除、列表查看出行规划（日期/预算/人数/偏好），支持排序（名称/时间正序倒序）与置顶 |
| 地点管理 | 高德地图选点、关键词搜索、逆地理编码、地点增删改 |
| 多日行程 | 多天编排，每天可设多个时段（含自定义时间），时段间重叠校验 |
| 天气查询 | 实时天气 + 多日预报，按地点自动匹配行政区 |
| 风险检查 | 基于规划日期与天气预报判断雨雪户外风险 |
| 日路线规划 | 地点间步行/驾车/公交路径计算与耗时估算 |
| AI 辅助总结 | 聚合地点、天气、预算、时段信息，调用 DeepSeek-V4-Flash + DuckDuckGo 联网检索生成建议 |

## 目录结构

```text
Lab3-3/
├── frontend/                          # Vue 3 + TypeScript 前端
│   ├── src/
│   │   ├── views/                     # 页面组件
│   │   │   ├── HealthView.vue         #   健康检查页
│   │   │   ├── PlansListView.vue      #   规划列表页
│   │   │   ├── PlanCreateView.vue     #   新建规划页（含地图选点）
│   │   │   └── PlanDetailView.vue     #   规划详情页（编辑、行程、AI）
│   │   ├── components/                # 复用组件
│   │   │   ├── PlanForm.vue           #   规划表单
│   │   │   ├── AiSummaryPanel.vue     #   AI 建议面板
│   │   │   └── WeatherSidebar.vue     #   天气信息侧栏
│   │   ├── lib/                       # 工具库
│   │   │   ├── api.ts                 #   API 请求封装（统一 code/message/data 解析）
│   │   │   ├── amap.ts                #   高德地图 SDK 加载与封装
│   │   │   ├── weather.ts             #   天气数据整理
│   │   │   └── risk.ts                #   风险判断逻辑
│   │   ├── stores/error.ts            # 全局错误状态
│   │   ├── types/                     # TypeScript 类型定义
│   │   │   ├── api.ts                 #   API 响应泛型
│   │   │   ├── plan.ts / place.ts     #   规划与地点类型
│   │   │   ├── itinerary.ts           #   行程时段类型
│   │   │   ├── weather.ts / risk.ts   #   天气与风险类型
│   │   │   └── amap.d.ts              #   高德地图全局类型声明
│   │   ├── router.ts                  # 前端路由
│   │   ├── main.ts                    # 应用入口
│   │   └── App.vue                    # 根组件（全局错误条 + router-view）
│   ├── index.html
│   ├── vite.config.ts                 # Vite 配置（含 /api 代理）
│   └── package.json
├── cloudfunctions/                    # CloudBase 云函数
│   ├── api-http/                      #   HTTP 云函数（主函数，生产使用）
│   │   ├── index.js                   #     路由分发 + HTTP 服务入口（支持 SSE 流式）
│   │   ├── store.js                   #     CloudBase 文档数据库访问层
│   │   ├── db.js                      #     SQLite 内存快照 + CloudBase 云存储备份（遗留）
│   │   ├── utils.js                   #     业务逻辑（地图/天气/AI/路径/风险/校验）
│   │   ├── response.js                #     统一响应格式（CORS 由网关注入）
│   │   ├── errors.js                  #     错误码枚举 + AppError 类
│   │   ├── secrets.js                 #     环境变量读取（密钥不进代码）
│   │   ├── scf_bootstrap              #     HTTP 服务启动引导
│   │   └── package.json
│   └── api/                           #   SCF 事件函数（旧版，已弃用保留备查）
│       └── ...                        #     结构与 api-http 基本一致
├── cloudbaserc.json                   # CloudBase 项目配置
├── .env.example                       # 环境变量模板
├── .gitignore
└── IMPLEMENTATION_PLAN.md             # 实验任务计划
```

## API 接口一览

所有接口统一响应格式：`{ code: 0, message: "OK", data: ... }`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（含数据库连通性） |
| GET | `/plans` | 规划列表 |
| POST | `/plans` | 创建规划 |
| GET | `/plans/:id` | 获取规划详情 |
| PUT | `/plans/:id` | 更新规划 |
| DELETE | `/plans/:id` | 删除规划（级联删除关联数据） |
| PUT | `/plans/:id/pin` | 切换规划置顶状态 |
| GET | `/plans/:id/places` | 获取规划下所有地点 |
| POST | `/plans/:id/places` | 向规划添加地点 |
| GET | `/places` | 全部地点列表 |
| GET | `/places/:id` | 获取单个地点 |
| PUT | `/places/:id` | 更新地点 |
| DELETE | `/places/:id` | 删除地点 |
| GET | `/plans/:id/risk-check` | 天气风险检查（含缓存） |
| GET | `/plans/:id/itinerary` | 获取行程安排 |
| PUT | `/plans/:id/itinerary` | 更新行程安排（含时段校验） |
| GET | `/plans/:id/itinerary/day-route` | 获取指定天的路线（含地点间路径） |
| POST | `/plans/:id/ai-summary` | 生成 AI 旅行建议 |
| GET | `/map/config` | 获取高德地图 Web 端配置 |
| GET | `/map/search` | 关键词地点搜索 |
| GET | `/map/reverse-geocode` | 逆地理编码（坐标→地址） |
| GET | `/map/nearby-poi` | 周边 POI 查询 |
| GET | `/weather/by-location` | 按坐标查询天气（实时 + 预报） |

## 数据库表结构

| 表 | 说明 |
| --- | --- |
| `plans` | 规划主表（标题、日期、预算、人数、偏好、置顶标记、时间戳） |
| `places` | 地点表（名称、地址、经纬度，外键关联 plan_id） |
| `itinerary_slots` | 行程时段表（天数、标签、起止分钟、排序、备注） |
| `itinerary_slot_places` | 时段-地点关联表（多对多，含排序） |
| `risk_check_cache` | 风险检查缓存表 |

数据库采用双层存储架构：[store.js](cloudfunctions/api-http/store.js) 提供 CloudBase 文档数据库的持久化读写，[db.js](cloudfunctions/api-http/db.js) 保留 SQLite 内存快照 + 云存储备份用于写后读一致性和灾难恢复。两套存储通过统一的 API 层对外暴露，上层业务无感知。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端框架 | Vue 3 + Composition API |
| 前端语言 | TypeScript |
| 构建工具 | Vite 6 |
| 地图 SDK | 高德地图 JS API 2.0 |
| 后端运行时 | Node.js 18.15（CloudBase 云函数） |
| 数据库 | CloudBase 文档数据库（共享持久化） |
| AI 模型 | DeepSeek-V4-Flash |
| 联网检索 | DuckDuckGo Instant Answer API |
| 部署平台 | 腾讯云 CloudBase（云函数 + 静态托管） |

## 使用方式

### 线上访问（推荐）

直接打开：`https://lab3-3-d5gdcm7qo10ced8af-1427379735.tcloudbaseapp.com`

### 本地开发

1. 安装依赖：

   ```bash
   cd frontend && npm install
   cd ../cloudfunctions/api-http && npm install
   cd ../cloudfunctions/api && npm install
   ```

2. 配置环境变量（复制 `.env.example` 为 `.env`，填入真实密钥）：
   - `DEEPSEEK_API_KEY` — DeepSeek AI 密钥
   - `AMAP_JS_KEY` / `AMAP_SECURITY_JS_CODE` — 高德地图 Web 端 Key
   - `AMAP_WEB_SERVICE_KEY` — 高德地图 Web 服务 Key

3. 启动前端开发服务器：

   ```bash
   cd frontend && npm run dev
   ```

   前端默认访问：`http://127.0.0.1:5173`

4. 本地开发时，前端通过 `VITE_API_BASE_URL` 环境变量指向云函数公网地址（见 `frontend/.env.production`）。

### 部署到 CloudBase

```bash
# 构建前端
cd frontend && npm run build

# 部署 HTTP 云函数（主函数）
tcb fn deploy api-http

# 部署静态托管
tcb hosting deploy frontend/dist -e lab3-3-d5gdcm7qo10ced8af
```

## 云函数调用查看

### CloudBase 控制台（推荐）

1. 进入 [CloudBase 控制台](https://console.cloud.tencent.com/tcb) → 选择环境 `lab3-3-d5gdcm7qo10ced8af`
2. 左侧菜单 **云函数** → 点击函数名 `api-http` → **日志** 标签页
3. 可按时间范围、调用状态（成功/失败）筛选，支持关键词搜索
4. **监控** 标签页可查看调用次数、错误率、平均耗时等指标

### CloudBase CLI

```bash
# 查看 api-http 云函数最近日志
tcb fn log api-http --limit 20

# 查看最近 1 小时的日志
tcb fn log api-http --start-time "1 hour ago" --limit 50

# 实时监听日志（类似 tail -f）
tcb fn log api-http --follow
```

### HTTP 访问服务日志

`api-http` 作为 HTTP 云函数，其请求日志也可在 **CloudBase 控制台 → HTTP 访问服务 → 访问日志** 中查看，包含请求路径、状态码、耗时等信息。

## 环境变量

所有密钥均通过环境变量注入，云端在 CloudBase 控制台 → 云函数 → 函数配置 → 环境变量中配置。详见 `.env.example`。

## 页面路由

| 路径 | 页面 |
| --- | --- |
| `/` | 重定向到 `/plans/new` |
| `/plans` | 规划列表 |
| `/plans/new` | 新建规划 |
| `/plans/:id` | 规划详情（编辑、行程、AI 总结） |
| `/health` | 健康检查 |

## 安全措施

- 所有第三方 API Key 仅存在于后端环境变量，前端不暴露
- CORS 已收紧至静态托管域名（非 `*`）
- `.env` / `.env.local` 已加入 `.gitignore`，仓库仅有 `.env.example` 模板
- 高德地图 Web 端 Key 已在控制台配置域名白名单

## Git 提交链

```text
feat(api): add HTTP cloud function for true SSE streaming and collapsible AI replies
fix(ai): stabilize incremental reply rendering in summary panel
fix(api): migrate AI backend from GLM to DeepSeek and fix timezone display
feat(plan): add delete, sort, and pin functionality in plan list view
refactor(api): migrate storage from SQLite snapshot to CloudBase document DB
fix: improve write-read consistency and backup reliability
chore(release): finalize v2.1 with comprehensive documentation and UI enhancements
refactor(api): migrate backend from FastAPI to Node.js CloudBase
docs(readme): expand frontend and backend file guide
feat(itinerary): add day-route map and align day count selection UI
```
