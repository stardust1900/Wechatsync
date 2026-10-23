import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'
import { checkAndMigrate } from '../lib/migration'
import { installExtensionGuard } from '../lib/runtime-guard'

// 检查并执行 v1.x -> v2.x 数据迁移
checkAndMigrate()

// 扩展热重载 / 更新后，旧弹窗上下文失效，所有 chrome.* 调用会抛
// "Extension context invalidated"。统一安装失效安全包装，避免未捕获报错刷屏。
installExtensionGuard()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
