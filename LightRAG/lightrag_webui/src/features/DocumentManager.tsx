import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@/stores/settings'
import Button from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import EmptyCard from '@/components/ui/EmptyCard'
import Checkbox from '@/components/ui/Checkbox'
import UploadDocumentsDialog from '@/components/documents/UploadDocumentsDialog'
import ClearDocumentsDialog from '@/components/documents/ClearDocumentsDialog'
import DeleteDocumentsDialog from '@/components/documents/DeleteDocumentsDialog'
import MoveToFolderDialog from '@/components/documents/MoveToFolderDialog'
import PipelineStatusDialog from '@/components/documents/PipelineStatusDialog'
import PaginationControls from '@/components/ui/PaginationControls'
import FolderTree from '@/components/documents/FolderTree'

import {
  scanNewDocuments,
  getDocumentsPaginatedWithTimeout,
  getFolders,
  type DocsStatusesResponse,
  type DocStatus,
  type DocStatusResponse,
  type DocumentsRequest,
  type PaginationInfo,
  type Folder
} from '@/api/lightrag'
import { errorMessage } from '@/lib/utils'
import { toast } from 'sonner'
import { useBackendState } from '@/stores/state'

import {
  RefreshCwIcon,
  ActivityIcon,
  RotateCcwIcon,
  CheckSquareIcon,
  XIcon,
  AlertTriangle,
  FileTextIcon,
  FileIcon,
  FileSpreadsheetIcon,
  PresentationIcon
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

type StatusFilter = DocStatus | 'all'
type SortField = 'created_at' | 'updated_at' | 'id' | 'file_path'
type SortDirection = 'asc' | 'desc'
type QuerySnapshot = {
  statusFilter: StatusFilter
  page: number
  pageSize: number
  sortField: SortField
  sortDirection: SortDirection
  folderId: string | null
}
type RefreshRequest =
  | { type: 'intelligent'; query: QuerySnapshot; customTimeout?: number; requestVersion: number }
  | { type: 'manual'; query: QuerySnapshot; requestVersion: number }

// ─── Utilities ────────────────────────────────────────────────────────────────

const getCountValue = (counts: Record<string, number>, ...keys: string[]): number => {
  for (const key of keys) {
    const value = counts[key]
    if (typeof value === 'number') return value
  }
  return 0
}

const hasActiveDocumentsStatus = (counts: Record<string, number>): boolean =>
  getCountValue(counts, 'PROCESSING', 'processing') > 0 ||
  getCountValue(counts, 'PENDING', 'pending') > 0 ||
  getCountValue(counts, 'PREPROCESSED', 'preprocessed') > 0

const getDisplayFileName = (doc: DocStatusResponse): string => {
  if (!doc.file_path || typeof doc.file_path !== 'string' || !doc.file_path.trim()) return doc.id
  const parts = doc.file_path.split('/')
  return parts[parts.length - 1] || doc.id
}

function getFileIcon(filePath: string | undefined) {
  if (!filePath) return <FileIcon className="size-4 text-[#a39e98]" />
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return <FileTextIcon className="size-4 text-[#dd5b00]" />
  if (['xlsx', 'csv'].includes(ext ?? '')) return <FileSpreadsheetIcon className="size-4 text-[#2a9d99]" />
  if (['pptx', 'ppt'].includes(ext ?? '')) return <PresentationIcon className="size-4 text-[#ff64c8]" />
  if (['docx', 'doc', 'txt', 'md'].includes(ext ?? '')) return <FileTextIcon className="size-4 text-[#0075de]" />
  return <FileIcon className="size-4 text-[#a39e98]" />
}

function StatusBadge({ status }: { status: DocStatus }) {
  const { t } = useTranslation()
  const map: Record<DocStatus, { cls: string; key: string }> = {
    processed:    { cls: 'bg-[#dcfce7] text-[#166534]', key: 'documentPanel.documentManager.status.completed' },
    preprocessed: { cls: 'bg-[#f3e8ff] text-[#6b21a8]', key: 'documentPanel.documentManager.status.preprocessed' },
    processing:   { cls: 'bg-[#dbeafe] text-[#1e40af]', key: 'documentPanel.documentManager.status.processing' },
    pending:      { cls: 'bg-[#fef3c7] text-[#92400e]', key: 'documentPanel.documentManager.status.pending' },
    failed:       { cls: 'bg-[#fee2e2] text-[#991b1b]', key: 'documentPanel.documentManager.status.failed' }
  }
  const { cls, key } = map[status] ?? { cls: 'bg-[#f1efec] text-[#615d59]', key: status }
  return (
    <span className={cn('shrink-0 rounded-[9999px] px-2 py-0.5 text-[11px] font-semibold leading-none', cls)}>
      {t(key)}
    </span>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DocumentManager() {
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    const handleBeforeUnload = () => { isMountedRef.current = false }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => { isMountedRef.current = false; window.removeEventListener('beforeunload', handleBeforeUnload) }
  }, [])

  const [showPipelineStatus, setShowPipelineStatus] = useState(false)
  const { t } = useTranslation()
  const health = useBackendState.use.health()
  const pipelineBusy = useBackendState.use.pipelineBusy()

  // ── Folder state ──────────────────────────────────────────────────────────
  const [folders, setFolders] = useState<Folder[]>([])
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null)

  const loadFolders = useCallback(async () => {
    try {
      const data = await getFolders()
      if (isMountedRef.current) setFolders(data)
    } catch (err) {
      if (isMountedRef.current) {
        toast.error(t('documentPanel.folders.loadError', { error: errorMessage(err) }))
      }
    }
  }, [t])

  useEffect(() => { loadFolders() }, [loadFolders])

  // ── Document state (existing logic preserved) ─────────────────────────────
  const [docs, setDocs] = useState<DocsStatusesResponse | null>(null)
  const currentTab = useSettingsStore.use.currentTab()
  const documentsPageSize = useSettingsStore.use.documentsPageSize()
  const setDocumentsPageSize = useSettingsStore.use.setDocumentsPageSize()

  const [currentPageDocs, setCurrentPageDocs] = useState<DocStatusResponse[]>([])
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1, page_size: documentsPageSize,
    total_count: 0, total_pages: 0, has_next: false, has_prev: false
  })
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({ all: 0 })
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [sortField, setSortField] = useState<SortField>('updated_at')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [pageByStatus, setPageByStatus] = useState<Record<StatusFilter, number>>({
    all: 1, processed: 1, preprocessed: 1, processing: 1, pending: 1, failed: 1
  })
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([])
  const isSelectionMode = selectedDocIds.length > 0

  const prevPipelineBusyRef = useRef<boolean | undefined>(undefined)
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeRefreshPromiseRef = useRef<Promise<void> | null>(null)
  const pendingRefreshRequestRef = useRef<RefreshRequest | null>(null)
  const latestRefreshRequestVersionRef = useRef(0)

  const [retryState, setRetryState] = useState({ count: 0, lastError: null as Error | null, isBackingOff: false })
  const [circuitBreakerState, setCircuitBreakerState] = useState({
    isOpen: false, failureCount: 0, lastFailureTime: null as number | null, nextRetryTime: null as number | null
  })

  // ── Folder doc counts for the tree ────────────────────────────────────────
  const folderDocCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = { __all__: statusCounts.all ?? 0 }
    folders.forEach((f) => { counts[f.id] = 0 })
    return counts
  }, [folders, statusCounts.all])

  const handleDocumentSelect = useCallback((docId: string, checked: boolean) => {
    setSelectedDocIds(prev => checked ? [...prev, docId] : prev.filter(id => id !== docId))
  }, [])
  const handleDeselectAll = useCallback(() => { setSelectedDocIds([]) }, [])

  const currentPageDocIds = useMemo(() => currentPageDocs.map(doc => doc.id), [currentPageDocs])
  const selectedCurrentPageCount = useMemo(() =>
    currentPageDocIds.filter(id => selectedDocIds.includes(id)).length, [currentPageDocIds, selectedDocIds])
  const isCurrentPageFullySelected = useMemo(() =>
    currentPageDocIds.length > 0 && selectedCurrentPageCount === currentPageDocIds.length,
  [currentPageDocIds, selectedCurrentPageCount])

  const handleSelectCurrentPage = useCallback(() => { setSelectedDocIds(currentPageDocIds) }, [currentPageDocIds])

  const documentCounts = useMemo(() => {
    if (!docs) return { all: 0 } as Record<string, number>
    const counts: Record<string, number> = { all: 0 }
    Object.entries(docs.statuses).forEach(([status, documents]) => {
      counts[status as DocStatus] = documents.length
      counts.all += documents.length
    })
    return counts
  }, [docs])

  const processedCount = getCountValue(statusCounts, 'PROCESSED', 'processed') || documentCounts.processed || 0
  const preprocessedCount = getCountValue(statusCounts, 'PREPROCESSED', 'preprocessed') || documentCounts.preprocessed || 0
  const processingCount = getCountValue(statusCounts, 'PROCESSING', 'processing') || documentCounts.processing || 0
  const pendingCount = getCountValue(statusCounts, 'PENDING', 'pending') || documentCounts.pending || 0
  const failedCount = getCountValue(statusCounts, 'FAILED', 'failed') || documentCounts.failed || 0

  const prevStatusCounts = useRef({ processed: 0, preprocessed: 0, processing: 0, pending: 0, failed: 0 })

  const buildQuerySnapshot = useCallback((overrides: Partial<QuerySnapshot> = {}): QuerySnapshot => ({
    statusFilter: overrides.statusFilter ?? statusFilter,
    page: overrides.page ?? pagination.page,
    pageSize: overrides.pageSize ?? pagination.page_size,
    sortField: overrides.sortField ?? sortField,
    sortDirection: overrides.sortDirection ?? sortDirection,
    folderId: overrides.folderId !== undefined ? overrides.folderId : activeFolderId
  }), [pagination.page, pagination.page_size, sortField, sortDirection, statusFilter, activeFolderId])

  const buildDocumentsRequest = useCallback((query: QuerySnapshot, page: number = query.page): DocumentsRequest => ({
    status_filter: query.statusFilter === 'all' ? null : query.statusFilter,
    page,
    page_size: query.pageSize,
    sort_field: query.sortField,
    sort_direction: query.sortDirection,
    folder_id: query.folderId
  }), [])

  const updateComponentState = useCallback((response: any) => {
    setPagination(response.pagination)
    setCurrentPageDocs(response.documents)
    setStatusCounts(response.status_counts)
    const legacyDocs: DocsStatusesResponse = {
      statuses: {
        processed: response.documents.filter((d: DocStatusResponse) => d.status === 'processed'),
        preprocessed: response.documents.filter((d: DocStatusResponse) => d.status === 'preprocessed'),
        processing: response.documents.filter((d: DocStatusResponse) => d.status === 'processing'),
        pending: response.documents.filter((d: DocStatusResponse) => d.status === 'pending'),
        failed: response.documents.filter((d: DocStatusResponse) => d.status === 'failed')
      }
    }
    setDocs(response.pagination.total_count > 0 ? legacyDocs : null)
  }, [])

  const classifyError = useCallback((error: any) => {
    if (error.name === 'AbortError') return { type: 'cancelled', shouldRetry: false, shouldShowToast: false }
    if (error.message === 'Request timeout') return { type: 'timeout', shouldRetry: true, shouldShowToast: true }
    if (error.message?.includes('Network Error') || error.code === 'NETWORK_ERROR') return { type: 'network', shouldRetry: true, shouldShowToast: true }
    if (error.status >= 500) return { type: 'server', shouldRetry: true, shouldShowToast: true }
    if (error.status >= 400 && error.status < 500) return { type: 'client', shouldRetry: false, shouldShowToast: true }
    return { type: 'unknown', shouldRetry: true, shouldShowToast: true }
  }, [])

  const isCircuitBreakerOpen = useCallback(() => {
    if (!circuitBreakerState.isOpen) return false
    const now = Date.now()
    if (circuitBreakerState.nextRetryTime && now >= circuitBreakerState.nextRetryTime) {
      setCircuitBreakerState(prev => ({ ...prev, isOpen: false, failureCount: Math.max(0, prev.failureCount - 1) }))
      return false
    }
    return true
  }, [circuitBreakerState])

  const recordFailure = useCallback((error: Error) => {
    const now = Date.now()
    setCircuitBreakerState(prev => {
      const newFailureCount = prev.failureCount + 1
      const shouldOpen = newFailureCount >= 3
      return { isOpen: shouldOpen, failureCount: newFailureCount, lastFailureTime: now, nextRetryTime: shouldOpen ? now + (Math.pow(2, newFailureCount) * 1000) : null }
    })
    setRetryState(prev => ({ count: prev.count + 1, lastError: error, isBackingOff: true }))
  }, [])

  const recordSuccess = useCallback(() => {
    setCircuitBreakerState({ isOpen: false, failureCount: 0, lastFailureTime: null, nextRetryTime: null })
    setRetryState({ count: 0, lastError: null, isBackingOff: false })
  }, [])

  const handlePageSizeChange = useCallback((newPageSize: number) => {
    if (newPageSize === pagination.page_size) return
    setDocumentsPageSize(newPageSize)
    setPageByStatus({ all: 1, processed: 1, preprocessed: 1, processing: 1, pending: 1, failed: 1 })
    setPagination(prev => ({ ...prev, page: 1, page_size: newPageSize }))
  }, [pagination.page_size, setDocumentsPageSize])

  const runRefreshRequest = useCallback(async (refreshRequest: RefreshRequest) => {
    try {
      if (!isMountedRef.current) return
      setIsRefreshing(true)
      const { query, requestVersion } = refreshRequest
      const isStaleRequest = () => requestVersion !== latestRefreshRequestVersionRef.current

      if (refreshRequest.type === 'manual') {
        const request = buildDocumentsRequest(query, 1)
        const response = await getDocumentsPaginatedWithTimeout(request)
        if (!isMountedRef.current || isStaleRequest()) return
        if (response.pagination.total_count < query.pageSize && query.pageSize !== 10) {
          handlePageSizeChange(10)
        } else {
          updateComponentState(response)
        }
      } else {
        const { customTimeout } = refreshRequest
        const pageToFetch = query.page
        const request = buildDocumentsRequest(query, pageToFetch)
        const response = await getDocumentsPaginatedWithTimeout(request, customTimeout)
        if (!isMountedRef.current || isStaleRequest()) return
        if (response.documents.length === 0 && response.pagination.total_count > 0) {
          const lastPage = Math.max(1, response.pagination.total_pages)
          if (pageToFetch !== lastPage) {
            const lastPageResponse = await getDocumentsPaginatedWithTimeout(buildDocumentsRequest(query, lastPage), customTimeout)
            if (!isMountedRef.current || isStaleRequest()) return
            setPageByStatus(prev => ({ ...prev, [query.statusFilter]: lastPage }))
            updateComponentState(lastPageResponse)
            return
          }
        }
        setPageByStatus(prev => prev[query.statusFilter] === pageToFetch ? prev : { ...prev, [query.statusFilter]: pageToFetch })
        updateComponentState(response)
      }
    } catch (err) {
      if (isMountedRef.current) {
        const classification = classifyError(err)
        if (classification.shouldShowToast) toast.error(t('documentPanel.documentManager.errors.loadFailed', { error: errorMessage(err) }))
        if (classification.shouldRetry) recordFailure(err as Error)
      }
    } finally {
      if (isMountedRef.current) setIsRefreshing(false)
    }
  }, [t, updateComponentState, classifyError, recordFailure, handlePageSizeChange, buildDocumentsRequest])

  const enqueueRefresh = useCallback(async (refreshRequest: RefreshRequest) => {
    if (activeRefreshPromiseRef.current) {
      pendingRefreshRequestRef.current = refreshRequest
      await activeRefreshPromiseRef.current
      return
    }
    const loop = (async () => {
      let next: RefreshRequest | null = refreshRequest
      while (next) {
        pendingRefreshRequestRef.current = null
        await runRefreshRequest(next)
        next = pendingRefreshRequestRef.current
      }
    })()
    activeRefreshPromiseRef.current = loop
    try { await loop } finally {
      if (activeRefreshPromiseRef.current === loop) activeRefreshPromiseRef.current = null
      pendingRefreshRequestRef.current = null
    }
  }, [runRefreshRequest])

  const handleIntelligentRefresh = useCallback(async (targetPage?: number, resetToFirst?: boolean, customTimeout?: number) => {
    const page = resetToFirst ? 1 : (targetPage || pagination.page)
    await enqueueRefresh({ type: 'intelligent', query: buildQuerySnapshot({ page }), customTimeout, requestVersion: latestRefreshRequestVersionRef.current })
  }, [buildQuerySnapshot, enqueueRefresh, pagination.page])

  const fetchPaginatedDocuments = useCallback(async (page: number, pageSize: number, currentStatusFilter: StatusFilter) => {
    setPagination(prev => ({ ...prev, page, page_size: pageSize }))
    await enqueueRefresh({
      type: 'intelligent',
      query: buildQuerySnapshot({ page, pageSize, statusFilter: currentStatusFilter }),
      requestVersion: latestRefreshRequestVersionRef.current
    })
  }, [buildQuerySnapshot, enqueueRefresh])

  const fetchDocuments = useCallback(async () => {
    await fetchPaginatedDocuments(pagination.page, pagination.page_size, statusFilter)
  }, [fetchPaginatedDocuments, pagination.page, pagination.page_size, statusFilter])

  const clearPollingInterval = useCallback(() => {
    if (pollingIntervalRef.current) { clearInterval(pollingIntervalRef.current); pollingIntervalRef.current = null }
  }, [])

  const startPollingInterval = useCallback((intervalMs: number) => {
    clearPollingInterval()
    pollingIntervalRef.current = setInterval(async () => {
      if (isCircuitBreakerOpen() || !isMountedRef.current) return
      try { await fetchDocuments(); recordSuccess() }
      catch (err) {
        if (!isMountedRef.current) return
        setIsRefreshing(false)
        const classification = classifyError(err)
        if (classification.shouldShowToast) toast.error(t('documentPanel.documentManager.errors.scanProgressFailed', { error: errorMessage(err) }))
        if (classification.shouldRetry) {
          recordFailure(err as Error)
          if (retryState.count < 3) setTimeout(() => { if (isMountedRef.current) setRetryState(prev => ({ ...prev, isBackingOff: false })) }, Math.min(Math.pow(2, retryState.count) * 1000, 30000))
        } else { clearPollingInterval() }
      }
    }, intervalMs)
  }, [fetchDocuments, t, clearPollingInterval, isCircuitBreakerOpen, recordSuccess, recordFailure, classifyError, retryState.count])

  const scanDocuments = useCallback(async () => {
    try {
      if (!isMountedRef.current) return
      const { status, message } = await scanNewDocuments()
      if (!isMountedRef.current) return
      toast.message(message || status)
      useBackendState.getState().resetHealthCheckTimerDelayed(1000)
      await handleIntelligentRefresh(undefined, false, 90000)
      startPollingInterval(2000)
      setTimeout(() => {
        if (isMountedRef.current && currentTab === 'documents' && health) {
          startPollingInterval(hasActiveDocumentsStatus(statusCounts) ? 5000 : 30000)
        }
      }, 15000)
    } catch (err) {
      if (isMountedRef.current) toast.error(t('documentPanel.documentManager.errors.scanFailed', { error: errorMessage(err) }))
    }
  }, [t, startPollingInterval, currentTab, health, statusCounts, handleIntelligentRefresh])

  const handleManualRefresh = useCallback(async () => {
    await enqueueRefresh({ type: 'manual', query: buildQuerySnapshot(), requestVersion: latestRefreshRequestVersionRef.current })
  }, [buildQuerySnapshot, enqueueRefresh])

  const handlePageChange = useCallback((newPage: number) => {
    if (newPage === pagination.page) return
    setPageByStatus(prev => ({ ...prev, [statusFilter]: newPage }))
    setPagination(prev => ({ ...prev, page: newPage }))
  }, [pagination.page, statusFilter])

  const handleStatusFilterChange = useCallback((newFilter: StatusFilter) => {
    if (newFilter === statusFilter) return
    setPageByStatus(prev => ({ ...prev, [statusFilter]: pagination.page }))
    const newPage = pageByStatus[newFilter]
    setStatusFilter(newFilter)
    setPagination(prev => ({ ...prev, page: newPage }))
  }, [statusFilter, pagination.page, pageByStatus])

  const handleFolderSelect = useCallback((folderId: string | null) => {
    setActiveFolderId(folderId)
    setSelectedDocIds([])
    setPagination(prev => ({ ...prev, page: 1 }))
    setPageByStatus({ all: 1, processed: 1, preprocessed: 1, processing: 1, pending: 1, failed: 1 })
  }, [])

  const handleDocumentsDeleted = useCallback(async () => {
    setSelectedDocIds([])
    useBackendState.getState().resetHealthCheckTimerDelayed(1000)
    startPollingInterval(2000)
  }, [startPollingInterval])

  const handleDocumentsCleared = useCallback(async () => {
    clearPollingInterval()
    setStatusCounts({ all: 0, processed: 0, processing: 0, pending: 0, failed: 0 })
    if (isMountedRef.current) { try { await fetchDocuments() } catch { /* ignore */ } }
    if (currentTab === 'documents' && health && isMountedRef.current) startPollingInterval(30000)
  }, [clearPollingInterval, fetchDocuments, currentTab, health, startPollingInterval])

  const handleMoved = useCallback(async () => {
    await Promise.all([handleIntelligentRefresh(), loadFolders()])
    setSelectedDocIds([])
  }, [handleIntelligentRefresh, loadFolders])

   
  useEffect(() => { latestRefreshRequestVersionRef.current += 1 }, [pagination.page, pagination.page_size, statusFilter, sortField, sortDirection, activeFolderId])

  useEffect(() => {
    if (prevPipelineBusyRef.current !== undefined && prevPipelineBusyRef.current !== pipelineBusy) {
      if (currentTab === 'documents' && health && isMountedRef.current) {
        handleIntelligentRefresh()
        startPollingInterval(hasActiveDocumentsStatus(statusCounts) ? 5000 : 30000)
      }
    }
    prevPipelineBusyRef.current = pipelineBusy
  }, [pipelineBusy, currentTab, health, handleIntelligentRefresh, statusCounts, startPollingInterval])

  useEffect(() => {
    if (currentTab !== 'documents' || !health) { clearPollingInterval(); return }
    startPollingInterval(hasActiveDocumentsStatus(statusCounts) ? 5000 : 30000)
    return () => { clearPollingInterval() }
  }, [health, t, currentTab, statusCounts, startPollingInterval, clearPollingInterval])

  useEffect(() => {
    if (!docs) return
    const newCounts = {
      processed: docs?.statuses?.processed?.length || 0,
      preprocessed: docs?.statuses?.preprocessed?.length || 0,
      processing: docs?.statuses?.processing?.length || 0,
      pending: docs?.statuses?.pending?.length || 0,
      failed: docs?.statuses?.failed?.length || 0
    }
    const changed = (Object.keys(newCounts) as Array<keyof typeof newCounts>).some(k => newCounts[k] !== prevStatusCounts.current[k])
    if (changed && isMountedRef.current) useBackendState.getState().check()
    prevStatusCounts.current = newCounts
  }, [docs])

  useEffect(() => {
    if (currentTab === 'documents') fetchPaginatedDocuments(pagination.page, pagination.page_size, statusFilter)
  }, [currentTab, pagination.page, pagination.page_size, statusFilter, sortField, sortDirection, fetchPaginatedDocuments])

  useEffect(() => { setSelectedDocIds([]) }, [pagination.page, statusFilter, sortField, sortDirection])

  // Suppress unused-variable lint warnings for sort setters that are kept for future sort UI
  void setSortField
  void setSortDirection

  // ── Render ────────────────────────────────────────────────────────────────

  const statusFilterOptions: { key: StatusFilter; label: string; count: number; color: string }[] = [
    { key: 'all',          label: t('documentPanel.documentManager.status.all'),          count: statusCounts.all || documentCounts.all, color: '' },
    { key: 'processed',    label: t('documentPanel.documentManager.status.completed'),    count: processedCount,    color: 'text-[#166534]' },
    { key: 'preprocessed', label: t('documentPanel.documentManager.status.preprocessed'), count: preprocessedCount, color: 'text-[#6b21a8]' },
    { key: 'processing',   label: t('documentPanel.documentManager.status.processing'),   count: processingCount,   color: 'text-[#1e40af]' },
    { key: 'pending',      label: t('documentPanel.documentManager.status.pending'),      count: pendingCount,      color: 'text-[#92400e]' },
    { key: 'failed',       label: t('documentPanel.documentManager.status.failed'),       count: failedCount,       color: 'text-[#991b1b]' }
  ]

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[rgba(0,0,0,0.1)] px-4">
        {/* Left actions */}
        <Button
          variant="outline" size="sm"
          onClick={scanDocuments}
          tooltip={t('documentPanel.documentManager.scanTooltip')}
          className="rounded-[4px] border-[rgba(0,0,0,0.1)] text-xs"
        >
          <RefreshCwIcon className="size-3.5" />
          {t('documentPanel.documentManager.scanButton')}
        </Button>
        <Button
          variant="outline" size="sm"
          onClick={() => setShowPipelineStatus(true)}
          tooltip={t('documentPanel.documentManager.pipelineStatusTooltip')}
          className={cn('rounded-[4px] border-[rgba(0,0,0,0.1)] text-xs', pipelineBusy && 'animate-pulse border-[rgba(220,87,0,0.4)] bg-[rgba(220,87,0,0.06)]')}
        >
          <ActivityIcon className="size-3.5" />
          {t('documentPanel.documentManager.pipelineStatusButton')}
        </Button>

        {/* Status filter chips */}
        <div className="flex flex-1 items-center gap-1 overflow-x-auto">
          {statusFilterOptions.map(({ key, label, count, color }) => (
            <button
              key={key}
              type="button"
              disabled={isRefreshing}
              onClick={() => handleStatusFilterChange(key)}
              className={cn(
                'shrink-0 rounded-[9999px] px-2.5 py-1 text-[11px] font-semibold transition-colors whitespace-nowrap',
                statusFilter === key
                  ? 'bg-[rgba(0,0,0,0.95)] text-white'
                  : cn('bg-[rgba(0,0,0,0.04)] hover:bg-[rgba(0,0,0,0.08)]', color || 'text-[#615d59]')
              )}
            >
              {label} ({count})
            </button>
          ))}
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-1.5">
          {pagination.total_pages > 1 && (
            <PaginationControls
              currentPage={pagination.page}
              totalPages={pagination.total_pages}
              pageSize={pagination.page_size}
              totalCount={pagination.total_count}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
              isLoading={isRefreshing}
              compact
            />
          )}
          {isSelectionMode && (
            <>
              <DeleteDocumentsDialog
                selectedDocIds={selectedDocIds}
                onDocumentsDeleted={handleDocumentsDeleted}
              />
              <MoveToFolderDialog
                folders={folders}
                selectedDocIds={selectedDocIds}
                onMoved={handleMoved}
              />
              <Button
                variant="outline" size="sm"
                onClick={isCurrentPageFullySelected ? handleDeselectAll : handleSelectCurrentPage}
                className="rounded-[4px] border-[rgba(0,0,0,0.1)] text-xs"
              >
                {isCurrentPageFullySelected
                  ? <><XIcon className="size-3.5" />{t('documentPanel.selectDocuments.deselectAll', { count: currentPageDocIds.length })}</>
                  : <><CheckSquareIcon className="size-3.5" />{t('documentPanel.selectDocuments.selectCurrentPage', { count: currentPageDocIds.length })}</>
                }
              </Button>
            </>
          )}
          {!isSelectionMode && (
            <ClearDocumentsDialog onDocumentsCleared={handleDocumentsCleared} />
          )}
          <UploadDocumentsDialog onDocumentsUploaded={() => handleIntelligentRefresh(undefined, false, 120000)} />
          <Button
            variant="ghost" size="sm"
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            tooltip={t('documentPanel.documentManager.refreshTooltip')}
            className="rounded-[4px] size-8 p-0"
          >
            <RotateCcwIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Body: FolderTree + DocList */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Folder tree */}
        <div className="w-[168px] shrink-0 border-r border-[rgba(0,0,0,0.1)] overflow-hidden">
          <FolderTree
            folders={folders}
            activeFolderId={activeFolderId}
            docCounts={folderDocCounts}
            onSelect={handleFolderSelect}
            onFoldersChanged={loadFolders}
          />
        </div>

        {/* Document list */}
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
          {currentPageDocs.length === 0 && !isRefreshing ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyCard
                title={t('documentPanel.documentManager.emptyTitle')}
                description={t('documentPanel.documentManager.emptyDescription')}
              />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
              {currentPageDocs.map((doc) => {
                const isSelected = selectedDocIds.includes(doc.id)
                const fileName = getDisplayFileName(doc)
                const meta: string[] = []
                if (doc.content_length) meta.push(`${doc.content_length.toLocaleString()} chars`)
                if (doc.created_at) meta.push(new Date(doc.created_at).toLocaleDateString())
                return (
                  <div
                    key={doc.id}
                    className={cn(
                      'group flex items-center gap-3 rounded-[8px] border bg-white px-4 py-3 transition-colors',
                      isSelected
                        ? 'border-[rgba(0,117,222,0.3)] bg-[#f2f9ff]'
                        : 'border-[rgba(0,0,0,0.08)] hover:border-[rgba(0,117,222,0.2)]',
                      '[box-shadow:rgba(0,0,0,0.04)_0px_4px_18px,rgba(0,0,0,0.027)_0px_2.025px_7.85px,rgba(0,0,0,0.02)_0px_0.8px_2.93px,rgba(0,0,0,0.01)_0px_0.175px_1.04px]'
                    )}
                  >
                    {/* File icon */}
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-[#f6f5f4]">
                      {getFileIcon(doc.file_path)}
                    </div>
                    {/* Info */}
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-[rgba(0,0,0,0.95)]" title={fileName}>
                          {fileName}
                        </span>
                        {doc.error_msg && <AlertTriangle className="size-3.5 shrink-0 text-[#dd5b00]" />}
                      </div>
                      {meta.length > 0 && (
                        <span className="truncate text-xs text-[#a39e98]">{meta.join(' · ')}</span>
                      )}
                    </div>
                    {/* Status badge */}
                    <StatusBadge status={doc.status as DocStatus} />
                    {/* Checkbox */}
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(checked) => handleDocumentSelect(doc.id, checked === true)}
                      className="shrink-0 rounded-[4px]"
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <PipelineStatusDialog open={showPipelineStatus} onOpenChange={setShowPipelineStatus} />
    </div>
  )
}
