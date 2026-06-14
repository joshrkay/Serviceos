import { describe, it, expect } from 'vitest';
import { parsePhotoCaption } from '../../src/jobs/photo-caption';

describe('parsePhotoCaption', () => {
  it('extracts category + job reference', () => {
    expect(parsePhotoCaption('Henderson before')).toEqual({
      category: 'before',
      jobReference: 'Henderson',
    });
    expect(parsePhotoCaption('after photo, Miller job')).toEqual({
      category: 'after',
      jobReference: 'Miller',
    });
  });

  it('maps completion synonyms', () => {
    expect(parsePhotoCaption('Davis done').category).toBe('completion');
    expect(parsePhotoCaption('finished the Smith install').category).toBe('completion');
  });

  it('maps problem synonyms', () => {
    expect(parsePhotoCaption('broken valve at the Jones place').category).toBe('problem');
    expect(parsePhotoCaption('leak under the sink').category).toBe('problem');
  });

  it('defaults to other and no reference for an empty caption', () => {
    expect(parsePhotoCaption('')).toEqual({ category: 'other' });
    expect(parsePhotoCaption('   ')).toEqual({ category: 'other' });
    expect(parsePhotoCaption(undefined)).toEqual({ category: 'other' });
  });

  it('keeps a reference when no category cue is present', () => {
    expect(parsePhotoCaption('the Henderson kitchen')).toEqual({
      category: 'other',
      jobReference: 'Henderson kitchen',
    });
  });

  it('drops filler words from the reference', () => {
    // "before" + "photo"/"of"/"the" are all stripped, leaving the name.
    expect(parsePhotoCaption('before photo of the Rodriguez')).toEqual({
      category: 'before',
      jobReference: 'Rodriguez',
    });
  });
});
