const test = require('node:test');
const assert = require('node:assert/strict');
const {
  previewOf, sortNotes, mdToHtml, renumberList, isNewer,
} = require('../src/shared');

test('previewOf strips ink markers and markdown punctuation', () => {
  assert.equal(previewOf('⁣# 제목\n> 인용 **굵게**\n\n본문'), '제목 인용 굵게 본문');
  assert.equal(previewOf(''), '');
  assert.equal(previewOf('가'.repeat(100)).length, 80);
});

test('sortNotes puts pinned notes first, then the chosen order', () => {
  const notes = [
    { id: 'a', title: '나', updatedAt: 3, createdAt: 1 },
    { id: 'b', title: '가', updatedAt: 1, createdAt: 3, pinned: true },
    { id: 'c', title: '다', updatedAt: 2, createdAt: 2 },
  ];
  assert.deepEqual(sortNotes(notes).map((n) => n.id), ['b', 'a', 'c']);
  assert.deepEqual(sortNotes(notes, 'created').map((n) => n.id), ['b', 'c', 'a']);
  assert.deepEqual(sortNotes(notes, 'title').map((n) => n.id), ['b', 'a', 'c']);
  assert.deepEqual(notes.map((n) => n.id), ['a', 'b', 'c'], 'does not mutate');
});

test('mdToHtml renders headings, lists, tasks and inline marks', () => {
  assert.equal(mdToHtml('# 제목'), '<h1>제목</h1>');
  assert.equal(mdToHtml('- 하나\n- 둘'), '<ul>\n<li>하나</li>\n<li>둘</li>\n</ul>');
  assert.equal(mdToHtml('1. a\n  - b'), '<ol>\n<li>a</li>\n<ul>\n<li>b</li>\n</ul>\n</ol>');
  assert.match(mdToHtml('- [x] 끝'), /class="task".*☑/);
  assert.equal(mdToHtml('**굵게** *기울임* `코드`'), '<p><strong>굵게</strong> <em>기울임</em> <code>코드</code></p>');
  assert.equal(mdToHtml('[14:30] 시작'), '<p><span class="stamp">[14:30]</span> 시작</p>');
  assert.equal(mdToHtml('---'), '<hr>');
});

test('mdToHtml escapes HTML', () => {
  assert.equal(mdToHtml('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
});

test('renumberList rewrites numbers after an item moves', () => {
  const v = '1. a\n3. b\n7. c';
  const r = renumberList(v, 0, v.length);
  assert.equal(r.text, '1. a\n2. b\n3. c');
  assert.equal(r.start, 0);
  assert.equal(r.end, v.length);
});

test('renumberList keeps the first number and restarts nested levels', () => {
  const v = '5. a\n  9. x\n  9. y\n9. b';
  assert.equal(renumberList(v, 0, 0).text, '5. a\n  1. x\n  2. y\n6. b');
});

test('renumberList returns null when nothing changes or not in a list', () => {
  assert.equal(renumberList('1. a\n2. b', 0, 0), null);
  assert.equal(renumberList('그냥 글', 0, 0), null);
});

test('renumberList shifts the caret past widened numbers', () => {
  const v = `${Array.from({ length: 10 }, () => '1. x').join('\n')}`;
  const r = renumberList(v, 0, v.length);
  assert.equal(r.text.split('\n')[9], '10. x');
  assert.equal(r.caret, v.length + 1);
});

test('isNewer compares semantic versions', () => {
  assert.equal(isNewer('0.2.1', '0.2.0'), true);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.2.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);
  assert.equal(isNewer('1', '0.9'), true);
});
