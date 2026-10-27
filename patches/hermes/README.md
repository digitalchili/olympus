# Selective skill policy

`selective-skills.patch` is a small downstream patch for the pinned Hermes
v0.22.5 source, `bf0203a794a07aac3ff764972ab9087baa4e4f4e`. The Docker runtime
applies it during the image build; a source mismatch fails the build.

Regular sessions reuse the selective skill-reading guidance already used by
one-shot sessions. Learning guidance favors verified reusable knowledge,
consolidation and removal of superseded wording. Specialized details belong in
references loaded on demand.

This changes prompt defaults only. It does not set `HERMES_SINGLE_QUERY_SESSION`,
remove tools, change delegation limits, disable the skill curator, rewrite
profile files, or rebuild the prompt of an active conversation. Existing skill
safety and prompt-restoration behavior remain intact. Native macOS Hermes
installations are not patched by the Olympus installer.

Fresh conversations receive the policy. Existing conversations retain their
cached prompt until native compaction or another normal prompt rebuild; a
deployment alone does not rewrite their context.

## Verification

In a disposable checkout of the exact Hermes revision, apply both patches:

```sh
git apply /path/to/Olympus/patches/hermes/selective-skills.patch
git apply /path/to/Olympus/patches/hermes/selective-skills-tests.patch
# Use the checkout's isolated test interpreter; see Hermes tests/AGENTS.md.
scripts/run_tests.sh \
  tests/agent/test_oneshot_footprint.py \
  tests/agent/test_prompt_builder.py \
  tests/agent/test_system_prompt.py \
  tests/agent/test_skills_guidance_content_filter.py \
  tests/agent/test_ghost_skill_pruning.py \
  tests/agent/test_system_prompt_restore.py \
  tests/agent/test_builtin_memory_disabled_surface.py
```

The updated regular-session regression failed against the old prompt. With the
patch, these checks passed: 189 tests, one macOS platform skip. The actual Docker
`hermes-policy` stage also built successfully. An offline probe inside that image
verified the regular-session prompt, unchanged tool filtering and delegation
budget, identical skill catalog, and isolated one-shot restrictions.
The full Olympus runtime image also passed the native worker acceptance suite,
including streamed/resumed turns, mid-session skill discovery and recovery.

The before-deployment Olympus chat completed a bounded standard-library coding
task with five passing tests and no skill loads. Its saved native prompt still
contained the old regular-session guidance. The requested native helper reached
the provider, but the installation's existing helper model was rejected before
it did work; this is a separate configuration issue, not evidence of a policy
regression.

These checks prove prompt delivery and runtime compatibility, not model behavior.
Acceptance still requires a fresh task through actual Olympus chat after a safe
deployment. Compare the same bounded coding request before and after; inspect
the actual skill/tool calls and native child result, not just the assistant's
claims. Do not restart or alter active work to obtain the comparison. Earlier
Hermes skill-authoring wording triggered Anthropic OAuth filtering; that provider
path also needs a live smoke test before claiming its compatibility.

The policy patch is unchanged from the Hermes 0.21.7 integration. The built-image
acceptance suite runs `test_skill_policy_native.py` against real Hermes and checks
the policy and retained `skill_manage` tool in actual worker/provider requests.
The pristine 0.22.5 image fails the selective-guidance regression, as expected.

On a Hermes image upgrade, review this patch against upstream and rerun the
checks. Drop it when upstream supplies the equivalent policy.
