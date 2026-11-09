declare module "bun:test" {
  export function describe(name: string, fn: () => void | Promise<void>): void;
  export function test(
    name: string,
    fn: () => void | Promise<void>,
    timeout?: number,
  ): void;
  export function it(
    name: string,
    fn: () => void | Promise<void>,
    timeout?: number,
  ): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;

  export interface Matchers<T = any> {
    not: Matchers<T>;
    toBe(expected: any): void;
    toEqual(expected: any): void;
    toStrictEqual(expected: any): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeCloseTo(expected: number, numDigits?: number): void;
    toContain(expected: any): void;
    toHaveLength(expected: number): void;
    toMatch(expected: string | RegExp): void;
    toBeInstanceOf(expected: any): void;
    toThrow(expected?: any): void;
  }

  export function expect<T = any>(actual: T): Matchers<T>;
}

interface ImportMeta {
  readonly url: string;
  readonly dir: string;
  readonly main: boolean;
}

declare var process: {
  readonly argv: string[];
  readonly env: Record<string, string | undefined>;
  cwd(): string;
  stderr: {
    write(chunk: string): boolean;
  };
  stdout: {
    write(chunk: string): boolean;
  };
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: BufferEncoding): string;
  export function writeFileSync(
    path: string,
    data: string,
    encoding?: BufferEncoding,
  ): void;
  export function appendFileSync(
    path: string,
    data: string,
    encoding?: BufferEncoding,
  ): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean },
  ): string | undefined;
  const fsDefault: {
    readFileSync: typeof readFileSync;
    writeFileSync: typeof writeFileSync;
    appendFileSync: typeof appendFileSync;
    existsSync: typeof existsSync;
    mkdirSync: typeof mkdirSync;
  };
  export default fsDefault;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
  export function dirname(p: string): string;
  const pathDefault: {
    resolve: typeof resolve;
    join: typeof join;
    dirname: typeof dirname;
  };
  export default pathDefault;
}

declare module "node:child_process" {
  export function execSync(
    command: string,
    options?: { encoding?: string },
  ): string;
}
