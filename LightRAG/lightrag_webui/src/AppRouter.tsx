import '@/lib/extensions'; // Import all global extensions
import { HashRouter as Router, Routes, Route, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/state'
import { navigationService } from '@/services/navigation'
import { ssoLogin } from '@/api/lightrag'
import { Toaster } from 'sonner'
import App from './App'
import LoginPage from '@/features/LoginPage'
import ThemeProvider from '@/components/ThemeProvider'

const AppContent = () => {
  const [initializing, setInitializing] = useState(true)
  const { isAuthenticated, login } = useAuthStore()
  const navigate = useNavigate()

  // Set navigate function for navigation service
  useEffect(() => {
    navigationService.setNavigate(navigate)
  }, [navigate])

  // Token validity check
  useEffect(() => {

    const checkAuth = async () => {
      try {
        // Handle SSO token from URL (e.g. /kb/?sso_token=<clawith_jwt>)
        // This is outside the hash, so we read from window.location.search
        const urlParams = new URLSearchParams(window.location.search)
        const ssoToken = urlParams.get('sso_token')
        if (ssoToken) {
          try {
            const response = await ssoLogin(ssoToken)
            if (response.access_token) {
              login(response.access_token, false, response.core_version, response.api_version, response.webui_title || null, response.webui_description || null)
              // Clean URL — remove sso_token from search params
              urlParams.delete('sso_token')
              const cleanSearch = urlParams.toString() ? `?${urlParams.toString()}` : ''
              window.history.replaceState({}, '', `${window.location.pathname}${cleanSearch}${window.location.hash}`)
              setInitializing(false)
              navigate('/')
              return
            }
          } catch (error) {
            console.error('SSO login failed:', error)
            // Fall through to normal auth check
          }
        }

        const token = localStorage.getItem('LIGHTRAG-API-TOKEN')

        if (token && isAuthenticated) {
          setInitializing(false);
          return;
        }

        if (!token) {
          useAuthStore.getState().logout()
        }
      } catch (error) {
        console.error('Auth initialization error:', error)
        if (!isAuthenticated) {
          useAuthStore.getState().logout()
        }
      } finally {
        setInitializing(false)
      }
    }

    checkAuth()

    return () => {
    }
  }, [isAuthenticated])

  // Redirect effect for protected routes
  useEffect(() => {
    if (!initializing && !isAuthenticated) {
      const currentPath = window.location.hash.slice(1);
      if (currentPath !== '/login') {
        console.log('Not authenticated, redirecting to login');
        navigate('/login');
      }
    }
  }, [initializing, isAuthenticated, navigate]);

  // Show nothing while initializing
  if (initializing) {
    return null
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={isAuthenticated ? <App /> : null}
      />
    </Routes>
  )
}

const AppRouter = () => {
  return (
    <ThemeProvider>
      <Router>
        <AppContent />
        <Toaster
          position="bottom-center"
          theme="system"
          closeButton
          richColors
        />
      </Router>
    </ThemeProvider>
  )
}

export default AppRouter
