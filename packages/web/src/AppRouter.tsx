import React, { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AppLayout from './App'

const HomePage = lazy(() => import('./pages/HomePage'))
const CostsPage = lazy(() => import('./pages/CostsPage'))
const TopUsagePage = lazy(() => import('./pages/TopUsagePage'))
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'))
const RepositoriesPage = lazy(() => import('./pages/RepositoriesPage'))
const RepoDetailPage = lazy(() => import('./pages/RepoDetailPage'))
const ActionsPage = lazy(() => import('./pages/ActionsPage'))
const MembersPage = lazy(() => import('./pages/MembersPage'))
const TagsPage = lazy(() => import('./pages/TagsPage'))
const TasksPage = lazy(() => import('./pages/TasksPage'))
const TagDetailPage = lazy(() => import('./pages/TagDetailPage'))
const ToolsPage = lazy(() => import('./pages/ToolsPage'))
const CustomPage = lazy(() => import('./pages/CustomPage'))
const ComparePage = lazy(() => import('./pages/ComparePage'))
const ExportPage = lazy(() => import('./pages/ExportPage'))
const SessionsPage = lazy(() => import('./pages/SessionsPage'))
const WorkflowsPage = lazy(() => import('./pages/WorkflowsPage'))
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'))
const PreferencesSettings = lazy(() => import('./pages/settings/PreferencesSettings'))
const AccessibilitySettings = lazy(() => import('./pages/settings/AccessibilitySettings'))
const NotificationsSettings = lazy(() => import('./pages/settings/NotificationsSettings'))
const SessionsSettings = lazy(() => import('./pages/settings/SessionsSettings'))
const DataSourcesSettings = lazy(() => import('./pages/settings/DataSourcesSettings'))
const BackupSettings = lazy(() => import('./pages/settings/BackupSettings'))
const HarnessesSettings = lazy(() => import('./pages/settings/HarnessesSettings'))
const InstallSettings = lazy(() => import('./pages/settings/InstallSettings'))
const ConnectionSettings = lazy(() => import('./pages/settings/ConnectionSettings'))
const LiveSettings = lazy(() => import('./pages/settings/LiveSettings'))
const ChatSettings = lazy(() => import('./pages/settings/ChatSettings'))
const UsersSettings = lazy(() => import('./pages/settings/UsersSettings'))
const TeamsSettings = lazy(() => import('./pages/settings/TeamsSettings'))
const MachinesSettings = lazy(() => import('./pages/settings/MachinesSettings'))
const ReposSettingsPage = lazy(() => import('./pages/settings/ReposSettingsPage'))
const PricingSettings = lazy(() => import('./pages/settings/PricingSettings'))
const BillingSettings = lazy(() => import('./pages/settings/BillingSettings'))

function PageFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 340, padding: 40 }}>
      <div className="ag-loader" role="status" aria-label="Loading">
        <div className="ag-loader-bars" aria-hidden="true">
          <span /><span /><span /><span /><span />
        </div>
        <div className="ag-loader-label">agentistics</div>
      </div>
    </div>
  )
}

export default function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Suspense fallback={<PageFallback />}><HomePage /></Suspense>} />
          <Route path="costs" element={<Suspense fallback={<PageFallback />}><CostsPage /></Suspense>} />
          <Route path="top" element={<Suspense fallback={<PageFallback />}><TopUsagePage /></Suspense>} />
          {/* The sessions WORKSPACE. `:sessionId` is optional because the workspace has a landing
              state of its own — the active fleet's summary — rather than being blank until you pick
              something. One route with an optional segment, not two, so the aside stays mounted and
              the list does not flash on every selection. */}
          <Route path="sessions" element={<Suspense fallback={<PageFallback />}><SessionsPage /></Suspense>} />
          <Route path="sessions/:sessionId" element={<Suspense fallback={<PageFallback />}><SessionsPage /></Suspense>} />
          <Route path="workflows" element={<Suspense fallback={<PageFallback />}><WorkflowsPage /></Suspense>} />
          <Route path="projects" element={<Suspense fallback={<PageFallback />}><ProjectsPage /></Suspense>} />
          <Route path="repositories" element={<Suspense fallback={<PageFallback />}><RepositoriesPage /></Suspense>} />
          <Route path="repositories/actions" element={<Suspense fallback={<PageFallback />}><ActionsPage /></Suspense>} />
          <Route path="repo/:id" element={<Suspense fallback={<PageFallback />}><RepoDetailPage /></Suspense>} />
          <Route path="members" element={<Suspense fallback={<PageFallback />}><MembersPage /></Suspense>} />
          <Route path="tasks" element={<Suspense fallback={<PageFallback />}><TasksPage /></Suspense>} />
          <Route path="tasks/:id" element={<Suspense fallback={<PageFallback />}><TasksPage /></Suspense>} />
          <Route path="tags" element={<Suspense fallback={<PageFallback />}><TagsPage /></Suspense>} />
          <Route path="tags/:id" element={<Suspense fallback={<PageFallback />}><TagDetailPage /></Suspense>} />
          <Route path="tools" element={<Suspense fallback={<PageFallback />}><ToolsPage /></Suspense>} />
          <Route path="custom" element={<Suspense fallback={<PageFallback />}><CustomPage /></Suspense>} />
          {/* Hardware stopped being a page — it is a modal opened from the sticky header (and from
              the mobile "More" sheet). The route is kept as a redirect so an existing bookmark
              lands somewhere rather than on a blank screen: this router has no catch-all. */}
          <Route path="hardware" element={<Navigate to="/" replace />} />
          <Route path="compare" element={<Suspense fallback={<PageFallback />}><ComparePage /></Suspense>} />
          <Route path="export" element={<Suspense fallback={<PageFallback />}><ExportPage /></Suspense>} />
          <Route path="settings" element={<Suspense fallback={<PageFallback />}><SettingsPage /></Suspense>}>
            <Route index element={<Navigate to="preferences" replace />} />
            <Route path="preferences" element={<Suspense fallback={<PageFallback />}><PreferencesSettings /></Suspense>} />
            <Route path="accessibility" element={<Suspense fallback={<PageFallback />}><AccessibilitySettings /></Suspense>} />
            <Route path="notifications" element={<Suspense fallback={<PageFallback />}><NotificationsSettings /></Suspense>} />
            <Route path="sessions" element={<Suspense fallback={<PageFallback />}><SessionsSettings /></Suspense>} />
            <Route path="data-sources" element={<Suspense fallback={<PageFallback />}><DataSourcesSettings /></Suspense>} />
            <Route path="backup" element={<Suspense fallback={<PageFallback />}><BackupSettings /></Suspense>} />
            <Route path="harnesses" element={<Suspense fallback={<PageFallback />}><HarnessesSettings /></Suspense>} />
            <Route path="pricing" element={<Suspense fallback={<PageFallback />}><PricingSettings /></Suspense>} />
            <Route path="billing" element={<Suspense fallback={<PageFallback />}><BillingSettings /></Suspense>} />
            <Route path="install" element={<Suspense fallback={<PageFallback />}><InstallSettings /></Suspense>} />
            <Route path="connection" element={<Suspense fallback={<PageFallback />}><ConnectionSettings /></Suspense>} />
            <Route path="live" element={<Suspense fallback={<PageFallback />}><LiveSettings /></Suspense>} />
            <Route path="chat" element={<Suspense fallback={<PageFallback />}><ChatSettings /></Suspense>} />
            <Route path="users" element={<Suspense fallback={<PageFallback />}><UsersSettings /></Suspense>} />
            <Route path="teams" element={<Suspense fallback={<PageFallback />}><TeamsSettings /></Suspense>} />
            <Route path="machines" element={<Suspense fallback={<PageFallback />}><MachinesSettings /></Suspense>} />
            <Route path="repositories" element={<Suspense fallback={<PageFallback />}><ReposSettingsPage /></Suspense>} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
