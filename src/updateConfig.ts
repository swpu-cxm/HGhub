/** Fork 控制的更新源。 */
export const UPDATE_GITHUB_OWNER = "swpu-cxm";
export const UPDATE_GITHUB_REPO = "HGhub";

/**
 * 私有仓库更新鉴权：仅在当前进程内由用户主动提供（例如设置页粘贴 PAT），
 * 不写入构建产物、localStorage 或 APK。
 */
export type UpdateAuth = { bearerToken?: string };