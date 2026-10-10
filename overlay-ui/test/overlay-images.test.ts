// Where an Image element's picture loads from (src/shared/images.ts): only names ChaosBot could have
// made, from the OBS route when live and the editor's own host otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageUrl, isImageName, setEditorImageBase } from '../src/shared/images.ts';

const name = 'a'.repeat(64) + '.png';

test('only a sha256 name with a picture extension is accepted', () => {
  assert.equal(isImageName(name), true);
  assert.equal(isImageName('A'.repeat(64) + '.png'), false);
  assert.equal(isImageName('a'.repeat(64) + '.svg'), false);
  assert.equal(isImageName('../' + name), false);
  assert.equal(isImageName(42), false);
});

test('OBS loads from the overlay port, the editor from its virtual host', () => {
  assert.equal(imageUrl(name, true), '/overlay/images/' + name);
  setEditorImageBase('https://overlay-images.chaosbot/');
  assert.equal(imageUrl(name, false), 'https://overlay-images.chaosbot/' + name);
  assert.equal(imageUrl('evil.png', true), null);
});

test('an editor base that is not a plain https host is ignored', () => {
  setEditorImageBase('javascript:alert(1)//');
  assert.equal(imageUrl(name, false), null);
});
