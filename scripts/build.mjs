// 按依赖顺序构建各 workspace，并对 esbuild 偶发原生崩溃（Windows 下
// "all goroutines are asleep - deadlock"，退出码 3221226356 / -1073740940）
// 自动重试：杀掉残留 esbuild 进程后重跑，直到成功。
import { spawnSync } from 'node:child_process'
import os from 'node:os'

const workspaces = [
  '@wechatsync/core',
  '@wechatsync/mcp-server',
  '@wechatsync/cli',
  '@wechatsync/extension',
]

// esbuild 原生死锁崩溃的特征退出码（十进制与有符号两种写法）
const ESBUILD_CRASH_CODES = new Set([3221226356, -1073740940])
const MAX_RETRIES = 5

function killEsbuild() {
  try {
    if (os.platform() === 'win32') {
      spawnSync('taskkill', ['/IM', 'esbuild.exe', '/F'], { stdio: 'ignore' })
    } else {
      spawnSync('pkill', ['-f', 'esbuild'], { stdio: 'ignore' })
    }
  } catch {
    // 无匹配进程或命令不存在都属于正常情况
  }
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: os.platform() === 'win32',
  })
  return res.status ?? 1
}

let failed = false

for (const ws of workspaces) {
  let attempt = 0
  let code = 1
  while (attempt <= MAX_RETRIES) {
    killEsbuild()
    code = run('yarn', ['workspace', ws, 'build'])
    if (code === 0) break

    // 非 esbuild 崩溃（如真实 TS 报错）直接失败，不再重试
    if (!ESBUILD_CRASH_CODES.has(code)) {
      failed = true
      break
    }

    attempt++
    console.error(
      `\n[build] ${ws} 遇到 esbuild 原生崩溃（退出码 ${code}），清理后重试 (${attempt}/${MAX_RETRIES})...\n`
    )
  }

  if (code !== 0) {
    failed = true
    console.error(`\n[build] ${ws} 构建失败，终止。`)
    break
  }
  console.error(`\n[build] ${ws} 构建完成。\n`)
}

process.exit(failed ? 1 : 0)
