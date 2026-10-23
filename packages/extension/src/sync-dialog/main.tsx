import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SyncDialogPage } from './SyncDialogPage'
import '../popup/styles/globals.css'
import { installExtensionGuard } from '../lib/runtime-guard'

// 同步对话框 iframe 在扩展重载后仍可能驻留在网页中，统一安装失效安全包装。
installExtensionGuard()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SyncDialogPage />
  </StrictMode>
)
