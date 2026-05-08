"use strict";

const { ErrorCode } = require("./errors");

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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

module.exports = { corsHeaders, apiResponse, ok, errorResponse };
