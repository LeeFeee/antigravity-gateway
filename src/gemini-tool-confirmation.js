'use strict';

const { decodeFields, field } = require('./gemini-wire');
const { GatewayError } = require('./protocol');

const repeated = (bytes, tag) => decodeFields(bytes).filter(value => value.number === tag && value.wireType === 2).map(value => value.value);
const text = (bytes, tag) => field(bytes, tag, 2)?.toString('utf8') || '';
function invalid() { return new GatewayError('Gemini 工具确认卡片无法无损转换，未批准或执行任何操作。', { code: 'gemini_tool_confirmation_unsupported', status: 502 }); }

function buttonQuery(card, tag) {
  const buttons = repeated(card, tag);
  if (buttons.length !== 1 || field(buttons[0], 3, 0) === 1n || field(buttons[0], 5, 0) === 1n) throw invalid();
  const action = field(buttons[0], 2, 2);
  if (!action || decodeFields(action).some(value => value.number !== 4)) throw invalid();
  const query = text(action, 4);
  if (!query) throw invalid();
  return query;
}

// Native 1.144.4.1467: ModelResponse.messageTree.blocks[].contentCard
// .content.remyConfirmationCard. This is an offered tool action, never an
// authorization. Only the connected client's subsequent tool result can
// acknowledge its execution; unknown cards must not become executable calls.
function geminiToolConfirmation(modelResponse, tools) {
  const tree = field(modelResponse, 5, 2);
  if (!tree) return null;
  const cards = repeated(tree, 1).flatMap(block => {
    const node = field(block, 24, 2), content = node && field(node, 1, 2);
    const card = content && field(content, 154, 2);
    return card ? [{ card, content }] : [];
  });
  if (!cards.length) return null;
  if (cards.length !== 1) throw invalid();
  const { card, content } = cards[0];
  const cardMetadata = field(content, 166, 2);
  if (!cardMetadata || field(cardMetadata, 1, 0) !== 4n) throw invalid();
  const header = text(card, 2), body = text(card, 3);
  const tool = [...tools.values()].find(value => header === `Run ${value.name}?`
    && body === `Allow Gemini to run ${value.name} on your machine?`);
  // Other native confirmation products (payments, passwords, browser actions,
  // subagents, checkboxes) are not equivalent to an advertised client tool.
  if (!tool || [4, 5, 8, 14, 15, 17, 18, 19, 20, 25].some(tag => field(card, tag, 2))) throw invalid();
  const details = repeated(card, 12);
  if (details.length !== 1 || text(details[0], 1) !== 'terminal') throw invalid();
  let args;
  try { args = JSON.parse(text(details[0], 3)); } catch { throw invalid(); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid();
  const reference = field(content, 2, 2);
  return { name: tool.name, arguments: args, allowQuery: buttonQuery(card, 7), cancelQuery: buttonQuery(card, 9),
    placeholder: reference ? text(reference, 1) : '', responseId: text(modelResponse, 1) };
}

module.exports = { geminiToolConfirmation };
