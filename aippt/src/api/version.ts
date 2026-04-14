import { request } from '@/utils/req'

export const versionApi = {
  getVersions: (docId: string, page = 1, limit = 20) => {
    return request.get(`/api/ppt/presentations/${docId}/versions`, {
      params: { page, limit }
    })
  },

  createVersion: (docId: string, data: {
    content: any
    title?: string
    description?: string
    isAutoSave?: boolean
    author?: string
  }) => {
    return request.post(`/api/ppt/presentations/${docId}/versions`, data)
  },

  getVersion: (docId: string, versionId: string) => {
    return request.get(`/api/ppt/presentations/${docId}/versions/${versionId}`)
  },

  deleteVersion: (docId: string, versionId: string) => {
    return request.delete(`/api/ppt/presentations/${docId}/versions/${versionId}`)
  },

  updateVersion: (docId: string, versionId: string, data: {
    title?: string
    description?: string
  }) => {
    return request.put(`/api/ppt/presentations/${docId}/versions/${versionId}`, data)
  },

  compareVersions: (docId: string, versionId1: string, versionId2: string) => {
    return request.get(`/api/ppt/presentations/${docId}/versions/${versionId1}/compare/${versionId2}`)
  }
}

export interface Version {
  id: string
  documentId: string
  content: any
  title: string
  description: string
  isAutoSave: boolean
  createdAt: string
  updatedAt: string
  size: number
  author: string
}

export interface VersionListResponse {
  versions: Version[]
  total: number
  page: number
  limit: number
}
