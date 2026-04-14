import { request } from '@/utils/req'

export const templateApi = {
  getTemplates: (options?: {
    category?: string
    source?: string
    page?: number
    pageSize?: number
  }) => {
    const params: any = {}
    if (options?.category) params.category = options.category
    if (options?.source) params.source = options.source
    if (options?.page) params.page = options.page
    if (options?.pageSize) params.pageSize = options.pageSize
    
    return request.get('/api/ppt/templates', { params })
  },

  getTemplate: (id: string) => {
    return request.get(`/api/ppt/templates/${id}`)
  },
}
