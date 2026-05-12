import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config, RuntimeConfig } from './types.js';
import { getDefaultConfig, mergeWithDefaults } from './defaults.js';
import { VramWatcher } from '../sysinfo/watcher.js';
import type { AgentSessionConfig } from '@mariozechner/pi-coding-agent';

/**
 * Configuration manager singleton
 */
export class ConfigManager {
  private static instance: ConfigManager | null = null;
  private config: Config;
  private vramWatcher: VramWatcher | null = null;
  private configPath: string | null = null;

  private constructor() {
    this.config = getDefaultConfig();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): ConfigManager {
    if (ConfigManager.instance === null) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Initialize configuration from file or defaults
   */
  initialize(configPath?: string): Config {
    this.configPath = configPath ?? null;

    if (configPath && existsSync(configPath)) {
      const userConfig = this.loadFromFile(configPath);
      this.config = mergeWithDefaults(userConfig);
    } else {
      this.config = getDefaultConfig();
    }

    this.setupVramWatcher();
    return this.config;
  }

  /**
   * Get current configuration
   */
  getConfig(): Config {
    return this.config;
  }

  /**
   * Update runtime configuration dynamically
   */
  updateRuntimeConfig(runtime: Partial<RuntimeConfig>): void {
    this.config = {
      ...this.config,
      runtime: {
        ...this.config.runtime,
        ...runtime,
      },
    };
  }

  /**
   * Save current configuration to file
   */
  saveConfig(path?: string): void {
    const savePath = path ?? this.configPath;
    if (!savePath) {
      throw new Error('No config path specified');
    }

    const dir = dirname(savePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(savePath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  /**
   * Load configuration from file
   */
  private loadFromFile(path: string): Partial<Config> {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as Partial<Config>;
  }

  /**
   * Setup VRAM watcher to update runtime config
   */
  private setupVramWatcher(): void {
    if (this.vramWatcher !== null) return;

    this.vramWatcher = new VramWatcher({
      intervalMs: 5000,
      warningThreshold: 80,
      criticalThreshold: 95,
    });

    this.vramWatcher.on('usage', (usage) => {
      this.updateRuntimeConfig({
        currentVramUsage: usage.percentage,
      });
    });

    this.vramWatcher.on('critical', () => {
      this.updateRuntimeConfig({
        pauseNewTasks: true,
        adjustedContextLength: Math.floor(this.config.system.hardware.recommendedContextLength / 2),
      });
    });

    this.vramWatcher.start();
  }

  /**
   * Stop VRAM watcher
   */
  destroy(): void {
    if (this.vramWatcher !== null) {
      this.vramWatcher.stop();
      this.vramWatcher = null;
    }
    ConfigManager.instance = null;
  }

  /**
   * Get system prompt based on hardware constraints
   */
  private getSystemPrompt(): string {
    const hw = this.config.system.hardware;
    return `You are a coding assistant running on a local ${hw.recommendedModelSize} model. ` +
      `Available VRAM: ${Math.floor(hw.maxVramBytes / 1024 / 1024)}MB. ` +
      `Recommended context length: ${hw.recommendedContextLength} tokens.`;
  }

  /**
   * Create pi model configuration
   */
  createPiModelConfig(): { provider: string; model: string; baseUrl: string; apiKey?: string } {
    const model = this.config.system.model;
    return {
      provider: model.provider,
      model: model.model,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
    };
  }
}

/**
 * Initialize configuration (convenience function)
 */
export function initializeConfig(configPath?: string): Config {
  return ConfigManager.getInstance().initialize(configPath);
}
