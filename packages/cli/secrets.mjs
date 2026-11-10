// Secrets for a CLI run: BLOCKFLOW_SECRET_<NAME> environment variables plus --secret name=value flags.

export const SECRET_ENV_PREFIX = 'BLOCKFLOW_SECRET_';

/**
 * `API_TOKEN` → `apiToken`, `LOGIN_PASSWORD` → `loginPassword`, `TOKEN` → `token`.
 * Names that are not UPPER_SNAKE (`myToken`) are returned unchanged.
 * @param {string} name
 */
export function lowerCamel(name) {
  if (!/^[A-Z0-9_]+$/.test(name) || !/[A-Z]/.test(name)) return name;
  const words = name.toLowerCase().split('_').filter(Boolean);
  return words.map((word, index) => (index === 0 ? word : word[0].toUpperCase() + word.slice(1))).join('');
}

/**
 * Builds the secrets sent with `suite.run`. Each `BLOCKFLOW_SECRET_<NAME>` becomes secret `NAME` and its
 * lowerCamel form (`BLOCKFLOW_SECRET_API_TOKEN` → `API_TOKEN` and `apiToken`), so a workflow can write
 * `{{secret.apiToken}}`. `flags` (from `--secret name=value`) are applied last and win.
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, string>} [flags]
 * @returns {Record<string, string>}
 */
export function collectSecrets(env, flags = {}) {
  /** @type {Record<string, string>} */
  const secrets = {};
  // Exact names first, then the camelCase aliases, so an explicit BLOCKFLOW_SECRET_apiToken is not overwritten by API_TOKEN.
  const fromEnv = Object.entries(env)
    .filter(([key, value]) => key.startsWith(SECRET_ENV_PREFIX) && key.length > SECRET_ENV_PREFIX.length && value !== undefined)
    .map(([key, value]) => [key.slice(SECRET_ENV_PREFIX.length), /** @type {string} */ (value)]);
  for (const [name, value] of fromEnv) {
    const alias = lowerCamel(name);
    if (alias !== name && !fromEnv.some(([other]) => other === alias)) secrets[alias] = value;
  }
  for (const [name, value] of fromEnv) secrets[name] = value;
  for (const [name, value] of Object.entries(flags)) secrets[name] = value;
  return secrets;
}
