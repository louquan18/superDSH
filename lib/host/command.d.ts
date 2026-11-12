import type { SuperagentService } from '../service.js';
/**
 * `/superagent …`：给不想开面板时用的命令行入口。
 * handler 直接拿到 agent 与 rawInput；结果只回到本次命令输出，不写 session 事件。
 */
export declare function registerCommand(ctx: any, service: SuperagentService): void;
