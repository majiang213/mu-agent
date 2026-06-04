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
  if (b === 0) throw new Error('Division by zero');
  return a / b;
}

function average(numbers) {
  if (numbers.length === 0) throw new Error('Cannot average empty array');
  const sum = numbers.reduce((acc, n) => acc + n, 0);
  return divide(sum, numbers.length);
}

module.exports = { add, subtract, multiply, divide, average };
