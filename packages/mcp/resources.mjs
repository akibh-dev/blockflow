// The documents an LLM needs to write workflows, served as MCP resources. A published package carries
// copies in ./resources (made by `npm pack` through the prepack script); in the repo they are read from
// docs/guide and llms.txt, so they are never stale while developing.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(PACKAGE_DIR, '../..');

/** uri, MCP name, file name in ./resources, path in the repo. */
export const RESOURCES = [
  {
    uri: 'blockflow://guide',
    name: 'guide',
    title: 'BlockFlow usage guide',
    description: 'How to write BlockFlow workflows: rules for AI tools, the script format, locators, waiting, error codes and the Repair table for import issues. Read first.',
    mimeType: 'text/markdown',
    file: 'README.md',
    repo: 'docs/guide/README.md',
  },
  {
    uri: 'blockflow://blocks',
    name: 'blocks',
    title: 'Block reference',
    description: 'Every block type with its config keys, defaults and outputs (generated from the code). Block keys and settings in a script must come from here.',
    mimeType: 'text/markdown',
    file: 'blocks.md',
    repo: 'docs/guide/blocks.md',
  },
  {
    uri: 'blockflow://script-schema',
    name: 'script-schema',
    title: 'Script JSON Schema',
    description: 'JSON Schema of the script format (blockflow-script, version 1). Unknown keys are errors.',
    mimeType: 'application/schema+json',
    file: 'script.schema.json',
    repo: 'docs/guide/script.schema.json',
  },
  {
    uri: 'blockflow://llms.txt',
    name: 'llms.txt',
    title: 'llms.txt',
    description: 'Short index of BlockFlow for language models: what to read in which order.',
    mimeType: 'text/plain',
    file: 'llms.txt',
    repo: 'llms.txt',
  },
];

/** Where a resource is read from: the packaged copy first, then the repo. */
export function resourcePath(resource, dirs = { packageDir: PACKAGE_DIR, repoDir: REPO_DIR }) {
  const packaged = path.join(dirs.packageDir, 'resources', resource.file);
  if (existsSync(packaged)) return packaged;
  const inRepo = path.join(dirs.repoDir, resource.repo);
  if (existsSync(inRepo)) return inRepo;
  throw new Error(`${resource.title} not found (looked in ${packaged} and ${inRepo}).`);
}

export function readResource(resource, dirs) {
  return readFileSync(resourcePath(resource, dirs), 'utf8');
}

/** Used by the prepack script: copies every resource from the repo into ./resources. */
export function copyResources(dirs = { packageDir: PACKAGE_DIR, repoDir: REPO_DIR }) {
  return RESOURCES.map((resource) => ({ from: path.join(dirs.repoDir, resource.repo), to: path.join(dirs.packageDir, 'resources', resource.file) }));
}
