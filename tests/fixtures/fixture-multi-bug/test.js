const { add, multiply } = require('./math');

let passed = 0;
let failed = 0;

function test(name, actual, expected) {
  if (actual === expected) {
    console.log(`✓ ${name}`);
    passed++;
  } else {
    console.error(`✗ ${name}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

test('add(2, 3) should be 5', add(2, 3), 5);
test('add(0, 5) should be 5', add(0, 5), 5);
test('add(-1, 1) should be 0', add(-1, 1), 0);
test('multiply(3, 4) should be 12', multiply(3, 4), 12);
test('multiply(2, 5) should be 10', multiply(2, 5), 10);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
