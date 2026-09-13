export class GitHubPermissionUpgradeError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('GitHub permission upgrade required: enable Contents, Pull requests and Workflows (read and write) for the Olympus GitHub App, then approve the updated installation permissions and reconnect it in Settings → GitHub. Your local work is preserved.');
  }
}
