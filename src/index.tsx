import { Hono } from 'hono'
import { renderer } from './renderer'
import { cors } from 'hono/cors'

// 导入服务
import { DatabaseService } from './services/database'
import { AuthService } from './services/auth'
import { RSSService } from './services/rss'
import { TelegramService } from './services/telegram'
import { MatcherService } from './services/matcher'

// 导入中间件
import {
  requestLoggerMiddleware,
  errorHandlerMiddleware,
  corsConfig,
  rateLimitMiddleware
} from './middleware/auth'

// 导入路由
import { authRoutes } from './routes/auth'
import { apiRoutes } from './routes/api'
import { telegramRoutes } from './routes/telegram'
import { pageRoutes } from './routes/pages'

type Bindings = {
  DB: D1Database
  ENVIRONMENT: string
}

type Variables = {
  dbService: DatabaseService
  authService: AuthService
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// 全局中间件
app.use('*', errorHandlerMiddleware)
app.use('*', requestLoggerMiddleware)
app.use('*', cors(corsConfig))
app.use('*', rateLimitMiddleware(200, 60000)) // 每分钟最多200个请求
app.use(renderer)

// 初始化服务
app.use('*', async (c, next) => {
  const dbService = new DatabaseService(c.env.DB)
  const authService = new AuthService(dbService)

  c.set('dbService', dbService)
  c.set('authService', authService)

  await next()
})

// 路由
app.route('/auth', authRoutes)
app.route('/api', apiRoutes)
app.route('/telegram', telegramRoutes)
app.route('/', pageRoutes)

// 定时任务处理器
export default {
  fetch: app.fetch,

  // 定时任务处理器
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const cronExpression = event.cron?.trim() || '';
    console.log(`开始执行定时任务，cron: ${cronExpression}`)

    try {
      const dbService = new DatabaseService(env.DB)

      // RSS抓取和推送任务
      const config = await dbService.getBaseConfig()

      if (!config || !config.bot_token) {
        console.log('系统未配置或未设置 Bot Token，跳过RSS抓取任务')
        return
      }

      const rssService = new RSSService(dbService)
      const telegramService = new TelegramService(dbService, config.bot_token)
      const matcherService = new MatcherService(dbService, telegramService)

      // 1. 抓取新的RSS数据
      console.log('开始抓取RSS数据...')
      let newPostsCount = 0
      try {
        const rssResult = await rssService.processNewRSSData()
        newPostsCount = rssResult.new
        console.log(`RSS抓取完成: 新增 ${newPostsCount} 篇文章`)
      } catch (rssError) {
        console.error('抓取 RSS 出现异常:', rssError)
      }

      // 2. 检查并处理未推送的文章（无论本次是否有新文章，都检查未推送队列）
      try {
        console.log('开始检查未推送文章队列...')
        const pushResult = await matcherService.processUnpushedPosts()
        console.log(`推送完成: 推送 ${pushResult.pushed} 篇，跳过 ${pushResult.skipped} 篇，错误 ${pushResult.errors} 篇`)
      } catch (pushError) {
        console.error('处理文章推送出现异常:', pushError)
      }

      // 3. 数据清理（整点或特定 cron 执行）
      const isHourly = cronExpression === '0 * * * *' || new Date().getUTCMinutes() === 0;
      if (isHourly) {
        try {
          console.log('执行数据清理任务...')
          const cleanupResult = await dbService.cleanupOldPosts()
          console.log(`数据清理完成: 删除了 ${cleanupResult.deletedCount} 条过期记录`)
        } catch (cleanupError) {
          console.error('清理过期数据出现异常:', cleanupError)
        }
      }

    } catch (error) {
      console.error('定时任务执行失败:', error)
    }
  }
}
