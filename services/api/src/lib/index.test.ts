import { expect, it } from 'vitest';
import { isValidStatusChange } from './index';

it('delega en la máquina de estados compartida', () => {
  expect(isValidStatusChange('nueva', 'en_revision')).toBe(true);
  expect(isValidStatusChange('nueva', 'ganada')).toBe(false);
});
