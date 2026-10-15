'use strict';

const { decodeFields, firstField, stringValue, bytesField, messageField, intField } = require('./robin-proto');

function conversationTurnFrames(buffer, expected) {
  const error = (message, code = 'robin_recovery_response_error', status = 502) => {
    const failure = new Error(message); failure.code = code; failure.status = status; throw failure;
  };
  const root = decodeFields(buffer);
  const field = firstField(root, 1, 2);
  if (!field) return error('Argon 没有返回可读取的原生任务。');
  const turn = decodeFields(field.value), identifiers = firstField(turn, 1, 2);
  if (!identifiers) return error('Argon 任务快照缺少归属标识。');
  const ids = decodeFields(identifiers.value);
  if (stringValue(firstField(ids, 1, 2)) !== expected.conversationId
      || stringValue(firstField(ids, 2, 2)) !== expected.requestId) {
    return error('Argon 任务快照属于不同的原生会话或请求。', 'robin_session_mismatch', 409);
  }
  const stored = firstField(turn, 4, 2), saved = stored ? decodeFields(stored.value) : [];
  const selected = stringValue(firstField(saved, 4, 2));
  const models = saved.filter(item => item.number === 1 && item.wireType === 2);
  const chosen = selected ? models.filter(model => stringValue(firstField(decodeFields(model.value), 1, 2)) === selected) : [];
  if (selected && models.length && chosen.length !== 1) return error('Argon 任务快照的选定响应无法唯一匹配。');
  const statuses = saved.filter(item => item.number === 5 && item.wireType === 2);
  for (const status of statuses) {
    const processing = firstField(decodeFields(status.value), 13, 2);
    const goal = processing && firstField(decodeFields(processing.value), 5, 2);
    const conversation = goal && stringValue(firstField(decodeFields(goal.value), 2, 2));
    if (conversation && conversation !== expected.conversationId) {
      return error('Argon 任务状态属于不同的原生会话。', 'robin_session_mismatch', 409);
    }
  }
  // ClientGetConversationTurn: turn(1), current identifiers(1), SavedResponse(4)
  // with model responses(1), selected response ID(4), status updates(5).
  // Project only its selected native response into the existing parser. Never
  // manufacture completion, thinking, usage or a missing approval card.
  return [bytesField(1003, messageField(1, Buffer.concat([
    messageField(2, identifiers.value), ...chosen.map(model => messageField(1, model.value)),
    ...[[22, 41]].flatMap(([source, target]) => {
      const field = firstField(saved, source, 0);
      return field ? [intField(target, field.value)] : [];
    })
  ]))), ...statuses.map(status => bytesField(1003, messageField(1, messageField(6, status.value))))];
}

function clientResponses(messages) {
  const output = [];
  for (const message of messages || []) {
    let fields;
    try { fields = decodeFields(message); } catch { continue; }
    for (const stream of fields.filter(field => field.number === 1003 && field.wireType === 2)) {
      const wrappers = decodeFields(stream.value);
      for (const wrapper of wrappers.filter(field => field.number === 1 && field.wireType === 2)) {
        output.push(decodeFields(wrapper.value));
      }
    }
  }
  return output;
}

function modelConfirmations(body) {
  const output = [];
  // ModelResponse.message_tree(5) -> BlockNode(1).action_card_block(24)
  // -> ActionCardContent(1) -> RemyConfirmationCard extension(154).
  // Only this typed card is a native approval; never inspect ordinary prose.
  for (const rich of body.filter(field => field.number === 5 && field.wireType === 2)) {
    for (const block of decodeFields(rich.value).filter(field => field.number === 1 && field.wireType === 2)) {
      for (const actionBlock of decodeFields(block.value).filter(field => field.number === 24 && field.wireType === 2)) {
        for (const action of decodeFields(actionBlock.value).filter(field => field.number === 1 && field.wireType === 2)) {
          const actionFields = decodeFields(action.value);
          const janus = firstField(actionFields, 166, 2);
          const type = janus && firstField(decodeFields(janus.value), 1, 0);
          // JanusConfirmationMetadata extension 166: destructive MCP=4.
          // Other consent types (folders/network/computer control) are not MCP.
          const confirmationType = type && type.value >= 0n && type.value <= 7n ? Number(type.value) : undefined;
          for (const card of actionFields.filter(field => field.number === 154 && field.wireType === 2)) {
            const fields = decodeFields(card.value);
            const buttonPrompt = number => {
              const button = firstField(fields, number, 2);
              const target = button && firstField(decodeFields(button.value), 2, 2);
              return target ? stringValue(firstField(decodeFields(target.value), 4, 2)) : '';
            };
            const details = fields.filter(field => field.number === 12 && field.wireType === 2).map(field => {
              const detail = decodeFields(field.value);
              // This identifies an icon/display category, not a tool name.
              return { displayName: stringValue(firstField(detail, 1, 2)), json: stringValue(firstField(detail, 3, 2)) };
            });
            output.push({ confirmationType, header: stringValue(firstField(fields, 2, 2)), body: stringValue(firstField(fields, 3, 2)),
              allowPrompt: buttonPrompt(7), cancelPrompt: buttonPrompt(9), details });
          }
        }
      }
    }
  }
  return output;
}

function responseMetadata(messages) {
  const models = new Map();
  const metadata = { usageKnown: false };
  for (const fields of clientResponses(messages)) {
    const identifiers = firstField(fields, 2, 2);
    if (identifiers) {
      const ids = decodeFields(identifiers.value);
      const conversationId = stringValue(firstField(ids, 1, 2));
      const requestId = stringValue(firstField(ids, 2, 2));
      if (/^c_[A-Za-z0-9_-]{8,128}$/.test(conversationId) && /^r_[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
        metadata.responseIdentifiers = { conversationId, requestId };
      }
    }
    for (const [number, name] of [[9, 'messageTreeCompleted'], [11, 'containsFallbackResponse'],
      [32, 'isConfirmationRequest'], [41, 'modeCategory']]) {
      const field = firstField(fields, number, 0);
      if (field) metadata[name] = [9, 11, 32].includes(number) ? field.value !== 0n : Number(field.value);
    }
    for (const [number, name] of [[25, 'responseBardModeId'], [30, 'modelAttributionName'],
      [39, 'modeVariantId'], [40, 'routingVariantId']]) {
      const field = firstField(fields, number, 2);
      if (field) metadata[name] = stringValue(field);
    }
    const downgrade = firstField(fields, 31, 0);
    if (downgrade) metadata.bardModeDowngradeReason = Number(downgrade.value);
    const status = firstField(fields, 6, 2);
    const processing = status && firstField(decodeFields(status.value), 13, 2);
    const goal = processing && firstField(decodeFields(processing.value), 5, 2);
    const goalStatus = goal && firstField(decodeFields(goal.value), 1, 0);
    // Native GoalStatus: unspecified=0, done=1, blocked=2, failed=3, running=4.
    if (goalStatus && goalStatus.value >= 0n && goalStatus.value <= 4n) metadata.goalStatus = Number(goalStatus.value);
    // Punt is native task status, not prose generated by the model. Preserve
    // its supplied explanation when the upstream ends without a final answer.
    for (const number of [13, 17]) {
      const punt = firstField(fields, number, 2);
      if (!punt) continue;
      const status = decodeFields(punt.value);
      metadata.punt = {
        headline: stringValue(firstField(status, 1, 2)), body: stringValue(firstField(status, 2, 2)),
        type: Number(firstField(status, 4, 0)?.value || 0), category: stringValue(firstField(status, 7, 2))
      };
    }
    for (const model of fields.filter(field => field.number === 1 && field.wireType === 2)) {
      const body = decodeFields(model.value);
      const id = stringValue(firstField(body, 1, 2));
      if (!/^r(?:c)?_[A-Za-z0-9_-]+$/.test(id)) continue;
      const previous = models.get(id) || { responseId: id, thinking: '' };
      const completeness = firstField(body, 19, 0);
      // Native CompletenessState: UNSPECIFIED=0, PARTIAL=1, COMPLETE=2.
      if (completeness) previous.completeness = Number(completeness.value);
      const thoughtsField = firstField(body, 12, 2);
      if (thoughtsField) {
        const thoughts = decodeFields(thoughtsField.value);
        const display = firstField(thoughts, 1, 2);
        if (display) previous.thinking = stringValue(firstField(decodeFields(display.value), 1, 2));
        const state = firstField(thoughts, 2, 0);
        if (state) previous.thoughtsState = Number(state.value);
      }
      const confirmations = modelConfirmations(body);
      if (confirmations.length) previous.confirmations = confirmations;
      else if (body.some(field => field.number === 5 && field.wireType === 2)) delete previous.confirmations;
      models.set(id, previous);
    }
  }
  return { ...metadata, models: [...models.values()] };
}

module.exports = { clientResponses, responseMetadata, conversationTurnFrames };
