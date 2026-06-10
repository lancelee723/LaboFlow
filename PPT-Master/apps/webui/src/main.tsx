import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import App from "./App"
import "./index.css"

// Global fetch wrapper — auto-prefix BASE_URL on absolute paths so the SPA
// works under a sub-path mount (LaboFlow serves us at /ppt-master/). Without
// this, raw `fetch("/api/...")` calls scattered across the codebase escape
// the sub-path and hit the host root, bypassing nginx's /ppt-master rewrite.
const __FETCH_BASE = import.meta.env.BASE_URL.replace(/\/$/, "")
if (__FETCH_BASE) {
  const __origFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("/") && !input.startsWith("//")) {
      input = `${__FETCH_BASE}${input}`
    }
    return __origFetch(input as RequestInfo, init)
  }) as typeof window.fetch
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
