export const ACTIVITY_KEY = 'io.hagency.activity';

export function matrixActivityContent(command, relation = null) {
  const next = { msgtype: 'm.notice', body: String(command.body || ''), [ACTIVITY_KEY]: { dispatch_id: command.dispatchId } };
  if (relation) next['m.relates_to'] = relation;
  if (!command.activity?.replaceEventId) return next;
  return { ...next, body: `* ${next.body}`, 'm.new_content': next,
    'm.relates_to': { rel_type: 'm.replace', event_id: command.activity.replaceEventId } };
}

export function isMatrixActivity(event, senderIsAgent) {
  return Boolean(senderIsAgent && (event?.content?.[ACTIVITY_KEY] || event?.content?.['m.new_content']?.[ACTIVITY_KEY]));
}
