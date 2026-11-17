// Offline DOM fixtures for the actual MK helper; no browser or HTML parser claims.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const text = data => ({text: data});
const br = (attrs = {}) => ({tag: 'br', attrs});
const p = (children = [br({'data-mce-bogus': '1'})], attrs = {}) => ({tag: 'p', attrs, children});
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

class FixtureNode {
  constructor(spec, parent = null) {
    this.parentElement = parent;
    this.nodeType = spec.type || (spec.tag ? 1 : 3);
    this.tagName = spec.tag?.toUpperCase();
    this.data = spec.text || '';
    this.attrs = {...spec.attrs};
    this.childNodes = (spec.children || []).map(child => new FixtureNode(child, this));
    this.writes = [];
  }
  get children() { return this.childNodes.filter(child => child.nodeType === 1); }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({name, value})); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.writes.push([name, value]); this.attrs[name] = value; }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(n => n.textContent).join(''); }
  get innerHTML() { return this.childNodes.map(n => n.outerHTML).join(''); }
  get outerHTML() {
    if (this.nodeType === 3) return escape(this.data);
    if (this.nodeType === 8) return `<!--${this.data}-->`;
    const tag = this.tagName.toLowerCase();
    const attrs = this.attributes.map(a => ` ${a.name}="${escape(a.value)}"`).join('');
    return `<${tag}${attrs}>` + (['br', 'img'].includes(tag) ? '' : this.innerHTML + `</${tag}>`);
  }
  matches(selector) {
    return selector.split(',').some(part => {
      if (part.trim().startsWith('.')) return (this.attrs.class || '').split(/\s+/).includes(part.trim().slice(1));
      const m = part.trim().match(/^(\w+)?(?:\[([\w-]+)(?:="([^"]+)")?\])?$/);
      return m && (!m[1] || m[1].toUpperCase() === this.tagName) && (!m[2] ||
        (m[3] ? this.attrs[m[2]] === m[3] : Object.hasOwn(this.attrs, m[2])));
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  get nextElementSibling() {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  remove() {
    const siblings = this.parentElement.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
}

function fixture(specs) {
  const body = new FixtureNode({tag: 'body', children: specs});
  const editor = {getBody: () => body, dirty: 0, saves: 0,
    setDirty(value) { assert.strictEqual(value, true); this.dirty++; },
    save() { this.saves++; }};
  const sandbox = {tinymce: {activeEditor: editor}};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../scripts/tistory-editor-helpers.js'), 'utf8') +
    '\nthis.api = {normalizeMKEmptyParagraphs, cleanupOGResiduals};', sandbox);
  return {body, editor, sandbox, ...sandbox.api};
}

function runTests() {
  const safe = [p(), p([br()]), p([text('\t \n\r\f\u00a0'), br(), br({'data-mce-bogus': '1'}), text(' ')]), p([text('\u00a0')])];
  const f = fixture(safe);
  const beforeNodes = [...f.body.childNodes];
  const beforeChildren = beforeNodes.map(n => [...n.childNodes]);
  const beforeHTML = beforeNodes.map(n => n.outerHTML);
  assert.strictEqual(f.normalizeMKEmptyParagraphs().normalized, 4);
  assert.strictEqual(f.editor.dirty, 1);
  assert.strictEqual(f.editor.saves, 0, 'caller saves after normalization');
  f.body.children.forEach((node, i) => {
    assert.strictEqual(node, beforeNodes[i], 'paragraph identity');
    assert.deepStrictEqual(node.childNodes, beforeChildren[i], 'children and text identities');
    assert.strictEqual(node.outerHTML, beforeHTML[i].replace('<p>', '<p data-ke-size="size16">'));
    assert.deepStrictEqual(node.writes, [['data-ke-size', 'size16']]);
  });
  const after = f.body.innerHTML;
  assert.strictEqual(f.normalizeMKEmptyParagraphs().normalized, 0);
  assert.strictEqual(f.body.innerHTML, after);
  assert.strictEqual(f.editor.dirty, 1, 'idempotent: no second write');

  const unsafe = [p([], {}), p([text(' \t\n')]), p([text('\u200b'), br()]), p([text('prose'), br()]),
    p([{type: 8, text: 'comment'}, br()]), p([{tag: 'br', children: [text('x')]}])];
  for (const tag of ['img', 'iframe', 'video', 'audio', 'svg', 'a', 'span', 'script', 'style', 'input', 'object', 'div']) {
    unsafe.push(p([{tag}, br()]));
  }
  for (const attrs of [{'data-ke-size': 'size14'}, {'data-ke-size': ''}, {'data-ke-size': 'size16'},
    {hidden: ''}, {style: 'display:none'}, {class: 'hidden'}, {id: 'semantic'}, {role: 'button'},
    {'aria-hidden': 'true'}, {onclick: ''}, {contenteditable: 'false'}, {'data-mce-bogus': '1'},
    {'data-image-marker': 'article-1'}, {'data-og-placeholder': 'https://source.example'}, {'data-article-id': 'one'}]) {
    unsafe.push(p(undefined, attrs));
  }
  for (const attrs of [{'data-mce-bogus': '0'}, {'data-mce-bogus': 'true'}, {'data-mce-bogus': '1', hidden: ''},
    {style: 'display:none'}, {onclick: 'run()'}, {contenteditable: 'false'}, {'data-ke-size': 'size16'}]) {
    unsafe.push(p([br(attrs)]));
  }
  // No nested paragraph inside a figure/caption/OG/hidden wrapper can change.
  for (const tag of ['figure', 'figcaption', 'a', 'div']) {
    unsafe.push({tag, attrs: {hidden: '', 'data-og-url': 'https://source.example'}, children: [p()]});
  }
  const untouched = fixture(unsafe);
  const original = untouched.body.innerHTML;
  assert.strictEqual(untouched.normalizeMKEmptyParagraphs().normalized, 0);
  assert.strictEqual(untouched.body.innerHTML, original, 'unsafe/semantic nodes remain for gate rejection');
  assert.strictEqual(untouched.editor.dirty, 0);

  const card = {tag: 'figure', attrs: {'data-ke-type': 'opengraph', 'data-og-url': 'https://source.example'},
    children: [{tag: 'a', attrs: {href: 'https://source.example'}, children: [{tag: 'img', attrs: {src: 'https://cdn.example/og.jpg'}}]}]};
  const image = {tag: 'figure', attrs: {'data-ke-type': 'image'}, children: [
    {tag: 'img', attrs: {src: 'https://cdn.example/article.jpg', alt: 'article'}}, {tag: 'figcaption', children: [text('AI disclosure')]}]};
  const spacer = p([text('\u00a0')], {'data-ke-size': 'size16'});
  const mixed = fixture([card, p(), image, p([text('summary')], {'data-ke-size': 'size16'}), spacer,
    p([text('comment')], {'data-ke-size': 'size16'}), p([text('\u200b')], {'data-image-marker': 'one'})]);
  const children = [...mixed.body.children];
  const originalMixed = mixed.body.innerHTML;
  // Existing generic cleanup keeps bogus BRs; normalization must not move/delete them.
  assert.strictEqual(mixed.cleanupOGResiduals().blankParasRemoved, 0);
  assert.strictEqual(mixed.body.innerHTML, originalMixed);
  assert.strictEqual(mixed.normalizeMKEmptyParagraphs().normalized, 1);
  assert.strictEqual(mixed.cleanupOGResiduals().blankParasRemoved, 0);
  assert.deepStrictEqual(mixed.body.children, children);
  children.forEach((node, i) => {
    if (i !== 1) assert.strictEqual(node.writes.length, 0, 'image/OG/prose/required spacer/marker unchanged');
  });
  const generic = fixture([card, p([br()]), image]);
  assert.strictEqual(generic.cleanupOGResiduals().blankParasRemoved, 1, 'non-MK cleanup behavior preserved');
  assert.strictEqual(generic.body.children.length, 2);

  for (const unavailable of [undefined, null, {}, {activeEditor: {}}, {activeEditor: {getBody: () => null}}]) {
    f.sandbox.tinymce = unavailable;
    assert.throws(() => f.normalizeMKEmptyParagraphs(), /unavailable/);
  }
  console.log('MK blank paragraph grammar, identity, idempotence and cleanup interaction tests passed');
}

if (process.argv.includes('--normalize')) {
  // Python's external Stage2 tests pass only synthetic fixtures through this actual helper.
  const f = fixture(JSON.parse(fs.readFileSync(0, 'utf8')));
  const result = f.normalizeMKEmptyParagraphs();
  process.stdout.write(JSON.stringify({result, html: f.body.innerHTML}));
} else {
  runTests();
}
