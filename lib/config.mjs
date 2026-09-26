/**
 * Configuration resolution for dsh-hypercompact.
 *
 * Configuration comes only from the cordis row (no settings namespace, no
 * settings card). Unknown keys are rejected so a typo cannot silently fall
 * back to a default.
 *
 * @module dsh-hypercompact/config
 */

/** Default configuration. Byte values are UTF-8 bytes of the request body. */
export const DEFAULTS = Object.freeze({
  auto: true,
  dryRun: false,
  maxRequestBytes: 5_000_000,
  targetRequestBytes: 1_500_000,
  maxTokens: 0,
  contextRatio: 0.85,
  retainTurns: 2,
  retainBytes: 400_000,
  allowIntraTurn: true,
  maxCheckpointBytes: 600_000,
  minCheckpointBytes: 300_000,
  pinnedBytes: 30_000,
  toolResultExcerpt: Object.freeze({ head: 200, tail: 100 }),
  toolErrorExcerpt: Object.freeze({ head: 600, tail: 400 }),
  userTextChars: 20_000,
  assistantTextChars: 1500,
  keyArgChars: 160,
  largeArgBytes: 2000,
  keyArgTools: null,
  groupTools: Object.freeze(['read', 'read_image', 'grep', 'glob', 'ls', 'web_search', 'web_fetch', 'recall', 'recall_search']),
  keepRecentImages: 2,
  maxKeptImageBytes: 2_000_000,
  housekeepingRatio: 0.5,
  housekeepingExcerpt: Object.freeze({ head: 2000, tail: 1000 }),
  recoverOnTimeout: true,
  maxRecoveryRetries: 1,
  tools: true,
  commands: true,
  maxRecallChars: 60_000,
  maxSearchHits: 30,
  statsLog: true,
  statsDir: null,
  modelPolicies: Object.freeze([]),
});

/** Keys that an exact provider/model override may replace. */
export const POLICY_KEYS = Object.freeze([
  'maxRequestBytes',
  'targetRequestBytes',
  'maxTokens',
  'contextRatio',
  'retainTurns',
  'retainBytes',
  'maxCheckpointBytes',
  'housekeepingRatio',
]);

const TOP_LEVEL_KEYS = new Set(Object.keys(DEFAULTS));
const MODEL_POLICY_KEYS = new Set(['provider', 'model', ...POLICY_KEYS]);

function fail(message) {
  throw new Error(`dsh-hypercompact config: ${message}`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkKeys(source, allowed, where) {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) fail(`unknown key "${key}" in ${where}`);
  }
}

function positiveInt(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} (${String(value)}) must be a positive integer`);
}

function nonNegativeInt(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} (${String(value)}) must be a non-negative integer`);
}

function bool(value, name) {
  if (typeof value !== 'boolean') fail(`${name} must be a boolean`);
}

/** Validate the policy fields shared by defaults and overrides. */
function validatePolicyFields(source, where) {
  if (source.maxRequestBytes !== undefined) positiveInt(source.maxRequestBytes, `${where}.maxRequestBytes`);
  if (source.targetRequestBytes !== undefined) positiveInt(source.targetRequestBytes, `${where}.targetRequestBytes`);
  if (source.maxTokens !== undefined) nonNegativeInt(source.maxTokens, `${where}.maxTokens`);
  if (source.contextRatio !== undefined) {
    const ratio = source.contextRatio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      fail(`${where}.contextRatio (${String(ratio)}) must be a number in [0, 1]; 0 disables it`);
    }
  }
  if (source.retainTurns !== undefined) nonNegativeInt(source.retainTurns, `${where}.retainTurns`);
  if (source.retainBytes !== undefined) nonNegativeInt(source.retainBytes, `${where}.retainBytes`);
  if (source.maxCheckpointBytes !== undefined) positiveInt(source.maxCheckpointBytes, `${where}.maxCheckpointBytes`);
  if (source.housekeepingRatio !== undefined) {
    const ratio = source.housekeepingRatio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio >= 1) {
      fail(`${where}.housekeepingRatio (${String(ratio)}) must be a number in [0, 1); 0 disables housekeeping`);
    }
  }
}

/** Reject a policy whose target is not strictly below its trigger. */
function checkHysteresis(policy, where) {
  if (policy.targetRequestBytes >= policy.maxRequestBytes) {
    fail(`${where}: targetRequestBytes (${policy.targetRequestBytes}) must be less than maxRequestBytes (${policy.maxRequestBytes})`);
  }
}

/** Validate one `{ head, tail }` excerpt object, merged over its default. */
function resolveExcerpt(config, key) {
  if (config[key] === undefined) return DEFAULTS[key];
  const value = config[key];
  if (!isRecord(value)) fail(`${key} must be an object { head, tail }`);
  checkKeys(value, new Set(['head', 'tail']), key);
  const merged = { ...DEFAULTS[key], ...value };
  nonNegativeInt(merged.head, `${key}.head`);
  nonNegativeInt(merged.tail, `${key}.tail`);
  return Object.freeze(merged);
}

/** Validate a list of tool names; `nullable` lists accept null meaning "all tools". */
function resolveNameList(config, key, nullable) {
  const value = config[key];
  if (value === undefined) return DEFAULTS[key];
  if (value === null && nullable) return null;
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || name.length === 0)) {
    fail(`${key} must be ${nullable ? 'null (all tools) or ' : ''}an array of tool names`);
  }
  return Object.freeze([...value]);
}

/**
 * Resolve and validate the plugin configuration.
 * @param {Record<string, unknown>} [config] - raw cordis row config.
 * @returns {Readonly<typeof DEFAULTS>} a frozen, fully defaulted config.
 */
export function resolveConfig(config = {}) {
  if (config === null || config === undefined) config = {};
  if (!isRecord(config)) fail('config must be an object');
  checkKeys(config, TOP_LEVEL_KEYS, 'config');
  validatePolicyFields(config, 'config');

  for (const key of ['auto', 'dryRun', 'recoverOnTimeout', 'tools', 'commands', 'statsLog', 'allowIntraTurn']) {
    if (config[key] !== undefined) bool(config[key], key);
  }
  for (const key of ['minCheckpointBytes', 'pinnedBytes', 'userTextChars', 'assistantTextChars', 'keyArgChars', 'largeArgBytes', 'maxRecallChars', 'maxSearchHits', 'maxKeptImageBytes']) {
    if (config[key] !== undefined) positiveInt(config[key], key);
  }
  if (config.maxRecoveryRetries !== undefined) nonNegativeInt(config.maxRecoveryRetries, 'maxRecoveryRetries');
  if (config.keepRecentImages !== undefined) nonNegativeInt(config.keepRecentImages, 'keepRecentImages');

  const toolResultExcerpt = resolveExcerpt(config, 'toolResultExcerpt');
  const toolErrorExcerpt = resolveExcerpt(config, 'toolErrorExcerpt');
  const housekeepingExcerpt = resolveExcerpt(config, 'housekeepingExcerpt');
  if (config.statsDir !== undefined && config.statsDir !== null && (typeof config.statsDir !== 'string' || config.statsDir.length === 0)) {
    fail('statsDir must be null (default location) or a non-empty path');
  }
  const groupTools = resolveNameList(config, 'groupTools', false);

  const keyArgTools = resolveNameList(config, 'keyArgTools', true);

  const modelPolicies = resolveModelPolicies(config.modelPolicies);
  const resolved = {
    ...DEFAULTS,
    ...config,
    toolResultExcerpt,
    toolErrorExcerpt,
    housekeepingExcerpt,
    groupTools,
    keyArgTools,
    modelPolicies,
  };
  if (resolved.minCheckpointBytes > resolved.maxCheckpointBytes) {
    fail(`minCheckpointBytes (${resolved.minCheckpointBytes}) must not exceed maxCheckpointBytes (${resolved.maxCheckpointBytes})`);
  }
  checkHysteresis(resolved, 'config');
  for (const [index, override] of modelPolicies.entries()) {
    checkHysteresis(policyFor(resolved, override), `modelPolicies[${index}] (${override.provider}/${override.model})`);
  }
  return Object.freeze(resolved);
}

function resolveModelPolicies(source) {
  if (source === undefined) return DEFAULTS.modelPolicies;
  if (!Array.isArray(source)) fail('modelPolicies must be an array');
  const seen = new Set();
  return Object.freeze(source.map((entry, index) => {
    const where = `modelPolicies[${index}]`;
    if (!isRecord(entry)) fail(`${where} must be an object`);
    checkKeys(entry, MODEL_POLICY_KEYS, where);
    if (typeof entry.provider !== 'string' || entry.provider.length === 0) fail(`${where}.provider must be a non-empty string`);
    if (typeof entry.model !== 'string' || entry.model.length === 0) fail(`${where}.model must be a non-empty string`);
    validatePolicyFields(entry, where);
    const key = `${entry.provider}\u0000${entry.model}`;
    if (seen.has(key)) fail(`duplicate model policy for ${entry.provider}/${entry.model}`);
    seen.add(key);
    return Object.freeze({ ...entry });
  }));
}

function policyFor(config, override) {
  const policy = {};
  for (const key of POLICY_KEYS) policy[key] = override?.[key] ?? config[key];
  // Housekeeping starts this fraction of the way from target to trigger (0 = off).
  policy.housekeepingBytes = policy.housekeepingRatio > 0
    ? Math.round(policy.targetRequestBytes + (policy.maxRequestBytes - policy.targetRequestBytes) * policy.housekeepingRatio)
    : 0;
  return policy;
}

/**
 * Merge the exact provider/model override (if any) over the defaults.
 * @param {ReturnType<typeof resolveConfig>} config - resolved config.
 * @param {{ provider: string, model: string } | undefined} target - routed model.
 * @returns {Readonly<Record<string, number>>} the effective policy.
 */
export function resolvePolicy(config, target) {
  const override = target === undefined
    ? undefined
    : config.modelPolicies.find((entry) => entry.provider === target.provider && entry.model === target.model);
  return Object.freeze(policyFor(config, override));
}
