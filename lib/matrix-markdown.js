import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const allowedTags = ['p', 'br', 'strong', 'em', 'del', 's', 'blockquote', 'ul', 'ol', 'li',
  'pre', 'code', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];

export function matrixMarkdownContent(content) {
  const result = { ...content };
  if (typeof content.body === 'string' && ['m.text', 'm.notice'].includes(content.msgtype)
    && !content.formatted_body) {
    result.format = 'org.matrix.custom.html';
    result.formatted_body = sanitizeHtml(markdown.render(content.body), {
      allowedTags, allowedAttributes: { a: ['href', 'title'], code: ['class'], ol: ['start'] },
      allowedSchemes: ['http', 'https', 'mailto', 'matrix'], allowProtocolRelative: false,
    });
  }
  if (content['m.new_content']) result['m.new_content'] = matrixMarkdownContent(content['m.new_content']);
  return result;
}
