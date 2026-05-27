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
  // BUG: no guard for b === 0, returns Infinity silently
  return a / b;
}

function average(numbers) {
  // BUG: if numbers is empty, divide by zero → NaN
  const sum = numbers.reduce((acc, n) => acc + n, 0);
  return divide(sum, numbers.length);
}

module.exports = { add, subtract, multiply, divide, average };
