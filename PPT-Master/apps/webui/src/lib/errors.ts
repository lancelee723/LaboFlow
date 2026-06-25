/** Structured error types from the backend's ErrorCode enum. */
export type ErrorCode = string

export interface ApiError {
  code: ErrorCode
  detail: string
  params?: Record<string, unknown>
}

/** Chinese error messages keyed by ErrorCode. */
export const zhErrors: Record<string, string> = {
  AUTH_INVALID_CREDENTIALS: "邮箱或密码错误",
  AUTH_TOKEN_EXPIRED: "登录已过期，请重新登录",
  AUTH_USER_NOT_FOUND: "用户不存在",
  AUTH_SSO_PASSWORD_NOT_AVAILABLE: "SSO 用户不支持修改密码",
  AUTH_WRONG_PASSWORD: "当前密码不正确",
  PROJECT_NOT_FOUND: "项目不存在",
  FILE_UNSUPPORTED_TYPE: "不支持的文件类型",
  FILE_TOO_LARGE: "文件过大（{{size_mb}}MB，上限 {{max_mb}}MB）",
  PPTX_NOT_FOUND: "PPTX 未找到，请先运行生成流程",
  SOURCE_NOT_FOUND: "源文件不存在",
  SOURCE_AMBIGUOUS: "请提供文件上传或 URL，不能同时提供两者",
  SESSION_NOT_FOUND: "会话不存在",
  SESSION_NOT_RESUMABLE: "会话不在等待输入状态",
  PIPELINE_CANCELLED: "生成流程已取消",
  LLM_NO_PROVIDER: "未配置 LLM 供应商，请在设置中添加",
  LLM_CONFIG_NOT_FOUND: "LLM 配置不存在",
  INVALID_INPUT: "输入无效",
  VALIDATION_ERROR: "数据校验失败",
  INTERNAL_ERROR: "服务器内部错误",
}

/** English error messages keyed by ErrorCode. */
export const enErrors: Record<string, string> = {
  AUTH_INVALID_CREDENTIALS: "Invalid email or password",
  AUTH_TOKEN_EXPIRED: "Session expired, please log in again",
  AUTH_USER_NOT_FOUND: "User not found",
  AUTH_SSO_PASSWORD_NOT_AVAILABLE: "Password change not available for SSO users",
  AUTH_WRONG_PASSWORD: "Current password is incorrect",
  PROJECT_NOT_FOUND: "Project not found",
  FILE_UNSUPPORTED_TYPE: "Unsupported file type",
  FILE_TOO_LARGE: "File too large ({{size_mb}}MB, max {{max_mb}}MB)",
  PPTX_NOT_FOUND: "PPTX not found. Run the pipeline first.",
  SOURCE_NOT_FOUND: "Source not found",
  SOURCE_AMBIGUOUS: "Provide exactly one of: file upload or URL",
  SESSION_NOT_FOUND: "Session not found",
  SESSION_NOT_RESUMABLE: "Session is not waiting for input",
  PIPELINE_CANCELLED: "Pipeline cancelled",
  LLM_NO_PROVIDER: "No LLM provider configured. Add one in Settings.",
  LLM_CONFIG_NOT_FOUND: "LLM config not found",
  INVALID_INPUT: "Invalid input",
  VALIDATION_ERROR: "Validation failed",
  INTERNAL_ERROR: "Internal server error",
}

/**
 * Translate an API error to a user-facing message.
 * Uses the current locale from localStorage, falls back to English.
 */
export function translateError(apiError: ApiError): string {
  const locale = getCurrentLocale()
  const map = locale === "zh" ? zhErrors : enErrors
  let message = map[apiError.code] ?? apiError.detail ?? "Unknown error"

  // Interpolate params
  if (apiError.params) {
    for (const [key, value] of Object.entries(apiError.params)) {
      message = message.replace(`{{${key}}}`, String(value))
    }
  }
  return message
}

function getCurrentLocale(): string {
  try {
    const cached = localStorage.getItem("i18n-locale")
    if (cached === "zh" || cached === "en") return cached
  } catch {
    // localStorage unavailable
  }
  return "en"
}
