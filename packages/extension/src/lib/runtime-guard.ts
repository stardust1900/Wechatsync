/**
 * Chrome 扩展在「重载 / 更新」后，仍驻留在页面中的内容脚本、注入脚本或弹窗，
 * 若继续调用 chrome.runtime.* 会【同步抛出】`Extension context invalidated`，
 * 且该错误常被事件回调吞不到，导致控制台刷屏「Uncaught Error」。
 *
 * 这里提供带有效性校验的安全封装，统一消除此类未捕获错误：
 *  - 上下文失效时直接 no-op / 返回 undefined，绝不抛错；
 *  - 即便校验通过也用 try/catch 兜底（仍存在竞态窗口）。
 */

/** 扩展上下文是否仍然有效（失效后 chrome.runtime.id 为 undefined） */
export function isContextValid(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id
  } catch {
    return false
  }
}

/** await 版：安全发送消息，失败时返回 undefined（不 reject） */
export async function safeSendMessage<T = any>(
  message: unknown,
): Promise<T | undefined> {
  if (!isContextValid()) return undefined
  try {
    return (await chrome.runtime.sendMessage(message)) as T | undefined
  } catch {
    return undefined
  }
}

/** fire-and-forget 版：吞掉所有错误（含上下文失效、接收端不存在） */
export function sendMessageSafe(message: unknown): void {
  if (!isContextValid()) return
  try {
    void chrome.runtime.sendMessage(message)
  } catch {
    /* 上下文失效或接收端不存在，忽略 */
  }
}

/** 安全获取扩展内资源 URL（失效时返回空串） */
export function safeGetURL(path: string): string {
  if (!isContextValid()) return ''
  try {
    return chrome.runtime.getURL(path)
  } catch {
    return ''
  }
}

/**
 * 在「扩展上下文失效」（重载 / 更新 / 卸载）后，所有 chrome.* API 调用都会同步抛出
 * `Extension context invalidated`。这里在入口处统一把 chrome.runtime / chrome.storage
 * / chrome.tabs 的常用方法包一层「失效安全」外壳：
 *  - 失效时直接 no-op / 返回空值（Promise 兼容回调形式），不再抛未捕获错误；
 *  - 即便校验通过也用 try/catch 兜底竞态窗口。
 *
 * 这样无论弹窗、编辑器 iframe、同步对话框里有多少处 chrome.* 调用，都能一次性兜底，
 * 不必逐行改动业务代码。
 */
export function installExtensionGuard(): void {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime) return
    const rt = chrome.runtime as any

    // getURL：必须返回字符串，否则 <img src> 等会拿到 [object Promise]
    const origGetURL = rt.getURL?.bind(rt)
    if (typeof origGetURL === 'function') {
      rt.getURL = (...args: any[]) => {
        if (!isContextValid()) return ''
        try { return origGetURL(...args) } catch { return '' }
      }
    }

    // getManifest：返回对象（失效时返回空对象，避免 .version 崩溃）
    const origManifest = rt.getManifest?.bind(rt)
    if (typeof origManifest === 'function') {
      rt.getManifest = (...args: any[]) => {
        if (!isContextValid()) return {} as any
        try { return origManifest(...args) } catch { return {} as any }
      }
    }

    // sendMessage / sendNativeMessage：返回 Promise（兼容回调形式，失效时回调不触发也安全）
    for (const m of ['sendMessage', 'sendNativeMessage']) {
      const orig = rt[m]?.bind(rt)
      if (typeof orig !== 'function') continue
      rt[m] = (...args: any[]) => {
        if (!isContextValid()) return Promise.resolve(undefined)
        try { return orig(...args) } catch { return Promise.resolve(undefined) }
      }
    }

    // connect：失效时直接抛可控错误（长连接本就该断开）
    const origConnect = rt.connect?.bind(rt)
    if (typeof origConnect === 'function') {
      rt.connect = (...args: any[]) => {
        if (!isContextValid()) throw new Error('Extension context invalidated (guarded)')
        return origConnect(...args)
      }
    }

    // storage.local：get/set/remove/clear（Promise 与回调形式皆可）
    const store = (chrome as any).storage?.local
    if (store) {
      for (const m of ['get', 'set', 'remove', 'clear']) {
        const orig = store[m]?.bind(store)
        if (typeof orig !== 'function') continue
        store[m] = (...args: any[]) => {
          if (!isContextValid()) return Promise.resolve(undefined)
          try {
            const r = orig(...args)
            return r && typeof r.then === 'function' ? r.catch(() => undefined) : r
          } catch { return Promise.resolve(undefined) }
        }
      }
    }

    // tabs：query/sendMessage/create/executeScript 等
    const tabs = (chrome as any).tabs
    if (tabs) {
      for (const m of ['query', 'sendMessage', 'create', 'executeScript', 'sendNavigationMessage']) {
        const orig = tabs[m]?.bind(tabs)
        if (typeof orig !== 'function') continue
        tabs[m] = (...args: any[]) => {
          if (!isContextValid()) return Promise.resolve([] as any)
          try {
            const r = orig(...args)
            return r && typeof r.then === 'function' ? r.catch(() => undefined) : r
          } catch { return Promise.resolve(undefined) }
        }
      }
    }
  } catch {
    /* 若 chrome 命名空间不可写（理论上不会），忽略即可，不影响其它逻辑 */
  }
}
