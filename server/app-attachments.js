export function normalizeAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item.path === 'string' && item.path.trim())
    .map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || path.basename(item.path)),
      size: Number(item.size) || 0,
      mimeType: String(item.mimeType || ''),
      path: String(item.path),
      kind: item.kind === 'image' ? 'image' : 'file'
    }));
}

export function withAttachmentReferences(message, attachments) {
  if (!attachments.length) {
    return message;
  }

  const lines = attachments.map((attachment) => {
    const type = attachment.kind === 'image' ? '图片' : '文件';
    return `- ${type}: ${attachment.name} (${attachment.path})`;
  });
  return `${message}\n\n附件路径:\n${lines.join('\n')}`;
}
