"""Built-image policy contract: real Hermes rendering and tool admission, no model I/O."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = os.environ.get('OLYMPUS_NATIVE_HERMES_SOURCE')


@unittest.skipUnless(SOURCE, 'native Hermes source not selected')
class SkillPolicyTests(unittest.TestCase):
    def test_regular_sessions_keep_selective_guidance_and_normal_tools(self):
        sys.path.insert(0, SOURCE)
        from agent import oneshot_footprint, prompt_builder
        tools = [{'function': {'name': name}} for name in
                 ('skill_view', 'skill_manage', 'terminal', 'delegate_task')]
        with tempfile.TemporaryDirectory() as directory:
            skill = Path(directory) / 'upgrade-fixture'
            skill.mkdir()
            (skill / 'SKILL.md').write_text('---\nname: upgrade-fixture\ndescription: Fixture API conventions.\n---\nFixture only.\n')
            with patch.dict(os.environ, {'HERMES_SINGLE_QUERY_SESSION': ''}):
                regular = prompt_builder.build_skills_system_prompt(
                    available_tools={t['function']['name'] for t in tools}, skills_dir_override=Path(directory))
                self.assertFalse(oneshot_footprint.is_single_query_session())
                self.assertEqual(oneshot_footprint.prune_oneshot_tools(tools), tools)
                self.assertIn('only when it carries domain knowledge you lack', regular)
                self.assertNotIn('even partially relevant', regular)
                self.assertNotIn('one-shot run', regular)
                self.assertIn('upgrade-fixture', regular)
                self.assertIn('removing superseded wording', prompt_builder.SKILLS_GUIDANCE)
                self.assertIn('[SKILL_PRUNED]', prompt_builder.SKILLS_GUIDANCE)
            with patch.dict(os.environ, {'HERMES_SINGLE_QUERY_SESSION': '1'}):
                oneshot = prompt_builder.build_skills_system_prompt(
                    available_tools={'skill_view'}, skills_dir_override=Path(directory))
                self.assertIn('one-shot run', oneshot)
                self.assertEqual([t['function']['name'] for t in oneshot_footprint.prune_oneshot_tools(tools)],
                                 ['skill_view', 'terminal', 'delegate_task'])
                self.assertEqual(regular.split('<available_skills>', 1)[1], oneshot.split('<available_skills>', 1)[1])


if __name__ == '__main__':
    unittest.main()
