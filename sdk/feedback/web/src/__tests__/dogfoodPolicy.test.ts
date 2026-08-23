import { resolveSDKDogfood } from '../dogfoodPolicy';

describe('resolveSDKDogfood', () => {
  it('fails closed for missing, disabled, and unapproved accounts', () => {
    expect(resolveSDKDogfood().code).toBe('SDK_DOGFOOD_DISABLED');
    expect(resolveSDKDogfood({ enabled: true, accountIds: [], currentAccountId: 'acct-1' }).code)
      .toBe('SDK_DOGFOOD_ACCOUNT_NOT_ALLOWED');
    expect(resolveSDKDogfood({ enabled: true, accountIds: ['acct-1'], currentAccountId: 'ACCT-1' }).active)
      .toBe(false);
  });

  it('activates only for an exact approved app-account ID', () => {
    expect(resolveSDKDogfood({
      enabled: true,
      accountIds: [' acct-1 '],
      currentAccountId: 'acct-1',
      label: 'SFMG',
    })).toEqual({
      active: true,
      code: 'SDK_DOGFOOD_ACTIVE',
      accountId: 'acct-1',
      label: 'SFMG',
    });
  });
});
