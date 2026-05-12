/**
 * Fixture file for AST locator tests.
 * DO NOT MODIFY — line numbers are hardcoded in tests.
 *
 * Symbol map (1-indexed):
 *   greet          → function declaration, line 14
 *   Calculator     → class declaration,    line 20
 *   Calculator.add → method,               line 22
 *   Calculator.sub → private method,       line 27
 *   multiply       → const arrow function, line 33
 *   fetchData      → async function,       line 37
 */

// line 14: named function declaration
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

// line 20: class declaration
export class Calculator {
  // line 22: public method
  add(a: number, b: number): number {
    return a + b;
  }

  // line 27: private method
  private sub(a: number, b: number): number {
    return a - b;
  }
}

// line 33: const arrow function
export const multiply = (a: number, b: number): number => a * b;

// line 37: async function
export async function fetchData(url: string): Promise<string> {
  return url;
}
