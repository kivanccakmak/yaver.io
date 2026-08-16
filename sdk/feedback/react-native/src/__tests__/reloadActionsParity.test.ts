import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `reloadActions.ts` is duplicated into yaver-feedback-react-native and
 * yaver-feedback-web on purpose — they are two independently published npm
 * packages, and neither may depend on the other.
 *
 * Duplication without a guard is DRIFT, and drift in this file is the worst
 * kind: it is a *policy* file. If the web copy stops returning [] for a
 * production build and the RN copy still does, the two SDKs disagree about
 * whether a shipped app may show a reload button — and nothing in `tsc`
 * notices, because they are separate compilation units.
 *
 * This is the same shape as beaconParity.test.ts in mobile/: read both
 * sources, assert they agree. Prove it by breaking it — change one word in
 * either copy and this test fails.
 */
const RN_COPY = join(__dirname, '..', 'reloadActions.ts');
const WEB_COPY = join(
  __dirname,
  '..', '..', '..', // sdk/feedback/react-native
  'web', 'src', 'reloadActions.ts',
);

describe('reloadActions parity between the RN and web SDKs', () => {
  it('both copies exist', () => {
    expect(() => readFileSync(RN_COPY, 'utf8')).not.toThrow();
    expect(() => readFileSync(WEB_COPY, 'utf8')).not.toThrow();
  });

  it('is byte-identical across the two packages', () => {
    const rn = readFileSync(RN_COPY, 'utf8');
    const web = readFileSync(WEB_COPY, 'utf8');
    expect(rn).toEqual(web);
  });

  it('still carries the production guard in BOTH copies', () => {
    // Named separately from the byte comparison so that if someone
    // legitimately reformats both files the failure still points at the one
    // line that actually matters.
    for (const [name, path] of [['react-native', RN_COPY], ['web', WEB_COPY]] as const) {
      const source = readFileSync(path, 'utf8');
      expect(`${name}: ${source.includes('if (!opts.isDevBuild) return [];')}`).toEqual(
        `${name}: true`,
      );
    }
  });
});
