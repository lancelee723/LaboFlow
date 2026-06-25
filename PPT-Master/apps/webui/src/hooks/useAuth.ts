import { useQuery, useQueryClient } from "@tanstack/react-query"
import { create } from "zustand"

interface User {
  id: string
  email: string
  name: string | null
  locale: string
  role: "admin" | "creator" | "viewer"
  is_server_admin: boolean
  mustChangePassword: boolean
}

interface AuthState {
  user: User | null
  setUser: (user: User | null) => void
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
  logout: async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" })
    set({ user: null })
  },
}))

export function useAuth() {
  const queryClient = useQueryClient()
  const { user, setUser } = useAuthStore()

  const { isLoading } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" })
      if (!res.ok) {
        if (res.status === 401) {
          setUser(null)
          return null
        }
        throw new Error("Failed to fetch user")
      }
      const data = await res.json()
      setUser(data)
      return data
    },
    retry: false,
  })

  const login = async (email: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.detail || "Login failed")
    }
    const data = await res.json()
    setUser(data.user)
    queryClient.invalidateQueries({ queryKey: ["auth"] })
    return data
  }

  return { user, isLoading, login, logout: useAuthStore.getState().logout }
}
