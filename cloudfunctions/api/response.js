"use strict";

const { ErrorCode } = require("./errors");

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "https://lab3-3-d5gdcm7qo10ced8af-1427379735.tcloudbaseapp.com",
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

module.exports = { corsHeaders, apiResponse, ok, errorResponse };
