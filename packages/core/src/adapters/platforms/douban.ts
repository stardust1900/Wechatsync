/**
 * 豆瓣适配器
 *
 * 注：豆瓣「写日记」已改为基于 topic（话题）编辑器的 SPA 流程：
 *  - 登录态由 Cookie（dbcl2 / ck）判定；
 *  - 上传凭证 upload_auth_token 与 ck 由页面运行时全局 window.__INIT_STATE__ 提供，
 *    需通过内容脚本（executeScript）在页面上下文读取，后台 fetch 拿不到；
 *  - 图片上传端点：https://upload.douban.com/j/group/topic/add_photo
 *  - 发布端点（rexxar）：POST https://m.douban.com/rexxar/api/v2/topic/post
 *    请求体需带 content（Draft.js raw 的 JSON 字符串）、title、subtype:'note' 等；
 *    rexxar 对 POST 用 X-CSRF-TOKEN 头携带 ck，并校验 Origin/Referer（这两个是浏览器
 *    禁止 fetch 设置的头，必须借助扩展 headerRules / declarativeNetRequest 注入）。
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'
import type { DoubanImageData } from '../../lib'
import type { PublishOptions } from '../types'
import { markdownToDraft } from '../../lib'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Douban')

export class DoubanAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'douban',
    name: '豆瓣',
    icon: 'https://www.douban.com/favicon.ico',
    homepage: 'https://www.douban.com/topic/create?subtype=note',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 豆瓣使用 Markdown 格式 (转换为 Draft.js) */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  // rexxar 草稿接口（写日记）：POST /rexxar/api/v2/dwarf/drafts，body { draft_props }
  // 创建后草稿会出现在「草稿箱」，用户可在编辑器继续编辑并发布。
  private readonly DRAFT_URL = 'https://m.douban.com/rexxar/api/v2/dwarf/drafts'
  // 图片上传端点
  private readonly ADD_PHOTO_URL = 'https://upload.douban.com/j/group/topic/add_photo'
  // 写日记页面（用于读取 window.__INIT_STATE__）
  private readonly EDITOR_URL = 'https://www.douban.com/topic/create?subtype=note'

  // rexxar / 上传接口需要 Origin / Referer，这两个是浏览器禁止 fetch 设置的头，
  // 必须借助扩展的 declarativeNetRequest（headerRules）注入。
  private readonly HEADER_RULES: Array<Omit<HeaderRule, 'id'>> = [
    {
      urlFilter: '*://www.douban.com/*',
      headers: { Referer: 'https://www.douban.com/', Origin: 'https://www.douban.com' },
    },
    {
      urlFilter: '*://m.douban.com/*',
      headers: { Referer: 'https://www.douban.com/', Origin: 'https://www.douban.com' },
    },
    {
      urlFilter: '*://upload.douban.com/*',
      headers: { Referer: 'https://www.douban.com/', Origin: 'https://www.douban.com' },
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      // 登录态判定必须与「能否发布」对齐：发布需要 ck（优先取自页面
      // window.__INIT_STATE__，Cookie 兜底）。若 Cookie 里 ck 缺失，说明登录态不完整，
      // 此时按未登录处理——否则会出现「界面显示已登录，同步却报请先登录」的不一致，
      // 且平台不会被归入未登录灰色列表。
      // 豆瓣会话 Cookie 为 dbcl2，登录后才会存在；ck 为登录态 CSRF Cookie
      let cookieAuth = false
      if (this.runtime.getCookie) {
        const dbcl2 = await this.runtime.getCookie('douban.com', 'dbcl2')
        const ck = await this.runtime.getCookie('douban.com', 'ck')
        cookieAuth = !!(dbcl2 && ck)
        logger.debug('cookieAuth:', cookieAuth, { hasDbcl2: !!dbcl2, hasCk: !!ck })
      }

      if (!cookieAuth) {
        return { isAuthenticated: false }
      }

      // 尝试从「已打开的」豆瓣页读取用户名（可选，失败不影响登录态）。
      // 用 reuseOnly 模式：绝不主动打开新标签，避免扩展启动/预检时豆瓣页闪烁。
      let username = ''
      let avatar = ''
      try {
        const state = await this.getDoubanState(true)
        if (state) {
          username = state.username || ''
          avatar = state.avatar || ''
        }
      } catch {
        // 忽略：用户名仅用于展示
      }

      return {
        isAuthenticated: true,
        userId: username,
        username,
        avatar,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    try {
      logger.warn('[Douban] 开始发布...')

      // ck 与 upload_auth_token 均来自页面运行时 window.__INIT_STATE__
      // （Cookie 中的 ck 在部分登录态下缺失会误报"请先登录"）。一次性读取，
      // 同时拿到两者，避免重复打开豆瓣页。
      const state = await this.getDoubanState()
      const ck =
        state?.ck ||
        (this.runtime.getCookie ? await this.runtime.getCookie('douban.com', 'ck') : null) ||
        null
      if (!ck) {
        throw new Error('请先登录豆瓣')
      }

      const uploadAuthToken = state?.upload_auth_token || null
      if (!uploadAuthToken) {
        throw new Error('未能获取豆瓣写日记所需凭证，请打开 ' + this.EDITOR_URL + ' 后重试')
      }

      // 在 headerRules 作用域内发起所有豆瓣请求（注入 Origin/Referer）
      return await this.withHeaderRules(this.HEADER_RULES, async () => {
        // 1. 图片处理：上传到豆瓣，得到新 url，同时收集完整图片数据
        let content = article.markdown || ''
        const imageDataMap = new Map<string, DoubanImageData>()
        content = await this.processImages(
          content,
          async (src) => {
            const result = await this.uploadImageWithFullData(src, ck, uploadAuthToken)
            imageDataMap.set(result.url, result.imageData)
            return result
          },
          {
            skipPatterns: ['doubanio.com', 'douban.com'],
            onProgress: options?.onImageProgress,
          }
        )

        // 2. 正文只保留纯文本：豆瓣图片走 image_ids 画廊（独立于 content），
        //    不在 content 内嵌 Draft.js IMAGE 实体（否则服务端处理 content 时 500）。
        const textOnly = content.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim()

        // 3. Markdown -> Draft.js raw（纯文本，无 IMAGE 实体）
        const draftContent = markdownToDraft(textOnly, imageDataMap)
        const contentObj = typeof draftContent === 'string' ? JSON.parse(draftContent) : draftContent
        // 与真实豆瓣编辑器一致：每个块 data 带 align 字段；content 整体作为
        // 对象（非字符串）发送——传字符串会在服务端取 .blocks 时崩溃 500。
        const blocks = Array.isArray(contentObj.blocks) ? contentObj.blocks : []
        for (const b of blocks) {
          b.data = { align: '', ...(b.data && typeof b.data === 'object' ? (b.data as Record<string, unknown>) : {}) }
        }

        // 豆瓣草稿编辑器（draft.js）加载文档末尾的列表时会整段丢弃，且会剥离尾随
        // 空块，导致文末「风险提示」等声明丢失。把末尾连续的列表项转成引用块
        // （blockquote）——豆瓣对引用块不丢，内容不丢只是变成引用样式。
        {
          let lastListEnd = blocks.length
          while (
            lastListEnd > 0 &&
            (blocks[lastListEnd - 1].type === 'unordered-list-item' ||
              blocks[lastListEnd - 1].type === 'ordered-list-item')
          ) {
            lastListEnd--
          }
          if (lastListEnd < blocks.length) {
            const quoteText = blocks
              .slice(lastListEnd)
              .map((b: any) => b.text || '')
              .join('\n')
            const head = blocks.slice(0, lastListEnd)
            head.push({
              key: `risk-quote-${Date.now()}`,
              text: quoteText,
              type: 'blockquote',
              depth: 0,
              entityRanges: [],
              inlineStyleRanges: [],
              data: { align: '' },
            })
            blocks.length = 0
            blocks.push(...head)
            logger.warn('[Douban] 文末列表已转引用块，避免被草稿编辑器丢弃')
          }
        }

        // 4. 收集图片 id（画廊）
        const imageIds: string[] = []
        for (const v of imageDataMap.values()) {
          if (v.id) imageIds.push(v.id)
        }

        // 5. 创建草稿（写入草稿箱，与页面「自动保存草稿」行为一致）
        //    rexxar dwarf 接口：POST /rexxar/api/v2/dwarf/drafts，body { draft_props }
        //    draft_props 为 JSON 字符串；content 为 Draft.js raw 对象（字段对齐真实编辑器请求）。
        const draftProps: Record<string, unknown> = {
          title: article.title || '',
          content: contentObj,
          image_ids: imageIds,
          topic_tag_ids: [],
          subtype: 'personal',
        }

        const cObj = contentObj as {
          blocks?: Array<{ type?: string; entityRanges?: Array<{ key: number | string }> }>
          entityMap?: Record<string, { type?: string }>
        }
        const cBlocks = cObj.blocks ?? []
        const contentHasImageEntities = cBlocks.some((b) =>
          (b.entityRanges ?? []).some((r) => cObj.entityMap?.[String(r.key)]?.type === 'IMAGE')
        )
        logger.warn(
          '[Douban] 发送 dwarf/drafts draft_props 结构: ' +
            JSON.stringify({
              keys: Object.keys(draftProps),
              title: String(draftProps.title || '').slice(0, 30),
              contentIsString: typeof draftProps.content === 'string',
              contentBlocks: cBlocks.length,
              distinctBlockTypes: Array.from(new Set(cBlocks.map((b) => b.type))),
              contentHasImageEntities,
              image_ids: draftProps.image_ids,
              image_layout: draftProps.image_layout,
              subtype: draftProps.subtype,
              group_id: draftProps.group_id,
            })
        )

        const response = await this.runtime.fetch(this.DRAFT_URL, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            // rexxar 的 POST 用 X-CSRF-TOKEN 头携带 ck（与页面 _W 拦截器一致）
            'X-CSRF-TOKEN': ck,
          },
          body: JSON.stringify({ draft_props: JSON.stringify(draftProps) }),
        })

        const res = (await this.readJson(response, 'dwarf/drafts')) as {
          r?: number
          status?: number
          code?: number
          err?: string
          message?: string
          id?: string | number
          data?: { id?: string | number }
        }
        // 生产构建下默认只显示 warn，打印完整响应用于排查
        logger.warn('[Douban] dwarf/drafts 响应:', JSON.stringify(res).slice(0, 800))

        // rexxar 用 r（或 status/code）表示业务状态：非 0 即失败
        const errCode = res.r ?? res.status ?? res.code
        if (errCode !== undefined && errCode !== 0) {
          throw new Error(`草稿创建失败 (code ${errCode}): ${res.err || res.message || '未知错误'}`)
        }

        const draftId = String(res?.id ?? res?.data?.id ?? '')
        if (!draftId) {
          throw new Error('草稿创建失败：响应未包含 draft id，响应=' + JSON.stringify(res).slice(0, 300))
        }

        logger.warn('[Douban] 草稿创建成功 draft_id=', draftId)
        const postUrl = `https://www.douban.com/topic/create?draft_id=${draftId}`

        return this.createResult(true, {
          postId: draftId,
          postUrl,
          draftOnly: true,
        })
      })
    } catch (error) {
      return this.createResult(false, {
        error: (error as Error).message,
      })
    }
  }

  /**
   * 健壮地读取 JSON 响应：非 JSON（如 HTML 错误页）时打印真实响应体，便于定位。
   */
  private async readJson(response: Response, label: string): Promise<Record<string, unknown>> {
    const text = await response.text()
    const ct = response.headers.get('content-type') || ''
    if (!response.ok || !ct.includes('json')) {
      const plain = text
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      logger.warn(
        `[Douban] ${label} 返回非 JSON 响应: status=${response.status} contentType=${ct} body=${plain.slice(0, 800)} | raw=${text.slice(0, 1200)}`
      )
    }
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new Error(`${label} 返回非 JSON（status ${response.status}）: ${text.slice(0, 200)}`)
    }
  }

  /**
   * 读取 window.__INIT_STATE__（upload_auth_token / ck / 用户名等）。
   * 优先复用已打开的豆瓣标签页；若不存在则：
   *  - reuseOnly=false（默认，发布需要 token 时）：自动打开写日记页并轮询等待 SPA 初始化；
   *  - reuseOnly=true（登录校验等只读场景）：不打开新标签，直接返回 null，
   *    避免扩展启动/预检/打开弹窗时豆瓣页"打开又关闭"的闪烁。
   */
  private async getDoubanState(reuseOnly = false): Promise<{
    upload_auth_token?: string
    ck?: string
    username?: string
    avatar?: string
  } | null> {
    if (!this.runtime.tabs) {
      logger.warn('runtime.tabs 不可用，无法读取 window.__INIT_STATE__（需浏览器环境）')
      return null
    }
    let tabId: number | undefined
    let createdByUs = false
    try {
      const tabs = await this.runtime.tabs.query('*://*.douban.com/*')
      if (tabs.length > 0 && tabs[0].id != null) {
        tabId = tabs[0].id
      } else if (!reuseOnly) {
        const created = await this.runtime.tabs.create(this.EDITOR_URL, false)
        tabId = created.id
        createdByUs = true
        await this.runtime.tabs.waitForLoad(tabId)
      } else {
        // 复用模式：当前没有打开的豆瓣页，不读取用户名（不影响登录态判定）
        return null
      }

      for (let i = 0; i < 30; i++) {
        const state = await this.runtime.tabs!.executeScript(
          tabId,
          () => {
            const s = (window as unknown as { __INIT_STATE__?: Record<string, unknown> }).__INIT_STATE__
            return {
              upload_auth_token: (s?.upload_auth_token as string) || '',
              ck: (s?.ck as string) || '',
              username: (s?.username as string) || (s?.loginUser as { name?: string })?.name || '',
              avatar: (s?.avatar as string) || '',
            }
          },
          []
        )
        if (state?.upload_auth_token) return state
        await new Promise((r) => setTimeout(r, 300))
      }
      logger.warn('等待 window.__INIT_STATE__.upload_auth_token 超时')
    } catch (e) {
      logger.warn('getDoubanState failed:', e)
    } finally {
      // 仅关闭我们为读取状态而新建的标签页，避免残留豆瓣编辑器页被浏览器会话恢复
      if (createdByUs && tabId != null) {
        try {
          await this.runtime.tabs!.remove(tabId)
        } catch {
          /* ignore */
        }
      }
    }
    return null
  }

  /**
   * 上传图片到豆瓣并返回完整数据
   */
  private async uploadImageWithFullData(
    src: string,
    ck: string,
    uploadAuthToken: string
  ): Promise<ImageUploadResult & { imageData: DoubanImageData }> {
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    formData.append('image_file', imageBlob, 'image.jpg')
    formData.append('ck', ck)
    formData.append('upload_auth_token', uploadAuthToken)

    const uploadResponse = await this.runtime.fetch(this.ADD_PHOTO_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        // X-CSRF-TOKEN 为自定义头，fetch 可设置；Origin/Referer 由 headerRules 注入
        'X-CSRF-TOKEN': ck,
      },
      body: formData,
    })

    const res = (await this.readJson(uploadResponse, 'add_photo')) as {
      r?: number
      photo?: {
        id: string
        url: string
        thumb: string
        width: number
        height: number
        file_name: string
        file_size: number
      }
    }

    logger.warn('[Douban] add_photo 响应:', JSON.stringify(res).slice(0, 400))

    if (res.r !== 0 || !res.photo?.url) {
      throw new Error('图片上传失败 (r=' + res.r + ')')
    }

    const photo = res.photo

    return {
      url: photo.url,
      imageData: {
        id: photo.id,
        url: photo.url,
        thumb: photo.thumb,
        width: photo.width,
        height: photo.height,
        file_name: photo.file_name,
        file_size: photo.file_size,
      },
    }
  }
}
