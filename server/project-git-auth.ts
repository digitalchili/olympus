export class ProjectGitError extends Error {
  constructor(public readonly code = 'PROJECT_GIT_UNAVAILABLE', public readonly statusCode = 503, public readonly exitCode?: number) {
    super(code === 'PROJECT_GIT_CONFIG_UNSUPPORTED'
      ? 'This repository has unsupported transport configuration. Inspect its Git settings before continuing.'
      : 'The Git operation could not be completed. Check the repository connection and try again.');
  }
}

/** This controls server-owned Git operations, not the user's agent shell. */
export function buildProjectGitEnv(input: { baseEnv: NodeJS.ProcessEnv; cloneUrl: string; token?: string }): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(input.baseEnv).filter(([key]) => !/^GIT_/i.test(key) && !/^SSH_ASKPASS/i.test(key)));
  if (input.token && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(input.cloneUrl)) {
    throw new ProjectGitError('PROJECT_GIT_CONFIG_UNSUPPORTED', 409);
  }
  const entries: Array<[string, string]> = [
    ['http.extraHeader', ''], ['credential.helper', ''], ['core.hooksPath', '/dev/null'],
    ['core.askPass', ''], ['core.fsmonitor', 'false'], ['http.followRedirects', 'false'], ['http.sslVerify', 'true'],
    ['submodule.recurse', 'false'], ['fetch.recurseSubmodules', 'false'],
    ['push.recurseSubmodules', 'false'], ['push.followTags', 'false'], ['push.gpgSign', 'false'],
    ['protocol.allow', 'never'], ['protocol.https.allow', 'always'],
  ];
  if (input.token) entries.push([`http.${input.cloneUrl}.extraHeader`, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${input.token}`).toString('base64')}`]);
  // Internal baseline clones and disposable test remotes have no credentials.
  else if (!input.cloneUrl || input.cloneUrl.startsWith('/')) entries.push(['protocol.file.allow', 'always']);
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: String(entries.length), ...Object.fromEntries(entries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value],
    ])) };
}

export function validateProjectGitTransportConfig(entries: readonly { key: string; value: string }[]): void {
  for (const { key } of entries) {
    if (/^(?:url\..*\.(?:insteadof|pushinsteadof)|remote\..*\.(?:vcs|proxy|uploadpack|receivepack|pushinsteadof)|core\.gitproxy|http\.|include\.|includeif\.)/i.test(key)) {
      throw new ProjectGitError('PROJECT_GIT_CONFIG_UNSUPPORTED', 409);
    }
  }
}

export function parseProjectGitConfig(stdout: string): Array<{ key: string; value: string }> {
  return stdout.split('\0').filter(Boolean).map(entry => {
    const split = entry.indexOf('\n');
    return { key: split < 0 ? entry : entry.slice(0, split), value: split < 0 ? '' : entry.slice(split + 1) };
  });
}
