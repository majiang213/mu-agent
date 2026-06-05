#include <iostream>
#include <vector>
#include <stdexcept>
#include <cassert>
#include <climits>
#include <algorithm>

/**
 * Recursive function to find the maximum element in an array.
 *
 * @param arr     The input array (vector)
 * @param index   Current index being considered
 * @return        The maximum element from index to end of array
 *
 * Base case: When index reaches the last element, return that element.
 * Recursive case: Compare current element with max of remaining array.
 */
int findMaxRecursive(const std::vector<int>& arr, size_t index) {
    // Handle empty array
    if (arr.empty()) {
        throw std::invalid_argument("Array is empty - cannot find maximum");
    }

    // Handle index out of bounds
    if (index >= arr.size()) {
        throw std::out_of_range("Index out of bounds");
    }

    // Base case: last element
    if (index == arr.size() - 1) {
        return arr[index];
    }

    // Recursive case: compare current with max of rest
    int maxOfRest = findMaxRecursive(arr, index + 1);
    return std::max(arr[index], maxOfRest);
}

/**
 * Wrapper function that starts recursion from index 0.
 */
int findMax(const std::vector<int>& arr) {
    return findMaxRecursive(arr, 0);
}

/**
 * Tail-recursive version (more efficient, can be optimized by compiler).
 */
int findMaxTailRecursive(const std::vector<int>& arr, size_t index, int currentMax) {
    if (arr.empty()) {
        throw std::invalid_argument("Array is empty - cannot find maximum");
    }

    if (index >= arr.size()) {
        return currentMax;
    }

    return findMaxTailRecursive(arr, index + 1, std::max(currentMax, arr[index]));
}

/**
 * Wrapper for tail-recursive version.
 */
int findMaxTail(const std::vector<int>& arr) {
    if (arr.empty()) {
        throw std::invalid_argument("Array is empty - cannot find maximum");
    }
    return findMaxTailRecursive(arr, 0, arr[0]);
}

// ==================== TEST FUNCTIONS ====================

/**
 * Test basic functionality with various inputs.
 */
void testBasicFunctionality() {
    std::cout << "\n=== Testing Basic Functionality ===\n";

    // Test 1: Normal array
    {
        std::vector<int> arr = {3, 7, 2, 9, 1};
        int result = findMax(arr);
        assert(result == 9);
        std::cout << "✓ Test 1 passed: Normal array {3,7,2,9,1} -> max = " << result << "\n";
    }

    // Test 2: Single element
    {
        std::vector<int> arr = {42};
        int result = findMax(arr);
        assert(result == 42);
        std::cout << "✓ Test 2 passed: Single element {42} -> max = " << result << "\n";
    }

    // Test 3: Two elements
    {
        std::vector<int> arr = {5, 10};
        int result = findMax(arr);
        assert(result == 10);
        std::cout << "✓ Test 3 passed: Two elements {5,10} -> max = " << result << "\n";
    }

    // Test 4: All same elements
    {
        std::vector<int> arr = {7, 7, 7, 7};
        int result = findMax(arr);
        assert(result == 7);
        std::cout << "✓ Test 4 passed: All same elements {7,7,7,7} -> max = " << result << "\n";
    }

    std::cout << "All basic functionality tests passed!\n";
}

/**
 * Test edge cases.
 */
void testEdgeCases() {
    std::cout << "\n=== Testing Edge Cases ===\n";

    // Test 1: Maximum at beginning
    {
        std::vector<int> arr = {100, 1, 2, 3};
        int result = findMax(arr);
        assert(result == 100);
        std::cout << "✓ Test 1 passed: Max at beginning {100,1,2,3} -> max = " << result << "\n";
    }

    // Test 2: Maximum at end
    {
        std::vector<int> arr = {1, 2, 3, 100};
        int result = findMax(arr);
        assert(result == 100);
        std::cout << "✓ Test 2 passed: Max at end {1,2,3,100} -> max = " << result << "\n";
    }

    // Test 3: Maximum in middle
    {
        std::vector<int> arr = {1, 2, 100, 3, 4};
        int result = findMax(arr);
        assert(result == 100);
        std::cout << "✓ Test 3 passed: Max in middle {1,2,100,3,4} -> max = " << result << "\n";
    }

    // Test 4: Negative numbers
    {
        std::vector<int> arr = {-5, -2, -8, -1};
        int result = findMax(arr);
        assert(result == -1);
        std::cout << "✓ Test 4 passed: Negative numbers {-5,-2,-8,-1} -> max = " << result << "\n";
    }

    // Test 5: Mix of positive and negative
    {
        std::vector<int> arr = {-10, 5, -3, 8, -1};
        int result = findMax(arr);
        assert(result == 8);
        std::cout << "✓ Test 5 passed: Mixed {-10,5,-3,8,-1} -> max = " << result << "\n";
    }

    // Test 6: Array with zero
    {
        std::vector<int> arr = {0, 0, 0};
        int result = findMax(arr);
        assert(result == 0);
        std::cout << "✓ Test 6 passed: Zeros {0,0,0} -> max = " << result << "\n";
    }

    // Test 7: Large numbers
    {
        std::vector<int> arr = {INT_MAX - 1, INT_MAX, INT_MAX - 2};
        int result = findMax(arr);
        assert(result == INT_MAX);
        std::cout << "✓ Test 7 passed: Large numbers -> max = " << result << "\n";
    }

    // Test 8: Negative and positive extremes
    {
        std::vector<int> arr = {INT_MIN, 0, INT_MAX};
        int result = findMax(arr);
        assert(result == INT_MAX);
        std::cout << "✓ Test 8 passed: Extreme values -> max = " << result << "\n";
    }

    std::cout << "All edge case tests passed!\n";
}

/**
 * Test error handling.
 */
void testErrorHandling() {
    std::cout << "\n=== Testing Error Handling ===\n";

    // Test 1: Empty array
    {
        std::vector<int> arr = {};
        try {
            findMax(arr);
            std::cout << "✗ Test 1 failed: Should have thrown exception for empty array\n";
        } catch (const std::invalid_argument& e) {
            std::cout << "✓ Test 1 passed: Empty array throws invalid_argument: " << e.what() << "\n";
        } catch (...) {
            std::cout << "✗ Test 1 failed: Wrong exception type\n";
        }
    }

    // Test 2: Empty array with tail recursive version
    {
        std::vector<int> arr = {};
        try {
            findMaxTail(arr);
            std::cout << "✗ Test 2 failed: Should have thrown exception for empty array\n";
        } catch (const std::invalid_argument& e) {
            std::cout << "✓ Test 2 passed: Empty array (tail recursive) throws invalid_argument: " << e.what() << "\n";
        } catch (...) {
            std::cout << "✗ Test 2 failed: Wrong exception type\n";
        }
    }

    std::cout << "All error handling tests passed!\n";
}

/**
 * Test tail recursive version matches regular recursive version.
 */
void testTailRecursiveConsistency() {
    std::cout << "\n=== Testing Tail Recursive Consistency ===\n";

    std::vector<std::vector<int>> testArrays = {
        {3, 7, 2, 9, 1},
        {42},
        {-5, -2, -8, -1},
        {100, 1, 2, 3},
        {1, 2, 3, 100},
        {0, 0, 0},
        {INT_MAX, INT_MIN, 0},
        {1, 1, 2, 2, 3, 3}
    };

    for (size_t i = 0; i < testArrays.size(); i++) {
        int regular = findMax(testArrays[i]);
        int tail = findMaxTail(testArrays[i]);
        assert(regular == tail);
        std::cout << "✓ Array " << (i + 1) << ": Both versions return " << regular << "\n";
    }

    std::cout << "All consistency tests passed!\n";
}

/**
 * Test with larger arrays to check for performance issues.
 */
void testPerformance() {
    std::cout << "\n=== Testing Performance ===\n";

    // Test with larger array
    {
        std::vector<int> arr(1000);
        for (int i = 0; i < 1000; i++) {
            arr[i] = i * 3 - 1500;  // Some varying values
        }
        arr[500] = 99999;  // Place max in middle

        int result = findMax(arr);
        assert(result == 99999);
        std::cout << "✓ Test 1 passed: Large array (1000 elements) -> max = " << result << "\n";
    }

    // Test with sorted array (worst case for naive recursion depth)
    {
        std::vector<int> arr(500);
        for (int i = 0; i < 500; i++) {
            arr[i] = i;
        }

        int result = findMax(arr);
        assert(result == 499);
        std::cout << "✓ Test 2 passed: Sorted array (500 elements) -> max = " << result << "\n";
    }

    // Test reverse sorted array
    {
        std::vector<int> arr(500);
        for (int i = 0; i < 500; i++) {
            arr[i] = 500 - i;
        }

        int result = findMax(arr);
        assert(result == 500);
        std::cout << "✓ Test 3 passed: Reverse sorted array (500 elements) -> max = " << result << "\n";
    }

    std::cout << "All performance tests passed!\n";
}

/**
 * Test that both implementations are correct by comparing with std::max_element.
 */
void testCorrectness() {
    std::cout << "\n=== Testing Correctness Against std::max_element ===\n";

    std::vector<std::vector<int>> testArrays = {
        {5, 3, 8, 1, 9, 2},
        {1},
        {-1, -2, -3, -4},
        {100, 200, 300, 400, 500},
        {500, 400, 300, 200, 100},
        {5, 5, 5, 5, 5},
        {INT_MIN, INT_MAX, 0, -1, 1},
        {42}
    };

    for (size_t i = 0; i < testArrays.size(); i++) {
        int expected = *std::max_element(testArrays[i].begin(), testArrays[i].end());
        int resultRecursive = findMax(testArrays[i]);
        int resultTail = findMaxTail(testArrays[i]);

        assert(resultRecursive == expected);
        assert(resultTail == expected);

        std::cout << "✓ Array " << (i + 1) << ": Expected=" << expected
                  << ", Recursive=" << resultRecursive
                  << ", Tail=" << resultTail << "\n";
    }

    std::cout << "All correctness tests passed!\n";
}

/**
 * Print the array for debugging.
 */
void printArray(const std::vector<int>& arr, const std::string& label = "") {
    if (!label.empty()) {
        std::cout << label << ": ";
    }
    std::cout << "[";
    for (size_t i = 0; i < arr.size(); i++) {
        if (i > 0) std::cout << ", ";
        std::cout << arr[i];
    }
    std::cout << "]\n";
}

/**
 * Demonstrate the recursive function with step-by-step output.
 */
void demonstrateRecursion() {
    std::cout << "\n=== Demonstrating Recursion Process ===\n";

    std::vector<int> arr = {3, 7, 2, 9, 1};
    printArray(arr, "Input array");

    std::cout << "\nRecursive calls:\n";
    std::cout << "findMaxRecursive({3,7,2,9,1}, 0)\n";
    std::cout << "  -> max(3, findMaxRecursive({3,7,2,9,1}, 1))\n";
    std::cout << "       -> max(7, findMaxRecursive({3,7,2,9,1}, 2))\n";
    std::cout << "            -> max(2, findMaxRecursive({3,7,2,9,1}, 3))\n";
    std::cout << "                 -> max(9, findMaxRecursive({3,7,2,9,1}, 4))\n";
    std::cout << "                      -> base case: return 1\n";
    std::cout << "                 -> max(9, 1) = 9\n";
    std::cout << "            -> max(2, 9) = 9\n";
    std::cout << "       -> max(7, 9) = 9\n";
    std::cout << "  -> max(3, 9) = 9\n\n";

    int result = findMax(arr);
    std::cout << "Result: " << result << "\n";
}

int main() {
    std::cout << "========================================\n";
    std::cout << "  Recursive Maximum Element Finder\n";
    std::cout << "========================================\n";

    try {
        // Run all test suites
        testBasicFunctionality();
        testEdgeCases();
        testErrorHandling();
        testTailRecursiveConsistency();
        testPerformance();
        testCorrectness();

        // Demonstrate the recursion
        demonstrateRecursion();

        std::cout << "\n========================================\n";
        std::cout << "  ALL TESTS PASSED SUCCESSFULLY!\n";
        std::cout << "========================================\n";

    } catch (const std::exception& e) {
        std::cerr << "\n✗ UNEXPECTED ERROR: " << e.what() << "\n";
        return 1;
    }

    return 0;
}
