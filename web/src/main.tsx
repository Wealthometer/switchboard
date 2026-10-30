import "@fontsource-variable/bricolage-grotesque"
import "@fontsource/instrument-sans/400.css"
import "@fontsource/instrument-sans/500.css"
import "@fontsource/instrument-sans/600.css"
import "./styles.css"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom"
import { ApiError } from "./api"
import { Login, Register } from "./pages/Auth"
import { Contacts } from "./pages/Contacts"
import { Home, Invite, Onboarding } from "./pages/Home"
import { Inbox } from "./pages/Inbox"
import { NewTicket } from "./pages/NewTicket"
import { PortalHome, PortalRequest } from "./pages/Portal"
import { Reports } from "./pages/Reports"
import { Settings } from "./pages/Settings"
import { Shell } from "./pages/Shell"
import { OrgProvider, RequireUser } from "./session"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: true },
  },
})

const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  { path: "/register", element: <Register /> },
  { path: "/invite/:token", element: <Invite /> },
  { path: "/portal/:slug", element: <PortalHome /> },
  { path: "/portal/:slug/requests/:number", element: <PortalRequest /> },
  { path: "/", element: <RequireUser><Home /></RequireUser> },
  { path: "/new-org", element: <RequireUser><Onboarding /></RequireUser> },
  {
    path: "/o/:slug",
    element: (
      <RequireUser>
        <OrgProvider>
          <Shell />
        </OrgProvider>
      </RequireUser>
    ),
    children: [
      { index: true, element: <Navigate to="tickets" replace /> },
      { path: "tickets", element: <Inbox /> },
      { path: "tickets/new", element: <NewTicket /> },
      { path: "tickets/:number", element: <Inbox /> },
      { path: "contacts", element: <Contacts /> },
      { path: "reports", element: <Reports /> },
      { path: "settings/*", element: <Settings /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
])

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
