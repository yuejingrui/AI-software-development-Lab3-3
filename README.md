# Lab3-2

## 目录结构

- `backend/`：后端 FastAPI 服务，负责规划、地点、时段行程、地图与天气接口
- `frontend/`：前端 Vue 3 单页应用，负责规划创建、详情编辑、地图展示与行程可视化
- `start_backend.ps1`：启动后端（Windows PowerShell）
- `start_frontend.ps1`：启动前端（Windows PowerShell）
- `step*.md`：各阶段任务记录与实现说明
- `.vscode/settings.json`：让编辑器使用 `frontend` 里的 TypeScript，避免出现 “Cannot find module 'vue'” 等假报错

## 后端（FastAPI）

### 已创建的文件

- `backend/requirements.txt`：Python 依赖，包含 FastAPI、Uvicorn、Pydantic 等运行所需包
- `backend/app/main.py`：FastAPI 应用入口，集中定义路由、请求/响应模型、异常处理、CORS、行程与地图相关接口
- `backend/app/db.py`：SQLite 数据库初始化与连接管理，负责创建规划、地点、时段、时段地点关联等表
- `backend/app/errors.py`：错误码、`AppError` 和后端统一错误处理基础
- `backend/app/response.py`：统一响应结构 `ApiResponse { code, message, data }` 与 `ok()` 封装
- `backend/app/ai.py`：AI 文本生成相关逻辑，封装摘要生成所需的调用与降级处理
- `backend/data/`：SQLite 数据文件目录，首次启动后会生成实际数据库文件



### 启动方式

进入目录，在仓库根目录执行：

```powershell
.\start_backend.ps1
```

后端默认监听：`http://127.0.0.1:8000`

### 健康检查接口

- `GET /health`
- 响应示例：

```json
{"code":0,"message":"OK","data":{"status":"ok","db":"ok"}}
```

### 可选环境变量

- `APP_DB_PATH`：自定义 SQLite 数据库文件路径（默认 `backend/data/app.db`）

## 前端（Vue3）

### 已创建的文件

- `frontend/package.json`：前端依赖与脚本（`dev`/`build`/`typecheck`）
- `frontend/vite.config.ts`：Vite 配置（默认端口 5173）
- `frontend/tsconfig.json`、`frontend/env.d.ts`：TypeScript 配置与环境变量声明
- `frontend/index.html`：SPA 入口 HTML
- `frontend/src/main.ts`：Vue 应用入口，挂载路由与根组件
- `frontend/src/router.ts`：前端路由配置，管理首页、列表页、新建页、详情页与健康检查页
- `frontend/src/App.vue`：应用壳层，承载全局错误提示与 `router-view`
- `frontend/src/components/PlanForm.vue`：规划表单组件，复用在创建与修改页面
- `frontend/src/components/AiSummaryPanel.vue`：AI 摘要面板，展示规划分析结果
- `frontend/src/components/WeatherSidebar.vue`：天气侧栏，展示天气与风险提示，并支持联动地图地点显示
- `frontend/src/views/HealthView.vue`：健康检查页，调用 `GET /health` 并展示后端状态
- `frontend/src/views/PlanCreateView.vue`：新建规划页，负责创建规划、添加地点与初始化地图选点
- `frontend/src/views/PlanDetailView.vue`：规划详情页，负责修改规划、管理地点、编辑时段行程、显示当日路线与 AI/天气联动
- `frontend/src/views/PlansListView.vue`：规划列表页，展示已保存规划并跳转详情
- `frontend/src/lib/api.ts`：API 请求封装，统一解析后端 `{code,message,data}` 响应格式并处理错误
- `frontend/src/lib/amap.ts`：高德地图 SDK 加载、地图配置拉取、地理编码/逆地理编码/附近地点查询
- `frontend/src/lib/weather.ts`：天气数据读取与整理相关工具
- `frontend/src/lib/risk.ts`：风险判断与提示文本相关逻辑
- `frontend/src/stores/error.ts`：全局错误状态
- `frontend/src/types/plan.ts`、`frontend/src/types/place.ts`、`frontend/src/types/itinerary.ts`、`frontend/src/types/weather.ts`、`frontend/src/types/risk.ts`、`frontend/src/types/api.ts`：前后端共享的数据类型定义
- `frontend/src/types/amap.d.ts`：高德地图全局对象类型声明
- `frontend/src/config/`：前端运行时配置目录（如有扩展配置可放这里）

### 启动方式

在仓库根目录执行：

```powershell
.\start_frontend.ps1
```

前端默认访问：`http://127.0.0.1:5173`

### 可选环境变量

- `VITE_API_BASE_URL`：后端地址（默认 `http://127.0.0.1:8000`）
  
## 如何正常打开（完整启动步骤）

不要直接双击打开 `frontend/index.html`，应先启动开发服务器再访问页面。

1. 打开 PowerShell，进入项目根目录：`d:\FuDan\生成式软件开发\Lab3-2`
2. 启动后端（保持窗口不要关闭）：

```powershell
.\start_backend.ps1
```

看到 `Uvicorn running on http://127.0.0.1:8000` 表示后端启动成功。

3. 再打开一个新的 PowerShell 窗口启动前端（保持窗口不要关闭）：

```powershell
.\start_frontend.ps1
```

看到 `Local: http://127.0.0.1:5173/` 表示前端启动成功。

4. 用浏览器打开：`http://127.0.0.1:5173/`

验证点：

- 浏览器直接访问 `http://127.0.0.1:8000/health` 应能看到一段 JSON
- 前端页面应显示“健康检查”，并展示 `status/db` 为 `ok`