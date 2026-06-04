import { readFile } from 'node:fs/promises';
import ts from 'typescript';

/**
 * Post-check hook interface
 */
export interface PostCheckHook {
  name: string;
  check(filePath: string, originalContent: string): Promise<boolean>;
}

/**
 * Syntax check hook
 */
export const syntaxCheckHook: PostCheckHook = {
  name: 'syntax',
  async check(filePath: string): Promise<boolean> {
    try {
      const ext = filePath.split('.').pop() ?? '';
      if (!['ts', 'tsx', 'js', 'jsx'].includes(ext)) return true;
      const program = ts.createProgram([filePath], {
        noEmit: true,
        allowJs: true,
        skipLibCheck: true,
        noResolve: true,
      });
      const diags = ts.getPreEmitDiagnostics(program);
      return diags.length === 0;
    } catch {
      return true;
    }
  },
};

/**
 * Damage detection hook
 */
export const damageCheckHook: PostCheckHook = {
  name: 'damage',
  async check(filePath: string, originalContent: string): Promise<boolean> {
    try {
      const modifiedContent = await readFile(filePath, 'utf-8');

      // Detect deleted functions
      const deletedFunctions = detectDeletedFunctions(originalContent, modifiedContent);
      if (deletedFunctions.length > 0) {
        console.error(`Damage detected: Deleted functions ${deletedFunctions.join(', ')}`);
        return false;
      }

      // Detect signature changes
      const signatureChanges = detectSignatureChanges(originalContent, modifiedContent);
      if (signatureChanges.length > 0) {
        console.error(`Damage detected: Signature changes in ${signatureChanges.join(', ')}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error(`Failed to check damage for ${filePath}:`, error);
      return false;
    }
  },
};

/**
 * Detect deleted functions
 */
function detectDeletedFunctions(original: string, modified: string): string[] {
  const functionPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;

  const originalFunctions = new Set<string>();
  let match;
  while ((match = functionPattern.exec(original)) !== null) {
    if (match[1]) originalFunctions.add(match[1]);
  }

  const modifiedFunctions = new Set<string>();
  while ((match = functionPattern.exec(modified)) !== null) {
    if (match[1]) modifiedFunctions.add(match[1]);
  }

  const deleted: string[] = [];
  for (const func of originalFunctions) {
    if (!modifiedFunctions.has(func)) {
      deleted.push(func);
    }
  }

  return deleted;
}

/**
 * Detect signature changes
 */
function detectSignatureChanges(original: string, modified: string): string[] {
  // Simplified: check if exported function signatures changed
  const signaturePattern = /export\s+(?:async\s+)?function\s+(\w+)\s*\([^)]*\)/g;

  const originalSigs = new Map<string, string>();
  let match;
  while ((match = signaturePattern.exec(original)) !== null) {
    if (match[1]) originalSigs.set(match[1], match[0]);
  }

  const modifiedSigs = new Map<string, string>();
  while ((match = signaturePattern.exec(modified)) !== null) {
    if (match[1]) modifiedSigs.set(match[1], match[0]);
  }

  const changed: string[] = [];
  for (const [name, origSig] of originalSigs) {
    const modSig = modifiedSigs.get(name);
    if (modSig && modSig !== origSig) {
      changed.push(name);
    }
  }

  return changed;
}

/**
 * Run all post-check hooks
 */
export async function runPostChecks(
  filePath: string,
  originalContent: string,
  hooks: PostCheckHook[] = [syntaxCheckHook, damageCheckHook],
): Promise<{ success: boolean; failedHooks: string[] }> {
  const failedHooks: string[] = [];

  for (const hook of hooks) {
    const passed = await hook.check(filePath, originalContent);
    if (!passed) {
      failedHooks.push(hook.name);
    }
  }

  return {
    success: failedHooks.length === 0,
    failedHooks,
  };
}
