/**
 * System information types for hardware monitoring
 */

/** Operating system type */
export type Platform = 'darwin' | 'linux' | 'win32';

/** CPU architecture */
export type Arch = 'x64' | 'arm64' | 'arm';

/**
 * System information snapshot
 */
export interface SysInfo {
  /** Platform identifier */
  platform: Platform;
  /** CPU architecture */
  arch: Arch;
  /** Total system memory in bytes */
  totalMemory: number;
  /** Free system memory in bytes */
  freeMemory: number;
  /** Number of CPU cores */
  cpuCount: number;
  /** CPU model name */
  cpuModel: string;
  /** GPU information if available */
  gpu?: GpuInfo;
  /** Timestamp when info was collected */
  timestamp: number;
}

/**
 * GPU information
 */
export interface GpuInfo {
  /** GPU model name */
  model: string;
  /** Total VRAM in bytes */
  vramTotal: number;
  /** Used VRAM in bytes */
  vramUsed: number;
  /** Free VRAM in bytes */
  vramFree: number;
  /** GPU utilization percentage (0-100) */
  utilization: number;
}

/**
 * Hardware constraints for model configuration
 */
export interface HardwareConstraints {
  /** Maximum VRAM allowed for model (bytes) */
  maxVramBytes: number;
  /** Maximum RAM allowed for model (bytes) */
  maxRamBytes: number;
  /** Recommended context length based on hardware */
  recommendedContextLength: number;
  /** Recommended model size (e.g., '7B', '13B') */
  recommendedModelSize: string;
}

/**
 * VRAM watcher configuration
 */
export interface VramWatcherConfig {
  /** Polling interval in milliseconds */
  intervalMs: number;
  /** VRAM usage threshold for warning (0-100) */
  warningThreshold: number;
  /** VRAM usage threshold for critical (0-100) */
  criticalThreshold: number;
  /** Callback when threshold is exceeded */
  onThresholdExceeded?: (usage: VramUsage) => void;
}

/**
 * VRAM usage snapshot
 */
export interface VramUsage {
  /** Total VRAM in bytes */
  total: number;
  /** Used VRAM in bytes */
  used: number;
  /** Free VRAM in bytes */
  free: number;
  /** Usage percentage (0-100) */
  percentage: number;
  /** Timestamp */
  timestamp: number;
}
