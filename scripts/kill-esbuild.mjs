// 构建前清理可能残留的 esbuild service 进程（上次构建崩溃时会变成孤儿进程，
// 导致下次构建在 stdio 管道上死锁：fatal error: all goroutines are asleep - deadlock）
import { execSync } from 'node:child_process'

try {
  if (process.platform === 'win32') {
    // Windows：按映像名结束 esbuild.exe（无进程时 taskkill 返回非 0，忽略即可）
    execSync('taskkill /IM esbuild.exe /F', { stdio: 'ignore' })
  } else {
    // macOS / Linux：按进程名结束
    execSync('pkill -f esbuild || true', { stdio: 'ignore' })
  }
} catch {
  // 没有匹配到进程或命令不存在都属于正常情况
}
