import { request } from '@/utils/req'

export const presentationApi = {
  getAll: () => {
    return request.get('/api/ppt/presentations')
  },

  getById: (id: string) => {
    return request.get(`/api/ppt/presentations/${id}`)
  },

  create: (data: {
    title: string
    description?: string
    content?: any
    thumbnail?: string
    isPublic?: boolean
  }) => {
    return request.post('/api/ppt/presentations', data)
  },

  update: (id: string, data: {
    title?: string
    description?: string
    content?: any
    thumbnail?: string
    isPublic?: boolean
  }) => {
    return request.put(`/api/ppt/presentations/${id}`, data)
  },

  delete: (id: string) => {
    return request.delete(`/api/ppt/presentations/${id}`)
  },

  duplicate: (id: string) => {
    return request.post(`/api/ppt/presentations/${id}/duplicate`)
  }
}
