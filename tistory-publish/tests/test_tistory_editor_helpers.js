const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const helperPath = path.join(__dirname, '..', 'scripts', 'tistory-editor-helpers.js');
const source = fs.readFileSync(helperPath, 'utf8');

function loadHelpers() {
  const sandbox = {
    console,
    document: {
      createElement(tagName) {
        assert.strictEqual(tagName, 'figcaption');
        return {
          tagName: 'FIGCAPTION',
          textContent: '',
          removed: [],
          removeAttribute(name) {
            this.removed.push(name);
          },
        };
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source}\nthis.__helpers = { applyImageCaption, imagePresentationOptions };`,
    sandbox,
    { filename: helperPath },
  );
  return sandbox.__helpers;
}

function makeFigure() {
  return {
    tagName: 'FIGURE',
    caption: null,
    matches(selector) {
      return selector === 'figure[data-ke-type="image"]';
    },
    querySelector(selector) {
      return selector === 'figcaption' ? this.caption : null;
    },
    appendChild(node) {
      this.caption = node;
    },
  };
}

{
  const { applyImageCaption } = loadHelpers();
  const figure = makeFigure();
  const caption = applyImageCaption(figure, 'GPT Images 생성');

  assert.strictEqual(caption.textContent, 'GPT Images 생성');
  assert.deepStrictEqual(caption.removed, ['style', 'data-placeholder']);
  assert.strictEqual(figure.caption, caption);
}

{
  const { imagePresentationOptions } = loadHelpers();
  assert.strictEqual(
    JSON.stringify(imagePresentationOptions({
      filename: '00-comic.jpg',
      caption: 'GPT Images 생성',
    })),
    JSON.stringify({ width: 680, align: 'left', caption: 'GPT Images 생성' }),
  );
  assert.strictEqual(
    JSON.stringify(imagePresentationOptions({
      filename: '01-trend.jpg',
      caption: 'GPT Images 생성',
    })),
    JSON.stringify({ width: 0, align: '', caption: 'GPT Images 생성' }),
  );
}

console.log('tistory-editor-helpers caption tests passed');
