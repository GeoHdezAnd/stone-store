import { describe, expect, it } from 'vitest';

import { mediaBucketName, publishBucketName } from '../bucket-names.js';
import { parseSiteDistributionId } from '../cdn-grant.js';

describe('parseSiteDistributionId', () => {
  it('vacío o ausente significa "sin distribución" (falla cerrado)', () => {
    expect(parseSiteDistributionId(undefined)).toBeUndefined();
    expect(parseSiteDistributionId('')).toBeUndefined();
    expect(parseSiteDistributionId('   ')).toBeUndefined();
  });

  it('acepta un id de distribución válido (recortado)', () => {
    expect(parseSiteDistributionId(' E1ABCDEF234567 ')).toBe('E1ABCDEF234567');
  });

  it.each([
    'e1abcdef234567',
    'E1',
    'E1ABCDEF234567890123456',
    'E1ABC/../x',
    '*',
    'E1ABCDEF 234567',
  ])('rechaza "%s"', (raw) => {
    expect(() => parseSiteDistributionId(raw)).toThrow(/SITE_DISTRIBUTION_ID/);
  });
});

describe('nombres de bucket fijos', () => {
  it('son deterministas por entorno y distintos entre sí', () => {
    expect(mediaBucketName('dev')).not.toBe(mediaBucketName('prod'));
    expect(mediaBucketName('dev')).not.toBe(publishBucketName('dev'));
  });
});
