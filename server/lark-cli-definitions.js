export const STATUS_CACHE_MS = 1500;
export const REQUIRED_SKILLS = ['lark-doc', 'lark-drive', 'lark-markdown', 'lark-shared', 'lark-slides', 'lark-sheets'];
export const AUTH_DOMAINS = ['docs', 'drive', 'markdown', 'slides', 'sheets'];

export const REQUIRED_SCOPE_GROUPS = [
  {
    id: 'docs',
    label: '文档读写',
    scopes: ['docx:document:create', 'docx:document:write_only', 'docs:document.content:read']
  },
  {
    id: 'drive',
    label: '云空间文件',
    scopes: ['drive:file:upload', 'drive:file:download']
  },
  {
    id: 'slides',
    label: 'PPT 幻灯片',
    scopes: [
      'slides:presentation:create',
      'slides:presentation:write_only',
      'slides:presentation:read',
      'slides:presentation:update'
    ]
  },
  {
    id: 'sheets',
    label: '表格权限',
    scopes: [
      'sheets:spreadsheet:create',
      'sheets:spreadsheet:read',
      'sheets:spreadsheet:write_only',
      'sheets:spreadsheet.meta:read',
      'sheets:spreadsheet.meta:write_only'
    ]
  }
];

export const CAPABILITIES = [
  { id: 'docs.create', label: '创建文档' },
  { id: 'docs.fetch', label: '读取内容' },
  { id: 'docs.update', label: '修改文档' },
  { id: 'docs.search', label: '搜索文档' },
  { id: 'docs.media', label: '插入媒体' },
  { id: 'drive.upload', label: '上传文件' },
  { id: 'drive.download', label: '下载文件' },
  { id: 'drive.folder', label: '创建文件夹' },
  { id: 'drive.move', label: '移动文件' },
  { id: 'drive.delete', label: '删除文件' },
  { id: 'slides.create', label: '创建 PPT' },
  { id: 'slides.fetch', label: '读取 PPT' },
  { id: 'slides.update', label: '修改 PPT' },
  { id: 'slides.delete', label: '删除幻灯片' },
  { id: 'sheets.create', label: '创建表格' },
  { id: 'sheets.read', label: '读取表格' },
  { id: 'sheets.write', label: '写入表格' },
  { id: 'sheets.append', label: '追加行' },
  { id: 'sheets.find', label: '查找替换' },
  { id: 'sheets.export', label: '导出表格' },
  { id: 'sheets.import', label: '导入 Excel/CSV' }
];
