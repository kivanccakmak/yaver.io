import { resolveSDKDogfood } from '../dogfoodPolicy';

describe('resolveSDKDogfood', () => {
  it('fails closed unless Dogfood is explicitly enabled', () => {
    expect(resolveSDKDogfood({ accountIds: ['acct-1'], currentAccountId: 'acct-1' })).toMatchObject({
      active: false,
      code: 'SDK_DOGFOOD_DISABLED',
    });
  });

  it('requires an exact approved app-account ID', () => {
    expect(resolveSDKDogfood({ enabled: true, accountIds: ['acct-1'], currentAccountId: '' }).code)
      .toBe('SDK_DOGFOOD_ACCOUNT_REQUIRED');
    expect(resolveSDKDogfood({ enabled: true, accountIds: ['acct-1'], currentAccountId: 'acct-10' }).code)
      .toBe('SDK_DOGFOOD_ACCOUNT_NOT_ALLOWED');
    expect(resolveSDKDogfood({ enabled: true, accountIds: ['acct-1'], currentAccountId: 'acct-1' })).toMatchObject({
      active: true,
      code: 'SDK_DOGFOOD_ACTIVE',
      accountId: 'acct-1',
    });
  });

  it('supports an account-bound key-enrolled installation without an app backend', () => {
    expect(resolveSDKDogfood({ enabled: true, appId: 'io.example', installationStatus: 'active' }).code)
      .toBe('SDK_DOGFOOD_INSTALLATION_REQUIRED');
    expect(resolveSDKDogfood({ enabled: true, appId: 'io.example', installationId: 'install-1', installationStatus: 'pending' }).code)
      .toBe('SDK_DOGFOOD_INSTALLATION_NOT_ACTIVE');
    expect(resolveSDKDogfood({ enabled: true, appId: 'io.example', installationId: 'install-1', installationStatus: 'active' })).toMatchObject({
      active: true,
      code: 'SDK_DOGFOOD_ACTIVE',
      accountId: 'install-1',
    });
  });
});
