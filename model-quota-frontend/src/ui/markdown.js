// 流式 Markdown 渲染：marked 解析 + DOMPurify 消毒（模型输出不可信）。
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(text) {
  const html = marked.parse(text || '');
  return DOMPurify.sanitize(html);
}
