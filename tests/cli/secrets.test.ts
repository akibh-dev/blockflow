import { describe, expect, it } from 'vitest';
import { collectSecrets, lowerCamel } from '../../packages/cli/index.mjs';

describe('lowerCamel', () => {
  it.each([
    ['API_TOKEN', 'apiToken'],
    ['LOGIN_PASSWORD', 'loginPassword'],
    ['TOKEN', 'token'],
    ['A__B_', 'aB'],
    ['OAUTH2_KEY', 'oauth2Key'],
    ['myToken', 'myToken'],
    ['123', '123'],
  ])('%s → %s', (name, expected) => expect(lowerCamel(name)).toBe(expected));
});

describe('collectSecrets', () => {
  it('maps BLOCKFLOW_SECRET_<NAME> to NAME and lowerCamel, ignoring other variables', () => {
    expect(collectSecrets({ BLOCKFLOW_SECRET_API_TOKEN: 't', BLOCKFLOW_SECRET_: 'ignored', PATH: '/bin', BLOCKFLOW_SOCKET: 's' })).toEqual({ API_TOKEN: 't', apiToken: 't' });
  });

  it('lets --secret win over the environment', () => {
    expect(collectSecrets({ BLOCKFLOW_SECRET_API_TOKEN: 'env' }, { apiToken: 'flag' })).toEqual({ API_TOKEN: 'env', apiToken: 'flag' });
  });

  it('does not let an alias overwrite an exact name from the environment', () => {
    expect(collectSecrets({ BLOCKFLOW_SECRET_apiToken: 'exact', BLOCKFLOW_SECRET_API_TOKEN: 'upper' })).toEqual({ apiToken: 'exact', API_TOKEN: 'upper' });
  });

  it('is empty without secrets', () => {
    expect(collectSecrets({})).toEqual({});
  });
});
