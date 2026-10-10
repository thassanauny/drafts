import { describe, expect, it } from 'vitest';
import { suggestOutputName } from '../src/lib/util';

describe('output name suggestions', () => {
  it('follows source changes and resets when a collection is emptied', () => {
    const control = document.createElement('input');
    control.value = 'merged';
    const suggest = suggestOutputName(control, 'merged');
    suggest('Annual report.v2.pdf');
    expect(control.value).toBe('Annual report.v2_merged');
    suggest('বাংলা.pdf');
    expect(control.value).toBe('বাংলা_merged');
    suggest();
    expect(control.value).toBe('');
  });

  it('replaces custom names, cleared fields, and restored drafts on source selection', () => {
    const control = document.createElement('input');
    control.value = 'cropped';
    const suggest = suggestOutputName(control, 'cropped');
    control.value = 'My saved name';
    suggest('photo.jpg');
    expect(control.value).toBe('photo_cropped');
    control.value = '';
    suggest('other.png');
    expect(control.value).toBe('other_cropped');
    control.value = 'Restored draft';
    suggest('other.png');
    expect(control.value).toBe('other_cropped');
  });
});
