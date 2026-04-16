<template>
  <a-modal
    v-model:visible="visible"
    title="选择 PPT 模板"
    width="900px"
    :footer="false"
    @cancel="handleCancel"
  >
    <div class="template-selector">
      <!-- 分类标签 -->
      <div class="category-tabs">
        <a-button
          v-for="cat in categories"
          :key="cat.value"
          :type="selectedCategory === cat.value ? 'primary' : 'default'"
          size="small"
          @click="selectedCategory = cat.value"
        >
          {{ cat.label }}
        </a-button>
      </div>

      <!-- 模板网格 -->
      <a-spin :loading="loading" style="width: 100%">
        <div class="template-grid">
        <div
          v-for="tpl in filteredTemplates"
          :key="tpl.id"
          class="template-card"
          :class="{ selected: selectedTemplate?.id === tpl.id }"
          @click="selectTemplate(tpl)"
        >
          <!-- 预览图 -->
          <div class="template-preview">
            <img v-if="tpl.preview" :src="tpl.preview" :alt="tpl.name" />
            <div v-else class="template-placeholder">
              <Icon name="presentation" :size="48" />
            </div>
          </div>

          <!-- 模板信息 -->
          <div class="template-info">
            <div class="template-name">{{ tpl.name }}</div>
            <div class="template-meta">
              <span class="template-size">{{ tpl.width }}×{{ tpl.height }}</span>
              <span class="template-slides">{{ tpl.slideCount || 0 }} 页</span>
            </div>
          </div>

          <!-- 选中标记 -->
          <div v-if="selectedTemplate?.id === tpl.id" class="selected-badge">
            <Icon name="check-circle-fill" :size="24" />
          </div>

          <!-- Premium 标记 -->
          <div v-if="tpl.isPremium" class="premium-badge">PRO</div>
        </div>

        <!-- 空状态 -->
        <a-empty v-if="!loading && filteredTemplates.length === 0" description="暂无模板" />

        <!-- 上传模板卡片 -->
        <div class="template-card upload-card" @click="handleUploadClick">
          <div class="template-preview">
            <div class="template-placeholder">
              <Icon name="upload" :size="48" />
            </div>
          </div>
          <div class="template-info">
            <div class="template-name">上传模板</div>
            <div class="template-meta">
              <span>支持 .pptx 文件</span>
            </div>
          </div>
        </div>
      </div>
      </a-spin>

      <input ref="uploadInputRef" type="file" accept=".pptx" style="display:none" @change="handleFileUpload" />

      <!-- 底部操作 -->
      <div class="template-actions">
        <a-button @click="handleCancel">取消</a-button>
        <a-button
          type="primary"
          :disabled="!selectedTemplate"
          @click="handleConfirm"
        >
          使用此模板
        </a-button>
      </div>
    </div>
  </a-modal>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { Message } from '@arco-design/web-vue';
import IIcon from '@/utils/slide/icon.js'
import { templateApi } from '@/api/template'

const Icon = IIcon; // Alias for template usage


const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['update:modelValue', 'confirm', 'cancel']);

// 响应式数据
const visible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val),
});

const loading = ref(false);
const templates = ref([]);
const selectedCategory = ref('all');
const selectedTemplate = ref(null);

// 分类列表
const categories = [
  { label: '全部', value: 'all' },
  { label: '咨询风格', value: 'consulting' },
  { label: '商务', value: 'business' },
  { label: '创意', value: 'creative' },
  { label: '极简', value: 'minimal' },
  { label: '科技', value: 'tech' },
  { label: '教育', value: 'education' },
  { label: '我的上传', value: 'user_upload' },
];

// 过滤模板
const filteredTemplates = computed(() => {
  if (selectedCategory.value === 'all') {
    return templates.value;
  }
  return templates.value.filter(t => t.category === selectedCategory.value);
});

// 加载模板列表
const loadTemplates = async () => {
  loading.value = true;
  try {
    const allTemplates = []

    try {
      const result = await templateApi.getTemplates({
        category: selectedCategory.value === 'all' ? undefined : selectedCategory.value,
        page: 1,
        pageSize: 100
      })
      if (result.code === 200 && result.data) {
        allTemplates.push(...(result.data.templates || []))
      }
    } catch (e) {
      console.warn('[TemplateSelector] Backend templates unavailable:', e.message)
    }

    try {
      const exportApiUrl = import.meta.env.VITE_EXPORT_API_URL || ''
      const res = await fetch(`${exportApiUrl}/api/templates?category=${selectedCategory.value === 'all' ? '' : selectedCategory.value}`)
      if (res.ok) {
        const data = await res.json()
        if (data?.data?.templates) {
          allTemplates.push(...data.data.templates)
        }
      }
    } catch (e) {
      console.warn('[TemplateSelector] Export server templates unavailable:', e.message)
    }

    templates.value = allTemplates
  } catch (error) {
    console.error('[TemplateSelector] Failed to load templates:', error);
    Message.error('加载模板失败');
  } finally {
    loading.value = false;
  }
};

// 选择模板
const selectTemplate = (template) => {
  selectedTemplate.value = template;
};

// 确认选择
const handleConfirm = () => {
  if (!selectedTemplate.value) {
    Message.warning('请选择一个模板');
    return;
  }
  emit('confirm', selectedTemplate.value);
  visible.value = false;
};

// 取消
const handleCancel = () => {
  emit('cancel');
  visible.value = false;
};

// 组件挂载时加载模板
onMounted(() => {
  loadTemplates();
});

const uploadInputRef = ref(null)

const handleUploadClick = () => {
  uploadInputRef.value?.click()
}

const handleFileUpload = async (event) => {
  const file = event.target.files?.[0]
  if (!file) return

  if (!file.name.endsWith('.pptx')) {
    Message.error('仅支持 .pptx 文件')
    return
  }

  try {
    const exportApiUrl = import.meta.env.VITE_EXPORT_API_URL || ''
    const formData = new FormData()
    formData.append('file', file)
    formData.append('name', file.name.replace('.pptx', ''))

    const res = await fetch(`${exportApiUrl}/api/templates/upload`, {
      method: 'POST',
      body: formData,
    })

    if (res.ok) {
      Message.success('模板上传成功！')
      loadTemplates()
    } else {
      Message.error('模板上传失败')
    }
  } catch (e) {
    Message.error('上传失败：' + e.message)
  }

  event.target.value = ''
}
</script>

<style scoped>
.template-selector {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 分类标签 */
.category-tabs {
  display: flex;
  gap: 8px;
  padding-bottom: 16px;
  border-bottom: 1px solid #e5e7eb;
}

/* 模板网格 */
.template-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  max-height: 500px;
  overflow-y: auto;
  padding: 4px;
}

/* 模板卡片 */
.template-card {
  position: relative;
  border: 2px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s;
}

.template-card:hover {
  border-color: #1677ff;
  box-shadow: 0 4px 12px rgba(22, 119, 255, 0.15);
  transform: translateY(-2px);
}

.template-card.selected {
  border-color: #1677ff;
  box-shadow: 0 4px 16px rgba(22, 119, 255, 0.25);
}

/* 预览图 */
.template-preview {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #f5f7fa;
  display: flex;
  align-items: center;
  justify-content: center;
}

.template-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.template-placeholder {
  color: #94a3b8;
}

/* 模板信息 */
.template-info {
  padding: 12px;
  background: white;
}

.template-name {
  font-size: 14px;
  font-weight: 600;
  color: #1a1a1a;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.template-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #64748b;
}

/* 选中标记 */
.selected-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  color: #1677ff;
  background: white;
  border-radius: 50%;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

/* Premium 标记 */
.premium-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  color: white;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.upload-card {
  border-style: dashed;
  border-color: #94a3b8;
}

.upload-card:hover {
  border-color: #1677ff;
  border-style: dashed;
}

/* 底部操作 */
.template-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid #e5e7eb;
}
</style>
