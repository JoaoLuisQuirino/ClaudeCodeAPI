import { config } from './config.js';
import { BadRequestError } from './errors.js';

/**
 * Validate that a model name is in the allowed list.
 * Prevents arbitrary strings from reaching spawn args.
 */
export function validateModel(model: string | undefined): string {
  const m = model || config.defaultModel;

  if (config.allowedModels.has(m)) return m;

  // Accept models with version suffixes like "claude-sonnet-4-6-20251001"
  // and full IDs when short names are in the list (e.g. "claude-sonnet-4-6" matches "sonnet")
  for (const allowed of config.allowedModels) {
    if (m.startsWith(allowed) || m.includes(allowed)) return m;
  }

  throw new BadRequestError(`Model "${m}" is not allowed. Allowed: ${[...config.allowedModels].join(', ')}`);
}

/**
 * Validate a session ID format — must be safe for use in CLI args and filenames.
 */
export function validateSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    throw new BadRequestError('Invalid session_id format');
  }
  return sessionId;
}
