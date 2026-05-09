'use strict';

jest.mock('../src/admin-auth', () => ({
  isAdminAuthenticated: jest.fn(),
}));

const { isAdminAuthenticated } = require('../src/admin-auth');
const {
  VISIBILITY_ALL,
  VISIBILITY_ADMIN_ONLY,
  VISIBILITY_NONE,
  normalizeVisibility,
  mediaVisibilityCondition,
  sourceVisibilityCondition,
  canAccessFromRow,
} = require('../src/visibility');

describe('visibility helpers', () => {
  beforeEach(() => {
    isAdminAuthenticated.mockReset();
  });

  test('normalizeVisibility normalizes valid values and falls back for invalid values', () => {
    expect(normalizeVisibility(' ALL ')).toBe(VISIBILITY_ALL);
    expect(normalizeVisibility('admin')).toBe(VISIBILITY_ADMIN_ONLY);
    expect(normalizeVisibility('none')).toBe(VISIBILITY_NONE);
    expect(normalizeVisibility('invalid')).toBe(VISIBILITY_ALL);
    expect(normalizeVisibility('', VISIBILITY_NONE)).toBe(VISIBILITY_NONE);
  });

  test('mediaVisibilityCondition returns public constraint for non-admin mode', () => {
    isAdminAuthenticated.mockReturnValue(false);

    const condition = mediaVisibilityCondition('media_alias', 'src_alias', { headers: {} });

    expect(condition).toContain("COALESCE(media_alias.visibility, 'all') = 'all'");
    expect(condition).toContain("COALESCE(src_alias.visibility, 'all') = 'all'");
  });

  test('mediaVisibilityCondition returns non-hidden constraint for admin mode', () => {
    isAdminAuthenticated.mockReturnValue(true);

    const condition = mediaVisibilityCondition('m', 'sl', { headers: {} });

    expect(condition).toContain("COALESCE(m.visibility, 'all') != 'none'");
    expect(condition).toContain("COALESCE(sl.visibility, 'all') != 'none'");
  });

  test('sourceVisibilityCondition switches between public and admin constraints', () => {
    isAdminAuthenticated.mockReturnValue(false);
    expect(sourceVisibilityCondition('src', {})).toContain("COALESCE(src.visibility, 'all') = 'all'");

    isAdminAuthenticated.mockReturnValue(true);
    expect(sourceVisibilityCondition('src', {})).toContain("COALESCE(src.visibility, 'all') != 'none'");
  });

  test('canAccessFromRow enforces none/admin visibility rules', () => {
    isAdminAuthenticated.mockReturnValue(false);

    expect(canAccessFromRow({ visibility: 'all', source_visibility: 'all' }, {})).toBe(true);
    expect(canAccessFromRow({ visibility: 'none', source_visibility: 'all' }, {})).toBe(false);
    expect(canAccessFromRow({ visibility: 'all', source_visibility: 'none' }, {})).toBe(false);
    expect(canAccessFromRow({ media_visibility: 'admin', source_location_visibility: 'all' }, {})).toBe(false);

    isAdminAuthenticated.mockReturnValue(true);
    expect(canAccessFromRow({ media_visibility: 'admin', source_location_visibility: 'admin' }, {})).toBe(true);
    expect(canAccessFromRow({ media_visibility: 'none', source_location_visibility: 'admin' }, {})).toBe(false);
  });
});
