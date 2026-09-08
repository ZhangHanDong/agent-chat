// This is a public receipt, never an execution approval or a provider DTO.
export function engagementApprovalContent(engagement, serving, mxid) {
  const configuration = [serving?.framework, serving?.model, serving?.reasoning].filter(Boolean).join(' · ');
  const content = {
    msgtype: 'm.notice',
    body: `已批准 / Approved ${engagement.role} for ${engagement.allocatedTokens} tokens.\n`
      + `Agent: ${mxid}\n`
      + (configuration ? `Serving: ${configuration}\n` : '')
      + `Request: ${engagement.id}\n`
      + (engagement.requestContext
        ? `目标项目 / Target project: ${engagement.projectRoomId}\n请在目标项目房间 @ 该 Agent 开始任务。Mention this agent in the target project room to begin work.`
        : '请在此房间 @ 该 Agent 开始任务。Mention this agent in this room to begin work.'),
    'm.mentions': { user_ids: [] },
  };
  const sourceEventId = engagement.requestContext?.sourceEventId ?? engagement.requestId;
  if (typeof sourceEventId === 'string' && sourceEventId.startsWith('$')) {
    content['m.relates_to'] = { 'm.in_reply_to': { event_id: sourceEventId } };
  }
  return content;
}
