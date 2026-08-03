import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function copyBuildAssets(sourceRoot, destinationRoot) {
  const copied = [];

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const source = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(source);
      } else if (entry.isFile() && (entry.name.endsWith('.sql') || entry.name.endsWith('.py'))) {
        const asset = relative(sourceRoot, source);
        const destination = join(destinationRoot, asset);
        await mkdir(dirname(destination), { recursive: true });
        await cp(source, destination);
        copied.push(asset);
      }
    }
  }

  await walk(sourceRoot);
  return copied;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  await copyBuildAssets(join(repositoryRoot, 'server'), join(repositoryRoot, 'dist', 'server', 'server'));
}
