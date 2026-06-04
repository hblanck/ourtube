'use strict';

const path = require('path');
const {
  aggregateMediaRows,
  buildVirtualMediaId,
  buildVirtualMediaItem,
  getStitchGroupPath,
  isVirtualMediaId,
  parseVirtualMediaId,
  parseTags,
  sortMediaItems,
  sortSegmentRows,
} = require('../src/virtual-media');

function buildSegment(overrides = {}) {
  return {
    id: 'seg-1',
    source_location_id: 7,
    source_location_name: 'Library',
    source_location_path: '/media',
    source_entry_path: '/media/events',
    source_entry_type: 'directory',
    stitch_directories: 1,
    type: 'video',
    file_path: '/media/events/day1/clip1.mp4',
    file_name: 'clip1.mp4',
    friendly_name: 'Trip Clip',
    description: 'Trip',
    duration: 15,
    size: 1500,
    width: 1920,
    height: 1080,
    tags: '["family","trip"]',
    faces_detected: 1,
    view_count: 2,
    created_at: '2024-01-02T00:00:00.000Z',
    modified_at: '2024-01-03T00:00:00.000Z',
    indexed_at: '2024-01-04T00:00:00.000Z',
    thumbnail_path: '/thumbs/clip1.jpg',
    visibility: 'all',
    source_visibility: 'all',
    downloadable: 0,
    ...overrides,
  };
}

describe('virtual media helpers', () => {
  test('buildVirtualMediaId and parseVirtualMediaId round-trip values', () => {
    const id = buildVirtualMediaId(42, '/media/group/a');
    const parsed = parseVirtualMediaId(id);

    expect(parsed).toEqual({ sourceLocationId: 42, groupPath: '/media/group/a' });
    expect(isVirtualMediaId(id)).toBe(true);
    expect(isVirtualMediaId('plain-id')).toBe(false);
    expect(parseVirtualMediaId('virtual_bad')).toBeNull();
  });

  test('parseTags handles arrays, json strings, and invalid input', () => {
    expect(parseTags(['one', '', 'two', null])).toEqual(['one', 'two']);
    expect(parseTags('["a", "", "b"]')).toEqual(['a', 'b']);
    expect(parseTags('{"not":"array"}')).toEqual([]);
    expect(parseTags('not-json')).toEqual([]);
  });

  test('sortMediaItems sorts text fields case-insensitively and respects order', () => {
    const items = [
      { id: '3', friendly_name: 'zeta', indexed_at: '2024-01-01T00:00:00Z' },
      { id: '1', friendly_name: 'Alpha', indexed_at: '2024-01-03T00:00:00Z' },
      { id: '2', friendly_name: 'beta', indexed_at: '2024-01-02T00:00:00Z' },
    ];

    expect(sortMediaItems(items, 'friendly_name', 'ASC').map(item => item.id)).toEqual(['1', '2', '3']);
    expect(sortMediaItems(items, 'friendly_name', 'DESC').map(item => item.id)).toEqual(['3', '2', '1']);
    expect(sortMediaItems(items, 'indexed_at', 'DESC').map(item => item.id)).toEqual(['1', '2', '3']);
  });

  test('sortSegmentRows orders by created_at then modified_at then file path', () => {
    const rows = [
      { file_path: '/b.mp4', created_at: '2024-01-02T00:00:00Z', modified_at: '2024-01-03T00:00:00Z' },
      { file_path: '/a.mp4', created_at: '2024-01-01T00:00:00Z', modified_at: '2024-01-05T00:00:00Z' },
      { file_path: '/c.mp4', created_at: '2024-01-02T00:00:00Z', modified_at: '2024-01-01T00:00:00Z' },
    ];

    expect(sortSegmentRows(rows).map(row => path.basename(row.file_path))).toEqual(['a.mp4', 'c.mp4', 'b.mp4']);
  });

  test('getStitchGroupPath returns expected grouping path for stitchable rows', () => {
    const stitched = buildSegment();
    expect(getStitchGroupPath(stitched)).toBe(path.join('/media/events', 'day1'));

    const directChild = buildSegment({ file_path: '/media/events/clip1.mp4' });
    expect(getStitchGroupPath(directChild)).toBe('/media/events');

    const outsideEntry = buildSegment({ file_path: '/outside/clip1.mp4' });
    expect(getStitchGroupPath(outsideEntry)).toBe('/media/events');

    expect(getStitchGroupPath(buildSegment({ stitch_directories: 0 }))).toBeNull();
    expect(getStitchGroupPath(buildSegment({ type: 'photo' }))).toBeNull();
  });

  test('buildVirtualMediaItem merges segment data with restrictive visibility', () => {
    const rows = [
      buildSegment({
        id: 'seg-a',
        file_path: '/media/events/day1/clip1.mp4',
        tags: '["family","trip"]',
        duration: 10,
        size: 100,
        faces_detected: 2,
        view_count: 3,
        visibility: 'all',
        source_visibility: 'admin',
        downloadable: 1,
      }),
      buildSegment({
        id: 'seg-b',
        file_path: '/media/events/day1/clip2.mp4',
        file_name: 'clip2.mp4',
        tags: '["trip","holiday"]',
        duration: 20,
        size: 200,
        faces_detected: 1,
        view_count: 5,
        created_at: '2024-01-05T00:00:00.000Z',
        modified_at: '2024-01-06T00:00:00.000Z',
        indexed_at: '2024-01-07T00:00:00.000Z',
        visibility: 'none',
        downloadable: 1,
      }),
    ];

    const item = buildVirtualMediaItem(rows, { includeSegments: true });

    expect(item.is_virtual).toBe(1);
    expect(item.segment_count).toBe(2);
    expect(item.duration).toBe(30);
    expect(item.size).toBe(300);
    expect(item.faces_detected).toBe(3);
    expect(item.view_count).toBe(8);
    expect(item.visibility).toBe('none');
    expect(item.source_visibility).toBe('admin');
    expect(item.downloadable).toBe(1);
    expect(item.tags.sort()).toEqual(['family', 'holiday', 'trip']);
    expect(item.raw_metadata).toEqual(expect.objectContaining({ stitched: true, segment_count: 2 }));
    expect(item.segments).toHaveLength(2);
    expect(item.segments.every(segment => segment.downloadable === 1)).toBe(true);
    expect(item.id).toBe(buildVirtualMediaId(7, '/media/events/day1'));
  });

  test('aggregateMediaRows returns standalone and grouped virtual items', () => {
    const standalone = buildSegment({
      id: 'solo',
      stitch_directories: 0,
      type: 'photo',
      tags: '["solo"]',
      downloadable: 1,
      source_entry_type: 'file',
      source_entry_path: '/media/events/solo.jpg',
      file_path: '/media/events/solo.jpg',
    });

    const groupedA = buildSegment({ id: 'g1', file_path: '/media/events/day2/clip1.mp4', file_name: 'clip1.mp4' });
    const groupedB = buildSegment({ id: 'g2', file_path: '/media/events/day2/clip2.mp4', file_name: 'clip2.mp4' });

    const items = aggregateMediaRows([standalone, groupedA, groupedB]);

    expect(items).toHaveLength(2);

    const solo = items.find(item => item.id === 'solo');
    expect(solo).toEqual(expect.objectContaining({
      is_virtual: 0,
      segment_count: 1,
      downloadable: 1,
      tags: ['solo'],
    }));

    const virtual = items.find(item => item.is_virtual === 1);
    expect(virtual).toEqual(expect.objectContaining({
      segment_count: 2,
      source_entry_type: 'directory',
      type: 'video',
    }));
  });
});
