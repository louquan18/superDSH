export interface ToolDef {
    name: string;
    description: string;
    parameters: any;
    output: {
        schema: any;
        render: (args: any, value: any) => any[];
    };
    execute: (args: any, exec: any) => Promise<any>;
}
export declare function textContent(value: any): any[];
export declare function objectOutput(): any;
export declare function defineTool(input: {
    name: string;
    description: string;
    parameters: any;
    execute: (args: any, exec: any) => Promise<any>;
}): ToolDef;
export declare const STRING_ARRAY: {
    readonly type: "array";
    readonly items: {
        readonly type: "string";
    };
};
