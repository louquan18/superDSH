import { stripUndefined } from './util.js'

export interface ToolDef {
  name: string
  description: string
  parameters: any
  output: {
    schema: any
    render: (args: any, value: any) => any[]
  }
  execute: (args: any, exec: any) => Promise<any>
}

export function textContent(value: any): any[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 0)
  return [{ type: 'text', text: text ?? '' }]
}

export function objectOutput(): any {
  return {
    type: 'object',
    additionalProperties: true,
  }
}

export function defineTool(input: {
  name: string
  description: string
  parameters: any
  execute: (args: any, exec: any) => Promise<any>
}): ToolDef {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    output: {
      schema: objectOutput(),
      render: (_args, value) => textContent(value),
    },
    // 单点兜底：任何工具都不许把显式 undefined 交给 dsh 的输出校验。
    execute: async (args, exec) => stripUndefined(await input.execute(args, exec)),
  }
}

export const STRING_ARRAY = {
  type: 'array',
  items: { type: 'string' },
} as const
