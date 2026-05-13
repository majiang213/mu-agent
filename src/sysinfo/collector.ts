import { execSync } from 'node:child_process';
import { arch, platform, totalmem, freemem, cpus } from 'node:os';
import type { Arch, GpuInfo, HardwareConstraints, Platform, SysInfo, VramUsage } from './types.js';

/**
 * Get current system information
 */
export function getSysInfo(): SysInfo {
  const cpuInfo = cpus()[0];

  return {
    platform: platform() as Platform,
    arch: arch() as Arch,
    totalMemory: totalmem(),
    freeMemory: freemem(),
    cpuCount: cpus().length,
    cpuModel: cpuInfo?.model ?? 'Unknown',
    gpu: getGpuInfo(),
    timestamp: Date.now(),
  };
}

/**
 * Get GPU information (platform-specific)
 */
function getGpuInfo(): GpuInfo | undefined {
  const plat = platform();

  if (plat === 'darwin') {
    return getMacGpuInfo();
  }

  if (plat === 'linux') {
    return getLinuxGpuInfo();
  }

  return undefined;
}

/**
 * Get macOS GPU information using system_profiler
 */
function getMacGpuInfo(): GpuInfo | undefined {
  try {
    const output = execSync('system_profiler SPDisplaysDataType -json', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const data = JSON.parse(output) as {
      SPDisplaysDataType?: Array<{
        sppci_model?: string;
        spdisplays_vram?: string;
      }>;
    };

    const display = data.SPDisplaysDataType?.[0];
    if (!display) return undefined;

    const vramMatch = display.spdisplays_vram?.match(/(\d+)\s*GB/i);
    const vramGb = vramMatch?.[1] ? parseInt(vramMatch[1], 10) : 0;

    return {
      model: display.sppci_model ?? 'Unknown',
      vramTotal: vramGb * 1024 * 1024 * 1024,
      vramUsed: 0,
      vramFree: vramGb * 1024 * 1024 * 1024,
      utilization: 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Get Linux GPU information using nvidia-smi
 */
function getLinuxGpuInfo(): GpuInfo | undefined {
  try {
    const output = execSync(
      'nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu ' +
        '--format=csv,noheader,nounits',
      { encoding: 'utf-8', timeout: 5000 },
    );

    const parts = output
      .trim()
      .split(',')
      .map((s) => s.trim());
    if (parts.length < 5) return undefined;

    const vramTotal = parseFloat(parts[1] ?? '0') * 1024 * 1024;
    const vramUsed = parseFloat(parts[2] ?? '0') * 1024 * 1024;
    const vramFree = parseFloat(parts[3] ?? '0') * 1024 * 1024;
    const utilization = parseFloat(parts[4] ?? '0');

    return {
      model: parts[0] ?? 'Unknown',
      vramTotal,
      vramUsed,
      vramFree,
      utilization: Number.isNaN(utilization) ? 0 : utilization,
    };
  } catch {
    return undefined;
  }
}

/**
 * Get current VRAM usage
 */
export function getVramUsage(): VramUsage | undefined {
  const gpu = getGpuInfo();
  if (!gpu) return undefined;

  return {
    total: gpu.vramTotal,
    used: gpu.vramUsed,
    free: gpu.vramFree,
    percentage: gpu.vramTotal > 0 ? (gpu.vramUsed / gpu.vramTotal) * 100 : 0,
    timestamp: Date.now(),
  };
}

/**
 * Calculate hardware constraints based on system info
 */
export function calculateHardwareConstraints(sysInfo: SysInfo): HardwareConstraints {
  const gpu = sysInfo.gpu;
  const totalVram = gpu?.vramTotal ?? 0;
  const totalRam = sysInfo.totalMemory;

  let maxVramBytes = totalVram > 0 ? Math.floor(totalVram * 0.8) : 0;
  let maxRamBytes = Math.floor(totalRam * 0.7);
  let recommendedContextLength: number;
  let recommendedModelSize: string;

  if (totalVram >= 24 * 1024 * 1024 * 1024) {
    recommendedModelSize = '13B';
    recommendedContextLength = 8192;
  } else if (totalVram >= 16 * 1024 * 1024 * 1024 || totalRam >= 32 * 1024 * 1024 * 1024) {
    recommendedModelSize = '8B';
    recommendedContextLength = 8192;
  } else if (totalVram >= 8 * 1024 * 1024 * 1024 || totalRam >= 16 * 1024 * 1024 * 1024) {
    recommendedModelSize = '7B';
    recommendedContextLength = 4096;
  } else {
    recommendedModelSize = '3B';
    recommendedContextLength = 2048;
    maxVramBytes = Math.floor(totalVram * 0.6);
    maxRamBytes = Math.floor(totalRam * 0.5);
  }

  return {
    maxVramBytes,
    maxRamBytes,
    recommendedContextLength,
    recommendedModelSize,
  };
}
