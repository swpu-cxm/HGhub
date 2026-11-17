/** Fork 控制的更新源；鉴权 token 仅经运行时注入，不落库。 */
export const UPDATE_GITHUB_OWNER = "swpu-cxm";
export const UPDATE_GITHUB_REPO = "HGhub";

export type UpdateAuth = { bearerToken?: string };