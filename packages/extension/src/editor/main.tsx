import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorApp } from './EditorApp'
import '../popup/styles/globals.css'
import { installExtensionGuard } from '../lib/runtime-guard'

// 编辑器 iframe 在扩展重载后仍可能驻留在网页中，旧上下文失效后 chrome.* 调用会抛错，
// 统一安装失效安全包装。
installExtensionGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EditorApp />
  </StrictMode>
)
