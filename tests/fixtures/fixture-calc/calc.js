/**
 * Simple calculator module.
 * BUG: divide() does not handle division by zero.
 */

function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

function divide(a, b) {
  if (b === 0) {
    throw new Error("Cannot divide by zero");
  }
  return a / b;
}

function average(numbers) {
  if (numbers.length === 0) {
    return NaN;
  }
  const sum = numbers.reduce((acc, n) => acc + n, 0);
  return divide(sum, numbers.length);
}

module.exports = { add, subtract, multiply, divide, average };
