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
  return a / b;
}

function average(numbers) {
  const sum = numbers.reduce((acc, n) => acc + n, 0);
  return divide(sum, numbers.length);
}

module.exports = { add, subtract, multiply, divide, average };
