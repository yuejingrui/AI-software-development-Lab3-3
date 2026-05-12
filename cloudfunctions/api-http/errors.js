"use strict";

const ErrorCode = Object.freeze({
  OK: 0,
  UNKNOWN: 1000,
  VALIDATION: 1001,
  HTTP: 1002,
  NOT_FOUND: 1003,
  DB: 2000,
});

class AppError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.code = code;
    this.message = message;
    this.httpStatus = httpStatus;
  }
}

module.exports = { ErrorCode, AppError };
