declare module "sql.js" {
  export interface SqlValue { }
  export interface Database {
    prepare(sql: string, params?: unknown[]): Statement;
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    run(sql: string, params?: unknown[]): void;
    export(): Uint8Array;
    close(): void;
  }
  export interface Statement {
    step(): boolean;
    getAsObject(params?: unknown[]): Record<string, unknown>;
    run(params?: unknown[]): void;
    bind(params?: unknown[]): void;
    free(): boolean;
  }
  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | ArrayBuffer | number[]) => Database;
  }
  type InitConfig = { locateFile?: (file: string) => string };
  const initSqlJs: (config?: InitConfig) => Promise<SqlJsStatic>;
  export default initSqlJs;
}
