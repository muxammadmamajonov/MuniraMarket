import { USER_ROLES } from '@muniramarket/contracts';
import { describe, expect, it } from 'vitest';
import { isStaff } from './roles';

describe('isStaff', () => {
  it('admits exactly operator and admin', () => {
    expect(USER_ROLES.filter((role) => isStaff({ role }))).toEqual(['operator', 'admin']);
  });

  it('refuses nobody-in-particular', () => {
    expect(isStaff(null)).toBe(false);
  });
});
