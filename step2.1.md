### 阶段 2：地点管理闭环
两个明显错误：
1、在填入正确api后，无法正常使用功能，浏览器控制台显示
Unsafe attempt to load URL http://127.0.0.1:5173/ from frame with URL chrome-error://chromewebdata/. Domains, protocols and ports must match.
2、严重问题：你把api的配置放在了前端，而实际上要求你放在后端，前端访问时请求api