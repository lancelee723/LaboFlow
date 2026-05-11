<template>
  <div class="sso-container">
    <div class="sso-card">
      <h2 v-if="loading">{{ $t('sso.authenticating', 'Authenticating...') }}</h2>
      <h2 v-else-if="error">{{ $t('sso.failed', 'SSO Login Failed') }}</h2>
      <p v-if="error" class="error-message">{{ error }}</p>
      <div v-if="loading" class="spinner"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { post } from '@/utils/request'

const router = useRouter()
const authStore = useAuthStore()

const loading = ref(true)
const error = ref('')

interface SSOLoginResponse {
  success: boolean
  message?: string
  user?: {
    id: string
    username: string
    email: string
    avatar?: string
    tenant_id: number
    can_access_all_tenants?: boolean
    is_active: boolean
    created_at: string
    updated_at: string
  }
  tenant?: {
    id: number
    name: string
    api_key: string
  }
  token?: string
  refresh_token?: string
}

onMounted(async () => {
  try {
    const urlParams = new URLSearchParams(window.location.search)
    const token = urlParams.get('token')

    if (!token) {
      error.value = 'Missing SSO token'
      loading.value = false
      return
    }

    const response = await post('/api/v1/auth/sso/clawith', { token }) as SSOLoginResponse

    if (!response.success) {
      error.value = response.message || 'SSO authentication failed'
      loading.value = false
      return
    }

    // Store auth data
    if (response.user && response.tenant && response.token) {
      authStore.setUser({
        id: response.user.id || '',
        username: response.user.username || '',
        email: response.user.email || '',
        avatar: response.user.avatar,
        tenant_id: String(response.user.tenant_id || response.tenant.id || ''),
        can_access_all_tenants: response.user.can_access_all_tenants || false,
        created_at: response.user.created_at || new Date().toISOString(),
        updated_at: response.user.updated_at || new Date().toISOString()
      })
      authStore.setToken(response.token)
      if (response.refresh_token) {
        authStore.setRefreshToken(response.refresh_token)
      }
      authStore.setTenant({
        id: String(response.tenant.id) || '',
        name: response.tenant.name || '',
        api_key: response.tenant.api_key || '',
        owner_id: response.user.id || '',
        created_at: response.tenant.created_at || new Date().toISOString(),
        updated_at: response.tenant.updated_at || new Date().toISOString()
      })
    }

    // Redirect to main page
    router.push('/platform/knowledge-bases')
  } catch (err: any) {
    error.value = err.message || 'SSO authentication failed'
    loading.value = false
  }
})
</script>

<style scoped>
.sso-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: var(--bg-primary, #f5f5f5);
}

.sso-card {
  text-align: center;
  padding: 40px;
  background: var(--bg-secondary, #fff);
  border-radius: 12px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
  max-width: 400px;
  width: 100%;
}

.sso-card h2 {
  margin: 0 0 16px;
  font-size: 20px;
  color: var(--text-primary, #333);
}

.error-message {
  color: var(--error, #e53e3e);
  font-size: 14px;
  margin: 0;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-subtle, #e2e8f0);
  border-top-color: var(--accent-primary, #3b82f6);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 16px auto 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
