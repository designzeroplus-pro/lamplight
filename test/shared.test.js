const test = require('node:test');
const assert = require('node:assert/strict');
const {
  previewOf, sortNotes, mdToHtml, templateHtml, renumberList, isNewer,
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

test('templateHtml frames a Notepad window around the whole note', () => {
  const html = templateHtml('notepad', '# 제목\n\n본문', { title: '<비> & 우산', date: '2026.10.08' });
  assert.match(html, /^<div class="w95-title"><i class="w95-ico"><\/i><b>&lt;비&gt; &amp; 우산 - 메모장<\/b>/);
  assert.match(html, /<div class="w95-field np-text"><h1>제목<\/h1>/);
  assert.match(html, /<div class="w95-status"><span>2026\.10\.08<\/span>/);
});

test('templateHtml lifts the head into mail fields and signs the letter', () => {
  const html = templateHtml('mail', '# 잘 지내니\n\n2026. 10. 08. (목)\n\n---\n\n오늘은 비.\n\n— 오늘의 내가');
  assert.match(html, /<span>제목:<\/span><b class="w95-field">잘 지내니<\/b>/);
  assert.match(html, /<span>날짜:<\/span><b class="w95-field">2026\. 10\. 08\. \(목\)<\/b>/);
  assert.match(html, /<div class="w95-field ml-body"><p>오늘은 비\.<\/p>\n<p class="sign">— 오늘의 내가<\/p><\/div>/);
  assert.doesNotMatch(html, /<h1>|<hr>/);
});

test('templateHtml keeps a first paragraph that is not a date', () => {
  assert.match(templateHtml('bbs', '# 제목\n\n그냥 첫 문단'), /<div class="bb-body"><p>그냥 첫 문단<\/p>/);
});

test('templateHtml frames a receipt with leaders, a stable serial and barcode', () => {
  const md = '# 하루\n\n- 커피 ··· ×2\n- **합계** ... 괜찮은 날\n- 그냥 항목';
  const html = templateHtml('receipt', md, { seed: 'note-1' });
  assert.match(html, /^<header class="rc-head">/);
  assert.match(html, /<li class="item"><span>커피<\/span><i><\/i><span>×2<\/span><\/li>/);
  assert.match(html, /<li class="item"><span><strong>합계<\/strong><\/span><i><\/i><span>괜찮은 날<\/span><\/li>/);
  assert.match(html, /<li>그냥 항목<\/li>/);
  assert.match(html, /No\. \d{4}<\/small>/);
  assert.equal(html, templateHtml('receipt', md, { seed: 'note-1' }));
  assert.notEqual(html.match(/No\. \d{4}/)[0], templateHtml('receipt', '', { seed: 'note-2' }).match(/No\. \d{4}/)[0]);
});

test('templateHtml prints the poem on a terminal after its command', () => {
  const html = templateHtml('terminal', '# 비\n\n2026. 10. 08.\n\n---\n\n한 줄');
  assert.match(html, /TYPE POEM\.TXT<\/p>\n<h1>비<\/h1><p class="tm-date">2026\. 10\. 08\.<\/p>\n<p>한 줄<\/p>/);
});

test('templateHtml picks one desktop line: quote first, then the body', () => {
  assert.match(templateHtml('desktop', '# 비\n\n날짜 1\n\n---\n\n첫 문단\n\n> 남는 한 줄'), /len-l"><p>남는 한 줄<\/p>[\s\S]*<i class="dt-task">비<\/i>/);
  assert.match(templateHtml('desktop', '# 비\n\n날짜 1\n\n---\n\n첫 문단\n\n둘째'), /len-l"><p>첫 문단<\/p>/);
  assert.match(templateHtml('desktop', '그냥 한 줄', { title: '제목' }), /<p>그냥 한 줄<\/p>[\s\S]*<i class="dt-task">제목<\/i>/);
});

test('templateHtml lays a note on paper: title, body, date', () => {
  const html = templateHtml('lt-lined', '# 비 <오는> 날\n\n2026. 10. 08.\n\n---\n\n안녕.\n\n— 오늘의 나', {});
  assert.match(html, /<p class="lt-heading">비 &lt;오는&gt; 날<\/p>/);
  assert.match(html, /<div class="lt-body"><p>안녕\.<\/p>\n<p class="sign">— 오늘의 나<\/p><\/div>/);
  assert.match(html, /<p class="lt-date">2026\. 10\. 08\.<\/p><\/div>$/);
  assert.doesNotMatch(html, /<h1>|<hr>/);
  assert.match(templateHtml('lt-lined', '본문', { title: '<제목>', date: '2026.10.08' }), /lt-heading">&lt;제목&gt;<\/p>[\s\S]*lt-date">2026\.10\.08</);
});

test('templateHtml puts every 원고지 character in its own square', () => {
  const html = templateHtml('lt-genko', '비 와&요', {});
  assert.match(html, /<div class="lt-body"><p><i><\/i><i>비<\/i><i><\/i><i>와<\/i><i>&amp;<\/i><i>요<\/i><\/p><\/div>/);
});

test('templateHtml stamps the wax seal and monogram with the first letter of the title', () => {
  assert.match(templateHtml('lt-wax', '# kim\n\n본문'), />K<\/text>/);
  assert.match(templateHtml('lt-gold', '본문', {}), /<div class="lt-monogram"><span>L<\/span><\/div>/);
});

test('templateHtml sets typographic posters from the title and lines', () => {
  const md = '# 비 오는 날\n\n2026. 10. 08.\n\n---\n\n마음이 놓였다.\n\n- 커피 두 잔\n- <통화>';
  const meta = { date: '2026.10.08' };
  assert.match(templateHtml('tp-slide', md, meta), /<h2 class="tp-big sz-1">비 오는 날<\/h2>/);
  assert.match(templateHtml('tp-orange', md, meta), /<li>마음이 놓였다\.<\/li><li class="dim">커피 두 잔<\/li><li class="dim">&lt;통화&gt;<\/li>/);
  assert.match(templateHtml('tp-manifesto', md, meta), /<p class="tp-num">\( 08 \)<\/p>/);
  assert.match(templateHtml('tp-list', md, meta), /<li>마음이 놓였다,<\/li><li>커피 두 잔,<\/li><li>&lt;통화&gt;\.<\/li>/);
  assert.match(templateHtml('tp-specimen', md, meta), /^<p class="tp-big sz-1">마음이 놓였다\.<\/p>/);
  assert.match(templateHtml('tp-bold', '본문만', { title: '제목' }), /<h2 class="tp-big sz-1">제목<\/h2>/);
});

test('typographic text steps down in size as it gets longer', () => {
  const big = (t) => templateHtml('tp-specimen', `# 제목\n\n${t}`).match(/tp-big (sz-\d)/)[1];
  assert.equal(big('짧다'), 'sz-1');
  assert.equal(big('가'.repeat(40)), 'sz-3');
  assert.equal(big('가'.repeat(200)), 'sz-5');
});
