import type { SuperagentService } from '../service.js';
/**
 * 管家的三条认证 HTTP 路由（`connection.fetch` 要求 path 以 `/api/` 开头，只有 owner Peer 能访问）：
 *
 * - `GET  /api/superagent/state`  快照
 * - `GET  /api/superagent/events` SSE，只发 invalidate 帧
 * - `POST /api/superagent/action` 面板动作
 *
 * 不用 `ctx.webServer.register`：connection.fetch 自带 owner Peer 鉴权和统一挂载。
 */
export declare function registerRoutes(ctx: any, service: SuperagentService): void;
