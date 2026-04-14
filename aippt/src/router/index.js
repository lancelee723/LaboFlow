import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    // 特殊页面路由 - 必须放在通配符之前
    {
      path: '/',
      name: 'Home',
      component: () => import('@/views/home.vue'),
      meta: { requiresAuth: true }
    },
    {
      path: '/workspace',
      name: 'Workspace',
      component: () => import('@/views/home-redirect.vue'),
      meta: { requiresAuth: true }
    },
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/views/login.vue'),
    },
    {
      path: '/slide/:docId',
      name: 'Slide',
      component: () => import('@/views/slide-page/slide-page.vue'),
      meta: { requiresAuth: true }
    },
    {
      path: '/ai-create',
      name: 'AiCreate',
      component: () => import('@/views/ai-create.vue'),
      meta: { requiresAuth: true }
    },
    // 通配符路由 - 必须放在最后，用于文档编辑
    {
      path: '/:pathMatch(.*)*',
      name: 'notion',
      component: () => import('@/views/slide-page/slide-page.vue'),
      meta: { requiresAuth: true }
    },
  ]
})

// SSO token handler: verify Clawith JWT and store auth info
async function handleSsoToken(ssoToken) {
  try {
    const baseUrl = import.meta.env.BASE_URL || '/'
    const response = await fetch(`${baseUrl}api/auth/sso/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ssoToken }),
    })
    if (!response.ok) return false
    const result = await response.json()
    if (result?.code === 200 && result?.data?.token) {
      const { token, user } = result.data
      localStorage.setItem('jwt_token', token)
      localStorage.setItem('uid', user?.id || 'sso_user')
      localStorage.setItem('username', user?.username || user?.email || 'SSO User')
      localStorage.setItem('userRole', user?.role || '0')
      return true
    }
  } catch (error) {
    console.error('[SSO] Token verification failed:', error)
  }
  return false
}

router.beforeEach(async (to, from, next) => {
  // 调试日志：确认路由匹配
  console.log('[Router] 路由导航:', {
    toPath: to.path,
    toName: to.name,
    fromPath: from.path,
    fromName: from.name,
    fullPath: to.fullPath
  })

  // Handle SSO token from URL (e.g. /ppt/?sso_token=<clawith_jwt>)
  const ssoToken = to.query?.sso_token
  if (ssoToken) {
    const success = await handleSsoToken(ssoToken)
    if (success) {
      // Remove sso_token from query and redirect to target path
      const query = { ...to.query }
      delete query.sso_token
      next({ path: to.path, query, replace: true })
      return
    }
  }

  const isAuthenticated = localStorage.getItem('uid')

  if (to.name === 'Login') {
    const force = to.query?.force === '1'
    if (isAuthenticated && !force) {
      next({ path: '/' })
    } else {
      next()
    }
    return
  }

  if (!isAuthenticated && to.meta.requiresAuth) {
    next({ name: 'Login', query: { redirect: to.fullPath } })
    return
  }

  next()
})

export default router
