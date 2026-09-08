import { expect, test, vi } from 'vitest';
import { matrixMarkdownContent } from '../lib/matrix-markdown.js';
import { sendDirectEvent } from '../lib/matrix-direct-chat.js';

test('Matrix Markdown preserves plaintext relations and safe formatted content', async () => {
  const body = '# 结论\n\n**粗体**，*强调*\n\n- 第一条\n- [来源](https://example.org/report)\n\n> 引用\n\n```js\nconst n = 1 < 2;\n```\n\n<script>alert(1)</script>\n[bad](javascript:alert(1))';
  const relation = { rel_type: 'm.thread', event_id: '$root' };
  const content = matrixMarkdownContent({ msgtype: 'm.text', body, 'm.relates_to': relation });
  expect(content).toMatchObject({ body, format: 'org.matrix.custom.html', 'm.relates_to': relation });
  for (const tag of ['h1', 'strong', 'em', 'ul', 'li', 'blockquote', 'pre', 'code']) expect(content.formatted_body).toContain(`<${tag}`);
  expect(content.formatted_body).toContain('href="https://example.org/report"');
  expect(content.formatted_body).not.toMatch(/<script|href="javascript:/);
  const client = { getRoomState: vi.fn(async () => [{ type: 'm.room.encryption' }]),
    crypto: { encryptRoomEvent: vi.fn(async (_room, _type, clear) => ({ ciphertext: clear.formatted_body })) },
    doRequest: vi.fn(async () => ({ event_id: '$sent' })) };
  await sendDirectEvent(client, '!dm:test', content, 'txn');
  expect(client.crypto.encryptRoomEvent.mock.calls[0][2]).toEqual(content);
  expect(matrixMarkdownContent(content)).toEqual(content);
  expect(matrixMarkdownContent({ msgtype: 'm.text', body: '* edited', 'm.new_content': { msgtype: 'm.text', body: '**edited**' } })['m.new_content'].formatted_body).toContain('<strong>edited</strong>');
});
