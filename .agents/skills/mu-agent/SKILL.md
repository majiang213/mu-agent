```markdown
# mu-agent Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill introduces the core development patterns and conventions used in the `mu-agent` TypeScript codebase. It covers file organization, code style, commit practices, and testing patterns, providing clear examples and actionable workflows for contributors and maintainers.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `myModule.ts`, `userAgent.ts`

### Import Style
- Use **relative imports** for referencing modules within the project.
  - Example:
    ```typescript
    import { myFunction } from './utils';
    ```

### Export Style
- Use **named exports** for all modules.
  - Example:
    ```typescript
    // In utils.ts
    export function myFunction() { /* ... */ }
    ```

### Commit Messages
- Follow **conventional commit** style.
- Use the `fix` prefix for bug fixes.
- Keep commit messages concise (~55 characters).
  - Example:
    ```
    fix: handle null user in agent initialization
    ```

## Workflows

### Bug Fixing
**Trigger:** When a bug is identified and needs to be resolved  
**Command:** `/fix-bug`

1. Create a new branch for the bug fix.
2. Make code changes following the coding conventions.
3. Write or update relevant tests (`*.test.*` files).
4. Commit using the `fix:` prefix and a concise message.
5. Open a pull request for review.

### Adding a New Module
**Trigger:** When introducing new functionality  
**Command:** `/add-module`

1. Create a new file using camelCase naming.
2. Implement functionality using named exports.
3. Use relative imports for dependencies.
4. Add or update tests for the new module.
5. Commit changes with a descriptive message.

### Writing Tests
**Trigger:** When adding or updating features  
**Command:** `/write-test`

1. Create or update a test file matching the pattern `*.test.*`.
2. Write test cases for the relevant functionality.
3. Run tests to ensure correctness.

## Testing Patterns

- Test files follow the `*.test.*` naming convention (e.g., `userAgent.test.ts`).
- The specific testing framework is not detected, but standard TypeScript test patterns apply.
- Place tests alongside or near the modules they cover.

  Example:
  ```typescript
  // userAgent.test.ts
  import { myFunction } from './userAgent';

  describe('myFunction', () => {
    it('should return expected value', () => {
      // test implementation
    });
  });
  ```

## Commands
| Command      | Purpose                                 |
|--------------|-----------------------------------------|
| /fix-bug     | Start the bug fixing workflow           |
| /add-module  | Add a new module following conventions  |
| /write-test  | Write or update tests for a module      |
```
