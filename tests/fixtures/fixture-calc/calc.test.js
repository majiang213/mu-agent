const { add, subtract, multiply, divide, average } = require('./calc');

describe('Calculator', () => {
  test('add', () => expect(add(2, 3)).toBe(5));
  test('subtract', () => expect(subtract(5, 3)).toBe(2));
  test('multiply', () => expect(multiply(3, 4)).toBe(12));

  test('divide normal', () => expect(divide(10, 2)).toBe(5));
  test('divide by zero should throw', () => {
    expect(() => divide(10, 0)).toThrow();
  });

  test('average of empty array should throw', () => {
    expect(() => average([])).toThrow();
  });

  test('average normal', () => expect(average([1, 2, 3])).toBe(2));
});
