# Native inline previews and design drafts

Olympus renders generated images and self-contained HTML prototypes **inside the task conversation**. This is a native Olympus feature; it does not use or embed the Codex app.

## User workflow

For open-ended visual work, the task agent offers one direction or two–three materially different concepts (unless the user already specified their choice). The agent creates real files, then returns previews in its completed answer.

- Images appear inline, with enlarge and download controls.
- HTML prototypes have Fit, Desktop, and Mobile viewport controls and support local JavaScript interactions.
- Draft collections offer **Compare all** and individual-draft views.
- **Use this direction** or **Refine this draft** saves the exact selected preview and optional feedback, then prepares a follow-up in the existing message box. Existing unsent text is preserved. The user sends that message through normal task chat to continue; saving a choice does not start an agent or approve deployment.
- Choices and immutable preview bytes remain available after reload. A later revision is a new collection, not an overwrite of the old preview.

These are design concepts, not automatically verified builds. Selecting a concept is separate from build verification, publishing, and production approval.

## Worker output contract

Write the real file in the approved task workspace before returning it. For a single image or HTML prototype, use the normal attachment marker:

```text
MEDIA:drafts/homepage-r1/index.html
```

For a comparison, return a fenced JSON manifest:

````text
```olympus-preview
{
  "id": "homepage-r1",
  "title": "Homepage directions",
  "drafts": [
    { "id": "a", "title": "Editorial", "description": "Quiet typography and generous spacing", "path": "drafts/homepage-r1/a.html" },
    { "id": "b", "title": "Expressive", "description": "High contrast and playful graphics", "path": "drafts/homepage-r1/b.html" }
  ]
}
```
````

A collection contains one to three drafts. Use a new collection ID **and new file paths for every revision**, including single-file MEDIA outputs. HTML must include its CSS and JavaScript inline and embed image/font assets as data URLs. Do not use CDNs, relative asset imports, server-side routes, API calls, nested frames, or login-dependent pages. Capture screenshots for applications that cannot be represented by a self-contained prototype; never call a screenshot interactive.

Finish the answer after delivering the manifest. Do not wait inside a clarification tool after it: published cards arrive when the answer completes. The next user message carries the chosen direction and any refinement feedback.

The UI removes a manifest from the visible prose only after all of its drafts have published previews. Invalid or failed manifests remain visible instead of silently claiming success.

## Security and persistence

The existing task/profile authorization and approved-workspace checks remain in force. Preview URLs refer to immutable server-stored snapshots, not arbitrary URLs or local development-server ports. HTML is served inside a wrapper with a restrictive Content Security Policy and a sandboxed `srcdoc` child. The wrapper's `frame-src 'none'` blocks the prototype from navigating itself to an API or external URL. Both iframe layers use `sandbox="allow-scripts"` (no same-origin, top-navigation, popup, or form permissions). External resource loading and fetch/XHR are blocked. Downloads return the original immutable snapshot bytes as an attachment; the wrapper is used only for display. Snapshot publication reads the already-approved open file descriptor so a pathname replacement cannot change the file being captured. Prototype code cannot read the Olympus parent document.

This is not a general-purpose browser, a hosted-app deployment service, or a production approval subsystem. Executable remote-app previews and coordinate annotations remain separate future work.

## Verification

```sh
npm test -- tests/inline_previews.test.ts tests/inline_preview_ui.test.ts tests/assistant_attachments.test.ts
npm run typecheck
npm run build
```

A credential-free browser fixture mounts the real preview publisher, artifact routes, and React preview components without importing the production app or starting an agent:

```sh
node --import tsx tests/inline_preview_browser_fixture.ts
```

Open `http://127.0.0.1:4179/`. The fixture deliberately attempts a parent-document read and a blocked API request from its HTML prototype. `/qa/status` reports whether that request reached the fixture server. All fixture state is under an ignored `.tmp-native-qa-inline-*` directory in this checkout.

Stop the disposable fixture with Ctrl+C (or SIGTERM) after browser checks, including when a browser tool fails. Leaving it running keeps Hermes background work active and blocks follow-up messages for that task. Do not restart the production server to clear a test fixture.
