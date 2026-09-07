/** No-op turns need checks only for an explicit coding/check request.
 * Tool names and generic words like "check" or "update" are not coding intent.
 * Actual file or revision changes are detected independently by the snapshots.
 */
export function requestsCodingVerification(content: string): boolean {
  // Examples inside quoted text or code blocks are not instructions to run them.
  const prose = content.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/^\s*>.*$/gm, '').trim();
  const normalize = (text: string) => text.trim().replace(/^(?:(?:please|can you|could you|would you|i want you to|i need you to)\s+)+/i, '');
  // An explanation heading can introduce imperative examples in plain text.
  // A separate "Explain the changes. Run the tests." still requests checks.
  if (/^(?:explain|describe|summarize)\b[^.!?\n]*(?:without (?:running|executing)|:\s*\n)/i.test(normalize(prose))) return false;
  return prose.split(/[\n.!?]+/).some(part => {
    const request = normalize(part);
    return /^(fix|implement|refactor|debug|patch)\b/i.test(request)
      || /^(?:run|rerun|execute|perform)\s+(?:(?:the|all|project|required|existing|configured|automated|unit|integration|regression)\s+)*(?:tests?|checks?|verification|validation|lint|typecheck|build|compile|pytest)\b/i.test(request)
      || /^(?:(?:run|rerun|execute)\s+)?`?(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|build)\b/i.test(request)
      || /^(?:verify|validate|check)\s+(?:(?:the|this|our)\s+)?(?:code|changes|implementation)\b/i.test(request)
      || /^(?:verify|validate)\s+(?:the\s+)?(?:build|tests?)\b/i.test(request)
      || /^(?:test|build|compile|lint|typecheck)\s+(?:(?:the|this|our)\s+)?(?:project|code|application)\b/i.test(request)
      || /^(?:verify|validate|test|lint|typecheck|build|compile)$/i.test(request);
  });
}
