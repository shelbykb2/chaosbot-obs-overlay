import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HubState } from '../src/shared/hubState.ts';

test('late widgets receive every goal and current moderated chat', () => {
  const state = new HubState();
  state.remember('scene', { doc: { scenes: [{ elements: [{ id: 'a', type: 'goal' }, { id: 'b', type: 'goal' }] }] } });
  state.remember('goal', { id: 'a', current: 4 });
  state.remember('goal', { id: 'b', current: 7 });
  state.remember('chatHistory', { lines: [{ id: '1', user: 'bad' }, { id: '2', user: 'viewer' }] });
  state.remember('chat', { line: { id: '3', user: 'viewer' } });
  state.remember('chatClear', { user: 'BAD' });
  const goals: unknown[] = []; let history: any;
  state.replay({ goal: (g) => goals.push(g), chatHistory: (h) => history = h });
  assert.deepEqual(goals, [{ id: 'a', current: 4 }, { id: 'b', current: 7 }]);
  assert.deepEqual(history.lines.map((l: any) => l.id), ['2', '3']);
  state.remember('chatClear', { id: '2' });
  state.replay({ chatHistory: (h) => history = h });
  assert.deepEqual(history.lines.map((l: any) => l.id), ['3']);
  state.remember('chatClear', { all: true });
  state.replay({ chatHistory: (h) => history = h });
  assert.deepEqual(history.lines, []);
});

test('retained history is bounded and deleted goals are not replayed', () => {
  const state = new HubState();
  for (let n = 0; n < 50; n++) state.remember('chat', { line: { id: String(n), user: 'viewer' } });
  state.remember('chat', { line: { id: '49', user: 'viewer' } });
  state.remember('goal', { id: 'deleted', current: 5 });
  state.remember('scene', { doc: { scenes: [{ elements: [] }] } });
  let history: any; let goals = 0;
  state.replay({ chatHistory: (h) => history = h, goal: () => goals++ });
  assert.equal(history.lines.length, 30);
  assert.equal(history.lines[0].id, '20');
  assert.equal(goals, 0);
  state.clear();
  state.replay({ chatHistory: () => assert.fail('Disposed page retained chat') });
});
