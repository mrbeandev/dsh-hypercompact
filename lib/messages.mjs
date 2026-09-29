/**
 * Message-shape adapter across dsh releases.
 *
 * dsh 0.1.5 stores a tool result as a user-role message whose single content
 * block is `{ type: 'tool-result', toolCallId, content, isError }`.
 * dsh 0.1.7 and later store it as a first-class tool-role message:
 * `{ role: 'tool', toolCallId, isError, content: [...blocks] }`.
 *
 * The same release moved the compaction checkpoint source from
 * `{ kind: 'plugin', plugin: 'compact' }` to `{ kind: 'compact-checkpoint' }`.
 *
 * Every module reads and rewrites tool results through these helpers, so the
 * plugin works on both formats. Dependency-free.
 *
 * @module dsh-hypercompact/messages
 */

/**
 * The tool results carried by one message, in either format.
 * @param {object | null | undefined} message - a derived message.
 * @returns {{ toolCallId: string, content: object[], isError: boolean }[]}
 */
export function toolResultsOf(message) {
  if (message === null || message === undefined) return [];
  if (message.role === 'tool') {
    return typeof message.toolCallId === 'string'
      ? [{ toolCallId: message.toolCallId, content: Array.isArray(message.content) ? message.content : [], isError: message.isError === true }]
      : [];
  }
  if (!Array.isArray(message.content)) return [];
  return message.content
    .filter((block) => block?.type === 'tool-result' && typeof block.toolCallId === 'string')
    .map((block) => ({ toolCallId: block.toolCallId, content: Array.isArray(block.content) ? block.content : [], isError: block.isError === true }));
}

/** The single tool result of a `tool/result` event's message, or undefined. */
export function toolResultOfEvent(event) {
  return toolResultsOf(event?.data?.message)[0];
}

/**
 * Copy a tool-result message with new result content, preserving every other
 * field (the harness only accepts content-only tool/result rewrites).
 * @param {object} message - the original tool/result message.
 * @param {object[]} content - replacement result content blocks.
 */
export function withToolResultContent(message, content) {
  if (message.role === 'tool') return { ...message, content };
  return { ...message, content: [{ ...message.content[0], content }] };
}

/** Whether a message source marks a compaction checkpoint (any backend, any release). */
export function isCheckpointSource(source) {
  if (source === null || typeof source !== 'object') return false;
  return source.kind === 'compact-checkpoint' || (source.kind === 'plugin' && source.plugin === 'compact');
}
