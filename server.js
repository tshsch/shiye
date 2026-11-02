// 「拾页」Shiye - 阅读收藏智能体
// 零依赖 Node.js 服务（仅使用 node:sqlite / node:crypto 等内置模块）
//
// 目录结构：
//   src/config.js   配置加载（.env）
//   src/db.js       数据库建表与迁移
//   src/auth.js     会话与登录凭证
//   src/llm.js      AI 调用（OpenAI 兼容接口）
//   src/content.js  抓取 / 分块 / 检索 / 评论聚合
//   src/seed.js     演示账号与演示数据
//   src/static.js   静态文件服务
//   src/routes/*    按资源拆分的 API 路由
//   static/         前端页面（css/js/资源）

const http = require('http');
const config = require('./src/config');
const { json } = require('./src/lib/http');
const { currentUser } = require('./src/auth');
const { serveStatic } = require('./src/static');
const { seedDemo } = require('./src/seed');

const authRoutes = require('./src/routes/auth');
const dataRoutes = require('./src/routes/data');
const itemRoutes = require('./src/routes/items');
const commentRoutes = require('./src/routes/comments');
const chatRoutes = require('./src/routes/chat');

seedDemo();

// 各路由模块：处理到返回 true，未匹配返回 false
const PROTECTED_ROUTES = [dataRoutes, itemRoutes, commentRoutes, chatRoutes];

function cors(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(u.pathname);
  try {
    if (req.method === 'OPTIONS') return cors(res);

    if (pathname.startsWith('/api/')) {
      const ctx = { pathname, method: req.method, query: u.searchParams };

      if (pathname === '/api/health') {
        return json(res, 200, { ok: true, llm: !!config.LLM_KEY, model: config.LLM_MODEL });
      }

      // 认证类路由：注册 / 登录 / 登出（无需登录态）
      if (await authRoutes(req, res, { ...ctx, me: null })) return;

      // 其余路由均需登录
      const me = currentUser(req);
      if (!me) return json(res, 401, { error: '请先登录' });
      for (const route of PROTECTED_ROUTES) {
        if (await route(req, res, { ...ctx, me })) return;
      }
      return json(res, 404, { error: 'not found' });
    }

    return serveStatic(res, pathname);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(config.PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  拾页已启动: http://localhost:' + config.PORT + '（局域网/公网用户请用对应地址访问）');
  console.log('  AI 能力: ' + (config.LLM_KEY ? '已连接 (' + config.LLM_MODEL + ')' : '未配置 key，运行在演示模式'));
  console.log('  演示账号: demo / demo123');
  console.log('');
});