import { describe, it, expect } from 'vitest';
import { createToolExecutor, ToolExecutor } from '../../src/tool/executor.js';

describe('ToolExecutor', () => {
  it('should instantiate with default coding tools', () => {
    const executor = createToolExecutor();
    const tools = executor.getAvailableTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).toContain('read');
    expect(tools).toContain('bash');
    expect(tools).toContain('edit');
  });

  it('should return error for unknown tool', async () => {
    const executor = createToolExecutor();
    const result = await executor.execute('nonexistent_tool', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Tool not found: nonexistent_tool/);
  });

  it('should execute read tool on a real file', async () => {
    const executor = createToolExecutor();
    const result = await executor.execute('read', { path: 'package.json' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('mu-agent');
  });

  it('should accept custom tool list', () => {
    const executor = new ToolExecutor([]);
    expect(executor.getAvailableTools()).toEqual([]);
  });
});
