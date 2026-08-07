/**
 * Every grammar Olympus highlights, in one module so the bundler emits a single
 * lazily-loaded chunk instead of one chunk per language. Importing `shiki`
 * directly pulls in its full bundled-language map, which made the build emit 300+
 * grammar chunks and fetch a new one for every distinct language in a thread.
 *
 * Languages outside this list still render, just without highlighting.
 */
import githubDark from 'shiki/themes/github-dark.mjs';
import githubLight from 'shiki/themes/github-light.mjs';

import bash from 'shiki/langs/bash.mjs';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import csharp from 'shiki/langs/csharp.mjs';
import css from 'shiki/langs/css.mjs';
import diff from 'shiki/langs/diff.mjs';
import docker from 'shiki/langs/docker.mjs';
import go from 'shiki/langs/go.mjs';
import graphql from 'shiki/langs/graphql.mjs';
import html from 'shiki/langs/html.mjs';
import ini from 'shiki/langs/ini.mjs';
import java from 'shiki/langs/java.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsonc from 'shiki/langs/jsonc.mjs';
import kotlin from 'shiki/langs/kotlin.mjs';
import lua from 'shiki/langs/lua.mjs';
import makefile from 'shiki/langs/make.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import php from 'shiki/langs/php.mjs';
import powershell from 'shiki/langs/powershell.mjs';
import python from 'shiki/langs/python.mjs';
import ruby from 'shiki/langs/ruby.mjs';
import rust from 'shiki/langs/rust.mjs';
import sql from 'shiki/langs/sql.mjs';
import swift from 'shiki/langs/swift.mjs';
import toml from 'shiki/langs/toml.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';

export const themes = [githubLight, githubDark];

export const grammars = [
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  docker,
  go,
  graphql,
  html,
  ini,
  java,
  javascript,
  json,
  jsonc,
  kotlin,
  lua,
  makefile,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  sql,
  swift,
  toml,
  tsx,
  typescript,
  xml,
  yaml,
];
