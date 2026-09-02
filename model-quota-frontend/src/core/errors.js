// 查询失败等业务错误：code 用于区分错误类型，message 面向用户展示。
export class QuotaQueryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QuotaQueryError';
    this.code = code;
  }
}
