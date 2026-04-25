# Lab3-2

## 目录结构

- `.vscode/settings.json`：让编辑器使用 `frontend` 里安装的 TypeScript，避免出现 “Cannot find module 'vue'” 等假报错
- `backend/`：后端 FastAPI
- `frontend/`：前端 Vue3
- `start_backend.ps1`：启动后端（Windows PowerShell）
- `start_frontend.ps1`：启动前端（Windows PowerShell）

## 后端（FastAPI）

### 已创建的文件

- `backend/requirements.txt`：Python 依赖
- `backend/app/main.py`：FastAPI 应用入口（包含 CORS、异常处理、`/health`）
- `backend/app/response.py`：统一响应结构 `ApiResponse { code, message, data }`
- `backend/app/errors.py`：错误码与 `AppError`
- `backend/app/db.py`：SQLite 数据库初始化与连接（默认 `backend/data/app.db`）



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
- `frontend/index.html`：入口 HTML
- `frontend/src/main.ts`：前端入口
- `frontend/src/router.ts`：路由（默认 `/` 指向健康检查页）
- `frontend/src/lib/api.ts`：API 请求封装（统一解析 `{code,message,data}`，错误写入全局提示）
- `frontend/src/stores/error.ts`：全局错误状态
- `frontend/src/views/HealthView.vue`：请求 `GET /health` 并展示状态
- `frontend/src/App.vue`：全局错误提示 + `router-view`

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