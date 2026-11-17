const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class Node {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.nodeType = 1;
    this.attrs = {...attrs};
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
  getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  removeAttribute(key) { delete this.attrs[key]; }
  matches(selector) {
    return selector.split(',').some(part => {
      if (part.trim().startsWith('.')) return (this.attrs.class || '').split(/\s+/).includes(part.trim().slice(1));
      const match = part.trim().match(/^(\w+)?(?:\[([\w-]+)(?:="([^"]+)")?\])?$/);
      return match && (!match[1] || match[1] === this.tag) && (!match[2] ||
        (match[3] ? this.attrs[match[2]] === match[3] : Object.hasOwn(this.attrs, match[2])));
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  appendChild(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    this.children.push(node);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceWith(node) {
    const parent = this.parent;
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    parent.children.splice(parent.children.indexOf(this), 1, node);
    node.parent = parent;
  }
  get firstChild() { return this.children[0]; }
  insertBefore(node, before) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    this.children.splice(this.children.indexOf(before), 0, node);
    node.parent = this;
  }
}

function fixture() {
  const body = new Node('body');
  let observer;
  let now = 1000;
  const editor = {getBody: () => body, selection: {select() {}, collapse() {}}, setDirty() {}, fire() {}, save() {}};
  const sandbox = {console, URL, Date: {now: () => now},
    document: {createElement: tag => new Node(tag)},
    tinymce: {activeEditor: editor},
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.records = []; observer = this; }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() { this.disconnected = true; }
      takeRecords() { return this.records.splice(0); }
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'tistory-editor-helpers.js'), 'utf8') +
    '\nthis.api = {beginMKImageUpload, pollMKImageUpload, finishMKImageUpload, abortMKImageUpload, preserveMKOGThumbnailEvidence};', sandbox);
  return {body, editor, api: sandbox.api, tick: (ms = 600) => { now += ms; },
    add(figure) { body.appendChild(figure); observer.records.push({type: 'childList', addedNodes: [figure]}); },
    mutate(node, value) {
      const oldValue = node.getAttribute('src');
      if (value === null) node.removeAttribute('src');
      else node.setAttribute('src', value);
      // Removing an absent attribute does not produce a native mutation record.
      if (value !== null || oldValue !== null) {
        observer.records.push({type: 'attributes', target: node, attributeName: 'src', oldValue});
      }
    },
    flush() { observer.callback(observer.takeRecords()); },
    observer: () => observer};
}
const image = (src, filename = 'deliberately-unrelated.jpg') => new Node('figure', {'data-ke-type': 'image'}, [new Node('img', {src, 'data-filename': filename})]);
const entry = {marker: 'trend-image-1', article_id: 'article-1', alt: '기사별 정확한 alt', caption: 'AI 편집 일러스트 안내'};
const marker = () => new Node('p', {'data-image-marker': entry.marker, 'data-article-id': entry.article_id, 'data-image-alt': entry.alt, 'data-image-caption': entry.caption});

{
  const f = fixture();
  const old = image('https://cdn.example/old.jpg', 'trend-image-1.jpg');
  f.body.appendChild(old);
  const target = marker();
  f.body.appendChild(target);
  f.api.beginMKImageUpload('one');
  const fresh = image('blob:pending');
  f.add(fresh);
  assert.strictEqual(f.api.pollMKImageUpload('one').ready, false);
  f.mutate(fresh.querySelector('img'), 'https://cdn.example/exact.jpg?signature=keep-all');
  assert.strictEqual(f.api.pollMKImageUpload('one').ready, false);
  f.tick();
  assert.strictEqual(f.api.pollMKImageUpload('one').ready, true);
  const result = f.api.finishMKImageUpload({token: 'one', entry});
  assert.strictEqual(result.src, 'https://cdn.example/exact.jpg?signature=keep-all');
  assert.strictEqual(result.token, 'one');
  assert.strictEqual(fresh.querySelector('img').getAttribute('alt'), entry.alt);
  assert.strictEqual(fresh.querySelector('figcaption').textContent, entry.caption);
  assert.strictEqual(old.querySelector('img').getAttribute('alt'), null);
  assert.strictEqual(f.body.querySelector('[data-image-marker]'), null);
  assert.strictEqual(f.observer().disconnected, true);
}

// Same-string writes may emit records. Exercise both native callback delivery
// and polling's takeRecords drain, with exact empty/absent attribute semantics.
for (const delivery of ['callback', 'poll']) {
  for (const baseline of ['https://cdn.example/original.jpg?x=1&y=2', '', null]) {
    const f = fixture();
    const old = image(baseline === null ? '' : baseline);
    const original = old.querySelector('img');
    if (baseline === null) original.removeAttribute('src');
    f.body.appendChild(old);
    f.body.appendChild(marker());
    f.api.beginMKImageUpload('noop');
    assert.strictEqual(f.observer().target, f.body);
    assert.strictEqual(f.observer().options.attributeOldValue, true);
    assert.strictEqual(f.observer().options.attributes, true);
    assert.deepStrictEqual(Array.from(f.observer().options.attributeFilter), ['src']);
    f.mutate(original, baseline);
    f.mutate(original, baseline);
    assert.strictEqual(f.observer().records.length, baseline === null ? 0 : 2,
      'absent removal emits no record; even same-string setAttribute emits records');
    const fresh = image('https://cdn.example/final.jpg');
    f.add(fresh);
    if (delivery === 'callback') f.flush();
    assert.strictEqual(f.api.pollMKImageUpload('noop').ready, false);
    assert.strictEqual(f.observer().records.length, 0, 'poll drains queued records');
    f.tick();
    assert.strictEqual(f.api.pollMKImageUpload('noop').ready, true);
    f.mutate(original, baseline); // finish must drain too, without resetting stability
    const result = f.api.finishMKImageUpload({token: 'noop', entry});
    assert.strictEqual(result.src, fresh.querySelector('img').getAttribute('src'));
    assert.strictEqual(original.getAttribute('src'), baseline);
    assert.strictEqual(original.getAttribute('alt'), null);
    assert.strictEqual(fresh.querySelector('img').getAttribute('alt'), entry.alt);
    assert.strictEqual(f.body.children.includes(old), true, 'original node identity retained');
  }
}

for (const delivery of ['callback', 'poll']) {
  for (const scenario of ['changed', 'same-batch-restore', 'separate-batch-restore',
    'missing-oldValue', 'undefined-oldValue', 'null-to-empty', 'empty-to-null',
    'null-round-trip', 'empty-round-trip']) {
    const f = fixture();
    const baseline = scenario.startsWith('null-') ? null : scenario.startsWith('empty-') ? '' : 'https://cdn.example/original.jpg';
    const old = image(baseline === null ? '' : baseline);
    const original = old.querySelector('img');
    if (baseline === null) original.removeAttribute('src');
    f.body.appendChild(old);
    f.body.appendChild(marker());
    f.api.beginMKImageUpload('transition');
    f.add(image('https://cdn.example/final.jpg'));
    f.api.pollMKImageUpload('transition');
    f.tick();
    const drain = () => {
      if (delivery === 'callback') f.flush();
      return f.api.pollMKImageUpload('transition');
    };
    if (scenario === 'missing-oldValue' || scenario === 'undefined-oldValue') {
      // Deliberately malformed evidence must fail even when final src is unchanged.
      const record = {type: 'attributes', attributeName: 'src', target: original};
      if (scenario === 'undefined-oldValue') record.oldValue = undefined;
      f.observer().records.push(record);
    } else {
      const changed = baseline === null ? '' : baseline === '' ? null : 'https://cdn.example/changed.jpg';
      f.mutate(original, changed);
      if (scenario === 'separate-batch-restore') {
        assert.strictEqual(drain().error, 'existing image mutated');
        // A subsequent no-op at B cannot rebind the immutable A baseline.
        f.mutate(original, changed);
        assert.strictEqual(drain().error, 'existing image mutated');
      }
      if (scenario.includes('restore') || scenario.endsWith('round-trip')) f.mutate(original, baseline);
    }
    assert.strictEqual(drain().error, 'existing image mutated', delivery + '/' + scenario);
    assert.strictEqual(f.observer().records.length, 0);
    // Restoring the baseline, or removing all pending records, never clears failure.
    f.mutate(original, baseline);
    drain(); f.tick();
    assert.throws(() => f.api.finishMKImageUpload({token: 'transition', entry}), /existing image mutated/);
    assert.strictEqual(original.getAttribute('alt'), null);
    assert.throws(() => f.api.beginMKImageUpload('retry'), /MK upload unavailable/);
  }
}

// Interleaved records must be checked against each target's own baseline, not
// against the next global record or only the final restored DOM state.
for (const delivery of ['callback', 'poll']) {
  for (const changed of [false, true]) {
    const f = fixture();
    const first = image('https://cdn.example/first-original.jpg');
    const second = image('https://cdn.example/second-original.jpg');
    f.body.appendChild(first); f.body.appendChild(second); f.body.appendChild(marker());
    const a = first.querySelector('img'), b = second.querySelector('img');
    const srcA = a.getAttribute('src'), srcB = b.getAttribute('src');
    f.api.beginMKImageUpload('interleaved');
    const fresh = image('https://cdn.example/final.jpg');
    f.add(fresh);
    f.mutate(a, srcA);
    f.mutate(b, changed ? 'https://cdn.example/intermediate.jpg' : srcB);
    f.mutate(a, srcA);
    f.mutate(b, srcB);
    f.mutate(a, srcA);
    if (delivery === 'callback') f.flush();
    const state = f.api.pollMKImageUpload('interleaved');
    assert.strictEqual(state.error, changed ? 'existing image mutated' : undefined);
    assert.strictEqual(f.observer().records.length, 0);
    f.tick();
    if (changed) assert.throws(() => f.api.finishMKImageUpload({token: 'interleaved', entry}), /existing image mutated/);
    else assert.strictEqual(f.api.finishMKImageUpload({token: 'interleaved', entry}).src, fresh.querySelector('img').getAttribute('src'));
  }
}

// Undefined oldValue is not the same evidence as a known absent (null) src.
{
  const f = fixture();
  const original = new Node('img');
  f.body.appendChild(original);
  f.api.beginMKImageUpload('missing-null-evidence');
  f.observer().records.push({type: 'attributes', attributeName: 'src', target: original});
  assert.strictEqual(f.api.pollMKImageUpload('missing-null-evidence').error, 'existing image mutated');
}

for (const scenario of ['two-new-images', 'existing-src-mutated', 'reused-src', 'wrong-marker-binding', 'no-native-figure', 'wrong-token']) {
  const f = fixture();
  const old = image('https://cdn.example/old.jpg');
  f.body.appendChild(old);
  const target = marker();
  f.body.appendChild(target);
  f.api.beginMKImageUpload('one');
  const fresh = scenario === 'no-native-figure' ? new Node('img', {src: 'https://cdn.example/new.jpg'}) : image('https://cdn.example/new.jpg');
  f.add(fresh);
  if (scenario === 'two-new-images') f.add(image('https://cdn.example/extra.jpg'));
  if (scenario === 'existing-src-mutated') f.mutate(old.querySelector('img'), 'https://cdn.example/changed.jpg');
  if (scenario === 'reused-src') fresh.querySelector('img').setAttribute('src', 'https://cdn.example/old.jpg');
  if (scenario === 'wrong-marker-binding') target.setAttribute('data-article-id', 'another-article');
  f.api.pollMKImageUpload('one');
  f.tick();
  assert.throws(() => f.api.finishMKImageUpload({token: scenario === 'wrong-token' ? 'other' : 'one', entry}), undefined, scenario);
}
for (const sameSrc of [false, true]) {
  const f = fixture();
  f.body.appendChild(marker());
  f.api.beginMKImageUpload('replace');
  const placeholder = image('https://cdn.example/transient.jpg');
  f.add(placeholder);
  f.api.pollMKImageUpload('replace');
  f.tick();
  placeholder.remove();
  const replacement = image(sameSrc ? 'https://cdn.example/transient.jpg' : 'https://cdn.example/final.jpg');
  f.add(replacement);
  assert.strictEqual(f.api.pollMKImageUpload('replace').ready, false, 'replacement needs its own stability window');
  f.tick();
  assert.strictEqual(f.api.pollMKImageUpload('replace').ready, true);
  const result = f.api.finishMKImageUpload({token: 'replace', entry});
  assert.strictEqual(result.src, replacement.querySelector('img').getAttribute('src'));
  assert.strictEqual(placeholder.querySelector('img').getAttribute('alt'), null);
}
for (const sameSrc of [false, true]) {
  const f = fixture();
  f.body.appendChild(marker());
  f.api.beginMKImageUpload('overlap');
  const placeholder = image('https://cdn.example/transient.jpg');
  f.add(placeholder);
  f.api.pollMKImageUpload('overlap');
  f.tick();
  const final = image(sameSrc ? 'https://cdn.example/transient.jpg' : 'https://cdn.example/final.jpg');
  f.add(final);
  for (let i = 0; i < 3; i++) {
    const state = f.api.pollMKImageUpload('overlap');
    assert.strictEqual(state.ready, false, 'cross-task overlap must remain pending, including at the Python wait boundary');
    assert.strictEqual(state.error, undefined);
    f.tick(250);
  }
  assert.throws(() => f.api.finishMKImageUpload({token: 'overlap', entry}), /upload pending/);
  placeholder.remove();
  assert.strictEqual(f.api.pollMKImageUpload('overlap').ready, false, 'sole replacement starts a fresh stability window');
  f.tick(499);
  assert.strictEqual(f.api.pollMKImageUpload('overlap').ready, false);
  f.tick(1);
  assert.strictEqual(f.api.pollMKImageUpload('overlap').ready, true);
  assert.strictEqual(f.api.finishMKImageUpload({token: 'overlap', entry}).src, final.querySelector('img').getAttribute('src'));
  assert.strictEqual(placeholder.querySelector('img').getAttribute('alt'), null);
}
{
  const f = fixture();
  f.body.appendChild(marker());
  f.api.beginMKImageUpload('ambiguous');
  f.add(image('https://cdn.example/first.jpg'));
  const extra = image('https://cdn.example/second.jpg');
  f.add(extra);
  assert.strictEqual(f.api.pollMKImageUpload('ambiguous').ready, false);
  f.tick(999);
  assert.strictEqual(f.api.pollMKImageUpload('ambiguous').ready, false);
  f.tick(1);
  assert.strictEqual(f.api.pollMKImageUpload('ambiguous').error, 'ambiguous upload attachments');
  extra.remove(); f.tick();
  assert.throws(() => f.api.finishMKImageUpload({token: 'ambiguous', entry}), /ambiguous upload attachments/);
  assert.strictEqual(f.api.abortMKImageUpload('foreign'), false);
  assert.strictEqual(f.observer().disconnected, undefined);
  assert.strictEqual(f.api.abortMKImageUpload('ambiguous'), true);
  assert.strictEqual(f.observer().disconnected, true);
  assert.throws(() => f.api.beginMKImageUpload('second-delivery'), /MK upload unavailable/);
  f.add(image('https://cdn.example/late.jpg'));
  assert.throws(() => f.api.finishMKImageUpload({token: 'ambiguous', entry}), /ambiguous upload attachments/);
}
for (const scenario of ['body-replaced', 'original-mutated', 'src-reused-during-overlap', 'aborted']) {
  const f = fixture();
  const old = image('https://cdn.example/old.jpg');
  f.body.appendChild(old);
  f.body.appendChild(marker());
  f.api.beginMKImageUpload('sticky');
  const fresh = image('https://cdn.example/new.jpg');
  f.add(fresh);
  if (scenario === 'body-replaced') f.editor.getBody = () => new Node('body');
  if (scenario === 'original-mutated') f.mutate(old.querySelector('img'), 'https://cdn.example/changed.jpg');
  const reused = image('https://cdn.example/old.jpg');
  if (scenario === 'src-reused-during-overlap') f.add(reused);
  if (scenario === 'aborted') f.api.abortMKImageUpload('sticky');
  assert.strictEqual(f.api.pollMKImageUpload('sticky').ready, true, scenario);
  assert.ok(f.api.pollMKImageUpload('sticky').error, scenario);
  f.editor.getBody = () => f.body;
  reused.remove(); f.tick();
  assert.throws(() => f.api.finishMKImageUpload({token: 'sticky', entry}), undefined, 'failure stays latched: ' + scenario);
  f.api.abortMKImageUpload('sticky');
  assert.strictEqual(f.observer().disconnected, true);
  assert.throws(() => f.api.beginMKImageUpload('second'), /MK upload unavailable/);
}
{
  const f = fixture();
  f.body.appendChild(new Node('h2'));
  f.api.beginMKImageUpload('banner');
  const banner = image('https://cdn.example/banner.jpg');
  f.add(banner);
  f.api.pollMKImageUpload('banner'); f.tick();
  f.api.finishMKImageUpload({token: 'banner', entry: null, bannerAlt: '배너'});
  assert.strictEqual(f.body.firstChild, banner);
  assert.strictEqual(banner.querySelector('img').getAttribute('alt'), '배너');
  assert.strictEqual(banner.querySelector('figcaption'), null);
}
for (const scenario of ['observed', 'declared-mismatch', 'extra-img', 'non-image-embed', 'pending-src']) {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.body.appendChild(new Node('figure', {'data-ke-type': 'opengraph'}, [new Node('img', {src: 'https://og.example/' + i + '.jpg'})]));
  const card = f.body.children[0];
  if (scenario === 'declared-mismatch') card.setAttribute('data-og-image', 'https://og.example/invented.jpg');
  if (scenario === 'extra-img') card.appendChild(new Node('img', {src: 'https://og.example/extra.jpg'}));
  if (scenario === 'non-image-embed') card.appendChild(new Node('iframe'));
  if (scenario === 'pending-src') card.querySelector('img').setAttribute('src', 'blob:pending');
  if (scenario === 'observed') {
    assert.strictEqual(f.api.preserveMKOGThumbnailEvidence().success, true);
    assert.strictEqual(card.getAttribute('data-og-image'), 'https://og.example/0.jpg');
    assert.strictEqual(card.getAttribute('data-og-source-url'), null);
    assert.strictEqual(card.getAttribute('data-og-title'), null);
  } else assert.throws(() => f.api.preserveMKOGThumbnailEvidence(), undefined, scenario);
}
for (const shape of ['og-container', 'data-og-host', 'mixed']) {
  for (const invalid of ['', 'extra-img', 'nested', 'unknown-src', 'declared-mismatch']) {
    const f = fixture();
    for (let i = 0; i < 4; i++) {
      const attrs = shape === 'og-container' || (shape === 'mixed' && i === 0)
        ? {class: 'og-container'} : shape === 'data-og-host' || (shape === 'mixed' && i === 1)
        ? {'data-og-host': 'mk.co.kr'} : {'data-ke-type': 'opengraph'};
      f.body.appendChild(new Node(attrs['data-ke-type'] ? 'figure' : 'div', attrs,
        [new Node('img', {src: 'https://og.example/' + i + '.jpg'})]));
    }
    const card = f.body.children[0];
    if (invalid === 'extra-img') card.appendChild(new Node('img', {src: 'https://og.example/extra.jpg'}));
    if (invalid === 'nested') card.appendChild(new Node('figure', {'data-ke-type': 'opengraph'}));
    if (invalid === 'unknown-src') card.querySelector('img').setAttribute('src', 'blob:pending');
    if (invalid === 'declared-mismatch') card.setAttribute('data-og-image', 'https://og.example/false.jpg');
    if (invalid) assert.throws(() => f.api.preserveMKOGThumbnailEvidence(), undefined, shape + '/' + invalid);
    else {
      assert.strictEqual(f.api.preserveMKOGThumbnailEvidence().success, true, shape);
      assert.strictEqual(card.getAttribute('data-og-image'), 'https://og.example/0.jpg');
      assert.strictEqual(card.getAttribute('data-og-source-url'), null);
    }
  }
}
console.log('MK Stage3 operation identity, marker/caption/banner and observed OG evidence tests passed');
