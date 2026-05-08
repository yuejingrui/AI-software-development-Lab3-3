"use strict";

// 所有密钥从环境变量读取，严禁在代码中硬编码真实值
// 在 CloudBase 控制台 → 云函数 → 函数配置 → 环境变量 中设置

// glm api 密钥（secret）
const YourSecret = process.env.GLM_SECRET || "";

// glm api key，注意是 id.secret 形式
const YourKeyKey = process.env.GLM_API_KEY || "";

// 高德地图 web 端 api key
const YourJsKey = process.env.AMAP_JS_KEY || "";

// 高德地图 web 端 api 密钥
const YourSecurityJsCode = process.env.AMAP_SECURITY_JS_CODE || "";

// 高德地图 web 服务 api key
const YourWebServiceKey = process.env.AMAP_WEB_SERVICE_KEY || "";

module.exports = {
  YourSecret,
  YourKeyKey,
  YourJsKey,
  YourSecurityJsCode,
  YourWebServiceKey,
};
