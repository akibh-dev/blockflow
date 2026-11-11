/** Pure helpers for deciding whether a workflow touches secrets. */

import type { Workflow } from './types';

/** `{{secret.name}}` anywhere in a node's config. A literal "secret." outside braces does not count. */
const SECRET_TEMPLATE = /\{\{[^}]*\bsecret\./;

/** True when any node's config references a secret (`{{secret.name}}`). */
export function usesSecrets(workflow: Workflow): boolean {
  return workflow.nodes.some((node) => SECRET_TEMPLATE.test(JSON.stringify(node.config)));
}
