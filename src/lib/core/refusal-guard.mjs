/**
 * Persist upstream AUP / content-filter refusals and short-circuit repeats.
 * Fingerprint is model + normalized system/user/tool names (not stream/max_tokens).
 */
import { createHash } from 'node:crypto'
import { ErrorType, ErrorCode, makeError, isUsagePolicyErrorMessage } from './errors.mjs'
import { extractPrompt, normalizeText } from './distill-detect.mjs'

export const REFUSAL_GUARD_MESSAGE =
  "Request blocked by the refusal guard. Anthropic's API previously refused this pattern."

export const REFUSAL_GUARD_SETTING = 'refusal_guard_enabled'

export function isRefusalGuardEnabled(readSetting) {
  const flag = process.env.VM2API_REFUSAL_GUARD || process.env.REFUSAL_GUARD || process.env.KIN_REFUSAL_GUARD
  if (flag === '0' || flag === 'false') return false
  if (typeof readSetting === 'function') {
    try {
      const v = readSetting(REFUSAL_GUARD_SETTING, true)
      if (v === false || v === 0 || v === '0' || v === 'false') return false
    } catch {
      /* sqlite missing → default on */
    }
  }
  return true
}

const REFUSAL_HAY = /stop_reason[=:]?\s*refusal/i

export function toolNamesOf(body) {
  if (!Array.isArray(body?.tools)) return []
  return body.tools
    .map((t) => String(t?.name || '').trim())
    .filter(Boolean)
    .sort()
}

export function envelopeStablePrompt(text = '') {
  return normalizeText(
    String(text || '')
      .replace(/thread_id:\s*[0-9a-f-]{8,}/gi, 'thread_id:')
      .replace(/Persistable response items \(JSON\):\s*\[[\s\S]*/i, 'Persistable response items (JSON):'),
  )
}

export function refusalFingerprint(body = {}, inbound = body) {
  const prompt = extractPrompt(inbound, body)
  const model = String(body?.model || inbound?.model || '')
    .trim()
    .toLowerCase()
  const payload = {
    model,
    prompt: envelopeStablePrompt(prompt.joined),
    tools: toolNamesOf(body).length ? toolNamesOf(body) : toolNamesOf(inbound),
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function refusalPreview(body = {}, inbound = body) {
  const prompt = extractPrompt(inbound, body)
  return String(prompt.user || prompt.joined || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

export function isUpstreamRefusal(result = {}, extra = {}) {
  if (result?.finalState === 'content_filter') return true
  const stop = String(result?.stopReason || result?.body?.stop_reason || extra.stop_reason || '')
  if (stop === 'refusal') return true
  const hay = [
    extra.error_message,
    extra.error_code,
    result?.body?.error?.message,
    result?.body?.error?.code,
    typeof result?.error === 'string' ? result.error : result?.error?.message,
    result?.finalState,
  ]
    .filter(Boolean)
    .join('\n')
  return isUsagePolicyErrorMessage(hay) || REFUSAL_HAY.test(hay)
}

export function refusalGuardError(requestId) {
  return makeError({
    type: ErrorType.PERMISSION,
    code: ErrorCode.REFUSAL_GUARD,
    message: REFUSAL_GUARD_MESSAGE,
    status: 403,
    request_id: requestId,
  })
}
