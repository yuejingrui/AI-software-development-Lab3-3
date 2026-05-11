"use strict";

const { ErrorCode } = require("./errors");

const ALLOWED_ORIGINS = [
  "https://lab3-3-d5gdcm7qo10ced8af-1427379735.tcloudbaseapp.com",
];

function resolveAllowOrigin(requestOrigin) {
  if (!requestOrigin) {
    // No Origin header — return first allowed origin as default (for same-origin requests)
    return ALLOWED_ORIGINS[0] || "";
  }
  // Allow localhost for development
  if (
    requestOrigin.startsWith("http://localhost:") ||
    requestOrigin.startsWith("http://127.0.0.1:")
  ) {
    return requestOrigin;
  }
  // Allow known production origins
  if (ALLOWED_ORIGINS.includes(requestOrigin)) {
    return requestOrigin;
  }
  // Fallback to first allowed origin (for tools like curl without proper Origin)
  return ALLOWED_ORIGINS[0] || "";
}

function corsHeaders(requestOrigin) {
  return {
    "Access-Control-Allow-Origin": resolveAllowOrigin(requestOrigin),
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  };
}

function apiResponse(code, message, data = null) {
  return { code, message, data };
}

function ok(data = null, message = "OK") {
  return apiResponse(ErrorCode.OK, message, data);
}

function errorResponse(code, message, data = null) {
  return apiResponse(code, message, data);
}

module.exports = { corsHeaders, resolveAllowOrigin, ALLOWED_ORIGINS, apiResponse, ok, errorResponse };
