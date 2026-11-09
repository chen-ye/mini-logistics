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
