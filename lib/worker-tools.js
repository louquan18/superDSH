import { defineTool, STRING_ARRAY } from './tools.js';
import { planScopeSchema } from './butler-tools.js';
export function createWorkerTools(service, agent) {
    const reportStatus = defineTool({
        name: 'butler_report_status',
        description: 'Report your current task state to the SuperAgent butler. Call at the start, at major milestones, before ending a turn, when blocked, and when you need a user decision. Keep it short and factual. This is not a request to the user; the butler reads it and surfaces progress.',
        parameters: {
            type: 'object',
            properties: {
                goal: { type: 'string', description: 'Current goal in one sentence.' },
                done: { ...STRING_ARRAY, description: 'Completed work items.' },
                next: { ...STRING_ARRAY, description: 'Next planned steps.' },
                blockers: { ...STRING_ARRAY, description: 'What is blocking you, if anything.' },
                decisions: { ...STRING_ARRAY, description: 'Decisions that need the user.' },
            },
            required: ['goal'],
            additionalProperties: false,
        },
        async execute(args, exec) {
            if (String(exec?.agent?.id ?? '') !== String(agent.id)) {
                return { ok: false, error: 'wrong agent for this tool' };
            }
            return service.noteReport(exec.agent, args);
        },
    });
    const submitPlan = defineTool({
        name: 'butler_submit_plan',
        description: 'Submit a plan for the current butler-dispatched task in a plan-review project. Include a complete markdown plan and a structured scope (paths/commands). The plan must be approved before mutating tools are allowed. Use only when the task was dispatched by the butler (marked 【管家派发】); otherwise this returns not_required.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                plan: { type: 'string', description: 'Complete markdown plan.' },
                scope: planScopeSchema(),
            },
            required: ['title', 'plan', 'scope'],
            additionalProperties: false,
        },
        async execute(args, exec) {
            if (String(exec?.agent?.id ?? '') !== String(agent.id)) {
                return { status: 'error', error: 'wrong agent for this tool' };
            }
            return service.submitPlan(exec.agent, args);
        },
    });
    return { reportStatus, submitPlan };
}
